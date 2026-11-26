# Phase 2: the gateway's half

Runs only after the connectors release is published, when the owner invokes the skill with
`gateway <version>`. The gateway work happens in `../Nimbus`; the derive step runs in this repo. SKILL.md holds the outline, the owner
questions and the report format. This file holds the operational detail. Stop at local commits.

## Derive what changed

1. In this repo run `git fetch --tags`, and `git fetch` in `../Nimbus`.
2. Read the pin from the commit the gateway branch starts from, never from the owner's checkout:
   `git -C ../Nimbus show origin/main:packages/gateway/package.json`. Strip any leading `^` or `~`,
   as `floorOf()` in the gateway's `check-connector-version-skew.ts` does. If the checkout's
   `packages/gateway/package.json` pins a different version, report both before any owner question
   or gateway edit.
3. List the change with `git diff connectors-v<pinned>..connectors-v<version>` in this repo. That
   diff is the source of truth for tool ids, connector ids and classes.
4. Compare it with the Phase 1 hand-off. The hand-off is a cross-check only. Report any
   disagreement; do not resolve it silently in either direction.

## Ask the owner first

Before any gateway edit, send one message. Use this template, one block per write tool in the diff:

```
<tool id>  (<connector>, <class>)
  wave:                 2 | 3 | 4
  offered to the model: yes | no (if no, the reason for MODEL_NEVER_OFFERED_REASONS)
  reversible:           yes, inverse <tool id> | no | n/a (only when it is a judgement call)
  before-state reader:  yes, <read tool id> | no   (wave 2/3 only; see below)
  broadcast mentions:   scan with <rule> | none    (only when the service has no BroadcastService rule)
```

Rules for the answers:

- A wave 2/3 row with a preview is offerable by construction (`isModelOfferableRow`). "Not offered"
  therefore means an entry in `MODEL_NEVER_OFFERED_REASONS` with the owner's reason.
- A wave 4 row needs a confirm text (`confirm-rows.test.ts`). A wave 4 row offered to the model also
  needs a before-state reader or bound step.
- A before-state reader is optional on a wave 2/3 row, but ask when the precedent rows of the same
  kind have one (the GitHub and GitLab comment rows do). Adding one can mean editing a locked test
  such as `before-reader.test.ts`; say so in the question.
- Ask about broadcast mentions (`@everyone`, `@here`) for any write that posts text to a service
  without a `BroadcastService` rule. Never invent a rule; with no answer, state the bound in the test
  and the docs.
- Before citing a precedent's reversibility to the owner, read its entry in the gateway's
  reversibility table. A tool with no entry is unknown, not irreversible.
- Append the questions that arise only for some changes: whether a new connector is indexed by the
  gateway; new OAuth scopes; whether a connector starts receiving its granted scopes at spawn; for a
  new connector, confirmation of its service id and that `<id>` is added to
  `CONNECTOR_SERVICE_IDS`.
- When the release has no writes and no conditional questions, say so in the report and go on. Do not
  send an empty message.
- Wait for the answers. Do not guess a wave. Number the questions so the owner can answer by number.

## Branch or worktree

1. `git fetch` in `../Nimbus`.
2. If `../Nimbus` is on a clean `main`, run `git switch -c dev/asaf/<topic> origin/main`.
3. Otherwise never switch the owner's checkout. Run
   `git worktree add -b dev/asaf/<topic> ../Nimbus/.claude/worktrees/<slug> origin/main`, where
   `<slug>` is a flat name with no slashes, then `bun install` there.
4. One connectors release maps to one gateway branch. Stage by explicit path, never push.
5. A worktree under `.claude/worktrees/` fails the I15 user-MCP write-grant test and
   `mesh-user-mcp-write-grant.test.ts`, which refuse a path with a `.claude` segment. Run those on
   unmodified `origin/main` in the same worktree; when they fail identically there, report them as
   environment failures, not as the change's.

## Gates every class meets

Every class starts with the pin bump in `packages/gateway/package.json`, then `bun install`, then the
generators: `gen:connector-write-manifest`, plus `gen:connector-registry` when the package's
`exports` changed. Then `bun run preflight:fast` and the suites named below. A hit in a generated
file is fixed by its generator, never by hand.

These gates scan the installed package, whatever the class:

- `audit:connector-hosts`: a new host, env var (`*_URL|*_HOST|*_BASE|*_SITE`), URL string or CLI
  subcommand array needs `first-party-manifests.ts` or `connector-host-gaps.json`.
- `connector-code-execution-sync.test.ts`: every tool of a process-spawning connector (`athena`,
  `aws`, `azure`, `bigquery`, `cloud-logging`, `cloudwatch`, `gcp`, `iac`, `kubernetes`,
  `sagemaker`, `vertex-ai`) is classified. A new read goes in `REVIEWED_PROCESS_CONNECTORS.<id>.reads`.
  Terraform/pulumi tools that run on a directory go in the code-execution list; an aws-backed iac read
  is a reviewed read in `REVIEWED_PROCESS_CONNECTORS.iac.reads` (precedent:
  `iac_cloudformation_stack_get`).
- `remote-content.sync.test.ts`: it pins handler code shapes of existing writes, so even a
  behaviour-preserving refactor there can break it.
- `read-tool-registry.test.ts`: any `*_latest` string anywhere in the installed package must be in
  `EXTRA_READ_TOOL_IDS`, whether or not it backs a before-read.
