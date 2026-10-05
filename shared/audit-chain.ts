import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import {
  appendFile,
  type FileHandle,
  link,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";
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
};

const DEFAULT_AUDIT_LOCK: AuditLockOptions = { staleMs: 10_000, timeoutMs: 30_000 };

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

type LockOwner = { readonly pid: number; readonly host: string };

function lockOwner(content: string): LockOwner | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { pid, host } = parsed as Record<string, unknown>;
  return typeof pid === "number" && typeof host === "string" ? { pid, host } : undefined;
}

/**
 * Whether a process on THIS host has provably exited. Signal 0 tests for a process without
 * delivering anything, and only ESRCH proves it gone: EPERM is a live process this one may not
 * signal. A pid that is not a positive integer is never signalled, since 0 and negative pids
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

/** Read a held lock through ONE handle, so its content and its age describe the same file. */
async function inspectLock(lockPath: string): Promise<HeldLock | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(lockPath, "r");
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
 * A lock may be taken over when its holder is provably gone — a process on this host that has
 * exited — or when it is older than any live append. The second covers what the first cannot
 * judge: a holder on another host sharing the log, a pid that has since been reused, and a lock
 * whose body was never written because its holder died between creating and writing it.
 *
 * The pid check trusts the hostname, so two machines sharing one log must not share a hostname.
 */
function isAbandoned(lock: HeldLock, staleMs: number): boolean {
  if (lock.ageMs > staleMs) return true;
  const owner = lockOwner(lock.content);
  return owner !== undefined && owner.host === hostname() && hasExited(owner.pid);
}

/**
 * Remove the lock file only if it is the one whose content is `expected`; resolves to whether it
 * was. Reading it and then unlinking it would remove a lock another writer took between the two
 * calls, so the file is renamed aside first — one atomic step that claims exactly one file — and a
 * file that turns out to be someone else's lock is linked back.
 */
async function removeLockIf(lockPath: string, expected: string): Promise<boolean> {
  const aside = `${lockPath}.${randomBytes(6).toString("hex")}`;
  try {
    await rename(lockPath, aside);
  } catch (e) {
    if (errorCode(e) === "ENOENT") return false;
    throw e;
  }
  const moved = await readFile(aside, "utf8").catch(() => undefined);
  if (moved !== expected) {
    // Not the lock meant: give it back. If a third writer has taken the free name in the meantime
    // this fails, and the displaced holder finds its lock gone at its own check before it appends,
    // or when it releases, and its append refuses.
    await link(aside, lockPath).catch(() => undefined);
  }
  // Only a name nothing reads remains if this fails.
  await unlink(aside).catch(() => undefined);
  return moved === expected;
}

/** Create the lock, holding `token`. False when another writer holds it. */
async function tryCreateLock(lockPath: string, token: string): Promise<boolean> {
  let handle: FileHandle;
  try {
    // `wx` is O_CREAT | O_EXCL (CREATE_NEW on Windows): of all the writers racing here, exactly one
    // creates the file, on all three platforms.
    handle = await open(lockPath, "wx");
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
    if (!written) await unlink(lockPath).catch(() => undefined);
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
async function takeOver(lockPath: string, opts: AuditLockOptions): Promise<boolean> {
  const takeoverPath = `${lockPath}.takeover`;
  const token = randomBytes(16).toString("hex");
  if (!(await tryCreateLock(takeoverPath, token))) {
    const stuck = await inspectLock(takeoverPath);
    if (stuck !== undefined && stuck.ageMs > opts.staleMs) {
      await removeLockIf(takeoverPath, stuck.content);
    }
    return false;
  }
  try {
    const held = await inspectLock(lockPath);
    if (held === undefined) return true;
    return isAbandoned(held, opts.staleMs) && (await removeLockIf(lockPath, held.content));
  } finally {
    await removeLockIf(takeoverPath, token);
  }
}

/**
 * An error that, on Windows, means the lock is changing hands rather than that it cannot be read.
 *
 * Windows answers an open of a file that is being deleted with EPERM, not ENOENT, for the moment
 * until the deleting handle closes. Measured: a lock path that another process created and unlinked
 * in a loop made 221 to 720 of about 30,000 concurrent opens fail with EPERM within three seconds.
 * This module never unlinks the lock path itself — a release renames it aside, and the same churn
 * done by rename produced none — but an operator clearing a stuck lock by hand can, and EBUSY is
 * another process holding the file open without sharing. Elsewhere both are a real permission
 * problem, and fail at once.
 */
function lockInTransition(e: unknown): boolean {
  const code = errorCode(e);
  return process.platform === "win32" && (code === "EPERM" || code === "EBUSY");
}

/** 2, 4, 8 … 64 ms, plus up to half again at random, so waiters do not retry in lockstep. */
function backoffMs(attempt: number): number {
  const base = Math.min(2 ** (attempt + 1), 64);
  return base + randomInt(0, base / 2 + 1);
}

async function acquireLock(
  path: string,
  lockPath: string,
  opts: AuditLockOptions,
): Promise<string> {
  const token = JSON.stringify({
    pid: process.pid,
    host: hostname(),
    nonce: randomBytes(16).toString("hex"),
    since: new Date().toISOString(),
  });
  const deadline = Date.now() + opts.timeoutMs;
  let transient: unknown;
  for (let attempt = 0; ; attempt += 1) {
    let held: HeldLock | undefined;
    let freed = false;
    try {
      if (await tryCreateLock(lockPath, token)) return token;
      held = await inspectLock(lockPath);
      // Released already, or abandoned and now removed: try again at once. A takeover that fails —
      // another writer's is under way, or a rename was refused while another process had the file
      // open — is not skipped but retried, after the wait, against a fresh look at the lock.
      freed =
        held === undefined ||
        (isAbandoned(held, opts.staleMs) && (await takeOver(lockPath, opts).catch(() => false)));
    } catch (e) {
      if (!lockInTransition(e)) throw e;
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
async function releaseLock(lockPath: string, token: string): Promise<boolean> {
  try {
    return await removeLockIf(lockPath, token);
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
 * run a write whose entry did not land. Every writer must name the log by the same path: a second
 * name for the file through a file symlink or hard link has a lock of its own.
 */
export function appendAuditEntry(
  path: string,
  entry: AuditEntry,
  lock: AuditLockOptions = DEFAULT_AUDIT_LOCK,
): Promise<void> {
  const log = resolve(path);
  return inQueue(log, () => appendUnderLock(log, entry, lock));
}

async function appendUnderLock(
  log: string,
  entry: AuditEntry,
  opts: AuditLockOptions,
): Promise<void> {
  const lockPath = `${log}.lock`;
  const token = await acquireLock(log, lockPath, opts);
  let outcome: "written" | "lost" | { readonly error: unknown };
  try {
    const lines = await readLines(log);
    const last = lines.at(-1);
    const prev = last === undefined ? GENESIS_HASH : tailHash(log, last, lines.length);
    const line: ChainedLine = { seq: lines.length + 1, prev, hash: linkHash(prev, entry), entry };
    // A lock taken over while the log was being read may be guarding another writer's append right
    // now. Checked as late as it can be, so the only window left open is between this check and
    // the write.
    if ((await readFile(lockPath, "utf8").catch(() => undefined)) === token) {
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
  const stillOurs = await releaseLock(lockPath, token);
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
