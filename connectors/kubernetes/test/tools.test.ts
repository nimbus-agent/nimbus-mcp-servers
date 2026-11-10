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
import { diffSha256 } from "../src/manifest-diff.ts";
import { planHash, registerKubernetesTools, SECRET_DIFF_WITHHELD } from "../src/tools.ts";

const CTX = "prod-east";
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
  process.env["KUBE_CONTEXT"] = CTX;
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
    args: { context: CTX, namespace: "default", resourceType: "deployment", name: "api" },
    argv: ["kubectl", "--context", CTX, "rollout", "restart", "deployment", "api", "-n", "default"],
  },
  {
    tool: "k8s_pod_delete",
    args: { context: CTX, namespace: "prod", podName: "api-1" },
    argv: ["kubectl", "--context", CTX, "delete", "pod", "api-1", "-n", "prod"],
  },
  {
    tool: "k8s_deployment_scale",
    args: { context: CTX, namespace: "prod", deploymentName: "api", replicas: 0 },
    argv: ["kubectl", "--context", CTX, "scale", "deployment", "api", "-n", "prod", "--replicas=0"],
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

  for (const { tool, args } of WRITES) {
    it(`${tool} requires context and namespace`, async () => {
      const stub = cli({ stdout: "" });
      for (const missing of ["context", "namespace"]) {
        const partial = { ...args };
        delete partial[missing];
        await expect(tools.call(tool, partial)).rejects.toThrow();
      }
      expect(stub.calls).toEqual([]);
    });

    it(`${tool} refuses a context that is not the configured one, before kubectl runs`, async () => {
      const stub = cli({ stdout: "" });
      await expect(tools.call(tool, { ...args, context: "staging" })).rejects.toThrow(
        "context does not match the configured context",
      );
      expect(stub.calls).toEqual([]);
    });
  }
});

