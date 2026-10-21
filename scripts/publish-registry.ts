/**
 * Sign the Readwise extension and add it to the official Nimbus extension registry.
 *
 * Run by `.github/workflows/registry-publish.yml` on every connectors release; runnable by hand:
 *
 *   bun scripts/publish-registry.ts --check
 *   bun scripts/publish-registry.ts --publisher-id <id>
 *
 * It takes NO path from argv. Every file it touches sits at a fixed place under a base it
 * determines itself — the working directory (the repository root) or the temp directory
 * (`$RUNNER_TEMP`, else the OS temp dir) — see {@link fixedLayout}:
 *
 *   <workspace>/registry/                              a checkout of the registry (`gh-pages`)
 *   <workspace>/connectors/readwise/dist/server.js     the bundle, built beforehand
 *   <temp>/nimbus-cli/nimbus[.exe]                     the Nimbus CLI (pinned, hash-checked by CI)
 *   <temp>/nimbus-keys/publisher.key                   the publisher's Ed25519 seed, base64
 *   <temp>/nimbus-keys/root.key                        the registry root's Ed25519 seed, base64
 *
 * `--check` needs no key: it reads the registry's `index.json` and the Readwise manifest, and says
 * whether there is anything to publish (`publish=true|false` in `GITHUB_OUTPUT`). CI runs it in a
 * job without the signing environment, so a release with nothing to publish never asks for an
 * approval. The publish never builds: the bundle is built in its own step, before the keys exist,
 * so the process that reads the keys runs no build.
 *
 * Each path must exist as the expected kind and must not be a symlink. The key files must be
 * readable by their owner only on POSIX, and never inside the registry — a key in the workspace is
 * one `git add -A` away from being published.
 *
 * It publishes only when the version in `connectors/readwise/nimbus.extension.json` is not yet in
 * the registry's `index.json`; any other release is a no-op. It never bootstraps a registry —
 * `nimbus registry maintain init` mints a fresh root key, which is the owner's job, once.
 *
 * Keys travel only as FILE PATHS. Nothing read from a key file, or derived from one — not even the
 * public key — reaches argv, a log line or an error message. When `GITHUB_OUTPUT` is set, the
 * outcome is written there for the commit step.
 *
 * This file is repo tooling, not shipped code, so it is outside the spawn chokepoint's scope and
 * starts the CLI with `Bun.spawn` and an argv array — never a shell.
 */

import { createPrivateKey, createPublicKey } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

export type PathKind = "file" | "directory";

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** Whether `child` (absolute, real) is strictly inside `parent` (absolute, real). */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && child.startsWith(prefix);
}

/**
 * `input` (relative to `cwd`) as a real absolute path: it must exist as `kind`, must not itself be
 * a symlink, and — when `base` is given — must resolve strictly inside `base`.
 */
export function checkedPath(
  input: string,
  opts: { cwd: string; kind: PathKind; what: string; base?: string },
): string {
  if (input === "") throw new Error(`${opts.what} is empty`);
  const candidate = resolve(opts.cwd, input);
  const stats = lstatOrNull(candidate);
  if (stats === null) throw new Error(`${opts.what} ${candidate} does not exist`);
  if (stats.isSymbolicLink()) throw new Error(`${opts.what} ${candidate} is a symlink`);
  const rightKind = opts.kind === "file" ? stats.isFile() : stats.isDirectory();
  if (!rightKind) throw new Error(`${opts.what} ${candidate} is not a ${opts.kind}`);
  const real = realpathSync(candidate);
  if (opts.base !== undefined) {
    const base = realpathSync(resolve(opts.cwd, opts.base));
    if (!isInside(base, real)) {
      throw new Error(`${opts.what} ${candidate} is outside ${base}, where it must be`);
    }
  }
  return real;
}

// ---------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------

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
  return Buffer.from(spki.subarray(-32)).toString("base64");
}

/**
 * A key file's seed. The file must be a regular file, not a symlink, and on POSIX unreadable by
 * group and others. No error quotes the contents.
 */
