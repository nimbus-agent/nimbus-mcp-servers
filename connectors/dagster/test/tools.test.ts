import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  stubFetch,
} from "../../../scripts/connector-tool-harness.ts";
import { DAGSTER_TOOL_NAMES, registerDagsterTools } from "../src/tools.ts";

const URL_ENV = "DAGSTER_BASE_URL";
const TOKEN_ENV = "DAGSTER_API_TOKEN";

let tools: CapturedTools;
let stub: FetchStub | undefined;

/** One repository node as the Dagster GraphQL catalog returns it. */
function repo(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "prod_repo",
    location: { name: "us-east" },
    pipelines: [
      {
        id: "job-1",
        name: "daily_ingest",
        description: "Loads yesterday's events.",
        isJob: true,
        tags: [{ key: "team", value: "data" }],
      },
    ],
    ...over,
  };
}

/** A successful GraphQL reply carrying `nodes`. */
function catalog(...nodes: unknown[]): void {
  stub = stubFetch({
    body: JSON.stringify({ data: { repositoriesOrError: { nodes } } }),
  });
}

beforeEach(() => {
  process.env[URL_ENV] = "https://dagster.example.test/";
  process.env[TOKEN_ENV] = "dg-token";
  tools = captureTools(registerDagsterTools);
});

afterEach(() => {
  stub?.restore();
  stub = undefined;
  delete process.env[URL_ENV];
  delete process.env[TOKEN_ENV];
});

describe("registerDagsterTools", () => {
  it("registers exactly the tools it declares", () => {
    expect(tools.names()).toEqual([...DAGSTER_TOOL_NAMES].sort());
  });

  it("POSTs one GraphQL query to <base>/graphql with the Dagster Cloud token", async () => {
    catalog(repo());
    await tools.call("dagster_list", {});
    expect(stub?.only.url).toBe("https://dagster.example.test/graphql");
    expect(stub?.only.method).toBe("POST");
    expect(stub?.only.headers["dagster-cloud-api-token"]).toBe("dg-token");
    expect(stub?.only.body).toContain("repositoriesOrError");
  });

  it("strips a trailing slash from the configured base URL", async () => {
    catalog();
    process.env[URL_ENV] = "https://dagster.example.test///";
    await tools.call("dagster_list", {});
    expect(stub?.only.url).toBe("https://dagster.example.test/graphql");
  });

  it("refuses before sending when the URL or token is missing", async () => {
    catalog();
    delete process.env[URL_ENV];
    await expect(tools.call("dagster_list", {})).rejects.toThrow(`${URL_ENV} is not set`);

    process.env[URL_ENV] = "https://dagster.example.test";
    delete process.env[TOKEN_ENV];
    await expect(tools.call("dagster_list", {})).rejects.toThrow(`${TOKEN_ENV} is not set`);
    expect(stub?.calls).toHaveLength(0);
  });
});

describe("GraphQL error handling", () => {
  it("surfaces the HTTP status and body", async () => {
    stub = stubFetch({ status: 502, body: "bad gateway" });
    await expect(tools.call("dagster_list", {})).rejects.toThrow("Dagster 502: bad gateway");
  });

  it("surfaces GraphQL errors returned with a 200", async () => {
    // GraphQL reports failures in the BODY with a 200, so a status check alone
    // would report success on a query that returned nothing.
    stub = stubFetch({ body: JSON.stringify({ errors: [{ message: "field not found" }] }) });
    await expect(tools.call("dagster_list", {})).rejects.toThrow(
      'Dagster GraphQL error: [{"message":"field not found"}]',
    );
  });

  it("refuses a 200 with no data field rather than treating it as empty", async () => {
    stub = stubFetch({ body: "{}" });
    await expect(tools.call("dagster_list", {})).rejects.toThrow("response missing `data` field");
  });

  it("surfaces a PythonError from repositoriesOrError", async () => {
    stub = stubFetch({
      body: JSON.stringify({
        data: { repositoriesOrError: { __typename: "PythonError", message: "boom in user code" } },
      }),
    });
    await expect(tools.call("dagster_list", {})).rejects.toThrow(
      "Dagster repositoriesOrError PythonError: boom in user code",
    );
  });

  it("names a PythonError without a message as unknown", async () => {
    stub = stubFetch({
      body: JSON.stringify({ data: { repositoriesOrError: { __typename: "PythonError" } } }),
    });
    await expect(tools.call("dagster_list", {})).rejects.toThrow("PythonError: unknown error");
  });
});

