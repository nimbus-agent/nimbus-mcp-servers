import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { verifyManifestSignature } from "@nimbus-dev/sdk"; // NOSONAR S1874
import { SYNC_TOOL_NAME } from "@nimbus-dev/sdk/sync";
import { buildExtension } from "../scripts/build-extension.ts";
import { TEST_BASE_MARKERS } from "../scripts/build-test-fixture.ts";

const CONNECTOR_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_SCRIPT = join(CONNECTOR_DIR, "scripts", "build-test-fixture.ts");

interface Seen {
  readonly path: string;
  readonly authorization: string | null;
}

describe("production bundle", () => {
  let work: string;
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "readwise-prod-"));
  });
  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it("hard-codes https://readwise.io and carries no trace of the test mechanism", async () => {
    const out = join(work, "server.js");
    await buildExtension(out);
    const text = readFileSync(out, "utf8");
    expect(text).toContain("https://readwise.io");
    expect(TEST_BASE_MARKERS.length).toBeGreaterThan(0);
    for (const marker of TEST_BASE_MARKERS) {
      expect(text).not.toContain(marker);
    }
  }, 60_000);

  it("the checked-in sources mention no marker either", () => {
    for (const file of ["readwise-base.ts", "extension.ts", "sync.ts", "tools.ts"]) {
      const src = readFileSync(join(CONNECTOR_DIR, "src", file), "utf8");
      for (const marker of TEST_BASE_MARKERS) {
        expect(src).not.toContain(marker);
      }
    }
  });
});

describe("test-signed fixture package", () => {
  let work: string;
  let pkg: string;
  let fake: ReturnType<typeof Bun.serve>;
  const seen: Seen[] = [];

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "readwise-fixture-"));
    pkg = join(work, "pkg");
    fake = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        seen.push({ path: url.pathname, authorization: req.headers.get("authorization") });
        if (url.pathname === "/api/v2/highlights/") {
          return Response.json({
            count: 1,
            next: null,
            previous: null,
            results: [{ id: 7, text: "from the fake", updated: "2024-03-02T08:00:00.000Z" }],
          });
        }
        return Response.json({ count: 0, next: null, previous: null, results: [] });
      },
    });
    const base = `http://127.0.0.1:${String(fake.port)}`;
    const proc = Bun.spawn([process.execPath, FIXTURE_SCRIPT, "--base-url", base, "--out", pkg], {
      cwd: CONNECTOR_DIR,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) {
      throw new Error(`fixture build failed (${code}): ${err}`);
    }
  }, 60_000);

  afterAll(() => {
    fake?.stop(true);
    rmSync(work, { recursive: true, force: true });
  });

  function readManifest(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(pkg, "nimbus.extension.json"), "utf8")) as Record<
      string,
      unknown
    >;
  }

  function publicKey(): Uint8Array {
    return new Uint8Array(
      Buffer.from(readFileSync(join(pkg, "test-publisher.pub"), "utf8").trim(), "base64"),
    );
  }

  it("signs the manifest: the written key verifies it, a tampered byte does not", async () => {
    const manifest = readManifest();
    const publisher = manifest["publisher"] as { id: string; key: string };
    expect(publisher.id).toBe("nimbus-test");
    expect(publisher.key).toHaveLength(44);
    expect(publisher.key).toBe(Buffer.from(publicKey()).toString("base64"));
    expect(String(manifest["signature"])).toHaveLength(88);
    await verifyManifestSignature(manifest, publicKey()); // NOSONAR S1874

    const tampered = { ...manifest, version: "9.9.9" };
    let failed = false;
    try {
      await verifyManifestSignature(tampered, publicKey()); // NOSONAR S1874
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  it("changes only network, publisher and signature", () => {
    const original = JSON.parse(
      readFileSync(join(CONNECTOR_DIR, "nimbus.extension.json"), "utf8"),
    ) as Record<string, unknown>;
    const { publisher: _p, signature: _s, permissions: _perm, ...rest } = readManifest();
    const { permissions: _o, ...origRest } = original;
    expect(rest).toEqual(origRest);
    const perms = readManifest()["permissions"] as { network: string[] };
    expect(perms.network).toEqual([`127.0.0.1:${String(fake.port)}`]);
  });

  it("the fixture bundle does not mention readwise.io", () => {
    const text = readFileSync(join(pkg, "dist", "server.js"), "utf8");
    expect(text).not.toContain("https://readwise.io");
    expect(text).toContain(`http://127.0.0.1:${String(fake.port)}`);
  });

  it("serves __nimbus_sync and a read tool from the fake, with Token auth", async () => {
    const env: Record<string, string> = { READWISE_TOKEN: "x" };
    for (const key of ["SystemRoot", "PATH", "Path", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
      const v = process.env[key];
      if (v !== undefined) {
        env[key] = v;
      }
    }
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(pkg, "dist", "server.js")],
      cwd: pkg,
      env,
      stderr: "ignore",
    });
    const client = new Client({ name: "fixture-test", version: "0.0.0" });
    try {
      await client.connect(transport);
      const sync = await client.callTool({
        name: SYNC_TOOL_NAME,
        arguments: { cursor: null, depth: "full" },
      });
      const text = (sync.content as readonly { text?: string }[])[0]?.text ?? "";
      const parsed = JSON.parse(text) as { status: string; items?: { externalId: string }[] };
      expect(parsed.status).toBe("ok");
      expect(parsed.items?.some((i) => i.externalId.includes("7"))).toBe(true);

      const list = await client.callTool({ name: "readwise_list", arguments: {} });
      const listText = (list.content as readonly { text?: string }[])[0]?.text ?? "";
      expect(listText).toContain("from the fake");
    } finally {
      await client.close().catch(() => undefined);
    }
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const s of seen) {
      expect(s.authorization).toBe("Token x");
    }
  }, 60_000);
});

