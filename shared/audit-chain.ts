import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";
import {
  appendFile,
  type FileHandle,
  link,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * What happened to one gated action.
 *
 * `declined` is a human saying no, so it always means a person was asked. `refused` is a
 * server-side denial and does not say on its own whether anyone was asked; its `reason` does.
 * `out of scope` and `budget exhausted` are decided before any prompt. `budget exhausted after
 * approval` follows an `accepted` entry: writes in flight together spent the last of the budget
 * while this one's prompt was open, so a human approved a write that then did not run. A client
 * that cannot prompt is never offered a write tool at all, so it leaves no entry.
 */
export type AuditOutcome =
  | "requested"
  | "accepted"
  | "declined"
  | "refused"
  | "executed"
  | "failed";

export type AuditEntry = {
  readonly ts: string;
  readonly connector: string;
  readonly tool: string;
  readonly outcome: AuditOutcome;
  /** Free-form per-outcome detail: resolved params, refusal reason, captured pre-state. */
  readonly detail: Record<string, unknown>;
};

type ChainedLine = {
  readonly seq: number;
  readonly prev: string;
  readonly hash: string;
  readonly entry: AuditEntry;
};

/** First link's predecessor. A fixed, all-zero digest, mirroring the gateway's audit chain. */
export const GENESIS_HASH = "0".repeat(64);

/**
 * Key order for `canonicalJson`. Plain code-unit comparison, NOT `localeCompare`: the order has to
 * be the same on every machine and locale, or a chain written on one host fails to verify on
 * another.
 */
function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Canonical JSON with sorted keys.
 *
 * Two structurally identical entries must hash identically regardless of insertion order —
 * otherwise re-serialising during verification could break a chain that was never tampered with.
 *
 * For the same reason a key whose value is `undefined` is left out, as `JSON.stringify` leaves it
 * out of the line that is actually written. Hashing it as `null` instead hashed something the log
 * never contained, so verification — which can only re-hash what it reads back — reported the
 * entry as tampered on its very first read. `kubernetes`' pod delete recorded exactly such a
 * pre-state whenever the namespace was left to its default.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const rec = value as Record<string, unknown>;
  const body = Object.keys(rec)
    .filter((k) => rec[k] !== undefined)
    .sort(compareKeys)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`)
    .join(",");
  return `{${body}}`;
}

/**
 * Hash over the predecessor plus the entry's canonical JSON.
 *
 * SHA-256 via `node:crypto`, deliberately NOT the gateway's BLAKE3: `@noble/hashes` is not in
 * `ALLOWED_CONNECTOR_DEPS`, and the standalone artifact must run under Node. Same construction,
 * different primitive.
 */
function linkHash(prev: string, entry: AuditEntry): string {
  return createHash("sha256").update(prev).update(canonicalJson(entry)).digest("hex");
}

/** Constant-time digest comparison (I10). A length mismatch is a mismatch, checked first. */
function hashEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function errorCode(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null || !("code" in e)) return undefined;
  return typeof e.code === "string" ? e.code : undefined;
}

async function readLines(path: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    // Only a log that does not exist yet is empty. Any other failure to read it — a permission, a
    // directory at the path, a Windows sharing violation — says nothing about its contents, and
    // reading it as empty chained the next entry to the genesis hash in the middle of a log that
    // already had entries, and made verification pass on a log nobody could read.
    if (errorCode(e) === "ENOENT") return [];
    throw e;
  }
  const trimmed = text.trimEnd();
  return trimmed === "" ? [] : trimmed.split("\n");
}

/**
 * How long one writer may hold a log's lock, and how long another waits for it.
 *
 * An append holds the lock for one read of the log and one write: 85 ms for a 155 MB log, measured.
 */
export type AuditLockOptions = {
  /**
   * Once a lock file is older than this, its holder is taken to be gone and the lock is taken over,
   * which is what lets the log recover from a writer killed mid-append. Ten seconds is two orders
   * of magnitude above any append a live writer makes.
   */
  readonly staleMs: number;
  /**
   * How long an append waits for the lock before it fails. Longer than `staleMs`, so a waiter
   * always outlasts a left-behind lock it could not prove abandoned straight away.
   */
  readonly timeoutMs: number;
  /**
   * The file operations the lock is made of, `node:fs/promises` unless given. Only tests pass
   * this, to reproduce failures that only some filesystems produce: WSL's `/mnt` drives among them.
   */
  readonly fs?: LockFs;
};

/** One open lock file. */
export type LockHandle = Pick<FileHandle, "readFile" | "stat" | "writeFile" | "close">;

/** The file operations the lock is made of. The log itself is read and written directly. */
export type LockFs = {
  readonly open: (path: string, flags: "r" | "wx") => Promise<LockHandle>;
  readonly readFile: (path: string, encoding: "utf8") => Promise<string>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly link: (existing: string, created: string) => Promise<void>;
  readonly unlink: (path: string) => Promise<void>;
  readonly stat: (path: string) => Promise<{ isDirectory(): boolean }>;
};

const NODE_FS: LockFs = { open, readFile, rename, link, unlink, stat };

const DEFAULT_AUDIT_LOCK: AuditLockOptions = { staleMs: 10_000, timeoutMs: 30_000 };

/**
 * How many times `readSettled` reads before it gives up, with `backoffMs` between: under a tenth of
 * a second in all.
 */
const SETTLE_ATTEMPTS = 6;

/** The appends queued in THIS process, per log; each starts when the one before it has settled. */
const appendQueues = new Map<string, Promise<void>>();

function inQueue(key: string, task: () => Promise<void>): Promise<void> {
  const run = (appendQueues.get(key) ?? Promise.resolve()).then(task);
  // A failed append must not stall the ones behind it, so the next waits on the settled result.
  const settled = run.catch(() => undefined);
  appendQueues.set(key, settled);
  settled.then(() => {
    if (appendQueues.get(key) === settled) appendQueues.delete(key);
  });
  return run;
}

type LockOwner = {
  readonly pid: number;
  readonly host: string;
  readonly pidSpace: string | undefined;
};

function lockOwner(content: string): LockOwner | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { pid, host, pidSpace } = parsed as Record<string, unknown>;
  if (typeof pid !== "number" || typeof host !== "string") return undefined;
  return { pid, host, pidSpace: typeof pidSpace === "string" ? pidSpace : undefined };
}

/**
 * The processes a pid probe from this process can see, named so that two processes share the name
 * only when they see the same ones. On Linux that is the running kernel, by its boot id, and this
 * process's PID namespace: containers, Flatpak sandboxes and WSL each run in a namespace of their
 * own, often under the hostname of the machine they run on, and a pid from another namespace means
 * nothing here. On Windows and macOS it is the platform: WSL runs under its Windows host's
 * hostname, and the platform keeps its Linux pids apart from Windows ones.
 *
 * `undefined` where it cannot be read, and then no lock is judged by its pid at all.
 */
function readPidSpace(): string | undefined {
  if (process.platform === "win32" || process.platform === "darwin") return process.platform;
  if (process.platform !== "linux") return undefined;
  try {
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return `linux ${boot} ${readlinkSync("/proc/self/ns/pid")}`;
  } catch {
    return undefined;
  }
}

/** Read once: a process stays in the PID namespace, and on the kernel, it started in. */
let ownPidSpace: { readonly value: string | undefined } | undefined;

function localPidSpace(): string | undefined {
  ownPidSpace ??= { value: readPidSpace() };
  return ownPidSpace.value;
}

/**
 * Whether a process in this one's pid space has provably exited. Signal 0 tests for a process
 * without delivering anything, and only ESRCH proves it gone: EPERM is a live process this one may
 * not signal. A pid that is not a positive integer is never signalled, since 0 and negative pids
 * address process groups.
 */
function hasExited(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return errorCode(e) === "ESRCH";
  }
}

type HeldLock = { readonly content: string; readonly ageMs: number };

/** Whether an error says the file is no longer there: ESTALE is NFS's word for it. */
function isGone(e: unknown): boolean {
  const code = errorCode(e);
  return code === "ENOENT" || code === "ESTALE";
}

/** Read a held lock through ONE handle, so its content and its age describe the same file. */
async function inspectLock(fs: LockFs, lockPath: string): Promise<HeldLock | undefined> {
  let handle: LockHandle;
  try {
    handle = await fs.open(lockPath, "r");
  } catch (e) {
    // Released between the failed create and this read.
    if (errorCode(e) === "ENOENT") return undefined;
    throw e;
  }
  try {
    const content = await handle.readFile("utf8");
    const { mtimeMs } = await handle.stat();
    return { content, ageMs: Date.now() - mtimeMs };
  } finally {
    await handle.close();
  }
}

/**
 * Read a lock, trying again for a moment while the read fails or comes back empty. Resolves to the
 * last content read, which can be empty, or to `undefined` when no read succeeded.
 *
 * A lock is empty only from its creation until its token is written, or for good when its holder
 * died between the two, so an empty read is not yet an answer about whose it is. A failed read is
 * often not one either: WSL's `/mnt` drives report a lock that was renamed a moment ago as missing,
 * even to the process that renamed it. Measured there: 345 of 730 reads straight after a rename
 * failed while two other processes were reading the lock, and a single retry a millisecond later
 * read every one of them.
 */
async function readSettled(fs: LockFs, path: string): Promise<string | undefined> {
  let content: string | undefined;
  for (let attempt = 0; ; attempt += 1) {
    try {
      content = await fs.readFile(path, "utf8");
      if (content !== "") return content;
    } catch {
      // Missing for a moment, or not readable at all: tried again until the attempts run out.
    }
    if (attempt + 1 >= SETTLE_ATTEMPTS) return content;
    await sleep(backoffMs(attempt));
  }
}

/**
 * A lock may be taken over when its holder is provably gone — a process this one can see, that has
 * exited — or when it is older than any live append. The second covers what the first cannot
 * judge: a holder on another host or in another PID namespace, a pid that has since been reused,
 * and a lock whose body was never written because its holder died between creating and writing it.
 *
 * The pid is probed only for a lock written on this host and in this pid space (`readPidSpace`).
 * A holder the probe cannot see reads as exited while it runs: WSL beside Windows, both under one
 * hostname, took over each other's live locks at once and broke the chain. On Windows and macOS
 * the hostname is all that tells two machines apart, so two machines sharing a log must not share
 * a hostname.
 */
function isAbandoned(lock: HeldLock, staleMs: number): boolean {
  if (lock.ageMs > staleMs) return true;
  const owner = lockOwner(lock.content);
  const here = localPidSpace();
  return (
    owner !== undefined &&
    here !== undefined &&
    owner.pidSpace === here &&
    owner.host === hostname() &&
    hasExited(owner.pid)
  );
}

/**
 * Remove the lock file only if it is the one whose content is `expected`; resolves to whether it
 * was. Reading it and then unlinking it would remove a lock another writer took between the two
 * calls, so the file is renamed aside first — one atomic step that claims exactly one file — and a
 * file that turns out to be someone else's lock is linked back. So is one that cannot be read back,
 * whose owner is then unknown, and this rejects.
 */
async function removeLockIf(fs: LockFs, lockPath: string, expected: string): Promise<boolean> {
  const aside = `${lockPath}.${randomBytes(6).toString("hex")}`;
  try {
    await fs.rename(lockPath, aside);
  } catch (e) {
    if (errorCode(e) === "ENOENT") return false;
    throw e;
  }
  // Never judged from a failed read: on WSL's `/mnt` drives that made a writer give back its own
  // lock, then report it taken over.
  const moved = await readSettled(fs, aside);
  if (moved !== expected) {
    // Not the lock meant: give it back. If a third writer has taken the free name in the meantime
    // this fails, and the displaced holder finds its lock gone at its own check before it appends,
    // or when it releases, and its append refuses.
    await fs.link(aside, lockPath).catch(() => undefined);
  }
  // Only a name nothing reads remains if this fails.
  await fs.unlink(aside).catch(() => undefined);
  if (moved === undefined) {
    throw new Error(`could not read ${lockPath} back after moving it aside, so it was put back`);
  }
  return moved === expected;
}

/** Create the lock, holding `token`. False when another writer holds it. */
async function tryCreateLock(fs: LockFs, lockPath: string, token: string): Promise<boolean> {
  let handle: LockHandle;
  try {
    // `wx` is O_CREAT | O_EXCL (CREATE_NEW on Windows): of all the writers racing here, exactly one
    // creates the file, on all three platforms.
    handle = await fs.open(lockPath, "wx");
  } catch (e) {
    if (errorCode(e) === "EEXIST") return false;
    throw e;
  }
  let written = false;
  try {
    await handle.writeFile(token, "utf8");
    written = true;
  } finally {
    await handle.close();
    // A lock holding no token can only be judged by its age; do not leave one behind.
    if (!written) await fs.unlink(lockPath).catch(() => undefined);
  }
  return true;
}

/**
 * Remove an abandoned lock — one writer at a time.
 *
 * Writers waiting on one lock find it abandoned together, each judging it from what it read before
 * the others acted. Removing it on that judgement let a slower writer move aside the fresh lock a
 * faster one had just taken in its place; it was handed back, but the faster writer's check before
 * it appends had already found its lock gone, and it refused its own entry. So a takeover first
 * takes a second lock, `<log>.lock.takeover`, and judges the lock again only while holding it: the
 * slower writer then finds the faster one's fresh lock, or none, and removes nothing.
 *
 * Resolves to whether the lock is gone. A takeover holds its lock for a moment, so one older than
 * `staleMs` was left by a writer that died during it, and is removed for the next attempt.
 */
async function takeOver(fs: LockFs, lockPath: string, opts: AuditLockOptions): Promise<boolean> {
  const takeoverPath = `${lockPath}.takeover`;
  const token = randomBytes(16).toString("hex");
  if (!(await tryCreateLock(fs, takeoverPath, token))) {
    const stuck = await inspectLock(fs, takeoverPath);
    if (stuck !== undefined && stuck.ageMs > opts.staleMs) {
      await removeLockIf(fs, takeoverPath, stuck.content);
    }
    return false;
  }
  try {
    const held = await inspectLock(fs, lockPath);
    if (held === undefined) return true;
    return isAbandoned(held, opts.staleMs) && (await removeLockIf(fs, lockPath, held.content));
  } finally {
    await removeLockIf(fs, takeoverPath, token);
  }
}

/**
 * Whether an error creating or reading the lock means it is changing hands, rather than that it
 * cannot be had.
 *
 * Windows answers an open of a file that is being deleted with EPERM, not ENOENT, for the moment
 * until the deleting handle closes. Measured: a lock path that another process created and unlinked
 * in a loop made 221 to 720 of about 30,000 concurrent opens fail with EPERM within three seconds.
 * This module never unlinks the lock path itself — a release renames it aside, and the same churn
 * done by rename produced none — but an operator clearing a stuck lock by hand can, and EBUSY is
 * another process holding the file open without sharing. Elsewhere both are a real permission
 * problem, and fail at once.
 *
 * A lock that has gone since it was opened, or that is renamed while it is being created, is
 * changing hands too. Most filesystems go on serving a file renamed while it is open, but WSL's
 * `/mnt` drives answer ENOENT, and NFS can answer ESTALE. Measured on WSL, with other processes
 * taking and releasing the lock in a loop: a fifth to a half of the reads of an opened lock failed
 * that way, and 5 to 17 percent of the creates racing a Windows process. A lock whose directory is
 * missing gives ENOENT too, and that one fails at once.
 */
async function lockInTransition(fs: LockFs, e: unknown, lockPath: string): Promise<boolean> {
  if (isGone(e)) {
    return fs.stat(dirname(lockPath)).then(
      (s) => s.isDirectory(),
      () => false,
    );
  }
  const code = errorCode(e);
  return process.platform === "win32" && (code === "EPERM" || code === "EBUSY");
}

/** 2, 4, 8 … 64 ms, plus up to half again at random, so waiters do not retry in lockstep. */
function backoffMs(attempt: number): number {
  const base = Math.min(2 ** (attempt + 1), 64);
  return base + randomInt(0, base / 2 + 1);
}

async function acquireLock(
  fs: LockFs,
  path: string,
  lockPath: string,
  opts: AuditLockOptions,
): Promise<string> {
  const token = JSON.stringify({
    pid: process.pid,
    host: hostname(),
    pidSpace: localPidSpace(),
    nonce: randomBytes(16).toString("hex"),
    since: new Date().toISOString(),
  });
  const deadline = Date.now() + opts.timeoutMs;
  let transient: unknown;
  for (let attempt = 0; ; attempt += 1) {
    let held: HeldLock | undefined;
    let freed = false;
    try {
      if (await tryCreateLock(fs, lockPath, token)) return token;
      held = await inspectLock(fs, lockPath);
      // Released already, or abandoned and now removed: try again at once. A takeover that fails —
      // another writer's is under way, or a rename was refused while another process had the file
      // open — is not skipped but retried, after the wait, against a fresh look at the lock.
      freed =
        held === undefined ||
        (isAbandoned(held, opts.staleMs) &&
          (await takeOver(fs, lockPath, opts).catch(() => false)));
    } catch (e) {
      if (!(await lockInTransition(fs, e, lockPath))) throw e;
      transient = e;
    }
    if (Date.now() >= deadline) throw lockTimeout(path, lockPath, opts.timeoutMs, held, transient);
    if (!freed) await sleep(backoffMs(attempt));
  }
}

function lockTimeout(
  path: string,
  lockPath: string,
  timeoutMs: number,
  held: HeldLock | undefined,
  transient: unknown,
): Error {
  const pid = held === undefined ? undefined : lockOwner(held.content)?.pid;
  const holder = pid === undefined ? "" : `, held by process ${pid}`;
  // Waited out as a lock changing hands, but it may be the real cause: name it.
  const lastError = transient === undefined ? "" : ` (last seen: ${errorCode(transient)})`;
  return new Error(
    `audit log ${path}: gave up after ${timeoutMs} ms waiting for its lock ${lockPath}${holder}` +
      `${lastError}; the entry was not written`,
  );
}

/**
 * Release a lock this append holds. False means it was no longer ours: another writer judged it
 * abandoned and took it over while the entry was being written.
 */
async function releaseLock(fs: LockFs, lockPath: string, token: string): Promise<boolean> {
  try {
    return await removeLockIf(fs, lockPath, token);
  } catch (e) {
    // The entry is written and chained, so the append stands. The lock file stays behind and the
    // next writer takes it over once it is `staleMs` old. Say so on stderr: stdout is a stdio MCP
    // server's protocol channel.
    process.stderr.write(
      `nimbus-connector: could not remove the audit-log lock ${lockPath}: ` +
        `${e instanceof Error ? e.message : String(e)}\n`,
    );
    return true;
  }
}

/** The hash a new entry links to: the one the log's last line carries. */
function tailHash(path: string, last: string, lineNo: number): string {
  let hash: unknown;
  try {
    hash = (JSON.parse(last) as Partial<ChainedLine>).hash;
  } catch {
    hash = undefined;
  }
  if (typeof hash !== "string") {
    // A torn last line, from a writer that died mid-write or a hand edit. Linking past it would
    // hide whatever it was; refuse, so the write it records does not run unrecorded.
    throw new Error(
      `audit log ${path}: line ${lineNo} is not a chained entry, so no entry can be linked after it`,
    );
  }
  return hash;
}

/**
 * Append one entry, linked to the line that is actually last when it is written.
 *
 * The link is read from the log and the entry written after it, so two appends interleaved between
 * those steps both link to the same predecessor and the chain breaks at the second: the consent
 * kit's records from parallel tool calls did exactly that, and so did two connector processes
 * sharing one `NIMBUS_MCP_AUDIT_LOG`. Appends are therefore serialised twice over. Within a
 * process they queue per log, so entries land in the order they were recorded. Across processes
 * the read and the write happen under a lock file beside the log, `<log>.lock`, created with
 * `O_EXCL`; a lock whose holder has died is taken over, as `isAbandoned` and `takeOver` describe.
 *
 * Fails closed. An append that cannot take the lock within `timeoutMs`, cannot read the log, or
 * finds a last line it cannot link to writes nothing and rejects — and the consent kit does not
 * run a write whose entry did not land.
 *
 * The lock sits beside the file the path resolves to through any symlink, so every writer that
 * reaches the log through a symlink still takes the one lock. A hard link to the log, or a
 * container mount of the log file alone rather than its directory, still gets a lock of its own.
 */
export function appendAuditEntry(
  path: string,
  entry: AuditEntry,
  lock: AuditLockOptions = DEFAULT_AUDIT_LOCK,
): Promise<void> {
  const named = resolve(path);
  return inQueue(named, async () => appendUnderLock(await logFile(named), entry, lock));
}

/**
 * The file a log path names, every symlink resolved. The log is created first if it does not exist
 * yet: a symlink to a log nobody has written to resolves to nothing, and its first append would
 * lock beside the symlink while later ones lock beside the file.
 */
async function logFile(named: string): Promise<string> {
  await (await open(named, "a")).close();
  return realpath(named);
}

async function appendUnderLock(
  log: string,
  entry: AuditEntry,
  opts: AuditLockOptions,
): Promise<void> {
  const fs = opts.fs ?? NODE_FS;
  const lockPath = `${log}.lock`;
  const token = await acquireLock(fs, log, lockPath, opts);
  let outcome: "written" | "lost" | { readonly error: unknown };
  try {
    const lines = await readLines(log);
    const last = lines.at(-1);
    const prev = last === undefined ? GENESIS_HASH : tailHash(log, last, lines.length);
    const line: ChainedLine = { seq: lines.length + 1, prev, hash: linkHash(prev, entry), entry };
    // A lock taken over while the log was being read may be guarding another writer's append right
    // now. Checked as late as it can be, so the only window left open is between this check and
    // the write.
    const holder = await readSettled(fs, lockPath);
    if (holder === undefined) {
      throw new Error(
        `audit log ${log}: could not read its lock ${lockPath} back before writing, ` +
          "so the entry was not written",
      );
    }
    if (holder === token) {
      await appendFile(log, `${JSON.stringify(line)}\n`, "utf8");
      outcome = "written";
    } else {
      outcome = "lost";
    }
  } catch (error) {
    outcome = { error };
  }
  // A lock that is someone else's now is theirs to release; even renaming it aside and back would
  // leave its name free for a moment, for a third writer to take.
  if (outcome === "lost") {
    throw new Error(
      `audit log ${log}: another writer took over this append's lock as abandoned; ` +
        "the entry was not written",
    );
  }
  const stillOurs = await releaseLock(fs, lockPath, token);
  if (outcome !== "written") throw outcome.error;
  if (!stillOurs) {
    throw new Error(
      `audit log ${log}: the entry was written, but another writer took over its lock while it ` +
        "was being written, so the chain may not verify past it",
    );
  }
}

/**
 * Walk the chain.
 *
 * Returns the 1-based line where the links first stop agreeing, which covers both a tampered entry
 * and a deleted one — a deletion breaks the successor's `prev` link.
 *
 * A log that does not exist is an empty chain; one that exists but cannot be read rejects, rather
 * than verifying as empty. The log is read without taking its lock, so a line that is still being
 * written when it is read reports as a break: verify a log no connector is writing to.
 */
export async function verifyAuditChain(
  path: string,
): Promise<{ ok: true; count: number } | { ok: false; brokenAtLine: number }> {
  const lines = await readLines(path);
  let prev = GENESIS_HASH;
  for (const [i, raw] of lines.entries()) {
    let line: ChainedLine;
    try {
      line = JSON.parse(raw) as ChainedLine;
    } catch {
      return { ok: false, brokenAtLine: i + 1 };
    }
    if (!hashEquals(line.prev, prev) || !hashEquals(line.hash, linkHash(prev, line.entry))) {
      return { ok: false, brokenAtLine: i + 1 };
    }
    prev = line.hash;
  }
  return { ok: true, count: lines.length };
}
