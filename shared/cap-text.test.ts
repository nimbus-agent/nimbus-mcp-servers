import { describe, expect, it } from "bun:test";
import { capText, MAX_VENDOR_TEXT, TRUNCATION_MARKER } from "./cap-text.ts";

describe("capText", () => {
  it("passes a short string through and drops non-strings and empties", () => {
    expect(capText("ok")).toBe("ok");
    expect(capText("")).toBeUndefined();
    expect(capText(7)).toBeUndefined();
    expect(capText(null)).toBeUndefined();
  });

  it("keeps exactly the cap and marks anything longer", () => {
    expect(capText("a".repeat(MAX_VENDOR_TEXT))).toBe("a".repeat(MAX_VENDOR_TEXT));
    expect(capText("a".repeat(MAX_VENDOR_TEXT + 1))).toBe(
      `${"a".repeat(MAX_VENDOR_TEXT)}${TRUNCATION_MARKER}`,
    );
  });
});
