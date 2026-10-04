import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { cursorListInputSchema } from "./cursor-list-tool.ts";

describe("cursorListInputSchema", () => {
  const schema = cursorListInputSchema();

  it("accepts a first page with no cursor, a null cursor, or an opaque one", () => {
    for (const args of [{}, { cursor: null }, { cursor: "eyJvZmZzZXQiOjIwMH0" }, { limit: 500 }]) {
      expect(schema.safeParse(args)).toEqual({ success: true, data: args });
    }
  });

  it("refuses a limit outside 1..500 or one that is not an integer", () => {
    for (const limit of [0, 501, 2.5]) {
      expect(schema.safeParse({ limit }).success).toBe(false);
    }
  });

  it("takes its ceiling from the caller", () => {
    const small = cursorListInputSchema(50);
    expect(small.safeParse({ limit: 50 }).success).toBe(true);
    expect(small.safeParse({ limit: 51 }).success).toBe(false);
  });

  it("publishes exactly the schema the six connectors each declared by hand", () => {
    const handWritten = z.object({
      cursor: z.string().nullable().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    });
    expect(z.toJSONSchema(schema as unknown as z.ZodType)).toEqual(z.toJSONSchema(handWritten));
  });
});
