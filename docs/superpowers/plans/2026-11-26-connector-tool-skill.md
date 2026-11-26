# `connector-tool` Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a project skill, `connector-tool`, that adds or changes a connector tool here
(Phase 1) and, after release, does the gateway's half on a local branch (Phase 2). Prove it by
using it once on a real batch-1 tool.

**Architecture:** A lean `SKILL.md` workflow (classify → Phase 1 → trap check → hand-off;
`gateway <version>` → Phase 2 → report) with two supporting files that carry the detail:
`phase1-connector.md` (this repo) and `phase2-gateway.md` (`../Nimbus`). A bun test pins the
skill's frontmatter, its required sections and its load-bearing rules, so a later edit cannot
silently drop them. The existing `scripts/doc-links.test.ts` already resolves every relative link
in every `.md`, so this-repo references are written as relative links and rot is caught for free.

**Tech Stack:** Markdown (Claude Code skill format), Bun test, TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-11-26-connector-tool-skill-design.md` (revision 4). Executors
read it; each task below names the spec section it transcribes.

## Global Constraints

- Skill location: `.claude/skills/connector-tool/` in this repo; frontmatter `name: connector-tool`.
- Write every file with the Write/Edit tools, never a Bash heredoc. CLAUDE.md records the backslash
  trap.
- Files that live in this repo are referenced as **relative markdown links**, so that
  `doc-links.test.ts` checks them. Gateway files are referenced as plain code paths
  (`../Nimbus/...`), which that test ignores, since that repo may be absent.
- State rules, not enumerations of gateway files or line counts (spec status line, §4).
- The skill never pushes, opens PRs, releases or merges. It never stages with `git add -A` or
  `git add .`, never edits a repo's `main`, and never switches the owner's gateway checkout.
- Gateway branches are `dev/asaf/<topic>`, and gateway worktrees live at
  `../Nimbus/.claude/worktrees/<flat-slug>`. Branches here are `feat/…`, `fix/…` or `docs/…`.
- Commit subjects use Conventional Commits. Commit messages end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- No `any`. Test files are excluded from `tsc`, so write them carefully.
- `bun run check` passes at the end of every task in this repo.

## Review Focus

1. **The gateway checkout is not a clean `main`.** It isn't one today: `.claude/scheduled_tasks.lock`
   is deleted there. The expected behaviour is a worktree, never a switch of the owner's branch.
   Task 3's test pins `git worktree add` and the "never switch" rule.
2. **A wave 2/3 write with a preview becomes model-offerable as a side effect.** The skill must ask
   the owner before any gateway edit. Task 3's test pins `isModelOfferableRow` and
   `MODEL_NEVER_OFFERED_REASONS` in the owner-questions section.
3. **A `mutates` prefix that doesn't match the gateway's `ConnectorServiceId`** ships in an immutable
   release. Task 2's test pins the `ConnectorServiceId` check, and Task 6 exercises it on
   `bitbucket`.
4. **A write registered in a helper file** passes `bun run check` but makes the standalone launcher
   exit 3. Task 2's test pins the `server.ts`/`tools.ts` rule and `registersWriteTool`.
5. **A locked gateway file grows by one `import`.** The skill must move a block out first, then
   update the baseline. Task 3's test pins `audit:file-size --update`.

---

### Task 1: Skill skeleton and its guard test

**Files:**
- Create: `scripts/connector-tool-skill.test.ts`
- Create: `.claude/skills/connector-tool/SKILL.md`

**Interfaces:**
- Produces: `SKILL_DIR = join(ROOT, ".claude", "skills", "connector-tool")` (where `ROOT` is
  computed the way `scripts/doc-links.test.ts` computes it), and three helpers in the test file:
  - `readSkill(name: string): string`;
  - `headings(md: string): string[]`, every `#`–`###` heading's text, trimmed;
  - `frontmatter(md: string): Record<string, string>`, the leading `---` block's `key: value`
    lines, where a folded `>` value is joined onto one line.

  Tasks 2 and 3 add `describe` blocks that use them.

