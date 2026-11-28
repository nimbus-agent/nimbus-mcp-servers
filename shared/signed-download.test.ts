import { describe, expect, it } from "bun:test";
import { fetchWithSignedHandoff } from "./signed-download.ts";

const API = "https://api.example.com/files/1/content";
const SIGNED = "https://storage.example.net/blob?sig=abc";

interface Seen {
  readonly url: string;
  readonly headers: Headers;
  readonly redirect: RequestInit["redirect"];
}

/** A transport that answers from `route` and records what it was asked. */
function transport(route: (url: string) => Response): {
  seen: Seen[];
  fetch: (url: string, init: RequestInit) => Promise<Response>;
} {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: async (url, init) => {
      seen.push({ url, headers: new Headers(init.headers), redirect: init.redirect });
      return route(url);
    },
  };
}

const redirectTo = (location: string, status = 302): Response =>
  new Response("", { status, headers: { location } });

const init = { headers: { Authorization: "Bearer secret" } };

describe("fetchWithSignedHandoff", () => {
  it("returns a non-redirect answer from the API origin as it is", async () => {
    const t = transport(() => new Response("bytes"));
    const res = await fetchWithSignedHandoff("Svc", API, init, { fetch: t.fetch });
    expect(await res.text()).toBe("bytes");
    expect(t.seen.map((s) => s.url)).toEqual([API]);
    expect(t.seen[0]?.redirect).toBe("manual");
    expect(t.seen[0]?.headers.get("authorization")).toBe("Bearer secret");
  });

  it("follows a same-origin redirect WITH the credential", async () => {
    const next = "https://api.example.com/other";
    const t = transport((u) => (u === API ? redirectTo(next) : new Response("ok")));
    await fetchWithSignedHandoff("Svc", API, init, { fetch: t.fetch });
    expect(t.seen.map((s) => s.url)).toEqual([API, next]);
    expect(t.seen[1]?.headers.get("authorization")).toBe("Bearer secret");
  });

  it("fetches a cross-origin https Location once, with no headers at all", async () => {
    const t = transport((u) => (u === API ? redirectTo(SIGNED) : new Response("signed bytes")));
    const res = await fetchWithSignedHandoff("Svc", API, init, { fetch: t.fetch });
    expect(await res.text()).toBe("signed bytes");
    expect(t.seen.map((s) => s.url)).toEqual([API, SIGNED]);
    expect([...(t.seen[1]?.headers.keys() ?? [])]).toEqual([]);
  });

  it("refuses a cross-origin target that is not https, sending nothing there", async () => {
    for (const location of ["http://storage.example.net/b", "file:///etc/passwd", "ftp://x/y"]) {
      const t = transport(() => redirectTo(location));
      await expect(fetchWithSignedHandoff("Svc", API, init, { fetch: t.fetch })).rejects.toThrow(
        "Svc redirected the download to a",
      );
      expect(t.seen).toHaveLength(1);
    }
  });

  it("refuses a second redirect from the signed URL", async () => {
    const t = transport(() => redirectTo(SIGNED));
    await expect(fetchWithSignedHandoff("Svc", API, init, { fetch: t.fetch })).rejects.toThrow(
      "Svc download URL redirected again; refused",
    );
    expect(t.seen).toHaveLength(2);
  });

  it("refuses a redirect with no Location, and an endless same-origin chain", async () => {
    const none = transport(() => new Response("", { status: 302 }));
    await expect(fetchWithSignedHandoff("Svc", API, init, { fetch: none.fetch })).rejects.toThrow(
      "Svc sent a redirect without a Location; refused",
    );
    const loop = transport(() => redirectTo(API));
    await expect(fetchWithSignedHandoff("Svc", API, init, { fetch: loop.fetch })).rejects.toThrow(
      "Svc sent too many redirects; refused",
    );
  });

  it("refuses a plain-http API URL before sending anything", async () => {
    const t = transport(() => new Response("x"));
    await expect(
      fetchWithSignedHandoff("Svc", "http://api.example.com/x", init, { fetch: t.fetch }),
    ).rejects.toThrow("Svc base URL must be https; refused");
    expect(t.seen).toHaveLength(0);
  });
});
