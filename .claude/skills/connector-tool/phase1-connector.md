# Phase 1: this repo's half

Follows [docs/adding-a-connector.md](../../../docs/adding-a-connector.md) and this repo's
[CLAUDE.md](../../../CLAUDE.md), with these as explicit steps. The trap check and the owner questions
are in [SKILL.md](./SKILL.md), not repeated here. Nothing in this phase edits the gateway.

## Registration

- Choose the registrar per tool, by hand. The consent audit is per connector, so it cannot see a
  mutating tool registered through the read registrar beside gated ones.
  - Anything that mutates: `createWriteToolRegistrar` from
    [shared/consent-kit.ts](../../../shared/consent-kit.ts).
  - A prepare tool: `createPrepareToolRegistrar`, bound to a variable named exactly
    `registerPrepareTool`. Its id goes in [shared/prepare-tool-ids.ts](../../../shared/prepare-tool-ids.ts)
    **and** in the exact list `shared/prepare-tool-ids.test.ts` asserts, and it ends in no read verb.
  - Otherwise the read registrar.
- Write registrations appear in `src/server.ts` or `src/tools.ts`, on a line the standalone launcher's
  `registersWriteTool` accepts (`registerWriteTool,` or `register<Letters>WriteTool(`), in a static
  shape the gateway's `connector-write-registrations.ts` can follow: no default export, no `let`, no
  shadowed or computed registrar. The consent audit scans every file, but the launcher scans only those
  two. A registration in a helper file passes `bun run check` and then makes `nimbus-connector <id>`
  exit 3.
- `hitlRequired` in `nimbus.extension.json` matches the writes.
- A write that must be refused for a cross-field rule (`line` only with `path`) or any input the tool
  is certain to reject passes `refuseBefore` in its registrar config. The registrar takes only a
  `ZodObjectSchema`, so `.refine()` is unavailable on a write schema, and a check inside the handler
  runs after the human approved. `refuseBefore` runs first, before scope, budget and prompt, but only
  standalone: in gateway mode the raw handler is registered, so the handler must refuse the same input
  too. Test both paths.
- A new write tool needs a row in the connector's `cases` table in
  [scripts/connector-write-scope.test.ts](../../../scripts/connector-write-scope.test.ts) (tool,
  mutates, args, expected scope term). Without it that file's "offers its write tools only to a client
  that can ask a human" fails for the connector.
- Each write's `mutates` is `<service>.<noun>.<verb>`, where `<service>` is the gateway's
  `ConnectorServiceId` (for example `google_calendar`, not `gcal`). When the `../Nimbus` checkout
  exists, read `../Nimbus/packages/gateway/src/connectors/connector-catalog.ts` and confirm that each
  new `mutates` starts with an id it defines (`CONNECTOR_SERVICE_IDS`, an array literal near the top:
  `grep -n CONNECTOR_SERVICE_IDS`). Nothing in this repo checks it, and the gateway's
  `manifest.sync.test.ts` and `rows.test.ts` reject a mismatch only after release.

## First write on a read-only connector

Extra steps.

- If `server.ts` still uses `runReadOnlyMcpConnector`, move it to `createConnectorServer`.
  `connector-boot.test.ts` asserts the logging capability once `hitlRequired` is non-empty.
  `google-calendar` is already on `createConnectorServer`.
- Document the write-scope variable and its kinds in
  [docs/configuration.md](../../../docs/configuration.md).
- OAuth connectors register write tools only when the token's scopes allow them (pattern:
  [connectors/gmail/src/tool-scope-policy.ts](../../../connectors/gmail/src/tool-scope-policy.ts)), so
  an existing read-only token lists no broken write. Two consequences:
  - A fail-closed gate, which hides writes while the scopes variable is unset (Gmail's policy), means
    `sync-tool-names.ts`, the contract test (`REGISTRATION_ENV`) and the boot test's expected surface
    all see the writes missing. Setting the scopes in `bootEnv` does not fix that. The connector
    drops `*_TOOL_NAMES`, as `gmail` does, and covers the writes and the scope gate in dedicated tests.
    (`outlook` keeps `OUTLOOK_TOOL_NAMES` only because its policy is fail-open when
    `MICROSOFT_OAUTH_SCOPES` is unset, which is the less safe choice for a new write.)
  - The gateway must then pass the granted scopes at spawn. Today only `gmail` receives
    `GOOGLE_OAUTH_SCOPES`, so that is Phase 2 work and an owner question, not something to do here.

## Guards

- A model-chosen URL goes through `resolveUrlWithBase`. A model-chosen path segment is encoded, with
  `..` refused. Writes refuse redirects (see [docs/configuration.md](../../../docs/configuration.md)).
- A model-chosen CLI value goes through a `cli-json-kit` schema, in the tool's schema.
- A prepare tool is registered in `src/tools.ts`, which the gateway's `prepare-tools.test.ts` reads,
  with `registerPrepareTool("<id>"`. Its prefix maps to its directory, or is added to
  `CONNECTOR_OF_PREFIX` in `shared/prepare-tool-ids.test.ts`.

## Test fixtures

- Run the contract test first and add an override only on failure. A schema the generic fixture
  cannot satisfy (UUIDs, RFC 3339, regexes), on any connector, HTTP or CLI, then gets an
  `ARG_OVERRIDES` entry in
  [scripts/connector-tool-contract.test.ts](../../../scripts/connector-tool-contract.test.ts).
- CLI connectors also get `SWEEP_SEED`, plus `BOUND_TO_STATE` for bound tools, in
  [scripts/cli-argument-guards.test.ts](../../../scripts/cli-argument-guards.test.ts). Removing a tool
  removes its stale `BOUND_TO_STATE` entry.

## Names, tests, docs

- Run `bun run sync:tool-names`, then `bun run audit:tool-names`. A connector whose list is derived
  (for example `readwise` via `collectionToolNames`) or skipped by `sync-tool-names.ts` is checked by
  hand.
- Tests assert behaviour, not file contents or paths.
- The connector README documents the tool, its credential and its write scope. The scope term is
  `kind:value` (for example `repo:acme/api`), and an unset variable authorises nothing: see
  [docs/configuration.md](../../../docs/configuration.md).
- A `readwise` change bumps `version` in its `nimbus.extension.json` (see
  [docs/publishing.md](../../../docs/publishing.md)).

## New connector only

- An `exports` entry; the pinned count in `connector-gates.test.ts` raised on purpose; `private: true`;
  the dependency on the allow-list (and any `@types/*` in root `dependencies`, per
  `consumer-types.test.ts`); `npm view <name>` before any install command.
- The contract-test maps, as needed: `EXPECTED_SPAWNING` (`cli-argument-guards.test.ts`);
  `CLI_BACKED`, `NOT_HTTP`, `KEYLESS` and `ARG_OVERRIDES` (`connector-tool-contract.test.ts`);
  `bootEnv` (`connector-boot.test.ts`).
- This repo's prose counts are updated, each derived by a command quoted in the commit message (the
  count of `connectors/*/src/server.ts`): `CLAUDE.md`, `README.md`, `CONTRIBUTING.md`,
  `docs/architecture.md`, `docs/adding-a-connector.md`, `docs/configuration.md` and
  `standalone/src/launcher.ts`.

## Finish

`bun run check` passes. A green audit can mean an empty scan, so rely on the test run, not on an `ok`.