describe("flattening the catalog", () => {
  it("flattens repository → pipelines into jobs carrying their repo and location", async () => {
    catalog(repo());
    const out = (await tools.callJson("dagster_list", {})) as {
      items: { name: string; repository: string; location: string; tags: unknown[] }[];
    };
    expect(out.items).toEqual([
      {
        name: "daily_ingest",
        repository: "prod_repo",
        location: "us-east",
        id: "job-1",
        description: "Loads yesterday's events.",
        isJob: true,
        tags: [{ key: "team", value: "data" }],
      },
    ]);
  });

  it("returns nothing when the catalog has no nodes array", async () => {
    stub = stubFetch({ body: JSON.stringify({ data: { repositoriesOrError: {} } }) });
    expect((await tools.callJson("dagster_list", {})) as { items: unknown[] }).toEqual({
      items: [],
    });
  });

  it("skips a repository node that is not an object", async () => {
    catalog(null, "not-a-repo", repo());
    const out = (await tools.callJson("dagster_list", {})) as { items: unknown[] };
    expect(out.items).toHaveLength(1);
  });

  it("skips a pipeline that is not an object or has no name", async () => {
    catalog(repo({ pipelines: [null, { id: "x" }, { name: "" }, { name: "ok" }] }));
    const out = (await tools.callJson("dagster_list", {})) as { items: { name: string }[] };
    expect(out.items.map((j) => j.name)).toEqual(["ok"]);
  });

  it("treats a non-array pipelines field as empty", async () => {
    catalog(repo({ pipelines: "not-an-array" }));
    expect((await tools.callJson("dagster_list", {})) as { items: unknown[] }).toEqual({
      items: [],
    });
  });

  it("reports a null location when the repository has none", async () => {
    catalog(repo({ location: undefined }));
    const out = (await tools.callJson("dagster_list", {})) as { items: { location: null }[] };
    expect(out.items[0]?.location).toBeNull();
  });

  it("nulls optional string fields that are absent or empty", async () => {
    catalog(repo({ pipelines: [{ name: "bare", id: "", description: "" }] }));
    const out = (await tools.callJson("dagster_list", {})) as {
      items: { id: null; description: null; isJob: boolean }[];
    };
    expect(out.items[0]).toMatchObject({ id: null, description: null, isJob: false });
  });

  describe("tags", () => {
    it("keeps only well-formed pairs, defaulting a missing value to empty", async () => {
      catalog(
        repo({
          pipelines: [
            {
              name: "j",
              tags: [
                null,
                "x",
                { value: "no-key" },
                { key: "" },
                { key: "k" },
                { key: "a", value: "b" },
              ],
            },
          ],
        }),
      );
      const out = (await tools.callJson("dagster_list", {})) as {
        items: { tags: { key: string; value: string }[] }[];
      };
      expect(out.items[0]?.tags).toEqual([
        { key: "k", value: "" },
        { key: "a", value: "b" },
      ]);
    });

    it("treats a non-array tags field as no tags", async () => {
      catalog(repo({ pipelines: [{ name: "j", tags: "nope" }] }));
      const out = (await tools.callJson("dagster_list", {})) as { items: { tags: unknown[] }[] };
      expect(out.items[0]?.tags).toEqual([]);
    });
  });
});

describe("dagster_list", () => {
  it("honours the limit", async () => {
    catalog(repo({ pipelines: [{ name: "a" }, { name: "b" }, { name: "c" }] }));
    const out = (await tools.callJson("dagster_list", { limit: 2 })) as { items: unknown[] };
    expect(out.items).toHaveLength(2);
  });
});

describe("dagster_get", () => {
  it("matches the full location:repository:name triple", async () => {
    catalog(repo());
    const job = (await tools.callJson("dagster_get", {
      id: "us-east:prod_repo:daily_ingest",
    })) as { name: string };
    expect(job.name).toBe("daily_ingest");
  });

  it("matches a bare job name too", async () => {
    catalog(repo());
    const job = (await tools.callJson("dagster_get", { id: "daily_ingest" })) as { name: string };
    expect(job.name).toBe("daily_ingest");
  });

  it("uses `_` for the location in the triple when there is none", async () => {
    catalog(repo({ location: undefined }));
    const job = (await tools.callJson("dagster_get", { id: "_:prod_repo:daily_ingest" })) as {
      name: string;
    };
    expect(job.name).toBe("daily_ingest");
  });

  it("throws, naming the id, when nothing matches", async () => {
    catalog(repo());
    await expect(tools.call("dagster_get", { id: "absent" })).rejects.toThrow(
      "Dagster: job absent not found",
    );
  });
});

describe("dagster_search", () => {
  it("matches on the job name", async () => {
    catalog(repo());
    const out = (await tools.callJson("dagster_search", { query: "INGEST" })) as {
      matches: { name: string }[];
    };
    expect(out.matches.map((m) => m.name)).toEqual(["daily_ingest"]);
  });

  it("returns an empty match set when nothing matches", async () => {
    catalog(repo());
    expect((await tools.callJson("dagster_search", { query: "zzz" })) as unknown).toEqual({
      matches: [],
    });
  });
});
