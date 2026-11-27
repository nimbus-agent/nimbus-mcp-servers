import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSandboxContractTests } from "@nimbus-dev/sdk/testing";
import {
  approvedStandaloneWrite,
  captureStandaloneTools,
  withEnv,
} from "../../../scripts/connector-tool-harness.ts";
import { liveSandboxGate, withCleanup } from "../../../scripts/sandbox-live-env.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { registerUnleashTools } from "../src/tools.ts";

const manifestPath = resolve(fileURLToPath(import.meta.url), "../../nimbus.extension.json");

describe.skipIf(!process.env["NIMBUS_TEST_HARNESS"])("sandbox contract", () => {
  it("respects declared permissions", async () => {
    await expect(runSandboxContractTests(manifestPath)).resolves.toBeUndefined();
  });
});

/**
 * LIVE: toggles ONE throwaway flag the owner created, in ONE environment, and toggles it back.
 * Nothing else is read or written. Runs only under `bun run test:sandbox` with every variable set.
 */
const live = liveSandboxGate("unleash live write: unleash_feature_toggle", [
  "UNLEASH_API_URL",
  "UNLEASH_API_TOKEN",
  "UNLEASH_SANDBOX_PROJECT",
  "UNLEASH_SANDBOX_FEATURE",
  "UNLEASH_SANDBOX_ENVIRONMENT",
]);

describe.skipIf(!live.enabled)(live.title, () => {
  const target = {
    projectId: live.values["UNLEASH_SANDBOX_PROJECT"] ?? "",
    featureName: live.values["UNLEASH_SANDBOX_FEATURE"] ?? "",
    environment: live.values["UNLEASH_SANDBOX_ENVIRONMENT"] ?? "",
  };
  // The write scope names exactly the throwaway flag, so the consent kit itself refuses any other.
  const scope = {
    NIMBUS_MCP_UNLEASH_WRITE_SCOPE: `flag:${target.projectId}/${target.environment}/${target.featureName}`,
  };

  /**
   * Run `body` in standalone mode, where the connector's own consent kit is the gate. Not a
   * beforeAll/afterAll pair: Bun counts a skipped describe's hooks as skipped tests.
   */
  async function standalone(body: () => Promise<void>): Promise<void> {
    resetConnectorModeForTests();
    setConnectorMode("standalone");
    try {
      await body();
    } finally {
      resetConnectorModeForTests();
    }
  }

  async function readState(): Promise<Record<string, unknown>> {
    const answer = await withEnv(scope, () =>
      captureStandaloneTools(registerUnleashTools, { elicitation: true }).tools.callJson(
        "unleash_feature_state_get",
        target,
      ),
    );
    expect(typeof answer).toBe("object");
    return answer as Record<string, unknown>;
  }

  /** One toggle through the real consent flow, approved by the harness's stand-in client. */
  async function toggle(enabled: boolean): Promise<Record<string, unknown>> {
    const run = await approvedStandaloneWrite(
      registerUnleashTools,
      scope,
      "unleash_feature_toggle",
      {
        ...target,
        enabled,
      },
    );
    expect(run.chain.ok).toBe(true);
    return run.answer as Record<string, unknown>;
  }

  function activeStrategies(state: Record<string, unknown>): number {
    const strategies = state["strategies"];
    if (!Array.isArray(strategies)) return 0;
    return strategies.filter((s: unknown) => {
      const disabled = (s as Record<string, unknown> | null)?.["disabled"];
      return disabled !== true;
    }).length;
  }

  it("toggles the throwaway flag to the opposite state, confirms it, and restores it", () =>
    standalone(async () => {
      const before = await readState();
      const original = before["enabled"];
      expect(typeof original).toBe("boolean");
      const flipped = original !== true;

      await withCleanup(
        `Unleash flag ${scope.NIMBUS_MCP_UNLEASH_WRITE_SCOPE} should be enabled=${String(original)}`,
        async () => {
          const answer = await toggle(flipped);
          expect(answer).toMatchObject({ ok: true, confirmed: true, enabled: flipped });
          const during = await readState();
          expect(during["enabled"]).toBe(flipped);
          if (flipped) {
            // The README's open question: does enabling an environment with no active strategy make
            // Unleash add a default one? Recorded, not asserted: either answer is a valid server.
            const had = activeStrategies(before);
            const has = activeStrategies(during);
            let verdict =
              "the environment already had an active strategy, so the question was not exercised";
            if (had === 0) {
              verdict = has > 0 ? "a default strategy WAS added" : "NO default strategy was added";
            }
            console.error(
              `[live sandbox] unleash: enabling an environment with ${String(had)} active strategies left ${String(has)}; ${verdict}`,
            );
          } else {
            console.error(
              "[live sandbox] unleash: the flag started enabled, so this run toggled it off and on; the default-strategy question was not exercised (start it disabled with no strategies to answer it)",
            );
          }
        },
        async () => {
          const back = await toggle(original === true);
          expect(back).toMatchObject({ ok: true, confirmed: true });
        },
      );

      const after = await readState();
      expect(after["enabled"]).toBe(original);
    }));
});
