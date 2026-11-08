/**
 * manifest-scan — a linear, fail-closed reader of the few fields of a Kubernetes manifest that
 * decide WHERE an apply lands: each document's `apiVersion`, `kind`, `metadata.namespace` and
 * `metadata.name`.
 *
 * Why it exists: `k8s_manifest_apply` runs `kubectl apply -n <namespace> -f <file>`. `-n` makes
 * kubectl refuse a namespaced object whose `metadata.namespace` differs (the exact error text is
 * not on the pages read, README bound U) but does nothing against a CLUSTER-scoped kind
 * (ClusterRole, Namespace, a CRD), which `-n` simply ignores. The scope the owner approved is
 * `namespace:<ns>`, so the connector itself must prove every document is a namespaced kind in that
 * namespace, before any prompt and again before any spawn.
 *
 * Why it is not a YAML parser: no YAML library is a dependency of this package, and a hand-written
 * parser would be a second YAML implementation to disagree with kubectl's. kubectl reads the text
 * with go-yaml (YAML 1.1 flavour, sigs.k8s.io/yaml). The only way a SECOND reader stays safe next to
 * the first is to accept a deliberately tiny, boring subset of YAML on which every plausible reader
 * agrees, and to REFUSE everything else. The rule for every line is therefore "if I cannot read it
 * with certainty, throw": a refused manifest costs the caller a rewrite in plain block style, a
 * misread one costs a cluster-scoped write.
 *
 * What is accepted is documented, rule by rule, in `connectors/kubernetes/README.md`. In short:
 *
 *  - printable text only (no tabs, no C0/C1 controls, no BOM, no NEL/LS/PS: go-yaml treats NEL, LS
 *    and PS as line breaks, so a `kind:` hidden after one would be a top-level key to kubectl and
 *    part of a scalar to a reader that only splits on `\n`);
 *  - documents split only on a line that is exactly `---` (an optional ` # comment` is allowed);
 *  - every line at column 0 is `plainKey:` or `plainKey: value`; the three keys read at the top
 *    level (`apiVersion`, `kind`, `metadata`) appear at most once;
 *  - no anchors, aliases, tags, merge keys, `? ` complex keys, flow collections or JSON;
 *  - the four values it interprets are plain or simply quoted scalars with no escapes, and a plain
 *    one that YAML 1.1 would not read as a string (`yes`, `null`, `123`, `1e3`) is refused.
 *
 * Linear: one pass over the lines, no backtracking, no nested data structure.
 */

/** One object the manifest declares, as read. */
export interface ScannedObject {
  readonly apiVersion: string;
  readonly kind: string;
  readonly name: string;
  readonly namespace?: string;
}

/**
 * The kinds an apply may carry, each with the apiVersion(s) that name it. Every kind here is
 * NAMESPACED. Pairing the group is what defeats a cluster-scoped CRD named like a core kind: a
 * CustomResourceDefinition may declare `kind: Service` in the group `example.com`, which is a
 * different resource that the bare name would wrongly allow.
 */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  Deployment: ["apps/v1"],
  StatefulSet: ["apps/v1"],
  DaemonSet: ["apps/v1"],
  ReplicaSet: ["apps/v1"],
  Job: ["batch/v1"],
  CronJob: ["batch/v1"],
  Pod: ["v1"],
  Service: ["v1"],
  ConfigMap: ["v1"],
  Secret: ["v1"],
  PersistentVolumeClaim: ["v1"],
  ServiceAccount: ["v1"],
  Ingress: ["networking.k8s.io/v1"],
  NetworkPolicy: ["networking.k8s.io/v1"],
  Role: ["rbac.authorization.k8s.io/v1"],
  RoleBinding: ["rbac.authorization.k8s.io/v1"],
  HorizontalPodAutoscaler: ["autoscaling/v2", "autoscaling/v1"],
  PodDisruptionBudget: ["policy/v1"],
};

