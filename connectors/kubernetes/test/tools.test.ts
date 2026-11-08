import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  approvedStandaloneWrite,
  type CapturedTools,
  captureStandaloneTools,
  captureTools,
  refusalSaying,
  type SpawnStub,
  stubSpawn,
  stubSpawnScript,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { registerKubernetesTools } from "../src/tools.ts";

let tools: CapturedTools;
let spawn: SpawnStub | undefined;
const saved = new Map<string, string | undefined>();
const KUBECONFIG_BODY = "apiVersion: v1\nkind: Config\n";
let kubeDir = "";
let kubeSource = "";

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
  kubeDir = mkdtempSync(join(tmpdir(), "k8s-test-"));
  kubeSource = join(kubeDir, "kubeconfig");
  writeFileSync(kubeSource, KUBECONFIG_BODY);
  process.env["KUBECONFIG"] = kubeSource;
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
  rmSync(kubeDir, { recursive: true, force: true });
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
      // A private copy, never the owner's own file.
      expect(stub.calls[0]?.env["KUBECONFIG"]).not.toBe(kubeSource);
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

describe("kubernetes runs every kubectl call on a private kubeconfig", () => {
  it("the child sees a copy with the source's content, removed afterwards; the source is untouched", async () => {
    let seenPath = "";
    let seenContent = "";
    spawn?.restore();
    spawn = stubSpawn({
      stdout: "{}",
      onSpawn: () => undefined,
    });
    const original = (Bun as { spawn: unknown }).spawn as (
      c: string[],
      o: { env: Record<string, string> },
    ) => unknown;
    (Bun as { spawn: unknown }).spawn = (c: string[], o: { env: Record<string, string> }) => {
      seenPath = o.env["KUBECONFIG"] ?? "";
      seenContent = readFileSync(seenPath, "utf8");
      writeFileSync(seenPath, "changed by the child");
      return original(c, o);
    };
    await tools.call("k8s_pod_list", {});
    expect(seenPath).not.toBe(kubeSource);
    expect(seenContent).toBe(KUBECONFIG_BODY);
    expect(existsSync(seenPath)).toBe(false);
    expect(readFileSync(kubeSource, "utf8")).toBe(KUBECONFIG_BODY);
  });

  it("removes the copy when kubectl fails", async () => {
    const stub = cli({ exitCode: 1, stderr: "boom" });
    await expect(tools.call("k8s_pod_list", {})).rejects.toThrow("boom");
    expect(existsSync(stub.calls[0]?.env["KUBECONFIG"] ?? kubeSource)).toBe(false);
  });

  it("refuses a KUBECONFIG that names a list, before anything runs", async () => {
    const stub = cli({ stdout: "" });
    process.env["KUBECONFIG"] = [kubeSource, kubeSource].join(
      process.platform === "win32" ? ";" : ":",
    );
    await expect(tools.call("k8s_pod_list", {})).rejects.toThrow(/more than one file/);
    expect(stub.calls).toEqual([]);
  });
});

describe("k8s_deployment_get", () => {
  const DEPLOYMENT = JSON.stringify({
    metadata: { name: "api", namespace: "prod", generation: 4 },
    spec: { replicas: 2, template: { spec: { containers: [{ image: "acme/api:1" }] } } },
    status: { readyReplicas: 2, observedGeneration: 4 },
  });

  it("runs kubectl get deployment through kubectlBase() and projects the reply", async () => {
    process.env["KUBE_CONTEXT"] = "staging";
    const stub = cli({ stdout: DEPLOYMENT });
    expect(await tools.callJson("k8s_deployment_get", { namespace: "prod", name: "api" })).toEqual({
      name: "api",
      namespace: "prod",
      replicas: 2,
      readyReplicas: 2,
      generation: 4,
      observedGeneration: 4,
      images: ["acme/api:1"],
    });
    expect(stub.calls.map((c) => c.command)).toEqual([
      ["kubectl", "--context", "staging", "get", "deployment", "api", "-n", "prod", "-o", "json"],
    ]);
  });

  it("defaults the namespace to default", async () => {
    const stub = cli({ stdout: DEPLOYMENT });
    await tools.call("k8s_deployment_get", { name: "api" });
    expect(stub.calls[0]?.command).toContain("default");
  });

  it("reports a missing deployment as not found, and any other failure as itself", async () => {
    cli({ exitCode: 1, stderr: 'Error from server (NotFound): deployments.apps "x" not found' });
    await expect(tools.call("k8s_deployment_get", { name: "x" })).rejects.toThrow(
      "deployment not found",
    );
    cli({ exitCode: 1, stderr: "forbidden" });
    await expect(tools.call("k8s_deployment_get", { name: "x" })).rejects.toThrow("forbidden");
  });

  it("refuses a name that kubectl would read as a flag, and a missing KUBECONFIG, before running", async () => {
    const stub = cli({ stdout: DEPLOYMENT });
    await expect(tools.call("k8s_deployment_get", { name: "--kubeconfig=/tmp/x" })).rejects.toThrow(
      refusalSaying('must not start with "-"'),
    );
    delete process.env["KUBECONFIG"];
    await expect(tools.call("k8s_deployment_get", { name: "api" })).rejects.toThrow(
      "KUBECONFIG env must be set",
    );
    expect(stub.calls).toEqual([]);
  });
});

