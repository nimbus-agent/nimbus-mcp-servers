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

## The manifest

`nimbus.extension.json` needs `id` (reverse-domain, e.g. `com.nimbus.acme`), `displayName`,
`version`, `entrypoint`, `runtime: "bun"`, `permissions`, `hitlRequired`, `syncInterval` and
`minNimbusVersion`.

`hitlRequired` is the authoritative mutation signal. List `"write"` and `"delete"` there if the
connector mutates anything. It is what the consent audit checks, and it is transport-independent —
true for connectors that mutate through a CLI, the filesystem or a mail protocol, where no HTTP verb
appears in the source.

## The tool surface

Every connector exposes at least `list`, `get` and `search`. Read tools register normally.

Before writing the plumbing, check whether a kit already owns it:

| If your connector… | Use |
| --- | --- |
| GETs JSON from one base URL with a token from the environment | `shared/env-json-api.ts` — `createJsonGetter` + `envAuthHeaders` |
| exposes the plain `list` / `get` / `search` triple over one collection | `shared/collection-tool-kit.ts` — `registerCollectionTools` |
| spawns a cloud CLI and parses its JSON | `shared/cli-json-kit.ts` — `createCliJsonRunner`, and `cliArg` for every value that reaches argv |
| speaks IMAP/SMTP | `shared/imapflow-adapter.ts` — `createImapFlowClient`, `createNodemailerMailer` |

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

## Dependencies

The real dependency set is declared once, in the **root** `package.json`. A per-connector
`package.json` is metadata only and is not installed from.

If your connector needs a library the other 93 do not, add it to the root `optionalDependencies` so
a platform that cannot build it does not break every other connector, and document the requirement
in [Configuration](./configuration.md).

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