- [ ] **Step 1: Write the failing test** `scripts/connector-tool-skill.test.ts`:

```ts
describe("connector-tool skill", () => {
  test("declares its name and when to use it", () => {
    const fm = frontmatter(readSkill("SKILL.md"));
    expect(fm["name"]).toBe("connector-tool");
    for (const cue of ["connector tool", "new connector", "gateway <version>"]) {
      expect(fm["description"]?.toLowerCase()).toContain(cue);
    }
  });

  test("links both phase files", () => {
    const md = readSkill("SKILL.md");
    expect(md).toContain("](./phase1-connector.md)");
    expect(md).toContain("](./phase2-gateway.md)");
  });

  test("has the workflow sections the design requires", () => {
    expect(headings(readSkill("SKILL.md"))).toEqual(
      expect.arrayContaining([
        "Classify the change", "Phase 1", "Trap check", "Phase 2", "What stays the owner's", "The report",
      ]),
    );
  });

  test("skill files contain no control characters", () => {
    // The heredoc trap: a \b once landed as a literal 0x08 and silenced a regex.
    for (const f of readdirSync(SKILL_DIR).filter((n) => n.endsWith(".md"))) {
      expect({ f, bad: /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(readSkill(f)) }).toEqual({ f, bad: false });
    }
  });
});
```

- [ ] **Step 2: Run it.** `bun test scripts/connector-tool-skill.test.ts` should FAIL, because
  `SKILL.md` is missing (ENOENT).

- [ ] **Step 3: Write `.claude/skills/connector-tool/SKILL.md`**
  - Frontmatter `description`: trigger on adding, changing or removing a connector tool, adding a
    new connector, and `gateway <version>`.
  - Body, about 120–180 lines:
    - **Classify the change:** spec §1, the table plus the "raise definition changes before code"
      rule.
    - **Phase 1:** steps, linking `./phase1-connector.md`.
    - **Trap check:** spec §3, the four questions verbatim.
    - **Phase 2:** spec §6, mode `gateway <version>`, linking `./phase2-gateway.md`.
    - **What stays the owner's:** spec §7.
    - **The report:** spec §8, as a fill-in template.
  - Create empty `phase1-connector.md` and `phase2-gateway.md` stubs with a `#` title each, so the
    links resolve.

- [ ] **Step 4: Run it.** `bun test scripts/connector-tool-skill.test.ts scripts/doc-links.test.ts`
  should PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/connector-tool-skill.test.ts .claude/skills/connector-tool/SKILL.md .claude/skills/connector-tool/phase1-connector.md .claude/skills/connector-tool/phase2-gateway.md
git commit -m "feat(skills): add connector-tool skill workflow"
```

### Task 2: Phase 1 file (this repo's half)

**Files:**
- Modify: `.claude/skills/connector-tool/phase1-connector.md`
- Modify: `scripts/connector-tool-skill.test.ts`

**Interfaces:**
- Consumes: `readSkill`, `headings` from Task 1.

- [ ] **Step 1: Add the failing test block**

```ts
describe("phase 1 file", () => {
  const md = () => readSkill("phase1-connector.md");
  test("has its sections", () => {
    expect(headings(md())).toEqual(expect.arrayContaining([
      "Registration", "First write on a read-only connector", "Guards", "Test fixtures",
      "Names, tests, docs", "New connector only", "Finish",
    ]));
  });
  test("keeps the rules that bite after release", () => {
    for (const rule of [
      "createWriteToolRegistrar", "registerPrepareTool", "registersWriteTool", "src/tools.ts",
      "ConnectorServiceId", "resolveUrlWithBase", "ARG_OVERRIDES", "BOUND_TO_STATE",
      "drops `*_TOOL_NAMES`", "connector-gates.test.ts", "bun run check",
    ]) expect(md()).toContain(rule);
  });
});
```

- [ ] **Step 2: Run it.** `bun test scripts/connector-tool-skill.test.ts` should FAIL on the missing
  headings.

- [ ] **Step 3: Write `phase1-connector.md`** by transcribing spec §2, its subsections in the
  order listed. Use relative links for this repo's files: `../../../shared/consent-kit.ts`,
  `../../../docs/adding-a-connector.md`, `../../../scripts/connector-tool-contract.test.ts`,
  `../../../scripts/cli-argument-guards.test.ts`, `../../../shared/prepare-tool-ids.ts`,
  `../../../connectors/gmail/src/tool-scope-policy.ts`, `../../../CLAUDE.md`. Give the
  `ConnectorServiceId` check its concrete command: read
  `../Nimbus/packages/gateway/src/connectors/connector-catalog.ts` and confirm that each new
  `mutates` starts with an id it defines.

- [ ] **Step 4: Run it.** `bun test scripts/connector-tool-skill.test.ts scripts/doc-links.test.ts`
  should PASS.

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/connector-tool/phase1-connector.md scripts/connector-tool-skill.test.ts
git commit -m "feat(skills): connector-tool phase 1 checklist"
```

