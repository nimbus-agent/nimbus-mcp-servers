/**
 * The contract every extracted connector tool surface must satisfy.
 *
 * These are properties, not examples: they are asserted against every connector
 * that exposes a `register<Name>Tools(reg)` entry, discovered from the tree
 * rather than listed, so a connector added tomorrow is covered the day it lands
 * and cannot quietly opt out.
 *
 * The two that matter most are security properties that no per-connector test
 * was checking:
 *
 *   - a tool whose credential is missing must REFUSE BEFORE it sends anything.
 *     A connector that fetches first and authenticates second leaks the request
 *     (and the fact of it) to the upstream API on every misconfigured install.
 *   - every request a tool makes must be https and must carry a credential.
 *     A tool that drops the auth header on one code path is an anonymous
 *     request against a private API, which fails in a confusing way at best.
 *
 * Neither is expressible as a per-connector example without writing it ~250
 * times, which is exactly why they were not being checked.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resetConnectorModeForTests, setConnectorMode } from "../shared/connector-mode.ts";
import {
  type CapturedTools,
  captureTools,
  stubFetch,
  stubSpawn,
} from "./connector-tool-harness.ts";
import { fixtureFor, type ParsableSchema } from "./tool-arg-fixture.ts";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const CONNECTORS = join(ROOT, "connectors");

/**
 * Connectors excluded from the HTTP properties, each with the reason. Not a
 * convenience list: every entry is a connector whose tools do not make
 * credentialed HTTP requests, so the properties below are not about them.
 */
const NOT_HTTP = new Map<string, string>([
  ["localdb", "reads local SQLite/DuckDB files; no network"],
  ["dataprofile", "profiles local files; no network"],
  ["great-expectations", "parses local GX result JSON; no network"],
  ["obsidian", "reads a local vault directory; no network"],
  ["storybook", "reads a local storybook static build; no network"],
  ["workday", "spawns the Workday CLI rather than fetching"],
  ["iac", "spawns terraform/opentofu rather than fetching"],
  ["apple", "drives local AppleScript/CalDAV, not a bearer API"],
  ["fastmail", "JMAP session bootstrap, asserted by its own test"],
  ["imap", "IMAP/SMTP sockets, covered by shared/imapflow-adapter.test.ts"],
  ["protonmail", "IMAP/SMTP sockets, covered by shared/imapflow-adapter.test.ts"],
]);

/**
 * Connectors that reach their service by spawning a CLI, with the binary.
 *
 * These have no credential of their own — the CLI holds the session — so the
 * HTTP properties do not describe them. What DOES describe them is the `cli
 * contract` block below: they must invoke the binary they are named for, and
 * nothing else. Running them without a spawn stub runs the real binaries, which
 * is both slow (two seconds for `az` alone) and a genuine subprocess on
 * whatever machine runs the suite.
 */
const CLI_BACKED = new Map<string, readonly string[]>([
  ["aws", ["aws"]],
  ["athena", ["aws"]],
  ["cloudwatch", ["aws"]],
  ["sagemaker", ["aws"]],
  ["cloud-logging", ["gcloud"]],
  ["vertex-ai", ["gcloud"]],
  // gcp reaches GKE through kubectl as well as gcloud; bigquery drives the
  // BigQuery API through `gcloud`, not the standalone `bq` its name suggests.
  ["gcp", ["gcloud", "kubectl"]],
  ["bigquery", ["gcloud"]],
  ["azure", ["az"]],
  ["kubernetes", ["kubectl"]],
]);

/**
 * The literal every discovered credential variable is set to, so a request can
 * be searched for it.
 *
 * Checking for a KNOWN HEADER NAME instead was the first attempt and it was
 * wrong on four connectors, in four different legitimate ways: Dagster uses
 * `Dagster-Cloud-Api-Token`, Pipedrive puts its token in the query string as
 * that API requires, and Superset's login and Wiz's OAuth exchange carry their
 * credentials in the request BODY because that is what an auth exchange is. A
 * header allowlist would have to be extended for each, and would then assert
 * nothing beyond "this name is on the list". Searching the whole request for the
 * value asserts the thing actually worth asserting: the credential reached the
 * request somehow.
 */
const CREDENTIAL_VALUE = "test-credential";

/** The body a failing upstream answers with, so an error can be traced to it. */
const UPSTREAM_BODY = "upstream is down";

/**
 * Connectors that legitimately demand no credential, with the reason.
 *
 * This list is what makes the credential assertions bite. Without it, a
 * connector that stopped reading its API key at all would demand nothing, and
 * every per-tool credential check would find nothing to check and pass — which
 * is precisely how a dropped `Authorization` header would reach production.
 * Verified by mutation: deleting Stripe's auth header is caught here and
 * nowhere else.
 */
