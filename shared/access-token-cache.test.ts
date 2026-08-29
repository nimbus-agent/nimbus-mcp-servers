import { describe, expect, it } from "bun:test";
import {
  type AccessTokenResponse,
  createAccessTokenCache,
  DEFAULT_SNIPPET_MAX,
} from "./access-token-cache.ts";

/** An exchange that counts its calls and answers with a canned response. */
function exchanger(...replies: AccessTokenResponse[]): {
  exchange: () => Promise<AccessTokenResponse>;
  calls: number;
} {
  const state = { calls: 0 };
  return {
    get calls(): number {
      return state.calls;
    },
    exchange: (): Promise<AccessTokenResponse> => {
      const reply = replies[Math.min(state.calls, replies.length - 1)];
      state.calls += 1;
      return Promise.resolve(reply ?? { ok: true, status: 200, text: "{}" });
    },
  };
}

const ok = (text: string): AccessTokenResponse => ({ ok: true, status: 200, text });

describe("createAccessTokenCache", () => {
  it("returns the token from the exchange", async () => {
    const ex = exchanger(ok('{"access_token":"tok-1"}'));
    expect(
      await createAccessTokenCache({ label: "Ramp token exchange", exchange: ex.exchange })(),
    ).toBe("tok-1");
  });

  it("exchanges once, then serves the cached token", async () => {
    const ex = exchanger(ok('{"access_token":"tok-1"}'));
    const token = createAccessTokenCache({ label: "L", exchange: ex.exchange });
    expect(await token()).toBe("tok-1");
    expect(await token()).toBe("tok-1");
    expect(ex.calls).toBe(1);
  });

  it("does NOT cache a failure — a transient 503 must not poison the process", async () => {
    // A long-running stdio connector caches for its whole lifetime, so caching
    // one failed exchange would break every later call until the client
    // restarts it.
    const ex = exchanger(
      { ok: false, status: 503, text: "upstream down" },
      ok('{"access_token":"t"}'),
    );
    const token = createAccessTokenCache({ label: "Superset login", exchange: ex.exchange });
    await expect(token()).rejects.toThrow("Superset login 503: upstream down");
    expect(await token()).toBe("t");
    expect(ex.calls).toBe(2);
  });

  it("names the exchange, not the service, when it fails", async () => {
    // "Superset login 401" tells a caller their credentials are wrong; a bare
    // "Superset 401" reads as the request they actually made having failed.
    const ex = exchanger({ ok: false, status: 401, text: "bad credentials" });
    await expect(
      createAccessTokenCache({ label: "Superset login", exchange: ex.exchange })(),
    ).rejects.toThrow("Superset login 401: bad credentials");
  });

  it("caps the body snippet in the error", async () => {
    const ex = exchanger({ ok: false, status: 500, text: "x".repeat(1000) });
    const err = await createAccessTokenCache({ label: "L", exchange: ex.exchange })().catch(
      (e: unknown) => e as Error,
    );
    expect(err.message).toBe(`L 500: ${"x".repeat(DEFAULT_SNIPPET_MAX)}`);
  });

  it("honours a custom snippet cap", async () => {
    const ex = exchanger({ ok: false, status: 500, text: "y".repeat(50) });
    await expect(
      createAccessTokenCache({ label: "L", exchange: ex.exchange, snippetMax: 5 })(),
    ).rejects.toThrow(`L 500: ${"y".repeat(5)}`);
  });

  it("distinguishes a non-JSON body from a missing token", async () => {
    const html = exchanger(ok("<html>login page</html>"));
    await expect(createAccessTokenCache({ label: "L", exchange: html.exchange })()).rejects.toThrow(
      "L: invalid JSON response",
    );

    const empty = exchanger(ok('{"detail":"nope"}'));
    await expect(
      createAccessTokenCache({ label: "L", exchange: empty.exchange })(),
    ).rejects.toThrow("L: no access_token in response");
  });

  it("rejects a token that is present but empty or the wrong type", async () => {
    for (const body of ['{"access_token":""}', '{"access_token":123}', '{"access_token":null}']) {
      const ex = exchanger(ok(body));
      await expect(createAccessTokenCache({ label: "L", exchange: ex.exchange })()).rejects.toThrow(
        "L: no access_token in response",
      );
    }
  });

  it("tolerates a null body", async () => {
    const ex = exchanger(ok("null"));
    await expect(createAccessTokenCache({ label: "L", exchange: ex.exchange })()).rejects.toThrow(
      "L: no access_token in response",
    );
  });

  it("reads a differently named token field", async () => {
    const ex = exchanger(ok('{"token":"tok-2"}'));
    expect(
      await createAccessTokenCache({ label: "L", exchange: ex.exchange, tokenField: "token" })(),
    ).toBe("tok-2");
  });

  it("does not exchange until the token is first needed", () => {
    const ex = exchanger(ok('{"access_token":"t"}'));
    createAccessTokenCache({ label: "L", exchange: ex.exchange });
    expect(ex.calls).toBe(0);
  });
});