describe("k8s_manifest_plan and k8s_manifest_apply", () => {
  const MANIFEST = "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\n";
  const SHA = createHash("sha256").update(MANIFEST, "utf8").digest("hex");
  const savedEnv = new Map<string, string | undefined>();
  let scratchBase = "";

  /** What the fake kubectl saw of each call, read at spawn time (the tool removes the files after). */
  interface Seen {
    command: readonly string[];
    env: Record<string, string | undefined>;
    manifest: string | undefined;
    mode: number | undefined;
    file: string | undefined;
  }
  let seen: Seen[] = [];

  /** A fake kubectl: `apply` prints object names, `diff` exits with `diffCode`. */
  function kubectl(
    opts: {
      diffCode?: number;
      diffOut?: string;
      applyCode?: number;
      applyOut?: string;
      applyErr?: string;
    } = {},
  ): SpawnStub {
    seen = [];
    spawn?.restore();
    spawn = stubSpawnScript((command, env) => {
      const at = command.indexOf("-f");
      const file = at === -1 ? undefined : command[at + 1];
      seen.push({
        command: [...command],
        env,
        file,
        manifest: file === undefined ? undefined : readFileSync(file, "utf8"),
        mode: file === undefined ? undefined : statSync(file).mode & 0o777,
      });
      if (command.includes("diff")) {
        return { exitCode: opts.diffCode ?? 0, stdout: opts.diffOut ?? "", stderr: "diff err" };
      }
      return {
        exitCode: opts.applyCode ?? 0,
        stdout: opts.applyOut ?? "deployment.apps/api\n",
        stderr: opts.applyErr ?? "",
      };
    });
    return spawn;
  }

  beforeEach(() => {
    for (const key of ["NIMBUS_CONNECTOR_SCRATCH_DIR", "KUBECTL_EXTERNAL_DIFF"]) {
      savedEnv.set(key, process.env[key]);
    }
    scratchBase = mkdtempSync(join(tmpdir(), "k8s-scratch-"));
    process.env["NIMBUS_CONNECTOR_SCRATCH_DIR"] = scratchBase;
    process.env["KUBECTL_EXTERNAL_DIFF"] = "/owner/evil-diff";
  });

  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(scratchBase, { recursive: true, force: true });
  });

  const PLAN_ARGS = { namespace: "shop", manifest: MANIFEST };
  const APPLY_ARGS = { ...PLAN_ARGS, manifestSha256: SHA };

  describe("plan", () => {
    it("runs the server-side dry run, then the server-side diff, with exact argv", async () => {
      process.env["KUBE_CONTEXT"] = "staging";
      const stub = kubectl({ diffCode: 1, diffOut: "--- a\n+++ b\n" });
      const out = (await tools.callJson("k8s_manifest_plan", PLAN_ARGS)) as Record<string, unknown>;
      const file = seen[0]?.file ?? "";
      expect(stub.calls.map((c) => c.command)).toEqual([
        [
          "kubectl",
          "--context",
          "staging",
          "apply",
          "--server-side",
          "--dry-run=server",
          "--field-manager=nimbus",
          "-n",
          "shop",
          "-f",
          file,
          "-o",
          "name",
        ],
        [
          "kubectl",
          "--context",
          "staging",
          "diff",
          "--server-side",
          "--field-manager=nimbus",
          "-n",
          "shop",
          "-f",
          file,
        ],
      ]);
      expect(out).toEqual({
        manifestSha256: SHA,
        namespace: "shop",
        objects: ["deployment.apps/api"],
        scanned: [{ apiVersion: "apps/v1", kind: "Deployment", name: "api" }],
        diff: "--- a\n+++ b\n",
        hasDifferences: true,
      });
    });

    it("never passes --force-conflicts", async () => {
      const stub = kubectl();
      await tools.call("k8s_manifest_plan", PLAN_ARGS);
      await tools.call("k8s_manifest_apply", APPLY_ARGS);
      for (const c of stub.calls) expect(c.command).not.toContain("--force-conflicts");
    });

    it("hands kubectl the exact bytes, in an owner-only file inside the scratch base, removed afterwards", async () => {
      kubectl();
      await tools.call("k8s_manifest_plan", PLAN_ARGS);
      for (const s of seen) {
        expect(s.manifest).toBe(MANIFEST);
        expect(dirname(dirname(s.file ?? ""))).toBe(scratchBase);
        if (process.platform !== "win32") expect(s.mode).toBe(0o600);
        expect(existsSync(s.file ?? "")).toBe(false);
        expect(existsSync(dirname(s.file ?? ""))).toBe(false);
      }
      // A private kubeconfig, never the owner's file.
      expect(seen[0]?.env["KUBECONFIG"]).not.toBe(kubeSource);
    });

    it("maps the diff's exit code: 0 no differences, 1 differences, anything else a failure", async () => {
      kubectl({ diffCode: 0 });
      expect(await tools.callJson("k8s_manifest_plan", PLAN_ARGS)).toMatchObject({
        hasDifferences: false,
      });
      kubectl({ diffCode: 1, diffOut: "d" });
      expect(await tools.callJson("k8s_manifest_plan", PLAN_ARGS)).toMatchObject({
        hasDifferences: true,
      });
      kubectl({ diffCode: 2 });
      await expect(tools.call("k8s_manifest_plan", PLAN_ARGS)).rejects.toThrow(
        "kubectl diff exited 2: diff err",
      );
    });

    it("the diff child has no KUBECTL_EXTERNAL_DIFF and a private temp directory", async () => {
      kubectl({ diffCode: 1 });
      await tools.call("k8s_manifest_plan", PLAN_ARGS);
      const diffCall = seen.find((s) => s.command.includes("diff"));
      const dir = dirname(diffCall?.file ?? "");
      expect(diffCall?.env["KUBECTL_EXTERNAL_DIFF"]).toBeUndefined();
      expect(diffCall?.env["TMPDIR"]).toBe(dir);
      expect(diffCall?.env["TMP"]).toBe(dir);
      expect(diffCall?.env["TEMP"]).toBe(dir);
    });

    it("a failing dry run throws kubectl's exit code and stderr, and the diff never runs", async () => {
      const stub = kubectl({ applyCode: 1, applyErr: "admission webhook denied" });
      await expect(tools.call("k8s_manifest_plan", PLAN_ARGS)).rejects.toThrow(
        "kubectl exited 1: admission webhook denied",
      );
      expect(stub.calls).toHaveLength(1);
    });

    it("refuses a diff over 64 KiB", async () => {
      kubectl({ diffCode: 1, diffOut: "x".repeat(65_537) });
      await expect(tools.call("k8s_manifest_plan", PLAN_ARGS)).rejects.toThrow("diff too large");
      kubectl({ diffCode: 1, diffOut: "x".repeat(65_536) });
      expect(await tools.callJson("k8s_manifest_plan", PLAN_ARGS)).toMatchObject({
        hasDifferences: true,
      });
    });

    it("refuses a reply over 256 KiB", async () => {
      kubectl({ diffCode: 1, diffOut: "d", applyOut: "deployment.apps/a\n".repeat(16_000) });
      await expect(tools.call("k8s_manifest_plan", PLAN_ARGS)).rejects.toThrow(
        "plan reply too large",
      );
    });

    it("refuses a manifest over 256 KiB of UTF-8 bytes before any spawn", async () => {
      const stub = kubectl();
      // 140,000 two-byte characters: under the schema's character cap, over the byte cap.
      const manifest = `# ${"é".repeat(140_000)}\n${MANIFEST}`;
      await expect(
        tools.call("k8s_manifest_plan", { namespace: "shop", manifest }),
      ).rejects.toThrow("manifest is larger than 262144 bytes");
      await expect(
        tools.call("k8s_manifest_plan", { namespace: "shop", manifest: `#${"x".repeat(262_200)}` }),
      ).rejects.toThrow();
      expect(stub.calls).toEqual([]);
    });

    it("refuses a manifest the scanner refuses, before any spawn", async () => {
      const stub = kubectl();
      const cases = [
        "apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: x\n",
        MANIFEST.replace("name: api", "name: api\n  namespace: other"),
        `${MANIFEST}---\nkind: Namespace\napiVersion: v1\nmetadata:\n  name: x\n`,
        '{"apiVersion":"v1","kind":"Pod","metadata":{"name":"p"}}',
        'apiVersion: apps/v1\n"kind": ClusterRole\nmetadata:\n  name: x\n',
      ];
      for (const manifest of cases) {
        await expect(
          tools.call("k8s_manifest_plan", { namespace: "shop", manifest }),
        ).rejects.toThrow(/manifest refused/);
      }
      expect(stub.calls).toEqual([]);
    });

    it("refuses a namespace kubectl would read as a flag, before any spawn", async () => {
      const stub = kubectl();
      await expect(
        tools.call("k8s_manifest_plan", { namespace: "--kubeconfig=/x", manifest: MANIFEST }),
      ).rejects.toThrow(refusalSaying('must not start with "-"'));
      expect(stub.calls).toEqual([]);
    });

    it("on Windows under the gateway, refuses without a scratch directory, before any spawn", async () => {
      if (process.platform !== "win32") return;
      delete process.env["NIMBUS_CONNECTOR_SCRATCH_DIR"];
      const stub = kubectl();
      await expect(tools.call("k8s_manifest_plan", PLAN_ARGS)).rejects.toThrow(
        "NIMBUS_CONNECTOR_SCRATCH_DIR is not set",
      );
      expect(stub.calls).toEqual([]);
    });
  });

  describe("apply", () => {
    it("runs exactly one server-side apply of the approved manifest and reports the objects", async () => {
      process.env["KUBE_CONTEXT"] = "staging";
      const stub = kubectl({ applyOut: "deployment.apps/api\nservice/api\n" });
      expect(await tools.callJson("k8s_manifest_apply", APPLY_ARGS)).toEqual({
        ok: true,
        status: "applied",
        objects: ["deployment.apps/api", "service/api"],
      });
      const file = seen[0]?.file ?? "";
      expect(stub.calls.map((c) => c.command)).toEqual([
        [
          "kubectl",
          "--context",
          "staging",
          "apply",
          "--server-side",
          "--field-manager=nimbus",
          "-n",
          "shop",
          "-f",
          file,
          "-o",
          "name",
        ],
      ]);
      expect(seen[0]?.manifest).toBe(MANIFEST);
      expect(existsSync(file)).toBe(false);
      expect(stub.calls[0]?.env["KUBECONFIG"]).not.toBe(kubeSource);
    });

    it("throws kubectl's exit code and stderr", async () => {
      kubectl({ applyCode: 1, applyErr: "conflict" });
      await expect(tools.call("k8s_manifest_apply", APPLY_ARGS)).rejects.toThrow(
        "kubectl exited 1: conflict",
      );
    });

    it("a manifest that does not hash to the approved value spawns nothing", async () => {
      const stub = kubectl();
      const edited = MANIFEST.replace("name: api", "name: api2");
      await expect(
        tools.call("k8s_manifest_apply", { ...APPLY_ARGS, manifest: edited }),
      ).rejects.toThrow("manifest does not match the approved hash");
      await expect(
        tools.call("k8s_manifest_apply", { ...APPLY_ARGS, manifestSha256: "0".repeat(64) }),
      ).rejects.toThrow("manifest does not match the approved hash");
      // The hash is of the bytes: a different line ending is a different manifest.
      await expect(
        tools.call("k8s_manifest_apply", {
          ...APPLY_ARGS,
          manifest: MANIFEST.replaceAll("\n", "\r\n"),
        }),
      ).rejects.toThrow("manifest does not match the approved hash");
      expect(stub.calls).toEqual([]);
    });

    it("refuses a hash that is not 64 lowercase hex, before any spawn", async () => {
      const stub = kubectl();
      for (const manifestSha256 of [SHA.toUpperCase(), SHA.slice(1), `${SHA}0`, "", "zz"]) {
        await expect(
          tools.call("k8s_manifest_apply", { ...APPLY_ARGS, manifestSha256 }),
        ).rejects.toThrow();
      }
      expect(stub.calls).toEqual([]);
    });

    it("spawns nothing for a manifest the scanner refuses, even with a matching hash", async () => {
      const stub = kubectl();
      const bad = "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: x\n";
      const sha = createHash("sha256").update(bad).digest("hex");
      await expect(
        tools.call("k8s_manifest_apply", { namespace: "shop", manifest: bad, manifestSha256: sha }),
      ).rejects.toThrow(/not on the namespaced allowlist/);
      expect(stub.calls).toEqual([]);
    });

    it("refuses an oversize manifest before any spawn", async () => {
      const stub = kubectl();
      const manifest = `# ${"é".repeat(140_000)}\n${MANIFEST}`;
      await expect(
        tools.call("k8s_manifest_apply", { namespace: "shop", manifest, manifestSha256: SHA }),
      ).rejects.toThrow("manifest is larger than 262144 bytes");
      expect(stub.calls).toEqual([]);
    });
  });

  describe("standalone mode", () => {
    beforeEach(() => {
      resetConnectorModeForTests();
      setConnectorMode("standalone");
    });

    it("refuseBefore stops a refused manifest before the prompt, and the audit says refused", async () => {
      const stub = kubectl();
      const auditDir = mkdtempSync(join(tmpdir(), "k8s-audit-"));
      const auditLog = join(auditDir, "audit.jsonl");
      try {
        await withEnv(
          { NIMBUS_MCP_KUBERNETES_WRITE_SCOPE: "namespace:shop", NIMBUS_MCP_AUDIT_LOG: auditLog },
          async () => {
            const cap = captureStandaloneTools(registerKubernetesTools, { elicitation: true });
            const bad = "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: x\n";
            const sha = createHash("sha256").update(bad).digest("hex");
            const res = (await cap.tools.callJson("k8s_manifest_apply", {
              namespace: "shop",
              manifest: bad,
              manifestSha256: sha,
            })) as { ok: boolean; error: string };
            expect(res.ok).toBe(false);
            expect(res.error).toMatch(/not on the namespaced allowlist/);
            const wrong = (await cap.tools.callJson("k8s_manifest_apply", {
              ...APPLY_ARGS,
              manifestSha256: "0".repeat(64),
            })) as { ok: boolean; error: string };
            expect(wrong.error).toBe("manifest does not match the approved hash");
            expect(cap.prompts).toEqual([]);
          },
        );
        expect(readFileSync(auditLog, "utf8")).toContain("refused");
      } finally {
        rmSync(auditDir, { recursive: true, force: true });
      }
      expect(stub.calls).toEqual([]);
    });

    it("an approved apply records the namespace, hash and scanned objects as its pre-state", async () => {
      kubectl();
      const run = await approvedStandaloneWrite(
        registerKubernetesTools,
        { NIMBUS_MCP_KUBERNETES_WRITE_SCOPE: "namespace:shop" },
        "k8s_manifest_apply",
        APPLY_ARGS,
      );
      expect(run.answer).toMatchObject({ ok: true, status: "applied" });
      expect(run.audit.find((e) => e.outcome === "executed")?.detail["preState"]).toEqual({
        namespace: "shop",
        manifestSha256: SHA,
        objects: [{ apiVersion: "apps/v1", kind: "Deployment", name: "api" }],
      });
    });

    it("an apply out of scope is refused without a prompt or a spawn", async () => {
      const stub = kubectl();
      await withEnv({ NIMBUS_MCP_KUBERNETES_WRITE_SCOPE: "namespace:other" }, async () => {
        const cap = captureStandaloneTools(registerKubernetesTools, { elicitation: true });
        const res = (await cap.tools.callJson("k8s_manifest_apply", APPLY_ARGS)) as {
          ok: boolean;
          error: string;
        };
        expect(res.error).toContain("out of scope: namespace:shop");
        expect(cap.prompts).toEqual([]);
      });
      expect(stub.calls).toEqual([]);
    });

    it("plan out of scope is refused; in scope it runs and is audited as prepared", async () => {
      const stub = kubectl();
      const auditDir = mkdtempSync(join(tmpdir(), "k8s-audit-"));
      const auditLog = join(auditDir, "audit.jsonl");
      try {
        await withEnv({ NIMBUS_MCP_KUBERNETES_WRITE_SCOPE: "namespace:other" }, async () => {
          const cap = captureStandaloneTools(registerKubernetesTools, { elicitation: false });
          expect(cap.tools.names()).toContain("k8s_manifest_plan");
          const res = (await cap.tools.callJson("k8s_manifest_plan", PLAN_ARGS)) as {
            ok: boolean;
            error: string;
          };
          expect(res.ok).toBe(false);
          expect(res.error).toContain("out of scope: namespace:shop");
        });
        expect(stub.calls).toEqual([]);
        await withEnv(
          { NIMBUS_MCP_KUBERNETES_WRITE_SCOPE: "namespace:shop", NIMBUS_MCP_AUDIT_LOG: auditLog },
          async () => {
            const cap = captureStandaloneTools(registerKubernetesTools, { elicitation: false });
            const res = (await cap.tools.callJson("k8s_manifest_plan", PLAN_ARGS)) as {
              manifestSha256: string;
            };
            expect(res.manifestSha256).toBe(SHA);
          },
        );
        expect(readFileSync(auditLog, "utf8")).toContain("prepared");
      } finally {
        rmSync(auditDir, { recursive: true, force: true });
      }
    });
  });
});
