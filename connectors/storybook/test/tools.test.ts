import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CapturedTools, captureTools } from "../../../scripts/connector-tool-harness.ts";
import { loadStories } from "../src/storybook-parse.ts";
import { registerStorybookTools, STORYBOOK_TOOL_NAMES } from "../src/tools.ts";

const INDEX = {
  v: 5,
  entries: {
    "components-button--primary": {
      id: "components-button--primary",
      title: "Components/Button",
      name: "Primary",
      importPath: "./src/Button.stories.tsx",
      tags: ["autodocs", "story"],
      type: "story",
    },
    "components-button--docs": {
      id: "components-button--docs",
      title: "Components/Button",
      name: "Docs",
      importPath: "./src/Button.stories.tsx",
      tags: ["docs"],
      type: "docs",
    },
    "forms-input--with-error": {
      id: "forms-input--with-error",
      title: "Forms/Input",
      name: "With Error",
      importPath: "./src/Input.stories.tsx",
      tags: ["a11y"],
      type: "story",
    },
  },
};

const PRIMARY = {
  id: "components-button--primary",
  title: "Components/Button",
  name: "Primary",
  importPath: "./src/Button.stories.tsx",
  tags: ["autodocs", "story"],
  type: "story",
};

let dir: string;
let tools: CapturedTools;
const prev = process.env["STORYBOOK_DIR"];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nimbus-storybook-tools-"));
  process.env["STORYBOOK_DIR"] = dir;
  await writeFile(join(dir, "index.json"), JSON.stringify(INDEX), "utf8");
  tools = captureTools(registerStorybookTools);
});

afterEach(async () => {
  if (prev === undefined) {
    delete process.env["STORYBOOK_DIR"];
  } else {
    process.env["STORYBOOK_DIR"] = prev;
  }
  await rm(dir, { recursive: true, force: true });
});

type Envelope = Record<string, unknown>;

describe("storybook tools", () => {
  it("registers exactly STORYBOOK_TOOL_NAMES, in order", () => {
    expect(tools.registrationOrder()).toEqual([...STORYBOOK_TOOL_NAMES]);
  });

  it("list returns every story's metadata envelope", async () => {
    const out = (await tools.callJson("storybook_list")) as { items: Envelope[] };
    expect(out.items.map((s) => s["id"])).toEqual([
      "components-button--primary",
      "components-button--docs",
      "forms-input--with-error",
    ]);
    expect(out.items[0]).toEqual(PRIMARY);
  });

  it("list returns 500 stories by default and honours an explicit limit", async () => {
    const entries = Object.fromEntries(
      Array.from({ length: 501 }, (_, i) => [
        `s-${String(i)}`,
        { id: `s-${String(i)}`, name: "N" },
      ]),
    );
    await writeFile(join(dir, "index.json"), JSON.stringify({ entries }), "utf8");
    expect(((await tools.callJson("storybook_list")) as { items: Envelope[] }).items).toHaveLength(
      500,
    );
    const two = (await tools.callJson("storybook_list", { limit: 2 })) as { items: Envelope[] };
    expect(two.items.map((s) => s["id"])).toEqual(["s-0", "s-1"]);
  });

  it("get returns one story by id, or item: null", async () => {
    expect(await tools.callJson("storybook_get", { id: "components-button--primary" })).toEqual({
      item: PRIMARY,
    });
    expect(await tools.callJson("storybook_get", { id: "components-button" })).toEqual({
      item: null,
    });
  });

  it("search matches id, title, name and tags, case-insensitively", async () => {
    const ids = async (query: string, limit?: number): Promise<unknown[]> => {
      const out = (await tools.callJson("storybook_search", {
        query,
        ...(limit === undefined ? {} : { limit }),
      })) as { matches: Envelope[] };
      return out.matches.map((s) => s["id"]);
    };
    expect(await ids("FORMS-INPUT")).toEqual(["forms-input--with-error"]);
    expect(await ids("components/button")).toEqual([
      "components-button--primary",
      "components-button--docs",
    ]);
    expect(await ids("with error")).toEqual(["forms-input--with-error"]);
    expect(await ids("A11Y")).toEqual(["forms-input--with-error"]);
    expect(await ids("nothing-like-this")).toEqual([]);
    expect(await ids("button", 1)).toEqual(["components-button--primary"]);
  });

  it("every tool refuses when STORYBOOK_DIR is unset", async () => {
    delete process.env["STORYBOOK_DIR"];
    for (const [name, args] of [
      ["storybook_list", {}],
      ["storybook_get", { id: "x" }],
      ["storybook_search", { query: "x" }],
    ] as const) {
      await expect(tools.call(name, args)).rejects.toThrow("STORYBOOK_DIR is not set");
    }
  });
});

describe("loadStories — manifest bounds", () => {
  it("reads nothing from a manifest larger than 16 MiB, even a valid one", async () => {
    // Padded with JSON whitespace, so the file would parse to three stories if it were read:
    // only the size bound keeps them out.
    const json = JSON.stringify(INDEX);
    await writeFile(join(dir, "index.json"), json + " ".repeat(16 * 1024 * 1024 + 1 - json.length));
    expect(await loadStories()).toEqual([]);
  });

  it("falls back to the legacy stories.json when there is no index.json", async () => {
    await rm(join(dir, "index.json"));
    await writeFile(
      join(dir, "stories.json"),
      JSON.stringify({ v: 3, stories: { "a--b": { id: "a--b", kind: "A", story: "B" } } }),
      "utf8",
    );
    expect((await loadStories()).map((s) => [s.id, s.title, s.name])).toEqual([["a--b", "A", "B"]]);
  });
});
