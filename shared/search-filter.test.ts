import { describe, expect, test } from "bun:test";

import {
  asObjectish,
  asRecord,
  fieldsFromKeys,
  filterByQuery,
  makeQueryFilter,
  nestedString,
  nonEmptyStringsText,
  objectNamesText,
  recordFieldsFromKeys,
  stringField,
  tagNamesFromObjects,
  tagText,
} from "./search-filter.ts";

describe("filterByQuery", () => {
  const rows = [
    { name: "Revenue", tag: "finance" },
    { name: "Latency", tag: "ops" },
    { name: "Revenue Detail", tag: "finance" },
  ];
  const fields = (r: { name: string; tag: string }) => [r.name, r.tag];

  test("matches case-insensitively", () => {
    expect(filterByQuery(rows, { query: "REVENUE", fields })).toHaveLength(2);
  });

  test("non-match returns empty", () => {
    expect(filterByQuery(rows, { query: "nonsense", fields })).toHaveLength(0);
  });

  test("empty query matches every non-skipped item", () => {
    expect(filterByQuery(rows, { query: "", fields })).toHaveLength(3);
  });

  test("honors a custom limit cap in encounter order", () => {
    const out = filterByQuery(rows, { query: "revenue", limit: 1, fields });
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe("Revenue");
  });

  test("defaults the cap to 50", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ name: `n-${i}`, tag: "x" }));
    expect(filterByQuery(many, { query: "n-", fields })).toHaveLength(50);
  });

  test("fields returning null skips the item entirely", () => {
    const mixed = [{ name: "keep" }, { name: "skip" }, { name: "keep-too" }];
    const out = filterByQuery(mixed, {
      query: "",
      fields: (r) => (r.name === "skip" ? null : [r.name]),
    });
    expect(out.map((r) => r.name)).toEqual(["keep", "keep-too"]);
  });

  test("tolerates null and undefined field parts", () => {
    const out = filterByQuery([{ a: "hit" }], {
      query: "hit",
      fields: (r) => [r.a, null, undefined],
    });
    expect(out).toHaveLength(1);
  });
});

describe("asRecord", () => {
  test("accepts a plain object", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
  });

  test("rejects null, primitives, and arrays", () => {
    expect(asRecord(null)).toBeUndefined();
    expect(asRecord(42)).toBeUndefined();
    expect(asRecord("x")).toBeUndefined();
    expect(asRecord([1, 2])).toBeUndefined();
  });
});

describe("asObjectish", () => {
  test("accepts a plain object and an array", () => {
    expect(asObjectish({ a: 1 })).toEqual({ a: 1 });
    expect(asObjectish([1, 2])).toEqual([1, 2] as unknown as Record<string, unknown>); // NOSONAR S4325: bridges the array literal to asObjectish's Record<string,unknown>|undefined return for toEqual
  });

  test("rejects null and primitives", () => {
    expect(asObjectish(null)).toBeUndefined();
    expect(asObjectish(42)).toBeUndefined();
    expect(asObjectish("x")).toBeUndefined();
  });
});

describe("stringField", () => {
  test("returns the string value for a string field", () => {
    expect(stringField({ name: "Revenue" }, "name")).toBe("Revenue");
  });

  test("returns empty string for a missing key", () => {
    expect(stringField({ name: "Revenue" }, "absent")).toBe("");
  });

  test("returns empty string for a non-string value", () => {
    expect(stringField({ count: 42 }, "count")).toBe("");
    expect(stringField({ flag: true }, "flag")).toBe("");
    expect(stringField({ nested: { a: 1 } }, "nested")).toBe("");
    expect(stringField({ list: ["a"] }, "list")).toBe("");
    expect(stringField({ nil: null }, "nil")).toBe("");
  });
});

