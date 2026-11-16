import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetConnectorModeForTests, setConnectorMode } from "./connector-mode.ts";
import type { ZodObjectSchema } from "./mcp-tool-kit.ts";
import {
  buildReadOnlyMcpConnector,
  runReadOnlyMcpConnector,
} from "./run-read-only-mcp-connector.ts";

type SyntheticArgs = { readonly id?: string };

function syntheticSchema(): ZodObjectSchema<SyntheticArgs> {
  return {
    shape: { id: {} },
    safeParse: (args: unknown) => ({
      success: true as const,
      data: args ?? {},
    }),
  };
}

beforeEach(resetConnectorModeForTests);
afterEach(resetConnectorModeForTests);

describe("buildReadOnlyMcpConnector", () => {
  test("passes serverName and version 0.1.0 to the createConnector factory", () => {
    const factory = mock((_info: { readonly name: string; readonly version: string }) => ({
      server: { tool: () => undefined },
      start: async () => undefined,
    }));
    buildReadOnlyMcpConnector("nimbus-acme", () => undefined, { createConnector: factory });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]?.[0]).toEqual({ name: "nimbus-acme", version: "0.1.0" });
  });

  test("invokes register with a registrar that delegates to server.tool", () => {
    const toolSpy = mock((..._args: unknown[]) => undefined);
    const fakeServer = { tool: toolSpy };
    buildReadOnlyMcpConnector(
      "nimbus-acme",
      (reg) => {
        reg("acme_list", "List acme items", syntheticSchema(), async () => ({
          content: [{ type: "text", text: "[]" }],
        }));
        reg("acme_get", "Get one acme item", syntheticSchema(), async () => ({
          content: [{ type: "text", text: "{}" }],
        }));
      },
      { createConnector: () => ({ server: fakeServer, start: async () => undefined }) },
    );
    expect(toolSpy).toHaveBeenCalledTimes(2);
    expect(toolSpy.mock.calls[0]?.[0]).toBe("acme_list");
    expect(toolSpy.mock.calls[0]?.[1]).toBe("List acme items");
    expect(toolSpy.mock.calls[1]?.[0]).toBe("acme_get");
  });

  test("returns the constructed server instance, and hands the same one to register", () => {
    const fakeServer = { tool: () => undefined };
    let handed: unknown;
    const result = buildReadOnlyMcpConnector(
      "nimbus-acme",
      (_reg, server) => {
        handed = server;
      },
      { createConnector: () => ({ server: fakeServer, start: async () => undefined }) },
    );
    expect(result).toBe(fakeServer);
    expect(handed).toBe(fakeServer);
  });

  /**
   * The DEFAULT arm is the production one — every connector entry point calls these functions
   * with no options at all. Injecting the seam in every test would leave exactly the code that
   * ships uncovered. Building a server is inert in both modes: nothing touches stdio until it is
   * started.
   */
  test("defaults to createConnectorServer: the layer server standalone, the upstream one for the gateway", () => {
    const standalone = buildReadOnlyMcpConnector("nimbus-acme", () => undefined);
    expect("layer" in (standalone as object)).toBe(true);

    resetConnectorModeForTests();
    setConnectorMode("gateway");
    const gateway = buildReadOnlyMcpConnector("nimbus-acme", () => undefined);
    expect("layer" in (gateway as object)).toBe(false);
    expect(typeof (gateway as { connect?: unknown }).connect).toBe("function");
  });
});

/**
 * This is the function every connector entry point actually calls. The `createConnector` seam
 * makes the wiring between the server and its start assertable without serving on the test
 * process's stdio.
 */
describe("runReadOnlyMcpConnector", () => {
  test("starts the built server, once", async () => {
    const start = mock(async () => undefined);
    await runReadOnlyMcpConnector("nimbus-acme", () => undefined, {
      createConnector: () => ({ server: { tool: () => undefined }, start }),
    });
    expect(start).toHaveBeenCalledTimes(1);
  });

  test("registers the caller's tools before starting", async () => {
    const order: string[] = [];
    const toolSpy = mock((..._a: unknown[]) => {
      order.push("register");
    });
    await runReadOnlyMcpConnector(
      "nimbus-acme",
      (reg) => {
        reg("acme_list", "List acme items", syntheticSchema(), async () => ({
          content: [{ type: "text", text: "[]" }],
        }));
      },
      {
        createConnector: () => ({
          server: { tool: toolSpy },
          start: async () => {
            order.push("start");
          },
        }),
      },
    );

    // A tool registered after the start would be invisible to the client that is already
    // handshaking.
    expect(order).toEqual(["register", "start"]);
  });

  test("propagates a start failure rather than resolving silently", async () => {
    await expect(
      runReadOnlyMcpConnector("nimbus-acme", () => undefined, {
        createConnector: () => ({
          server: { tool: () => undefined },
          start: async () => {
            throw new Error("stdio unavailable");
          },
        }),
      }),
    ).rejects.toThrow(/stdio unavailable/);
  });
});
