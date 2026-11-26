# `connector-tool` skill — design

Date: 2026-11-26 · Status: revision 4, agreed after three rounds of independent review (Antigravity, Gemini
4 Neon). Each finding was checked against the code before it was taken. Where a finding asked for
an enumerated list of gateway files, the skill states the rule and finds the files instead, so it
does not go stale.

## Intent

The gateway's Phase 9.7 left a backlog of connector tools it needed and did not find here (review
comments, issue edits, label/assignee removal, Google Calendar writes, `aws_lambda_get`, …). Closing
it means the same kind of change a dozen times, and every one of them crosses into the gateway repo:
the tool lands here, is released, and the gateway then needs a pin bump, its generators re-run, and
— for a write — a write row, a preview and an owner ruling. Today that knowledge is split between
this repo's CLAUDE.md traps, the gateway's skills (one of them stale), and memory.

The skill makes one run of "add or change a connector tool" do this repo's half correctly, check the
traps that only a careful reader can check, and then, once the release exists, do the gateway's half
on a local branch — asking the owner the questions that are the owner's, and leaving pushes,
releases and merges to the owner.

## Goals

- One skill, `connector-tool`, at `.claude/skills/connector-tool/SKILL.md` in this repo.
- Covers: adding a tool to an existing connector, changing one (incl. its description, name or
  schema), removing one, and adding a new connector (one change class, not a second skill).
- Phase 1 does this repo's half to a green `bun run check`, plus a trap check, and emits a Phase 2
  hand-off.
- Phase 2, run after the connectors release is published, does the gateway's half in `../Nimbus` on
  a local branch to a green `bun run preflight:fast` and the touched gateway suites.
- Ends every run with a report: what changed, where, on which branch, the landing order, open owner
  decisions, unacted references.

## Non-goals

- Pushing, opening PRs, cutting releases, merging. The skill stops at local commits.
- Deciding anything that is the owner's (§7).
- Encoding the gateway's internals beyond a short map of the gates that bite. The gateway half
  follows the gateway's own files.
- Gateway sync/indexing handlers for a new connector (an owner decision; reported, not built).
- **Other org repos.** Checked 2026-11-26:
  - `nimbus-vscode`, `nimbus-web-clipper`, `nimbus-sdk`, `nimbus-client`, `nimbus-mcp` reference no
    connector tools.
  - `create-nimbus-connector` deliberately has not followed the move to this repo: its "94" figures
    are dated measurements of a pre-move tree, its gates refuse a current checkout, and its CLAUDE.md
    says not to restate live numbers. Editing it would corrupt that record.
  - `nimbus-dotgithub` says "about 95", a rounded figure not bumped for 96–98, and has no CLAUDE.md.
    The report mentions it only when a new connector crosses a round number (100, …), as a manual
    follow-up.
  - `nimbus-connector-registry` is an unbuilt scaffold the gateway retired on 2026-11-12.
  - `nimbus-delivered-specs` is history.
- A standalone `connector-trap-review` agent. Possible later; not this work.

## Anti-goals (failure even if it "works")

- A mutating tool registered through the read registrar.
- A write row that becomes model-offerable without the owner saying so — including by the side
  effect that a wave 2/3 row with a preview is offerable.
- A connectors release whose `mutates` strings the gateway then rejects, forcing a second release.
- Gateway docs that advertise a tool the pinned gateway does not ship.
- Editing any repo's `main`, staging with `git add -A`/`.`, moving the owner's checkout off their
  branch, or pushing anything.
- Hand-edited generated files or hand-typed counts.

## Constraints

- This repo's CLAUDE.md non-negotiables and traps apply verbatim.
- The gateway (`../Nimbus`) pins a **published** `@nimbus-dev/connectors`; its gates scan the
  installed package. So the gateway half waits for a release, and **every** release with a `feat:`
  needs a gateway pin bump soon after: `audit:connector-version-skew` fails the gateway on a minor
  gap.
- Tool-definition hashes (gateway V97) cover `{ toolId, description, inputSchema }`
  (`connector-writes/definition-hash.ts`). Editing a tool's description or input schema suspends an
  approved tool on the agent door until re-approved. Renaming or removing a tool leaves the old
  approval "missing" (not suspended, not audited) and the new id unapproved.
- Gateway branches are `dev/<you>/<topic>`; its worktrees live under `.claude/worktrees/<branch>`
  and need `bun install` (Nimbus CLAUDE.md, Development Workflow).
