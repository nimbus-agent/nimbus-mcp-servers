import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  stubFetch,
} from "../../../scripts/connector-tool-harness.ts";
import { registerSnykTools, SNYK_TOOL_NAMES } from "../src/tools.ts";

const TOKEN = "SNYK_TOKEN";

let tools: CapturedTools;
let stub: FetchStub | undefined;

function reply(body: unknown, status = 200): void {
  stub = stubFetch({ body: typeof body === "string" ? body : JSON.stringify(body), status });
}

/** One aggregated issue as Snyk returns it. */
function issue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "SNYK-JS-LODASH-1",
    pkgName: "lodash",
    issueData: { title: "Prototype Pollution", cve: ["CVE-2020-8203"] },
    ...over,
  };
}

const ORG = { orgId: "org-1", projectId: "proj-1" };

beforeEach(() => {
  process.env[TOKEN] = "snyk-token";
  tools = captureTools(registerSnykTools);
});

afterEach(() => {
  stub?.restore();
  stub = undefined;
  delete process.env[TOKEN];
});

describe("registerSnykTools", () => {
  it("registers exactly the tools it declares", () => {
    expect(tools.names()).toEqual([...SNYK_TOOL_NAMES].sort());
  });

  it("authenticates with the lowercase `token` scheme Snyk requires", async () => {
    reply({ issues: [] });
    await tools.call("snyk_list", { orgId: "org-1" });
    expect(stub?.only.headers["authorization"]).toBe("token snyk-token");
  });

  it("refuses before sending when the token is missing", async () => {
    reply({});
    delete process.env[TOKEN];
    for (const name of SNYK_TOOL_NAMES) {
      await expect(tools.call(name, { ...ORG, issueId: "i", query: "q" })).rejects.toThrow(
        `${TOKEN} is not set`,
      );
    }
    expect(stub?.calls).toHaveLength(0);
  });
});

describe("snyk_list", () => {
  it("GETs the org's projects when no projectId is given", async () => {
    reply({ projects: [] });
    await tools.call("snyk_list", { orgId: "org 1" });
    expect(stub?.only.method).toBe("GET");
    expect(stub?.only.url).toBe("https://api.snyk.io/v1/org/org%201/projects");
  });

  it("POSTs an aggregated-issues filter when a projectId is given", async () => {
    reply({ issues: [issue()] });
    await tools.call("snyk_list", ORG);
    expect(stub?.only.method).toBe("POST");
    expect(stub?.only.url).toContain("/project/proj-1/aggregated-issues");
    expect(JSON.parse(stub?.only.body ?? "{}")).toEqual({
      filters: {
        severities: ["critical", "high", "medium", "low"],
        types: ["vuln", "license"],
        ignored: false,
        patched: false,
      },
    });
  });

  it("narrows the severities when asked", async () => {
    reply({ issues: [] });
    await tools.call("snyk_list", { ...ORG, severities: ["critical"] });
    const body = JSON.parse(stub?.only.body ?? "{}") as { filters: { severities: string[] } };
    expect(body.filters.severities).toEqual(["critical"]);
  });

  it("truncates the issue list to the limit, keeping the rest of the envelope", async () => {
    reply({ total: 3, issues: [issue({ id: "a" }), issue({ id: "b" }), issue({ id: "c" })] });
    const out = (await tools.callJson("snyk_list", { ...ORG, limit: 2 })) as {
      total: number;
      issues: { id: string }[];
    };
    expect(out.total).toBe(3);
    expect(out.issues.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("leaves the envelope alone when it is already within the limit", async () => {
    reply({ issues: [issue({ id: "a" })] });
    const out = (await tools.callJson("snyk_list", { ...ORG, limit: 5 })) as {
      issues: unknown[];
    };
    expect(out.issues).toHaveLength(1);
  });

  it("surfaces the Snyk status and body on failure", async () => {
    reply("forbidden", 403);
    await expect(tools.call("snyk_list", { orgId: "org-1" })).rejects.toThrow(
      "Snyk 403: forbidden",
    );
  });

  it("treats an empty body as an empty object rather than a parse error", async () => {
    // Snyk answers some POSTs with 200 and no body at all.
    reply("   ");
    expect((await tools.callJson("snyk_list", ORG)) as unknown).toEqual({});
  });
});

describe("snyk_get", () => {
  it("returns the aggregated issue whose id matches", async () => {
    reply({ issues: [issue({ id: "other" }), issue({ id: "wanted" })] });
    const out = (await tools.callJson("snyk_get", { ...ORG, issueId: "wanted" })) as {
      id: string;
    };
    expect(out.id).toBe("wanted");
  });

  it("throws, naming the issue and project, when nothing matches", async () => {
    reply({ issues: [issue()] });
    await expect(tools.call("snyk_get", { ...ORG, issueId: "absent" })).rejects.toThrow(
      "Snyk: issue absent not found in project proj-1",
    );
  });

  it("skips entries that are not objects or whose id is not a string", async () => {
    reply({ issues: [null, "x", { id: 7 }, issue({ id: "wanted" })] });
    const out = (await tools.callJson("snyk_get", { ...ORG, issueId: "wanted" })) as {
      id: string;
    };
    expect(out.id).toBe("wanted");
  });

  it("refuses a response with no issues envelope", async () => {
    reply({ detail: "unexpected" });
    await expect(tools.call("snyk_get", { ...ORG, issueId: "x" })).rejects.toThrow(
      "returned no issues envelope",
    );
  });
});

describe("snyk_search", () => {
  it("matches the issue title, package name and CVE", async () => {
    reply({
      issues: [issue(), issue({ id: "2", pkgName: "axios", issueData: { title: "SSRF" } })],
    });
    for (const query of ["prototype", "LODASH", "CVE-2020-8203"]) {
      const out = (await tools.callJson("snyk_search", { ...ORG, query })) as {
        matches: { id: string }[];
      };
      expect({ query, ids: out.matches.map((m) => m.id) }).toEqual({
        query,
        ids: ["SNYK-JS-LODASH-1"],
      });
    }
  });

  it("returns an empty match set when the envelope has no issues", async () => {
    reply({ detail: "nothing" });
    expect((await tools.callJson("snyk_search", { ...ORG, query: "x" })) as unknown).toEqual({
      matches: [],
    });
  });
});
