import { describe, expect, test } from "bun:test";

import { filterWorkdayWorkers } from "../src/search-filter.ts";

function worker(fields: {
  descriptor?: string;
  title?: string;
  team?: string;
  department?: string;
  location?: string;
} = {}): Record<string, unknown> {
  return {
    descriptor: fields.descriptor ?? "Avery Example",
    title: fields.title ?? "Platform Engineer",
    team: fields.team ?? "Orchid Team",
    department: fields.department ?? "Infrastructure",
    location: fields.location ?? "North Campus",
  };
}

describe("filterWorkdayWorkers", () => {
  test("matches each configured field case-insensitively", () => {
    const cases = [
      { row: worker({ descriptor: "Zinnia Person" }), query: "ZINNIA" },
      { row: worker({ title: "Quasar Architect" }), query: "QUASAR" },
      { row: worker({ team: "Cobalt Team" }), query: "COBALT" },
      { row: worker({ department: "Marmot Operations" }), query: "MARMOT" },
      { row: worker({ location: "Juniper Annex" }), query: "JUNIPER" },
    ];

    for (const { row, query } of cases) {
      expect(filterWorkdayWorkers([row], { query })).toEqual([row]);
    }
  });

  test("returns empty for a non-match", () => {
    expect(filterWorkdayWorkers([worker()], { query: "nonsense" })).toEqual([]);
  });

  test("skips non-object entries", () => {
    const match = worker({ descriptor: "Needle Person" });
    expect(filterWorkdayWorkers([null, 42, "x", match], { query: "needle" })).toEqual([match]);
  });

  test("tolerates missing and non-string fields", () => {
    const rows: unknown[] = [
      { descriptor: "missing-fields" },
      { descriptor: "numeric-title", title: 42 },
      worker({ title: "Harbor Specialist" }),
    ];

    const out = filterWorkdayWorkers(rows, { query: "harbor" });
    expect(out).toEqual([rows[2]]);
  });

  test("respects limit in encounter order", () => {
    const rows = Array.from({ length: 6 }, (_, index) =>
      worker({ descriptor: `Match Person ${String(index)}`, team: "Signal Team" }),
    );

    const out = filterWorkdayWorkers(rows, { query: "signal", limit: 3 });
    expect(out).toEqual(rows.slice(0, 3));
  });

  test("default limit is 50", () => {
    const rows = Array.from({ length: 75 }, (_, index) =>
      worker({ descriptor: `Worker ${String(index)}`, department: "Shared Department" }),
    );

    const out = filterWorkdayWorkers(rows, { query: "shared" });
    expect(out).toHaveLength(50);
    expect(out).toEqual(rows.slice(0, 50));
  });

  test("empty input returns empty", () => {
    expect(filterWorkdayWorkers([], { query: "anything" })).toEqual([]);
  });
});