const KEYLESS = new Map<string, string>([
  ["prefect", "self-hosted Prefect Server may run without an API key; the header is optional"],
]);

/**
 * Connectors whose registrar takes injected domain collaborators, not just the
 * server, with the reason.
 *
 * `registerAppleTools(server, params)` and `registerFastmailTools(server,
 * client)` cannot be driven by a generic recorder because their second argument
 * is an IMAP/CalDAV/JMAP client, not a registration surface. Each already has a
 * dedicated test that supplies a real fake for it; a generic pass here would
 * add nothing they do not already assert.
 */
const NEEDS_COLLABORATORS = new Map<string, string>([
  ["apple", "registerAppleTools(server, { client, mailer, calendar, … })"],
  ["fastmail", "registerFastmailTools(server, jmapClient)"],
  ["imap", "registerImapTools(server, imapClient, smtpMailer)"],
  ["protonmail", "registerProtonmailTools(server, imapClient, smtpMailer)"],
]);

/**
 * Argument values a Zod schema cannot express, per connector.
 *
 * `z.string().min(1)` is satisfied by `"x"`, but a Firebase app id is
 * `1:<projectNumber>:<platform>:<hash>` and the connector derives the project
 * number from its second segment. The generic fixture is therefore rejected
 * before any credential is read, which made every credential assertion for that
 * connector vacuous. An override here is narrower and more honest than loosening
 * the assertions for everyone.
 */
const ARG_OVERRIDES = new Map<string, Record<string, unknown>>([
  ["firebase", { appId: "1:1234567890:android:abcdef0123456789" }],
  // CircleCI's pipeline and workflow ids are `z.uuid()`; no generic string
  // satisfies that.
  [
    "circleci",
    {
      pipelineId: "00000000-0000-4000-8000-000000000000",
      workflowId: "00000000-0000-4000-8000-000000000000",
    },
  ],
]);

interface ConnectorToolSurface {
  readonly id: string;
  readonly register: (reg: never) => void;
  readonly declaredNames: readonly string[] | undefined;
}

