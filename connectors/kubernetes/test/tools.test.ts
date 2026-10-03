import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CapturedTools,
  captureTools,
  type SpawnStub,
  stubSpawn,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { registerKubernetesTools } from "../src/tools.ts";

let tools: CapturedTools;
let spawn: SpawnStub | undefined;
const saved = new Map<string, string | undefined>();

/** Answer every kubectl call with this reply, replacing any stub already installed. */
function cli(reply: { stdout?: string; stderr?: string; exitCode?: number }): SpawnStub {
  spawn?.restore();
  spawn = stubSpawn(reply);
  return spawn;
}

beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  for (const key of ["KUBECONFIG", "KUBE_CONTEXT"]) saved.set(key, process.env[key]);
  process.env["KUBECONFIG"] = "/nonexistent/kubeconfig";
  delete process.env["KUBE_CONTEXT"];
  tools = captureTools(registerKubernetesTools);
});

afterEach(() => {
  spawn?.restore();
  spawn = undefined;
  for (const [key, value] of saved) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  resetConnectorModeForTests();
});

const WRITES: readonly {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly argv: readonly string[];
}[] = [
  {
    tool: "k8s_rollout_restart",
    args: { resourceType: "deployment", name: "api" },
    argv: ["kubectl", "rollout", "restart", "deployment", "api", "-n", "default"],
  },
  {
    tool: "k8s_pod_delete",
    args: { namespace: "prod", podName: "api-1" },
    argv: ["kubectl", "delete", "pod", "api-1", "-n", "prod"],
  },
  {
    tool: "k8s_deployment_scale",
    args: { namespace: "prod", deploymentName: "api", replicas: 0 },
    argv: ["kubectl", "scale", "deployment", "api", "-n", "prod", "--replicas=0"],
  },
];

describe("kubernetes write tools", () => {
  for (const { tool, args, argv } of WRITES) {
    it(`${tool} runs exactly its kubectl command and reports ok`, async () => {
      const stub = cli({ stdout: "" });
      expect(await tools.callJson(tool, args)).toEqual({ ok: true });
      expect(stub.calls.map((c) => c.command)).toEqual([[...argv]]);
      expect(stub.calls[0]?.env["KUBECONFIG"]).toBe("/nonexistent/kubeconfig");
    });

    it(`${tool} throws kubectl's exit code and stderr`, async () => {
      cli({ exitCode: 2, stderr: "forbidden" });
      await expect(tools.call(tool, args)).rejects.toThrow("kubectl exited 2: forbidden");
    });

    it(`${tool} refuses before running anything without KUBECONFIG`, async () => {
      const stub = cli({ stdout: "" });
      delete process.env["KUBECONFIG"];
      await expect(tools.call(tool, args)).rejects.toThrow("KUBECONFIG env must be set");
      expect(stub.calls).toEqual([]);
    });
  }

  it("targets the configured context", async () => {
    process.env["KUBE_CONTEXT"] = "staging";
    const stub = cli({ stdout: "" });
    await tools.call("k8s_pod_delete", { podName: "p" });
    expect(stub.calls[0]?.command).toEqual([
      "kubectl",
      "--context",
      "staging",
      "delete",
      "pod",
      "p",
      "-n",
      "default",
    ]);
  });
});

describe("kubernetes list tools", () => {
  it("k8s_pod_list asks kubectl for JSON and returns it", async () => {
    const stub = cli({ stdout: '{"items":[{"metadata":{"name":"p"}}]}' });
    expect(await tools.callJson("k8s_pod_list", { namespace: "kube-system" })).toEqual({
      items: [{ metadata: { name: "p" } }],
    });
    expect(stub.calls[0]?.command).toEqual([
      "kubectl",
      "get",
      "pods",
      "-n",
      "kube-system",
      "-o",
      "json",
    ]);
  });

  it("an empty answer is reported as an empty object", async () => {
    cli({ stdout: "" });
    expect(await tools.callJson("k8s_event_list", {})).toEqual({});
  });

  it("throws kubectl's exit code and stderr", async () => {
    cli({ exitCode: 1, stderr: "no route" });
    await expect(tools.call("k8s_deployment_list", {})).rejects.toThrow(
      "kubectl exited 1: no route",
    );
  });
});
