import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { registerSemgrepTools, SEMGREP_TOOL_NAMES } from "../src/tools.ts";

const API = "https://semgrep.dev/api/v1";

const FINDINGS = {
  findings: [
    {
      id: 101,
      rule_name: "python.lang.security.audit.eval-detected",
      rule_message: "Detected the use of eval()",
      location: { file_path: "app/handlers.py" },
      repository: { name: "acme/api" },
    },
    {
      id: 102,
      rule_name: "javascript.express.security.open-redirect",
      rule_message: "Untrusted redirect target",
      location: { file_path: "web/routes.js" },
      repository: { name: "acme/web" },
    },
  ],
};

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

/** Run `fn` with the token and deployment slug configured; the slug needs encoding. */
function configured(fn: () => Promise<void>): Promise<void> {
  return withEnv({ SEMGREP_TOKEN: "sgp_test", SEMGREP_DEPLOYMENT_SLUG: "acme corp" }, fn);
}

beforeEach(() => {
  tools = captureTools(registerSemgrepTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

/** The query parameters of the one request a tool made. */
function params(stub: FetchStub): Record<string, string> {
  return Object.fromEntries(new URL(stub.only.url).searchParams);
}

describe("semgrep tools", () => {
  it("registers exactly SEMGREP_TOOL_NAMES", () => {
    expect(tools.names()).toEqual([...SEMGREP_TOOL_NAMES]);
  });

  it("list without filters returns the deployments, with no slug needed", async () => {
    const stub = serve('{"deployments":[{"slug":"acme"}]}');
    await withEnv({ SEMGREP_TOKEN: "sgp_test", SEMGREP_DEPLOYMENT_SLUG: undefined }, async () => {
      expect(await tools.callJson("semgrep_list", {})).toEqual({ deployments: [{ slug: "acme" }] });
    });
    expect(stub.only.url).toBe(`${API}/deployments`);
    expect(stub.only.headers["authorization"]).toBe("Bearer sgp_test");
  });

  it("list with filters queries the deployment's findings", async () => {
    const stub = serve(JSON.stringify(FINDINGS));
    await configured(async () => {
      expect(
        await tools.callJson("semgrep_list", {
          severity: ["critical", "high"],
          status: ["open"],
          repository: "acme/api",
          limit: 25,
        }),
      ).toEqual(FINDINGS);
    });
    const url = new URL(stub.only.url);
    expect(url.pathname).toBe("/api/v1/deployments/acme%20corp/findings");
    expect(params(stub)).toEqual({
      page_size: "25",
      severities: "critical,high",
      statuses: "open",
      repos: "acme/api",
    });
  });

  it("list with only one filter sends only that filter, and 100 per page", async () => {
    const stub = serve("{}");
    await configured(async () => {
      await tools.call("semgrep_list", { repository: "acme/web" });
    });
    expect(params(stub)).toEqual({ page_size: "100", repos: "acme/web" });

    const bySeverity = serve("{}");
    await configured(async () => {
      await tools.call("semgrep_list", { severity: ["low"] });
    });
    expect(params(bySeverity)).toEqual({ page_size: "100", severities: "low" });
  });

  it("list with filters refuses without SEMGREP_DEPLOYMENT_SLUG, before any request", async () => {
    const stub = serve("{}");
    await withEnv({ SEMGREP_TOKEN: "t", SEMGREP_DEPLOYMENT_SLUG: undefined }, async () => {
      await expect(tools.call("semgrep_list", { status: ["fixed"] })).rejects.toThrow(
        "SEMGREP_DEPLOYMENT_SLUG is not set",
      );
    });
    expect(stub.calls).toEqual([]);
  });

  it("get asks for one finding by id and returns it", async () => {
    const stub = serve(JSON.stringify({ findings: [FINDINGS.findings[1]] }));
    await configured(async () => {
      expect(await tools.callJson("semgrep_get", { findingId: "102" })).toEqual(
        FINDINGS.findings[1],
      );
    });
    expect(params(stub)).toEqual({ ids: "102", page_size: "1" });
  });

  it("get throws when the deployment holds no such finding", async () => {
    for (const reply of ['{"findings":[]}', "{}", "null"]) {
      serve(reply);
      await configured(async () => {
        await expect(tools.call("semgrep_get", { findingId: "999" })).rejects.toThrow(
          "Semgrep: finding 999 not found",
        );
      });
    }
  });

  it("search matches open findings by rule, message, path and repository", async () => {
    const stub = serve(JSON.stringify(FINDINGS));
    const keys = async (query: string): Promise<unknown[]> => {
      let out: unknown;
      await configured(async () => {
        out = await tools.callJson("semgrep_search", { query });
      });
      return (out as { matches: { id: number }[] }).matches.map((m) => m.id);
    };
    expect(await keys("EVAL-DETECTED")).toEqual([101]);
    expect(await keys("untrusted redirect")).toEqual([102]);
    expect(await keys("routes.js")).toEqual([102]);
    expect(await keys("acme/")).toEqual([101, 102]);
    expect(await keys("sql-injection")).toEqual([]);
    expect(Object.fromEntries(new URL(stub.calls[0]?.url ?? "").searchParams)).toEqual({
      statuses: "open",
      page_size: "500",
    });
  });

  it("search returns no matches when the answer carries no findings array", async () => {
    serve('{"findings":"not-an-array"}');
    await configured(async () => {
      expect(await tools.callJson("semgrep_search", { query: "x" })).toEqual({ matches: [] });
    });
  });

  it("surfaces a non-2xx answer with its status and body", async () => {
    serve({ status: 403, body: "Forbidden" });
    await configured(async () => {
      await expect(tools.call("semgrep_search", { query: "x" })).rejects.toThrow(
        "Semgrep 403: Forbidden",
      );
    });
  });
});
