import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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
  "--zone=us-east1-b",
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