describe("the effective context", () => {
  const ARGS = { context: "from-kubeconfig", namespace: "prod", podName: "p" };

  it("is kubectl config current-context when KUBE_CONTEXT is unset, and is then passed as --context", async () => {
    delete process.env["KUBE_CONTEXT"];
    spawn?.restore();
    spawn = stubSpawnScript((command) =>
      command.includes("current-context") ? { stdout: "from-kubeconfig\n" } : { stdout: "" },
    );
    await tools.call("k8s_pod_delete", ARGS);
    expect(spawn.calls.map((c) => c.command)).toEqual([
      ["kubectl", "config", "current-context"],
      ["kubectl", "--context", "from-kubeconfig", "delete", "pod", "p", "-n", "prod"],
    ]);
  });

  it("a given context must equal it, else nothing is deleted", async () => {
    delete process.env["KUBE_CONTEXT"];
    spawn?.restore();
    spawn = stubSpawnScript(() => ({ stdout: "from-kubeconfig\n" }));
    await expect(tools.call("k8s_pod_delete", { ...ARGS, context: "other" })).rejects.toThrow(
      "context does not match the configured context",
    );
    expect(spawn.calls).toHaveLength(1);
  });

  it("fails closed when kubectl cannot say, or says nothing, or says something odd", async () => {
    delete process.env["KUBE_CONTEXT"];
    for (const reply of [
      { exitCode: 1, stderr: "no config" },
      { stdout: "  \n" },
      { stdout: "--kubeconfig=/x\n" },
      { stdout: "a\nb\n" },
    ]) {
      const stub = cli(reply);
      await expect(tools.call("k8s_pod_delete", ARGS)).rejects.toThrow();
      expect(stub.calls).toHaveLength(1);
    }
  });

  it("KUBE_CONTEXT wins and costs no extra kubectl call", async () => {
    const stub = cli({ stdout: "" });
    await tools.call("k8s_pod_delete", { ...ARGS, context: CTX });
    expect(stub.calls).toHaveLength(1);
  });

  it("applies to the reads too, where a given context is optional", async () => {
    const stub = cli({ stdout: "{}" });
    await tools.call("k8s_pod_list", {});
    await tools.call("k8s_pod_list", { context: CTX });
    await expect(tools.call("k8s_pod_list", { context: "x" })).rejects.toThrow(
      "context does not match the configured context",
    );
    expect(stub.calls.map((c) => c.command.slice(0, 3))).toEqual([
      ["kubectl", "--context", CTX],
      ["kubectl", "--context", CTX],
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

  it("records the context and namespace the pod was deleted from", async () => {
    const { preState, chain } = await approvedDelete("namespace:shop", {
      context: CTX,
      namespace: "shop",
      podName: "web-1",
    });
    expect(spawn?.calls[0]?.command).toEqual([
      "kubectl",
      "--context",
      CTX,
      "delete",
      "pod",
      "web-1",
      "-n",
      "shop",
    ]);
    expect(preState).toEqual({ context: CTX, namespace: "shop", podName: "web-1" });
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
  const BASE = { context: CTX, namespace: "default" };
  const CASES: readonly (readonly [string, Record<string, unknown>, string])[] = [
    ["k8s_rollout_restart", { ...BASE, resourceType: SMUGGLED, name: "api" }, DASH],
    ["k8s_rollout_restart", { ...BASE, resourceType: "deployment", name: SMUGGLED }, DASH],
    ["k8s_pod_delete", { ...BASE, podName: SMUGGLED }, DASH],
    ["k8s_deployment_scale", { ...BASE, deploymentName: SMUGGLED, replicas: 1 }, DASH],
    ["k8s_pod_delete", { context: CTX, namespace: SMUGGLED, podName: "api-1" }, DASH],
    ["k8s_pod_delete", { context: SMUGGLED, namespace: "default", podName: "api-1" }, DASH],
    ["k8s_pod_list", { namespace: SMUGGLED }, DASH],
    ["k8s_pod_list", { context: SMUGGLED }, DASH],
    ["k8s_pod_delete", { ...BASE, podName: "api-1\napi-2" }, CONTROL],
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
      "--context",
      CTX,
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
    expect(
      await tools.callJson("k8s_deployment_get", {
        context: "staging",
        namespace: "prod",
        name: "api",
      }),
    ).toEqual({
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
  const SHA = planHash(CTX, "shop", MANIFEST);
  /** Pinned: sha256("nimbus-k8s-manifest-v2\nprod-east\nshop\n" + MANIFEST). Copy this into other repos. */
  const SHA_VECTOR = "6e9e27651017001b79ee38c8cd239330eff826603900a77d0732a577788dfb75";
  const savedEnv = new Map<string, string | undefined>();
  let scratchBase = "";

  const dep = (replicas: number, name = "api", server: Record<string, unknown> = {}) => ({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace: "shop", ...server },
    spec: { replicas },
  });
  const svc = (name = "api", port = 80) => ({
    apiVersion: "v1",
    kind: "Service",
    metadata: { name, namespace: "shop" },
    spec: { ports: [port] },
  });
  /** What a live object carries on top of the planned one: fields the server owns. */
  const SERVER_FIELDS = {
    uid: "11111111",
    resourceVersion: "42",
    generation: 7,
    creationTimestamp: "2026-01-01T00:00:00Z",
    managedFields: [{ manager: "kubectl" }],
    annotations: { "kubectl.kubernetes.io/last-applied-configuration": "{}" },
  };

  /** The diff of replicas 2 -> 3 on deployment.apps/api, and its hash (pinned). */
  const UPDATE_DIFF = [
    "--- live deployment.apps/api",
    "+++ planned deployment.apps/api",
    "@@ -6,6 +6,6 @@",
    '     "namespace": "shop"',
    "   },",
    '   "spec": {',
    '-    "replicas": 2',
    '+    "replicas": 3',
    "   }",
    " }",
    "",
  ].join("\n");
  const UPDATE_DIFF_SHA = "da0d15f71a68700492498729ea2537aeeaeb78cbc141504b9d3c54750846e8e4";

  /** What the fake kubectl saw of each call, read at spawn time (the tool removes the files after). */
  interface Seen {
    command: readonly string[];
    env: Record<string, string | undefined>;
    manifest: string | undefined;
    mode: number | undefined;
    file: string | undefined;
  }
  let seen: Seen[] = [];

  /** The cluster the fake kubectl answers for; a test changes it between calls to move the cluster. */
  const world = {
    planned: dep(3) as unknown,
    live: dep(2, "api", SERVER_FIELDS) as unknown,
    dryCode: 0,
    dryErr: "",
    dryRaw: undefined as string | undefined,
    getCode: 0,
    getRaw: undefined as string | undefined,
    applyCode: 0,
    applyOut: "deployment.apps/api\n",
    applyErr: "",
    current: "prod-east",
  };
  const resetWorld = () => {
    world.planned = dep(3);
    world.live = dep(2, "api", SERVER_FIELDS);
    world.dryCode = 0;
    world.dryErr = "";
    world.dryRaw = undefined;
    world.getCode = 0;
    world.getRaw = undefined;
    world.applyCode = 0;
    world.applyOut = "deployment.apps/api\n";
    world.applyErr = "";
  };
  const json = (v: unknown) => (v === undefined ? "" : JSON.stringify(v));

  /** A fake kubectl over {@link world}. */
  function kubectl(): SpawnStub {
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
      if (command.includes("current-context")) return { stdout: `${world.current}\n` };
      if (command.includes("apply") && command.includes("--dry-run=server")) {
        return {
          exitCode: world.dryCode,
          stdout: world.dryRaw ?? json(world.planned),
          stderr: world.dryErr,
        };
      }
      if (command.includes("apply")) {
        return { exitCode: world.applyCode, stdout: world.applyOut, stderr: world.applyErr };
      }
      return {
        exitCode: world.getCode,
        stdout: world.getRaw ?? json(world.live),
        stderr: "get err",
      };
    });
    return spawn;
  }

  beforeEach(() => {
    resetWorld();
    for (const key of ["NIMBUS_CONNECTOR_SCRATCH_DIR", "KUBECTL_EXTERNAL_DIFF"]) {
      savedEnv.set(key, process.env[key]);
    }
    scratchBase = mkdtempSync(join(tmpdir(), "k8s-scratch-"));
    process.env["NIMBUS_CONNECTOR_SCRATCH_DIR"] = scratchBase;
  });

  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(scratchBase, { recursive: true, force: true });
  });

  const PLAN_ARGS = { context: CTX, namespace: "shop", manifest: MANIFEST };
  const APPLY_ARGS = { ...PLAN_ARGS, planSha256: SHA, diffSha256: UPDATE_DIFF_SHA };

  const plan = (args: Record<string, unknown> = PLAN_ARGS) =>
    tools.callJson("k8s_manifest_plan", args) as Promise<Record<string, unknown>>;

  describe("the hashes", () => {
    it("plan hash v2 is pinned: sha256 of the domain, context, namespace and manifest", () => {
      expect(SHA).toBe(SHA_VECTOR);
      expect(
        createHash("sha256")
          .update(`nimbus-k8s-manifest-v2\n${CTX}\nshop\n${MANIFEST}`, "utf8")
          .digest("hex"),
      ).toBe(SHA_VECTOR);
    });

    it("binds the context and the namespace: change either and the hash changes", () => {
      expect(planHash("other", "shop", MANIFEST)).not.toBe(SHA);
      expect(planHash(CTX, "shop2", MANIFEST)).not.toBe(SHA);
      // v1 had no context; it is retired and no longer equals anything the tool produces.
      const v1 = createHash("sha256")
        .update(`nimbus-k8s-manifest-v1\nshop\n${MANIFEST}`, "utf8")
        .digest("hex");
      expect(v1).not.toBe(SHA);
    });

    it("the diff hash is pinned: sha256 of nimbus-k8s-diff-v1, a newline and the diff", () => {
      expect(diffSha256(UPDATE_DIFF)).toBe(UPDATE_DIFF_SHA);
      expect(
        createHash("sha256").update(`nimbus-k8s-diff-v1\n${UPDATE_DIFF}`, "utf8").digest("hex"),
      ).toBe(UPDATE_DIFF_SHA);
    });
  });

  describe("plan", () => {
    it("runs the server-side dry run (-o json), then one get of the live objects, with exact argv, and no diff program", async () => {
      const stub = kubectl();
      await plan();
      const file = seen[0]?.file ?? "";
      expect(stub.calls.map((c) => c.command)).toEqual([
        [
          "kubectl",
          "--context",
          CTX,
          "apply",
          "--server-side",
          "--dry-run=server",
          "--field-manager=nimbus",
          "-n",
          "shop",
          "-f",
          file,
          "-o",
          "json",
        ],
        [
          "kubectl",
          "--context",
          CTX,
          "get",
          "deployment.apps/api",
          "-n",
          "shop",
          "-o",
          "json",
          "--ignore-not-found",
        ],
      ]);
      for (const c of stub.calls) {
        expect(c.command).not.toContain("diff");
        expect(c.command).not.toContain("--force-conflicts");
      }
    });

    it("an update: the diff text, its hash and the reply, with the server-owned fields ignored", async () => {
      kubectl();
      expect(await plan()).toEqual({
        planSha256: SHA,
        diffSha256: UPDATE_DIFF_SHA,
        namespace: "shop",
        objects: ["deployment.apps/api"],
        scanned: [{ apiVersion: "apps/v1", kind: "Deployment", name: "api" }],
        diff: UPDATE_DIFF,
        hasDifferences: true,
      });
    });

    it("a create (nothing live, no output from get): the live side is the absent marker", async () => {
      world.live = undefined;
      kubectl();
      const out = await plan();
      expect(out["hasDifferences"]).toBe(true);
      expect(out["diff"]).toContain("-(absent: will be created)\n+{\n");
      expect(
        String(out["diff"]).startsWith(
          "--- live deployment.apps/api\n+++ planned deployment.apps/api\n",
        ),
      ).toBe(true);
    });

    it("no change: planned and live differ only in server-owned fields, so the diff is empty", async () => {
      world.planned = dep(2);
      kubectl();
      const out = await plan();
      expect(out["diff"]).toBe("");
      expect(out["hasDifferences"]).toBe(false);
      expect(out["diffSha256"]).toBe(diffSha256(""));
    });

    it("a field the server defaults, present on both sides, is not a difference", async () => {
      const defaulted = { strategy: { type: "RollingUpdate" }, revisionHistoryLimit: 10 };
      world.planned = { ...dep(2), spec: { replicas: 2, ...defaulted } };
      world.live = { ...dep(2, "api", SERVER_FIELDS), spec: { replicas: 2, ...defaulted } };
      kubectl();
      expect((await plan())["hasDifferences"]).toBe(false);
    });

    it("several objects: one get naming all in code-unit order, a diff per changed object, in that order", async () => {
      const manifest = `${MANIFEST}---\napiVersion: v1\nkind: Service\nmetadata:\n  name: api\n`;
      world.planned = { kind: "List", items: [svc("api", 81), dep(3)] };
      world.live = { kind: "List", items: [dep(2, "api", SERVER_FIELDS), svc("api", 80)] };
      world.applyOut = "service/api\ndeployment.apps/api\n";
      const stub = kubectl();
      const out = await plan({ ...PLAN_ARGS, manifest });
      expect(stub.calls[1]?.command.slice(4, 6)).toEqual(["deployment.apps/api", "service/api"]);
      expect(out["objects"]).toEqual(["service/api", "deployment.apps/api"]);
      const heads = String(out["diff"])
        .split("\n")
        .filter((l) => l.startsWith("--- "));
      expect(heads).toEqual(["--- live deployment.apps/api", "--- live service/api"]);
    });

    it("hands kubectl the exact bytes, in an owner-only file inside the scratch base, removed afterwards", async () => {
      kubectl();
      await plan();
      const withFile = seen.filter((s) => s.file !== undefined);
      expect(withFile.length).toBeGreaterThan(0);
      for (const s of withFile) {
        expect(s.manifest).toBe(MANIFEST);
        expect(dirname(dirname(s.file ?? ""))).toBe(scratchBase);
        if (process.platform !== "win32") expect(s.mode).toBe(0o600);
        expect(existsSync(s.file ?? "")).toBe(false);
        expect(existsSync(dirname(s.file ?? ""))).toBe(false);
      }
      expect(seen[0]?.env["KUBECONFIG"]).not.toBe(kubeSource);
    });

    it("a failing dry run throws kubectl's exit code and stderr, and the get never runs", async () => {
      world.dryCode = 1;
      world.dryErr = "admission webhook denied";
      const stub = kubectl();
      await expect(plan()).rejects.toThrow("kubectl exited 1: admission webhook denied");
      expect(stub.calls).toHaveLength(1);
    });

    it("a failing get throws its exit code", async () => {
      world.getCode = 3;
      kubectl();
      await expect(plan()).rejects.toThrow("kubectl get exited 3: get err");
    });

    it("refuses JSON it cannot read, without echoing it", async () => {
      world.dryRaw = "not json {secret}";
      kubectl();
      const err = await plan().catch((e: unknown) => String(e));
      expect(err).toContain("kubectl dry run returned invalid JSON");
      expect(err).not.toContain("secret");
      world.dryRaw = undefined;
      world.getRaw = "[1,";
      kubectl();
      await expect(plan()).rejects.toThrow("kubectl get returned invalid JSON");
    });

    it("refuses a live reply it cannot key (a kind off the allowlist)", async () => {
      world.live = { kind: "Namespace", metadata: { name: "x" } };
      kubectl();
      await expect(plan()).rejects.toThrow(/not on the allowlist/);
    });

    it("refuses a diff over 64 KiB, and accepts one well under", async () => {
      world.planned = { ...dep(3), data: { blob: "x".repeat(70_000) } };
      kubectl();
      await expect(plan()).rejects.toThrow("diff too large");
      world.planned = { ...dep(3), data: { blob: "x".repeat(1_000) } };
      kubectl();
      expect((await plan())["hasDifferences"]).toBe(true);
    });

    it("refuses a reply over 256 KiB", async () => {
      // About 4,300 small ConfigMaps fit in the 256 KiB manifest cap; the scan summary plus the
      // names for them are bigger than the reply cap. They are already live, so the diff stays small.
      const count = 4_300;
      const manifest = Array.from(
        { length: count },
        (_, i) => `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c${String(i)}\n`,
      ).join("---\n");
      expect(Buffer.byteLength(manifest)).toBeLessThan(262_144);
      const items = Array.from({ length: count }, (_, i) => ({
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name: `c${String(i)}` },
      }));
      world.planned = { kind: "List", items };
      world.live = { kind: "List", items };
      kubectl();
      await expect(plan({ ...PLAN_ARGS, manifest })).rejects.toThrow("plan reply too large");
    });

    it("refuses before the get when the dry run names other objects than the scan read", async () => {
      world.planned = { kind: "ClusterRole", metadata: { name: "evil" } };
      const stub = kubectl();
      await expect(plan()).rejects.toThrow(/not on the allowlist/);
      world.planned = { kind: "Service", metadata: { name: "evil" } };
      await expect(plan()).rejects.toThrow(
        /kubectl dry run reported different objects.*kubectl: service\/evil.*scan: deployment.apps\/api/,
      );
      expect(stub.calls.every((c) => !c.command.includes("get"))).toBe(true);
    });

    it("compares the dry run's names to the scan as a multiset, whatever their order", async () => {
      const manifest = `${MANIFEST}---\napiVersion: v1\nkind: Service\nmetadata:\n  name: api\n`;
      world.planned = { kind: "List", items: [svc(), dep(3)] };
      kubectl();
      expect((await plan({ ...PLAN_ARGS, manifest }))["objects"]).toEqual([
        "service/api",
        "deployment.apps/api",
      ]);
      world.planned = { kind: "List", items: [svc()] };
      await expect(plan({ ...PLAN_ARGS, manifest })).rejects.toThrow(/different objects/);
      world.planned = { kind: "List", items: [svc(), svc()] };
      await expect(plan({ ...PLAN_ARGS, manifest })).rejects.toThrow(/twice/);
    });

    const SECRET =
      "apiVersion: v1\nkind: Secret\nmetadata:\n  name: s\nstringData:\n  pw: topsecret\n";
    const secretObj = (pw: string) => ({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "s", namespace: "shop" },
      data: { pw },
    });

    it("withholds kubectl's stderr when the manifest holds a Secret", async () => {
      world.dryCode = 1;
      world.dryErr = 'invalid value "topsecret"';
      kubectl();
      const err = await plan({ ...PLAN_ARGS, manifest: SECRET }).catch((e: unknown) => String(e));
      expect(err).toContain("(stderr withheld: the manifest holds a Secret)");
      expect(err).not.toContain("topsecret");
    });

    it("withholds the diff body, but not the fact of a difference, when the manifest holds a Secret", async () => {
      world.planned = secretObj("dG9wc2VjcmV0");
      world.live = secretObj("b2xk");
      kubectl();
      const out = await plan({ ...PLAN_ARGS, manifest: SECRET });
      expect(out["diff"]).toBe(`${SECRET_DIFF_WITHHELD}\n`);
      expect(out["hasDifferences"]).toBe(true);
      expect(out["diffSha256"]).toBe(diffSha256(`${SECRET_DIFF_WITHHELD}\n`));
      expect(JSON.stringify(out)).not.toContain("dG9wc2VjcmV0");
    });

    it("with a Secret beside another object, shows and hashes that object's diff only", async () => {
      const both = `${SECRET}---\n${MANIFEST}`;
      world.planned = { kind: "List", items: [secretObj("dG9wc2VjcmV0"), dep(3)] };
      world.live = { kind: "List", items: [secretObj("b2xk"), dep(2, "api", SERVER_FIELDS)] };
      kubectl();
      const out = await plan({ ...PLAN_ARGS, manifest: both });
      const diff = String(out["diff"]);
      expect(diff.startsWith(`${SECRET_DIFF_WITHHELD}\n`)).toBe(true);
      expect(diff).toContain("planned deployment.apps/api");
      expect(diff).not.toContain("secret/s");
      expect(JSON.stringify(out)).not.toContain("dG9wc2VjcmV0");
      expect(JSON.stringify(out)).not.toContain("b2xk");
      expect(out["diffSha256"]).toBe(diffSha256(diff));
      // A live change to the Deployment alone changes the hash the apply re-plan compares.
      world.live = { kind: "List", items: [secretObj("b2xk"), dep(1, "api", SERVER_FIELDS)] };
      const again = await plan({ ...PLAN_ARGS, manifest: both });
      expect(again["diffSha256"]).not.toBe(out["diffSha256"]);
    });

    it("the plan hash binds the namespace and the context", async () => {
      kubectl();
      const a = await plan();
      const b = await plan({ ...PLAN_ARGS, namespace: "shop2" });
      expect(a["planSha256"]).toBe(SHA);
      expect(b["planSha256"]).toBe(planHash(CTX, "shop2", MANIFEST));
      expect(a).not.toHaveProperty("manifestSha256");
    });

    it("refuses a context that is not the configured one before any spawn, and requires both inputs", async () => {
      const stub = kubectl();
      await expect(plan({ ...PLAN_ARGS, context: "other" })).rejects.toThrow(
        "context does not match the configured context",
      );
      await expect(plan({ namespace: "shop", manifest: MANIFEST })).rejects.toThrow();
      await expect(plan({ context: CTX, manifest: MANIFEST })).rejects.toThrow();
      expect(stub.calls).toEqual([]);
    });

    it("with KUBE_CONTEXT unset, hashes the kubeconfig's current context", async () => {
      delete process.env["KUBE_CONTEXT"];
      world.current = "from-kubeconfig";
      const stub = kubectl();
      const out = await plan({ ...PLAN_ARGS, context: "from-kubeconfig" });
      expect(out["planSha256"]).toBe(planHash("from-kubeconfig", "shop", MANIFEST));
      expect(stub.calls[0]?.command).toEqual(["kubectl", "config", "current-context"]);
      expect(stub.calls[1]?.command.slice(0, 3)).toEqual([
        "kubectl",
        "--context",
        "from-kubeconfig",
      ]);
    });

    it("refuses a manifest over 256 KiB of UTF-8 bytes before any spawn", async () => {
      const stub = kubectl();
      // 140,000 two-byte characters: under the schema's character cap, over the byte cap.
      const manifest = `# ${"é".repeat(140_000)}\n${MANIFEST}`;
      await expect(plan({ ...PLAN_ARGS, manifest })).rejects.toThrow(
        "manifest is larger than 262144 bytes",
      );
      await expect(plan({ ...PLAN_ARGS, manifest: `#${"x".repeat(262_200)}` })).rejects.toThrow();
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
        await expect(plan({ ...PLAN_ARGS, manifest })).rejects.toThrow(/manifest refused/);
      }
      expect(stub.calls).toEqual([]);
    });

    it("refuses a namespace kubectl would read as a flag, before any spawn", async () => {
      const stub = kubectl();
      await expect(plan({ ...PLAN_ARGS, namespace: "--kubeconfig=/x" })).rejects.toThrow(
        refusalSaying('must not start with "-"'),
      );
      expect(stub.calls).toEqual([]);
    });

    it.skipIf(process.platform !== "win32")(
      "on Windows under the gateway, refuses without a scratch directory, before any spawn",
      async () => {
        delete process.env["NIMBUS_CONNECTOR_SCRATCH_DIR"];
        const stub = kubectl();
        await expect(plan()).rejects.toThrow("NIMBUS_CONNECTOR_SCRATCH_DIR is not set");
        expect(stub.calls).toEqual([]);
      },
    );
  });

  describe("apply", () => {
    const CHANGED = "the cluster changed since the plan was approved";
    const apply = (args: Record<string, unknown> = APPLY_ARGS) =>
      tools.call("k8s_manifest_apply", args);
    const realApplies = (stub: SpawnStub) =>
      stub.calls.filter(
        (c) => c.command.includes("apply") && !c.command.includes("--dry-run=server"),
      );

    it("re-diffs (dry run, get), then runs one server-side apply and reports the objects", async () => {
      const stub = kubectl();
      expect(await tools.callJson("k8s_manifest_apply", APPLY_ARGS)).toEqual({
        ok: true,
        status: "applied",
        objects: ["deployment.apps/api"],
      });
      const file = seen[0]?.file ?? "";
      const base = ["kubectl", "--context", CTX];
      expect(stub.calls.map((c) => c.command)).toEqual([
        [
          ...base,
          "apply",
          "--server-side",
          "--dry-run=server",
          "--field-manager=nimbus",
          "-n",
          "shop",
          "-f",
          file,
          "-o",
          "json",
        ],
        [...base, "get", "deployment.apps/api", "-n", "shop", "-o", "json", "--ignore-not-found"],
        [
          ...base,
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
      for (const s of seen.filter((x) => x.file !== undefined)) expect(s.manifest).toBe(MANIFEST);
      expect(existsSync(file)).toBe(false);
      expect(stub.calls[0]?.env["KUBECONFIG"]).not.toBe(kubeSource);
      for (const c of stub.calls) expect(c.command).not.toContain("--force-conflicts");
    });

    it("applies what a real plan returned: plan, then apply with both of its hashes", async () => {
      kubectl();
      const planned = await plan();
      const stub = kubectl();
      expect(
        await tools.callJson("k8s_manifest_apply", {
          ...PLAN_ARGS,
          planSha256: planned["planSha256"],
          diffSha256: planned["diffSha256"],
        }),
      ).toMatchObject({ ok: true, status: "applied" });
      expect(realApplies(stub)).toHaveLength(1);
    });

    it("throws the fixed message and applies nothing when the cluster moved since the plan", async () => {
      kubectl();
      const planned = await plan();
      // Someone changed the live object after the owner approved the plan.
      world.live = dep(5, "api", SERVER_FIELDS);
      const stub = kubectl();
      await expect(
        apply({
          ...PLAN_ARGS,
          planSha256: planned["planSha256"],
          diffSha256: planned["diffSha256"],
        }),
      ).rejects.toThrow(new RegExp(`^${CHANGED}$`));
      expect(realApplies(stub)).toEqual([]);
    });

    it("throws the same fixed message when the diff hash is simply wrong", async () => {
      const stub = kubectl();
      await expect(apply({ ...APPLY_ARGS, diffSha256: "0".repeat(64) })).rejects.toThrow(
        new RegExp(`^${CHANGED}$`),
      );
      expect(realApplies(stub)).toEqual([]);
    });

    it("throws the same fixed message when the re-diff itself fails, whatever the failure", async () => {
      for (const set of [
        () => {
          world.dryCode = 1;
          world.dryErr = "webhook denied";
        },
        () => {
          world.getCode = 1;
        },
        () => {
          world.dryRaw = "garbage";
        },
        () => {
          world.planned = { kind: "Service", metadata: { name: "evil" } };
        },
      ]) {
        resetWorld();
        set();
        const stub = kubectl();
        await expect(apply()).rejects.toThrow(new RegExp(`^${CHANGED}$`));
        expect(realApplies(stub)).toEqual([]);
      }
    });

    it("does not apply when the manifest file changed after the re-diff", async () => {
      spawn?.restore();
      spawn = stubSpawnScript((command) => {
        const at = command.indexOf("-f");
        const file = at === -1 ? undefined : command[at + 1];
        if (file !== undefined) writeFileSync(file, MANIFEST.replace("name: api", "name: other"));
        if (command.includes("--dry-run=server")) return { stdout: json(world.planned) };
        return { stdout: json(world.live) };
      });
      await expect(apply()).rejects.toThrow("the manifest file changed before the apply");
      expect(realApplies(spawn)).toEqual([]);
    });

    it("reports an applied set that differs from the scan, naming both sets", async () => {
      world.applyOut = "deployment.apps/other\n";
      kubectl();
      await expect(apply()).rejects.toThrow(
        /applied and reported different objects.*kubectl: deployment.apps\/other; scan: deployment.apps\/api/,
      );
    });

    it("an approved plan for one namespace or context cannot be replayed in another", async () => {
      const stub = kubectl();
      await expect(apply({ ...APPLY_ARGS, namespace: "other" })).rejects.toThrow(
        "manifest does not match the approved hash",
      );
      // A plan hashed under another context (here the retired v1 shape too) is not this cluster's.
      await expect(
        apply({ ...APPLY_ARGS, planSha256: planHash("elsewhere", "shop", MANIFEST) }),
      ).rejects.toThrow("manifest does not match the approved hash");
      await expect(apply({ ...APPLY_ARGS, context: "elsewhere" })).rejects.toThrow(
        "context does not match the configured context",
      );
      expect(stub.calls).toEqual([]);
    });

    it("throws kubectl's exit code and stderr from the real apply", async () => {
      world.applyCode = 1;
      world.applyErr = "conflict";
      kubectl();
      // The diff hash must match first.
      const planned = await plan();
      await expect(
        apply({
          ...PLAN_ARGS,
          planSha256: planned["planSha256"],
          diffSha256: planned["diffSha256"],
        }),
      ).rejects.toThrow("kubectl exited 1: conflict");
    });

    it("a manifest that does not hash to the approved value spawns nothing", async () => {
      const stub = kubectl();
      const edited = MANIFEST.replace("name: api", "name: api2");
      await expect(apply({ ...APPLY_ARGS, manifest: edited })).rejects.toThrow(
        "manifest does not match the approved hash",
      );
      await expect(apply({ ...APPLY_ARGS, planSha256: "0".repeat(64) })).rejects.toThrow(
        "manifest does not match the approved hash",
      );
      // The hash is of the bytes: a different line ending is a different manifest.
      await expect(
        apply({ ...APPLY_ARGS, manifest: MANIFEST.replaceAll("\n", "\r\n") }),
      ).rejects.toThrow("manifest does not match the approved hash");
      expect(stub.calls).toEqual([]);
    });

    it("refuses a missing or malformed hash, before any spawn", async () => {
      const stub = kubectl();
      for (const planSha256 of [SHA.toUpperCase(), SHA.slice(1), `${SHA}0`, "", "zz"]) {
        await expect(apply({ ...APPLY_ARGS, planSha256 })).rejects.toThrow();
      }
      for (const diffSha of [UPDATE_DIFF_SHA.toUpperCase(), UPDATE_DIFF_SHA.slice(1), "", "zz"]) {
        await expect(apply({ ...APPLY_ARGS, diffSha256: diffSha })).rejects.toThrow();
      }
      const { diffSha256: _omitted, ...withoutDiff } = APPLY_ARGS;
      await expect(apply(withoutDiff)).rejects.toThrow();
      const { context: _c, ...withoutContext } = APPLY_ARGS;
      await expect(apply(withoutContext)).rejects.toThrow();
      expect(stub.calls).toEqual([]);
    });

    it("spawns nothing for a manifest the scanner refuses, even with a matching hash", async () => {
      const stub = kubectl();
      const bad = "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: x\n";
      await expect(
        apply({
          ...APPLY_ARGS,
          manifest: bad,
          planSha256: planHash(CTX, "shop", bad),
        }),
      ).rejects.toThrow(/not on the namespaced allowlist/);
      expect(stub.calls).toEqual([]);
    });

    it("refuses an oversize manifest before any spawn", async () => {
      const stub = kubectl();
      const manifest = `# ${"é".repeat(140_000)}\n${MANIFEST}`;
      await expect(apply({ ...APPLY_ARGS, manifest })).rejects.toThrow(
        "manifest is larger than 262144 bytes",
      );
      expect(stub.calls).toEqual([]);
    });
  });

  describe("standalone mode", () => {
    beforeEach(() => {
      resetConnectorModeForTests();
      setConnectorMode("standalone");
    });

    it("refuseBefore stops a refused manifest or a wrong hash before the prompt, and the audit says refused", async () => {
      const stub = kubectl();
      const auditDir = mkdtempSync(join(tmpdir(), "k8s-audit-"));
      const auditLog = join(auditDir, "audit.jsonl");
      try {
        await withEnv(
          { NIMBUS_MCP_KUBERNETES_WRITE_SCOPE: "namespace:shop", NIMBUS_MCP_AUDIT_LOG: auditLog },
          async () => {
            const cap = captureStandaloneTools(registerKubernetesTools, { elicitation: true });
            const bad = "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: x\n";
            const res = (await cap.tools.callJson("k8s_manifest_apply", {
              ...APPLY_ARGS,
              manifest: bad,
              planSha256: planHash(CTX, "shop", bad),
            })) as { ok: boolean; error: string };
            expect(res.ok).toBe(false);
            expect(res.error).toMatch(/not on the namespaced allowlist/);
            const wrong = (await cap.tools.callJson("k8s_manifest_apply", {
              ...APPLY_ARGS,
              planSha256: "0".repeat(64),
            })) as { ok: boolean; error: string };
            expect(wrong.error).toBe("manifest does not match the approved hash");
            const other = (await cap.tools.callJson("k8s_manifest_apply", {
              ...APPLY_ARGS,
              context: "elsewhere",
            })) as { ok: boolean; error: string };
            expect(other.error).toBe("context does not match the configured context");
            expect(cap.prompts).toEqual([]);
          },
        );
        expect(readFileSync(auditLog, "utf8")).toContain("refused");
      } finally {
        rmSync(auditDir, { recursive: true, force: true });
      }
      expect(stub.calls).toEqual([]);
    });

    it("an approved apply records the context, namespace, hashes and scanned objects as its pre-state", async () => {
      kubectl();
      const run = await approvedStandaloneWrite(
        registerKubernetesTools,
        { NIMBUS_MCP_KUBERNETES_WRITE_SCOPE: "namespace:shop" },
        "k8s_manifest_apply",
        APPLY_ARGS,
      );
      expect(run.answer).toMatchObject({ ok: true, status: "applied" });
      expect(run.audit.find((e) => e.outcome === "executed")?.detail["preState"]).toEqual({
        context: CTX,
        namespace: "shop",
        planSha256: SHA,
        diffSha256: UPDATE_DIFF_SHA,
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
              planSha256: string;
            };
            expect(res.planSha256).toBe(SHA);
          },
        );
        expect(readFileSync(auditLog, "utf8")).toContain("prepared");
      } finally {
        rmSync(auditDir, { recursive: true, force: true });
      }
    });
  });
});