const PLAIN_KEY = /^[A-Za-z][A-Za-z0-9_./-]*$/;
/** A `kind`/`apiVersion` value; the allowlist is the real check, this keeps the echo harmless. */
const TYPE_TEXT = /^[A-Za-z][A-Za-z0-9./-]*$/;
/** A `metadata.name`/`metadata.namespace` value. */
const NAME_TEXT = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
/** Words (any case) that YAML 1.1 reads as a boolean or null rather than a string. */
const YAML11_WORDS = new Set(["y", "n", "yes", "no", "true", "false", "on", "off", "null"]);
/** A block scalar header: `|`, `>`, with indentation and chomping indicators, then an optional comment. */
const BLOCK_HEADER = /^[|>](?:[1-9][+-]?|[+-][1-9]?)?(?:[ ]+(?:#.*)?)?$/;
/** A document separator: `---`, optionally followed by spaces and a comment. */
const DOC_SEPARATOR = /^---(?:[ ]+(?:#.*)?)?$/;
/** A value may not START with these: anchor, alias, tag, flow collection, reserved, directive. */
const FORBIDDEN_START = "&*!{[]},?@`%";
/** A `metadata.name`: a DNS subdomain (lower-case alphanumerics, `-` and `.`, at most 253). */
const DNS_SUBDOMAIN = /^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/;
const KEY_ECHO_LENGTH = 40;

/**
 * A fixed-message refusal: the rule, the document and the line, never manifest text (a Secret value
 * that starts with `@` was once echoed). The only text that may follow is a KEY NAME, passed by the
 * two callers that have just checked it is a plain key at column 0 or directly under metadata.
 */
function refuse(why: string, where: Where, key?: string): never {
  const at = `document ${String(where.doc)}, line ${String(where.line)}`;
  const named =
    key !== undefined && key.length <= KEY_ECHO_LENGTH && PLAIN_KEY.test(key)
      ? ` (key ${key})`
      : "";
  throw new Error(`manifest refused (${at}): ${why}${named}`);
}

interface Where {
  readonly doc: number;
  readonly line: number;
}

/** The first character of `text` that go-yaml would not read as plain printable content. */
function firstBadCharacter(text: string): { index: number; code: number } | undefined {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0a || (c >= 0x20 && c <= 0x7e)) continue;
    // 0x2028 and 0x2029 are line breaks to go-yaml and so are refused with the rest of the controls.
    if (c >= 0xa0 && c <= 0xd7ff && c !== 0x2028 && c !== 0x2029) continue;
    if (c === 0x0d) {
      // CRLF is a line break; a lone CR is one to go-yaml and not to a reader that splits on LF.
      if (text.charCodeAt(i + 1) === 0x0a) continue;
      return { index: i, code: c };
    }
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return { index: i, code: c };
    }
    // 0xE000-0xFFFD without the BOM (0xFEFF).
    if (c >= 0xe000 && c <= 0xfffd && c !== 0xfeff) continue;
    return { index: i, code: c };
  }
  return undefined;
}

interface DocLine {
  readonly no: number;
  readonly text: string;
}

/** Split into documents on lines that are exactly `---`; refuse the other document-level markers. */
function splitDocuments(text: string): DocLine[][] {
  const bad = firstBadCharacter(text);
  if (bad !== undefined) {
    const line = text.slice(0, bad.index).split("\n").length;
    throw new Error(
      `manifest refused (line ${String(line)}): character U+${bad.code
        .toString(16)
        .toUpperCase()
        .padStart(4, "0")} is not allowed (tabs, control characters, a BOM and Unicode line ` +
        "separators are refused)",
    );
  }
  const docs: DocLine[][] = [[]];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const where = { doc: docs.length, line: i + 1 };
    if (line.startsWith("---")) {
      if (!DOC_SEPARATOR.test(line)) {
        refuse("a line starting with --- must be exactly ---", where);
      }
      docs.push([]);
      continue;
    }
    if (line.startsWith("...")) refuse("a document end marker (...) is not accepted", where);
    if (line.startsWith("%")) refuse("a directive (%) is not accepted", where);
    docs.at(-1)?.push({ no: i + 1, text: line });
  }
  return docs;
}

/** A scalar as it was written. */
type Scalar = { readonly t: "plain" | "quoted"; readonly text: string };

/** What follows a `key:` (or a `- `): nothing, a scalar, or a block scalar header. */
type Value = { readonly t: "empty" } | { readonly t: "block" } | Scalar;

