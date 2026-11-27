import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CapturedTools,
  captureStandaloneTools,
  captureTools,
  type FetchStub,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { JIRA_TOOL_NAMES, registerJiraTools } from "../src/tools.ts";

const SITE = "https://acme.atlassian.net";
const BASIC = `Basic ${Buffer.from("dev@acme.io:jira-token").toString("base64")}`;

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

/** Run `fn` against a configured site. The base URL has no scheme and a trailing slash. */
function onSite(fn: () => Promise<void>): Promise<void> {
  return withEnv(
    {
      JIRA_BASE_URL: " acme.atlassian.net/ ",
      JIRA_EMAIL: "dev@acme.io",
      JIRA_API_TOKEN: "jira-token",
    },
    fn,
  );
}

/** Call `name` on the configured site and return the single request it made. */
async function request(name: string, args: Record<string, unknown>, reply: StubReply = "{}") {
  const stub = serve(reply);
  await onSite(async () => {
    await tools.call(name, args);
  });
  return stub.only;
}

function adf(text: string): unknown {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  tools = captureTools(registerJiraTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
});

describe("jira tools", () => {
  it("registers exactly JIRA_TOOL_NAMES, in order", () => {
    expect(tools.registrationOrder()).toEqual([...JIRA_TOOL_NAMES]);
  });

  it("issue_list POSTs a JQL search with defaults, Basic auth and a JSON body", async () => {
    const req = await request("jira_issue_list", {});
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${SITE}/rest/api/3/search`);
    expect(req.headers["authorization"]).toBe(BASIC);
    expect(req.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(req.body ?? "null")).toEqual({
      jql: "order by updated DESC",
      startAt: 0,
      maxResults: 50,
      fields: ["summary", "description", "updated", "status", "issuetype", "priority", "assignee"],
    });
  });

  it("issue_list passes the caller's JQL and paging", async () => {
    const req = await request("jira_issue_list", {
      jql: "project = OPS",
      startAt: 50,
      maxResults: 10,
    });
    expect(JSON.parse(req.body ?? "null")).toMatchObject({
      jql: "project = OPS",
      startAt: 50,
      maxResults: 10,
    });
  });

  it("issue_get GETs one issue with its comment field", async () => {
    const req = await request("jira_issue_get", { issueKey: "OPS-1" });
    expect(req.method).toBe("GET");
    expect(req.url).toBe(
      `${SITE}/rest/api/3/issue/OPS-1?fields=summary,description,updated,status,issuetype,priority,assignee,comment`,
    );
    // No body, so no Content-Type is claimed.
    expect(req.headers["content-type"]).toBeUndefined();
  });

  it("issue_create defaults the type to Task and sends no description when none is given", async () => {
    const req = await request(
      "jira_issue_create",
      { projectKey: "OPS", summary: "Rotate keys" },
      '{"key":"OPS-7"}',
    );
    expect(req.url).toBe(`${SITE}/rest/api/3/issue`);
    expect(JSON.parse(req.body ?? "null")).toEqual({
      fields: { project: { key: "OPS" }, summary: "Rotate keys", issuetype: { name: "Task" } },
    });
  });

  it("issue_create sends the description as ADF and the requested issue type", async () => {
    const req = await request("jira_issue_create", {
      projectKey: "OPS",
      summary: "Outage",
      description: "Pager fired at 02:00",
      issueTypeName: "Bug",
    });
    expect(JSON.parse(req.body ?? "null")).toEqual({
      fields: {
        project: { key: "OPS" },
        summary: "Outage",
        issuetype: { name: "Bug" },
        description: adf("Pager fired at 02:00"),
      },
    });
  });

  it("issue_create returns Jira's created issue", async () => {
    serve('{"id":"10007","key":"OPS-7"}');
    await onSite(async () => {
      expect(
        await tools.callJson("jira_issue_create", { projectKey: "OPS", summary: "s" }),
      ).toEqual({ id: "10007", key: "OPS-7" });
    });
  });

  it("issue_update PUTs only the fields given and reports the key", async () => {
    const summaryOnly = await request("jira_issue_update", { issueKey: "OPS-7", summary: "New" });
    expect(summaryOnly.method).toBe("PUT");
    expect(summaryOnly.url).toBe(`${SITE}/rest/api/3/issue/OPS-7`);
    expect(JSON.parse(summaryOnly.body ?? "null")).toEqual({ fields: { summary: "New" } });

    const descriptionOnly = await request("jira_issue_update", {
      issueKey: "OPS-7",
      description: "",
    });
    expect(JSON.parse(descriptionOnly.body ?? "null")).toEqual({
      fields: { description: adf("") },
    });

    serve({ status: 204, body: "" });
    await onSite(async () => {
      expect(
        await tools.callJson("jira_issue_update", {
          issueKey: "OPS-7",
          summary: "S",
          description: "D",
        }),
      ).toEqual({ ok: true, issueKey: "OPS-7" });
    });
    expect(JSON.parse(http?.only.body ?? "null")).toEqual({
      fields: { summary: "S", description: adf("D") },
    });
  });

  it("issue_update refuses an update with nothing to change, before any request", async () => {
    const stub = serve("{}");
    await onSite(async () => {
      await expect(tools.call("jira_issue_update", { issueKey: "OPS-7" })).rejects.toThrow(
        "Provide summary and/or description to update",
      );
    });
    expect(stub.calls).toEqual([]);
  });

  it("issue_update throws Jira's status and body when the update is refused", async () => {
    serve({ status: 400, body: '{"errors":{"summary":"too long"}}' });
    await onSite(async () => {
      await expect(
        tools.call("jira_issue_update", { issueKey: "OPS-7", summary: "x" }),
      ).rejects.toThrow('Jira 400: {"errors":{"summary":"too long"}}');
    });
  });

  it("comment_add POSTs the comment as ADF to the issue", async () => {
    const req = await request("jira_comment_add", { issueKey: "OPS-7", body: "Fixed in 1.2" });
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${SITE}/rest/api/3/issue/OPS-7/comment`);
    expect(JSON.parse(req.body ?? "null")).toEqual({ body: adf("Fixed in 1.2") });
  });

  it("board_list and sprint_list page through the agile API", async () => {
    expect((await request("jira_board_list", {})).url).toBe(
      `${SITE}/rest/agile/1.0/board?startAt=0&maxResults=50`,
    );
    expect((await request("jira_board_list", { startAt: 5, maxResults: 2 })).url).toBe(
      `${SITE}/rest/agile/1.0/board?startAt=5&maxResults=2`,
    );
    expect((await request("jira_sprint_list", { boardId: 12 })).url).toBe(
      `${SITE}/rest/agile/1.0/board/12/sprint?startAt=0&maxResults=50`,
    );
    expect(
      (await request("jira_sprint_list", { boardId: 12, startAt: 3, maxResults: 4 })).url,
    ).toBe(`${SITE}/rest/agile/1.0/board/12/sprint?startAt=3&maxResults=4`);
  });

  it("epic_list searches the project's epics", async () => {
    const req = await request("jira_epic_list", { projectKey: "OPS", maxResults: 5 });
    expect(req.url).toBe(`${SITE}/rest/api/3/search`);
    expect(JSON.parse(req.body ?? "null")).toEqual({
      jql: "project = OPS AND issuetype = Epic ORDER BY updated DESC",
      startAt: 0,
      maxResults: 5,
      fields: ["summary", "updated", "status"],
    });
  });

  it("surfaces a failed read with its status, and an unparseable success by name", async () => {
    serve({ status: 401, body: "Unauthorized" });
    await onSite(async () => {
      await expect(tools.call("jira_board_list", {})).rejects.toThrow("Jira 401: Unauthorized");
    });
    serve("<html>maintenance</html>");
    await onSite(async () => {
      await expect(tools.call("jira_sprint_list", { boardId: 1 })).rejects.toThrow(
        "Jira: invalid JSON from sprint list",
      );
    });
  });

  it("names the missing variable and sends nothing when the site is not configured", async () => {
    const stub = serve("{}");
    for (const [missing, env] of [
      ["JIRA_BASE_URL", { JIRA_BASE_URL: undefined, JIRA_EMAIL: "e", JIRA_API_TOKEN: "t" }],
      ["JIRA_EMAIL", { JIRA_BASE_URL: SITE, JIRA_EMAIL: " ", JIRA_API_TOKEN: "t" }],
      ["JIRA_API_TOKEN", { JIRA_BASE_URL: SITE, JIRA_EMAIL: "e", JIRA_API_TOKEN: undefined }],
    ] as const) {
      await withEnv(env, async () => {
        await expect(tools.call("jira_issue_get", { issueKey: "OPS-1" })).rejects.toThrow(
          `${missing} is not set`,
        );
      });
    }
    expect(stub.calls).toEqual([]);
  });

  it("keeps an explicit http:// base URL as given", async () => {
    const stub = serve("{}");
    await withEnv(
      { JIRA_BASE_URL: "http://jira.internal:8080//", JIRA_EMAIL: "e", JIRA_API_TOKEN: "t" },
      async () => {
        await tools.call("jira_board_list", {});
      },
    );
    expect(stub.only.url).toBe(
      "http://jira.internal:8080/rest/agile/1.0/board?startAt=0&maxResults=50",
    );
  });
});