### Task 3: Phase 2 file (the gateway's half)

**Files:**
- Modify: `.claude/skills/connector-tool/phase2-gateway.md`
- Modify: `scripts/connector-tool-skill.test.ts`

**Interfaces:**
- Consumes: `readSkill`, `headings` from Task 1.

- [ ] **Step 1: Add the failing test block**

```ts
describe("phase 2 file", () => {
  const md = () => readSkill("phase2-gateway.md");
  test("has its sections", () => {
    expect(headings(md())).toEqual(expect.arrayContaining([
      "Derive what changed", "Ask the owner first", "Branch or worktree", "Gates every class meets",
      "Per class", "Finish",
    ]));
  });
  test("keeps the rules that protect the owner", () => {
    for (const rule of [
      "git fetch --tags", "floorOf", "isModelOfferableRow", "MODEL_NEVER_OFFERED_REASONS",
      "git worktree add", "never switch", "audit:file-size --update", "EXTRA_READ_TOOL_IDS",
      "connector-spawns.ts", "nimbus-connector-writes.md", "preflight:fast",
    ]) expect(md()).toContain(rule);
  });
  test("does not follow the stale authoring file", () => {
    expect(md()).toMatch(/nimbus-connector-authoring\.md[^\n]*(stale|not follow)/i);
  });
});
```

- [ ] **Step 2: Run it.** `bun test scripts/connector-tool-skill.test.ts` should FAIL.

- [ ] **Step 3: Write `phase2-gateway.md`**:
  - **Derive what changed:** spec §6, Phase 2.
  - **Ask the owner first:** spec §7, as one message template with a wave / offered / reversible
    line per write.
  - **Branch or worktree:** spec §5, gateway bullet.
  - **Gates every class meets:** spec §4 preamble, in rule form.
  - **Per class:** spec §4, the table.
  - **Finish:** `bun run preflight:fast`, the touched suites, a local commit, then the report.

  Every gateway path is written as plain code (`../Nimbus/...`), never as a link.

