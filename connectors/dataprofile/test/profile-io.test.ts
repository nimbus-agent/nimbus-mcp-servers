/**
 * The I/O edges of connectors/dataprofile/src/profile.ts that the parser tests
 * cannot reach: the REAL Parquet footer reader (hyparquet, not an injected
 * fake), files above the 64 MiB whole-read cap, and inputs that fail to open
 * or parse.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDataModel, listDataModels, type ParquetMetadataLike } from "../src/profile.ts";

/** The whole-read cap in profile.ts; anything larger is profiled from a header peek. */
const MAX_TEXT_BYTES = 64 * 1024 * 1024;
/** How much of an oversized file that header peek reads. */
const HEADER_PEEK_BYTES = 64 * 1024;

const ascii = (s: string): number[] => [...Buffer.from(s, "utf8")];

/**
 * A minimal but genuine Parquet file: magic, a Thrift-compact `FileMetaData`
 * footer, the footer length, magic. The schema is a root plus two columns —
 * `id` INT32 REQUIRED and `email` BYTE_ARRAY OPTIONAL — with `num_rows` 5 and
 * no row groups, so there is no row data in the file at all.
 */
function minimalParquet(): Buffer {
  // One row per Thrift field (compact protocol: a field header byte, then its value).
  const fields: readonly (readonly number[])[] = [
    [0x15, 0x02], // 1: version (i32) = 1
    [0x19, 0x3c], // 2: schema, list<struct> of 3
    [0x48, 0x06, ...ascii("schema"), 0x15, 0x04, 0x00], // root: name, num_children = 2
    [0x15, 0x02, 0x25, 0x00, 0x18, 0x02, ...ascii("id"), 0x00], // INT32, REQUIRED, "id"
    [0x15, 0x0c, 0x25, 0x02, 0x18, 0x05, ...ascii("email"), 0x00], // BYTE_ARRAY, OPTIONAL
    [0x16, 0x0a], // 3: num_rows (i64) = 5
    [0x19, 0x0c], // 4: row_groups, empty list<struct>
    [0x00], // stop
  ];
  const footer = fields.flat();
  const length = Buffer.alloc(4);
  length.writeInt32LE(footer.length);
  return Buffer.concat([Buffer.from("PAR1"), Buffer.from(footer), length, Buffer.from("PAR1")]);
}

/** Write `head`, then extend the file past the whole-read cap without writing the rest. */
async function writeOversized(path: string, head: string): Promise<number> {
  const size = MAX_TEXT_BYTES + 1;
  const fh = await open(path, "w");
  try {
    await fh.writeFile(head, "utf8");
    await fh.truncate(size);
  } finally {
    await fh.close();
  }
  return size;
}

describe("profile.ts — I/O edges (real fs)", () => {
  let dir: string;
  const prev = process.env["DATAPROFILE_DIR"];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nimbus-dp-io-"));
    process.env["DATAPROFILE_DIR"] = dir;
  });

  afterEach(async () => {
    if (prev === undefined) {
      delete process.env["DATAPROFILE_DIR"];
    } else {
      process.env["DATAPROFILE_DIR"] = prev;
    }
    await rm(dir, { recursive: true, force: true });
  });

  test("the default reader profiles a real Parquet footer: schema and row count only", async () => {
    const bytes = minimalParquet();
    await writeFile(join(dir, "users.parquet"), bytes);
    expect(await getDataModel("users.parquet")).toEqual({
      relativePath: "users.parquet",
      format: "parquet",
      columns: [
        { name: "id", type: "INT32" },
        { name: "email", type: "BYTE_ARRAY" },
      ],
      columnCount: 2,
      rowCountEstimate: 5,
      sizeBytes: bytes.length,
    });
  });

  test("the default reader skips a .parquet file that is not Parquet", async () => {
    await writeFile(join(dir, "fake.parquet"), "PAR1 but not really", "utf8");
    await writeFile(join(dir, "real.csv"), "a\n1\n", "utf8");
    expect((await listDataModels()).map((m) => m.relativePath)).toEqual(["real.csv"]);
  });

  test("a Parquet file that disappears after its footer was read is skipped", async () => {
    const reader = async (): Promise<ParquetMetadataLike> => ({
      schema: [{ name: "id", type: "INT32" }],
      num_rows: 1,
    });
    // The injected reader answers without touching disk, so the size probe is
    // what finds the file missing.
    expect(await getDataModel("gone.parquet", reader)).toBeNull();
  });

  test("an oversized CSV is profiled from its header alone, with no row estimate", async () => {
    const size = await writeOversized(join(dir, "huge.csv"), "user_id,email\nu1,a@example.com\n");
    expect(await getDataModel("huge.csv")).toEqual({
      relativePath: "huge.csv",
      format: "csv",
      columns: [
        { name: "user_id", type: null },
        { name: "email", type: null },
      ],
      columnCount: 2,
      rowCountEstimate: null,
      sizeBytes: size,
    });
  });

  test("an oversized JSON document is skipped rather than parsed from a fragment", async () => {
    // The first 64 KiB — all a header peek reads — is a complete, valid JSON document, so only
    // the oversized-JSON rule keeps it from being profiled from that fragment.
    const peek = `[{"a":1}]${" ".repeat(HEADER_PEEK_BYTES)}`;
    await writeOversized(join(dir, "huge.json"), peek);
    await writeFile(join(dir, "small.json"), '[{"a":1}]', "utf8");
    expect(await getDataModel("huge.json")).toBeNull();
    expect((await listDataModels()).map((m) => m.relativePath)).toEqual(["small.json"]);
  });

  test("a .json file that is not valid JSON is skipped, not thrown", async () => {
    await writeFile(join(dir, "broken.json"), "{ not json", "utf8");
    expect(await getDataModel("broken.json")).toBeNull();
    expect(await listDataModels()).toEqual([]);
  });

  test("a data file that cannot be opened profiles to null", async () => {
    expect(await getDataModel("missing.csv")).toBeNull();
  });

  test("a directory named like a data file profiles to null", async () => {
    // POSIX opens a directory and then fails the read (EISDIR); Windows fails the open.
    // Either way the answer is null, never a throw.
    await mkdir(join(dir, "folder.csv"));
    expect(await getDataModel("folder.csv")).toBeNull();
  });
});
