/**
 * Sign the Readwise extension and add it to the official Nimbus extension registry.
 *
 * Run by `.github/workflows/registry-publish.yml` on every connectors release; runnable by hand:
 *
 *   bun scripts/publish-registry.ts \
 *     --cli <nimbus-cli>                 the Nimbus CLI binary (pinned and hash-checked by CI)
 *     --registry <dir>                   a checkout of the registry (the `gh-pages` branch)
 *     --publisher-key-file <file>        the publisher's Ed25519 seed, one line of base64
 *     --root-key-file <file>             the registry root's Ed25519 seed, one line of base64
 *     --publisher-id <id>                the publisher id recorded for the extension
 *
 * It publishes only when the version in `connectors/readwise/nimbus.extension.json` is not yet in
 * the registry's `index.json`; any other release is a no-op. It never bootstraps a registry —
 * `nimbus registry maintain init` mints a fresh root key, which is the owner's job, once.
 *
 * Keys travel only as FILE PATHS: no key reaches argv, a log line or an error message. When
 * `GITHUB_OUTPUT` is set, the outcome is written there for the commit step.
 *
 * This file is repo tooling, not shipped code, so it is outside the spawn chokepoint's scope and
 * starts the CLI with `Bun.spawn` and an argv array — never a shell.
 */

import { createPrivateKey, createPublicKey } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
export const READWISE_DIR = join(ROOT, "connectors", "readwise");

export interface Publisher {
  id: string;
  key: string;
}

export interface RegistryEntry {
  publisher?: Partial<Publisher>;
  versions?: Record<string, unknown>;
}

export interface RegistryIndex {
  rootKey?: string;
  sequence?: number;
  extensions: Record<string, RegistryEntry>;
}

export type Plan = { action: "publish" } | { action: "skip" | "refuse"; reason: string };

export type PublishResult =
  | { status: "skipped"; id: string; version: string }
  | { status: "published"; id: string; version: string; sequence: number };

export interface PublishOptions {
  cli: string;
  registryDir: string;
  publisherKeyFile: string;
  rootKeyFile: string;
  publisherId: string;
  connectorDir?: string;
}

export interface PublishDeps {
  /** Bundle the extension into one file at `outFile`. */
  build(outFile: string): Promise<void>;
  /** Run `argv` with no shell; resolve to its exit code. */
  run(argv: string[]): Promise<number>;
  log(message: string): void;
}

/** DER prefix of a PKCS#8 Ed25519 private key; the 32-byte seed follows it. */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SEED_BASE64 = /^[A-Za-z0-9+/]{43}=$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decode a key file's text — one line of base64 holding a 32-byte Ed25519 seed, as
 * `nimbus extension keygen --out` and `nimbus registry maintain init --key` write it. The error
 * never quotes the input: it is a secret.
 */
export function decodeSeed(text: string): Buffer {
  const trimmed = text.trim();
  if (!SEED_BASE64.test(trimmed)) {
    throw new Error("key file is not one line of base64 holding a 32-byte Ed25519 seed");
  }
  return Buffer.from(trimmed, "base64");
}

/** The base64 Ed25519 public key for a base64 seed. */
export function derivePublicKey(seedBase64: string): string {
  const seed = decodeSeed(seedBase64);
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return Buffer.from(spki.subarray(spki.length - 32)).toString("base64");
}

/** Read `<registryDir>/index.json`. A missing one is the owner's to bootstrap, never CI's. */
export function loadIndex(registryDir: string): RegistryIndex {
  const file = join(registryDir, "index.json");
  if (!existsSync(file)) {
    throw new Error(
      `${file} does not exist. The registry has not been bootstrapped: the owner runs ` +
        "`nimbus registry maintain init <dir> --key <root-key>` once and pushes the result as the " +
        "gh-pages branch (docs/publishing.md). CI never bootstraps — init mints a fresh root key.",
    );
  }
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed["extensions"])) {
    throw new Error(`${file} has no "extensions" map; it is not a Nimbus registry index`);
  }
  const extensions: Record<string, RegistryEntry> = {};
  for (const [id, entry] of Object.entries(parsed["extensions"])) {
    if (!isRecord(entry)) continue;
    const publisher = isRecord(entry["publisher"]) ? entry["publisher"] : undefined;
    const versions = isRecord(entry["versions"]) ? entry["versions"] : undefined;
    const out: RegistryEntry = {};
    if (publisher !== undefined) {
      const p: Partial<Publisher> = {};
      if (typeof publisher["id"] === "string") p.id = publisher["id"];
      if (typeof publisher["key"] === "string") p.key = publisher["key"];
      out.publisher = p;
    }
    if (versions !== undefined) out.versions = versions;
    extensions[id] = out;
  }
  const index: RegistryIndex = { extensions };
  if (typeof parsed["rootKey"] === "string") index.rootKey = parsed["rootKey"];
  if (typeof parsed["sequence"] === "number") index.sequence = parsed["sequence"];
  return index;
}

