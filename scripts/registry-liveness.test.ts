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
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  needs?: unknown;
  environment?: unknown;
  permissions?: unknown;
  "runs-on"?: string;
  "timeout-minutes"?: number;
  outputs?: Record<string, string>;
  steps?: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions?: unknown;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs: Record<string, Job>;
}

/** A GitHub Actions expression, `${{ … }}`, as the parsed workflow holds it. */
const gha = (expression: string): string => `\${{ ${expression} }}`;
const stepNamed = (steps: Step[], name: string): Step | undefined =>
  steps.find((s) => s.name === name);

describe("the registry liveness workflow", () => {
  const text = read("registry-liveness.yml");
  const publishParsed = Bun.YAML.parse(read("registry-publish.yml")) as Workflow;
  const parsed = Bun.YAML.parse(text) as Workflow;
  const check = parsed.jobs["check"] as Job;
  const sign = parsed.jobs["sign"] as Job;
  const checkSteps = check.steps ?? [];
  const signSteps = sign.steps ?? [];
  const HARDEN = "step-security/harden-runner@e14015d583714f6e62063499dc959a02595150a1";
  const ACTION =
    "nimbus-agent/Nimbus/packages/github-actions/registry-action@90515ccbb2c4d74aa5db31cfe17d9c0dcf44e669";

  test("triggers weekly and by hand, and nothing else", () => {
    expect(Object.keys(parsed.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(parsed.on["schedule"]).toEqual([{ cron: "23 5 * * 1" }]);
    expect(parsed.permissions).toEqual({ contents: "read" });
    expect(parsed.concurrency?.group).toBe("registry-liveness");
    expect(parsed.concurrency?.["cancel-in-progress"]).toBe(false);
  });

  test("has exactly the check and sign jobs", () => {
    expect(Object.keys(parsed.jobs).sort()).toEqual(["check", "sign"]);
  });

  describe("check", () => {
    const jobText = text.slice(text.indexOf("\n  check:"), text.indexOf("\n  sign:"));

    test("holds no environment, no secret and a read-only token", () => {
      expect(jobText.length).toBeGreaterThan(100);
      expect(check.environment).toBeUndefined();
      expect(check.permissions).toEqual({ contents: "read" });
      expect(check["runs-on"]).toBe("ubuntu-24.04");
      expect(check["timeout-minutes"]).toBe(60);
      expect(jobText).not.toContain("${{ secrets.");
    });

    test("starts with Harden Runner, then a full-history checkout without credentials", () => {
      expect(checkSteps[0]?.uses?.startsWith(HARDEN)).toBe(true);
      expect(checkSteps[0]?.with).toEqual({ "egress-policy": "audit" });
      const checkout = stepNamed(checkSteps, "Checkout");
      expect(checkout?.with?.["fetch-depth"]).toBe(0);
      expect(checkout?.with?.["persist-credentials"]).toBe(false);
    });

    test("sets up the sandbox exactly as the publish workflow's score job does", () => {
      const mine = stepNamed(checkSteps, "Set up the sandbox")?.run;
      const theirs = stepNamed(publishParsed.jobs["score"]?.steps ?? [], "Set up the sandbox")?.run;
      expect(mine).toBeDefined();
      expect(mine).toBe(theirs);
    });

    test("resolves and verifies the latest release's gateway", () => {
      const step = checkSteps.find((s) => s.id === "gateway");
      expect(step?.env).toEqual({ GH_TOKEN: gha("github.token") });
      const run = step?.run ?? "";
      expect(run).toContain("gh release view --repo nimbus-agent/Nimbus");
      expect(run).toContain("^[0-9]+\\.[0-9]+\\.[0-9]+$");
      expect(run).toContain("sha256sum -c CHECKSUM.txt");
      expect(run).toContain(`echo "version=\${version}" >> "$GITHUB_OUTPUT"`);
      expect(check.outputs?.["nimbus-version"]).toBe(gha("steps.gateway.outputs.version"));
    });

    test("runs the action in liveness-check mode with only the expected inputs", () => {
      const step = checkSteps.find((s) => s.uses?.startsWith(ACTION));
      expect(step?.with).toEqual({
        mode: "liveness-check",
        "default-branch": "main",
        "nimbus-gateway": `${gha("github.workspace")}/nimbus-gateway-linux-x64`,
        "nimbus-version": gha("steps.gateway.outputs.version"),
      });
    });

    test("uploads the results file as registry-liveness", () => {
      const step = checkSteps.find((s) => s.uses?.startsWith("actions/upload-artifact@"));
      expect(step?.with).toEqual({
        name: "registry-liveness",
        path: "liveness-results.json",
        "if-no-files-found": "error",
      });
    });
  });

  describe("sign", () => {
    test("holds the protected environment and write access, and runs no shell", () => {
      expect(sign.needs).toBe("check");
      expect(sign.environment).toBe("registry-liveness");
      expect(sign["runs-on"]).toBe("ubuntu-24.04");
      expect(sign.permissions).toEqual({ contents: "write" });
      expect(sign["timeout-minutes"]).toBe(15);
      expect(signSteps[0]?.uses?.startsWith(HARDEN)).toBe(true);
      expect(signSteps.filter((s) => s.run !== undefined)).toEqual([]);
      expect(signSteps.every((s) => typeof s.uses === "string")).toBe(true);
    });

    test("keeps the checkout credential, which the action pushes with", () => {
      const checkout = stepNamed(signSteps, "Checkout");
      expect(checkout).toBeDefined();
      expect(checkout?.with?.["persist-credentials"]).toBeUndefined();
    });

    test("downloads the results outside the checkout", () => {
      const step = signSteps.find((s) => s.uses?.startsWith("actions/download-artifact@"));
      expect(step?.with).toEqual({
        name: "registry-liveness",
        path: `${gha("runner.temp")}/registry-liveness`,
      });
    });

    test("runs the action in liveness-sign mode with the liveness key", () => {
      const step = signSteps.find((s) => s.uses?.startsWith(ACTION));
      expect(step?.with).toEqual({
        mode: "liveness-sign",
        "default-branch": "main",
        "liveness-key": gha("secrets.NIMBUS_REGISTRY_LIVENESS_KEY"),
        results: `${gha("runner.temp")}/registry-liveness/liveness-results.json`,
        "nimbus-version": gha("needs.check.outputs.nimbus-version"),
      });
    });
  });

  test("references only the liveness secret, once, and never another key", () => {
    expect([...text.matchAll(/secrets\.[A-Z_]+/g)].map((m) => m[0])).toEqual([
      "secrets.NIMBUS_REGISTRY_LIVENESS_KEY",
    ]);
    expect(text.match(/NIMBUS_REGISTRY_LIVENESS_KEY/g)?.length).toBe(1);
    expect(text).not.toContain("NIMBUS_REGISTRY_ROOT_KEY");
    expect(text).not.toContain("NIMBUS_PUBLISHER_KEY");
  });

  test("pins every action by commit SHA, the Nimbus action at v10.17.0", () => {
    const uses = [...text.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((m) => m[1] ?? "");
    expect(uses.length).toBeGreaterThan(2);
    expect(uses.filter((u) => !/@[0-9a-f]{40}$/.test(u))).toEqual([]);
    const lines = text.split("\n").filter((l) => l.includes("registry-action@"));
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(line.trim()).toBe(`uses: ${ACTION} # v10.17.0`);
    }
  });
});
