import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const read = (name: string): string =>
  readFileSync(join(ROOT, ".github", "workflows", name), "utf8");

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  "working-directory"?: string;
}
interface Job {
  needs?: unknown;
  if?: string;
  environment?: unknown;
  permissions?: unknown;
  "runs-on"?: string;
  "timeout-minutes"?: number;
  outputs?: Record<string, string>;
  env?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  steps?: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions?: unknown;
  jobs: Record<string, Job>;
}

const gha = (expression: string): string => `\${{ ${expression} }}`;
const stepNamed = (steps: Step[], name: string): Step | undefined =>
  steps.find((s) => s.name === name);

describe("the set-liveness-key workflow", () => {
  const text = read("registry-set-liveness-key.yml");
  const parsed = Bun.YAML.parse(text) as Workflow;
  const publish = Bun.YAML.parse(read("registry-publish.yml")) as Workflow;
  const pre = parsed.jobs["preflight"] as Job;
  const setKey = parsed.jobs["set-key"] as Job;
  const preSteps = pre.steps ?? [];
  const setSteps = setKey.steps ?? [];
  const pubPre = publish.jobs["preflight"]?.steps ?? [];
  const pubSteps = publish.jobs["publish"]?.steps ?? [];
  const HARDEN = "step-security/harden-runner@e14015d583714f6e62063499dc959a02595150a1";
  const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";

  test("is a manual dispatch with no inputs, read-only by default", () => {
    expect(Object.keys(parsed.on)).toEqual(["workflow_dispatch"]);
    expect(parsed.on["workflow_dispatch"] ?? null).toBeNull();
    expect(parsed.permissions).toEqual({ contents: "read" });
    expect(Object.keys(parsed.jobs).sort()).toEqual(["preflight", "set-key"]);
  });

  test("preflight holds no environment and no secret", () => {
    expect(pre["runs-on"]).toBe("ubuntu-24.04");
    expect(pre["timeout-minutes"]).toBe(5);
    expect(pre.environment).toBeUndefined();
    expect(pre.permissions).toEqual({ contents: "read" });
    const start = text.indexOf("  preflight:");
    const end = text.indexOf("  set-key:");
    expect(text.slice(start, end)).not.toContain("${{ secrets.");
    expect(pre.outputs).toEqual({ needed: gha("steps.check.outputs.needed") });
  });

  test("preflight steps, in order", () => {
    expect(preSteps[0]?.uses).toBe(HARDEN);
    expect(preSteps[0]?.with).toEqual({ "egress-policy": "audit" });
    for (const name of ["Refuse unless the registry is enabled", "Refuse a ref other than main"]) {
      const mine = stepNamed(preSteps, name);
      expect(mine?.run).toBeDefined();
      expect(mine?.run).toBe(stepNamed(pubPre, name)?.run as string);
      expect(mine?.env).toEqual(stepNamed(pubPre, name)?.env as Record<string, string>);
    }
    expect(preSteps.map((s) => s.name)).toEqual([
      "Harden Runner",
      "Refuse unless the registry is enabled",
      "Refuse a ref other than main",
      "Checkout",
      "Checkout the registry (gh-pages)",
      "Setup Bun",
      "Is the liveness key already named?",
    ]);
    expect(preSteps[3]?.uses).toBe(CHECKOUT);
    expect(preSteps[3]?.with).toEqual({ "persist-credentials": false });
    expect(preSteps[4]?.uses).toBe(CHECKOUT);
    expect(preSteps[4]?.with).toEqual({
      ref: "gh-pages",
      path: "registry",
      "persist-credentials": false,
    });
    const bun = stepNamed(pubPre, "Setup Bun");
    expect(preSteps[5]?.uses).toBe(bun?.uses as string);
    expect(preSteps[5]?.with).toEqual(bun?.with as Record<string, unknown>);
    const check = preSteps[6];
    expect(check?.id).toBe("check");
    expect(check?.env).toEqual({ KEY: gha("vars.NIMBUS_REGISTRY_LIVENESS_PUBLIC_KEY") });
    expect(check?.run?.trim()).toBe("bun scripts/liveness-key-check.ts");
  });

  test("set-key is gated, protected, serialised and pinned", () => {
    expect(setKey["runs-on"]).toBe("ubuntu-24.04");
    expect(setKey["timeout-minutes"]).toBe(15);
    expect(setKey.needs).toBe("preflight");
    expect(setKey.if).toBe("needs.preflight.outputs.needed == 'true'");
    expect(setKey.environment).toBe("official-registry");
    expect(setKey.permissions).toEqual({ contents: "write" });
    expect(setKey.concurrency).toEqual({
      group: "official-registry",
      "cancel-in-progress": false,
    });
    expect(setKey.env).toEqual({
      NIMBUS_CLI_VERSION: "v10.17.0",
      NIMBUS_CLI_SHA256: "840fdc4f7d529e9aa986a9e57272d5584cf719d3f482468c498b31bb74920fe2",
    });
  });

  test("set-key steps, in order", () => {
    expect(setSteps.map((s) => s.name)).toEqual([
      "Harden Runner",
      "Checkout the registry (gh-pages)",
      "Download and verify the Nimbus CLI",
      "Write the registry root key",
      "Name the liveness key",
      "Delete the signing keys",
      "Commit and push the registry",
    ]);
    expect(setSteps[0]?.uses).toBe(HARDEN);
    expect(setSteps[0]?.with).toEqual({ "egress-policy": "audit" });
    expect(setSteps[1]?.uses).toBe(CHECKOUT);
    expect(setSteps[1]?.with).toEqual({
      ref: "gh-pages",
      path: "registry",
      "persist-credentials": false,
    });
    const dl = stepNamed(pubSteps, "Download and verify the Nimbus CLI");
    expect(setSteps[2]?.run).toBe(dl?.run as string);
    expect(setSteps[2]?.run).toContain("sha256sum --check --strict");
    expect(setSteps[2]?.run).toContain(
      `/releases/download/\${NIMBUS_CLI_VERSION}/nimbus-cli-linux-x64`,
    );
    const write = stepNamed(pubSteps, "Write the registry root key");
    expect(setSteps[3]?.run).toBe(write?.run as string);
    expect(setSteps[3]?.env).toEqual(write?.env as Record<string, string>);
    const name = setSteps[4];
    expect(name?.env).toEqual({ KEY: gha("vars.NIMBUS_REGISTRY_LIVENESS_PUBLIC_KEY") });
    expect(name?.run?.trim()).toBe(
      '"$RUNNER_TEMP/nimbus-cli/nimbus" registry maintain set-liveness-key registry "$KEY" --key "$RUNNER_TEMP/nimbus-keys/root.key"',
    );
    expect(setSteps[5]?.if).toBe("always()");
    expect(setSteps[5]?.run?.trim()).toBe('rm -rf "$RUNNER_TEMP/nimbus-keys"');
  });

  test("the push step commits then pushes to gh-pages without force", () => {
    const push = setSteps[6];
    expect(push?.["working-directory"]).toBe("registry");
    expect(push?.env).toEqual({ GH_TOKEN: gha("github.token") });
    const run = push?.run ?? "";
    const order = [
      "git add -A",
      "git diff --cached --quiet",
      "exit 1",
      'user.name="github-actions[bot]"',
      'user.email="41898282+github-actions[bot]@users.noreply.github.com"',
      "registry: name the liveness key",
      "GIT_CONFIG_COUNT=1",
      `git push "https://github.com/\${GITHUB_REPOSITORY}.git" HEAD:gh-pages`,
    ].map((s) => run.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(run).toContain("::error::");
    expect(run).not.toMatch(/--force|\bpush\b[^\n]*\s-f\b/);
  });

  test("secret hygiene and no repository code beside the root key", () => {
    expect(text.match(/secrets\.NIMBUS_REGISTRY_ROOT_KEY/g)?.length).toBe(1);
    expect(text).not.toContain("NIMBUS_REGISTRY_LIVENESS_KEY");
    const setText = text.slice(text.indexOf("  set-key:"));
    expect(setText).not.toMatch(/\bbun\b/);
    expect(setText).not.toContain("scripts/");
    expect(setText).not.toContain("npm ");
    const preText = text.slice(text.indexOf("  preflight:"), text.indexOf("  set-key:"));
    expect(preText.match(/scripts\/[\w.-]+/g)).toEqual(["scripts/liveness-key-check.ts"]);
  });
});
