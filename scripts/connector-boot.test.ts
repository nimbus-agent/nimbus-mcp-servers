/**
 * Every connector's ENTRY POINT, booted the way the gateway boots it.
 *
 * `connectors/<id>/src/server.ts` is the module the package exports for each connector, the one
 * `nimbus-connector <id>` imports, and the one the gateway's `run-bundled-connector.ts` imports
 * after locking the mode to "gateway" — calling its `startConnector()` when the bootstrap is
 * guarded behind `import.meta.main`. Every connector test drives a `register…Tools` function
 * directly, so until this file 85 of those 94 modules never ran in the suite at all: an entry
 * point that registered the wrong surface, misnamed its server, needed a variable nobody sets or
 * never connected its transport passed every test.
 *
 * Here each one is booted for real — the production server, its stdio transport and the SDK's own
 * client — with only the process's stdin and stdout swapped for in-memory streams while it starts
 * (`bootOverStubbedStdio`). The connectors are DISCOVERED from the tree, so one added tomorrow is
 * booted the day it lands.
 *
 * Each module is imported once per process. An unguarded entry point connects at module scope and
 * a second import is a cached no-op that boots nothing, so no other test file may import one.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DAVClient } from "tsdav";
import { ICLOUD_CALDAV_BOOTSTRAP_URL } from "../connectors/apple/src/adapters.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../shared/connector-mode.ts";
import {
  bootOverStubbedStdio,
  byToolName,
  type ConnectorRegistrar,
  captureTools,
  connectOverStubbedStdio,
  type StubbedStdio,
  withEnv,
} from "./connector-tool-harness.ts";

const CONNECTORS = join(fileURLToPath(import.meta.url), "..", "..", "connectors");

/** Every directory under `connectors/` with an entry point — which is what makes it a connector. */
const ids = readdirSync(CONNECTORS, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(CONNECTORS, e.name, "src", "server.ts")))
  .map((e) => e.name)
  .sort();

/**
 * Booted by a test of their own rather than the generic one, with the reason. Apple's bootstrap
 * logs in to iCloud CalDAV before it serves, so its boot needs that network round-trip answered.
 */
const OWN_TEST = new Set(["apple"]);

/** An empty directory obsidian is pointed at: it registers against the vaults found under it. */
let vaultRoots: string;

beforeAll(() => {
  vaultRoots = mkdtempSync(join(tmpdir(), "nimbus-boot-vaults-"));
});

afterAll(() => {
  rmSync(vaultRoots, { recursive: true, force: true });
});

/**
 * What a bootstrap reads before it can serve, with the stand-in it boots under here.
 *
 * Read at module scope or while registering rather than per call, so an entry point without them
 * throws at import — which is how a misconfigured connector fails at spawn instead of at its first
 * tool call. None of the values reaches a network: the IMAP and SMTP clients open no socket, and
 * the JMAP client discovers no session, until a tool runs.
 */
function bootEnv(id: string): Record<string, string> {
  switch (id) {
    case "fastmail":
      return { FASTMAIL_API_TOKEN: "fm-token" };
    case "imap":
      return {
        IMAP_HOST: "imap.example.test",
        IMAP_USERNAME: "ada",
        IMAP_PASSWORD: "imap-pw",
        IMAP_SMTP_HOST: "smtp.example.test",
        IMAP_SMTP_USERNAME: "ada",
        IMAP_SMTP_PASSWORD: "smtp-pw",
      };
    case "protonmail":
      return {
        PROTONMAIL_USERNAME: "ada",
        PROTONMAIL_PASSWORD: "bridge-pw",
        PROTONMAIL_SMTP_USERNAME: "ada",
        PROTONMAIL_SMTP_PASSWORD: "bridge-pw",
      };
    case "obsidian":
      return { OBSIDIAN_VAULT_PATHS_JSON: JSON.stringify([vaultRoots]) };
    default:
      return {};
  }
}

