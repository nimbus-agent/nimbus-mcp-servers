import { describe, expect, test } from "bun:test";

import {
  assertCombinedSize,
  assertCommitFiles,
  COMMIT_MAX_COMBINED_BYTES,
  decodeBase64Text,
  isSafeCommitPath,
} from "./commit-files.ts";

describe("isSafeCommitPath", () => {
  test("accepts ordinary nested paths, dotfiles and unicode", () => {
    for (const p of ["a.txt", "src/a/b.ts", ".github/workflows/ci.yml", "docs/café.md", "a b/c"]) {
      expect(isSafeCommitPath(p)).toBe(true);
    }
  });

  test("refuses traversal, .git, separators in the wrong place, controls and overlength", () => {
    const bad = [
      "",
      "/a",
      "a/",
      "a//b",
      "./a",
      "a/./b",
      "../a",
      "a/../b",
      ".git/config",
      "a/.GIT/x",
      "a\\b",
      "a\nb",
      "a\u0000b",
      "a\u007fb",
      "x".repeat(1025),
    ];
    for (const p of bad) expect(isSafeCommitPath(p)).toBe(false);
    expect(isSafeCommitPath("x".repeat(1024))).toBe(true);
  });
});

describe("isSafeCommitPath: characters the preview cannot show faithfully", () => {
  // Written as escapes so this file holds no invisible character itself.
  const CASES: [string, string][] = [
    ["a right-to-left override", "src/\u202Egpj.exe"],
    ["a zero-width space", "src/a\u200Bb.ts"],
    ["a NEL control (C1)", "src/a\u0085b.ts"],
    ["a line separator", "src/a\u2028b.ts"],
    ["a paragraph separator", "src/a\u2029b.ts"],
    ["a byte-order mark", "src/\uFEFFa.ts"],
    ["a bidi isolate", "src/a\u2066b.ts"],
    ["a lone high surrogate", "src/a\uD800b.ts"],
    ["a lone low surrogate", "src/a\uDC00b.ts"],
    ["the last C1 control", "src/a\u009Fb.ts"],
  ];
  for (const [what, path] of CASES) {
    test(`refuses ${what}`, () => {
      expect(isSafeCommitPath(path)).toBe(false);
    });
  }

  test("still accepts ordinary non-ASCII text and a valid surrogate pair", () => {
    expect(isSafeCommitPath("docs/caf\u00e9.md")).toBe(true);
    expect(isSafeCommitPath("docs/\u{1F600}.md")).toBe(true);
    expect(isSafeCommitPath("docs/\u00a0x")).toBe(true);
  });
});

describe("isSafeCommitPath: NTFS and HFS spellings of .git", () => {
  for (const seg of [
    ".git",
    ".GIT",
    ".git.",
    ".git ",
    ".git. .",
    ".Git...",
    "git~1",
    "GIT~1",
    "git~1.",
    "...",
    ". ",
  ]) {
    test(`refuses the segment ${JSON.stringify(seg)} at any depth`, () => {
      expect(isSafeCommitPath(`${seg}/config`)).toBe(false);
      expect(isSafeCommitPath(`a/${seg}/config`)).toBe(false);
      expect(isSafeCommitPath(`a/${seg}`)).toBe(false);
    });
  }

  test("accepts names that merely resemble them", () => {
    for (const p of [
      ".gitignore",
      ".github/ci.yml",
      "git~2",
      "git~10",
      "x.git",
      ".gitx/y",
      "a. b",
    ]) {
      expect(isSafeCommitPath(p)).toBe(true);
    }
  });
});

describe("assertCommitFiles and assertCombinedSize", () => {
  test("a path and a path beneath it cannot both be files", () => {
    expect(() =>
      assertCommitFiles([
        { path: "a", content: "1" },
        { path: "a/b", content: "2" },
      ]),
    ).toThrow("path collision");
    // Order does not matter, and depth does not hide it.
    expect(() =>
      assertCommitFiles([
        { path: "x/y/z.txt", content: "2" },
        { path: "x/y", content: "1" },
      ]),
    ).toThrow("path collision");
    expect(() =>
      assertCommitFiles([
        { path: "a", content: "1" },
        { path: "ab/c", content: "2" },
        { path: "a.b", content: "3" },
      ]),
    ).not.toThrow();
  });

  test("duplicate paths and too many files are refused", () => {
    expect(() =>
      assertCommitFiles([
        { path: "a", content: "1" },
        { path: "a", content: "2" },
      ]),
    ).toThrow("duplicate file path");
    const many = Array.from({ length: 21 }, (_, i) => ({ path: `f${String(i)}`, content: "" }));
    expect(() => assertCommitFiles(many)).toThrow("at most 20 files");
  });

  test("the cap is on UTF-8 BYTES, old and new together", () => {
    // 3 bytes per character.
    const files = [{ path: "a", content: "€".repeat(COMMIT_MAX_COMBINED_BYTES / 3) }];
    expect(() => assertCommitFiles(files)).not.toThrow();
    expect(() => assertCombinedSize(1, files)).toThrow("commit too large");
    expect(() => assertCombinedSize(0, files)).not.toThrow();
    expect(() =>
      assertCommitFiles([{ path: "a", content: "x".repeat(COMMIT_MAX_COMBINED_BYTES + 1) }]),
    ).toThrow("commit too large");
  });
});

describe("decodeBase64Text", () => {
  test("decodes UTF-8 text, line-wrapped base64 included", () => {
    const b64 = Buffer.from("héllo", "utf8").toString("base64");
    expect(decodeBase64Text(`${b64.slice(0, 4)}\n${b64.slice(4)}`)).toEqual({ text: "héllo" });
  });

  test("invalid UTF-8 and NUL bytes are binary", () => {
    expect(decodeBase64Text(Buffer.from([0xff, 0xfe, 0x41]).toString("base64"))).toEqual({
      binary: true,
    });
    expect(decodeBase64Text(Buffer.from([0x41, 0x00]).toString("base64"))).toEqual({
      binary: true,
    });
  });
});
