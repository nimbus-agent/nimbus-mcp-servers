# Adding a connector

A connector is a directory under `connectors/<id>/`. The id is lowercase letters, digits and
hyphens — the launcher validates against exactly that set before touching the filesystem.

## The minimum

```
connectors/<id>/
├── README.md                tools, credentials, scopes — for users of this connector
├── nimbus.extension.json    the manifest
├── package.json             private: true, metadata only
├── tsconfig.json            extends ../../tsconfig.base.json
└── src/
    ├── server.ts            the entry point; the launcher requires this exact path
    └── tools.ts             the tool surface: one exported register<Name>Tools()
```

`src/server.ts` is what makes the directory a connector. The consent audit and the launcher both
identify connectors by its presence, so a directory without it is invisible to both.

Two edits outside the directory make it part of the package:

- an `exports` entry in the root `package.json`, `"./<id>": "./connectors/<id>/src/server.ts"` —
  the gateway imports each connector by that specifier, and `scripts/exports-map.test.ts` fails
  without it;
- the connector count `scripts/connector-gates.test.ts` pins (94 today), raised by one. It exists
  so that a discovery change which finds nothing cannot pass as a clean audit.

**Keep `server.ts` a bootstrap.** It reads the environment, builds the clients, calls
`register<Name>Tools(...)` and connects the transport — nothing else:

```ts
import { runReadOnlyMcpConnector } from "../../../shared/run-read-only-mcp-connector.ts";
import { registerAcmeTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-acme", (reg) => {
  registerAcmeTools(reg);
});
```

A module that registers its tools at module scope cannot be imported by a test — importing it opens
a real stdio transport — so its whole tool surface is unreachable from one, and it is excluded from
the connector contract test. That is why the split matters rather than being a matter of taste.

If the connector really must register from `server.ts`, guard the bootstrap with
`if (import.meta.main)` and export both `register<Name>Tools` and `startConnector()`. The guard is
false under an import, so the gateway and the launcher start the connector by calling
`startConnector()`; `bun run audit:connector-entrypoints` fails a guarded entry point that does not
export it.

## The manifest

`nimbus.extension.json` needs `id` (reverse-domain, e.g. `com.nimbus.acme`), `displayName`,
`version`, `entrypoint`, `runtime: "bun"`, `permissions`, `hitlRequired`, `syncInterval` and
`minNimbusVersion`.

`hitlRequired` is the authoritative mutation signal. List `"write"` and `"delete"` there if the
connector mutates anything. It is what the consent audit checks, and it is transport-independent —
true for connectors that mutate through a CLI, the filesystem or a mail protocol, where no HTTP verb
appears in the source.

## The tool surface

Expose what the service supports. Most connectors offer `list`, `get` and `search` over their main
collection, but nothing requires that triple — `iac` exposes plan and apply runs, `datadog` two
lists. The contract test asks for at least one tool, not for any particular set. Read tools
register normally.

Before writing the plumbing, check whether a kit already owns it:

| If your connector… | Use |
| --- | --- |
| GETs JSON from one base URL with a token from the environment | `shared/env-json-api.ts` — `createJsonGetter` + `envAuthHeaders` |
| exposes the plain `list` / `get` / `search` triple over one collection | `shared/collection-tool-kit.ts` — `registerCollectionTools` |
| spawns a cloud CLI and parses its JSON | `shared/cli-json-kit.ts` — `createCliJsonRunner`, and an argument schema for every value that reaches argv |
| speaks IMAP/SMTP | `shared/imapflow-adapter.ts` — `createImapFlowClient`, `createNodemailerMailer` |

A connector that drives a CLI spawns it only through `shared/nimbus-spawn.ts` — `nimbusSpawn`,
`run-cli-json.ts` or `createCliJsonRunner` — and gives every caller-supplied value that reaches
the CLI one of `cli-json-kit.ts`'s schemas: `awsCliArg` for `aws`, `azCliArg` for `az`, `cliArg`
for any other CLI, and `awsCliDocument` for a document handed to `aws` whole.
`scripts/spawn-chokepoint.test.ts` fails a connector that spawns any other way, and
`scripts/cli-argument-guards.test.ts` calls every tool of a connector that spawns and fails an
argument that reaches argv unchecked, so a new CLI connector is held to both the day it lands.