describe("fixture script argument validation", () => {
  async function run(baseUrl: string): Promise<number> {
    const proc = Bun.spawn(
      [
        process.execPath,
        FIXTURE_SCRIPT,
        "--base-url",
        baseUrl,
        "--out",
        join(tmpdir(), "rw-never"),
      ],
      { cwd: CONNECTOR_DIR, stdout: "ignore", stderr: "ignore" },
    );
    return await proc.exited;
  }

  it("refuses a non-http scheme, a path, a query and credentials", async () => {
    for (const bad of [
      "ftp://127.0.0.1:1",
      "http://127.0.0.1:1/api",
      "http://127.0.0.1:1/?a=b",
      "http://u:p@127.0.0.1:1",
      "not a url",
    ]) {
      expect(await run(bad)).not.toBe(0);
    }
  }, 60_000);
});

describe("fixture --out guard", () => {
  const MANIFEST = join(CONNECTOR_DIR, "nimbus.extension.json");

  async function runOut(out: string): Promise<{ code: number; err: string }> {
    const proc = Bun.spawn(
      [process.execPath, FIXTURE_SCRIPT, "--base-url", "http://127.0.0.1:4010", "--out", out],
      { cwd: CONNECTOR_DIR, stdout: "ignore", stderr: "pipe" },
    );
    const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    return { code, err };
  }

  it("refuses the connector directory itself and leaves the manifest untouched", async () => {
    const before = readFileSync(MANIFEST);
    const { code, err } = await runOut(CONNECTOR_DIR);
    expect(code).not.toBe(0);
    expect(err).toContain("overwrite the checked-in nimbus.extension.json");
    expect(readFileSync(MANIFEST).equals(before)).toBe(true);
    expect(existsSync(join(CONNECTOR_DIR, "test-publisher.pub"))).toBe(false);
  }, 60_000);

  it("refuses a path inside the connector, however spelled", async () => {
    const before = readFileSync(MANIFEST);
    const inside = [
      join(CONNECTOR_DIR, "dist"),
      join(CONNECTOR_DIR, "src", "..", "dist"),
      // Case-insensitive drive letter / path on Windows only.
      ...(process.platform === "win32" ? [join(CONNECTOR_DIR, "DIST").toUpperCase()] : []),
    ];
    for (const out of inside) {
      const { code, err } = await runOut(out);
      expect(code).not.toBe(0);
      expect(err).toContain("--out must not be");
      expect(readFileSync(MANIFEST).equals(before)).toBe(true);
    }
  }, 60_000);

  it("refuses a child literally named ..foo: it is inside the connector, not above it", async () => {
    const before = readFileSync(MANIFEST);
    const child = join(CONNECTOR_DIR, "..foo");
    const { code, err } = await runOut(child);
    expect(code).not.toBe(0);
    expect(err).toContain("--out must not be");
    expect(existsSync(child)).toBe(false);
    expect(readFileSync(MANIFEST).equals(before)).toBe(true);
  }, 60_000);

  it("refuses a directory that contains the connector", async () => {
    const before = readFileSync(MANIFEST);
    const { code, err } = await runOut(join(CONNECTOR_DIR, "..", ".."));
    expect(code).not.toBe(0);
    expect(err).toContain("--out must not be");
    expect(readFileSync(MANIFEST).equals(before)).toBe(true);
  }, 60_000);

  it("still builds into a separate temp directory", async () => {
    const work = mkdtempSync(join(tmpdir(), "readwise-guard-ok-"));
    try {
      const { code } = await runOut(join(work, "pkg"));
      expect(code).toBe(0);
      expect(existsSync(join(work, "pkg", "nimbus.extension.json"))).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);
});
