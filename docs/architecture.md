# Architecture

## Repository layout

```
.
├── README.md               the only README at the root
├── CLAUDE.md               working agreement for AI agents in this repo
├── LICENSE  NOTICE         AGPL-3.0-only, and the security tiering
├── package.json            the single published package: @nimbus-dev/connectors
├── biome.json              formatter + linter
├── tsconfig.base.json      strict compiler options, shared by every tsconfig
├── tsconfig.json           one typecheck pass over the whole repo
├── connectors/             94 connectors, one directory each
│   └── <id>/
│       ├── README.md               that connector's tools, credentials, scopes
│       ├── nimbus.extension.json   manifest: permissions, hitlRequired, sync interval
│       ├── package.json            per-connector metadata (not published; see below)
│       ├── tsconfig.json
│       └── src/
│           ├── server.ts           the entry point, and the only required file
│           └── …                   search filters, transport helpers, tool modules
├── shared/                 helpers every connector imports by relative path
├── standalone/             the `nimbus-connector` launcher (the package `bin`)
├── scripts/                repo tooling and its tests
└── docs/                   this directory
```

The connectors sit under `connectors/` rather than at the root. They were at the root when the tree
was first extracted from the Nimbus monorepo, which put **107 entries** at the top level and buried
`README.md`, `package.json` and `scripts/` among them.

### One package, not 94

Everything here publishes as a single npm package, `@nimbus-dev/connectors`. The alternative — a
package per connector — was rejected because it means 94 releases per change to `shared/`, and it
forces `shared/` to become a versioned dependency that 190 files currently import by relative path.

The per-connector `package.json` files are kept for their metadata but are **not published** and are
not workspace members. Their `dependencies` are informational; the real dependency set is declared
once, at the root. A test asserts every one of them stays `private: true`, so none can be published
by accident.

## How a connector is built

A connector is an MCP server over stdio. `src/server.ts` is the entry point and the only file the
launcher requires; everything else is that connector's own decomposition.

Three layers sit under it:

**`shared/` — the kits.** Tool registration (`mcp-tool-kit.ts`, `rest-tool-kit.ts`,
`mcp-search-tool.ts`), transport helpers (`fetch-bearer-json.ts`, `atlassian-json-fetch.ts`,
`join-api-path.ts`, `run-cli-json.ts`), and the search-filter primitives. A connector composes these
rather than hand-rolling HTTP and tool plumbing.

**`shared/consent-kit.ts` — the write path.** Every mutating tool is registered through
`createWriteToolRegistrar`, never with the raw MCP registration call. That registrar is what
enforces consent, the write-scope allow-list and the mutation budget, and it is why those properties
hold regardless of how a connector is written. `shared/write-scope.ts` and `shared/audit-chain.ts`
back it.

**`shared/connector-mode.ts` — gateway versus standalone.** A connector behaves differently when the
Nimbus gateway hosts it (the gateway owns consent) than when it runs standalone (the client owns
consent). The mode is set once, by the entry point. `setConnectorMode` may only be named by
`shared/connector-mode.ts` itself — enforced by `scripts/check-connector-consent.ts`, because a
second caller could re-gate a connector mid-process.

## The gates

Four commands, all run by CI on Ubuntu, macOS and Windows:

| Command | What it establishes |
| --- | --- |
| `bun run lint` | Biome formatting and lint rules, including `noExplicitAny`. |
| `bun run typecheck` | One `tsc` pass over all 94 connectors plus `shared/`, `standalone/` and `scripts/`. |
| `bun run audit:connector-consent` | No connector declares a mutating tool without routing it through the consent kit, and nothing outside `shared/connector-mode.ts` names the mode setter. |
| `bun test` | The suite, 1200+ tests. |

`bun run check` runs all four in order.

The consent audit is the structural one. It identifies a connector by asking whether the directory
has `src/server.ts`, not by skipping known non-connector names — a blocklist had already produced a
fabricated finding once, when a `node_modules` directory appeared beside the connectors and was read
as one.

## Platform equality

Windows, macOS and Linux are equally supported, which is a Nimbus non-negotiable rather than a
preference. CI runs the same command on all three. Build paths with `path.join`, never a hardcoded
separator, and be aware that a test asserting Windows-shaped paths will pass locally on Windows and
fail on the other two legs.

The repository enforces LF line endings through `.gitattributes`. This is load-bearing, not
cosmetic: the consent audit's write-registration check is an exact string match, and a CRLF checkout
left a trailing carriage return that made it report two correctly-hardened connectors as declaring
ungated writes.

## Relationship to the Nimbus gateway

This repository holds the **MCP tool surface** — the part that is useful without a gateway. The
gateway's per-connector **sync and indexing** intelligence stays in
[nimbus-agent/Nimbus](https://github.com/nimbus-agent/Nimbus). Adding a connector therefore touches
both repositories.

What the gateway adds, and what no published package can supply, is in [`NOTICE`](../NOTICE): the
process sandbox, OS-keychain credential storage, the egress ledger and owner-controlled consent.
