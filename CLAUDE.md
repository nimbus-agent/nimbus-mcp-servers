# nimbus-mcp-servers — Claude Code Context

## What this repo is

The **94 first-party Nimbus MCP connectors**, extracted from the
[Nimbus monorepo](https://github.com/nimbus-agent/Nimbus) and published as a single npm package,
**`@nimbus-dev/connectors`**. Each connector is an MCP server over stdio, runnable by any MCP client
without a Nimbus gateway.

**Runtime:** Bun 1.2+ / TypeScript strict · **Linter:** Biome · **License:** AGPL-3.0-only

Read [`docs/architecture.md`](./docs/architecture.md) before changing structure, and
[`docs/adding-a-connector.md`](./docs/adding-a-connector.md) before adding or modifying one.

## Non-negotiables

Architectural constraints, not preferences. Do not suggest changes that violate them.

1. **Consent is structural.** Every mutating tool registers through `createWriteToolRegistrar` in
   `shared/consent-kit.ts` — never the raw MCP registration call. The consent gate lives in the
   registrar, not in a prompt, and cannot be configured away.
2. **No plaintext credentials in code.** They come from `process.env` at startup. Never call a Vault
   API — the connector process has no Vault access by design.
3. **`setConnectorMode` has exactly one caller.** The mode comes from the entry point. A second
   caller could re-gate a connector mid-process; the consent audit enforces this statically.
4. **Platform equality.** Windows, macOS and Linux are equally supported. CI runs all three.
5. **No `any`.** Use `unknown` for external data. TypeScript strict mode is non-negotiable.
6. **AGPL-3.0-only, and `NOTICE` is preserved.** Do not change licence fields.

## Layout

```
connectors/<id>/src/server.ts   the entry point — its presence is what defines a connector
connectors/<id>/src/tools.ts    the tool surface: one exported register<Name>Tools()
shared/                         kits every connector imports by relative path (../../../shared/…)
standalone/                     the `nimbus-connector` launcher (the package bin)
scripts/                        repo tooling + its tests
docs/                           all repo-level documentation
```

Connectors live under `connectors/`, not at the root. Note the import depth from a connector source
file: `../../../shared/…`. A test file at the connector root rather than in `src/` uses `../../`.

**`server.ts` is a bootstrap and nothing else** — read env, build clients, call
`register<Name>Tools(…)`, connect. This is structural, not stylistic: a module that registers at
module scope cannot be imported by a test (importing it opens a real stdio transport), so its whole
tool surface is unreachable and it drops out of the connector contract test. A connector that must
register from `server.ts` guards the bootstrap with `if (import.meta.main)` and exports the
registrar; ten do.

Before hand-rolling plumbing, check the kits — `env-json-api.ts` (env-token JSON GET),
`collection-tool-kit.ts` (the list/get/search triple), `cli-json-kit.ts` (spawn a CLI, parse JSON,
`cliArg`-guard every argv value), `imapflow-adapter.ts` (IMAP/SMTP).

## Commands

| Command | What it does |
| --- | --- |
| `bun run check` | Every gate, in order. **Run this before pushing.** |
| `bun run lint` / `lint:fix` | Biome. |
| `bun run typecheck` | One `tsc` pass over everything. |
| `bun run audit:connector-consent` | The structural consent gate. |
| `bun run audit:tool-names` | Every `*_TOOL_NAMES` matches what the connector registers. |
| `bun run sync:tool-names` | Rewrites the stale ones. Run after adding or renaming a tool. |
| `bun test` | Full suite (2100+ tests). |

## Traps that have already cost time here

- **A green audit can mean an empty scan.** `audit:connector-consent` reports `ok` both when nothing
  is wrong and when it discovered zero connectors. After changing anything about discovery, confirm
  the count is 94 — do not read `ok` as proof. The same trap has a second form in tests: the
  connector contract test asserts it discovered more than 40 surfaces, and a per-connector
  assertion that finds nothing to assert must FAIL rather than pass. Deleting Stripe's auth header
  went undetected until the contract gained "this connector demands a credential at all".
- **Line endings are load-bearing.** `.gitattributes` normalises to LF. The consent audit's
  write-registration check is an exact string match, and a CRLF checkout left a trailing carriage
  return that made it report two correctly-hardened connectors as declaring ungated writes.
- **Do not name `nimbus-mcp`.** It belongs to an unrelated third party on npm and was shipped in two
  releases as an `npx` instruction. The bin is `nimbus-connector`. Run `npm view <name>` before
  documenting any install command.
- **Test what the code guarantees, not where files sit.** A test pinning a connector entry to
  `mcp-connectors/<id>/…` was the only thing that broke when the tree moved, though the resolver was
  already layout-independent.
- **A substring match on a relative path lies.** `../../../shared/` contains `../../shared/`, so a
  grep for the old depth "finds" every corrected import. Anchor on the opening quote.
- **`private: true` on every per-connector `package.json`** is a structural guard against accidental
  publishing, asserted by a test. The real dependency set lives only in the root manifest.
- **A test that reads a connector's source by path breaks when the source moves.** `github`'s
  write-declaration test read `server.ts` and failed the moment the registrations moved to
  `tools.ts`, though every declaration it checks was unchanged. Read both, as the launcher's
  eligibility check already did — and prefer asserting behaviour over file contents.
- **Do not put backslashes in a Bash heredoc here.** They arrive mangled: a `\b` written into a
  regex through one landed in `connector-tool-contract.test.ts` as a literal `0x08`, so
  `/\b(?:is not set)\b/` silently matched nothing and every credential assertion passed
  vacuously. Use the Write/Edit tools for anything containing an escape.

## Relationship to the gateway

This repo holds the **MCP tool surface**. The gateway's per-connector **sync and indexing**
intelligence stays in the Nimbus monorepo. Adding a connector touches both repos.