interface Lexed {
  readonly dashes: number;
  /** Column of the key (or of the last dash for a keyless `- |`). */
  readonly column: number;
  readonly key?: string;
  readonly keyQuoted: boolean;
  readonly value: Value;
}

/**
 * Read a quoted scalar that starts at `s[0]`. Returns its text and the index just past the closing
 * quote. Throws if it does not close on this line. Escapes are not interpreted: a double-quoted
 * scalar with a backslash keeps the backslash in `text`, which the four interpreted values then
 * refuse (a `C` could spell a different kind or namespace than the one this reader sees).
 */
function readQuoted(s: string, where: Where): { text: string; end: number } {
  const quote = s[0];
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (quote === '"' && c === "\\") {
      i++;
      continue;
    }
    if (c === quote) {
      if (quote === "'" && s[i + 1] === "'") {
        i++;
        continue;
      }
      return { text: s.slice(1, i), end: i + 1 };
    }
  }
  return refuse("a quoted string must close on the line it opens on", where);
}

function skipSpaces(s: string, from: number): number {
  let i = from;
  while (s[i] === " ") i++;
  return i;
}

/** Whether `s[i]` is a `:` that is a mapping indicator (followed by a space or the line end). */
function isIndicatorAt(s: string, i: number): boolean {
  return s[i] === ":" && (i + 1 === s.length || s[i + 1] === " ");
}

/**
 * The text after a `key:` or a `- `: refuse what cannot be read with certainty, strip a trailing
 * comment, and classify it. Applied to EVERY line at EVERY depth.
 */
function lexValue(raw: string, where: Where): Value {
  const v = raw.slice(skipSpaces(raw, 0));
  if (v === "" || v.startsWith("#")) return { t: "empty" };
  const first = v[0] ?? "";
  if (FORBIDDEN_START.includes(first)) {
    refuse(
      "anchors, aliases, tags, flow collections ({ } [ ]), JSON and reserved indicators are not accepted",
      where,
    );
  }
  if (v.startsWith("<<")) refuse("a merge key (<<) is not accepted", where);
  if (first === "|" || first === ">") {
    if (!BLOCK_HEADER.test(v)) refuse("unreadable block scalar header", where);
    return { t: "block" };
  }
  if (first === '"' || first === "'") {
    const { text, end } = readQuoted(v, where);
    const after = v.slice(end);
    const trimmed = after.slice(skipSpaces(after, 0));
    // After the closing quote only spaces and a comment (separated by a space) may follow.
    if (trimmed !== "" && !(after.startsWith(" ") && trimmed.startsWith("#"))) {
      refuse("unexpected text after a quoted string", where);
    }
    return { t: "quoted", text };
  }
  if ((first === "-" || first === ":") && (v.length === 1 || v[1] === " ")) {
    refuse("a nested sequence or empty-key indicator on one line is not accepted", where);
  }
  const hash = v.indexOf(" #");
  const text = (hash === -1 ? v : v.slice(0, hash)).replace(/ +$/, "");
  if (text.endsWith(":") || text.includes(": ")) {
    refuse("a mapping indicator inside a value is not accepted", where);
  }
  return { t: "plain", text };
}

/** Index of the `:` that ends a plain key in `body`, or -1 when the line has no key. */
function plainKeyEnd(body: string): number {
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "#" && (i === 0 || body[i - 1] === " ")) return -1;
    if (isIndicatorAt(body, i)) return i;
  }
  return -1;
}