describe("jira transitions", () => {
  const TRANSITIONS = '{"transitions":[{"id":"31","name":"Done","to":{"name":"Done"}}]}';

  it("transitions_list GETs the issue's transitions with their fields expanded", async () => {
    const req = await request("jira_issue_transitions_list", { issueKey: "OPS-1" }, TRANSITIONS);
    expect(`${req.method} ${req.url}`).toBe(
      `GET ${SITE}/rest/api/3/issue/OPS-1/transitions?expand=transitions.fields`,
    );
  });

  it("transition POSTs the transition id and reports it", async () => {
    const stub = serve({ status: 204, body: "" });
    await onSite(async () => {
      expect(
        await tools.callJson("jira_issue_transition", { issueKey: "OPS-7", transitionId: "31" }),
      ).toEqual({ ok: true, issueKey: "OPS-7", transitionId: "31" });
    });
    expect(`${stub.only.method} ${stub.only.url}`).toBe(
      `POST ${SITE}/rest/api/3/issue/OPS-7/transitions`,
    );
    expect(JSON.parse(stub.only.body ?? "null")).toEqual({ transition: { id: "31" } });
    expect(stub.only.headers["authorization"]).toBe(BASIC);
  });

  it("transition throws Jira's status and body when the workflow refuses it", async () => {
    serve({ status: 400, body: '{"errorMessages":["Transition is not valid"]}' });
    await onSite(async () => {
      await expect(
        tools.call("jira_issue_transition", { issueKey: "OPS-7", transitionId: "99" }),
      ).rejects.toThrow('Jira 400: {"errorMessages":["Transition is not valid"]}');
    });
  });

  it("transition refuses a transition id that is not a number, before any request", async () => {
    const stub = serve("{}");
    await onSite(async () => {
      for (const transitionId of ["", "abc", "3 1", "31/../x", "1".repeat(21)]) {
        await expect(
          tools.call("jira_issue_transition", { issueKey: "OPS-7", transitionId }),
        ).rejects.toThrow();
      }
    });
    expect(stub.calls).toEqual([]);
  });

  it("transition reads the credentials before the first request", async () => {
    const stub = serve("{}");
    await expect(
      tools.call("jira_issue_transition", { issueKey: "OPS-7", transitionId: "31" }),
    ).rejects.toThrow("JIRA_BASE_URL is not set");
    expect(stub.calls).toEqual([]);
  });
});