describe("tagText", () => {
  test("joins a string array at key 'tags' with spaces", () => {
    expect(tagText({ tags: ["finance", "ops"] })).toBe("finance ops");
  });

  test("returns empty string when 'tags' is missing", () => {
    expect(tagText({ name: "x" })).toBe("");
  });

  test("returns empty string when 'tags' is not an array", () => {
    expect(tagText({ tags: "finance" })).toBe("");
    expect(tagText({ tags: { a: 1 } })).toBe("");
    expect(tagText({ tags: null })).toBe("");
  });

  test("skips non-string entries", () => {
    expect(tagText({ tags: ["finance", 42, null, { name: "x" }, "ops"] })).toBe("finance ops");
  });

  test("returns empty string for an array of only non-string entries", () => {
    expect(tagText({ tags: [1, 2, { a: 1 }] })).toBe("");
  });
});

describe("nonEmptyStringsText", () => {
  test("joins the string entries of the array at `key` with spaces", () => {
    expect(nonEmptyStringsText({ owners: ["airflow", "data-eng"] }, "owners")).toBe(
      "airflow data-eng",
    );
  });

  test("skips empty strings and non-strings, so no double space reaches the haystack", () => {
    const row = { tags: ["a", "", 42, null, "b"] };
    expect(nonEmptyStringsText(row, "tags")).toBe("a b");
    // The rule it does NOT share with tagText, which joins the empty entry.
    expect(tagText(row)).toBe("a  b");
  });

  test("returns empty string when the key is missing or not an array", () => {
    expect(nonEmptyStringsText({}, "tags")).toBe("");
    expect(nonEmptyStringsText({ tags: "a" }, "tags")).toBe("");
    expect(nonEmptyStringsText({ tags: null }, "tags")).toBe("");
  });
});

describe("objectNamesText", () => {
  test("joins the non-empty string `name` of each objectish entry at `key`", () => {
    const row = { projects: [{ name: "web" }, { name: "" }, "plain", null, { name: 7 }, {}] };
    expect(objectNamesText(row, "projects")).toBe("web");
  });

  test("returns empty string when the key is missing or not an array", () => {
    expect(objectNamesText({}, "projects")).toBe("");
    expect(objectNamesText({ projects: { name: "x" } }, "projects")).toBe("");
  });

  test("tagNamesFromObjects is the same rule at the `tags` key", () => {
    const row = { tags: [{ name: "finance" }, { name: "" }, 3, { name: "ops" }] };
    expect(tagNamesFromObjects(row)).toBe(objectNamesText(row, "tags"));
    expect(tagNamesFromObjects(row)).toBe("finance ops");
  });
});

describe("tagNamesFromObjects", () => {
  test("joins the string `name` of each tag object with spaces", () => {
    expect(tagNamesFromObjects({ tags: [{ name: "finance" }, { name: "ops" }] })).toBe(
      "finance ops",
    );
  });

  test("returns empty string when `tags` is missing", () => {
    expect(tagNamesFromObjects({ other: 1 })).toBe("");
  });

  test("returns empty string when `tags` is not an array", () => {
    expect(tagNamesFromObjects({ tags: "finance" })).toBe("");
    expect(tagNamesFromObjects({ tags: { name: "x" } })).toBe("");
    expect(tagNamesFromObjects({ tags: null })).toBe("");
  });

  test("skips non-object entries (asObjectish undefined)", () => {
    expect(tagNamesFromObjects({ tags: ["plain", 42, null, { name: "kept" }] })).toBe("kept");
  });

  test("skips object entries whose `name` is missing, non-string, or empty", () => {
    expect(
      tagNamesFromObjects({
        tags: [{ name: 5 }, { other: "x" }, { name: "" }, { name: "good" }],
      }),
    ).toBe("good");
  });

  test("returns empty string for an array of only skippable entries", () => {
    expect(tagNamesFromObjects({ tags: [{ name: "" }, { name: 1 }, "x"] })).toBe("");
  });
});

