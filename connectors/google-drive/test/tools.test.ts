import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type CapturedTools, captureTools } from "../../../scripts/connector-tool-harness.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../../../shared/connector-mode.ts";
import { GOOGLE_DRIVE_TOOL_NAMES, registerGoogleDriveTools } from "../src/tools.ts";

const TOKEN = "GOOGLE_OAUTH_ACCESS_TOKEN";

interface Reply {
  readonly status?: number;
  readonly body?: string;
  readonly bytes?: Uint8Array;
  readonly headers?: Record<string, string>;
}

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly body: string | undefined;
}

let originalFetch: typeof globalThis.fetch;
let seen: Seen[] = [];
let tools: CapturedTools;

/**
 * Answer each request from a queue, or from a matcher keyed on the URL.
 *
 * Drive's download path makes TWO requests — metadata, then the media or export
 * endpoint — so a single canned reply cannot exercise it.
 */
function respond(route: (url: string, index: number) => Reply): void {
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({
      url,
      method: init?.method ?? "GET",
      authorization: headers["Authorization"],
      contentType: headers["Content-Type"],
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const reply = route(url, seen.length - 1);
    const payload = (reply.bytes ?? reply.body ?? "{}") as BodyInit;
    return new Response(payload, { status: reply.status ?? 200, headers: reply.headers });
  }) as typeof globalThis.fetch;
}

/** Every request answered the same way. */
function always(reply: Reply): void {
  respond(() => reply);
}

beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
  originalFetch = globalThis.fetch;
  seen = [];
  process.env[TOKEN] = "ya29.token";
  tools = captureTools(registerGoogleDriveTools);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env[TOKEN];
  resetConnectorModeForTests();
});

describe("registerGoogleDriveTools", () => {
  it("registers exactly the tools it declares", () => {
    expect(tools.names()).toEqual([...GOOGLE_DRIVE_TOOL_NAMES].sort());
  });

  it("refuses every tool without an access token, before sending anything", async () => {
    always({});
    delete process.env[TOKEN];
    for (const name of GOOGLE_DRIVE_TOOL_NAMES) {
      await expect(
        tools.call(name, {
          fileId: "f1",
          query: "q",
          name: "n",
          newName: "n2",
          newParentId: "p2",
        }),
      ).rejects.toThrow(`${TOKEN} is not set`);
    }
    expect(seen).toHaveLength(0);
  });
});

describe("gdrive_file_list", () => {
  it("requests non-trashed files with the default page size", async () => {
    always({ body: '{"files":[]}' });
    await tools.call("gdrive_file_list", {});
    expect(seen[0]?.url).toContain("pageSize=25");
    expect(seen[0]?.url).toContain("trashed+%3D+false");
    expect(seen[0]?.authorization).toBe("Bearer ya29.token");
  });

  it("passes a page token through only when it is non-empty", async () => {
    always({ body: "{}" });
    await tools.call("gdrive_file_list", { pageToken: "next-page" });
    expect(seen[0]?.url).toContain("pageToken=next-page");

    seen = [];
    await tools.call("gdrive_file_list", { pageToken: "" });
    expect(seen[0]?.url).not.toContain("pageToken");
  });

  it("surfaces the Drive status and body on failure", async () => {
    always({ status: 403, body: "insufficient permissions" });
    await expect(tools.call("gdrive_file_list", {})).rejects.toThrow(
      "Drive API 403: insufficient permissions",
    );
  });
});

describe("gdrive_file_metadata", () => {
  it("percent-encodes the file id into the path", async () => {
    always({ body: '{"id":"a/b"}' });
    await tools.call("gdrive_file_metadata", { fileId: "a/b" });
    expect(seen[0]?.url).toContain("/files/a%2Fb?");
  });

  it("surfaces the Drive status on failure", async () => {
    always({ status: 404, body: "File not found" });
    await expect(tools.call("gdrive_file_metadata", { fileId: "x" })).rejects.toThrow(
      "Drive API 404: File not found",
    );
  });
});

