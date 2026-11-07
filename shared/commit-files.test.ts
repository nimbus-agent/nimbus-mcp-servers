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

describe("assertCommitFiles and assertCombinedSize", () => {
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
