import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  approvedStandaloneWrite,
  type CapturedTools,
  captureTools,
  refusalSaying,
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

describe("k8s_pod_delete's audited pre-state (standalone mode)", () => {
  beforeEach(() => {
    resetConnectorModeForTests();
    setConnectorMode("standalone");
  });

  /** Delete `args`' pod as an approved write under `scope`; return what its audit recorded. */
  async function approvedDelete(scope: string, args: Record<string, unknown>) {
    cli({ stdout: "" });
    const run = await approvedStandaloneWrite(
      registerKubernetesTools,
      { NIMBUS_MCP_KUBERNETES_WRITE_SCOPE: scope },
      "k8s_pod_delete",
      args,
    );
    expect(run.answer).toEqual({ ok: true });
    return {
      preState: run.audit.find((e) => e.outcome === "executed")?.detail["preState"],
      chain: run.chain,
    };
  }

  it("records the namespace the pod was deleted from when it was given", async () => {
    const { preState } = await approvedDelete("namespace:shop", {
      namespace: "shop",
      podName: "web-1",
    });
    expect(preState).toEqual({ namespace: "shop", podName: "web-1" });
  });

  it("records the default namespace it actually used when none was given", async () => {
    // The delete ran in `default`; a pre-state without the namespace could not say where the pod
    // was, and (as `undefined`) used to break the audit chain's verification as well.
    const { preState, chain } = await approvedDelete("namespace:default", { podName: "web-1" });
    expect(spawn?.calls[0]?.command).toEqual([
      "kubectl",
      "delete",
      "pod",
      "web-1",
      "-n",
      "default",
    ]);
    expect(preState).toEqual({ namespace: "default", podName: "web-1" });
    // requested, accepted, executed — and the chain over them intact.
    expect(chain).toEqual({ ok: true, count: 3 });
  });
});

describe("kubernetes refuses an argument that is not a plain value, before kubectl runs", () => {
  // kubectl reads a positional that starts with "-" as a flag, so a pod named
  // --kubeconfig=<path> would point it at a kubeconfig whose exec credential plugin runs a command.
  // The namespace is the value of -n and so cannot be read that way; it is held to the same rule.
  const SMUGGLED = "--kubeconfig=/tmp/attacker-kubeconfig";
  const DASH = 'must not start with "-"';
  const CONTROL = "must not contain control characters";
  const CASES: readonly (readonly [string, Record<string, unknown>, string])[] = [
    ["k8s_rollout_restart", { resourceType: SMUGGLED, name: "api" }, DASH],
    ["k8s_rollout_restart", { resourceType: "deployment", name: SMUGGLED }, DASH],
    ["k8s_pod_delete", { podName: SMUGGLED }, DASH],
    ["k8s_deployment_scale", { deploymentName: SMUGGLED, replicas: 1 }, DASH],
    ["k8s_pod_delete", { namespace: SMUGGLED, podName: "api-1" }, DASH],
    ["k8s_pod_list", { namespace: SMUGGLED }, DASH],
    ["k8s_pod_delete", { podName: "api-1\napi-2" }, CONTROL],
  ];

  for (const [tool, args, refusal] of CASES) {
    it(`${tool} refuses ${JSON.stringify(args)}`, async () => {
      const stub = cli({ stdout: "" });
      await expect(tools.call(tool, args)).rejects.toThrow(refusalSaying(refusal));
      expect(stub.calls).toEqual([]);
    });
  }
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
