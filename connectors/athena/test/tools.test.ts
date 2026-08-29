import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type SpawnStub,
  stubSpawn,
} from "../../../scripts/connector-tool-harness.ts";
import { ATHENA_TOOL_NAMES, registerAthenaTools } from "../src/tools.ts";

let tools: CapturedTools;
let spawn: SpawnStub | undefined;

/** Replace the CLI with a stub answering `body` as its stdout. */
function cli(body: unknown, exitCode = 0, stderr = ""): void {
  spawn = stubSpawn({ stdout: JSON.stringify(body), exitCode, stderr });
}

/** The argv of the single CLI invocation. */
function argv(): readonly string[] {
  return spawn?.calls[0]?.command ?? [];
}

beforeEach(() => {
  tools = captureTools(registerAthenaTools);
});

afterEach(() => {
  spawn?.restore();
  spawn = undefined;
});

describe("registerAthenaTools", () => {
  it("registers exactly the tools it declares", () => {
    expect(tools.names()).toEqual([...ATHENA_TOOL_NAMES].sort());
  });

  it("never asks the CLI for row data", async () => {
    // The connector's whole contract is metadata-only: no query execution and
    // no result fetching, whichever tool is called and however it is called.
    const forbidden = ["start-query-execution", "get-query-results", "get-query-execution"];
    for (const [name, args] of [
      ["athena_list", {}],
      ["athena_list", { catalog: "c" }],
      ["athena_list", { catalog: "c", database: "d" }],
      ["athena_get", { catalog: "c", database: "d", table: "t" }],
      ["athena_search", { query: "q" }],
      ["athena_search", { catalog: "c", query: "q" }],
      ["athena_search", { catalog: "c", database: "d", query: "q" }],
    ] as const) {
      cli({});
      await tools.call(name, args);
      const called = argv();
      expect({ name, forbidden: forbidden.filter((v) => called.includes(v)) }).toEqual({
        name,
        forbidden: [],
      });
      spawn?.restore();
    }
  });
});

describe("athena_list", () => {
  it("lists data catalogs when given nothing", async () => {
    cli({ DataCatalogsSummary: [{ CatalogName: "awsdatacatalog" }] });
    const out = (await tools.callJson("athena_list", {})) as { DataCatalogsSummary: unknown[] };
    expect(argv()).toEqual([
      "aws",
      "athena",
      "list-data-catalogs",
      "--max-results",
      "200",
      "--output",
      "json",
    ]);
    expect(out.DataCatalogsSummary).toHaveLength(1);
  });

  it("lists a catalog's databases when given a catalog", async () => {
    cli({ DatabaseList: [] });
    await tools.call("athena_list", { catalog: "awsdatacatalog" });
    expect(argv()).toContain("list-databases");
    expect(argv()).toContain("awsdatacatalog");
  });

  it("lists a database's table metadata when given both", async () => {
    cli({ TableMetadataList: [] });
    await tools.call("athena_list", { catalog: "c", database: "d" });
    expect(argv()).toContain("list-table-metadata");
    expect(argv()).toContain("--database-name");
  });

  it("reports a CLI failure, naming the subcommand", async () => {
    cli({}, 255, "An error occurred: AccessDeniedException");
    await expect(tools.call("athena_list", {})).rejects.toThrow(
      "aws athena list-data-catalogs failed: An error occurred: AccessDeniedException",
    );
  });
});

describe("athena_get", () => {
  it("fetches one table's metadata", async () => {
    cli({ TableMetadata: { Name: "events" } });
    const out = (await tools.callJson("athena_get", {
      catalog: "c",
      database: "d",
      table: "events",
    })) as { TableMetadata: { Name: string } };
    expect(argv()).toContain("get-table-metadata");
    expect(argv()).toContain("events");
    expect(out.TableMetadata.Name).toBe("events");
  });

  it("rejects an argument that would be read as a CLI flag", async () => {
    // `--profile` reaching argv as a "catalog" would change which AWS account
    // the CLI talks to, so it is refused at the schema boundary.
    cli({});
    await expect(
      tools.call("athena_get", { catalog: "--profile", database: "d", table: "t" }),
    ).rejects.toThrow();
    expect(spawn?.calls).toHaveLength(0);
  });
});

describe("athena_search", () => {
  it("filters catalog names case-insensitively", async () => {
    cli({ DataCatalogsSummary: [{ CatalogName: "AwsDataCatalog" }, { CatalogName: "hive" }] });
    const out = (await tools.callJson("athena_search", { query: "awsdata" })) as {
      matches: { CatalogName: string }[];
    };
    expect(out.matches.map((m) => m.CatalogName)).toEqual(["AwsDataCatalog"]);
  });

  it("filters database names under a catalog", async () => {
    cli({ DatabaseList: [{ Name: "sales" }, { Name: "marketing" }] });
    const out = (await tools.callJson("athena_search", { catalog: "c", query: "sal" })) as {
      matches: { Name: string }[];
    };
    expect(out.matches.map((m) => m.Name)).toEqual(["sales"]);
  });

  it("filters table names under a database", async () => {
    cli({ TableMetadataList: [{ Name: "events" }, { Name: "users" }] });
    const out = (await tools.callJson("athena_search", {
      catalog: "c",
      database: "d",
      query: "user",
    })) as { matches: { Name: string }[] };
    expect(out.matches.map((m) => m.Name)).toEqual(["users"]);
  });

  it("skips entries that are not objects or lack the matched field", async () => {
    cli({ DataCatalogsSummary: [null, "x", {}, { CatalogName: 7 }, { CatalogName: "keep" }] });
    const out = (await tools.callJson("athena_search", { query: "keep" })) as {
      matches: unknown[];
    };
    expect(out.matches).toHaveLength(1);
  });

  it("returns no matches when the CLI reports an unexpected envelope", async () => {
    cli({ SomethingElse: [{ CatalogName: "x" }] });
    expect((await tools.callJson("athena_search", { query: "x" })) as unknown).toEqual({
      matches: [],
    });
  });
});
