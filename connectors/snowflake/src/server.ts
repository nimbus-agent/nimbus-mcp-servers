import { z } from "zod";
import { type ConsentServer, createWriteToolRegistrar } from "../../../shared/consent-kit.ts";
import { cursorListInputSchema } from "../../../shared/cursor-list-tool.ts";
import { requiredEnv } from "../../../shared/env-json-api.ts";
import { guardedFetch } from "../../../shared/guarded-fetch.ts";
import { searchToolInputSchema } from "../../../shared/mcp-search-tool.ts";
import { mcpJsonResult as jsonResult } from "../../../shared/mcp-tool-kit.ts";
import {
  runReadOnlyMcpConnector,
  type ZodToolRegistrar,
} from "../../../shared/run-read-only-mcp-connector.ts";
import { asRecord } from "../../../shared/search-filter.ts";
import { filterSnowflakeTables } from "./search-filter.ts";

function authHeader(): Record<string, string> {
  return {
    Authorization: `Bearer ${requiredEnv("SNOWFLAKE_TOKEN")}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/**
 * POST a single SQL statement to the Snowflake SQL REST API (`/api/v2/statements`) with the
 * connector's Bearer auth. Returns the parsed JSON response; throws on a non-OK status. Shared by
 * the read-only `fetchTables` path and the HITL-gated write tools so auth/transport stays in one place.
 */
async function executeStatement(statement: string): Promise<unknown> {
  const url = `https://${requiredEnv("SNOWFLAKE_ACCOUNT")}.snowflakecomputing.com/api/v2/statements`;
  // guardedFetch: the Bearer token must never follow a redirect to another origin, and a redirect
  // on this POST (which may be a write) is refused rather than replayed.
  const res = await guardedFetch("Snowflake", url, {
    method: "POST",
    headers: authHeader(),
    body: JSON.stringify({ statement, timeout: 60 }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Snowflake ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

// Each dot-separated part is an unquoted identifier OR a fully double-quoted token (no embedded ").
const SF_IDENT_PART = /^(?:[A-Za-z_][A-Za-z0-9_$]*|"[^"]+")$/;
function assertSfIdentifier(name: string, label: string): string {
  const parts = name.split(".");
  for (const part of parts) {
    if (!SF_IDENT_PART.test(part)) {
      throw new Error(`unsafe Snowflake identifier component for ${label}: ${part} in ${name}`);
    }
  }
  return name;
}

// String literals are escaped by doubling single quotes (the only Snowflake literal-injection vector).
function sfLiteral(v: string): string {
  return `'${v.replaceAll("'", "''")}'`;
}

/** The parts of `db.schema.name`, each already vetted by {@link assertSfIdentifier}. */
function splitObjectName(object: string): { db: string; schema: string; name: string } {
  // The name is placed in string literals, where Snowflake reads a backslash as an escape.
  if (object.includes("\\")) throw new Error("object must not contain a backslash");
  const parts = assertSfIdentifier(object, "object").split(".");
  const [db, schema, name] = parts;
  if (parts.length !== 3 || db === undefined || schema === undefined || name === undefined) {
    throw new Error("object must be a fully qualified name: database.schema.name");
  }
  return { db, schema, name };
}

/** An identifier part's name as Snowflake stores it: a quoted part verbatim, else upper-cased. */
function storedName(part: string): string {
  return part.startsWith('"') ? part.slice(1, -1) : part.toUpperCase();
}

/**
 * The write-scope value of an object name: the name as Snowflake resolves it. The dotted name is
 * split respecting double quotes; an unquoted part is upper-cased, a quoted one keeps its exact
 * case with its quotes removed and `""` read as `"`; the parts are joined with `.`. A name that
 * does not parse is returned as written, so it matches only a term that spells it that way.
 */
export function scopeObjectName(name: string): string {
  const parts: string[] = [];
  let i = 0;
  for (;;) {
    let part = "";
    if (name[i] === '"') {
      i++;
      for (;;) {
        const ch = name[i];
        if (ch === undefined) return name; // unterminated quote
        i++;
        if (ch !== '"') {
          part += ch;
        } else if (name[i] === '"') {
          part += '"';
          i++;
        } else {
          break;
        }
      }
      if (part === "") return name;
    } else {
      const start = i;
      while (i < name.length && name[i] !== "." && name[i] !== '"') i++;
      const raw = name.slice(start, i);
      if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(raw)) return name;
      part = raw.toUpperCase();
    }
    parts.push(part);
    if (i >= name.length) return parts.join(".");
    if (name[i] !== ".") return name;
    i++;
  }
}

const TABLES_SQL =
  "SELECT table_catalog AS database_name, table_schema AS schema_name, table_name, " +
  "row_count, last_altered FROM information_schema.tables WHERE table_schema <> 'INFORMATION_SCHEMA'";

function rowsFromStatementsResponse(parsed: unknown): Record<string, unknown>[] {
  const root = asRecord(parsed);
  const meta = asRecord(root?.["resultSetMetaData"]);
  const rowType = Array.isArray(meta?.["rowType"]) ? meta["rowType"] : [];
  const names = rowType.map(
    (c) => (asRecord(c)?.["name"] as string | undefined)?.toLowerCase() ?? "",
  );
  const data = Array.isArray(root?.["data"]) ? root["data"] : [];
  const out: Record<string, unknown>[] = [];
  for (const rr of data) {
    if (!Array.isArray(rr)) continue;
    const obj: Record<string, unknown> = {};
    names.forEach((name, i) => {
      if (name !== "") obj[name] = rr[i];
    });
    if (typeof obj["row_count"] === "string" && obj["row_count"] !== "") {
      obj["row_count"] = Number(obj["row_count"]);
    }
    out.push(obj);
  }
  return out;
}

/**
 * Fetch table metadata. With no `page`, returns the full set (used by `snowflake_get` /
 * `snowflake_search`, which must scan every table). With a `page`, appends a deterministic
 * `ORDER BY … LIMIT … OFFSET …` so `snowflake_list` can drain pages — only numbers are
 * interpolated, so there is no SQL-injection surface.
 */
async function fetchTables(page?: {
  limit: number;
  offset: number;
}): Promise<Record<string, unknown>[]> {
  const statement =
    page === undefined
      ? TABLES_SQL
      : // (table_catalog, table_schema, table_name) uniquely identifies a table in INFORMATION_SCHEMA
        // — a TOTAL order, so OFFSET paging cannot skip or duplicate rows across pages.
        `${TABLES_SQL} ORDER BY table_catalog, table_schema, table_name LIMIT ${page.limit} OFFSET ${page.offset}`;
  return rowsFromStatementsResponse(await executeStatement(statement));
}

/** Column names, types and nullability only. NEVER `column_default`, `comment` or any row data. */
const COLUMNS_SQL =
  "SELECT table_catalog AS database_name, table_schema AS schema_name, table_name, " +
  "column_name, data_type, is_nullable, ordinal_position FROM information_schema.columns";

/** At most this many schemas get a column query per page; tables in the rest are marked incomplete. */
const MAX_SCHEMAS_PER_PAGE = 50;
/** At most this many column rows per schema query; a cut schema marks its tables incomplete. */
const MAX_COLUMNS_PER_SCHEMA = 20_000;

/** A string literal for a value read back from Snowflake: doubles `'` and `\` (Snowflake's escape). */
function sfValueLiteral(v: string): string {
  return `'${v.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

/** Collision-free (database, schema) key. */
function schemaKey(db: string, schema: string): string {
  return JSON.stringify([db, schema]);
}

export interface SnowflakeColumn {
  name: string;
  type: string | null;
  nullable: boolean | null;
  ordinal: number | null;
}

/** Snowflake lists every result partition in `partitionInfo`; the response body holds only the first. */
function hasMorePartitions(parsed: unknown): boolean {
  const info = asRecord(asRecord(parsed)?.["resultSetMetaData"])?.["partitionInfo"];
  return Array.isArray(info) && info.length > 1;
}

/** Case-preserving key: `USERS` and `"users"` are different tables, so the lowercased key will not do. */
function exactTableKey(row: Record<string, unknown>): string {
  return JSON.stringify([row["database_name"], row["schema_name"], row["table_name"]]);
}

/**
 * Column metadata for the given tables: ONE `information_schema.columns` query per distinct
 * (database, schema), not per table, each capped at {@link MAX_COLUMNS_PER_SCHEMA} rows, and at most
 * {@link MAX_SCHEMAS_PER_PAGE} schemas. Returns the columns by table key plus the keys of tables whose
 * columns may be incomplete (schema over the cap, cut result, or a failed query).
 */
async function fetchColumnsFor(
  tables: Record<string, unknown>[],
  onlyTable?: string,
): Promise<{ byTable: Map<string, SnowflakeColumn[]>; incomplete: Set<string> }> {
  const byTable = new Map<string, SnowflakeColumn[]>();
  const incomplete = new Set<string>();
  const schemas = distinctSchemas(tables, incomplete);
  let queried = 0;
  const failed = new Set<string>();
  for (const [key, { db, schema }] of schemas) {
    if (queried >= MAX_SCHEMAS_PER_PAGE) {
      failed.add(key);
      continue;
    }
    queried++;
    try {
      // One statement at a time on purpose: up to 50 schemas, and the warehouse is the owner's.
      const complete = await readSchemaColumns(db, schema, onlyTable, byTable); // NOSONAR S9382: sequential on purpose, see above.
      if (!complete) failed.add(key);
    } catch {
      failed.add(key);
    }
  }
  for (const t of tables) {
    const db = t["database_name"];
    const schema = t["schema_name"];
    if (typeof db === "string" && typeof schema === "string" && failed.has(schemaKey(db, schema))) {
      incomplete.add(exactTableKey(t));
    }
  }
  return { byTable, incomplete };
}

/** The distinct (database, schema) pairs of `tables`; a table without both names goes to `incomplete`. */
function distinctSchemas(
  tables: Record<string, unknown>[],
  incomplete: Set<string>,
): Map<string, { db: string; schema: string }> {
  const schemas = new Map<string, { db: string; schema: string }>();
  for (const t of tables) {
    const db = t["database_name"];
    const schema = t["schema_name"];
    if (typeof db !== "string" || typeof schema !== "string") {
      incomplete.add(exactTableKey(t));
      continue;
    }
    schemas.set(schemaKey(db, schema), { db, schema });
  }
  return schemas;
}

/**
 * Query one schema's columns into `byTable`. Returns false when the result may be cut (over the cap,
 * or more partitions than this response holds); a failed query throws.
 */
async function readSchemaColumns(
  db: string,
  schema: string,
  onlyTable: string | undefined,
  byTable: Map<string, SnowflakeColumn[]>,
): Promise<boolean> {
  const filter =
    `WHERE table_catalog = ${sfValueLiteral(db)} AND table_schema = ${sfValueLiteral(schema)}` +
    (onlyTable === undefined ? "" : ` AND table_name = ${sfValueLiteral(onlyTable)}`);
  const parsed = await executeStatement(
    `${COLUMNS_SQL} ${filter} ORDER BY table_name, ordinal_position LIMIT ${MAX_COLUMNS_PER_SCHEMA + 1}`,
  );
  const rows = rowsFromStatementsResponse(parsed);
  for (const r of rows.slice(0, MAX_COLUMNS_PER_SCHEMA)) {
    const col = columnOf(r);
    if (col === undefined) continue;
    const k = exactTableKey(r);
    const list = byTable.get(k);
    if (list === undefined) byTable.set(k, [col]);
    else list.push(col);
  }
  // Only the first result partition comes back in this response; a LIMIT does not prove it holds every row.
  return !(rows.length > MAX_COLUMNS_PER_SCHEMA || hasMorePartitions(parsed));
}

/** `YES` is true, `NO` is false, anything else is unknown. */
function nullableOf(value: unknown): boolean | null {
  if (value === "YES") return true;
  if (value === "NO") return false;
  return null;
}

/** One `information_schema.columns` row as a column, or undefined when it has no name. */
function columnOf(r: Record<string, unknown>): SnowflakeColumn | undefined {
  const name = r["column_name"];
  if (typeof name !== "string" || name === "") return undefined;
  const ordinal = Number(r["ordinal_position"]);
  return {
    name,
    type: typeof r["data_type"] === "string" ? r["data_type"] : null,
    nullable: nullableOf(r["is_nullable"]),
    ordinal: Number.isFinite(ordinal) ? ordinal : null,
  };
}

/** Adds `columns` (`{ name, type, nullable, ordinal }[]`) and `columns_complete` to each table row. */
async function withColumns(
  tables: Record<string, unknown>[],
  onlyTable?: string,
): Promise<Record<string, unknown>[]> {
  const { byTable, incomplete } = await fetchColumnsFor(tables, onlyTable);
  return tables.map((t) => {
    const k = exactTableKey(t);
    return { ...t, columns: byTable.get(k) ?? [], columns_complete: !incomplete.has(k) };
  });
}

function tableKey(row: Record<string, unknown>): string {
  const db = typeof row["database_name"] === "string" ? row["database_name"].toLowerCase() : "";
  const schema = typeof row["schema_name"] === "string" ? row["schema_name"].toLowerCase() : "";
  const table = typeof row["table_name"] === "string" ? row["table_name"].toLowerCase() : "";
  return `${db}.${schema}.${table}`;
}

/**
 * The metadata a comment or tag change is previewed against: the object's COMMENT and its tags,
 * direct and inherited. Two statements, both live (never ACCOUNT_USAGE, whose TAG_REFERENCES lags
 * up to 120 minutes):
 * - `SHOW TABLES|VIEWS LIKE '<name>' IN SCHEMA db.schema` for the `comment` column. The LIKE pattern
 *   supports the wildcards % and _ and the page documents no escape for them
 *   (https://docs.snowflake.com/en/sql-reference/sql/show-tables), so none is relied on: the pattern
 *   only NARROWS the rows, and the object is picked by exact name in code.
 * - `INFORMATION_SCHEMA.TAG_REFERENCES('db.schema.name', 'TABLE')`; the domain TABLE covers views
 *   (https://docs.snowflake.com/en/sql-reference/functions/tag_references).
 * Metadata only: no row data is ever selected.
 */
async function objectMetadata(
  objectType: "table" | "view",
  object: string,
): Promise<Record<string, unknown>> {
  const { db, schema, name } = splitObjectName(object);
  const verb = objectType === "view" ? "VIEWS" : "TABLES";
  const shown = rowsFromStatementsResponse(
    await executeStatement(
      `SHOW ${verb} LIKE ${sfLiteral(name.startsWith('"') ? name.slice(1, -1) : name)} IN SCHEMA ${db}.${schema}`,
    ),
  );
  const wanted = storedName(name);
  const row = shown.find((r) => r["name"] === wanted);
  if (row === undefined) throw new Error(`Snowflake ${objectType} not found: ${object}`);
  const tagRows = rowsFromStatementsResponse(
    await executeStatement(
      `SELECT tag_database, tag_schema, tag_name, tag_value FROM TABLE(${db}.INFORMATION_SCHEMA.TAG_REFERENCES(${sfLiteral(object)}, 'TABLE'))`,
    ),
  );
  // A tag is a schema object: two tags named PII in different schemas are different tags, so each
  // entry carries where its tag lives, and the order is by fully qualified name, then value.
  const qualified = (t: { database: string; schema: string; name: string }): string =>
    `${t.database}.${t.schema}.${t.name}`;
  const tags = tagRows
    .map((t) => ({
      database: scalarText(t["tag_database"] ?? ""),
      schema: scalarText(t["tag_schema"] ?? ""),
      name: scalarText(t["tag_name"] ?? ""),
      value: t["tag_value"] ?? null,
    }))
    .sort(
      (a, b) =>
        qualified(a).localeCompare(qualified(b)) ||
        scalarText(a.value).localeCompare(scalarText(b.value)),
    );
  return { object, objectType, comment: row["comment"] ?? "", tags };
}

/** A cell of a statement reply as text: a scalar as `String` writes it, anything else as its JSON. */
function scalarText(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  if (v === null || v === undefined) return String(v);
  return JSON.stringify(v) ?? "";
}

/**
 * Register the three read-only Snowflake tools on `reg`. Exported (rather than inlined into the
 * `runReadOnlyMcpConnector` call) so the tool handlers can be exercised in unit tests without
 * starting a real stdio transport.
 */
export function registerSnowflakeTools(reg: ZodToolRegistrar, server: unknown): void {
  // Despite the read-only helper's name, this connector exposes write tools. The consent
  // kit needs the real server, which the helper now passes through as its second argument.
  const registerWriteTool = createWriteToolRegistrar(server as ConsentServer, {
    connector: "snowflake",
    scopeEnv: "NIMBUS_MCP_SNOWFLAKE_WRITE_SCOPE",
    scopeKinds: ["object"],
  });

  reg(
    "snowflake_list",
    "List Snowflake tables across all databases and schemas, each with its `columns` (`{ name, type, nullable, ordinal }`, metadata only, never row data or defaults; `columns_complete` is false when they may be cut). Paginated: `cursor` (opaque offset) + `limit` (default 200, max 500) → `{ items, nextCursor }`.",
    cursorListInputSchema(),
    async (p) => {
      const limit = p.limit ?? 200;
      const offset =
        p.cursor === null || p.cursor === undefined || p.cursor === ""
          ? 0
          : Math.max(0, Number.parseInt(p.cursor, 10) || 0);
      const tables = await fetchTables({ limit, offset });
      const items = await withColumns(tables);
      const nextCursor = tables.length === limit ? String(offset + limit) : null;
      return jsonResult({ items, nextCursor });
    },
  );

  reg(
    "snowflake_get",
    "Fetch one Snowflake table by its fully-qualified id (`database.schema.table`, case-insensitive). Throws when the table is not found.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      const tables = await fetchTables();
      const needle = p.id.toLowerCase();
      const found = tables.find((row) => tableKey(row) === needle);
      if (found === undefined) {
        throw new Error(`Snowflake table not found: ${p.id}`);
      }
      const [withCols] = await withColumns([found], found["table_name"] as string);
      return jsonResult(withCols);
    },
  );

  reg(
    "snowflake_search",
    "Substring search across Snowflake tables. Matches the query (case-insensitive) against table name, schema name, and database name. Returns a `{ matches: [...] }` envelope.",
    searchToolInputSchema(200),
    async (p) => {
      const tables = await fetchTables();
      const matches = filterSnowflakeTables(tables, { query: p.query, limit: p.limit });
      return jsonResult({ matches });
    },
  );

  reg(
    "snowflake_object_metadata_get",
    "Get a table's or view's COMMENT and tags (direct and inherited) by fully qualified name: {object, objectType, comment, tags:[{name, value}]}. The before-state of snowflake_comment_set and snowflake_tag_set; objectType defaults to table. Metadata only, never row data.",
    z.object({
      objectType: z.enum(["table", "view"]).optional(),
      object: z.string().min(1),
    }),
    async (p) => jsonResult(await objectMetadata(p.objectType ?? "table", p.object)),
  );

  registerWriteTool(
    "snowflake_tag_set",
    {
      mutates: "snowflake.tag.set",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "object", value: scopeObjectName(p.object) }),
    },
    "Set or unset a governance TAG on a table. `ALTER TABLE <object> SET TAG <tag> = '<value>'`; omit `value` to UNSET.",
    z.object({
      object: z.string().min(1),
      tag: z.string().min(1),
      value: z.string().optional(),
    }),
    async (p) => {
      const obj = assertSfIdentifier(p.object, "object");
      const tag = assertSfIdentifier(p.tag, "tag");
      const statement =
        p.value === undefined
          ? `ALTER TABLE ${obj} UNSET TAG ${tag}`
          : `ALTER TABLE ${obj} SET TAG ${tag} = ${sfLiteral(p.value)}`;
      await executeStatement(statement);
      return jsonResult({ status: "ok", object: obj, tag });
    },
  );

  registerWriteTool(
    "snowflake_comment_set",
    {
      mutates: "snowflake.comment.set",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "object", value: scopeObjectName(p.object) }),
    },
    "Set a COMMENT on a table. `COMMENT ON TABLE <object> IS '<comment>'`.",
    z.object({ object: z.string().min(1), comment: z.string() }),
    async (p) => {
      const obj = assertSfIdentifier(p.object, "object");
      await executeStatement(`COMMENT ON TABLE ${obj} IS ${sfLiteral(p.comment)}`);
      return jsonResult({ status: "ok", object: obj });
    },
  );
}

// Exported so the bundled-connector registry can start this server explicitly: `import.meta.main`
// is false under an import, and the module must stay importable by tests without connecting stdio.
export async function startConnector(): Promise<void> {
  await runReadOnlyMcpConnector("nimbus-snowflake", registerSnowflakeTools);
}

if (import.meta.main) await startConnector();
