# Contributing

Thanks for helping. This repository holds the **94 first-party Nimbus MCP connectors**, published as
one package, `@nimbus-dev/connectors`.

Read [`docs/adding-a-connector.md`](./docs/adding-a-connector.md) before writing a connector, and
[`docs/architecture.md`](./docs/architecture.md) before changing structure.

## Getting started

```bash
bun install
bun run check   # lint, typecheck, the three connector audits, full suite
```

`bun run check` is what CI runs, on Ubuntu, macOS and Windows. Run it before pushing.

## The rules that are not preferences

1. **Every mutating tool registers through `createWriteToolRegistrar`** from
   `shared/consent-kit.ts` — never the raw MCP registration call. That registrar is what enforces
   consent, the write-scope allow-list and the mutation budget. `bun run audit:connector-consent`
   fails a connector that declares `write`/`delete` in `hitlRequired` without going through it, and
   the launcher refuses to start it.
2. **`setConnectorMode` has exactly one caller.** The mode comes from the entry point; a second
   caller could re-gate a connector mid-process. Enforced statically.
3. **Credentials come from `process.env`.** Never call a Vault API — the connector process has no
   Vault access by design.
4. **Pure JavaScript dependencies only.** These are bundled into the Nimbus gateway's compiled
   binary, where a native module fails silently and the only symptom a user sees is a sync that
   never works. `bun run audit:connector-deps` enforces the allow-list.
5. **No `any`.** Use `unknown` for external data.
6. **Platform equality.** Build paths with `path.join`. CI runs all three OSes.

## Dependencies

The real dependency set is declared once, in the **root** `package.json`. A per-connector
`package.json` is metadata and nothing installs from it.

This package ships **raw TypeScript**, which has a consequence that is easy to miss: a consumer
compiles these sources, so any `@types/*` they need is a real `dependency`, not a `devDependency`.
`scripts/consumer-types.test.ts` enforces that — it exists because `@types/nodemailer` sat in
`devDependencies` through two releases and broke the gateway's typecheck.

## Commits and releases

Conventional commits. The **PR title** is what release-please reads, because squash is the only
merge method enabled and the squash commit is built from the PR title and description.

Releases are automated: merging to `main` opens a release PR, and merging that publishes to npm with
provenance via GitHub OIDC — no tokens, no manual step. Pre-1.0, a `feat` bumps the minor.

## Two things that have cost time here

- **A green audit can mean an empty scan.** `audit:connector-consent` prints `ok` both when nothing
  is wrong and when it discovered zero connectors. After changing anything about discovery, confirm
  the count is 94.
- **Line endings are load-bearing.** `.gitattributes` normalises to LF. The consent audit's
  write-registration check is an exact string match, and a CRLF checkout defeated it.

## The other half lives in the gateway repo

This repository holds the MCP **tool surface**. A connector that should also be *indexed* needs its
sync handler and registry entry in [nimbus-agent/Nimbus](https://github.com/nimbus-agent/Nimbus).
Adding a connector touches both.