function readSeedFile(file: string, what: string): string {
  const stats = lstatOrNull(file);
  if (stats === null) throw new Error(`${what} file ${file} does not exist`);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${what} file ${file} is not a regular file`);
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new Error(`${what} file ${file} is readable by group or others; chmod 600 it`);
  }
  let text: string;
  try {
    text = readFileSync(file, "utf8");
    decodeSeed(text);
  } catch {
    throw new Error(`${what} file ${file} is not one line of base64 holding a 32-byte seed`);
  }
  return text.trim();
}

// ---------------------------------------------------------------------------------------------
// Registry index
// ---------------------------------------------------------------------------------------------

function parsePublisher(value: unknown): Partial<Publisher> | undefined {
  if (!isRecord(value)) return undefined;
  const p: Partial<Publisher> = {};
  if (typeof value["id"] === "string") p.id = value["id"];
  if (typeof value["key"] === "string") p.key = value["key"];
  return p;
}

function parseEntry(entry: Record<string, unknown>): RegistryEntry {
  const out: RegistryEntry = {};
  const publisher = parsePublisher(entry["publisher"]);
  if (publisher !== undefined) out.publisher = publisher;
  if (isRecord(entry["versions"])) out.versions = entry["versions"];
  return out;
}

/** Read `<registryDir>/index.json`. A missing one is the owner's to bootstrap, never CI's. */
export function loadIndex(registryDir: string): RegistryIndex {
  const file = join(registryDir, "index.json");
  const stats = lstatOrNull(file);
  if (stats === null) {
    throw new Error(
      `${file} does not exist. The registry has not been bootstrapped: the owner runs ` +
        "`nimbus registry maintain init <dir> --key <root-key>` once and pushes the result as the " +
        "gh-pages branch (docs/publishing.md). CI never bootstraps — init mints a fresh root key.",
    );
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${file} is not a regular file`);
  }
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed["extensions"])) {
    throw new Error(`${file} has no "extensions" map; it is not a Nimbus registry index`);
  }
  const extensions: Record<string, RegistryEntry> = {};
  for (const [id, entry] of Object.entries(parsed["extensions"])) {
    if (isRecord(entry)) extensions[id] = parseEntry(entry);
  }
  const index: RegistryIndex = { extensions };
  if (typeof parsed["rootKey"] === "string") index.rootKey = parsed["rootKey"];
  if (typeof parsed["sequence"] === "number") index.sequence = parsed["sequence"];
  return index;
}

/**
 * Whether `id@version` should be published under `publisher`. A refusal names what the REGISTRY
 * records, never the key supplied: nothing derived from a key file is printed.
 */
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
        `the publisher key supplied does not match the one the registry records for ${id} ` +
        `(${known.key}). A publisher key can never change for an id — installs pin it. Supply ` +
        "the original publisher seed.",
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

// ---------------------------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------------------------

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
    throw new TypeError("the extension manifest has no `entrypoint`");
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
  if (!isRecord(parsed)) throw new TypeError("nimbus.extension.json is not a JSON object");
  return parsed;
}

function manifestIdVersion(connectorDir: string): { id: string; version: string } {
  const manifest = readManifest(connectorDir);
  const id = manifest["id"];
  const version = manifest["version"];
  if (typeof id !== "string" || typeof version !== "string") {
    throw new TypeError("nimbus.extension.json needs a string `id` and `version`");
  }
  return { id, version };
}

/** The repository's AGPL-3.0 licence text. */
export const ROOT_LICENSE = join(ROOT, "LICENSE");

/**
 * Lay out the package in `stageDir`: the staged manifest, `dist/`, the connector's README, and a
 * LICENSE. The AGPL requires the licence text to travel with the code, so a connector without a
 * LICENSE of its own ships the repository's (`licenseFile`, default {@link ROOT_LICENSE}).
 */