- Conventional Commits apply to commit subjects and PR titles (release-please reads those, not
  branch names).
- Skill files are written with Write/Edit, never a Bash heredoc.

## Approaches considered

- **A. Impact map + each repo's own files (chosen by the owner).** The skill knows this repo in
  depth and the gateway as a map of which gates and files a change class touches, then follows the
  gateway's own files for the detail.
- B. One skill that encodes every repo's internals — duplicates the gateway's checklists and drifts.
- C. Report-only — safest, but the owner asked for the changes to be made.

The review confirmed A. It also narrowed A from "N repos" to "this repo, then the gateway",
because no other repo needs per-change edits.

## The design

### 1. Classify the change

| Class | Example |
|---|---|
| read tool added | `aws_lambda_get` |
| write tool added | `bitbucket_pr_comment_create`, `gcal_event_create` |
| first write on a read-only connector | anything in Google Calendar (today `calendar.readonly`) |
| prepare tool added | a `*_prepare` read the gateway calls before approval |
| behaviour fix, definition unchanged | Snowflake `TAG_REFERENCES` columns |
| definition change: description, input schema, or name | any edit to what a tool lists |
| tool removed | — |
| new connector | `unleash`, `split` |

A definition change or removal is raised with the owner **before** any code is written, stating the
V97 consequence for that case. The default recommendation is a new tool rather than reshaping a
shipped one, and description edits on shipped tools are avoided unless they are the point.

### 2. Phase 1 — this repo's half

Follows `docs/adding-a-connector.md` and CLAUDE.md, with these as explicit steps:

**Registration**
- Registrar chosen per tool, by hand: `createWriteToolRegistrar` for anything that mutates;
  `createPrepareToolRegistrar` bound to a variable named exactly `registerPrepareTool`, with the id in
  `shared/prepare-tool-ids.ts` **and** in the exact list `shared/prepare-tool-ids.test.ts` asserts,
  and an id ending in no read verb, for a prepare tool; the read registrar otherwise.
- Write registrations appear in `src/server.ts` or `src/tools.ts`, on a line the standalone
  launcher's `registersWriteTool` accepts (`registerWriteTool,` or `register<Letters>WriteTool(`),
  in a static shape the gateway's `connector-write-registrations.ts` can follow: no default export,
  no `let`, no shadowed or computed registrar. The consent audit scans every file, but the launcher
  scans only those two. A registration in a helper file passes `bun run check` and then makes
  `nimbus-connector <id>` exit 3.
- `hitlRequired` in `nimbus.extension.json` matches.
- Each write's `mutates` is `<service>.<noun>.<verb>`, where `<service>` is the gateway's
  `ConnectorServiceId`, read from `../Nimbus/packages/gateway/src/connectors/connector-catalog.ts`
  when that checkout exists (e.g. `google_calendar`, not `gcal`). Nothing here checks it, and the
  gateway's `manifest.sync.test.ts` and `rows.test.ts` reject a mismatch only after release.

**First write on a read-only connector** (extra steps)
- If `server.ts` still uses `runReadOnlyMcpConnector`, move it to `createConnectorServer`
  (`connector-boot.test.ts` asserts the logging capability once `hitlRequired` is non-empty).
  `google-calendar` is already on `createConnectorServer`.
