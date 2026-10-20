/**
 * Builds a TEST-SIGNED Readwise extension package whose network calls go to another host, for
 * gateway end-to-end tests only:
 *
 *   bun connectors/readwise/scripts/build-test-fixture.ts --base-url http://127.0.0.1:4010 --out <dir>
 *
 * The production bundle cannot do this: `src/readwise-base.ts` hard-codes `https://readwise.io`
 * and nothing reads an env var, argument or config. The only lever is here — a Bun build plugin
 * that replaces that one module while bundling. Neither the plugin nor its markers exist in
 * `src/`, so the production `dist/server.js` carries no trace of them.
 *
 * The package is signed with an EPHEMERAL Ed25519 key generated per run. The private key is never
 * written anywhere; the public key goes to `<out>/test-publisher.pub` for a consumer to pin.
 */
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
// NOSONAR S1874: deprecated with no shipped replacement; `signManifest` IS the contract the
// gateway verifies (flat `publisher.key` + `signature`), as in the Nimbus CLI's signing seam.
import { signManifest } from "@nimbus-dev/sdk"; // NOSONAR S1874
import { buildExtension } from "./build-extension.ts";

/** Distinctive strings that exist only in the test build; the production bundle must lack all. */
export const TEST_BASE_MARKERS = [
  "NIMBUS_TEST_BASE_SUBSTITUTE",
  "nimbus-test-base-substitute",
] as const;

export const TEST_PUBLISHER_ID = "nimbus-test";

const CONNECTOR_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const READWISE_BASE_MODULE = join(CONNECTOR_DIR, "src", "readwise-base.ts");

/** http(s) origin only: no path, query, fragment or credentials. Returns the normalised origin. */
export function parseBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--base-url is not a URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("--base-url must be http or https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("--base-url must not carry credentials");
  }
  if (url.search !== "" || url.hash !== "" || url.pathname !== "/" || /[?#]/.test(raw)) {
    throw new Error("--base-url must be an origin only (no path, query or fragment)");
  }
  return url;
}

/**
 * The gateway's `permissions.network` form: a bare host means port 443, `host:port` is explicit.
 * Loopback with a port (`127.0.0.1:4010`) is a valid RFC 1123 host plus port, so it is accepted.
 */
export function networkEntry(url: URL): string {
  let port = url.port;
  if (port === "") {
    port = url.protocol === "https:" ? "443" : "80";
  }
  return port === "443" ? url.hostname : `${url.hostname}:${port}`;
}

function baseSubstitutePlugin(origin: string): Bun.BunPlugin {
  return {
    name: TEST_BASE_MARKERS[1],
    setup(build) {
      // Anchored on a separator (either kind), then checked against the one resolved module path.
      build.onLoad({ filter: /[\\/]readwise-base\.ts$/ }, (args) => {
        if (resolve(args.path) !== resolve(READWISE_BASE_MODULE)) {
          return undefined;
        }
        return {
          contents: `export const ${TEST_BASE_MARKERS[0]} = true;\nexport const READWISE_BASE = ${JSON.stringify(origin)};\n`,
          loader: "ts" as const,
        };
      });
    },
  };
}

function generateKeypair(): { seed: Uint8Array; pubkey: Uint8Array } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const d = (privateKey.export({ format: "jwk" }) as { d: string }).d;
  const x = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  return {
    seed: new Uint8Array(Buffer.from(d, "base64url")),
    pubkey: new Uint8Array(Buffer.from(x, "base64url")),
  };
}

/** Resolve through symlinks as far as the path exists, then append the not-yet-created tail. */
function canonicalPath(p: string): string {
  let existing = resolve(p);
  const tail: string[] = [];
  while (!existsSync(existing) && dirname(existing) !== existing) {
    tail.unshift(basename(existing));
    existing = dirname(existing);
  }
  const real = existsSync(existing) ? realpathSync.native(existing) : existing;
  return resolve(real, ...tail);
}

/** `a` is `b` or lies inside `b`; case-insensitive on Windows, which has case-insensitive paths. */
function isSameOrInside(a: string, b: string): boolean {
  const fold = (x: string): string => (process.platform === "win32" ? x.toLowerCase() : x);
  const rel = relative(fold(b), fold(a));
  const escapes = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  return rel === "" || !escapes;
}

/**
 * The fixture overwrites `nimbus.extension.json` and `dist/server.js` under `outDir`. Aimed at the
 * connector directory, an ancestor of it, or anything inside it, that would replace the
 * checked-in manifest with a test-signed loopback one and leave a test-base bundle in `dist/`
 * where a publish step could ship it.
 */
export function assertSafeOutDir(outDir: string): void {
  const out = canonicalPath(outDir);
  const connector = canonicalPath(CONNECTOR_DIR);
  if (isSameOrInside(out, connector) || isSameOrInside(connector, out)) {
    throw new Error(
      `--out must not be the Readwise connector directory, a directory containing it, or a path inside it (${outDir}): ` +
        "the fixture would overwrite the checked-in nimbus.extension.json with a test-signed loopback manifest " +
        "and leave a test-base dist/server.js where a publish step could ship it. Use a separate temp directory.",
    );
  }
}

export async function buildTestFixture(baseUrl: string, outDir: string): Promise<void> {
  const url = parseBaseUrl(baseUrl);
  assertSafeOutDir(outDir);
  const origin = url.origin;
  mkdirSync(join(outDir, "dist"), { recursive: true });
  await buildExtension(join(outDir, "dist", "server.js"), [baseSubstitutePlugin(origin)]);

  const manifest = JSON.parse(
    readFileSync(join(CONNECTOR_DIR, "nimbus.extension.json"), "utf8"),
  ) as Record<string, unknown>;
  const { seed, pubkey } = generateKeypair();
  const keyB64 = Buffer.from(pubkey).toString("base64");
  const unsigned: Record<string, unknown> = {
    ...manifest,
    permissions: { network: [networkEntry(url)] },
    publisher: { id: TEST_PUBLISHER_ID, key: keyB64 },
  };
  const signature = await signManifest(unsigned, seed); // NOSONAR S1874
  writeFileSync(
    join(outDir, "nimbus.extension.json"),
    `${JSON.stringify({ ...unsigned, signature }, null, 2)}\n`,
  );
  writeFileSync(join(outDir, "test-publisher.pub"), `${keyB64}\n`);
}

function argValue(args: readonly string[], flag: string): string {
  const i = args.indexOf(flag);
  const v = i === -1 ? undefined : args[i + 1];
  if (v === undefined || v.startsWith("--")) {
    throw new Error(
      `usage: build-test-fixture.ts --base-url <http(s)://host[:port]> --out <dir> (missing ${flag})`,
    );
  }
  return v;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    await buildTestFixture(argValue(args, "--base-url"), argValue(args, "--out"));
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
