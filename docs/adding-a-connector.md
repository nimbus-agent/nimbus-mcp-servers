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
    └── server.ts            the entry point; the launcher requires this exact path
```

`src/server.ts` is what makes the directory a connector. The consent audit and the launcher both
identify connectors by its presence, so a directory without it is invisible to both.

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

That is lint, typecheck, the consent audit and the full suite. CI runs the same four on Ubuntu,
macOS and Windows.

Two failure modes worth knowing in advance:

- **A test that encodes a path shape rather than a behaviour.** Assert what the code guarantees, not
  where files happen to sit. One test pinned a connector entry to `mcp-connectors/<id>/…` and was the
  only thing that broke when the tree moved, though the resolver itself was already layout-independent.
- **Line endings.** `.gitattributes` normalises to LF, and that is load-bearing — the consent audit's
  write-registration check is an exact string match that a trailing carriage return defeats.

## The other half, in the gateway repo

This repository holds the MCP tool surface only. A connector that should also be **indexed** by the
Nimbus gateway needs its sync handler and registry entry in
[nimbus-agent/Nimbus](https://github.com/nimbus-agent/Nimbus). Adding a connector touches both.
