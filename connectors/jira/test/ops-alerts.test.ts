import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CapturedTools,
  captureStandaloneTools,
  captureTools,
  type FetchStub,
  type RecordedRequest,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { encodeBasicAuthHeader } from "../../../shared/mcp-tool-kit.ts";
import { registerJiraTools, resetJiraCloudIdCacheForTests } from "../src/tools.ts";

const SITE = "https://acme.atlassian.net";
const CLOUD_ID = "0a1b2c3d-4e5f-6789-abcd-ef0123456789";
const OPS = `https://api.atlassian.com/jsm/ops/api/${CLOUD_ID}/v1`;
const BASIC = encodeBasicAuthHeader("dev@acme.io", "jira-token");

const SITE_ENV = {
  JIRA_BASE_URL: SITE,
  JIRA_EMAIL: "dev@acme.io",
  JIRA_API_TOKEN: "jira-token",
};

let http: FetchStub | undefined;

function serve(reply: StubReply | ((req: RecordedRequest) => StubReply | undefined)): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

/** On the configured site with the cloud id given up front. */
const withCloudId = (fn: () => Promise<void>): Promise<void> =>
  withEnv({ ...SITE_ENV, JIRA_CLOUD_ID: CLOUD_ID }, fn);

/** On the configured site, with the cloud id left to discovery. */
const discovering = (fn: () => Promise<void>): Promise<void> =>
  withEnv({ ...SITE_ENV, JIRA_CLOUD_ID: undefined }, fn);

const ACCEPTED = '{"result":"Request will be processed","requestId":"req-9","took":0.1}';

beforeEach(() => {
  resetConnectorModeForTests();
  resetJiraCloudIdCacheForTests();
});

afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
});