- Document the write-scope variable and kinds in `docs/configuration.md`.
- OAuth connectors: register write tools only when the token's scopes allow them (pattern:
  `connectors/gmail/src/tool-scope-policy.ts`), so an existing read-only token lists no broken write.
  Two consequences to handle in this repo:
  - A fail-closed gate, which hides writes while the scopes variable is unset (Gmail's policy),
    means `sync-tool-names.ts`, the contract test (`REGISTRATION_ENV`) and the boot test's expected
    surface all see the writes missing. Setting the scopes in `bootEnv` does not fix that. The
    connector **drops `*_TOOL_NAMES`**, as `gmail` does, and covers the writes and the scope gate in
    dedicated tests. (`outlook` keeps `OUTLOOK_TOOL_NAMES` only because its policy is fail-open when
    `MICROSOFT_OAUTH_SCOPES` is unset, which is the less safe choice for a new write.)
  - The gateway must then **pass** the granted scopes at spawn. Today only `gmail` receives
    `GOOGLE_OAUTH_SCOPES` (`lazy-mesh/connector-spawns.ts`), so this is Phase 2 work (§4) and an
    owner question (§7).

**Guards**
- Model-chosen URLs go through `resolveUrlWithBase`. Model-chosen path segments are encoded, with
  `..` refused. Writes refuse redirects (`docs/configuration.md`).
- Model-chosen CLI values go through a `cli-json-kit` schema in the tool's schema.
- Test fixtures:
  - A schema the generic fixture cannot satisfy (UUIDs, RFC 3339, regexes, `.refine()`), on any
    connector, HTTP or CLI, gets an `ARG_OVERRIDES` entry in `scripts/connector-tool-contract.test.ts`.
  - CLI connectors also get `SWEEP_SEED`, plus `BOUND_TO_STATE` for bound tools, in
    `scripts/cli-argument-guards.test.ts`. Removing a tool removes its stale `BOUND_TO_STATE`
    entry.
- A prepare tool is registered in `src/tools.ts`, which the gateway's `prepare-tools.test.ts`
  reads, with `registerPrepareTool("<id>"`. Its prefix maps to its directory, or is added to
  `CONNECTOR_OF_PREFIX` in `shared/prepare-tool-ids.test.ts`.

**Names, tests, docs**
- `bun run sync:tool-names`, then `audit:tool-names`. Connectors whose list is derived (e.g.
  `readwise` via `collectionToolNames`) or skipped by `sync-tool-names.ts` are checked by hand.
- Tests assert behaviour, not file contents or paths.
- The connector README documents the tool, its credential and its write scope.
- `readwise` changes bump `version` in its `nimbus.extension.json` (`docs/publishing.md`).

**New connector only**
- `exports` entry; the pinned 98 in `connector-gates.test.ts` raised on purpose; `private: true`;
  dependency on the allow-list (and any `@types/*` in root `dependencies`, per
  `consumer-types.test.ts`); `npm view` before any install command.
- Contract-test maps as needed: `EXPECTED_SPAWNING` (`cli-argument-guards.test.ts`); `CLI_BACKED` /
  `NOT_HTTP` / `KEYLESS` / `ARG_OVERRIDES` (`connector-tool-contract.test.ts`); `bootEnv`
  (`connector-boot.test.ts`).
- This repo's prose counts are updated, each derived by a command quoted in the commit message
  (`connectors/*/src/server.ts` count): CLAUDE.md, README.md, CONTRIBUTING.md, `docs/architecture.md`,
  `docs/adding-a-connector.md`, `docs/configuration.md`, `standalone/src/launcher.ts`.

**Finish:** `bun run check` passes.

### 3. Trap check (self-review)

Before Phase 1 ends, the skill reads its own diff and answers, per added or changed tool. Each
question is phrased so that "yes" passes:

1. If it mutates, is it registered through the write registrar, in `server.ts`/`tools.ts`, with a
   `mutates` whose service prefix matches the gateway's `ConnectorServiceId`?
2. Is every model-chosen value that reaches a URL, path segment, header, host or CLI guarded at the
   schema?
3. Do its error paths avoid echoing credentials, auth headers, unbounded bodies or local paths,
   while still surfacing the status and a bounded upstream snippet (`mcpJsonResultIfOk`, or stderr
   for CLI tools)? The contract tests **require** that upstream text, so the goal is bounded and
   credential-free, not silent.
4. Is the name stable and consistent with the connector's naming, and is the description final?
   A later description edit counts as a definition change.

Anything not a clear "yes" is fixed or reported, never waved through.

### 4. Impact map (the gateway, `../Nimbus`)

All gateway work happens in Phase 2. Every class starts with the pin bump, `bun install`, the
generators (`gen:connector-write-manifest`, plus `gen:connector-registry` when `exports` changed),
then `bun run preflight:fast` and the suites named below. Gates that scan the installed package for
any class:

- `audit:connector-hosts`: a new host, env var (`*_URL|*_HOST|*_BASE|*_SITE`), URL string or CLI
  subcommand array needs `first-party-manifests.ts` or `connector-host-gaps.json`.
- `connector-code-execution-sync.test.ts`: every tool of a process-spawning connector (`athena`,
  `aws`, `azure`, `bigquery`, `cloud-logging`, `cloudwatch`, `gcp`, `iac`, `kubernetes`,
  `sagemaker`, `vertex-ai`) is classified. A new read goes in `REVIEWED_PROCESS_CONNECTORS.<id>.reads`
  (or the code-execution list for `az`/`gcloud`/`iac` reads).
- `remote-content.sync.test.ts`: it pins handler code shapes of existing writes, so even a
  behaviour-preserving refactor there can break it.
- `read-tool-registry.test.ts`: any `*_latest` string anywhere in the installed package must be in
  `EXTRA_READ_TOOL_IDS`, whether or not it backs a before-read.
- `audit:file-size`: every gateway file of 500 lines or more is locked at its exact baseline in
  `docs/structure-audit/file-size-baseline.json`, whether it is source or test, a row family or a
  shared module. So the skill checks each file against the baseline before editing it. When a
  locked file would grow, even by the one `import` that wires in a new sibling module:
  1. Move an existing block out to a sibling module first, so the locked file ends at or below its
     baseline. The FinOps split shows the pattern: `finops-connector-catalog.ts`,
     `lazy-mesh/finops-manifests.ts`, `lazy-mesh/phase3-finops.ts`.
  2. A baseline file that shrank fails the audit as stale until `bun run audit:file-size --update`
     is run and the baseline file is committed with the change.

  The skill names the rule and the pattern, not a list of files, since the list changes with every
  PR.
- Hard-coded counts: gateway tests and docs pin exact counts (rows, wave 4 rows, bundled
  connectors). The skill finds them by searching the gateway for the old number, next to the noun it
  counts, rather than from a list. Nimbus `CLAUDE.md` and `GEMINI.md` mirror each other and change
  together. Test assertions pin bare numbers (`toHaveLength(126)`), sometimes spelled out in a test
  title ("eight"), and subset counts sit beside totals (phase-3 spawns vs bundled connectors). The
  touched suites catch those, so they are run rather than searched for.

Per class, on top of that:

| Class | Gateway work |
|---|---|
| read tool added | the gates above; `read-tool-registry.ts` `EXTRA_READ_TOOL_IDS` if the name ends in no read verb and it backs a before-read or share replay; the connector docs page `packages/docs/src/content/docs/connectors/<id>.mdx`; roadmap row tick |
| write tool added | follow `.claude/commands/nimbus-connector-writes.md` (row, preview, before-state/confirm, refusals, reversibility, its tests and docs), **after the owner's answers in §7**. A new refusal goes in a sibling helper module, not in the shared `model-write-refusals.ts`, which is locked by size |
| first write on a read-only connector | as write, plus: the OAuth `defaultScopes` in `connector-catalog.ts` (Google Calendar requests only `calendar.readonly` today); **passing the granted scopes at spawn** (`auth/oauth-vault-tokens.ts`, `lazy-mesh/connector-spawns.ts`; today only Gmail gets them). An own-key-only service such as `google_calendar` reads its scopes without falling back to `google.oauth`. Plus any scope URL in `connector-host-gaps.json` |
| prepare tool added | `connector-writes/prepare-tools.ts` `PREPARE_TOOL_ID_BACKING`, and `prepare-tools.test.ts`, whose list equals ours and whose connector→`src/tools.ts` map lists only `github`, `gitlab`, `iac` and `kubernetes` today. Also `withBound` on the paired row. Prepare tools are not in `manifest.generated.ts` |
| behaviour fix | the gates above; roadmap row tick |
| definition change / removal | every reference to the id (rows, tests, docs); `packages/cli/src/agent-kits/steer-table.ts` + `STEER_TABLE_VERSION` if the tool is steered; the owner is told which approvals are suspended or orphaned |
| new connector | the generated bundled registry; `connector-catalog.ts`, `connector-secrets-manifest.ts`, `first-party-manifests.ts` and the enumerated list in `first-party-manifests.test.ts`; **spawn wiring** in `lazy-mesh/` (a `phase3-*.ts` group plus `phase3-config.ts`; without it the gateway bundles the connector and never starts it); the docs page; sync/indexing reported as an owner decision |

The skill does **not** follow `.claude/commands/nimbus-connector-authoring.md` as written: it is stale
(it requires `assertHitlRequired()`, which no longer exists, and a mandatory list/get/search triple)
and names none of the new-connector targets above. Fixing that file is a separate gateway docs
change (see Companion changes); until then the new-connector row above is the source.

The skill also greps the gateway for each affected tool id and connector id. A hit in a generated
file is fixed by its generator, never by hand. A hit is "acted on" when changed or deliberately left
with a stated reason. Every other hit goes in the report.

### 5. Branches and checkout hygiene

- **This repo.** On `main`, create a branch from `origin/main` (`feat/<connector>-<slug>` or
  `fix/…`). On another branch, use it. "Dirty" means uncommitted changes to tracked files and stops
  the run. Untracked files are left alone.
- **The gateway.** Always `git fetch` first. If `../Nimbus` is on a clean `main`, run `git switch
  -c dev/<you>/<topic> origin/main`. Otherwise, never switch the owner's checkout: run `git
  worktree add -b dev/<you>/<topic> ../Nimbus/.claude/worktrees/<slug> origin/main`, where the
  slug is a flat name with no slashes, then `bun install` there.
- Everywhere, stage by explicit path, never `git add -A` or `git add .`. Commit with the repo's
  conventions. Never push.

### 6. Two phases, because of the pin

- **Phase 1 (before release).** Only this repo: §2, §3, and a hand-off in the report naming the
  tools, their classes, the gateway work §4 predicts, and the owner questions §7 will ask. No
  gateway edit, docs included, so gateway docs never get ahead of the gateway's pin.
- **Phase 2 (after the release is published).** The owner invokes the same skill with `gateway
  <version>` from this repo. It runs `git fetch --tags` here, reads
  the pin from `../Nimbus/packages/gateway/package.json` with any leading `^` or `~` stripped (as
  `check-connector-version-skew.ts`'s `floorOf()` does), and derives what changed from `git diff
  connectors-v<pinned>..connectors-v<version>` in this repo. It asks the §7 questions in one message, then does §4 on one
  gateway branch, to a green `preflight:fast` and the touched suites. The Phase 1 hand-off is a
  cross-check only, and any disagreement is reported.

One connectors release maps to one gateway branch.

### 7. What stays the owner's

Asked in one message at the start of Phase 2, before any gateway edit, per write:

- **wave** (2, 3 or 4; the row type requires one);
- **offered to the model or not.** A wave 2/3 row with a preview is offerable by construction
  (`isModelOfferableRow`), so "not offered" means an entry in `MODEL_NEVER_OFFERED_REASONS` with
  the owner's reason. Every wave 4 row needs a confirm text (`confirm-rows.test.ts`); a wave 4 row
  offered to the model also needs a before-state reader or bound step (`isModelOfferableRow`);
- **reversibility** and its inverse, when that is a judgement call.

Also the owner's, asked when they arise: any definition change or removal of a shipped tool
(Phase 1, before code); whether a new connector is indexed by the gateway; new OAuth scopes, and
whether a connector starts receiving its granted scopes at spawn.

### 8. The report

Ends every run: change class; per repo — branch or worktree, commits, gates run and their result;
landing order (connectors PR → release → gateway PR, soon, since a minor gap fails the gateway's
version-skew audit); open owner decisions; references found and not acted on; and, for a new
connector crossing a round number, the `nimbus-dotgithub` follow-up.

## Verifying the skill

Its acceptance test is its first real use: Phase 1 on the smallest batch-1 write, a Bitbucket
pull-request comment tool, ending in a green `bun run check` and a hand-off whose gateway work matches
`nimbus-connector-writes.md`'s checklist. Bitbucket's README is a stub today, so this also exercises
README authoring. Phase 2 for the same tool, after its release, is the second half of the test.
Problems found are fixed in the skill before batch 1 continues.

## Companion changes

- `ROADMAP.md`: the "Connector follow-ups the gateway's write work named" row expands into the four
  batches agreed on 2026-11-26 (code review and issue writes; Google Calendar writes; infra reads and
  fixes; Unleash and Split), plus the Bitbucket merge-precondition investigation. Recorded as
  dropped: Opsgenie (replaced by Jira Service Management, OR-W34-7) and REST readers for
  `az`/`gcloud` (not taken, OR-97-1).
- Gateway docs (a separate `../Nimbus` branch): bring `.claude/commands/nimbus-connector-authoring.md`
  up to date. Drop `assertHitlRequired()` and the mandatory triple, point at this repo's
  `docs/adding-a-connector.md` for the connector half, and list the gateway's own new-connector
  targets from §4.

## Left to the builder

- Wording and layout of `SKILL.md`; whether the impact map and checklists live inline or in
  supporting files beside it.
- The `description` frontmatter, as long as it triggers on adding/changing/removing a connector tool
  or connector, and on `gateway <version>`.