describe("fieldsFromKeys", () => {
  test("reads the requested string keys off an objectish row", () => {
    const extract = fieldsFromKeys(["name", "owner"]);
    expect(extract({ name: "Revenue", owner: "fin", extra: "ignored" })).toEqual([
      "Revenue",
      "fin",
    ]);
  });

  test("missing/non-string keys collapse to empty strings", () => {
    const extract = fieldsFromKeys(["name", "missing"]);
    expect(extract({ name: "x", missing: 42 })).toEqual(["x", ""]);
  });

  test("appends tag text when opts.tags is true", () => {
    const extract = fieldsFromKeys(["name"], { tags: true });
    expect(extract({ name: "x", tags: ["a", "b"] })).toEqual(["x", "a b"]);
  });

  test("does not append tags when opts.tags is false or omitted", () => {
    expect(fieldsFromKeys(["name"], { tags: false })({ name: "x", tags: ["a"] })).toEqual(["x"]);
    expect(fieldsFromKeys(["name"])({ name: "x", tags: ["a"] })).toEqual(["x"]);
  });

  test("returns null for a non-objectish item", () => {
    const extract = fieldsFromKeys(["name"]);
    expect(extract(null)).toBeNull();
    expect(extract(42)).toBeNull();
    expect(extract("str")).toBeNull();
  });

  test("treats an array item as objectish (asObjectish accepts arrays)", () => {
    // asObjectish accepts arrays, so string-indexed keys resolve to "".
    const extract = fieldsFromKeys(["0"]);
    expect(extract(["first", "second"])).toEqual(["first"]);
  });
});

describe("recordFieldsFromKeys", () => {
  test("reads the requested string keys off a plain-object row", () => {
    expect(recordFieldsFromKeys(["name", "id"])({ name: "Revenue", id: 7 })).toEqual([
      "Revenue",
      "",
    ]);
  });

  test("returns null for an array row as well as for non-objects", () => {
    const extract = recordFieldsFromKeys(["0"]);
    expect(extract(["first"])).toBeNull();
    expect(extract(null)).toBeNull();
    expect(extract("str")).toBeNull();
  });

  test("never matches an array row — the one case where it differs from fieldsFromKeys", () => {
    // An array row read as an object yields only empty fields, and those join to spaces — so a
    // query made only of spaces matches it under fieldsFromKeys, but not here.
    const rows = [["a", "b"], { name: "x" }];
    const opts = { query: " " };
    expect(makeQueryFilter(fieldsFromKeys(["name", "id"]))(rows, opts)).toEqual(rows);
    expect(makeQueryFilter(recordFieldsFromKeys(["name", "id"]))(rows, opts)).toEqual([
      { name: "x" },
    ]);
  });
});

describe("nestedString", () => {
  test("reads a leaf string down a multi-segment path", () => {
    const root = { metadata: { labels: { app: "web" } } };
    expect(nestedString(root, ["metadata", "labels", "app"])).toBe("web");
  });

  test("returns the value for a single-segment path", () => {
    expect(nestedString({ kind: "Deployment" }, ["kind"])).toBe("Deployment");
  });

  test("returns empty string when an intermediate segment is missing", () => {
    expect(nestedString({ metadata: {} }, ["metadata", "labels", "app"])).toBe("");
  });

  test("returns empty string when an intermediate segment is not a record", () => {
    expect(nestedString({ metadata: "scalar" }, ["metadata", "name"])).toBe("");
  });

  test("returns empty string when the leaf is not a string", () => {
    expect(nestedString({ spec: { replicas: 3 } }, ["spec", "replicas"])).toBe("");
  });

  test("returns empty string for a missing leaf", () => {
    expect(nestedString({ spec: {} }, ["spec", "absent"])).toBe("");
  });

  test("handles an empty path via the at(-1) fallback", () => {
    // path.at(-1) is undefined → keyed by "" → missing leaf → "".
    expect(nestedString({ "": "weird" }, [])).toBe("weird");
    expect(nestedString({ a: 1 }, [])).toBe("");
  });
});

describe("makeQueryFilter", () => {
  test("builds a filter that delegates to filterByQuery with the extractor", () => {
    const filter = makeQueryFilter(fieldsFromKeys(["name"]));
    const items = [{ name: "Revenue" }, { name: "Latency" }, "non-object"];
    const out = filter(items, { query: "rev" });
    expect(out).toEqual([{ name: "Revenue" }]);
  });

  test("honors the limit option passed through to filterByQuery", () => {
    const filter = makeQueryFilter(fieldsFromKeys(["name"]));
    const items = [{ name: "a-1" }, { name: "a-2" }, { name: "a-3" }];
    expect(filter(items, { query: "a-", limit: 2 })).toHaveLength(2);
  });
});
