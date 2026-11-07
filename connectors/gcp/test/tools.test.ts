import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CapturedTools,
  captureTools,
  type RecordedSpawn,
  refusalSaying,
  type SpawnStub,
  stubSpawn,
} from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { registerGcpTools } from "../src/tools.ts";

let tools: CapturedTools;
let spawn: SpawnStub | undefined;

/** Answer every CLI call with this reply, replacing any stub already installed. */
function cli(reply: { stdout?: string; stderr?: string; exitCode?: number }): SpawnStub {
  spawn?.restore();
  spawn = stubSpawn(reply);
  return spawn;
}

function commands(calls: readonly RecordedSpawn[]): string[][] {
  return calls.map((c) => [...c.command]);
}

beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  tools = captureTools(registerGcpTools);
});

afterEach(() => {
  spawn?.restore();
  spawn = undefined;
  resetConnectorModeForTests();
});

const DEPLOY = { projectId: "p1", region: "us-east1", service: "api", image: "gcr.io/p1/api:2" };
const RESTART = {
  projectId: "p1",
  location: "us-east1-b",
  cluster: "gke-1",
  namespace: "prod",
  deployment: "api",
};
const GET_CREDENTIALS = [
  "gcloud",
  "container",
  "clusters",
  "get-credentials",
  "gke-1",
  "--project=p1",
  "--location=us-east1-b",
];
const ROLLOUT_RESTART = ["kubectl", "rollout", "restart", "deployment", "api", "-n", "prod"];

describe("gcp write tools", () => {
  it("gcp_cloud_run_deploy runs exactly its gcloud command and reports ok", async () => {
    const stub = cli({ stdout: "" });
    expect(await tools.callJson("gcp_cloud_run_deploy", DEPLOY)).toEqual({ ok: true });
    expect(commands(stub.calls)).toEqual([
      [
        "gcloud",
        "run",
        "deploy",
        "api",
        "--project=p1",
        "--region=us-east1",
        "--image=gcr.io/p1/api:2",
        "--quiet",
      ],
    ]);
  });

  it("gcp_cloud_run_deploy throws gcloud's exit code and stderr", async () => {
    cli({ exitCode: 1, stderr: "PERMISSION_DENIED" });
    await expect(tools.call("gcp_cloud_run_deploy", DEPLOY)).rejects.toThrow(
      "gcloud exited 1: PERMISSION_DENIED",
    );
  });

  it("gcp_gke_workload_restart fetches cluster credentials, then restarts, and reports ok", async () => {
    const stub = cli({ stdout: "" });
    expect(await tools.callJson("gcp_gke_workload_restart", RESTART)).toEqual({ ok: true });
    expect(commands(stub.calls)).toEqual([GET_CREDENTIALS, ROLLOUT_RESTART]);
  });

  it("gcp_gke_workload_restart stops at a credentials failure, before kubectl", async () => {
    const stub = cli({ exitCode: 1, stderr: "cluster not found" });
    await expect(tools.call("gcp_gke_workload_restart", RESTART)).rejects.toThrow(
      "gcloud exited 1: cluster not found",
    );
    expect(commands(stub.calls)).toEqual([GET_CREDENTIALS]);
  });
});

describe("gcp refuses an argument that is not a plain value, before gcloud or kubectl runs", () => {
  // The service and the cluster are positionals to gcloud, and the deployment one to kubectl: a
  // value starting with "-" would be read as a flag. The values written as --flag=<value> cannot
  // be read that way, and are held to the same rule.
  const DASH = 'must not start with "-"';
  const CASES: readonly (readonly [string, Record<string, unknown>, string])[] = [
    [
      "gcp_cloud_run_deploy",
      { ...DEPLOY, service: "--impersonate-service-account=attacker@example.com" },
      DASH,
    ],
    ["gcp_gke_workload_restart", { ...RESTART, cluster: "--flags-file=/tmp/x" }, DASH],
    [
      "gcp_gke_workload_restart",
      { ...RESTART, deployment: "--kubeconfig=/tmp/attacker-kubeconfig" },
      DASH,
    ],
    ["gcp_gke_workload_restart", { ...RESTART, namespace: "--kubeconfig=/x" }, DASH],
    [
      "gcp_cloud_run_deploy",
      { ...DEPLOY, image: "gcr.io/p1/api:2\nx" },
      "must not contain control characters",
    ],
    ["gcp_cloud_run_service_list", { projectId: "-p1", region: "r1" }, DASH],
  ];

  for (const [tool, args, refusal] of CASES) {
    it(`${tool} refuses ${JSON.stringify(args)}`, async () => {
      const stub = cli({ stdout: "" });
      await expect(tools.call(tool, args)).rejects.toThrow(refusalSaying(refusal));
      expect(stub.calls).toEqual([]);
    });
  }
});