describe("jira JSM Operations alerts (gateway mode)", () => {
  let tools: CapturedTools;

  beforeEach(() => {
    setConnectorMode("gateway");
    tools = captureTools(registerJiraTools);
  });

  it("acknowledge POSTs to the ops gateway with no body and the Basic header", async () => {
    const stub = serve({ status: 202, body: ACCEPTED });
    await withCloudId(async () => {
      expect(await tools.callJson("jira_ops_alert_acknowledge", { alertId: "A1" })).toEqual({
        status: "accepted",
        requestId: "req-9",
        took: 0.1,
      });
    });
    const req = stub.only;
    expect(`${req.method} ${req.url}`).toBe(`POST ${OPS}/alerts/A1/acknowledge`);
    expect(req.body).toBeUndefined();
    expect(req.headers["authorization"]).toBe(BASIC);
    expect(req.redirect).toBe("manual");
  });

  it("never says the alert is acknowledged, only that the request was accepted", async () => {
    serve({ status: 202, body: ACCEPTED });
    await withCloudId(async () => {
      const result = await tools.call("jira_ops_alert_acknowledge", { alertId: "A1" });
      expect(JSON.stringify(result)).not.toContain("acknowledged");
    });
  });

  it("close POSTs to /close with no body", async () => {
    const stub = serve({ status: 202, body: ACCEPTED });
    await withCloudId(async () => {
      await tools.call("jira_ops_alert_close", { alertId: "A1" });
    });
    expect(`${stub.only.method} ${stub.only.url}`).toBe(`POST ${OPS}/alerts/A1/close`);
    expect(stub.only.body).toBeUndefined();
  });

  it("discovers the cloud id once, with the Basic header, and caches it", async () => {
    const stub = serve((req) =>
      req.url.endsWith("/_edge/tenant_info")
        ? JSON.stringify({ cloudId: CLOUD_ID })
        : { status: 202, body: ACCEPTED },
    );
    await discovering(async () => {
      await tools.call("jira_ops_alert_close", { alertId: "A1" });
      await tools.call("jira_ops_alert_close", { alertId: "A2" });
    });
    expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${SITE}/_edge/tenant_info`,
      `POST ${OPS}/alerts/A1/close`,
      `POST ${OPS}/alerts/A2/close`,
    ]);
    expect(stub.calls[0]?.headers["authorization"]).toBe(BASIC);
    expect(stub.calls[0]?.redirect).toBe("manual");
  });

  it("fails closed on a malformed cloud id, with no further request", async () => {
    const stub = serve(JSON.stringify({ cloudId: "../../evil" }));
    await discovering(async () => {
      await expect(tools.call("jira_ops_alert_get", { alertId: "A1" })).rejects.toThrow(
        /JIRA_CLOUD_ID/,
      );
    });
    expect(stub.calls).toHaveLength(1);
  });

  it("fails closed on a malformed JIRA_CLOUD_ID, sending nothing", async () => {
    const stub = serve("{}");
    await withEnv({ ...SITE_ENV, JIRA_CLOUD_ID: "not-a-uuid" }, async () => {
      await expect(tools.call("jira_ops_alert_get", { alertId: "A1" })).rejects.toThrow(
        /JIRA_CLOUD_ID/,
      );
    });
    expect(stub.calls).toEqual([]);
  });

  it("fails closed when tenant_info is unavailable", async () => {
    const stub = serve({ status: 404, body: "no" });
    await discovering(async () => {
      await expect(tools.call("jira_ops_alert_get", { alertId: "A1" })).rejects.toThrow(
        /JIRA_CLOUD_ID/,
      );
    });
    expect(stub.calls).toHaveLength(1);
  });

  it("refuses a redirect from tenant_info", async () => {
    const stub = serve({ status: 302, headers: { Location: "https://evil.test/t" } });
    await discovering(async () => {
      await expect(tools.call("jira_ops_alert_get", { alertId: "A1" })).rejects.toThrow(/redirect/);
    });
    expect(stub.calls).toHaveLength(1);
  });

  it("refuses a redirect from the ops host and sends nothing to the target", async () => {
    const stub = serve({ status: 307, headers: { Location: "https://evil.test/steal" } });
    await withCloudId(async () => {
      await expect(tools.call("jira_ops_alert_acknowledge", { alertId: "A1" })).rejects.toThrow(
        /redirect/,
      );
    });
    expect(stub.calls).toHaveLength(1);
    expect(stub.only.url.startsWith("https://api.atlassian.com/")).toBe(true);
  });

  it("quotes 401, 403 and 404 answers", async () => {
    await withCloudId(async () => {
      for (const status of [401, 403, 404]) {
        serve({ status, body: `denied-${String(status)}` });
        await expect(tools.call("jira_ops_alert_get", { alertId: "A1" })).rejects.toThrow(
          `Jira Operations ${String(status)}: denied-${String(status)}`,
        );
      }
    });
  });

  it("get and request_status build their paths from the validated ids", async () => {
    const stub = serve("{}");
    await withCloudId(async () => {
      await tools.call("jira_ops_alert_get", { alertId: "abc-1_x" });
      await tools.call("jira_ops_alert_request_status", { requestId: "req-9" });
    });
    expect(stub.calls.map((c) => c.url)).toEqual([
      `${OPS}/alerts/abc-1_x`,
      `${OPS}/alerts/requests/req-9`,
    ]);
  });

  it("list sends size, offset and the optional filters in a fixed order", async () => {
    const stub = serve('{"values":[]}');
    await withCloudId(async () => {
      await tools.call("jira_ops_alert_list", {});
      await tools.call("jira_ops_alert_list", {
        query: "status: open",
        size: 10,
        offset: 20,
        sort: "createdAt",
        order: "desc",
      });
    });
    expect(stub.calls.map((c) => c.url)).toEqual([
      `${OPS}/alerts?size=25&offset=0`,
      `${OPS}/alerts?size=10&offset=20&query=status%3A+open&sort=createdAt&order=desc`,
    ]);
  });

  it("list refuses offset plus size of 20000 or more, and a size over 100", async () => {
    const stub = serve("{}");
    await withCloudId(async () => {
      await expect(
        tools.call("jira_ops_alert_list", { size: 100, offset: 19_900 }),
      ).rejects.toThrow(/20000/);
      await expect(tools.call("jira_ops_alert_list", { size: 101 })).rejects.toThrow();
    });
    expect(stub.calls).toEqual([]);
  });

  it("refuses ids that could reach another path, before any request", async () => {
    const stub = serve("{}");
    await withCloudId(async () => {
      for (const bad of ["../x", "a/b", "a b", "", "a?b", "x".repeat(129)]) {
        await expect(tools.call("jira_ops_alert_get", { alertId: bad })).rejects.toThrow();
        await expect(tools.call("jira_ops_alert_acknowledge", { alertId: bad })).rejects.toThrow();
        await expect(tools.call("jira_ops_alert_close", { alertId: bad })).rejects.toThrow();
        await expect(
          tools.call("jira_ops_alert_request_status", { requestId: bad }),
        ).rejects.toThrow();
      }
    });
    expect(stub.calls).toEqual([]);
  });

  it("each of the five tools refuses without credentials before any request", async () => {
    const stub = serve("{}");
    const calls: [string, Record<string, unknown>][] = [
      ["jira_ops_alert_get", { alertId: "A1" }],
      ["jira_ops_alert_list", {}],
      ["jira_ops_alert_request_status", { requestId: "r1" }],
      ["jira_ops_alert_acknowledge", { alertId: "A1" }],
      ["jira_ops_alert_close", { alertId: "A1" }],
    ];
    await withEnv(
      {
        JIRA_BASE_URL: SITE,
        JIRA_EMAIL: "dev@acme.io",
        JIRA_API_TOKEN: undefined,
        JIRA_CLOUD_ID: CLOUD_ID,
      },
      async () => {
        for (const [name, args] of calls) {
          await expect(tools.call(name, args)).rejects.toThrow("JIRA_API_TOKEN is not set");
        }
      },
    );
    expect(stub.calls).toEqual([]);
  });
});

describe("jira JSM Operations alerts (standalone mode)", () => {
  let auditDir: string;
  let auditLog: string;

  beforeEach(() => {
    setConnectorMode("standalone");
    auditDir = mkdtempSync(join(tmpdir(), "nimbus-jira-audit-"));
    auditLog = join(auditDir, "audit.jsonl");
  });

  afterEach(() => {
    rmSync(auditDir, { recursive: true, force: true });
  });

  async function standalone(scope: string): Promise<CapturedTools> {
    let tools: CapturedTools | undefined;
    await withEnv(
      {
        NIMBUS_MCP_JIRA_WRITE_SCOPE: scope,
        NIMBUS_MCP_AUDIT_LOG: auditLog,
        NIMBUS_MCP_WRITE_BUDGET: undefined,
      },
      () => {
        tools = captureStandaloneTools(registerJiraTools, { elicitation: true }).tools;
      },
    );
    if (tools === undefined) throw new Error("registration did not run");
    return tools;
  }

  function executedPreState(): unknown {
    return readFileSync(auditLog, "utf8")
      .trim()
      .split("\n")
      .map(
        (l) =>
          (JSON.parse(l) as { entry: { outcome: string; detail: Record<string, unknown> } }).entry,
      )
      .find((e) => e.outcome === "executed")?.detail["preState"];
  }

  const ALERT = {
    id: "A1",
    status: "open",
    acknowledged: false,
    message: "disk full",
    priority: "P2",
    responders: [{ id: "x" }],
  };

  for (const [tool, action] of [
    ["jira_ops_alert_acknowledge", "acknowledge"],
    ["jira_ops_alert_close", "close"],
  ] as const) {
    it(`${tool} captures the alert BEFORE the POST`, async () => {
      const tools = await standalone("alert:A1");
      const stub = serve((req) =>
        req.method === "GET" ? JSON.stringify(ALERT) : { status: 202, body: ACCEPTED },
      );
      await withCloudId(async () => {
        await tools.call(tool, { alertId: "A1" });
      });
      expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        `GET ${OPS}/alerts/A1`,
        `POST ${OPS}/alerts/A1/${action}`,
      ]);
      expect(executedPreState()).toEqual({
        status: "open",
        acknowledged: false,
        message: "disk full",
        priority: "P2",
      });
    });
  }

  it("authorises alerts by exact id only: another id is out of scope, with no request", async () => {
    const tools = await standalone("alert:A1");
    const stub = serve("{}");
    await withCloudId(async () => {
      expect(await tools.callJson("jira_ops_alert_close", { alertId: "A2" })).toEqual({
        ok: false,
        error: "out of scope: alert:A2 is not in NIMBUS_MCP_JIRA_WRITE_SCOPE",
      });
    });
    expect(stub.calls).toEqual([]);
  });
});
