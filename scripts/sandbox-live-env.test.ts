import { describe, expect, test } from "bun:test";
import { liveSandboxGate, sandboxName, withCleanup } from "./sandbox-live-env.ts";

describe("liveSandboxGate", () => {
  const REQUIRED = ["DEMO_TOKEN", "DEMO_TARGET"] as const;

  test("is off, silently, outside the harness even with every variable set", () => {
    const logged: string[] = [];
    const gate = liveSandboxGate(
      "demo",
      REQUIRED,
      { DEMO_TOKEN: "t", DEMO_TARGET: "x" },
      (line) => {
        logged.push(line);
      },
    );
    expect(gate.enabled).toBe(false);
    expect(gate.title).toBe("demo (skipped: only under bun run test:sandbox)");
    expect(logged).toEqual([]);
  });

  test("under the harness, names every unset or blank variable and announces the skip", () => {
    const logged: string[] = [];
    const gate = liveSandboxGate(
      "demo",
      REQUIRED,
      { NIMBUS_TEST_HARNESS: "1", DEMO_TOKEN: "secret-value", DEMO_TARGET: "  " },
      (line) => {
        logged.push(line);
      },
    );
    expect(gate.enabled).toBe(false);
    expect(gate.missing).toEqual(["DEMO_TARGET"]);
    expect(gate.title).toBe("demo (skipped: set DEMO_TARGET)");
    expect(logged).toEqual(["[live sandbox] demo: skipped: set DEMO_TARGET"]);
    // A value is never printed, only variable names.
    expect(logged.join("\n")).not.toContain("secret-value");
  });

  test("runs under the harness with every variable set, values trimmed", () => {
    const gate = liveSandboxGate(
      "demo",
      REQUIRED,
      { NIMBUS_TEST_HARNESS: "1", DEMO_TOKEN: "t", DEMO_TARGET: " x " },
      () => undefined,
    );
    expect(gate).toEqual({
      enabled: true,
      missing: [],
      title: "demo",
      values: { DEMO_TOKEN: "t", DEMO_TARGET: "x" },
    });
  });
});

test("sandboxName is obviously a test name", () => {
  expect(sandboxName(undefined, 42)).toBe("nimbus-sandbox-42");
  expect(sandboxName("timed", 42)).toBe("nimbus-sandbox-42-timed");
});

describe("withCleanup", () => {
  test("cleans up after a body that succeeds, and returns its value", async () => {
    const order: string[] = [];
    const value = await withCleanup(
      "x",
      () => {
        order.push("body");
        return Promise.resolve(7);
      },
      () => {
        order.push("cleanup");
        return Promise.resolve();
      },
    );
    expect(value).toBe(7);
    expect(order).toEqual(["body", "cleanup"]);
  });

  test("cleans up after a body that throws, and rethrows the body's error", async () => {
    let cleaned = false;
    await expect(
      withCleanup(
        "x",
        () => Promise.reject(new Error("body failed")),
        () => {
          cleaned = true;
          return Promise.resolve();
        },
      ),
    ).rejects.toThrow("body failed");
    expect(cleaned).toBe(true);
  });

  test("a failed cleanup is logged with what to fix, and thrown only when the body passed", async () => {
    const logged: string[] = [];
    const log = (line: string): void => {
      logged.push(line);
    };
    await expect(
      withCleanup(
        () => "flag f",
        () => Promise.resolve(1),
        () => Promise.reject(new Error("restore refused")),
        log,
      ),
    ).rejects.toThrow("restore refused");
    await expect(
      withCleanup(
        "flag g",
        () => Promise.reject(new Error("body failed")),
        () => Promise.reject(new Error("restore refused")),
        log,
      ),
    ).rejects.toThrow("body failed");
    expect(logged).toEqual([
      "[live sandbox] CLEANUP FAILED, fix by hand: flag f: restore refused",
      "[live sandbox] CLEANUP FAILED, fix by hand: flag g: restore refused",
    ]);
  });
});