export async function stagePackage(args: {
  connectorDir: string;
  stageDir: string;
  publisher: Publisher;
  build: (outFile: string) => Promise<void>;
  licenseFile?: string;
}): Promise<Record<string, unknown>> {
  const { connectorDir, stageDir, publisher, build } = args;
  mkdirSync(join(stageDir, "dist"), { recursive: true });
  await build(join(stageDir, "dist", "server.js"));
  let hasLicense = false;
  for (const name of readdirSync(connectorDir)) {
    if (/^(?:README|LICENSE)(?:\.|$)/i.test(name)) {
      copyFileSync(join(connectorDir, name), join(stageDir, name));
      if (/^LICENSE/i.test(name)) hasLicense = true;
    }
  }
  if (!hasLicense) {
    const licenseFile = args.licenseFile ?? ROOT_LICENSE;
    if (!existsSync(licenseFile)) {
      throw new Error(`licence file ${licenseFile} does not exist; the package must carry one`);
    }
    copyFileSync(licenseFile, join(stageDir, "LICENSE"));
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

// ---------------------------------------------------------------------------------------------
// Check and publish
// ---------------------------------------------------------------------------------------------

export interface CheckResult {
  publish: boolean;
  id: string;
  version: string;
  reason: string;
}

/**
 * Whether the connector's manifest version is missing from the registry — the keyless decision CI
 * makes before asking for the signing environment. A missing `index.json` throws, as in a publish.
 * The publish itself re-decides under the registry lock, with the key checks this cannot make.
 */
export function checkPublish(
  registryDir: string,
  connectorDir: string = READWISE_DIR,
): CheckResult {
  const { id, version } = manifestIdVersion(connectorDir);
  const index = loadIndex(registryDir);
  const published = Object.hasOwn(index.extensions[id]?.versions ?? {}, version);
  return {
    publish: !published,
    id,
    version,
    reason: published
      ? `${id}@${version} is already published; nothing to do.`
      : `${id}@${version} is not in the registry; it will be published.`,
  };
}

async function runStep(run: PublishDeps["run"], argv: string[]): Promise<void> {
  const code = await run(argv);
  if (code !== 0) {
    throw new Error(`\`nimbus ${argv.slice(1, 4).join(" ")}\` exited ${code}`);
  }
}

export async function publishRegistry(
  options: PublishOptions,
  deps: PublishDeps,
): Promise<PublishResult> {
  const connectorDir = options.connectorDir ?? READWISE_DIR;
  const { id, version } = manifestIdVersion(connectorDir);
  if (options.publisherId.trim() === "") throw new Error("the publisher id is empty");

  const publisher: Publisher = {
    id: options.publisherId,
    key: derivePublicKey(readSeedFile(options.publisherKeyFile, "publisher key")),
  };
  const rootKey = derivePublicKey(readSeedFile(options.rootKeyFile, "root key"));

  const index = loadIndex(options.registryDir);
  if (index.rootKey !== undefined && index.rootKey !== rootKey) {
    throw new Error(
      `the root key supplied does not match the registry's rootKey (${index.rootKey})`,
    );
  }
  const plan = planPublish(index, id, version, publisher);
  if (plan.action === "refuse") {
    throw new Error(`refusing to publish ${id}@${version}: ${plan.reason}`);
  }
  if (plan.action === "skip") {
    deps.log(plan.reason);
    return { status: "skipped", id, version };
  }

  const stageDir = mkdtempSync(join(tmpdir(), "nimbus-extension-stage-"));
  try {
    await stagePackage({ connectorDir, stageDir, publisher, build: deps.build });
    // Sequential, and in this order: `add` packs the signature `sign` writes.
    await runStep(deps.run, [
      options.cli,
      "extension",
      "sign",
      stageDir,
      "--key",
      options.publisherKeyFile,
    ]);
    await runStep(deps.run, [
      options.cli,
      "registry",
      "maintain",
      "add",
      options.registryDir,
      stageDir,
      "--key",
      options.rootKeyFile,
    ]);
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }

  const after = loadIndex(options.registryDir);
  if (!Object.hasOwn(after.extensions[id]?.versions ?? {}, version)) {
    throw new Error(`the CLI reported success but ${id}@${version} is not in index.json`);
  }
  return { status: "published", id, version, sequence: after.sequence ?? 0 };
}

// ---------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------

export interface CliIo {
  /** The repository root; the script uses `process.cwd()`. */
  workspace: string;
  /** Where the CLI and the keys live; the script uses `$RUNNER_TEMP`, else the OS temp dir. */
  tempDir: string;
  /** Where to append step outputs (`$GITHUB_OUTPUT`), if anywhere. */
  githubOutput?: string | undefined;
  log(message: string): void;
  run(argv: string[]): Promise<number>;
}

/** The fixed places, relative to their base, of everything the script reads. */
export const LAYOUT = {
  registry: "registry",
  bundle: join("connectors", "readwise", "dist", "server.js"),
  cli: join("nimbus-cli", process.platform === "win32" ? "nimbus.exe" : "nimbus"),
  keyDir: "nimbus-keys",
  publisherKey: "publisher.key",
  rootKey: "root.key",
} as const;

export interface Layout {
  registryDir: string;
  bundle: string;
  cli: string;
  publisherKeyFile: string;
  rootKeyFile: string;
}

/** Every path the script uses: constant names joined onto the two bases. Nothing from argv. */
export function fixedLayout(workspace: string, tempDir: string): Layout {
  return {
    registryDir: join(workspace, LAYOUT.registry),
    bundle: join(workspace, LAYOUT.bundle),
    cli: join(tempDir, LAYOUT.cli),
    publisherKeyFile: join(tempDir, LAYOUT.keyDir, LAYOUT.publisherKey),
    rootKeyFile: join(tempDir, LAYOUT.keyDir, LAYOUT.rootKey),
  };
}

function writeOutputs(file: string | undefined, lines: string[]): void {
  if (file === undefined || file === "") return;
  appendFileSync(file, `${lines.join("\n")}\n`, "utf8");
}

/**
 * Run the script with `argv` (no program name). Argv carries only the mode and the publisher id;
 * every path comes from {@link fixedLayout} and is checked before anything reads it.
 */
export async function runCli(argv: string[], io: CliIo): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      check: { type: "boolean" },
      "publisher-id": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  // The label comes from the repository manifest alone, so a log line built from it cannot carry
  // anything read from a key file.
  const { id, version } = manifestIdVersion(READWISE_DIR);
  const label = `${id}@${version}`;
  const paths = fixedLayout(io.workspace, io.tempDir);
  const registryDir = checkedPath(paths.registryDir, {
    cwd: io.workspace,
    kind: "directory",
    what: "the registry checkout",
    base: io.workspace,
  });

  if (values.check === true) {
    const { publish } = checkPublish(registryDir);
    io.log(publish ? `${label}: not in the registry; publishing.` : `${label}: already published.`);
    writeOutputs(io.githubOutput, [`publish=${publish}`, `id=${id}`, `version=${version}`]);
    return;
  }

  const publisherId = values["publisher-id"];
  if (publisherId === undefined || publisherId.trim() === "") {
    throw new Error("missing required flag --publisher-id");
  }
  const bundle = checkedPath(paths.bundle, {
    cwd: io.workspace,
    kind: "file",
    what: "the prebuilt bundle (run `bun connectors/readwise/scripts/build-extension.ts` first)",
    base: io.workspace,
  });
  const inTemp = (file: string, what: string): string => {
    const real = checkedPath(file, { cwd: io.tempDir, kind: "file", what, base: io.tempDir });
    if (isInside(registryDir, real)) throw new Error(`${what} is inside the registry`);
    return real;
  };
  const cli = inTemp(paths.cli, "the Nimbus CLI");
  const publisherKeyFile = inTemp(paths.publisherKeyFile, "the publisher key file");
  const rootKeyFile = inTemp(paths.rootKeyFile, "the root key file");

  const result = await publishRegistry(
    { cli, registryDir, publisherKeyFile, rootKeyFile, publisherId },
    // The bundle was built before the keys existed; this process only copies it.
    { build: (outFile) => copyFile(bundle, outFile), run: io.run, log: io.log },
  );
  const published = result.status === "published";
  if (published) io.log(`${label}: published.`);
  writeOutputs(io.githubOutput, [
    `published=${published}`,
    `id=${id}`,
    `version=${version}`,
    `sequence=${published ? result.sequence : ""}`,
  ]);
}

if (import.meta.main) {
  try {
    await runCli(process.argv.slice(2), {
      workspace: process.cwd(),
      tempDir: process.env["RUNNER_TEMP"] || tmpdir(),
      githubOutput: process.env["GITHUB_OUTPUT"],
      log: (message) => console.log(message),
      run: (argv) =>
        Bun.spawn(argv, { stdin: "ignore", stdout: "inherit", stderr: "inherit" }).exited,
    });
  } catch (e) {
    console.error(`::error::${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
