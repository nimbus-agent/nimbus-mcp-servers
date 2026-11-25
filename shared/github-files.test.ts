import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readGithubFilesAt } from "./github-files.ts";

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const OPTS = { withContent: true, maxReadBytes: 1024 } as const;

describe("readGithubFilesAt", () => {
  it("throws GitHub's status and a capped body when a read fails", async () => {
    globalThis.fetch = (async () =>
      new Response("x".repeat(1000), { status: 500 })) as unknown as typeof globalThis.fetch;
    const err = await readGithubFilesAt("tok", "o", "r", "a".repeat(40), ["a.txt"], OPTS).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(`GitHub 500: ${"x".repeat(300)}`);
  });
});
