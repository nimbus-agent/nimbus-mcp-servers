import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { stubFetch } from "../../../scripts/connector-tool-harness.ts";
import { createFetchJmapClient, parseAddressList } from "../src/jmap-client.ts";

const TOKEN = "FASTMAIL_API_TOKEN";
const BASE = "FASTMAIL_BASE_URL";

const SESSION = {
  apiUrl: "https://api.fastmail.com/jmap/api/",
  primaryAccounts: { "urn:ietf:params:jmap:mail": "acct1" },
};

function emailListResponse(ids: string[]): unknown {
  return {
    methodResponses: [
      [
        "Email/get",
        {
          list: ids.map((id) => ({
            id,
            subject: `Subject ${id}`,
            receivedAt: "2026-01-02T03:04:05Z",
            from: [{ email: "s@example.test" }],
            to: [{ email: "r@example.test" }],
            preview: "hello",
          })),
        },
        "eg",
      ],
    ],
  };
}

describe("parseAddressList", () => {
  it("extracts the address from a display-name form", () => {
    expect(parseAddressList("Alice <a@example.test>")).toEqual([{ email: "a@example.test" }]);
  });

  it("splits on commas and trims", () => {
    expect(parseAddressList("a@x.test, Bob <b@y.test> ")).toEqual([
      { email: "a@x.test" },
      { email: "b@y.test" },
    ]);
  });

  it("drops empty entries rather than emitting blank addresses", () => {
    expect(parseAddressList("a@x.test,,  ,")).toEqual([{ email: "a@x.test" }]);
  });

  it("keeps a bare address when the angle brackets are unbalanced", () => {
    expect(parseAddressList("Alice <a@example.test")).toEqual([{ email: "Alice <a@example.test" }]);
  });
});