/** Read one non-blank, non-comment line: dashes, key, value. */
function lexLine(rest: string, indent: number, where: Where): Lexed {
  let body = rest;
  let column = indent;
  let dashes = 0;
  let dashColumn = indent;
  while (body === "-" || body.startsWith("- ")) {
    dashes++;
    dashColumn = column;
    const next = skipSpaces(body, 1);
    column += next;
    body = body.slice(next);
  }
  if (body === "") return { dashes, column: dashColumn, keyQuoted: false, value: { t: "empty" } };
  const first = body[0] ?? "";
  if (FORBIDDEN_START.includes(first)) {
    refuse(
      "anchors, aliases, tags, flow collections ({ } [ ]), JSON and reserved indicators are not accepted",
      where,
    );
  }
  if (body.startsWith("<<")) refuse("a merge key (<<) is not accepted", where);
  if (isIndicatorAt(body, 0)) refuse("an empty key is not accepted", where);
  if (first === "|" || first === ">") {
    if (dashes === 0) refuse("a block scalar needs a key or a list entry", where);
    // A bare `- |` is opened by the last dash: its content must be indented past that dash.
    return { dashes, column: dashColumn, keyQuoted: false, value: lexValue(body, where) };
  }
  if (first === '"' || first === "'") {
    const { text, end } = readQuoted(body, where);
    const afterQuote = skipSpaces(body, end);
    if (isIndicatorAt(body, afterQuote)) {
      return {
        dashes,
        column,
        key: text,
        keyQuoted: true,
        value: lexValue(body.slice(afterQuote + 1), where),
      };
    }
    return { dashes, column, keyQuoted: false, value: lexValue(body, where) };
  }
  const end = plainKeyEnd(body);
  if (end === -1) return { dashes, column, keyQuoted: false, value: lexValue(body, where) };
  return {
    dashes,
    column,
    key: body.slice(0, end),
    keyQuoted: false,
    value: lexValue(body.slice(end + 1), where),
  };
}

/** The text of a scalar one of the four interpreted values holds, or a refusal. */
function interpreted(value: Value, field: string, shape: RegExp, where: Where): string {
  if (value.t !== "plain" && value.t !== "quoted") {
    refuse(`${field} must be a plain or simply quoted scalar`, where);
  }
  const { text } = value;
  if (!shape.test(text)) {
    refuse(`${field} has a value this scanner cannot read with certainty`, where);
  }
  if (value.t === "plain" && field.startsWith("metadata.")) {
    // YAML 1.1 reads these plain scalars as booleans, null or numbers; a quoted one is a string.
    if (YAML11_WORDS.has(text.toLowerCase()) || /^[0-9]/.test(text)) {
      refuse(
        `${field}: a plain value YAML may read as a boolean or a number must be quoted`,
        where,
      );
    }
  }
  return text;
}

interface DocState {
  apiVersion?: string;
  kind?: string;
  sawMetadata: boolean;
  name?: string;
  namespace?: string;
}

