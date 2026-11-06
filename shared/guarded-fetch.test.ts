import { afterEach, describe, expect, it } from "bun:test";
import { guardedFetch, MAX_REDIRECT_HOPS } from "./guarded-fetch.ts";

type Step = Response | Error;

/** A scripted transport: each call pops the next step and records the URL and init it saw. */
function scripted(steps: Step[]): {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const step = steps.shift();
      if (step === undefined) throw new Error("unscripted request");
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

const redirect = (status: number, location?: string): Response =>
  new Response(null, { status, headers: location === undefined ? {} : { location } });
const ok = (): Response => new Response("done", { status: 200 });

describe("guardedFetch redirects", () => {
  it("refuses a redirect to a userinfo URL that names another host", async () => {
    const t = scripted([redirect(302, "https://api.example.com@evil.test/")]);
    await expect(
      guardedFetch("Svc", "https://api.example.com/x", {}, { fetch: t.fetch }),
    ).rejects.toThrow(/another origin/);
    expect(t.calls).toHaveLength(1);
  });

  it("refuses a protocol-relative Location that names another host", async () => {
    const t = scripted([redirect(302, "//evil.test/x")]);
    await expect(
      guardedFetch("Svc", "https://api.example.com/x", {}, { fetch: t.fetch }),
    ).rejects.toThrow(/another origin/);
    expect(t.calls).toHaveLength(1);
  });

  it("treats an explicit default port as the same origin", async () => {
    const t = scripted([redirect(301, "https://api.example.com:443/y"), ok()]);
    const res = await guardedFetch("Svc", "https://api.example.com/x", {}, { fetch: t.fetch });
    expect(res.status).toBe(200);
    expect(t.calls).toHaveLength(2);
  });

  it("treats a differently cased host as the same origin", async () => {
    const t = scripted([redirect(301, "https://API.Example.COM/y"), ok()]);
    const res = await guardedFetch("Svc", "https://api.example.com/x", {}, { fetch: t.fetch });
    expect(res.status).toBe(200);
  });

  it("refuses an https to http downgrade on the same host", async () => {
    const t = scripted([redirect(302, "http://api.example.com/x")]);
    await expect(
      guardedFetch("Svc", "https://api.example.com/x", {}, { fetch: t.fetch }),
    ).rejects.toThrow(/another origin/);
    expect(t.calls).toHaveLength(1);
  });

  it("follows a 303 and a 307 on HEAD within the origin", async () => {
    for (const status of [303, 307]) {
      const t = scripted([redirect(status, "/moved"), ok()]);
      const res = await guardedFetch(
        "Svc",
        "https://api.example.com/x",
        { method: "HEAD" },
        { fetch: t.fetch },
      );
      expect(res.status).toBe(200);
      expect(t.calls[1]?.url).toBe("https://api.example.com/moved");
    }
  });

  it("refuses a redirect with no Location", async () => {
    const t = scripted([redirect(302)]);
    await expect(
      guardedFetch("Svc", "https://api.example.com/x", {}, { fetch: t.fetch }),
    ).rejects.toThrow(/without a Location/);
  });

  it("follows exactly MAX_REDIRECT_HOPS hops and refuses the next", async () => {
    const hops = Array.from({ length: MAX_REDIRECT_HOPS + 1 }, (_, i) =>
      redirect(302, `/h${String(i)}`),
    );
    const t = scripted(hops);
    await expect(
      guardedFetch("Svc", "https://api.example.com/x", {}, { fetch: t.fetch }),
    ).rejects.toThrow(/too many redirects/);
    expect(t.calls).toHaveLength(MAX_REDIRECT_HOPS + 1);
  });

  it("refuses any redirect on a POST without a second request", async () => {
    const t = scripted([redirect(301, "/moved")]);
    await expect(
      guardedFetch("Svc", "https://api.example.com/x", { method: "POST" }, { fetch: t.fetch }),
    ).rejects.toThrow(/answered a POST with a redirect \(301\); the write may or may not have been applied/);
    expect(t.calls).toHaveLength(1);
  });
});

describe("guardedFetch http bases", () => {
  const opts = (t: ReturnType<typeof scripted>) => ({ fetch: t.fetch, requireSecureBase: false });

  it("follows a same-host http -> https upgrade, re-sending the credential header", async () => {
    const t = scripted([redirect(301, "https://ci.internal/x"), ok()]);
    const res = await guardedFetch(
      "Svc",
      "http://ci.internal/x",
      { headers: { "Zotero-API-Key": "k" } },
      opts(t),
    );
    expect(res.status).toBe(200);
    expect(t.calls.map((c) => c.url)).toEqual(["http://ci.internal/x", "https://ci.internal/x"]);
    expect((t.calls[1]?.init.headers as Record<string, string>)["Zotero-API-Key"]).toBe("k");
  });

  it("refuses an http -> https redirect to another host", async () => {
    const t = scripted([redirect(301, "https://evil.test/x")]);
    await expect(guardedFetch("Svc", "http://ci.internal/x", {}, opts(t))).rejects.toThrow(
      /another origin/,
    );
    expect(t.calls).toHaveLength(1);
  });

  it("refuses an http -> https upgrade that changes the port", async () => {
    const t = scripted([redirect(301, "https://ci.internal:8443/x")]);
    await expect(guardedFetch("Svc", "http://ci.internal/x", {}, opts(t))).rejects.toThrow(
      /another origin/,
    );
  });

  it("follows a same-origin http -> http redirect on a plain-http base", async () => {
    const t = scripted([redirect(302, "/y"), ok()]);
    const res = await guardedFetch("Svc", "http://ci.internal/x", {}, opts(t));
    expect(res.status).toBe(200);
    expect(t.calls[1]?.url).toBe("http://ci.internal/y");
  });

  it("never follows https -> http", async () => {
    const t = scripted([redirect(302, "http://ci.internal/x")]);
    await expect(guardedFetch("Svc", "https://ci.internal/x", {}, opts(t))).rejects.toThrow(
      /another origin/,
    );
  });
});

describe("guardedFetch default transport", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("sends redirect manual and a timeout signal", async () => {
    let seen: RequestInit | undefined;
    globalThis.fetch = (async (_u: string, init?: RequestInit) => {
      seen = init;
      return ok();
    }) as unknown as typeof globalThis.fetch;
    await guardedFetch("Svc", "https://api.example.com/x");
    expect(seen?.redirect).toBe("manual");
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });
});