/** Whether `id@version` should be published under `publisher`. */
export function planPublish(
  index: RegistryIndex,
  id: string,
  version: string,
  publisher: Publisher,
): Plan {
  const entry = index.extensions[id];
  if (entry === undefined) return { action: "publish" };
  const known = entry.publisher;
  if (known?.key !== undefined && known.key !== publisher.key) {
    return {
      action: "refuse",
      reason:
        `the registry records publisher key ${known.key} for ${id}, but the publisher key ` +
        `supplied derives ${publisher.key}. A publisher key can never change for an id — ` +
        "installs pin it. Supply the original publisher seed.",
    };
  }
  if (known?.id !== undefined && known.id !== publisher.id) {
    return {
      action: "refuse",
      reason: `the registry records publisher id "${known.id}" for ${id}, not "${publisher.id}".`,
    };
  }
  if (entry.versions !== undefined && Object.hasOwn(entry.versions, version)) {
    return { action: "skip", reason: `${id}@${version} is already published; nothing to do.` };
  }
  return { action: "publish" };
}

/**
 * The manifest as it ships in the package: the repo manifest plus the publisher block and the
 * `entry` shim. Returns a new object; the input is not touched.
 *
 * COMPATIBILITY SHIM — `entry`: the pinned CLI (v9.2.1) reads only `entry` and otherwise falls
 * back to `dist/index.js`; `entrypoint` support (registry-format `parseEntry`) landed on Nimbus
 * main after it. The gateway reads `entry` first, so setting both to the same value changes
 * nothing for it. Remove once the pinned CLI is a release containing that support.
 */
export function stageManifest(
  manifest: Record<string, unknown>,
  publisher: Publisher,
): Record<string, unknown> {
  const entrypoint = manifest["entrypoint"];
  if (typeof entrypoint !== "string" || entrypoint === "") {
    throw new Error("the extension manifest has no `entrypoint`");
  }
  if (manifest["entry"] !== undefined && manifest["entry"] !== entrypoint) {
    throw new Error("the extension manifest's `entry` differs from its `entrypoint`");
  }
  return { ...manifest, entry: entrypoint, publisher: { id: publisher.id, key: publisher.key } };
}

function readManifest(connectorDir: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    readFileSync(join(connectorDir, "nimbus.extension.json"), "utf8"),
  );
  if (!isRecord(parsed)) throw new Error("nimbus.extension.json is not a JSON object");
  return parsed;
}

/** Lay out the package in `stageDir`: the staged manifest, `dist/`, and README/LICENSE. */
export async function stagePackage(args: {
  connectorDir: string;
  stageDir: string;
  publisher: Publisher;
  build: (outFile: string) => Promise<void>;
}): Promise<Record<string, unknown>> {
  const { connectorDir, stageDir, publisher, build } = args;
  mkdirSync(join(stageDir, "dist"), { recursive: true });
  await build(join(stageDir, "dist", "server.js"));
  for (const name of readdirSync(connectorDir)) {
    if (/^(?:README|LICENSE)(?:\.|$)/i.test(name)) {
      copyFileSync(join(connectorDir, name), join(stageDir, name));
    }
  }
  const staged = stageManifest(readManifest(connectorDir), publisher);
  // UTF-8 explicitly: the manifest carries non-ASCII text.
  writeFileSync(
    join(stageDir, "nimbus.extension.json"),
    `${JSON.stringify(staged, null, 2)}\n`,
    "utf8",
  );
  return staged;
}