/** Scan one document; returns its object, or `undefined` when it holds no content at all. */
function scanDocument(
  lines: readonly DocLine[],
  docNo: number,
  ns: string,
): ScannedObject | undefined {
  const st: DocState = { sawMetadata: false };
  let hasContent = false;
  let blockColumn: number | undefined; // inside a block scalar opened by a key at this column
  let inMetadata = false;
  let childIndent: number | undefined; // indentation of metadata's direct children
  let pendingColumn: number | undefined; // an interpreted value must not continue past this column

  for (const { no, text } of lines) {
    const where: Where = { doc: docNo, line: no };
    const indent = skipSpaces(text, 0);
    const rest = text.slice(indent);

    // A block scalar's content is never interpreted: every blank or more-indented line is skipped.
    if (blockColumn !== undefined) {
      if (rest === "" || indent > blockColumn) continue;
      blockColumn = undefined;
    }
    if (rest === "" || rest.startsWith("#")) continue;

    if (!hasContent && indent !== 0)
      refuse("the first line of a document must start at column 0", where);
    hasContent = true;

    // A plain multi-line value continues on more-indented lines. For the four interpreted values
    // that would make this reader and kubectl read different text, so it is refused.
    if (pendingColumn !== undefined) {
      if (indent > pendingColumn) {
        refuse(
          "kind, apiVersion, metadata.name and metadata.namespace must fit on one line",
          where,
        );
      }
      pendingColumn = undefined;
    }

    const lexed = lexLine(rest, indent, where);
    if (lexed.value.t === "block") blockColumn = lexed.column;

    if (indent === 0) {
      inMetadata = false;
      childIndent = undefined;
      if (lexed.dashes > 0) {
        refuse("a list at column 0 is not accepted; indent a list under its key", where);
      }
      if (lexed.key === undefined)
        refuse("a line at column 0 must be `key:` or `key: value`", where);
      if (lexed.keyQuoted || !PLAIN_KEY.test(lexed.key)) {
        refuse("a key at column 0 must be a plain key (letters, digits, _ . / -)", where);
      }
      if (lexed.key === "items") {
        // kubectl's builder flattens ANY object whose top-level `items` is an array (it asks
        // Unstructured.IsList()), applies the items and drops the wrapper: a ConfigMap with an
        // `items:` list of ClusterRoles would apply the ClusterRoles. Nested `items` (volume
        // projections) is not top-level and stays allowed.
        refuse(
          "a top-level items key is not accepted (kubectl would read the document as a List)",
          where,
          lexed.key,
        );
      }
      if (lexed.key === "apiVersion" || lexed.key === "kind") {
        if (st[lexed.key] !== undefined) refuse(`duplicate top-level ${lexed.key}`, where);
        st[lexed.key] = interpreted(lexed.value, lexed.key, TYPE_TEXT, where);
        pendingColumn = 0;
      } else if (lexed.key === "metadata") {
        if (st.sawMetadata) refuse("duplicate top-level metadata", where);
        st.sawMetadata = true;
        if (lexed.value.t !== "empty") refuse("metadata must be a block mapping", where);
        inMetadata = true;
      }
      continue;
    }

    if (!inMetadata) continue;
    // Inside metadata: its direct children are the lines at the first child's indentation.
    if (childIndent === undefined) {
      childIndent = indent;
      if (lexed.dashes > 0 || lexed.key === undefined)
        refuse("metadata must be a block mapping", where);
    } else if (indent < childIndent) {
      refuse("inconsistent indentation under metadata", where);
    }
    if (indent !== childIndent || lexed.dashes > 0) continue;
    if (lexed.key === undefined)
      refuse("a line under metadata must be `key:` or `key: value`", where);
    if (lexed.keyQuoted || !PLAIN_KEY.test(lexed.key)) {
      refuse("a key directly under metadata must be a plain key", where);
    }
    if (lexed.key === "generateName") {
      refuse("metadata.generateName is not accepted; give metadata.name", where, lexed.key);
    }
    if (lexed.key === "name" || lexed.key === "namespace") {
      if (st[lexed.key] !== undefined) refuse(`duplicate metadata.${lexed.key}`, where);
      st[lexed.key] = interpreted(
        lexed.value,
        `metadata.${lexed.key}`,
        lexed.key === "name" ? DNS_SUBDOMAIN : NAME_TEXT,
        where,
      );
      pendingColumn = childIndent;
    }
  }

  if (!hasContent) return undefined;
  const where: Where = { doc: docNo, line: lines.at(-1)?.no ?? 1 };
  if (st.kind === undefined || st.apiVersion === undefined) {
    refuse("every document needs a top-level apiVersion and kind", where);
  }
  if (!st.sawMetadata) refuse("every document needs a top-level metadata block", where);
  if (st.name === undefined) refuse("every document needs metadata.name", where);
  const versions = Object.hasOwn(ALLOWED, st.kind) ? ALLOWED[st.kind] : undefined;
  if (versions === undefined) {
    refuse("this kind is not on the namespaced allowlist", where);
  }
  if (!versions.includes(st.apiVersion)) {
    refuse(
      `apiVersion is not the one paired with this kind (expected ${versions.join(" or ")})`,
      where,
    );
  }
  if (st.namespace !== undefined && st.namespace !== ns) {
    refuse("metadata.namespace differs from the namespace argument", where);
  }
  return {
    apiVersion: st.apiVersion,
    kind: st.kind,
    name: st.name,
    ...(st.namespace === undefined ? {} : { namespace: st.namespace }),
  };
}

/**
 * Read `text` as a multi-document Kubernetes manifest and return one entry per object, or throw a
 * fixed-message error naming the rule and the place. Never returns for a manifest it could not read
 * with certainty, and never for one with an object outside `namespace` or off the allowlist.
 */
export function scanNamespacedManifest(text: string, namespace: string): ScannedObject[] {
  const objects: ScannedObject[] = [];
  const docs = splitDocuments(text);
  for (let i = 0; i < docs.length; i++) {
    const object = scanDocument(docs[i] ?? [], i + 1, namespace);
    if (object !== undefined) objects.push(object);
  }
  if (objects.length === 0) throw new Error("manifest refused: it declares no objects");
  return objects;
}
