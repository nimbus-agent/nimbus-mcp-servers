import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { registerSonarqubeTools, SONARQUBE_TOOL_NAMES } from "../src/tools.ts";

const ISSUES = {
  issues: [
    {
      key: "AX1",
      rule: "typescript:S1234",
      message: "Remove this unused import",
      component: "acme:src/app.ts",
      tags: ["unused"],
    },
    {
      key: "AX2",
      rule: "typescript:S5332",
      message: "Using http protocol is insecure",
      component: "acme:src/net.ts",
      tags: ["cwe", "owasp-a3"],
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

/** Run `fn` against SonarCloud (the default base) with a token and no organization. */
function cloud(fn: () => Promise<void>, extra: Record<string, string | undefined> = {}) {
  return withEnv(
    {
      SONARQUBE_TOKEN: "squ_test",
      SONARQUBE_URL: undefined,
      SONARQUBE_ORGANIZATION: undefined,
      ...extra,
    },
    fn,
  );
}

function request(stub: FetchStub): { path: string; params: Record<string, string> } {
  const url = new URL(stub.only.url);
  return { path: `${url.origin}${url.pathname}`, params: Object.fromEntries(url.searchParams) };
}

beforeEach(() => {
  tools = captureTools(registerSonarqubeTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

describe("sonarqube tools", () => {
  it("registers exactly SONARQUBE_TOOL_NAMES, in order", () => {
    expect(tools.registrationOrder()).toEqual([...SONARQUBE_TOOL_NAMES]);
  });

  it("list with no project lists projects on SonarCloud with the bearer token", async () => {
    const stub = serve('{"components":[]}');
    await cloud(async () => {
      expect(await tools.callJson("sonarqube_list", {})).toEqual({ components: [] });
    });
    expect(request(stub)).toEqual({
      path: "https://sonarcloud.io/api/components/search",
      params: { qualifiers: "TRK", ps: "100" },
    });
    expect(stub.only.headers["authorization"]).toBe("Bearer squ_test");
  });

  it("list with no project scopes the project list to SONARQUBE_ORGANIZATION when set", async () => {
    const stub = serve('{"components":[]}');
    await cloud(
      async () => {
        await tools.call("sonarqube_list", {});
      },
      { SONARQUBE_ORGANIZATION: "  acme-org " },
    );
    expect(request(stub).params).toEqual({
      qualifiers: "TRK",
      ps: "100",
      organization: "acme-org",
    });
  });

  it("list with a project returns its open issues of every type by default", async () => {
    const stub = serve(JSON.stringify(ISSUES));
    await cloud(async () => {
      expect(await tools.callJson("sonarqube_list", { projectKey: "acme" })).toEqual(ISSUES);
    });
    expect(request(stub)).toEqual({
      path: "https://sonarcloud.io/api/issues/search",
      params: {
        componentKeys: "acme",
        types: "BUG,VULNERABILITY,CODE_SMELL",
        statuses: "OPEN,CONFIRMED,REOPENED",
        ps: "100",
      },
    });
  });

  it("list with a project narrows by type and severity and pages by limit", async () => {
    const stub = serve(JSON.stringify(ISSUES));
    await cloud(async () => {
      await tools.call("sonarqube_list", {
        projectKey: "acme",
        types: ["VULNERABILITY"],
        severities: ["BLOCKER", "CRITICAL"],
        limit: 10,
      });
    });
    expect(request(stub).params).toEqual({
      componentKeys: "acme",
      types: "VULNERABILITY",
      statuses: "OPEN,CONFIRMED,REOPENED",
      ps: "10",
      severities: "BLOCKER,CRITICAL",
    });
  });

  it("talks to a self-hosted server when SONARQUBE_URL is set", async () => {
    const stub = serve('{"components":[]}');
    await cloud(
      async () => {
        await tools.call("sonarqube_list", {});
      },
      { SONARQUBE_URL: "https://sonar.internal.example/" },
    );
    expect(request(stub).path).toBe("https://sonar.internal.example/api/components/search");
  });

  it("get returns the one issue with that key", async () => {
    const stub = serve(JSON.stringify({ issues: [ISSUES.issues[1]] }));
    await cloud(async () => {
      expect(await tools.callJson("sonarqube_get", { issueKey: "AX2" })).toEqual(ISSUES.issues[1]);
    });
    expect(request(stub).params).toEqual({ issues: "AX2", ps: "1" });
  });

  it("get throws when no issue has that key", async () => {
    for (const reply of ['{"issues":[]}', "{}", "null"]) {
      serve(reply);
      await cloud(async () => {
        await expect(tools.call("sonarqube_get", { issueKey: "NOPE" })).rejects.toThrow(
          "SonarQube: issue NOPE not found",
        );
      });
    }
  });

  it("search matches a project's open issues by message, rule, component and tag", async () => {
    const stub = serve(JSON.stringify(ISSUES));
    const keys = async (query: string): Promise<unknown[]> => {
      let out: unknown;
      await cloud(async () => {
        out = await tools.callJson("sonarqube_search", { projectKey: "acme", query });
      });
      return (out as { matches: { key: string }[] }).matches.map((m) => m.key);
    };
    expect(await keys("UNUSED IMPORT")).toEqual(["AX1"]);
    expect(await keys("s5332")).toEqual(["AX2"]);
    expect(await keys("src/app.ts")).toEqual(["AX1"]);
    expect(await keys("owasp")).toEqual(["AX2"]);
    expect(await keys("deprecated")).toEqual([]);
    expect(Object.fromEntries(new URL(stub.calls[0]?.url ?? "").searchParams)).toEqual({
      componentKeys: "acme",
      types: "BUG,VULNERABILITY,CODE_SMELL",
      statuses: "OPEN,CONFIRMED,REOPENED",
      ps: "500",
    });
  });

  it("surfaces a non-2xx answer with its status and body", async () => {
    serve({ status: 401, body: "Unauthorized" });
    await cloud(async () => {
      await expect(tools.call("sonarqube_list", {})).rejects.toThrow("SonarQube 401: Unauthorized");
    });
  });
});
