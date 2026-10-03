import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { postGraphql } from "./graphql-json.ts";

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Records the requests made and replies with a canned response. */
function stubFetch(reply: { status?: number; body: string }): { calls: Request[] } {
  const calls: Request[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(new Request(typeof input === "string" ? input : String(input), init));
    return new Response(reply.body, { status: reply.status ?? 200 });
  }) as typeof globalThis.fetch;
  return { calls };
}

const base = {
  url: "https://graphql.test/graphql",
  label: "Svc",
  headers: { Authorization: "Bearer tok" },
  query: "query Q { things { id } }",
};

describe("postGraphql", () => {
  it("POSTs the query and variables as JSON and resolves to `data`", async () => {
    const { calls } = stubFetch({ body: '{"data":{"things":[{"id":"1"}]}}' });
    const data = await postGraphql<{ things: { id: string }[] }>({
      ...base,
      variables: { first: 2 },
    });
    expect(data).toEqual({ things: [{ id: "1" }] });
    const call = calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe("https://graphql.test/graphql");
    expect(call?.headers.get("authorization")).toBe("Bearer tok");
    expect(call?.headers.get("content-type")).toBe("application/json");
    expect(call?.headers.get("accept")).toBe("application/json");
    expect(await call?.text()).toBe(JSON.stringify({ query: base.query, variables: { first: 2 } }));
  });

  it("leaves `variables` out of the body entirely when none are given", async () => {
    const { calls } = stubFetch({ body: '{"data":{}}' });
    await postGraphql(base);
    expect(await calls[0]?.text()).toBe(JSON.stringify({ query: base.query }));
  });

  it("throws `<label> <status>: <body>` on a non-2xx", async () => {
    stubFetch({ status: 401, body: "bad token" });
    await expect(postGraphql(base)).rejects.toThrow("Svc 401: bad token");
  });

  it("fails on an `errors` member even when `data` came back too", async () => {
    stubFetch({ body: '{"data":{"things":[]},"errors":[{"message":"partial"}]}' });
    await expect(postGraphql(base)).rejects.toThrow('Svc GraphQL error: [{"message":"partial"}]');
  });

  it("fails when the response carries no `data` member", async () => {
    stubFetch({ body: "{}" });
    await expect(postGraphql(base)).rejects.toThrow("Svc GraphQL: response missing `data` field");
  });

  it("caps the body snippet in a non-2xx error at 400 characters", async () => {
    stubFetch({ status: 500, body: "z".repeat(900) });
    let message = "";
    try {
      await postGraphql(base);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toBe(`Svc 500: ${"z".repeat(400)}`);
  });
});
