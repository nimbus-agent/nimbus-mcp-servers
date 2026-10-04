/**
 * `bin.ts` is the package's `nimbus-connector` process, and its whole job is one rule: run the
 * launcher on argv and exit ONLY when the launch failed. Exiting on success would tear down the
 * server the launcher just started — most connectors connect at module scope, so the import inside
 * the launcher resolves while that server is live, and the connected transport is what keeps the
 * process running.
 *
 * It is a top-level script with no export, so each case imports it afresh — a query string makes a
 * new module instance — with argv set the way a shell sets it and `process.exit` stubbed.
 */

import { afterEach, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import {
  bootOverStubbedStdio,
  connectOverStubbedStdio,
  withEnv,
} from "../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests } from "../../shared/connector-mode.ts";

let exit: Mock<typeof process.exit>;

beforeEach(() => {
  exit = spyOn(process, "exit").mockImplementation((() => undefined) as never);
  resetConnectorModeForTests();
});

afterEach(() => {
  exit.mockRestore();
  resetConnectorModeForTests();
});

/** Evaluate a fresh copy of bin.ts as `nimbus-connector <args…>`. */
async function runBin(args: readonly string[], instance: string): Promise<void> {
  const argv = process.argv;
  process.argv = [argv[0] ?? "bun", "nimbus-connector", ...args];
  try {
    await import(`./bin.ts?${instance}`);
  } finally {
    process.argv = argv;
  }
}

test("does not exit once the connector is up, and the connector serves", async () => {
  // snowflake is a guarded entry point, so starting it here builds a fresh server rather than
  // re-importing a module another test file may already have booted.
  const stdio = await withEnv({ NIMBUS_MCP_SNOWFLAKE_WRITE_SCOPE: "object:db.s.t" }, () =>
    bootOverStubbedStdio(() => runBin(["snowflake"], "started")),
  );
  expect(exit).not.toHaveBeenCalled();
  const client = await connectOverStubbedStdio(stdio);
  try {
    expect(client.getServerVersion()?.name).toBe("nimbus-snowflake");
  } finally {
    await client.close();
  }
});

// Declared after the success case on purpose: bun reports a re-imported module's line coverage from
// its LAST evaluation, and this is the path that runs every line of bin.ts.
test("exits with the launcher's own code when the launch fails, and says why", async () => {
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  let written: unknown[][] = [];
  try {
    await runBin(["definitely-not-a-connector"], "unknown");
    written = [...stderr.mock.calls];
  } finally {
    stderr.mockRestore();
  }
  expect(exit.mock.calls).toEqual([[2]]);
  expect(written).toEqual([['unknown connector "definitely-not-a-connector"\n']]);
});