describe("gcp_cloud_run_service_list", () => {
  it("asks gcloud for JSON output and returns it", async () => {
    const stub = cli({ stdout: '[{"metadata":{"name":"api"}}]' });
    expect(
      await tools.callJson("gcp_cloud_run_service_list", { projectId: "p1", region: "r1" }),
    ).toEqual([{ metadata: { name: "api" } }]);
    expect(stub.calls[0]?.command).toEqual([
      "gcloud",
      "run",
      "services",
      "list",
      "--project=p1",
      "--region=r1",
      "--format",
      "json",
    ]);
  });

  it("reports an empty answer as an empty object", async () => {
    cli({ stdout: "" });
    expect(
      await tools.callJson("gcp_cloud_run_service_list", { projectId: "p1", region: "r1" }),
    ).toEqual({});
  });

  it("throws gcloud's exit code and stderr", async () => {
    cli({ exitCode: 2, stderr: "invalid region" });
    await expect(
      tools.call("gcp_cloud_run_service_list", { projectId: "p1", region: "r1" }),
    ).rejects.toThrow("gcloud exited 2: invalid region");
  });
});

describe("gke tools use a private kubeconfig, never the owner's", () => {
  it("get-credentials and kubectl share one fresh file that is removed afterwards", async () => {
    const stub = cli({ stdout: "" });
    await tools.callJson("gcp_gke_workload_restart", RESTART);
    const [creds, rollout] = stub.calls;
    const path = creds?.env["KUBECONFIG"] ?? "";
    expect(path).not.toBe("");
    expect(rollout?.env["KUBECONFIG"]).toBe(path);
    expect(existsSync(path)).toBe(false);
  });

  it("never names the owner's ~/.kube/config: HOME is a temp dir and stays untouched", async () => {
    const home = mkdtempSync(join(tmpdir(), "gcp-home-"));
    const saved = new Map(["HOME", "USERPROFILE"].map((k) => [k, process.env[k]]));
    process.env["HOME"] = home;
    process.env["USERPROFILE"] = home;
    try {
      const stub = cli({ stdout: "" });
      await tools.callJson("gcp_gke_workload_restart", RESTART);
      for (const c of stub.calls) {
        expect(c.env["KUBECONFIG"]?.startsWith(home)).toBe(false);
        expect(c.command.join(" ")).not.toContain(".kube");
      }
      expect(existsSync(join(home, ".kube"))).toBe(false);
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("two concurrent restarts use different files", async () => {
    const stub = cli({ stdout: "" });
    await Promise.all([
      tools.call("gcp_gke_workload_restart", RESTART),
      tools.call("gcp_gke_workload_restart", RESTART),
    ]);
    const paths = new Set(stub.calls.map((c) => c.env["KUBECONFIG"]));
    expect(paths.size).toBe(2);
  });

  it("the file starts empty for get-credentials to fill", async () => {
    let seen = "unset";
    spawn?.restore();
    spawn = stubSpawn({ stdout: "" });
    const original = (Bun as { spawn: unknown }).spawn as (
      c: string[],
      o: { env: Record<string, string> },
    ) => unknown;
    (Bun as { spawn: unknown }).spawn = (c: string[], o: { env: Record<string, string> }) => {
      if (seen === "unset") seen = readFileSync(o.env["KUBECONFIG"] ?? "", "utf8");
      writeFileSync(o.env["KUBECONFIG"] ?? "", "filled");
      return original(c, o);
    };
    await tools.call("gcp_gke_workload_restart", RESTART);
    expect(seen).toBe("");
  });
});

describe("gcp_gke_workload_get", () => {
  const DEPLOYMENT = JSON.stringify({
    metadata: { name: "api", namespace: "prod", generation: 2 },
    spec: { replicas: 3, template: { spec: { containers: [{ image: "gcr.io/p1/api:2" }] } } },
    status: { readyReplicas: 3, observedGeneration: 2 },
  });

  it("fetches credentials with --location, then gets the deployment and projects it", async () => {
    const stub = cli({ stdout: DEPLOYMENT });
    expect(await tools.callJson("gcp_gke_workload_get", RESTART)).toEqual({
      name: "api",
      namespace: "prod",
      replicas: 3,
      readyReplicas: 3,
      generation: 2,
      observedGeneration: 2,
      images: ["gcr.io/p1/api:2"],
    });
    expect(commands(stub.calls)).toEqual([
      GET_CREDENTIALS,
      ["kubectl", "get", "deployment", "api", "-n", "prod", "-o", "json"],
    ]);
  });

  it("reports a missing deployment as not found", async () => {
    let n = 0;
    spawn?.restore();
    const real = stubSpawn({});
    spawn = real;
    const stubbed = (Bun as { spawn: unknown }).spawn as (c: string[], o: unknown) => unknown;
    (Bun as { spawn: unknown }).spawn = (c: string[], o: unknown) => {
      n += 1;
      if (n === 1) return stubbed(c, o);
      return {
        exited: Promise.resolve(1),
        stdout: new Blob([""]),
        stderr: new Blob(['Error from server (NotFound): deployments.apps "api" not found']),
      };
    };
    await expect(tools.call("gcp_gke_workload_get", RESTART)).rejects.toThrow(
      "deployment not found",
    );
  });

  it("stops at a credentials failure and refuses flag-like values before any spawn", async () => {
    const stub = cli({ exitCode: 1, stderr: "cluster not found" });
    await expect(tools.call("gcp_gke_workload_get", RESTART)).rejects.toThrow(
      "gcloud exited 1: cluster not found",
    );
    expect(stub.calls).toHaveLength(1);
    const none = cli({ stdout: "" });
    await expect(
      tools.call("gcp_gke_workload_get", { ...RESTART, deployment: "--kubeconfig=/x" }),
    ).rejects.toThrow(refusalSaying('must not start with "-"'));
    expect(none.calls).toEqual([]);
  });
});