Export the registered names as `<CONNECTOR>_TOOL_NAMES`. `bun run audit:tool-names` fails if that
export drifts from what the connector actually registers; `bun run sync:tool-names` rewrites it.

**Every mutating tool must be registered through `createWriteToolRegistrar`** from
`shared/consent-kit.ts` — never with the raw MCP registration call:

```ts
import { createWriteToolRegistrar } from "../../../shared/consent-kit.ts";

const registerWriteTool = createWriteToolRegistrar(server, {
  /* … */
});
```

That registrar is what enforces consent, the write-scope allow-list and the mutation budget. A
connector that declares `write` or `delete` in `hitlRequired` without registering through it fails
`bun run audit:connector-consent`, and the launcher refuses to start it with exit code `3`.

Do not call `setConnectorMode` anywhere. The mode comes from the entry point; the audit enforces
that, because a second caller could re-gate a connector mid-process.

## Credentials

Read them from `process.env` at startup and fail loudly if absent:

```ts
const token = process.env["ACME_TOKEN"];
if (!token) throw new Error("ACME_TOKEN not set");
```

Never call a Vault API — the connector process has no Vault access by design, in either mode.

A URL that arrives as a tool argument, such as the next-page link a paged tool takes back from an
earlier response, is chosen by the model. Resolve it with `resolveUrlWithBase` from
`shared/fetch-bearer-json.ts` before any request that carries the credential: it refuses an
absolute URL on any other origin. Until October 2026 `bitbucket` fetched its `page` argument as
given, which would have sent the username and app password to whatever host it named.

## Dependencies

The real dependency set is declared once, in the **root** `package.json`. A per-connector
`package.json` is metadata only and is not installed from.

If your connector needs a library the other 93 do not, add it to the root `optionalDependencies` so
a platform that cannot build it does not break every other connector, and document the requirement
in [Configuration](./configuration.md). It must also be pure JavaScript and be added to
`ALLOWED_CONNECTOR_DEPS` in `scripts/check-connector-deps.ts`: the gateway bundles every connector
into one compiled binary, where a native module fails silently, so `bun run audit:connector-deps`
refuses anything off that list. List it in the connector's own `package.json` too — nothing
installs from that file, but GitHub's dependency graph reads it.

## Before you push

```bash
bun run check
```

That is lint, typecheck, every audit and the full suite. CI runs the same on Ubuntu, macOS and
Windows.

A new connector is picked up automatically by `scripts/connector-tool-contract.test.ts`, which will
hold it to the same properties as the other 93 — including that every tool refuses by name before
sending anything when its credential is missing. It needs no registration; if your connector cannot
satisfy a property for a real reason, add it to the annotated exclusion map in that file with the
reason, rather than loosening the property for everyone.

Its entry point is picked up the same way by `scripts/connector-boot.test.ts`, which boots every
`server.ts` as the gateway does — in gateway mode, calling `startConnector()` when the bootstrap is
guarded — with only stdin and stdout swapped for in-memory streams, then asks it over MCP for its
name and tools: `nimbus-<id>`, serving exactly the tools its registrar registers. A bootstrap that
reads a variable while starting rather than per call (as `imap` and `protonmail` do) needs a
stand-in value in that file's `bootEnv`; without one the boot fails naming the variable.

Three failure modes worth knowing in advance:

- **A test that encodes a path shape rather than a behaviour.** Assert what the code guarantees, not
  where files happen to sit. One test pinned a connector entry to `mcp-connectors/<id>/…` and was the
  only thing that broke when the tree moved, though the resolver itself was already layout-independent.
- **Line endings.** `.gitattributes` normalises to LF, and that is load-bearing — the consent audit's
  write-registration check is an exact string match that a trailing carriage return defeats.
- **A test that reads a source file by path.** `connectors/github/test/write-tools.test.ts` asserts
  the connector's write DECLARATIONS by reading its source, and broke the moment the registrations
  moved from `server.ts` to `tools.ts` even though every declaration it checks was unchanged. It now
  reads both files, as the launcher's eligibility check already did.

## The other half, in the gateway repo

This repository holds the MCP tool surface only. A connector that should also be **indexed** by the
Nimbus gateway needs its sync handler and registry entry in
[nimbus-agent/Nimbus](https://github.com/nimbus-agent/Nimbus). Adding a connector touches both.
