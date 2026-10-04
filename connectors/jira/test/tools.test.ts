import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
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

  it("issue_get GETs one encoded issue with its comment field", async () => {
    const req = await request("jira_issue_get", { issueKey: "OPS 1" });
    expect(req.method).toBe("GET");
    expect(req.url).toBe(
      `${SITE}/rest/api/3/issue/OPS%201?fields=summary,description,updated,status,issuetype,priority,assignee,comment`,
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

  it("comment_add POSTs the comment as ADF to the encoded issue", async () => {
    const req = await request("jira_comment_add", { issueKey: "OPS/7", body: "Fixed in 1.2" });
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${SITE}/rest/api/3/issue/OPS%2F7/comment`);
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
