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
import { registerBitriseTools } from "../src/tools.ts";

const API = "https://api.bitrise.io";
const ARGS = { appSlug: "app-1", branch: "release/1.2", workflow: "deploy" };

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: StubReply): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

const withToken = (fn: () => Promise<void>): Promise<void> =>
  withEnv({ BITRISE_TOKEN: "br-token" }, fn);

async function buildSlugFor(reply: unknown): Promise<unknown> {
  serve(JSON.stringify(reply));
  let out: unknown;
  await withToken(async () => {
    out = await tools.callJson("bitrise_build_trigger", ARGS);
  });
  return (out as { buildSlug: unknown }).buildSlug;
}

beforeEach(() => {
  setConnectorMode("gateway");
  tools = captureTools(registerBitriseTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
  resetConnectorModeForTests();
});

describe("bitrise_build_trigger (gateway mode)", () => {
  it("POSTs hook_info and build_params with the raw token and no Bearer", async () => {
    const stub = serve(
      '{"status":"ok","message":"webhook processed","slug":"bld-slug","service":"bitrise"}',
    );
    let result: unknown;
    await withToken(async () => {
      result = await tools.callJson("bitrise_build_trigger", ARGS);
    });
    const req = stub.only;
    expect(`${req.method} ${req.url}`).toBe(`POST ${API}/v0.1/apps/app-1/builds`);
    expect(req.headers["authorization"]).toBe("br-token");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(req.body ?? "null")).toEqual({
      hook_info: { type: "bitrise" },
      build_params: { branch: "release/1.2", workflow_id: "deploy" },
    });
    expect(result).toEqual({
      ok: true,
      status: "accepted",
      appSlug: "app-1",
      branch: "release/1.2",
      workflow: "deploy",
      buildSlug: "bld-slug",
    });
  });

  it("reads build_slug at the root, then slug, then results[0].build_slug, and never build_url", async () => {
    expect(
      await buildSlugFor({ build_slug: "root", slug: "s", results: [{ build_slug: "r0" }] }),
    ).toBe("root");
    expect(await buildSlugFor({ slug: "s", results: [{ build_slug: "r0" }] })).toBe("s");
    expect(await buildSlugFor({ results: [{ build_slug: "r0" }, { build_slug: "r1" }] })).toBe(
      "r0",
    );
    // The deprecated URL is not a slug: a reply with only that names no build.
    expect(
      await buildSlugFor({ build_url: "https://app.bitrise.io/build/zzz", build_number: 7 }),
    ).toBeNull();
  });

  it("refuses a 307 and sends no second request", async () => {
    const stub = serve({ status: 307, headers: { Location: "https://evil.test/steal" } });
    await withToken(async () => {
      await expect(tools.call("bitrise_build_trigger", ARGS)).rejects.toThrow(/redirect/i);
    });
    expect(stub.calls).toHaveLength(1);
    expect(stub.only.redirect).toBe("manual");
  });

  it("refuses an app slug, branch or workflow that could reach another path, before any request", async () => {
    const stub = serve("{}");
    await withToken(async () => {
      for (const bad of ["../x", "a/b", "a b", "", ".", ".."]) {
        await expect(
          tools.call("bitrise_build_trigger", { ...ARGS, appSlug: bad }),
        ).rejects.toThrow();
      }
      for (const bad of ["../x", "-x", "a b", "a..b", "x.lock"]) {
        await expect(
          tools.call("bitrise_build_trigger", { ...ARGS, branch: bad }),
        ).rejects.toThrow();
      }
      for (const bad of ["", "a b", "a/b", "../x", "-x"]) {
        await expect(
          tools.call("bitrise_build_trigger", { ...ARGS, workflow: bad }),
        ).rejects.toThrow();
      }
    });
    expect(stub.calls).toEqual([]);
  });

  it("refuses without BITRISE_TOKEN before any request", async () => {
    const stub = serve("{}");
    await withEnv({ BITRISE_TOKEN: undefined }, async () => {
      await expect(tools.call("bitrise_build_trigger", ARGS)).rejects.toThrow(
        "BITRISE_TOKEN is not set",
      );
    });
    expect(stub.calls).toEqual([]);
  });

  it("surfaces an API refusal, and never reports completion", async () => {
    serve({ status: 403, body: "no access" });
    await withToken(async () => {
      await expect(tools.call("bitrise_build_trigger", ARGS)).rejects.toThrow(/403.*no access/);
    });
    serve('{"slug":"b","status":"ok"}');
    await withToken(async () => {
      const text = JSON.stringify(await tools.callJson("bitrise_build_trigger", ARGS));
      expect(text).not.toMatch(/deployed|done|completed/i);
    });
  });
});

describe("bitrise_build_latest", () => {
  it("asks for one build, filtered by branch and workflow, and projects it", async () => {
    const stub = serve(
      JSON.stringify({
        data: [
          {
            slug: "b9",
            status: 1,
            status_text: "success",
            branch: "main",
            triggered_workflow: "primary",
            triggered_at: "t0",
            finished_at: "t1",
            commit_message: "secret message",
          },
        ],
      }),
    );
    await withToken(async () => {
      expect(
        await tools.callJson("bitrise_build_latest", {
          appSlug: "app-1",
          branch: "main",
          workflow: "primary",
        }),
      ).toEqual({
        build: {
          slug: "b9",
          status: 1,
          status_text: "success",
          branch: "main",
          triggered_workflow: "primary",
          triggered_at: "t0",
          finished_at: "t1",
        },
      });
    });
    expect(stub.only.url).toBe(
      `${API}/v0.1/apps/app-1/builds?limit=1&branch=main&workflow=primary`,
    );
  });

  it("returns build: null when the app has none, with only limit=1 in the query", async () => {
    const stub = serve('{"data":[]}');
    await withToken(async () => {
      expect(await tools.callJson("bitrise_build_latest", { appSlug: "app-1" })).toEqual({
        build: null,
      });
    });
    expect(stub.only.url).toBe(`${API}/v0.1/apps/app-1/builds?limit=1`);
  });
});
