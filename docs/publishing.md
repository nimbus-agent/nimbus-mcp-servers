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

## After publishing

The Nimbus gateway consumes this package from npm. It pins it in `packages/gateway/package.json`,
generates its bundled-connector registry as `@nimbus-dev/connectors/<id>` specifiers, and its
connector-boot smoke test starts every connector out of the compiled binary. Its
`audit:connector-version-skew` gate compares the pin with npm's `latest`: falling a minor version
behind fails the gateway's build, a patch only warns. So a `feat` release here — a minor bump,
pre-1.0 — needs a gateway PR that raises the pin.
