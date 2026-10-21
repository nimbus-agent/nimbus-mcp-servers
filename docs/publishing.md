# Publishing

The repository publishes one package: **`@nimbus-dev/connectors`**.

## Names to get right

`nimbus-mcp` on npm **belongs to an unrelated third party** — an AWS security-assessment server. An
earlier README told users to `npx nimbus-mcp <connector-id>`, which fetched and executed someone
else's code, and it shipped that way in two releases. Do not use that name anywhere, in prose or in
a copy-pasteable config block.

The bin is `nimbus-connector`. That avoids a second collision too: `@nimbus-dev/mcp` already ships a
`nimbus-mcp` bin that launches the **gateway's** MCP server — a different program with a different
tool surface.

Run `npm view <name>` before documenting any install command.

## What ships

`files` in `package.json` decides, and `scripts/package-contents.test.ts` asserts the result by
asking `npm pack --dry-run` rather than reimplementing the glob semantics. It enforces:

- every connector's `src/server.ts` and `nimbus.extension.json` are present;
- `shared/` is present, because 212 shipped connector source files import it by relative path;
- the `bin` target is present;
- **no test files** ship;
- **no nested `package.json`** ships — `standalone/package.json` declares a second package identity
  with its own dependencies and a `bin` pointing at a `dist/` that has never been built, and a
  nested manifest puts a package boundary inside the package.

## Cutting a release

Releases are automated by release-please and `.github/workflows/release.yml`. Nobody runs
`npm publish` by hand.

