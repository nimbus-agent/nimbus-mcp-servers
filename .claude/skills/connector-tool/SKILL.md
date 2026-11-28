---
name: connector-tool
description: >
  Use when adding, changing or removing a connector tool in this repo, adding a new connector, or when
  the owner invokes it with `gateway <version>` after a connectors release. Phase 1 does this repo's half
  (registration, guards, tests, docs, trap check) to a green `bun run check`. Phase 2 does the gateway's
  half in `../Nimbus` on a local branch. Never pushes, releases or merges.
---

# connector-tool

One run of "add or change a connector tool" crosses into the gateway repo (`../Nimbus`): the tool lands
here, is released, and the gateway then needs a pin bump, its generators re-run and, for a write, a
write row, a preview and an owner ruling. This skill does this repo's half correctly, checks the traps
only a careful reader can check, and then, once the release exists, does the gateway's half on a local
branch.

Rules that always apply:

- This repo's [CLAUDE.md](../../../CLAUDE.md) non-negotiables and traps apply verbatim.
- Stop at local commits. Never push, open a PR, cut a release or merge.
- Stage by explicit path. Never `git add -A` or `git add .`. Never edit `main`, and never move the
  owner's checkout off their branch.
- Write every file with Write/Edit, never a Bash heredoc.
- Generated files are fixed by their generator, never by hand. Counts are derived by a command, never
  typed from memory.

## Classify the change

| Class | Example |
|---|---|
| read tool added | `aws_lambda_get` |
| write tool added | `bitbucket_pr_comment_create` |
| first write on a read-only connector | the first write on a connector with none (precedent: Google Calendar, 0.20.0); supersedes "write tool added" and includes all of it |
| prepare tool added | a read the gateway calls before approval (listed in `shared/prepare-tool-ids.ts`; named `*_commit_prepare`, `*_plan`, `*_show_json` or `*_changeset_create`) |
| behaviour fix, definition unchanged | Snowflake `TAG_REFERENCES` columns |
| definition change: description, input schema, or name | any edit to what a tool lists |
| tool removed | none |
| new connector | `unleash`, `split` |

A definition change or removal is raised with the owner **before** any code is written, stating the
V97 consequence for that case: the gateway hashes `{ toolId, description, inputSchema }`, so an edited
description or schema suspends an approved tool until it is re-approved, and a rename or removal leaves
the old approval "missing" and the new id unapproved. The default recommendation is a new tool rather
than reshaping a shipped one. Description edits on shipped tools are avoided unless they are the point.

## Phase 1

This repo's half, before any release. Only this repo: no gateway edit, docs included, so gateway docs
never get ahead of the gateway's pin. The steps are in [phase1-connector.md](./phase1-connector.md).
In outline:

1. Branch: on `main`, create `feat/<connector>-<slug>` (or `fix/...`) from `origin/main`. On another
   branch, use it, unless the owner's brief names a new branch: then `git switch -c` it from the
   current one. If the current branch is a `feat/` or `fix/` branch for a *different* connector or
   tool, do not reuse it: branch from `origin/main`, or ask if unsure. One item, one branch, one
   release. Never branch off `main` behind the brief's back. Uncommitted changes to tracked
   files stop the run. Untracked files are left alone.
2. Read [docs/adding-a-connector.md](../../../docs/adding-a-connector.md) and follow the phase file:
   registration, guards, test fixtures, names, tests, docs, and the new-connector extras.
3. Run the trap check below on your own diff. Write each new test first, and see it fail for the
   right reason. An assertion that a call is rejected passes just as well when the tool is not
   registered at all, so assert on the refusal's message. A RED test that fails for the right reason
   is the only RED that counts: read each failure before going on.
4. `bun run check` passes. When it fails for a reason outside the diff (a nested `worktrees/`
   checkout, a Bun older than `.bun-version`), do not wave it through: run its parts by hand
   (`bun test`, `bunx biome check`, `bun run typecheck`, the `audit:*` scripts) and name in the report
   which gate was replaced and why.
5. Commit with Conventional Commits subjects (release-please reads those).
6. Emit the hand-off in the report: the tools, their classes, the "Gateway work predicted" field, and
   the owner questions it will ask. For each write, the gateway work is: walk every item of
   `../Nimbus/.claude/commands/nimbus-connector-writes.md`'s checklist (and its pitfalls) and
   name, for each tool, what that item needs, or `n/a` with a reason. Do not copy the checklist here; it is the gateway's and
   drifts. Name an individual gateway test or doc only when that file does not make it findable.

## Trap check

Before Phase 1 ends, read your own diff and answer, per added or changed tool. Each question is phrased
so that "yes" passes:

