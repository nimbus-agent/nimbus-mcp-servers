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
- `shared/` is present, because 190 files import it by relative path;
- the `bin` target is present;
- **no test files** ship;
- **no nested `package.json`** ships — `standalone/package.json` declares a second package identity
  with its own dependencies and a `bin` pointing at a `dist/` that has never been built, and a
  nested manifest puts a package boundary inside the package.

## Cutting a release

1. `bun run check` — lint, typecheck, consent audit, full suite.
2. Bump `version` in `package.json`.
3. `npm pack --dry-run` and read the file list.
4. Install the tarball into a scratch directory and boot a connector from it. A tarball that packs
   cleanly can still fail to resolve once installed, and that is the failure this step catches.
5. `npm publish --access public`.

The package is `private: true` until the first publish is deliberately authorised. Nothing in CI
publishes it — releasing is a manual, intentional act.

## After publishing

The Nimbus gateway consumes this package from npm. Its bundled-connector registry can emit either
relative paths or `@nimbus-dev/connectors/<id>` specifiers, and its connector-boot smoke test proves
the compiled binary can still reach all 94 through the package specifier. Run that against the
**published** artifact before removing anything from the monorepo.