- [ ] **Step 4: Run it.** `bun test scripts/connector-tool-skill.test.ts scripts/doc-links.test.ts`
  should PASS. Then run `bun run check`, which should PASS.

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/connector-tool/phase2-gateway.md scripts/connector-tool-skill.test.ts
git commit -m "feat(skills): connector-tool phase 2 gateway map"
```

### Task 4: Roadmap batches

**Files:**
- Modify: `ROADMAP.md`, the "Connector follow-ups the gateway's write work named" row.

- [ ] **Step 1: Replace the row.** Its parent bullet keeps its link to Phase 9.7. Under it go five
  unticked sub-rows:
  1. **Code review and issue writes:** GitHub PR review / line comment, Bitbucket PR comment,
     GitHub/GitLab label and assignee remove, GitHub/GitLab issue title and body edit, Jira
     assignee, Linear labels.
  2. **Google Calendar writes:** create, update, delete. This is the first write on the connector,
     and the gateway must pass the granted scopes at spawn.
  3. **Infra reads and fixes:** `aws_lambda_get`; Snowflake `TAG_REFERENCES` selecting
     `tag_database` and `tag_schema`; `iac_terraform_init`; a read of a stack's change sets.
  4. **Flag connectors:** Unleash and Split, as new connectors with writes.
  5. **Investigate:** a head-commit precondition for `bitbucket_pr_merge`. It may be impossible
     upstream.

  After them, add one "Dropped" line: Opsgenie (replaced by Jira Service Management, OR-W34-7), and
  REST readers for `az`/`gcloud` (not taken, OR-97-1).

- [ ] **Step 2: Verify.** `bun test scripts/doc-links.test.ts` should PASS.

- [ ] **Step 3: Commit**

```bash
git add ROADMAP.md
git commit -m "docs(roadmap): split the Phase 9.7 follow-ups into four batches"
```

### Task 5: Refresh the gateway's stale authoring file (`../Nimbus`)

**Files:**
- Modify: `../Nimbus/.claude/commands/nimbus-connector-authoring.md`, in a worktree.

- [ ] **Step 1: Create the worktree.** The gateway checkout is dirty, so do not switch it.

```bash
git -C ../Nimbus fetch origin
git -C ../Nimbus worktree add -b dev/asaf/connector-authoring-refresh ../Nimbus/.claude/worktrees/connector-authoring-refresh origin/main
```

  Expected: a new worktree on `dev/asaf/connector-authoring-refresh`.
- [ ] **Step 2: Edit the file in the worktree.**
  - Remove every `assertHitlRequired()` requirement and the mandatory `list`/`get`/`search` items,
    including in its checklist.
  - Point the connector half at
    `https://github.com/nimbus-agent/nimbus-mcp-servers/blob/main/docs/adding-a-connector.md`.
  - Add a "Gateway half of a new connector" section listing the targets from spec §4's
    new-connector row.
  - Correct the claim that omitting `hitlRequired` bypasses the gateway gate. The gate is
    `HITL_REQUIRED_BACKING` plus `CONNECTOR_WRITE_ROWS`.
- [ ] **Step 3: Verify.** In the worktree, run `bun install` and then `bun run preflight:fast`. It
  should PASS. Check `git -C <worktree> diff --stat`: it should touch only that one file.
- [ ] **Step 4: Commit in the worktree**, with `git add .claude/commands/nimbus-connector-authoring.md`
  and the subject `docs(skills): bring connector authoring in line with nimbus-mcp-servers`. Do not
  push.

### Task 6: Acceptance run, Phase 1 on `bitbucket_pr_comment_create`

The skill is the thing under test. The executor **invokes the `connector-tool` skill** and follows
it. Where the skill and this task disagree, or the skill is silent, that is a skill defect: record
it for Task 7, and do not quietly do the right thing.

**Files (expected outcome):**
- Modify: `connectors/bitbucket/src/tools.ts`, `connectors/bitbucket/test/tools.test.ts`,
  `connectors/bitbucket/README.md` (currently a stub)
- Possibly modify: `scripts/connector-tool-contract.test.ts` (`ARG_OVERRIDES`, if the skill says
  so)

**The tool's contract** (the values the skill's run must arrive at):
- Name `bitbucket_pr_comment_create`, registered with the existing `registerWriteTool` in
  `src/tools.ts`, with `mutates: "bitbucket.pr.comment.create"`. Its prefix is the gateway's
  `bitbucket` service id, following the convention of `github.issue.comment.create`.
- `scopeTargetOf: (p) => ({ kind: "repo", value: p.repoFull })`, and `recoverable: true`, since a
  comment can be deleted.
- Schema: `repoFullArg.extend({ pullRequestId: z.number().int().min(1), body:
  z.string().min(1).max(32_768), path: z.string().min(1).max(4096).optional(), line:
  z.number().int().min(1).optional() })`. `line` is accepted only together with `path`; refuse it
  otherwise.
