import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const SKILL_DIR = join(ROOT, ".claude", "skills", "connector-tool");

function readSkill(name: string): string {
  return readFileSync(join(SKILL_DIR, name), "utf8");
}

/** Every `#`-`###` heading's text, trimmed. */
function headings(md: string): string[] {
  const out: string[] = [];
  for (const line of md.split("\n")) {
    const m = /^#{1,3}\s+(.*)$/.exec(line);
    if (m?.[1] !== undefined) out.push(m[1].trim());
  }
  return out;
}

/** The leading `---` block's `key: value` lines; a folded `>` value is joined onto one line. */
function frontmatter(md: string): Record<string, string> {
  const lines = md.replaceAll("\r\n", "\n").split("\n");
  const out: Record<string, string> = {};
  if (lines[0] !== "---") return out;
  let key: string | undefined;
  for (const line of lines.slice(1)) {
    if (line === "---") break;
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (m?.[1] !== undefined && !line.startsWith(" ")) {
      key = m[1];
      const value = (m[2] ?? "").trim();
      out[key] = value === ">" || value === ">-" ? "" : value;
    } else if (key !== undefined) {
      out[key] = `${out[key] ?? ""} ${line.trim()}`.trim();
    }
  }
  return out;
}

/** True when the text holds a control character other than tab, LF and CR. */
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 0x00 && c <= 0x08) || c === 0x0b || c === 0x0c || (c >= 0x0e && c <= 0x1f)) {
      return true;
    }
  }
  return false;
}

describe("phase 1 file", () => {
  const md = () => readSkill("phase1-connector.md");

  test("has its sections", () => {
    expect(headings(md())).toEqual(
      expect.arrayContaining([
        "Registration",
        "First write on a read-only connector",
        "Guards",
        "Test fixtures",
        "Names, tests, docs",
        "New connector only",
        "Finish",
      ]),
    );
  });

  test("keeps the rules that bite after release", () => {
    for (const rule of [
      "createWriteToolRegistrar",
      "registerPrepareTool",
      "registersWriteTool",
      "src/tools.ts",
      "ConnectorServiceId",
      "resolveUrlWithBase",
      "ARG_OVERRIDES",
      "BOUND_TO_STATE",
      "drops `*_TOOL_NAMES`",
      "connector-gates.test.ts",
      "bun run check",
      "connector-write-scope.test.ts",
      "refuseBefore",
      "CONNECTOR_SERVICE_IDS",
      "kind:value",
      "Run the contract test first",
    ]) {
      expect(md()).toContain(rule);
    }
  });
});

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
        "Classify the change",
        "Phase 1",
        "Trap check",
        "Phase 2",
        "What stays the owner's",
        "The report",
      ]),
    );
  });

  test("keeps the rules the first run proved", () => {
    const md = readSkill("SKILL.md");
    for (const rule of [
      "fails for the right reason",
      "Gateway work predicted",
      "name, for each tool, what that item needs",
      "branch off",
      "nimbus-connector-writes.md",
    ]) {
      expect(md).toContain(rule);
    }
  });

  test("skill files contain no control characters", () => {
    // The heredoc trap: a \b once landed as a literal 0x08 and silenced a regex.
    for (const f of readdirSync(SKILL_DIR).filter((n) => n.endsWith(".md"))) {
      expect({ f, bad: hasControlCharacter(readSkill(f)) }).toEqual({ f, bad: false });
    }
  });
});

describe("phase 2 file", () => {
  const md = () => readSkill("phase2-gateway.md");
  test("has its sections", () => {
    expect(headings(md())).toEqual(
      expect.arrayContaining([
        "Derive what changed",
        "Ask the owner first",
        "Branch or worktree",
        "Gates every class meets",
        "Per class",
        "Finish",
      ]),
    );
  });
  test("keeps the rules that protect the owner", () => {
    for (const rule of [
      "git fetch --tags",
      "floorOf",
      "isModelOfferableRow",
      "MODEL_NEVER_OFFERED_REASONS",
      "git worktree add",
      "never switch",
      "audit:file-size --update",
      "EXTRA_READ_TOOL_IDS",
      "connector-spawns.ts",
      "nimbus-connector-writes.md",
      "preflight:fast",
      "Walk every item",
      "or `n/a` with a reason",
    ]) {
      expect(md()).toContain(rule);
    }
  });
  test("does not follow the stale authoring file", () => {
    expect(md()).toMatch(/nimbus-connector-authoring\.md[^\n]*(stale|not follow)/i);
  });
});
