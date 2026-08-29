import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { fixtureFor, type ParsableSchema } from "./tool-arg-fixture.ts";

/** Assert the derived fixture is one the schema itself accepts. */
function accepted(schema: z.ZodTypeAny, seed?: Record<string, unknown>): unknown {
  const args = fixtureFor(schema as unknown as ParsableSchema, seed);
  expect(args).not.toBeUndefined();
  expect(schema.safeParse(args).success).toBe(true);
  return args;
}

describe("fixtureFor", () => {
  it("returns {} for a schema with no required fields", () => {
    expect(fixtureFor(z.object({}) as unknown as ParsableSchema)).toEqual({});
  });

  it("leaves optional fields out", () => {
    expect(accepted(z.object({ limit: z.number().int().optional() }))).toEqual({});
  });

  it("fills a required string, number and boolean", () => {
    const args = accepted(
      z.object({ id: z.string(), count: z.number(), flag: z.boolean() }),
    ) as Record<string, unknown>;
    expect(typeof args["id"]).toBe("string");
    expect(typeof args["count"]).toBe("number");
    expect(typeof args["flag"]).toBe("boolean");
  });

  it("satisfies a minimum length rather than sending an empty string", () => {
    const args = accepted(z.object({ q: z.string().min(4) })) as { q: string };
    expect(args.q.length).toBeGreaterThanOrEqual(4);
  });

  it("satisfies a numeric minimum", () => {
    const args = accepted(z.object({ n: z.number().int().min(5) })) as { n: number };
    expect(args.n).toBeGreaterThanOrEqual(5);
  });

  it("respects a maximum alongside a minimum", () => {
    accepted(z.object({ limit: z.number().int().min(1).max(3) }));
    accepted(z.object({ name: z.string().min(2).max(3) }));
  });

  it("fills a required array", () => {
    const args = accepted(z.object({ ids: z.array(z.string()).min(1) })) as { ids: string[] };
    expect(args.ids.length).toBeGreaterThan(0);
  });

  it("fills a required nested object", () => {
    accepted(z.object({ opts: z.object({}) }));
  });

  it("picks a member of an enum", () => {
    const args = accepted(z.object({ state: z.enum(["open", "closed"]) })) as { state: string };
    expect(["open", "closed"]).toContain(args.state);
  });

  it("picks the value of a literal", () => {
    accepted(z.object({ kind: z.literal("repo") }));
  });

  it("gives up on a format no generic value satisfies", () => {
    // A uuid or a url is not derivable from the schema: the caller is told so it
    // can supply an override, rather than being handed something invalid.
    expect(fixtureFor(z.object({ id: z.uuid() }) as unknown as ParsableSchema)).toBeUndefined();
    expect(fixtureFor(z.object({ url: z.url() }) as unknown as ParsableSchema)).toBeUndefined();
  });

  it("uses a seed to satisfy exactly those formats", () => {
    const args = accepted(z.object({ id: z.uuid() }), {
      id: "00000000-0000-4000-8000-000000000000",
    }) as { id: string };
    expect(args.id).toBe("00000000-0000-4000-8000-000000000000");
  });

  it("fills the rest of the object around a seed", () => {
    const args = accepted(z.object({ id: z.uuid(), name: z.string().min(1) }), {
      id: "00000000-0000-4000-8000-000000000000",
    }) as { name: string };
    expect(args.name.length).toBeGreaterThan(0);
  });

  it("carries a seed key the schema does not declare without breaking it", () => {
    // A plain z.object strips unknown keys at parse time, so an over-broad
    // per-connector override cannot corrupt a tool that does not take that
    // argument — the fixture still validates and the declared field is filled.
    const schema = z.object({ q: z.string().min(1) });
    const args = accepted(schema, { unrelated: "x" }) as Record<string, unknown>;
    expect(typeof args["q"]).toBe("string");
    expect(schema.parse(args)).toEqual({ q: args["q"] as string });
  });

  it("gives up on a cross-field refinement it cannot reason about", () => {
    const schema = z
      .object({ a: z.string().min(1), b: z.string().min(1) })
      .refine((v) => v.a !== v.b, { message: "a and b must differ" });
    expect(fixtureFor(schema as unknown as ParsableSchema)).toBeUndefined();
  });
});
