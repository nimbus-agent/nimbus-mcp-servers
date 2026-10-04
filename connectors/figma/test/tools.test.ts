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
import { FIGMA_TOOL_NAMES, registerFigmaTools } from "../src/tools.ts";

const BASE = "https://api.figma.com";

/** A team with three usable projects and three entries that do not name one. */
const PROJECTS = {
  name: "Acme",
  projects: [
    { id: "11", name: "Design System" },
    { id: 22, name: "Marketing" },
    { id: "33" },
    { id: null, name: "no id" },
    { name: "missing id" },
    null,
  ],
};

const FILES: Record<string, unknown> = {
  "11": {
    name: "Design System",
    files: [{ key: "a1", name: "Q2 Roadmap", last_modified: "2026-09-01T00:00:00Z" }],
  },
  "22": {
    name: "Marketing",
    files: [
      { key: "b1", name: "Landing page" },
      { key: "b2", name: "Roadmap teaser" },
    ],
  },
  // A project whose files endpoint carries no `files` array contributes nothing.
  "33": { name: "Empty" },
};

function team(req: RecordedRequest): StubReply | undefined {
  if (req.url === `${BASE}/v1/teams/team%2F42/projects`) return JSON.stringify(PROJECTS);
  const m = /^https:\/\/api\.figma\.com\/v1\/projects\/([^/]+)\/files$/.exec(req.url);
  const files = m?.[1] === undefined ? undefined : FILES[m[1]];
  return files === undefined ? undefined : JSON.stringify(files);
}

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply | ((req: RecordedRequest) => StubReply | undefined)): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

beforeEach(() => {
  tools = captureTools(registerFigmaTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

/** The configured team every test runs against; the id needs encoding on purpose. */
function asTeam(fn: () => Promise<void>): Promise<void> {
  return withEnv({ FIGMA_TOKEN: "figd_test", FIGMA_TEAM_ID: "team/42" }, fn);
}

describe("figma tools", () => {
  it("registers exactly FIGMA_TOOL_NAMES", () => {
    expect(tools.names()).toEqual([...FIGMA_TOOL_NAMES]);
  });

  it("list flattens every project's files, tagged with the project they came from", async () => {
    const stub = serve(team);
    await asTeam(async () => {
      expect(await tools.callJson("figma_list")).toEqual({
        files: [
          {
            key: "a1",
            name: "Q2 Roadmap",
            last_modified: "2026-09-01T00:00:00Z",
            project_id: "11",
            project_name: "Design System",
          },
          { key: "b1", name: "Landing page", project_id: "22", project_name: "Marketing" },
          { key: "b2", name: "Roadmap teaser", project_id: "22", project_name: "Marketing" },
        ],
      });
    });
    // One projects call, then one files call per project that has an id — numeric ids included.
    expect(stub.calls.map((c) => c.url)).toEqual([
      `${BASE}/v1/teams/team%2F42/projects`,
      `${BASE}/v1/projects/11/files`,
      `${BASE}/v1/projects/22/files`,
      `${BASE}/v1/projects/33/files`,
    ]);
    for (const call of stub.calls) {
      expect(call.headers["authorization"]).toBe("Bearer figd_test");
    }
  });

  it("list is empty, after one request, when the team answer carries no projects", async () => {
    const stub = serve(JSON.stringify({ name: "Acme" }));
    await asTeam(async () => {
      expect(await tools.callJson("figma_list")).toEqual({ files: [] });
    });
    expect(stub.calls).toHaveLength(1);
  });

  it("get returns one project's files envelope as-is", async () => {
    const stub = serve(JSON.stringify(FILES["22"]));
    await asTeam(async () => {
      expect(await tools.callJson("figma_get", { projectId: "22/x" })).toEqual(FILES["22"]);
    });
    expect(stub.only.url).toBe(`${BASE}/v1/projects/22%2Fx/files`);
  });

  it("search matches file names and project names, case-insensitively, within the limit", async () => {
    serve(team);
    await asTeam(async () => {
      const byFile = (await tools.callJson("figma_search", { query: "ROADMAP" })) as {
        matches: { key: string }[];
      };
      expect(byFile.matches.map((m) => m.key)).toEqual(["a1", "b2"]);

      const byProject = (await tools.callJson("figma_search", { query: "marketing" })) as {
        matches: { key: string }[];
      };
      expect(byProject.matches.map((m) => m.key)).toEqual(["b1", "b2"]);

      const limited = (await tools.callJson("figma_search", { query: "roadmap", limit: 1 })) as {
        matches: { key: string }[];
      };
      expect(limited.matches.map((m) => m.key)).toEqual(["a1"]);
    });
  });

  it("list refuses without FIGMA_TEAM_ID, before any request", async () => {
    const stub = serve(team);
    await withEnv({ FIGMA_TOKEN: "figd_test", FIGMA_TEAM_ID: undefined }, async () => {
      await expect(tools.call("figma_list")).rejects.toThrow("FIGMA_TEAM_ID is not set");
    });
    expect(stub.calls).toEqual([]);
  });

  it("surfaces a non-2xx answer with its status and body", async () => {
    serve({ status: 403, body: "Invalid token" });
    await asTeam(async () => {
      await expect(tools.call("figma_search", { query: "x" })).rejects.toThrow(
        "Figma 403: Invalid token",
      );
    });
  });
});