function connectorIds(): string[] {
  return readdirSync(CONNECTORS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * Load a connector's `tools.ts` and pick out its registrar.
 *
 * Only the single-argument form is taken. The connectors whose registrar also
 * needs the live MCP server (the ones with consent-gated write tools) build
 * their registrar from it, so they cannot be driven by a bare `reg` and are
 * covered by their own tests instead.
 */
async function loadSurface(id: string): Promise<ConnectorToolSurface | undefined> {
  if (NEEDS_COLLABORATORS.has(id)) {
    return undefined;
  }
  const mod = await importToolModule(id);
  if (mod === undefined) {
    return undefined;
  }
  const entry = Object.entries(mod).find(
    ([name, value]) =>
      /^register[A-Za-z]+Tools$/.test(name) &&
      typeof value === "function" &&
      (value.length === 1 || value.length === 2),
  );
  if (entry === undefined) {
    return undefined;
  }
  const names = Object.entries(mod).find(([name]) => name.endsWith("_TOOL_NAMES"))?.[1];
  return {
    id,
    register: entry[1] as (reg: never) => void,
    declaredNames: Array.isArray(names) ? (names as string[]) : undefined,
  };
}

/**
 * Import the module holding a connector's registrar: `src/tools.ts` when it has
 * one, otherwise `src/server.ts` — but only when that entry point guards its
 * bootstrap behind `import.meta.main`.
 *
 * The guard is the whole condition. Ten connectors export their registrar from
 * `server.ts` and start the transport only when run directly, so importing them
 * is safe and they need no refactoring to be covered. Importing an UNGUARDED
 * entry point would open a real stdio transport inside the test process, which
 * is exactly why those files were unreachable from a test in the first place.
 */
async function importToolModule(id: string): Promise<Record<string, unknown> | undefined> {
  const tools = join(CONNECTORS, id, "src", "tools.ts");
  if (existsSync(tools)) {
    try {
      return (await import(tools)) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  const server = join(CONNECTORS, id, "src", "server.ts");
  if (!existsSync(server) || !readFileSync(server, "utf8").includes("import.meta.main")) {
    return undefined;
  }
  try {
    return (await import(server)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const surfaces: ConnectorToolSurface[] = [];
for (const id of connectorIds()) {
  const surface = await loadSurface(id);
  if (surface !== undefined) {
    surfaces.push(surface);
  }
}

/**
 * Configuration a connector reads while REGISTERING rather than while handling
 * a call, with the value to register under.
 *
 * Obsidian resolves its vault list up front so a tool cannot be registered
 * against a path the operator never granted. That is a deliberate design, but
 * it means the connector cannot be captured at all without the variable — not
 * that it has no tools.
 */
const REGISTRATION_ENV = new Map<string, Record<string, string>>([
  ["obsidian", { OBSIDIAN_VAULT_PATHS_JSON: '["/tmp/nimbus-contract-vault"]' }],
]);

function capture(surface: ConnectorToolSurface): CapturedTools {
  const setup = REGISTRATION_ENV.get(surface.id);
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(setup ?? {})) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return captureTools(surface.register as Parameters<typeof captureTools>[0]);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/**
 * The two phrasings the tree uses to report unset configuration.
 *
 * `"<VAR> is not set"` is the common one; Datadog and Jenkins name a PAIR —
 * `"DD_API_KEY and DD_APP_KEY must be set"` — because either alone is useless.
 * Matching only the first phrasing made both connectors look as though they
 * demanded no credential at all, which is the opposite of true.
 */
const REFUSAL = /(?:is not set|must be set)/;
const ENV_NAME = /[A-Z][A-Z0-9_]{2,}/g;

/** The variables a refusal message names, or `[]` when it is not a refusal. */
function missingEnvVars(message: string): string[] {
  return REFUSAL.test(message) ? (message.match(ENV_NAME) ?? []) : [];
}

/**
 * Set the environment variables a call demands, one refusal at a time, and
 * report them. Returns `undefined` when the call fails for some other reason —
 * the caller then knows the tool never got as far as needing credentials.
 */
async function satisfyEnv(
  call: () => Promise<unknown>,
  assigned: Set<string>,
): Promise<Error | undefined> {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      await call();
      return undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const named = missingEnvVars(message).filter((name) => !assigned.has(name));
      if (named.length === 0) {
        return err instanceof Error ? err : new Error(message);
      }
      for (const name of named) {
        assigned.add(name);
        process.env[name] = envValue(name);
      }
    }
  }
  return new Error("gave up satisfying the environment after 12 attempts");
}

/** A value plausible for the variable's name — URLs must parse to be usable. */
function envValue(name: string): string {
  return /(_URL|_HOST|_BASE|_ENDPOINT|_INSTANCE)$/.test(name)
    ? "https://connector.test"
    : CREDENTIAL_VALUE;
}

/**
 * Every place a credential could legitimately be, as plain text.
 *
 * The base64 decode is not incidental: five connectors (Airflow, Greenhouse,
 * Lever, Zendesk, Ramp) authenticate with HTTP Basic, so the credential is
 * present but encoded, and a plain substring search reported all five as
 * sending no credential at all. Decoding the Basic payload is what makes the
 * assertion true of Basic auth rather than only of Bearer.
 */
function searchable(call: {
  url: string;
  headers: Record<string, string>;
  body?: string;
}): string[] {
  const parts = [call.url, JSON.stringify(call.headers), call.body ?? ""];
  const basic = /^Basic (.+)$/.exec(call.headers["authorization"] ?? "");
  if (basic?.[1] !== undefined) {
    try {
      parts.push(Buffer.from(basic[1], "base64").toString("utf8"));
    } catch {
      // A malformed payload is simply not a place the credential is.
    }
  }
  return parts;
}

/** The fixture for one tool, with any connector-specific overrides applied. */
function argsFor(
  surface: ConnectorToolSurface,
  tools: CapturedTools,
  name: string,
): Record<string, unknown> | undefined {
  return fixtureFor(tools.get(name).schema as ParsableSchema, ARG_OVERRIDES.get(surface.id) ?? {});
}

function clearEnv(names: Iterable<string>): void {
  for (const name of names) {
    delete process.env[name];
  }
}

describe("connector tool surfaces", () => {
  // Gateway mode is the shape these assertions are about: the connector registers
  // its whole surface and the gateway executor is the consent gate, so the write
  // tools are present to assert on. Reset on both sides — bun runs every test
  // file in ONE process, and the mode is process-global.
  beforeAll(() => {
    resetConnectorModeForTests();
    setConnectorMode("gateway");
  });
  afterAll(() => {
    resetConnectorModeForTests();
  });

  it("discovers the extracted connectors", () => {
    // A guard against the trap this repo has already been bitten by: a green
    // run that examined nothing. If discovery breaks, this fails rather than
    // reporting a vacuous pass for every property below.
    expect(surfaces.length).toBeGreaterThan(40);
  });

  for (const surface of surfaces) {
    describe(surface.id, () => {
      it("registers at least one tool, each named `<connector>_<verb>`", () => {
        const names = capture(surface).names();
        expect(names.length).toBeGreaterThan(0);
        for (const name of names) {
          expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
        }
      });

      const declared = surface.declaredNames;
      if (declared !== undefined) {
        it("registers exactly the tools its *_TOOL_NAMES export declares", () => {
          expect(capture(surface).names()).toEqual([...declared].sort());
        });
      }

      it("gives every tool a description distinct from its name", () => {
        // Deliberately not a length floor. The first attempt required 30
        // characters and then 15, and each threshold failed on descriptions
        // that are genuinely fine — datadog's "List monitors.",
        // bigeye's "Acknowledge a Bigeye issue." A test that fails on correct
        // code to enforce an unwritten style rule is worse than no test. What
        // is actually a defect is an EMPTY description, or one that just echoes
        // the tool name and so tells a model nothing it does not already have.
        const tools = capture(surface);
        for (const name of tools.names()) {
          const description = tools.get(name).description.trim();
          expect({ name, ok: description !== "" && description !== name }).toEqual({
            name,
            ok: true,
          });
        }
      });

      it("can be called with arguments its own schema accepts", () => {
        // This is what makes every assertion below non-vacuous: they all drive
        // the tools through `argsFor`, so if it could not produce valid
        // arguments the calls would fail on validation and never reach the
        // behaviour under test.
        const tools = capture(surface);
        for (const name of tools.names()) {
          const schema = tools.get(name).schema as ParsableSchema;
          const args = argsFor(surface, tools, name) ?? {};
          expect({ name, accepted: args !== undefined && schema.safeParse(args).success }).toEqual({
            name,
            accepted: true,
          });
        }
      });

      const cliBinaries = CLI_BACKED.get(surface.id);
      const skip =
        NOT_HTTP.get(surface.id) ??
        (cliBinaries === undefined ? undefined : `CLI-backed (${cliBinaries.join(", ")})`);
      const describeHttp = skip === undefined ? describe : describe.skip;

      if (cliBinaries !== undefined) {
        describe("cli contract", () => {
          it(`invokes only ${cliBinaries.join(" / ")}`, async () => {
            const tools = capture(surface);
            for (const name of tools.names()) {
              const args = argsFor(surface, tools, name) ?? {};
              const assigned = new Set<string>();
              const spawn = stubSpawn({ stdout: "{}" });
              const http = stubFetch({ body: "{}" });
              try {
                await satisfyEnv(() => tools.call(name, args), assigned);
                for (const call of spawn.calls) {
                  expect({
                    name,
                    binary: call.command[0],
                    allowed: cliBinaries.includes(call.command[0] ?? ""),
                  }).toEqual({ name, binary: call.command[0], allowed: true });
                }
                // A CLI-backed connector may also speak HTTP: bigquery mints a
                // token with `gcloud auth print-access-token` and then calls the
                // BigQuery REST API with it. That second path still has to be
                // https — it carries the minted token.
                for (const call of http.calls) {
                  expect({ name, scheme: call.url.slice(0, 8) }).toEqual({
                    name,
                    scheme: "https://",
                  });
                }
              } finally {
                http.restore();
                spawn.restore();
                clearEnv(assigned);
              }
            }
          });

          it("reports a failing CLI rather than returning a success envelope", async () => {
            const tools = capture(surface);
            for (const name of tools.names()) {
              const args = argsFor(surface, tools, name) ?? {};
              const assigned = new Set<string>();
              const ok = stubSpawn({ stdout: "{}" });
              try {
                await satisfyEnv(() => tools.call(name, args), assigned);
                ok.restore();
                const failing = stubSpawn({ exitCode: 2, stderr: UPSTREAM_BODY });
                try {
                  const outcome = await tools.call(name, args).then(
                    (r) => JSON.stringify(r),
                    (e: unknown) => (e as Error).message,
                  );
                  if (failing.calls.length > 0) {
                    expect({ name, mentionsFailure: outcome.includes(UPSTREAM_BODY) }).toEqual({
                      name,
                      mentionsFailure: true,
                    });
                  }
                } finally {
                  failing.restore();
                }
              } finally {
                ok.restore();
                clearEnv(assigned);
              }
            }
          });
        });
      }

      describeHttp(`http contract${skip === undefined ? "" : ` (skipped: ${skip})`}`, () => {
        it("demands a credential from the environment", async () => {
          const tools = capture(surface);
          const assigned = new Set<string>();
          const stub = stubFetch({ body: "{}" });
          try {
            for (const name of tools.names()) {
              const args = argsFor(surface, tools, name) ?? {};
              await satisfyEnv(() => tools.call(name, args), assigned);
            }
            const credentials = [...assigned].filter((v) => process.env[v] === CREDENTIAL_VALUE);
            const keyless = KEYLESS.get(surface.id);
            expect({
              connector: surface.id,
              demandsCredential: credentials.length > 0 || keyless !== undefined,
            }).toEqual({ connector: surface.id, demandsCredential: true });
          } finally {
            stub.restore();
            clearEnv(assigned);
          }
        });

        it("refuses before sending anything when a credential is missing", async () => {
          const tools = capture(surface);
          const assigned = new Set<string>();
          for (const name of tools.names()) {
            const args = argsFor(surface, tools, name) ?? {};
            const stub = stubFetch({ body: "{}" });
            try {
              // Discover this tool's variables, then clear them and re-run: the
              // tool must refuse by name, and must not have touched the network.
              await satisfyEnv(() => tools.call(name, args), assigned);
              clearEnv(assigned);
              const before = stub.calls.length;
              const err = await tools.call(name, args).then(
                () => undefined,
                (e: unknown) => e as Error,
              );
              if (assigned.size > 0) {
                expect({
                  name,
                  namesTheMissingVariable: missingEnvVars(err?.message ?? "").length > 0,
                }).toEqual({ name, namesTheMissingVariable: true });
                expect({ name, requests: stub.calls.length - before }).toEqual({
                  name,
                  requests: 0,
                });
              }
            } finally {
              stub.restore();
              clearEnv(assigned);
              assigned.clear();
            }
          }
        });

        it("sends every request over https", async () => {
          const tools = capture(surface);
          for (const name of tools.names()) {
            const args = argsFor(surface, tools, name) ?? {};
            const assigned = new Set<string>();
            const stub = stubFetch({ body: "{}" });
            try {
              await satisfyEnv(() => tools.call(name, args), assigned);
              for (const call of stub.calls) {
                expect({ name, scheme: call.url.slice(0, 8) }).toEqual({
                  name,
                  scheme: "https://",
                });
              }
            } finally {
              stub.restore();
              clearEnv(assigned);
            }
          }
        });

        it("carries the credential it demanded into the request it makes", async () => {
          const tools = capture(surface);
          for (const name of tools.names()) {
            const args = argsFor(surface, tools, name) ?? {};
            const assigned = new Set<string>();
            const stub = stubFetch({ body: "{}" });
            try {
              await satisfyEnv(() => tools.call(name, args), assigned);
              const credentials = [...assigned].filter((v) => process.env[v] === CREDENTIAL_VALUE);
              // A connector with no credential variable at all is keyless by
              // design (self-hosted Prefect Server is the one in the tree);
              // there is nothing to carry, so there is nothing to assert.
              if (credentials.length === 0 || stub.calls.length === 0) {
                continue;
              }
              const carried = stub.calls.some((call) =>
                searchable(call).some((part) => part.includes(CREDENTIAL_VALUE)),
              );
              expect({ name, demanded: credentials, carried }).toEqual({
                name,
                demanded: credentials,
                carried: true,
              });
            } finally {
              stub.restore();
              clearEnv(assigned);
            }
          }
        });

        it("fails loudly, quoting the upstream, when the API rejects the call", async () => {
          const tools = capture(surface);
          for (const name of tools.names()) {
            const args = argsFor(surface, tools, name) ?? {};
            const assigned = new Set<string>();
            const ok = stubFetch({ body: "{}" });
            try {
              // Learn the variables against a 200 first, so the failure below is
              // the API refusing rather than the connector refusing.
              await satisfyEnv(() => tools.call(name, args), assigned);
              ok.restore();
              const failing = stubFetch({ status: 503, body: UPSTREAM_BODY });
              try {
                const err = await tools.call(name, args).then(
                  () => undefined,
                  (e: unknown) => e as Error,
                );
                if (failing.calls.length > 0) {
                  // Deliberately not "the message contains 503". Slack and Teams
                  // answer 200 with `{ ok: false, error: … }` — an HTTP status is
                  // not where their failures live — so they quote the upstream
                  // body instead. Both are correct; what would be a defect is a
                  // tool that swallows the failure and returns a success
                  // envelope, or that rejects with nothing the caller can act on.
                  expect({
                    name,
                    rejected: err !== undefined,
                    quotesUpstream:
                      err?.message.includes("503") === true ||
                      err?.message.includes(UPSTREAM_BODY) === true,
                  }).toEqual({ name, rejected: true, quotesUpstream: true });
                }
              } finally {
                failing.restore();
              }
            } finally {
              ok.restore();
              clearEnv(assigned);
            }
          }
        });
      });
    });
  }
});