1. Merge work to `main` under Conventional Commit subjects — see
   [CONTRIBUTING § Commits and releases](../CONTRIBUTING.md#commits-and-releases). On each push to
   `main`, release-please opens or updates a release PR that bumps `version` in `package.json` and
   `.release-please-manifest.json` and adds the `CHANGELOG.md` entry. Pre-1.0 a `feat` bumps the
   minor and a `fix` the patch. The PR is opened with a token minted from the Nimbus Release Bot
   GitHub App, because the organisation does not let `GITHUB_TOKEN` create pull requests.
2. Merging the release PR tags `connectors-vX.Y.Z` and creates the GitHub release. The publish job
   then runs the gates again — lint, typecheck, the consent, deps and entrypoints audits, and the
   full suite — and stops unless an OIDC token is present and npm meets the 11.5.1 floor that
   trusted publishing needs.
3. It runs `npm publish --provenance --access public` with no npm token: npm trusted publishing
   authenticates the workflow through GitHub OIDC and attaches the provenance.
4. It installs the version it just published from the registry into an empty directory, runs
   `npm audit signatures` there (retrying through registry propagation lag), and checks that the
   provenance names this repository, `.github/workflows/release.yml` and the release commit.

`connectors-v*` tags are protected: nobody can delete or move one. A release whose publish job
fails is not re-tagged — land the fix and let the next version carry it. npm restricts unpublishing
a version once 72 hours have passed as well, which is why the gates run again before the publish
step.

Nothing in the pipeline boots a connector from the installed package. When a release changes
packaging (`files`, `exports`, `bin`), check that by hand before merging its release PR: `npm pack`,
install the tarball into a scratch directory, and start a connector from it. A tarball that packs
cleanly can still fail to resolve once installed.

0.1.0 and 0.1.1 were published by hand, before this pipeline existed, and carry no provenance.
Every release since 0.2.0 came from it.

## Publishing to the official Nimbus registry

The Readwise connector also ships as a self-contained, signed Nimbus extension
(`com.nimbus.readwise`), published to the **official Nimbus extension registry**: a static folder
on this repository's `gh-pages` branch, served by GitHub Pages. The registry URL is the Pages URL,
`https://nimbus-agent.github.io/nimbus-mcp-servers/`.

### What the job does

After the npm publish of every release, `release.yml` calls
`.github/workflows/registry-publish.yml` — but only once the repository variable
`OFFICIAL_REGISTRY_ENABLED` is `true`. Until the owner sets it, releases skip the job and stay
green. The workflow can also be dispatched by hand from `main`, which is how the first publish
happens; a dispatch is refused, before any approval is requested, unless the variable is `true`.
The job:

1. waits for a reviewer to approve the protected `official-registry` environment, whose secrets
   are the two signing keys;
2. checks out the release commit and the `gh-pages` branch, and refuses to run from any ref but
   `main`;
3. downloads the Nimbus CLI — it is not on npm — from a pinned Nimbus release, and verifies it
   against a SHA-256 written into the workflow;
4. writes the two keys to files under `$RUNNER_TEMP` (mode 0600), and runs
   `scripts/publish-registry.ts`, which builds `dist/server.js`, stages the package with the
   publisher block added to the staged manifest (never the repository's), runs
   `nimbus extension sign` and then `nimbus registry maintain add`, which re-signs `index.json`;
5. deletes the key files, and commits the changed registry to `gh-pages` as
   `registry: add <id>@<version> (sequence N)`.

**What the package contains:** `nimbus.extension.json` (the staged manifest), `dist/server.js`,
the connector's `README.md`, and a `LICENSE`. The AGPL requires the licence text to travel with
the code, so a connector without a LICENSE of its own — Readwise has none — ships the repository's
root `LICENSE`.

**The version rule.** The job publishes only when the `version` in
`connectors/readwise/nimbus.extension.json` is not yet in the registry. A release that does not bump
it publishes nothing. To ship a new extension build, bump that `version` in the PR that changes it.
A registry version is immutable: the same version is never re-signed or replaced.

The script refuses, before running the CLI, when the publisher key it is given differs from the
one the registry records for the id, or the root key differs from the index's `rootKey`. **A
publisher key can never change for an id** — installs pin it — so losing the publisher seed means
publishing under a new id.

The pinned CLI (v9.2.1) reads the manifest's `entry` and not `entrypoint`, so the staged manifest
sets `entry` to the same value. That shim goes once the pin moves to a release that reads
`entrypoint`.

### One-time setup (the owner)

CI never bootstraps the registry: `nimbus registry maintain init` mints a fresh root key, so a
bootstrap run in CI would either fail or replace the root of trust.

1. Generate the publisher key: `nimbus extension keygen --out <publisher-key>`.
2. Create the registry: `nimbus registry maintain init <dir> --key <root-key>`. Push the contents
   of `<dir>` — `index.json`, `extensions/`, and an empty `.nojekyll` — as the root of an orphan
   `gh-pages` branch.
3. Enable GitHub Pages: deploy from a branch, `gh-pages`, folder `/ (root)`.
4. Create the environment `official-registry` (Settings → Environments) with required reviewers
   and its deployment branches limited to `main`. Give it the secrets `NIMBUS_REGISTRY_ROOT_KEY`
   and `NIMBUS_PUBLISHER_KEY` — each the full contents of its key file — and the variable
   `NIMBUS_PUBLISHER_ID`, the publisher id to record. Put the keys in the environment, not in the
   repository's secrets: environment secrets reach only the approved job.
5. Keep offline backups of both seeds. The root key re-signs the index on every publish, and the
   publisher key can never be replaced for an id.
6. **Last**, set the repository variable `OFFICIAL_REGISTRY_ENABLED` to `true` (Settings → Secrets
   and variables → Actions → Variables) — only after the environment, its secrets and variable,
   the `gh-pages` branch and Pages are all in place. The environment in particular must already
   exist, with required reviewers and deployment restricted to `main`, before you enable: a job
   that names an environment which does not exist makes GitHub create it, with no protection
   rules at all.

## After publishing

The Nimbus gateway consumes this package from npm. It pins it in `packages/gateway/package.json`,
generates its bundled-connector registry as `@nimbus-dev/connectors/<id>` specifiers, and its
connector-boot smoke test starts every connector out of the compiled binary. Its
`audit:connector-version-skew` gate compares the pin with npm's `latest`: falling a minor version
behind fails the gateway's build, a patch only warns. So a `feat` release here — a minor bump,
pre-1.0 — needs a gateway PR that raises the pin.