describe("createFetchJmapClient", () => {
  let stub: ReturnType<typeof stubFetch> | undefined;

  beforeEach(() => {
    process.env[TOKEN] = "token-123";
    delete process.env[BASE];
  });

  afterEach(() => {
    stub?.restore();
    stub = undefined;
    delete process.env[TOKEN];
    delete process.env[BASE];
  });

  it("refuses to construct without a token", () => {
    delete process.env[TOKEN];
    expect(() => createFetchJmapClient()).toThrow("FASTMAIL_API_TOKEN is not set");
  });

  it("discovers the session once and reuses it across calls", async () => {
    stub = stubFetch((req) =>
      req.url.endsWith("/jmap/session")
        ? JSON.stringify(SESSION)
        : JSON.stringify(emailListResponse(["e1"])),
    );
    const client = createFetchJmapClient();
    await client.list(10);
    await client.list(10);
    const sessionCalls = stub.calls.filter((c) => c.url.endsWith("/jmap/session"));
    expect(sessionCalls).toHaveLength(1);
    expect(sessionCalls[0]?.headers["authorization"]).toBe("Bearer token-123");
  });

  it("honours FASTMAIL_BASE_URL and strips its trailing slash", async () => {
    process.env[BASE] = "https://jmap.self-hosted.test/";
    stub = stubFetch((req) =>
      req.url.endsWith("/jmap/session")
        ? JSON.stringify({ ...SESSION, apiUrl: "https://jmap.self-hosted.test/api/" })
        : JSON.stringify(emailListResponse([])),
    );
    await createFetchJmapClient().list(1);
    expect(stub.calls[0]?.url).toBe("https://jmap.self-hosted.test/jmap/session");
  });

  it("refuses an apiUrl pointing at another host — the SSRF guard", async () => {
    // A JMAP session response is server-controlled, and the next request to
    // `apiUrl` carries the bearer token. Redirecting it off-host would hand the
    // credential to whoever answers.
    stub = stubFetch(JSON.stringify({ ...SESSION, apiUrl: "https://evil.test/jmap/api/" }));
    await expect(createFetchJmapClient().list(1)).rejects.toThrow();
  });

  it("reports the status when session discovery fails", async () => {
    stub = stubFetch({ status: 401, body: "nope" });
    await expect(createFetchJmapClient().list(1)).rejects.toThrow("JMAP session failed: HTTP 401");
  });

  it("reports the status when an api call fails", async () => {
    stub = stubFetch((req) =>
      req.url.endsWith("/jmap/session")
        ? { body: JSON.stringify(SESSION) }
        : { status: 500, body: "boom" },
    );
    await expect(createFetchJmapClient().list(1)).rejects.toThrow("JMAP api failed: HTTP 500");
  });

  it("rejects a session response with no apiUrl or mail account", async () => {
    stub = stubFetch(JSON.stringify({ primaryAccounts: {} }));
    await expect(createFetchJmapClient().list(1)).rejects.toThrow(
      "JMAP session response missing apiUrl / mail account",
    );
  });

  describe("list / search / get", () => {
    beforeEach(() => {
      stub = stubFetch((req) =>
        req.url.endsWith("/jmap/session")
          ? JSON.stringify(SESSION)
          : JSON.stringify(emailListResponse(["e1", "e2"])),
      );
    });

    it("returns a view per email the server listed", async () => {
      const views = await createFetchJmapClient().list(2);
      expect(views.map((v) => v.id)).toEqual(["e1", "e2"]);
      expect(views[0]?.subject).toBe("Subject e1");
    });

    it("POSTs the query to the session's apiUrl", async () => {
      await createFetchJmapClient().search("invoice", 5);
      const api = stub?.calls.find((c) => c.url === SESSION.apiUrl);
      expect(api?.method).toBe("POST");
      expect(api?.body).toContain("invoice");
    });

    it("returns the first match for get, and null when there is none", async () => {
      expect((await createFetchJmapClient().get("e1"))?.id).toBe("e1");

      stub?.restore();
      stub = stubFetch((req) =>
        req.url.endsWith("/jmap/session")
          ? JSON.stringify(SESSION)
          : JSON.stringify(emailListResponse([])),
      );
      expect(await createFetchJmapClient().get("missing")).toBeNull();
    });
  });

  describe("send", () => {
    const DISCOVERY = {
      methodResponses: [
        ["Identity/get", { list: [{ id: "id1", email: "me@fastmail.test" }] }, "id"],
        ["Mailbox/query", { ids: ["drafts1"] }, "mq"],
      ],
    };
    const CREATED = {
      methodResponses: [
        ["Email/set", { created: { draft: { id: "email1" } } }, "es"],
        ["EmailSubmission/set", { created: { sub: { id: "sub1" } } }, "sub"],
      ],
    };

    function stubSend(discovery: unknown = DISCOVERY, created: unknown = CREATED): void {
      let apiCalls = 0;
      stub = stubFetch((req) => {
        if (req.url.endsWith("/jmap/session")) {
          return JSON.stringify(SESSION);
        }
        apiCalls += 1;
        return JSON.stringify(apiCalls === 1 ? discovery : created);
      });
    }

    it("creates the draft and submits it, returning both ids", async () => {
      stubSend();
      expect(
        await createFetchJmapClient().send({
          to: "you@example.test",
          subject: "Hi",
          body: "Body",
        }),
      ).toEqual({ emailId: "email1", submissionId: "sub1" });
    });

    it("sends from the discovered identity, not from a caller-supplied address", async () => {
      stubSend();
      await createFetchJmapClient().send({ to: "you@example.test", subject: "s", body: "b" });
      const set = stub?.calls.at(-1)?.body ?? "";
      expect(set).toContain('"from":[{"email":"me@fastmail.test"}]');
    });

    it("includes cc and bcc only when supplied", async () => {
      stubSend();
      await createFetchJmapClient().send({
        to: "you@example.test",
        subject: "s",
        body: "b",
        cc: "c@example.test",
      });
      const set = stub?.calls.at(-1)?.body ?? "";
      expect(set).toContain('"cc":[{"email":"c@example.test"}]');
      expect(set).not.toContain('"bcc"');
    });

    it("refuses when the identity or Drafts mailbox cannot be resolved", async () => {
      stubSend({ methodResponses: [["Identity/get", { list: [] }, "id"]] });
      await expect(
        createFetchJmapClient().send({ to: "you@example.test", subject: "s", body: "b" }),
      ).rejects.toThrow("could not resolve sending identity or Drafts mailbox");
    });

    it("reports null ids when the server created nothing", async () => {
      stubSend(DISCOVERY, { methodResponses: [] });
      expect(
        await createFetchJmapClient().send({ to: "you@example.test", subject: "s", body: "b" }),
      ).toEqual({ emailId: null, submissionId: null });
    });
  });
});