/** Import a connector's entry point and, when its bootstrap is guarded, start it — as the gateway does. */
async function startEntryPoint(id: string): Promise<void> {
  const mod = (await import(join(CONNECTORS, id, "src", "server.ts"))) as {
    startConnector?: unknown;
  };
  if (typeof mod.startConnector === "function") {
    await (mod.startConnector as () => Promise<void>)();
  }
}

/**
 * The surface a connector's entry point must serve: its `*_TOOL_NAMES` when it declares one —
 * `audit:tool-names` keeps that list equal to what its registrar registers — and otherwise what
 * that registrar registers when captured in the same gateway mode.
 */
async function expectedSurface(id: string): Promise<string[]> {
  const tools = join(CONNECTORS, id, "src", "tools.ts");
  const mod = (await import(
    existsSync(tools) ? tools : join(CONNECTORS, id, "src", "server.ts")
  )) as Record<string, unknown>;
  const declared = Object.entries(mod).find(
    ([name, value]) => name.endsWith("_TOOL_NAMES") && Array.isArray(value),
  )?.[1] as readonly string[] | undefined;
  if (declared !== undefined) {
    return [...declared].sort(byToolName);
  }
  const register = Object.entries(mod).find(
    ([name, value]) => /^register[A-Za-z]+Tools$/.test(name) && typeof value === "function",
  )?.[1];
  if (register === undefined) {
    throw new Error(`${id} has neither a *_TOOL_NAMES list nor a register…Tools to compare with`);
  }
  return captureTools(register as ConnectorRegistrar).names();
}

/** Connect to a booted entry point and assert it is the named server serving its whole surface. */
async function expectServesItsSurface(id: string, stdio: StubbedStdio): Promise<void> {
  const client = await connectOverStubbedStdio(stdio);
  try {
    expect(client.getServerVersion()?.name).toBe(`nimbus-${id}`);
    const served = (await client.listTools()).tools.map((t) => t.name).sort(byToolName);
    expect(served.length).toBeGreaterThan(0);
    expect(served).toEqual(await expectedSurface(id));
  } finally {
    await client.close();
  }
}

beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
});

afterEach(() => {
  resetConnectorModeForTests();
});

describe("every connector entry point, booted as the gateway boots it", () => {
  test("discovers the whole tree, and every connector is booted by exactly one test", () => {
    // A discovery that found nothing would turn every boot below into a test that cannot fail.
    expect(ids.length).toBeGreaterThan(90);
    expect(ids).toContain("apple");
    expect([...OWN_TEST].every((id) => ids.includes(id))).toBe(true);
  });

  test.each(ids.filter((id) => !OWN_TEST.has(id)))(
    "%s serves its whole tool surface over stdio",
    async (id) => {
      const stdio = await withEnv(bootEnv(id), () =>
        bootOverStubbedStdio(() => startEntryPoint(id)),
      );
      await expectServesItsSurface(id, stdio);
    },
  );

  test("apple logs in to iCloud CalDAV and warms its calendars before it serves, and still boots when the warm-up fails", async () => {
    const dav: string[] = [];
    const proto = DAVClient.prototype as unknown as Record<string, unknown>;
    const real = { login: proto["login"], fetchCalendars: proto["fetchCalendars"] };
    proto["login"] = function login(this: { serverUrl: string }): Promise<void> {
      dav.push(`login ${this.serverUrl}`);
      return Promise.resolve();
    };
    proto["fetchCalendars"] = (): Promise<never> => {
      dav.push("fetchCalendars");
      return Promise.reject(new Error("calendar discovery is down"));
    };
    let stdio: StubbedStdio;
    try {
      stdio = await withEnv(
        { APPLE_ICLOUD_EMAIL: "ada@icloud.test", APPLE_ICLOUD_APP_PASSWORD: "app-pw" },
        () => bootOverStubbedStdio(() => startEntryPoint("apple")),
      );
    } finally {
      Object.assign(proto, real);
    }
    expect(dav).toEqual([`login ${ICLOUD_CALDAV_BOOTSTRAP_URL}`, "fetchCalendars"]);
    await expectServesItsSurface("apple", stdio);
  });
});
