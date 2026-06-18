# Build prompt — `nimbus-mcp-servers`

Copy everything below into a fresh Claude Code session opened in a clone of `nimbus-agent/nimbus-mcp-servers`, with the main `nimbus-agent/Nimbus` repo available locally for reference.

---

I'm building **`nimbus-mcp-servers`**: publishing a curated subset of Nimbus's first-party connectors as **standalone** MCP servers that any MCP client (Claude Desktop, Cursor, …) can run, decoupled from the Nimbus gateway. This repo is AGPL-3.0.

**Before any code, this needs a real design decision — start with brainstorming, not implementation.**

**Read first in the main Nimbus repo:**
- One or two real connectors end-to-end: `packages/mcp-connectors/github/` and `packages/mcp-connectors/linear/` — server entry, manifest, sync handler, and **how they consume credentials/env**.
- The skill `.claude/commands/nimbus-connector-authoring.md`.
- The I15 (sandbox / `wrapServerSpec`) and credential-injection model in `CLAUDE.md` / `docs/SECURITY-INVARIANTS.md`, so the coupling you must remove is precise.

**Key decisions to resolve in brainstorming (these are load-bearing):**
1. **Decouple vs vendor vs fork** — how to publish standalone servers without forking 94 connectors into permanent drift from the monorepo. (Shared package? Build step that strips gateway seams? Monorepo `exports`?)
2. **Credential model outside the Vault** — standalone servers get secrets from environment variables; document this clearly and safely (no Vault, no gateway).
3. **AGPL implications** — what AGPL-3.0 means for downstream MCP clients embedding these servers; make attribution + obligations explicit.
4. **Which connectors first** — pick 3–5 that are genuinely standalone-friendly (token/env auth, no gateway-only indexing assumptions).

**Deliverables (after the design is settled):**
1. A packaging approach + repo structure for standalone servers.
2. The **first** standalone connector published to npm (e.g. `@nimbus/mcp-github`) with its own README and copy-paste install instructions for Claude Desktop and Cursor (MCP server config with env-provided credentials).
3. A template/checklist for porting the next connectors.

**Acceptance criteria:**
- The published server runs in a real Claude Desktop / Cursor MCP config using only env-provided credentials, with no Nimbus gateway present.
- No gateway-internal sandbox/Vault code is required at runtime.
- AGPL attribution is correct and documented.

**Process:** brainstorm → spec → plan. Do NOT start porting connectors before the decouple strategy is decided and written down. Verify the first server works in a real MCP client before opening the PR. License is AGPL-3.0.
