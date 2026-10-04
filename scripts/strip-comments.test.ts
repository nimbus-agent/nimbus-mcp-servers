import { describe, expect, test } from "bun:test";
import { stripComments } from "./strip-comments.ts";

describe("stripComments", () => {
  test("drops a line comment, trailing ones included, and keeps the newline", () => {
    expect(stripComments("const a = 1; // trailing\nconst b = 2;\n")).toBe(
      "const a = 1; \nconst b = 2;\n",
    );
  });

  test("drops a block comment but keeps its newlines, so line numbers survive", () => {
    expect(stripComments("a/* one\ntwo\n*/b")).toBe("a\n\nb");
  });

  test("leaves comment markers inside every kind of string alone", () => {
    const src = [
      'const u = "http://x/*y*/"; // c',
      "const v = 'a//b'; // c",
      "const w = `/* not a comment */`; // c",
    ].join("\n");
    expect(stripComments(src)).toBe(
      [
        'const u = "http://x/*y*/"; ',
        "const v = 'a//b'; ",
        "const w = `/* not a comment */`; ",
      ].join("\n"),
    );
  });

  test("an escaped quote does not end the string it is in", () => {
    expect(stripComments(String.raw`x = "a\"//b"; // c`)).toBe(String.raw`x = "a\"//b"; `);
  });

  test("a backslash ending the input inside a string is kept, not read past", () => {
    expect(stripComments('x = "abc\\')).toBe('x = "abc\\');
  });

  test("an unterminated block comment swallows the rest of the input", () => {
    expect(stripComments("keep /* never closed\nexport const lost = 1;\n")).toBe("keep ");
  });

  test("a line comment on the last line, with no newline after it, is dropped", () => {
    expect(stripComments("keep // and no newline")).toBe("keep ");
  });
});
