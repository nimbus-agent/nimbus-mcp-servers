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

### Updating dependencies

Dependabot opens no pull requests here. A maintainer updates dependencies in periodic bulk PRs:
`bun outdated`, edit the ranges in the root `package.json`, `bun install`, then `bun run check`.
Dependabot **alerts** stay on, so start from the open ones in the repository's Security tab — fixing
one is the same manual bump as any other update.

What that PR has to get right:

- **Let Bun write the lockfile, and commit `bun.lock` with the manifest.** CI installs with
  `bun install --frozen-lockfile`, which fails when the two disagree. npm does not read `bun.lock`:
  when Dependabot updated this repo through its npm ecosystem, it bumped `package.json`, left the
  lockfile stale, and every PR it opened failed that step
  ([#11](https://github.com/nimbus-agent/nimbus-mcp-servers/pull/11)).
- **Bump the per-connector manifests too.** They install nothing, but GitHub's dependency graph
  scans them, so a stale range there raises a security alert even after the root is patched. The
  root moved to `nodemailer` 10 in mid-September 2026, yet an advisory published two weeks later
  still opened three alerts — against `connectors/{imap,apple,protonmail}/package.json`, which
  declared `^9`.
- **Move `github/codeql-action` as one unit.** Its `init` and `analyze` steps must be pinned to the
  same commit, or CodeQL fails with "Loaded a configuration file for version X, but running version
  Y". Third-party actions are pinned to a full commit SHA with the tag in a trailing comment; update
  both together.
- **Keep shared majors in step with the gateway.** The Nimbus gateway installs this package from npm
  and depends directly on some of the same libraries (`imapflow`, for one). When the two disagree on
  a major, its compiled binary carries both copies.

Turning Dependabot pull requests back on needs `.github/workflows/cla.yml` changed first: a run
Dependabot triggers gets no Actions secrets, so the CLA token mint fails and the required `cla`
check never passes.

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
