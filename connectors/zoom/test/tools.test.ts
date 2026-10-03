import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  type StubReply,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { registerZoomTools, ZOOM_TOOL_NAMES } from "../src/tools.ts";

const API = "https://api.zoom.us/v2";

const MEETINGS = {
  meetings: [
    { id: 1, topic: "Weekly sync", agenda: "Roadmap review", host_id: "host-a" },
    { id: 2, topic: "Interview", agenda: "", host_id: "host-b" },
    { id: 3, topic: "Weekly retro", agenda: "", host_id: "host-a" },
  ],
};

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

function configured(fn: () => Promise<void>): Promise<void> {
  return withEnv({ ZOOM_TOKEN: "zoom-token" }, fn);
}

beforeEach(() => {
  tools = captureTools(registerZoomTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

describe("zoom tools", () => {
  it("registers exactly ZOOM_TOOL_NAMES, in order", () => {
    expect(tools.registrationOrder()).toEqual([...ZOOM_TOOL_NAMES]);
  });

  it("list reads the scheduled meetings, 100 per page, with a bearer token", async () => {
    const stub = serve(JSON.stringify(MEETINGS));
    await configured(async () => {
      expect(await tools.callJson("zoom_list", {})).toEqual(MEETINGS);
    });
    expect(stub.only.url).toBe(`${API}/users/me/meetings?type=scheduled&page_size=100`);
    expect(stub.only.headers["authorization"]).toBe("Bearer zoom-token");
  });

  it("get and transcript_get double-encode a UUID that starts with a slash", async () => {
    const stub = serve("{}");
    await configured(async () => {
      await tools.call("zoom_get", { id: "123456789" });
      await tools.call("zoom_get", { id: "/abc==" });
      await tools.call("zoom_transcript_get", { id: "/abc==" });
    });
    expect(stub.calls.map((c) => c.url)).toEqual([
      `${API}/meetings/123456789`,
      `${API}/meetings/%252Fabc%253D%253D`,
      `${API}/meetings/%252Fabc%253D%253D/recordings`,
    ]);
  });

  it("search matches topic, agenda and host id, and honours `limit`", async () => {
    serve(JSON.stringify(MEETINGS));
    const ids = async (args: Record<string, unknown>): Promise<unknown[]> => {
      let out: unknown;
      await configured(async () => {
        out = await tools.callJson("zoom_search", args);
      });
      return (out as { matches: { id: number }[] }).matches.map((m) => m.id);
    };
    expect(await ids({ query: "WEEKLY" })).toEqual([1, 3]);
    expect(await ids({ query: "weekly", limit: 1 })).toEqual([1]);
    expect(await ids({ query: "roadmap" })).toEqual([1]);
    expect(await ids({ query: "host-b" })).toEqual([2]);
    expect(await ids({ query: "standup" })).toEqual([]);
  });

  it("search finds nothing in an answer that carries no `meetings` array", async () => {
    serve('{"code":124,"message":"Invalid access token."}');
    await configured(async () => {
      expect(await tools.callJson("zoom_search", { query: "weekly" })).toEqual({ matches: [] });
    });
  });

  it("recordings_list asks for one window of cloud recordings, 100 per page", async () => {
    const stub = serve('{"meetings":[]}');
    await configured(async () => {
      expect(
        await tools.callJson("zoom_recordings_list", { from: "2026-05-01", to: "2026-05-31" }),
      ).toEqual({ meetings: [] });
    });
    expect(stub.only.url).toBe(
      `${API}/users/me/recordings?from=2026-05-01&to=2026-05-31&page_size=100`,
    );
  });

  it("recordings_list refuses a window Zoom would reject, before any request", async () => {
    const stub = serve("{}");
    await configured(async () => {
      await expect(
        tools.call("zoom_recordings_list", { from: "2026-01-01", to: "2026-03-01" }),
      ).rejects.toThrow("Zoom requires (to - from) <= 1 month; got 59 days.");
      await expect(
        tools.call("zoom_recordings_list", { from: "2026-03-01", to: "2026-01-01" }),
      ).rejects.toThrow("'to' (2026-01-01) must be >= 'from' (2026-03-01).");
    });
    expect(stub.calls).toEqual([]);
  });

  it("refuses without ZOOM_TOKEN, before any request, and quotes an API failure", async () => {
    const stub = serve("{}");
    await withEnv({ ZOOM_TOKEN: undefined }, async () => {
      await expect(tools.call("zoom_list", {})).rejects.toThrow("ZOOM_TOKEN is not set");
    });
    expect(stub.calls).toEqual([]);

    serve({ status: 404, body: '{"code":3001,"message":"Meeting does not exist"}' });
    await configured(async () => {
      await expect(tools.call("zoom_get", { id: "9" })).rejects.toThrow(
        'Zoom 404: {"code":3001,"message":"Meeting does not exist"}',
      );
    });
  });
});