function readSeedFile(file: string, what: string): string {
  if (!existsSync(file)) throw new Error(`${what} file ${file} does not exist`);
  try {
    const text = readFileSync(file, "utf8");
    decodeSeed(text);
    return text.trim();
  } catch {
    throw new Error(`${what} file ${file} is not one line of base64 holding a 32-byte seed`);
  }
}

export async function publishRegistry(
  options: PublishOptions,
  deps: PublishDeps,
): Promise<PublishResult> {
  const connectorDir = options.connectorDir ?? READWISE_DIR;
  const manifest = readManifest(connectorDir);
  const id = manifest["id"];
  const version = manifest["version"];
  if (typeof id !== "string" || typeof version !== "string") {
    throw new Error("nimbus.extension.json needs a string `id` and `version`");
  }
  if (options.publisherId.trim() === "") throw new Error("the publisher id is empty");

  const publisher: Publisher = {
    id: options.publisherId,
    key: derivePublicKey(readSeedFile(options.publisherKeyFile, "publisher key")),
  };
  const rootKey = derivePublicKey(readSeedFile(options.rootKeyFile, "root key"));

  const index = loadIndex(options.registryDir);
  if (index.rootKey !== undefined && index.rootKey !== rootKey) {
    throw new Error(
      `the root key supplied derives ${rootKey}, but the registry's rootKey is ${index.rootKey}`,
    );
  }
  const plan = planPublish(index, id, version, publisher);
  if (plan.action === "refuse")
    throw new Error(`refusing to publish ${id}@${version}: ${plan.reason}`);
  if (plan.action === "skip") {
    deps.log(plan.reason);
    return { status: "skipped", id, version };
  }

  const stageDir = mkdtempSync(join(tmpdir(), "nimbus-extension-stage-"));
  try {
    await stagePackage({ connectorDir, stageDir, publisher, build: deps.build });
    const steps: string[][] = [
      [options.cli, "extension", "sign", stageDir, "--key", options.publisherKeyFile],
      [
        options.cli,
        "registry",
        "maintain",
        "add",
        options.registryDir,
        stageDir,
        "--key",
        options.rootKeyFile,
      ],
    ];
    for (const argv of steps) {
      const code = await deps.run(argv);
      if (code !== 0) {
        throw new Error(`\`nimbus ${argv.slice(1, 4).join(" ")}\` exited ${code}`);
      }
    }
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }

  const after = loadIndex(options.registryDir);
  if (!Object.hasOwn(after.extensions[id]?.versions ?? {}, version)) {
    throw new Error(`the CLI reported success but ${id}@${version} is not in index.json`);
  }
  return { status: "published", id, version, sequence: after.sequence ?? 0 };
}

function writeOutputs(result: PublishResult): void {
  const file = process.env["GITHUB_OUTPUT"];
  if (file === undefined || file === "") return;
  const lines = [
    `published=${result.status === "published"}`,
    `id=${result.id}`,
    `version=${result.version}`,
    `sequence=${result.status === "published" ? result.sequence : ""}`,
  ];
  appendFileSync(file, `${lines.join("\n")}\n`, "utf8");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      cli: { type: "string" },
      registry: { type: "string" },
      "publisher-key-file": { type: "string" },
      "root-key-file": { type: "string" },
      "publisher-id": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const required = ["cli", "registry", "publisher-key-file", "root-key-file", "publisher-id"];
  const missing = required.filter((k) => !values[k as keyof typeof values]);
  if (missing.length > 0) {
    throw new Error(`missing required flag(s): ${missing.map((m) => `--${m}`).join(", ")}`);
  }
  const { buildExtension } = await import("../connectors/readwise/scripts/build-extension.ts");
  const result = await publishRegistry(
    {
      cli: values.cli ?? "",
      registryDir: values.registry ?? "",
      publisherKeyFile: values["publisher-key-file"] ?? "",
      rootKeyFile: values["root-key-file"] ?? "",
      publisherId: values["publisher-id"] ?? "",
    },
    {
      build: (outFile) => buildExtension(outFile),
      run: async (argv) =>
        Bun.spawn(argv, { stdin: "ignore", stdout: "inherit", stderr: "inherit" }).exited,
      log: (message) => console.log(message),
    },
  );
  if (result.status === "published") {
    console.log(`published ${result.id}@${result.version}; registry sequence ${result.sequence}`);
  }
  writeOutputs(result);
}

if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    console.error(`::error::${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