describe("gdrive_file_search", () => {
  it("escapes the query literal so it cannot break out of the Drive expression", async () => {
    // The query is interpolated into a Drive `q` expression, so an unescaped
    // quote would change which files the expression selects.
    always({ body: "{}" });
    await tools.call("gdrive_file_search", { query: "it's a 'test'" });
    // Parsed with URLSearchParams, not decodeURIComponent: the query is form-
    // encoded, so spaces arrive as `+` and a manual decode reads them literally.
    const q = new URL(seen[0]?.url ?? "").searchParams.get("q") ?? "";
    expect(q).toContain("fullText contains");
    expect(q).toContain("and trashed = false");
    // Every apostrophe the caller supplied is backslash-escaped, so none of
    // them can close the literal and append a clause of the caller's choosing.
    const literal = q.slice(q.indexOf("'") + 1, q.lastIndexOf("'"));
    expect(literal).toBe(String.raw`it\'s a \'test\'`);
    for (const [i, ch] of [...literal].entries()) {
      if (ch === "'") {
        expect(literal[i - 1]).toBe("\\");
      }
    }
  });
});

describe("gdrive_file_download", () => {
  const meta = (over: Record<string, unknown> = {}): Reply => ({
    body: JSON.stringify({ id: "f1", name: "note.txt", mimeType: "text/plain", ...over }),
  });

  it("returns utf-8 for a text file", async () => {
    respond((_url, i) => (i === 0 ? meta() : { body: "hello world" }));
    const out = (await tools.callJson("gdrive_file_download", { fileId: "f1" })) as {
      encoding: string;
      content: string;
    };
    expect(out.encoding).toBe("utf-8");
    expect(out.content).toBe("hello world");
  });

  it("returns base64 for a binary file", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250]);
    respond((_url, i) => (i === 0 ? meta({ mimeType: "application/octet-stream" }) : { bytes }));
    const out = (await tools.callJson("gdrive_file_download", { fileId: "f1" })) as {
      encoding: string;
      content: string;
    };
    expect(out.encoding).toBe("base64");
    expect(Buffer.from(out.content, "base64")).toEqual(Buffer.from(bytes));
  });

  it("exports a Google Doc as text rather than downloading its bytes", async () => {
    respond((_url, i) =>
      i === 0 ? meta({ mimeType: "application/vnd.google-apps.document" }) : { body: "doc text" },
    );
    const out = (await tools.callJson("gdrive_file_download", { fileId: "f1" })) as {
      exportMimeType: string;
      content: string;
    };
    expect(out.exportMimeType).toBe("text/plain");
    expect(seen[1]?.url).toContain("/export?mimeType=text%2Fplain");
    expect(out.content).toBe("doc text");
  });

  it("exports a Sheet as CSV", async () => {
    respond((_url, i) =>
      i === 0 ? meta({ mimeType: "application/vnd.google-apps.spreadsheet" }) : { body: "a,b" },
    );
    const out = (await tools.callJson("gdrive_file_download", { fileId: "f1" })) as {
      exportMimeType: string;
    };
    expect(out.exportMimeType).toBe("text/csv");
  });

  it("refuses a Workspace type it cannot export, pointing at the web link", async () => {
    respond(() =>
      meta({
        mimeType: "application/vnd.google-apps.form",
        webViewLink: "https://docs.google.com/forms/d/f1",
      }),
    );
    const err = await tools.call("gdrive_file_download", { fileId: "f1" }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    const detail = JSON.parse(err?.message ?? "{}") as { code: string; webViewLink: string };
    expect(detail.code).toBe("EXPORT_NOT_SUPPORTED");
    expect(detail.webViewLink).toBe("https://docs.google.com/forms/d/f1");
  });

  it("truncates an over-large export rather than failing", async () => {
    respond((_url, i) =>
      i === 0
        ? meta({ mimeType: "application/vnd.google-apps.document" })
        : { body: "x".repeat(5000) },
    );
    const out = (await tools.callJson("gdrive_file_download", {
      fileId: "f1",
      maxBytes: 1024,
    })) as { truncated: boolean; content: string };
    expect(out.truncated).toBe(true);
    expect(out.content).toHaveLength(1024);
  });

  it("refuses a media file whose declared size exceeds maxBytes, before downloading it", async () => {
    respond(() => meta({ mimeType: "application/pdf", size: "99999999" }));
    const err = await tools.call("gdrive_file_download", { fileId: "f1", maxBytes: 1024 }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect((JSON.parse(err?.message ?? "{}") as { code: string }).code).toBe("FILE_TOO_LARGE");
    // Only the metadata request was made — the bytes were never fetched.
    expect(seen).toHaveLength(1);
  });

  it("refuses when Content-Length exceeds maxBytes", async () => {
    respond((_url, i) =>
      i === 0
        ? meta({ mimeType: "application/pdf" })
        : { bytes: new Uint8Array(10), headers: { "content-length": "99999999" } },
    );
    const err = await tools.call("gdrive_file_download", { fileId: "f1", maxBytes: 1024 }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect((JSON.parse(err?.message ?? "{}") as { code: string }).code).toBe("FILE_TOO_LARGE");
  });

  it("refuses when the delivered bytes exceed maxBytes despite the headers", async () => {
    // The last line of defence: a server that under-reports its size must not
    // be able to push an arbitrarily large payload through the tool.
    respond((_url, i) =>
      i === 0 ? meta({ mimeType: "application/pdf" }) : { bytes: new Uint8Array(4096) },
    );
    const err = await tools.call("gdrive_file_download", { fileId: "f1", maxBytes: 1024 }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    const detail = JSON.parse(err?.message ?? "{}") as { code: string; sizeBytes: number };
    expect(detail.code).toBe("FILE_TOO_LARGE");
    expect(detail.sizeBytes).toBe(4096);
  });

  it("reports a metadata failure distinctly from a download failure", async () => {
    respond((_url, i) => (i === 0 ? { status: 404, body: "gone" } : {}));
    await expect(tools.call("gdrive_file_download", { fileId: "f1" })).rejects.toThrow(
      "metadata 404: gone",
    );

    seen = [];
    respond((_url, i) =>
      i === 0 ? meta({ mimeType: "application/pdf" }) : { status: 500, body: "boom" },
    );
    await expect(tools.call("gdrive_file_download", { fileId: "f1" })).rejects.toThrow(
      "download 500: boom",
    );
  });

  it("reports an export failure distinctly", async () => {
    respond((_url, i) =>
      i === 0
        ? meta({ mimeType: "application/vnd.google-apps.document" })
        : { status: 403, body: "denied" },
    );
    await expect(tools.call("gdrive_file_download", { fileId: "f1" })).rejects.toThrow(
      "export 403: denied",
    );
  });

  it("rejects a metadata response that is not an object", async () => {
    respond(() => ({ body: "[1,2,3]" }));
    await expect(tools.call("gdrive_file_download", { fileId: "f1" })).rejects.toThrow(
      "metadata: invalid response",
    );
  });

  it("falls back to the file id when the metadata carries no name", async () => {
    respond((_url, i) => (i === 0 ? { body: '{"mimeType":"text/plain"}' } : { body: "content" }));
    const out = (await tools.callJson("gdrive_file_download", { fileId: "f1" })) as {
      name: string;
    };
    expect(out.name).toBe("f1");
  });
});

describe("gdrive_file_create", () => {
  it("posts metadata only when no content is given", async () => {
    always({ body: '{"id":"new"}' });
    await tools.call("gdrive_file_create", { name: "empty.txt" });
    expect(seen[0]?.url).toBe("https://www.googleapis.com/drive/v3/files");
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.contentType).toBe("application/json");
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({
      name: "empty.txt",
      mimeType: "text/plain",
    });
  });

  it("uses a multipart upload when content is given", async () => {
    always({ body: '{"id":"new"}' });
    await tools.call("gdrive_file_create", { name: "note.txt", content: "hello" });
    expect(seen[0]?.url).toContain("uploadType=multipart");
    expect(seen[0]?.contentType).toContain("multipart/related; boundary=nimbus_");
    expect(seen[0]?.body).toContain("hello");
    expect(seen[0]?.body).toContain('"name":"note.txt"');
  });

  it("treats empty content as no content", async () => {
    always({ body: "{}" });
    await tools.call("gdrive_file_create", { name: "e.txt", content: "" });
    expect(seen[0]?.url).not.toContain("uploadType");
  });

  it("includes the parent folder when given", async () => {
    always({ body: "{}" });
    await tools.call("gdrive_file_create", { name: "x", parentId: "folder-1" });
    expect(JSON.parse(seen[0]?.body ?? "{}")).toMatchObject({ parents: ["folder-1"] });
  });

  it("surfaces a create failure", async () => {
    always({ status: 400, body: "bad request" });
    await expect(tools.call("gdrive_file_create", { name: "x" })).rejects.toThrow(
      "Drive API 400: bad request",
    );
  });
});

describe("gdrive_file_trash", () => {
  it("PATCHes trashed: true rather than deleting", async () => {
    always({ body: "{}" });
    await tools.call("gdrive_file_trash", { fileId: "f1" });
    expect(seen[0]?.method).toBe("PATCH");
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({ trashed: true });
    expect(seen[0]?.url).not.toContain("?");
  });
});

describe("gdrive_file_rename", () => {
  it("PATCHes the new name", async () => {
    always({ body: "{}" });
    await tools.call("gdrive_file_rename", { fileId: "f1", newName: "renamed.txt" });
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({ name: "renamed.txt" });
  });

  it("surfaces a patch failure", async () => {
    always({ status: 500, body: "server error" });
    await expect(tools.call("gdrive_file_rename", { fileId: "f1", newName: "x" })).rejects.toThrow(
      "Drive API 500: server error",
    );
  });
});

describe("gdrive_file_move", () => {
  it("uses the given removeParentId without looking parents up", async () => {
    always({ body: "{}" });
    await tools.call("gdrive_file_move", {
      fileId: "f1",
      newParentId: "p2",
      removeParentId: "p1",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toContain("addParents=p2");
    expect(seen[0]?.url).toContain("removeParents=p1");
  });

  it("infers the current parent when removeParentId is omitted", async () => {
    respond((_url, i) => (i === 0 ? { body: '{"parents":["p1","p9"]}' } : { body: "{}" }));
    await tools.call("gdrive_file_move", { fileId: "f1", newParentId: "p2" });
    expect(seen[0]?.url).toContain("fields=parents");
    expect(seen[1]?.url).toContain("removeParents=p1");
  });

  it("refuses when the file has no parent to move it out of", async () => {
    respond(() => ({ body: '{"parents":[]}' }));
    await expect(
      tools.call("gdrive_file_move", { fileId: "f1", newParentId: "p2" }),
    ).rejects.toThrow("Cannot infer removeParentId");
  });

  it("treats a malformed parents response as no parents", async () => {
    for (const body of ["[1,2]", "{}", '{"parents":"p1"}', '{"parents":[1,""]}']) {
      seen = [];
      respond(() => ({ body }));
      await expect(
        tools.call("gdrive_file_move", { fileId: "f1", newParentId: "p2" }),
      ).rejects.toThrow("Cannot infer removeParentId");
    }
  });

  it("surfaces a parents-lookup failure", async () => {
    respond(() => ({ status: 403, body: "denied" }));
    await expect(
      tools.call("gdrive_file_move", { fileId: "f1", newParentId: "p2" }),
    ).rejects.toThrow("Drive API 403: denied");
  });
});