- Request: `POST ${repoPath(repoFull)}/pullrequests/${id}/comments`, with the JSON body
  `{ content: { raw: body } }`, plus `inline: { path, to: line }` when `path` is given.

- [ ] **Step 1: Branch.** Run `git switch -c feat/bitbucket-pr-comment` from
  `docs/connector-tool-skill`. The skill files must exist in the working tree. The skill's
  "already on a non-main branch" rule applies.
- [ ] **Step 2: Invoke the skill** (`connector-tool`), adding `bitbucket_pr_comment_create`.
  Expected: it classifies the change as "write tool added".
- [ ] **Step 3: Write the failing tests** in `connectors/bitbucket/test/tools.test.ts`, in the
  file's existing stub style:
  - `it("posts a general comment as content.raw")`: one POST to
    `${REPO_PATH}/pullrequests/7/comments` with the body `{"content":{"raw":"hi"}}`.
  - `it("posts an inline comment with path and line")`: the body has
    `inline: { path: "src/a.ts", to: 12 }`.
  - `it("refuses line without path")`: rejects, and sends nothing.
  - `it("quotes the upstream status on failure")`: given a 403 reply, the message contains `403`.
- [ ] **Step 4: Run them.** `bun test connectors/bitbucket` should FAIL with the tool not
  registered.
- [ ] **Step 5: Implement the tool** as the contract says, then run `bun run sync:tool-names` so
  `BITBUCKET_TOOL_NAMES` gains the id.
- [ ] **Step 6: Run the skill's trap check**, and record its four answers in the run notes.
- [ ] **Step 7: Rewrite `connectors/bitbucket/README.md`** to cover tools, credentials
  (`BITBUCKET_USERNAME`, `BITBUCKET_APP_PASSWORD`) and the write scope
  `NIMBUS_MCP_BITBUCKET_WRITE_SCOPE` with kind `repo`.
- [ ] **Step 8: Verify.** `bun run check` should PASS.
- [ ] **Step 9: Get the skill's report.** Expected: a Phase 2 hand-off naming `nimbus-connector-writes.md`, the §7
  questions for this tool, and "connectors PR → release → gateway PR". Compare it line by line with
  `../Nimbus/.claude/commands/nimbus-connector-writes.md`'s checklist. Every checklist item it
  omits is a defect.
- [ ] **Step 10: Commit** on `feat/bitbucket-pr-comment`, with explicit paths, subject
  `feat(bitbucket): add bitbucket_pr_comment_create`.

### Task 7: Fold the acceptance findings back into the skill

**Files:**
- Modify: whichever of the three skill files the Task 6 defects point at, plus
  `scripts/connector-tool-skill.test.ts` for any rule a defect shows to be load-bearing.

- [ ] **Step 1: Add the test first.** For each Task 6 defect that is a missing or wrong rule, add
  its phrase to the matching "keeps the rules" list, then run
  `bun test scripts/connector-tool-skill.test.ts`. It should FAIL.
- [ ] **Step 2: Fix the skill text,** on `docs/connector-tool-skill`. Switch back to that branch,
  and afterwards rebase `feat/bitbucket-pr-comment` onto it.
- [ ] **Step 3: Verify.** `bun run check` should PASS on both branches.
- [ ] **Step 4: Commit** `fix(skills): connector-tool findings from the first run`. If there were
  no defects, record "none", skip the commit, and state that.

## Not in this plan

- **Phase 2 of the acceptance test.** It needs `bitbucket_pr_comment_create` released, which is an
  owner act. After the release, the owner runs `connector-tool gateway <version>`.
- **Batches 1–4 beyond the acceptance tool.** Each gets its own run of the skill.
- **Pushing or opening PRs** for `docs/connector-tool-skill`, `feat/bitbucket-pr-comment` or the
  gateway worktree branch. The skill PR lands first and the feature PR stacks on it.