- `audit:file-size`: every gateway file of 500 lines or more, source or test, row family or shared
  module, is locked at its exact baseline in `docs/structure-audit/file-size-baseline.json`. Test
  files and test fixtures count: a write row typically grows several locked ones
  (`remote-content-doors.test.ts`, `remote-content-fixtures.ts`, `model-write-source.test.ts`,
  `executor-confirm.test.ts`). Check each file against the baseline before editing it. When a
  locked file would grow, even by the one `import` that wires in a new sibling module:
  1. Move an existing block out to a sibling module first, so the locked file ends at or below its
     baseline. The FinOps split shows the pattern: `finops-connector-catalog.ts`,
     `lazy-mesh/finops-manifests.ts`, `lazy-mesh/phase3-finops.ts`.
  2. Some blocks cannot move. `HITL_REQUIRED_BACKING` in `engine/executor.ts` is module-private and
     hand-written by invariant I2. There, and in a locked test file, balance the added lines by
     condensing an existing comment instead (gateway precedent: #2132). Never compress code.
  3. A baseline file that shrank fails the audit as stale. Run `bun run audit:file-size --update`
     and commit the baseline file with the change.

  This is a rule and a pattern, not a list of files: the list changes with every PR.
- Hard-coded counts: gateway tests and docs pin exact counts (rows, wave 4 rows, bundled
  connectors). Find them by searching the gateway for the old number next to the noun it counts,
  never from memory. `CLAUDE.md` and `GEMINI.md` in the gateway mirror each other and change
  together. Test assertions pin bare numbers (`toHaveLength(126)`), sometimes spelled out in a test
  title ("eight"), and subset counts sit beside totals (phase-3 spawns vs bundled connectors). The
  touched suites catch those, so run them rather than searching.

## Per class

Everything below is on top of the gates above.

| Class | Gateway work |
|---|---|
| read tool added | `read-tool-registry.ts` `EXTRA_READ_TOOL_IDS` if the name ends in no read verb and it backs a before-read or share replay; the connector docs page `packages/docs/src/content/docs/connectors/<id>.mdx`; roadmap row tick |
| write tool added | follow `../Nimbus/.claude/commands/nimbus-connector-writes.md` (row, preview, before-state/confirm, refusals, reversibility, its tests and docs), after the owner's answers. Walk every item of that checklist (and its pitfalls) and name, for each tool, what the item needs, or `n/a` with a reason; an item left unnamed is a gap in the report. Then the write-row placement rules below the table |
| first write on a read-only connector | as write, plus: the OAuth `defaultScopes` in `connector-catalog.ts` (Google Calendar requests only `calendar.readonly` today); passing the granted scopes at spawn (`auth/oauth-vault-tokens.ts`, `lazy-mesh/connector-spawns.ts`; today only Gmail gets them). An own-key-only service such as `google_calendar` reads its scopes without falling back to `google.oauth`. Plus any scope URL in `connector-host-gaps.json` |
| prepare tool added | `connector-writes/prepare-tools.ts` `PREPARE_TOOL_ID_BACKING`, and `prepare-tools.test.ts`, whose list equals ours and whose connector-to-`src/tools.ts` map lists only `github`, `gitlab`, `iac` and `kubernetes` today. Also `withBound` on the paired row. Prepare tools are not in `manifest.generated.ts` |
| behaviour fix | the gates above; roadmap row tick |
| definition change / removal | every reference to the id (rows, tests, docs); `packages/cli/src/agent-kits/steer-table.ts` plus `STEER_TABLE_VERSION` if the tool is steered; tell the owner which approvals are suspended or orphaned |
| new connector | add `<id>` (the directory name, `-` as `_`) to `CONNECTOR_SERVICE_IDS`; the generated bundled registry; `connector-catalog.ts`, `connector-secrets-manifest.ts`, `first-party-manifests.ts` and the enumerated list in `first-party-manifests.test.ts`; spawn wiring in `lazy-mesh/` (a `phase3-*.ts` group plus `phase3-config.ts`; without it the gateway bundles the connector and never starts it); the docs page; sync/indexing reported as an owner decision |

Write-row placement, for every write tool added:

- **The row.** It goes in its family file. When that file is at its locked baseline, create a sibling
  row module (precedent: `bitbucket-comment-rows.ts`) and spread it in the rows index.
- **A new refusal function** goes in a sibling helper module, not in the shared
  `model-write-refusals.ts`, which is locked by size.
- **A new entry in an existing refusal table** (for example `REMOTE_CONTENT_SCANNED`, which is
  module-private and has a completeness tripwire) goes in place, in that table. Offset its lines by
  moving another block out of the file (precedent: `null-optional-refusals.ts`).
- **The family template test.** A row in a B1/B2/C*/D* family extends that family's test. A row in a
  sibling module gets its own `<module>.test.ts`: golden lines, drift keys against the installed
  schema, the offer, reversibility and refusals.
- **Hidden consequences.** A newly offerable row on a service breaks tests that pinned that service
  as having none (`c0-reclassify`, `d1-door`, the real-door service list in
  `model-write-source.test.ts`, the remote-content fixture table, the agent-door offerable count).
  Run every connector-writes, security-invariants and engine suite, not only the named ones.

`../Nimbus/.claude/commands/nimbus-connector-authoring.md` may be stale or refreshed at any time, and
this skill does not follow it: the new-connector row above is its source.

## Finish

1. Grep the gateway for each affected tool id and connector id. A hit is "acted on" when changed or
   deliberately left with a stated reason. Every other hit goes in the report.
2. Run `bun run preflight:fast` in the gateway, then the touched suites. Both must be green.
3. Commit locally on the gateway branch, by explicit path, with the gateway's commit conventions.
   Never push, open a PR or merge.
4. Fill in the report from SKILL.md, including the gateway branch or worktree name, its commits and
   the gates run.
