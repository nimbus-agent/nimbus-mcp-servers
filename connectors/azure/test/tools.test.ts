import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  refusalSaying,
  type SpawnStub,
  stubSpawn,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { registerAzureTools } from "../src/tools.ts";

let tools: CapturedTools;
let spawn: SpawnStub | undefined;

/** Answer every az call with this reply, replacing any stub already installed. */
function cli(reply: { stdout?: string; stderr?: string; exitCode?: number }): SpawnStub {
  spawn?.restore();
  spawn = stubSpawn(reply);
  return spawn;
}

beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  tools = captureTools(registerAzureTools);
});

afterEach(() => {
  spawn?.restore();
  spawn = undefined;
  resetConnectorModeForTests();
});

const RG = { subscriptionId: "sub-1", resourceGroup: "rg-1" };

const WRITES: readonly {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly argv: readonly string[];
}[] = [
  {
    tool: "azure_app_service_restart",
    args: { ...RG, name: "web" },
    argv: [
      "az",
      "webapp",
      "restart",
      "--subscription",
      "sub-1",
      "--resource-group",
      "rg-1",
      "--name",
      "web",
    ],
  },
  {
    tool: "azure_aks_node_pool_scale",
    args: { ...RG, clusterName: "aks", poolName: "np1", nodeCount: 3 },
    argv: [
      "az",
      "aks",
      "nodepool",
      "scale",
      "--subscription",
      "sub-1",
      "--resource-group",
      "rg-1",
      "--cluster-name",
      "aks",
      "--name",
      "np1",
      "--node-count",
      "3",
    ],
  },
];

describe("azure write tools", () => {
  for (const { tool, args, argv } of WRITES) {
    it(`${tool} runs exactly its az command and reports ok`, async () => {
      const stub = cli({ stdout: "" });
      expect(await tools.callJson(tool, args)).toEqual({ ok: true });
      expect(stub.calls.map((c) => c.command)).toEqual([[...argv]]);
    });

    it(`${tool} throws az's exit code and stderr`, async () => {
      cli({ exitCode: 3, stderr: "AuthorizationFailed" });
      await expect(tools.call(tool, args)).rejects.toThrow("az exited 3: AuthorizationFailed");
    });
  }
});

describe("azure refuses a value az would replace by a file, before az runs", () => {
  // az replaces an argument that starts with @ by the contents of the file it names, with ~
  // expanded and @- read from stdin, and does the same to whatever follows the first = in an
  // argument. The file would reach Azure as the value, which a "not found" error can quote back.
  const CASES: readonly (readonly [string, Record<string, unknown>, string])[] = [
    [
      "azure_app_service_list",
      { ...RG, resourceGroup: "@~/.azure/msal_token_cache.json" },
      'must not start with "@"',
    ],
    ["azure_app_service_list", { ...RG, subscriptionId: "@-" }, 'must not start with "@"'],
    ["azure_app_service_restart", { ...RG, name: "web=@/etc/hosts" }, 'must not contain "=@"'],
    [
      "azure_aks_node_pool_scale",
      { ...RG, clusterName: "aks", poolName: "--debug", nodeCount: 1 },
      'must not start with "-"',
    ],
    [
      "azure_app_service_restart",
      { ...RG, name: "web\nweb2" },
      "must not contain control characters",
    ],
  ];

  for (const [tool, args, refusal] of CASES) {
    it(`${tool} refuses ${JSON.stringify(args)}`, async () => {
      const stub = cli({ stdout: "" });
      await expect(tools.call(tool, args)).rejects.toThrow(refusalSaying(refusal));
      expect(stub.calls).toEqual([]);
    });
  }
});

describe("azure_app_service_list", () => {
  it("asks az for JSON output and returns it", async () => {
    const stub = cli({ stdout: '[{"name":"web"}]' });
    expect(await tools.callJson("azure_app_service_list", RG)).toEqual([{ name: "web" }]);
    expect(stub.calls[0]?.command).toEqual([
      "az",
      "webapp",
      "list",
      "--subscription",
      "sub-1",
      "--resource-group",
      "rg-1",
      "-o",
      "json",
    ]);
  });

  it("reports an empty answer as an empty object", async () => {
    cli({ stdout: "" });
    expect(await tools.callJson("azure_app_service_list", RG)).toEqual({});
  });

  it("throws az's exit code and stderr", async () => {
    cli({ exitCode: 1, stderr: "Please run 'az login'" });
    await expect(tools.call("azure_app_service_list", RG)).rejects.toThrow(
      "az exited 1: Please run 'az login'",
    );
  });
});
