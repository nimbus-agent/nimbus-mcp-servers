import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type FetchStub,
  stubFetch,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { registerSentryTools, SENTRY_TOOL_NAMES } from "../src/tools.ts";

const API = "https://sentry.io/api/0";

let tools: CapturedTools;
let http: FetchStub | undefined;

function serve(reply: Parameters<typeof stubFetch>[0]): FetchStub {
  http?.restore();
  http = stubFetch(reply);
  return http;
}

function configured(fn: () => Promise<void>): Promise<void> {
  return withEnv(
    { SENTRY_AUTH_TOKEN: "sntrys_token", SENTRY_ORG_SLUG: "acme", SENTRY_URL: undefined },
    fn,
  );
}

beforeEach(() => {
  tools = captureTools(registerSentryTools);
});

afterEach(() => {
  http?.restore();
  http = undefined;
});

describe("sentry tools", () => {
  it("registers exactly SENTRY_TOOL_NAMES, in order", () => {
    expect(tools.registrationOrder()).toEqual([...SENTRY_TOOL_NAMES]);
  });

  it("lists a project's unresolved issues and releases under the configured org", async () => {
    const stub = serve("[]");
    await configured(async () => {
      await tools.call("sentry_issue_list", { projectSlug: "web-app", limit: 5 });
      await tools.call("sentry_release_list", { projectSlug: "web-app" });
    });
    expect(stub.calls.map((c) => c.url)).toEqual([
      `${API}/projects/acme/web-app/issues/?query=is:unresolved&limit=5`,
      `${API}/projects/acme/web-app/releases/`,
    ]);
    expect(stub.calls[0]?.headers["authorization"]).toBe("Bearer sntrys_token");
  });

  it("refuses a project slug that would leave /projects/<org>/<project>/, before any request", async () => {
    const stub = serve("[]");
    await configured(async () => {
      for (const projectSlug of [
        "..",
        ".",
        "../../organizations/acme/members",
        "web-app/../../x",
        "web-app?query=",
        "web app",
        "a".repeat(101),
      ]) {
        await expect(tools.call("sentry_issue_list", { projectSlug })).rejects.toThrow(
          "a Sentry project slug",
        );
        await expect(tools.call("sentry_release_list", { projectSlug })).rejects.toThrow(
          "a Sentry project slug",
        );
      }
    });
    expect(stub.calls).toEqual([]);
  });

  it("encodes the configured org slug into its path segment", async () => {
    const stub = serve("[]");
    await withEnv(
      { SENTRY_AUTH_TOKEN: "t", SENTRY_ORG_SLUG: "my org", SENTRY_URL: undefined },
      async () => {
        await tools.call("sentry_release_list", { projectSlug: "web" });
      },
    );
    expect(stub.only.url).toBe(`${API}/projects/my%20org/web/releases/`);
  });
});
