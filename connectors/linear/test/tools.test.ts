import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  type RecordedRequest,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { LINEAR_TOOL_NAMES, registerLinearTools } from "../src/tools.ts";

const GQL = "https://api.linear.app/graphql";

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

/** The GraphQL document and variables one request carried. */
function gql(req: RecordedRequest): { query: string; variables: Record<string, unknown> } {
  return JSON.parse(req.body ?? "null") as { query: string; variables: Record<string, unknown> };
}

/** Call `name` with the API key set; answer with `data`; return the request and the result. */
async function call(
  name: string,
  args: Record<string, unknown>,
  data: unknown = {},
): Promise<{ req: RecordedRequest; out: unknown }> {
  const stub = serve(JSON.stringify({ data }));
  let out: unknown;
  await withEnv({ LINEAR_API_KEY: "lin_api_test" }, async () => {
    out = await tools.callJson(name, args);
  });
  return { req: stub.only, out };
}

beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  tools = captureTools(registerLinearTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
});

describe("linear tools", () => {
  it("registers exactly LINEAR_TOOL_NAMES, in order", () => {
    expect(tools.registrationOrder()).toEqual([...LINEAR_TOOL_NAMES]);
  });

  it("issue_list with no filter POSTs the unfiltered query with the raw API key", async () => {
    const data = { issues: { nodes: [{ id: "i1", identifier: "ENG-1" }] } };
    const { req, out } = await call("linear_issue_list", {}, data);
    expect(out).toEqual(data);
    expect(req.method).toBe("POST");
    expect(req.url).toBe(GQL);
    // Linear takes a personal API key bare, with no Bearer scheme.
    expect(req.headers["authorization"]).toBe("lin_api_test");
    expect(req.headers["content-type"]).toBe("application/json");
    const { query, variables } = gql(req);
    expect(query).not.toContain("$filter");
    expect(variables).toEqual({ first: 50 });
  });

  it("issue_list turns each filter argument into its IssueFilter clause", async () => {
    const { req } = await call("linear_issue_list", {
      first: 10,
      teamId: "team-1",
      stateName: "In Progress",
      assigneeId: "user-9",
    });
    const { query, variables } = gql(req);
    expect(query).toContain("$filter: IssueFilter!");
    expect(variables).toEqual({
      first: 10,
      filter: {
        team: { id: { eq: "team-1" } },
        state: { name: { eq: "In Progress" } },
        assignee: { id: { eq: "user-9" } },
      },
    });
  });

  it("issue_list sends only the filters given", async () => {
    const { req } = await call("linear_issue_list", { stateName: "Done" });
    expect(gql(req).variables).toEqual({ first: 50, filter: { state: { name: { eq: "Done" } } } });
  });

  it("issue_get asks for one issue by id", async () => {
    const { req, out } = await call("linear_issue_get", { issueId: "uuid-1" }, { issue: null });
    expect(gql(req).variables).toEqual({ id: "uuid-1" });
    expect(out).toEqual({ issue: null });
  });

  it("issue_create sends the required input alone when nothing else is given", async () => {
    const { req } = await call("linear_issue_create", { teamId: "team-1", title: "Fix login" });
    expect(gql(req).query).toContain("issueCreate(input: $input)");
    expect(gql(req).variables).toEqual({ input: { teamId: "team-1", title: "Fix login" } });
  });

  it("issue_create carries every optional field, including priority 0", async () => {
    const { req } = await call("linear_issue_create", {
      teamId: "team-1",
      title: "Fix login",
      description: "Steps to reproduce",
      priority: 0,
      stateId: "state-2",
      assigneeId: "user-9",
    });
    expect(gql(req).variables).toEqual({
      input: {
        teamId: "team-1",
        title: "Fix login",
        description: "Steps to reproduce",
        priority: 0,
        stateId: "state-2",
        assigneeId: "user-9",
      },
    });
  });

  it("issue_update sends only the fields given, keyed by the issue id", async () => {
    const { req: one } = await call("linear_issue_update", { issueId: "uuid-1", title: "New" });
    expect(gql(one).variables).toEqual({ id: "uuid-1", input: { title: "New" } });

    const { req: all } = await call("linear_issue_update", {
      issueId: "uuid-1",
      title: "T",
      description: "D",
      stateId: "s",
      priority: 2,
      assigneeId: "a",
    });
    expect(gql(all).variables).toEqual({
      id: "uuid-1",
      input: { title: "T", description: "D", stateId: "s", priority: 2, assigneeId: "a" },
    });
  });

  it("comment_create posts the body against the issue", async () => {
    const { req } = await call("linear_comment_create", { issueId: "uuid-1", body: "LGTM" });
    expect(gql(req).query).toContain("commentCreate(input: $input)");
    expect(gql(req).variables).toEqual({ input: { issueId: "uuid-1", body: "LGTM" } });
  });

  it("the list queries default their page sizes", async () => {
    for (const [name, args, variables] of [
      ["linear_project_list", {}, { first: 50 }],
      ["linear_project_list", { first: 5 }, { first: 5 }],
      ["linear_project_get", { projectId: "p1" }, { id: "p1" }],
      ["linear_cycle_list", { teamId: "team-1" }, { teamId: "team-1", first: 20 }],
      ["linear_cycle_list", { teamId: "team-1", first: 3 }, { teamId: "team-1", first: 3 }],
      ["linear_roadmap_list", {}, { first: 30 }],
      ["linear_member_list", {}, { first: 50 }],
      ["linear_member_list", { first: 7 }, { first: 7 }],
    ] as const) {
      const { req } = await call(name, args);
      expect([name, gql(req).variables]).toEqual([name, variables]);
    }
  });

  it("surfaces a non-2xx response with its status and body", async () => {
    serve({ status: 401, body: "Authentication required" });
    await withEnv({ LINEAR_API_KEY: "bad" }, async () => {
      await expect(tools.call("linear_member_list", {})).rejects.toThrow(
        "Linear 401: Authentication required",
      );
    });
  });

  it("reports a 2xx body that is not JSON as invalid JSON", async () => {
    serve("<html>gateway timeout</html>");
    await withEnv({ LINEAR_API_KEY: "k" }, async () => {
      await expect(tools.call("linear_project_list", {})).rejects.toThrow(
        "Linear 200: invalid JSON",
      );
    });
  });

  it("joins GraphQL errors into one message", async () => {
    serve(JSON.stringify({ errors: [{ message: "Entity not found" }, { message: "Forbidden" }] }));
    await withEnv({ LINEAR_API_KEY: "k" }, async () => {
      await expect(tools.call("linear_issue_get", { issueId: "x" })).rejects.toThrow(
        "Linear GraphQL: Entity not found; Forbidden",
      );
    });
  });

  it("refuses a response that carries neither data nor errors", async () => {
    serve(JSON.stringify({ errors: [] }));
    await withEnv({ LINEAR_API_KEY: "k" }, async () => {
      await expect(tools.call("linear_roadmap_list", {})).rejects.toThrow(
        "Linear GraphQL: missing data",
      );
    });
  });

  it("refuses without LINEAR_API_KEY, before any request", async () => {
    const stub = serve("{}");
    await withEnv({ LINEAR_API_KEY: undefined }, async () => {
      await expect(tools.call("linear_issue_list", {})).rejects.toThrow(
        "LINEAR_API_KEY is not set",
      );
    });
    expect(stub.calls).toEqual([]);
  });
});
