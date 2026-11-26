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
| write tool added | `bitbucket_pr_comment_create`, `gcal_event_create` |
| first write on a read-only connector | anything in Google Calendar (today `calendar.readonly`) |
| prepare tool added | a `*_prepare` read the gateway calls before approval |
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
   branch, use it. Uncommitted changes to tracked files stop the run. Untracked files are left alone.
2. Read [docs/adding-a-connector.md](../../../docs/adding-a-connector.md) and follow the phase file:
   registration, guards, test fixtures, names, tests, docs, and the new-connector extras.
3. Run the trap check below on your own diff.
4. `bun run check` passes.
5. Commit with Conventional Commits subjects (release-please reads those).
6. Emit the hand-off in the report: the tools, their classes, the gateway work the phase 2 file
   predicts, and the owner questions it will ask.

## Trap check

Before Phase 1 ends, read your own diff and answer, per added or changed tool. Each question is phrased
so that "yes" passes:

1. If it mutates, is it registered through the write registrar, in `server.ts`/`tools.ts`, with a
   `mutates` whose service prefix matches the gateway's `ConnectorServiceId`?
2. Is every model-chosen value that reaches a URL, path segment, header, host or CLI guarded at the
   schema?
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

1. `git fetch --tags` here. Read the pin from `../Nimbus/packages/gateway/package.json`, stripping any
   leading `^` or `~`. Derive what changed from `git diff connectors-v<pinned>..connectors-v<version>`
   in this repo. The Phase 1 hand-off is a cross-check only, and any disagreement is reported.
2. Ask the owner's questions (next section) in one message, before any gateway edit.
3. `git fetch` in the gateway. If `../Nimbus` is on a clean `main`, run
   `git switch -c dev/<you>/<topic> origin/main`. Otherwise never switch the owner's checkout: run
   `git worktree add -b dev/<you>/<topic> ../Nimbus/.claude/worktrees/<slug> origin/main` with a flat
   slug (no slashes), then `bun install` there.
4. Do the gateway work for the change class on that one branch, to a green `bun run preflight:fast` and
   the touched suites.
5. Grep the gateway for each affected tool id and connector id. A hit is "acted on" when changed or
   deliberately left with a stated reason. Every other hit goes in the report.

One connectors release maps to one gateway branch. Every release with a `feat:` needs a gateway pin
bump soon after, because `audit:connector-version-skew` fails the gateway on a minor gap.

## What stays the owner's

Asked in one message at the start of Phase 2, before any gateway edit, per write:

- **wave** (2, 3 or 4; the row type requires one);
- **offered to the model or not.** A wave 2/3 row with a preview is offerable by construction
  (`isModelOfferableRow`), so "not offered" means an entry in `MODEL_NEVER_OFFERED_REASONS` with the
  owner's reason. Every wave 4 row needs a confirm text (`confirm-rows.test.ts`). A wave 4 row offered
  to the model also needs a before-state reader or bound step (`isModelOfferableRow`);
- **reversibility** and its inverse, when that is a judgement call.

Also the owner's, asked when they arise: any definition change or removal of a shipped tool (Phase 1,
before code); whether a new connector is indexed by the gateway; new OAuth scopes, and whether a
connector starts receiving its granted scopes at spawn.

## The report

Ends every run. Fill in:

```
Change class:      <class from the table>
This repo:         branch <name> · commits <sha subject, ...> · gates run: <command: result, ...>
Gateway:           branch or worktree <name or "not started"> · commits <...> · gates run: <...>
Landing order:     connectors PR -> release -> gateway PR (soon: a minor gap fails the gateway's
                   version-skew audit)
Open owner decisions: <wave, offered to model, reversibility, indexing, scopes, ... or "none">
References found and not acted on: <id, file, why left>
nimbus-dotgithub:  <only for a new connector crossing a round number (100, ...): manual follow-up>
```
