import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  refusalSaying,
  type SpawnStub,
  stubSpawn,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { CLOUD_LOGGING_TOOL_NAMES, registerCloudLoggingTools } from "../src/tools.ts";

const SINKS = [
  {
    name: "audit-to-bq",
    destination: "bigquery.googleapis.com/projects/acme/datasets/audit",
    filter: 'logName:"cloudaudit.googleapis.com"',
  },
  {
    name: "errors-to-pubsub",
    destination: "pubsub.googleapis.com/projects/acme/topics/alerts",
    filter: "severity>=ERROR",
  },
  "not a sink",
];

let tools: CapturedTools;
let spawn: SpawnStub | undefined;

/** Answer every gcloud invocation with `reply`, replacing any stub already installed. */
function cli(reply: { stdout?: string; stderr?: string; exitCode?: number }): SpawnStub {
  spawn?.restore();
  spawn = stubSpawn(reply);
  return spawn;
}

/** Run `fn` with no project pinned, so gcloud keeps the project it is configured with. */
function unpinned(fn: () => Promise<void>): Promise<void> {
  return withEnv({ GOOGLE_CLOUD_PROJECT: undefined }, fn);
}

beforeEach(() => {
  tools = captureTools(registerCloudLoggingTools);
});

afterEach(() => {
  spawn?.restore();
  spawn = undefined;
});

describe("cloud_logging tools", () => {
  it("registers exactly CLOUD_LOGGING_TOOL_NAMES, in order", () => {
    expect(tools.registrationOrder()).toEqual([...CLOUD_LOGGING_TOOL_NAMES]);
  });

  it("list runs `gcloud logging sinks list` as JSON and returns the sinks", async () => {
    const stub = cli({ stdout: JSON.stringify(SINKS) });
    await unpinned(async () => {
      expect(await tools.callJson("cloud_logging_list")).toEqual(SINKS);
    });
    expect(stub.calls.map((c) => c.command)).toEqual([
      ["gcloud", "logging", "sinks", "list", "--format", "json"],
    ]);
  });

  it("pins the project when GOOGLE_CLOUD_PROJECT is set", async () => {
    const stub = cli({ stdout: "[]" });
    await withEnv({ GOOGLE_CLOUD_PROJECT: " acme-prod " }, async () => {
      await tools.call("cloud_logging_list");
    });
    expect(stub.calls[0]?.command).toEqual([
      "gcloud",
      "logging",
      "sinks",
      "list",
      "--project",
      "acme-prod",
      "--format",
      "json",
    ]);
  });

  it("list answers an empty list for empty output or output that is not a list", async () => {
    for (const stdout of ["", "  \n", '{"sinks":[]}']) {
      cli({ stdout });
      await unpinned(async () => {
        expect(await tools.callJson("cloud_logging_list")).toEqual([]);
      });
    }
  });

  it("get describes one sink", async () => {
    const stub = cli({ stdout: JSON.stringify(SINKS[0]) });
    await unpinned(async () => {
      expect(await tools.callJson("cloud_logging_get", { sinkName: "audit-to-bq" })).toEqual(
        SINKS[0],
      );
    });
    expect(stub.calls[0]?.command).toEqual([
      "gcloud",
      "logging",
      "sinks",
      "describe",
      "audit-to-bq",
      "--format",
      "json",
    ]);
  });

  it("get refuses a sink name that would be read as a gcloud flag, at its schema", async () => {
    const stub = cli({ stdout: "{}" });
    await expect(
      tools.call("cloud_logging_get", { sinkName: "--impersonate-service-account=x" }),
    ).rejects.toThrow(refusalSaying('must not start with "-"'));
    expect(stub.calls).toEqual([]);
    // Refused by the schema itself, so before a consent prompt or the handler could run.
    const schema = tools.get("cloud_logging_get").schema as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ sinkName: "--impersonate-service-account=x" }).success).toBe(false);
    expect(schema.safeParse({ sinkName: "audit-to-bq" }).success).toBe(true);
  });

  it("search matches sink names, filters and destinations, case-insensitively", async () => {
    cli({ stdout: JSON.stringify(SINKS) });
    const names = async (query: string): Promise<unknown[]> => {
      let out: unknown;
      await unpinned(async () => {
        out = await tools.callJson("cloud_logging_search", { query });
      });
      return (out as { matches: { name: string }[] }).matches.map((m) => m.name);
    };
    expect(await names("AUDIT-TO")).toEqual(["audit-to-bq"]);
    expect(await names("severity>=error")).toEqual(["errors-to-pubsub"]);
    expect(await names("pubsub.googleapis")).toEqual(["errors-to-pubsub"]);
    expect(await names("acme")).toEqual(["audit-to-bq", "errors-to-pubsub"]);
    expect(await names("storage.googleapis")).toEqual([]);
  });

  it("throws gcloud's stderr when the CLI fails", async () => {
    cli({
      exitCode: 1,
      stdout: "",
      stderr: "ERROR: (gcloud.logging.sinks.list) PERMISSION_DENIED",
    });
    await unpinned(async () => {
      await expect(tools.call("cloud_logging_search", { query: "x" })).rejects.toThrow(
        "gcloud logging sinks failed: ERROR: (gcloud.logging.sinks.list) PERMISSION_DENIED",
      );
    });
  });
});
