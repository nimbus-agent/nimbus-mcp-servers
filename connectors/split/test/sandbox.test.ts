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
import { registerSplitTools } from "../src/tools.ts";

const manifestPath = resolve(fileURLToPath(import.meta.url), "../../nimbus.extension.json");

describe.skipIf(!process.env["NIMBUS_TEST_HARNESS"])("sandbox contract", () => {
  it("respects declared permissions", async () => {
    await expect(runSandboxContractTests(manifestPath)).resolves.toBeUndefined();
  });
});

/**
 * LIVE: kills ONE throwaway split the owner created, in ONE environment, and restores it. Nothing
 * else is read or written. Runs only under `bun run test:sandbox` with every variable set.
 */
const live = liveSandboxGate("split live writes: split_kill and split_restore", [
  "SPLIT_ADMIN_API_KEY",
  "SPLIT_SANDBOX_WORKSPACE_ID",
  "SPLIT_SANDBOX_SPLIT",
  "SPLIT_SANDBOX_ENVIRONMENT",
]);

/** The same environment named by a name with a space in it (`Sandbox EU`); optional. */
const spacedName = (process.env["SPLIT_SANDBOX_ENVIRONMENT_NAME"] ?? "").trim();

describe.skipIf(!live.enabled)(live.title, () => {
  const workspaceId = live.values["SPLIT_SANDBOX_WORKSPACE_ID"] ?? "";
  const splitName = live.values["SPLIT_SANDBOX_SPLIT"] ?? "";

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

  /** Kill, confirm, restore, confirm, for the split in `environment` (an id or a name). */
  async function killAndRestore(environment: string): Promise<void> {
    const target = { workspaceId, splitName, environment };
    // The write scope names exactly the throwaway split, so the consent kit refuses any other.
    const scope = {
      NIMBUS_MCP_SPLIT_WRITE_SCOPE: `flag:${workspaceId}/${environment}/${splitName}`,
    };

    const read = async (): Promise<Record<string, unknown>> => {
      const answer = await withEnv(scope, () =>
        captureStandaloneTools(registerSplitTools, { elicitation: true }).tools.callJson(
          "split_definition_get",
          target,
        ),
      );
      expect(typeof answer).toBe("object");
      return answer as Record<string, unknown>;
    };
    const write = async (
      tool: "split_kill" | "split_restore",
    ): Promise<Record<string, unknown>> => {
      const run = await approvedStandaloneWrite(registerSplitTools, scope, tool, target);
      expect(run.chain.ok).toBe(true);
      return run.answer as Record<string, unknown>;
    };

    const before = await read();
    // Refuse to start from a killed split: restoring it at the end would change a state the owner
    // chose, and the run could not tell a restore it caused from one it found.
    if (before["killed"] !== false) {
      throw new Error(
        `split ${splitName} in ${environment} reads killed=${String(before["killed"])}; restore it (or pick another throwaway split) before this test kills it`,
      );
    }

    let killed = false;
    await withCleanup(
      `Split ${scope.NIMBUS_MCP_SPLIT_WRITE_SCOPE} should be restored (not killed)`,
      async () => {
        const answer = await write("split_kill");
        killed = true;
        expect(answer).toMatchObject({ ok: true, confirmed: true, killed: true });
        expect((await read())["killed"]).toBe(true);
      },
      async () => {
        // Restore even when the kill threw after Split applied it: an unneeded restore of a split
        // that is not killed is harmless, a skipped one leaves it killed.
        const answer = await write("split_restore");
        expect(answer).toMatchObject({ ok: true, confirmed: true, killed: false });
        killed = false;
      },
    );

    expect(killed).toBe(false);
    expect((await read())["killed"]).toBe(false);
  }

  it("kills the throwaway split in SPLIT_SANDBOX_ENVIRONMENT, confirms it, and restores it", async () => {
    await standalone(() => killAndRestore(live.values["SPLIT_SANDBOX_ENVIRONMENT"] ?? ""));
  });

  it.skipIf(spacedName === "")(
    spacedName === ""
      ? "kills and restores by an environment name with a space (skipped: set SPLIT_SANDBOX_ENVIRONMENT_NAME)"
      : "kills and restores by an environment name with a space (SPLIT_SANDBOX_ENVIRONMENT_NAME)",
    async () => {
      expect(spacedName).toContain(" ");
      await standalone(() => killAndRestore(spacedName));
    },
  );
});