1. If it mutates, is it registered through the write registrar, in `server.ts`/`tools.ts`, with a
   `mutates` whose service prefix matches the gateway's `ConnectorServiceId` (for a new connector,
   the directory name with `-` as `_`, with "add `<id>` to `CONNECTOR_SERVICE_IDS`" in the hand-off)?
2. Is every model-chosen value that reaches a URL, path segment, header, host or CLI guarded at the
   schema, and does the connector refuse redirects on writes?
3. Do its error paths avoid echoing credentials, auth headers, unbounded bodies or local paths, while
   still surfacing the status and a bounded upstream snippet (`mcpJsonResultIfOk`, or stderr for CLI
   tools)? The contract tests **require** that upstream text, so the goal is bounded and
   credential-free, not silent.
4. Is the name stable and consistent with the connector's naming, and is the description final? A later
   description edit counts as a definition change.

Anything not a clear "yes" is fixed or reported, never waved through.

## Phase 2

The gateway's half, after the connectors release is published. The owner invokes this skill from this
repo with `gateway <version>`. The steps are in [phase2-gateway.md](./phase2-gateway.md). In outline:

1. `git fetch --tags` here and `git fetch` in the gateway. Read the pin from the branch base,
   `git -C ../Nimbus show origin/main:packages/gateway/package.json`, never from the owner's
   checkout, stripping any leading `^` or `~`. A different pin in the checkout is reported first. Derive what changed from `git diff connectors-v<pinned>..connectors-v<version>`
   in this repo. The Phase 1 hand-off is a cross-check only, and any disagreement is reported.
2. Ask the owner's questions (next section) in one message, before any gateway edit. When there are
   none, say so in the report and go on.
3. `git fetch` in the gateway. If `../Nimbus` is on a clean `main`, run
   `git switch -c dev/asaf/<topic> origin/main`. Otherwise never switch the owner's checkout: run
   `git worktree add -b dev/asaf/<topic> ../Nimbus/.claude/worktrees/<slug> origin/main` with a flat
   slug (no slashes), then `bun install` there.
4. Do the gateway work for the change class on that one branch, to a green `bun run preflight:fast` and
   the touched suites.
5. Grep the gateway for each affected tool id and connector id. A hit is "acted on" when changed or
   deliberately left with a stated reason. Every other hit goes in the report.

One connectors release maps to one gateway branch. Every release with a `feat:` needs a gateway pin
bump, or the gateway never ships the new tools. A publish here never blocks the gateway (Nimbus#2192,
2026-11-27): `bun run report:connector-version-skew` there says what is published but unpinned, and
never fails. A Nimbus release PR may merge before or after the bump.

## What stays the owner's

Asked in one message at the start of Phase 2, before any gateway edit, per write:

- **wave** (2, 3 or 4; the row type requires one);
- **offered to the model or not.** A wave 2/3 row with a preview is offerable by construction
  (`isModelOfferableRow`), so "not offered" means an entry in `MODEL_NEVER_OFFERED_REASONS` with the
  owner's reason. Every wave 4 row needs a confirm text (`confirm-rows.test.ts`). A wave 4 row offered
  to the model also needs a before-state reader or bound step (`isModelOfferableRow`).
  Confirm on the whole id unless the id is known to be opaque or random: a tail of an id with
  internal structure names the wrong part (a Google Calendar occurrence id is `<seriesId>_<timestamp>`, so
  `{eventId:tail8}` named only the time of day);
- **reversibility** and its inverse, when that is a judgement call. Name a candidate inverse only if
  a tool for it exists, else say there is none. A precedent with no reversibility entry is unknown,
  not irreversible;
- **a before-state reader** on a wave 2/3 row, when the precedent rows of its kind have one;
- **broadcast-mention scanning**, for a write that posts text to a service with no
  `BroadcastService` rule.

Also the owner's, asked when they arise: any definition change or removal of a shipped tool (Phase 1,
before code); a tool that writes local state or runs code the caller names (e.g.
`iac_terraform_init`), which is classified with the owner before code; whether a new connector is
indexed by the gateway; a new connector's service id (to be added to `CONNECTOR_SERVICE_IDS`); new
OAuth scopes, and whether a connector starts receiving its granted scopes at spawn.

## The report

Ends every run. Fill in:

```
Change class:      <class from the table>
This repo:         branch <name> · commits <sha subject, ...> · gates run: <command: result, ...>
Gateway:           branch or worktree <name or "not started"> · commits <...> · gates run: <...>
Landing order:     connectors PR -> release -> gateway PR (the gateway ships the new tools only
                   once the pin moves; nothing fails meanwhile)
Gateway work predicted: <per write tool, each item of the gateway checklist: what it needs, or n/a + reason>
Open owner decisions: <wave, offered to model, reversibility, indexing, scopes, ... or "none">
References found and not acted on: <id, file, why left>
nimbus-dotgithub:  <only for a new connector crossing a round number (100, ...): manual follow-up>
```