describe("jira transition (standalone mode)", () => {
  let dir: string;
  let auditLog: string;

  beforeEach(() => {
    resetConnectorModeForTests();
    setConnectorMode("standalone");
    dir = mkdtempSync(join(tmpdir(), "nimbus-jira-audit-"));
    auditLog = join(dir, "audit.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is not recoverable: the status is captured before the transition, and audited", async () => {
    let standalone: CapturedTools | undefined;
    await withEnv(
      { NIMBUS_MCP_JIRA_WRITE_SCOPE: "issue:OPS-7", NIMBUS_MCP_AUDIT_LOG: auditLog },
      () => {
        standalone = captureStandaloneTools(registerJiraTools, { elicitation: true }).tools;
      },
    );
    const stub = serve((req) =>
      req.method === "GET"
        ? '{"fields":{"status":{"name":"In Progress","id":"3"}}}'
        : { status: 204, body: "" },
    );
    await onSite(async () => {
      await standalone?.call("jira_issue_transition", { issueKey: "OPS-7", transitionId: "31" });
    });
    expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${SITE}/rest/api/3/issue/OPS-7?fields=status`,
      `POST ${SITE}/rest/api/3/issue/OPS-7/transitions`,
    ]);
    const entries = readFileSync(auditLog, "utf8")
      .trim()
      .split("\n")
      .map(
        (l) =>
          (JSON.parse(l) as { entry: { outcome: string; detail: Record<string, unknown> } }).entry,
      );
    expect(entries.find((e) => e.outcome === "executed")?.detail["preState"]).toEqual({
      status: "In Progress",
    });
  });
  it("records captureFailed, not an undefined status, when the status cannot be read", async () => {
    let standalone: CapturedTools | undefined;
    await withEnv(
      { NIMBUS_MCP_JIRA_WRITE_SCOPE: "issue:OPS-7", NIMBUS_MCP_AUDIT_LOG: auditLog },
      () => {
        standalone = captureStandaloneTools(registerJiraTools, { elicitation: true }).tools;
      },
    );
    serve((req) =>
      req.method === "GET"
        ? { status: 404, body: "Issue does not exist" }
        : { status: 204, body: "" },
    );
    await onSite(async () => {
      await standalone?.call("jira_issue_transition", { issueKey: "OPS-7", transitionId: "31" });
    });
    const executed = readFileSync(auditLog, "utf8")
      .trim()
      .split(String.fromCharCode(10))
      .map(
        (l) =>
          (JSON.parse(l) as { entry: { outcome: string; detail: Record<string, unknown> } }).entry,
      )
      .find((e) => e.outcome === "executed");
    expect(executed?.detail["preState"]).toEqual({
      captureFailed: expect.stringContaining("Jira 404"),
    });
  });
});

const ACCOUNT = "5b10a2844c20165700ede21g";
const BAD_KEY = "issueKey is an issue key like ENG-7 or a numeric issue id";
const BAD_ACCOUNT =
  "accountId is a Jira account id, or null to unassign; a name, an email or -1 is refused";

describe("jira issue assign", () => {
  it("PUTs the account id to the issue's assignee and reports it", async () => {
    const stub = serve({ status: 204, body: "" });
    await onSite(async () => {
      expect(
        await tools.callJson("jira_issue_assign", { issueKey: "ENG-7", accountId: ACCOUNT }),
      ).toEqual({ ok: true, issueKey: "ENG-7", accountId: ACCOUNT });
    });
    expect(`${stub.only.method} ${stub.only.url}`).toBe(
      `PUT ${SITE}/rest/api/3/issue/ENG-7/assignee`,
    );
    expect(JSON.parse(stub.only.body ?? "null")).toEqual({ accountId: ACCOUNT });
    expect(stub.only.headers["authorization"]).toBe(BASIC);
    expect(stub.only.headers["content-type"]).toBe("application/json");
  });

  it("unassigns with accountId null, sending null rather than leaving the field out", async () => {
    const stub = serve({ status: 204, body: "" });
    await onSite(async () => {
      expect(
        await tools.callJson("jira_issue_assign", { issueKey: "ENG-7", accountId: null }),
      ).toEqual({ ok: true, issueKey: "ENG-7", accountId: null });
    });
    expect(stub.only.body).toBe('{"accountId":null}');
  });

  it("requires accountId to be stated: leaving it out is refused, not read as unassign", async () => {
    const stub = serve("{}");
    await onSite(async () => {
      await expect(tools.call("jira_issue_assign", { issueKey: "ENG-7" })).rejects.toThrow(
        /"accountId"/,
      );
    });
    expect(stub.calls).toEqual([]);
  });

  it("refuses a hostile issue key or a non-id account before any request", async () => {
    const stub = serve("{}");
    await onSite(async () => {
      for (const issueKey of ["..", "../x", "ENG-7/../../x", "ENG 7", "", "ENG-", "-7"]) {
        await expect(
          tools.call("jira_issue_assign", { issueKey, accountId: ACCOUNT }),
        ).rejects.toThrow(BAD_KEY);
      }
      for (const accountId of ["-1", "ada@acme.io", "Ada Lovelace", "", "a/b"]) {
        await expect(
          tools.call("jira_issue_assign", { issueKey: "ENG-7", accountId }),
        ).rejects.toThrow(BAD_ACCOUNT);
      }
    });
    expect(stub.calls).toEqual([]);
  });

  it("accepts a numeric issue id and a prefixed account id", async () => {
    const stub = serve({ status: 204, body: "" });
    const prefixed = "557058:f58131cb-b67d-43c7-b30d-6b58d40bd077";
    await onSite(async () => {
      await tools.call("jira_issue_assign", { issueKey: "10042", accountId: prefixed });
    });
    expect(stub.only.url).toBe(`${SITE}/rest/api/3/issue/10042/assignee`);
    expect(JSON.parse(stub.only.body ?? "null")).toEqual({ accountId: prefixed });
  });

  it("throws Jira's status and body when the assignment is refused", async () => {
    serve({ status: 400, body: '{"errorMessages":["User cannot be assigned issues."]}' });
    await onSite(async () => {
      await expect(
        tools.call("jira_issue_assign", { issueKey: "ENG-7", accountId: ACCOUNT }),
      ).rejects.toThrow('Jira 400: {"errorMessages":["User cannot be assigned issues."]}');
    });
  });
});

describe("jira issue keys on every issue tool (path confusion)", () => {
  const ISSUE_TOOLS: readonly [string, Record<string, unknown>][] = [
    ["jira_issue_get", {}],
    ["jira_issue_update", { summary: "s" }],
    ["jira_comment_add", { body: "b" }],
    ["jira_issue_transitions_list", {}],
    ["jira_issue_transition", { transitionId: "31" }],
    ["jira_issue_assign", { accountId: ACCOUNT }],
  ];

  it("refuses a dot segment, a slash or any other non-key before any request, on each tool", async () => {
    const stub = serve("{}");
    await onSite(async () => {
      for (const [name, rest] of ISSUE_TOOLS) {
        for (const issueKey of ["..", "../x", "ENG-7/../../x", "OPS/7", "OPS 1", "%2e%2e", ""]) {
          await expect(tools.call(name, { ...rest, issueKey })).rejects.toThrow(BAD_KEY);
        }
      }
    });
    expect(stub.calls).toEqual([]);
  });

  it("still accepts a key and a numeric id on each tool", async () => {
    for (const [name, rest] of ISSUE_TOOLS) {
      for (const issueKey of ["ENG-7", "MY_PROJ2-42", "10042"]) {
        const stub = serve({ status: 200, body: '{"fields":{}}' });
        await onSite(async () => {
          await tools.call(name, { ...rest, issueKey });
        });
        expect(new URL(stub.calls[0]?.url ?? "").pathname).toContain(`/issue/${issueKey}`);
      }
    }
  });
});

describe("jira never sends its credential across a redirect", () => {
  const EVIL = "https://evil.example/steal";

  it("a 307 on the assign PUT is refused and nothing goes to the other origin", async () => {
    const stub = serve({ status: 307, headers: { Location: EVIL } });
    await onSite(async () => {
      await expect(
        tools.call("jira_issue_assign", { issueKey: "ENG-7", accountId: ACCOUNT }),
      ).rejects.toThrow(/Jira answered a PUT with a redirect \(307\)/);
    });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.redirect).toBe("manual");
    expect(stub.calls.some((c) => new URL(c.url).host === "evil.example")).toBe(false);
  });

  it("a 307 on an existing write (comment add) is refused the same way", async () => {
    const stub = serve({ status: 307, headers: { Location: EVIL } });
    await onSite(async () => {
      await expect(
        tools.call("jira_comment_add", { issueKey: "ENG-7", body: "hi" }),
      ).rejects.toThrow(/Jira answered a POST with a redirect \(307\)/);
    });
    expect(stub.calls).toHaveLength(1);
  });

  it("a cross-origin 302 on a read is refused and the credential goes nowhere else", async () => {
    const stub = serve({ status: 302, headers: { Location: EVIL } });
    await onSite(async () => {
      await expect(tools.call("jira_issue_get", { issueKey: "ENG-7" })).rejects.toThrow(
        "Jira redirected to another origin; refused",
      );
    });
    expect(stub.calls).toHaveLength(1);
  });
});

describe("jira issue assign (standalone mode)", () => {
  let dir: string;
  let auditLog: string;

  beforeEach(() => {
    resetConnectorModeForTests();
    setConnectorMode("standalone");
    dir = mkdtempSync(join(tmpdir(), "nimbus-jira-audit-"));
    auditLog = join(dir, "audit.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("records the previous assignee before the PUT, so the assignment can be put back", async () => {
    let standalone: CapturedTools | undefined;
    await withEnv(
      { NIMBUS_MCP_JIRA_WRITE_SCOPE: "issue:ENG-7", NIMBUS_MCP_AUDIT_LOG: auditLog },
      () => {
        standalone = captureStandaloneTools(registerJiraTools, { elicitation: true }).tools;
      },
    );
    const stub = serve((req) =>
      req.method === "GET"
        ? '{"fields":{"assignee":{"accountId":"old-1","displayName":"Ada"}}}'
        : { status: 204, body: "" },
    );
    await onSite(async () => {
      await standalone?.call("jira_issue_assign", { issueKey: "ENG-7", accountId: null });
    });
    expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${SITE}/rest/api/3/issue/ENG-7?fields=assignee`,
      `PUT ${SITE}/rest/api/3/issue/ENG-7/assignee`,
    ]);
    const executed = readFileSync(auditLog, "utf8")
      .trim()
      .split(String.fromCharCode(10))
      .map(
        (l) =>
          (JSON.parse(l) as { entry: { outcome: string; detail: Record<string, unknown> } }).entry,
      )
      .find((e) => e.outcome === "executed");
    expect(executed?.detail["preState"]).toEqual({ assigneeAccountId: "old-1" });
  });
});
