import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { type AuditEntry, appendAuditEntry, verifyAuditChain } from "./audit-chain.ts";

const tempDirs: string[] = [];

async function tempLog(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nimbus-audit-"));
  tempDirs.push(dir);
  return join(dir, "audit.jsonl");
}

/** The parsed lines of a log, in file order. */
async function chainedLines(p: string): Promise<{ seq: number; entry: AuditEntry }[]> {
  return (await readFile(p, "utf8"))
    .trimEnd()
    .split("\n")
    .map((l) => JSON.parse(l) as { seq: number; entry: AuditEntry });
}

/** 1..n */
function oneTo(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

/**
 * A writer PROCESS: it says it has started, then appends `count` entries to `log`, one after
 * another, as connector `who`.
 *
 * Built by concatenation and run from a temp directory: a fixture under `shared/` would ship in
 * the package.
 */
const WRITER_SOURCE = [
  'import { writeFileSync } from "node:fs";',
  'import { join } from "node:path";',
  `import { appendAuditEntry } from ${JSON.stringify(new URL("./audit-chain.ts", import.meta.url).href)};`,
  "const [log, who, count, dir] = process.argv.slice(2);",
  'writeFileSync(join(dir, "started-" + who), "");',
  "for (let i = 0; i < Number(count); i += 1) {",
  "  await appendAuditEntry(log, {",
  '    ts: "2026-10-05T00:00:00.000Z", connector: who, tool: "t" + i, outcome: "executed", detail: {},',
  "  });",
  "}",
].join("\n");

/**
 * Run `n` writer processes on one log, `count` entries each, as `w0`…`w<n-1>`, all queued behind a
 * lock this test holds: one naming this live process, and fresh, so it is waited for and never
 * taken over. Once every writer has begun its first append, `then` is handed the lock to release
 * or age; the writers are then awaited, and every one must exit cleanly.
 *
 * Holding the lock is what makes the writers overlap by construction: each began before `then`,
 * and none can finish an append until after it. Without it one writer could finish before the next
 * had started, and a test of the lock would pass with no lock at all.
 */
async function writeConcurrently(
  log: string,
  n: number,
  count: number,
  then: (lockPath: string) => Promise<void>,
): Promise<void> {
  const lockPath = await plantLock(log, lockBody(process.pid));
  const dir = await mkdtemp(join(tmpdir(), "nimbus-audit-writers-"));
  tempDirs.push(dir);
  const script = join(dir, "writer.ts");
  await writeFile(script, WRITER_SOURCE);
  const procs = Array.from({ length: n }, (_, k) =>
    Bun.spawn([process.execPath, script, log, `w${k}`, String(count), dir], {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    }),
  );
  try {
    const deadline = Date.now() + 60_000;
    while ((await readdir(dir)).filter((f) => f.startsWith("started-")).length < n) {
      if (Date.now() > deadline) throw new Error("the writer processes never started");
      await Bun.sleep(5);
    }
    await then(lockPath);
    const codes = await Promise.all(procs.map((p) => p.exited));
    const stderr = await Promise.all(procs.map((p) => new Response(p.stderr).text()));
    expect({ codes, stderr }).toEqual({
      codes: Array.from({ length: n }, () => 0),
      stderr: Array.from({ length: n }, () => ""),
    });
  } finally {
    for (const p of procs) p.kill();
  }
}

/** Write a lock file as a writer would leave it behind, optionally backdated by `ageMs`. */
async function plantLock(log: string, body: string, ageMs = 0): Promise<string> {
  const lockPath = `${log}.lock`;
  await writeFile(lockPath, body);
  if (ageMs > 0) {
    const then = new Date(Date.now() - ageMs);
    await utimes(lockPath, then, then);
  }
  return lockPath;
}

function lockBody(pid: number, host = hostname()): string {
  return JSON.stringify({ pid, host, nonce: "planted", since: "2026-10-05T00:00:00.000Z" });
}

/**
 * The pid of a process that has exited, checked to be gone: pids are reused, and quickly on
 * Windows, so a dead process's pid is only known dead once signal 0 says so.
 */
function exitedPid(): number {
  for (let i = 0; i < 20; i += 1) {
    const { pid } = Bun.spawnSync([process.execPath, "-e", ""], { windowsHide: true });
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("every exited pid tried had already been reused");
}

/** The files beside a log other than the log itself: a lock left behind, or a renamed one. */
async function leftovers(log: string): Promise<string[]> {
  return (await readdir(dirname(log))).filter((f) => f !== basename(log));
}

/**
 * A process that, for `ms`, creates the lock and deletes it again as fast as it can — the way a
 * tool that deletes rather than renames would — then prints how many times it did. It says it has
 * started through a file, since its tight loop never yields to flush stdout.
 */
const CHURNER_SOURCE = [
  'import { closeSync, openSync, unlinkSync, writeFileSync, writeSync } from "node:fs";',
  "const [lockPath, ms, startedPath] = process.argv.slice(2);",
  "const end = Date.now() + Number(ms);",
  'writeFileSync(startedPath, "");',
  "let cycles = 0;",
  "while (Date.now() < end) {",
  "  let fd;",
  "  try {",
  '    fd = openSync(lockPath, "wx");',
  "  } catch {",
  "    continue;",
  "  }",
  '  writeSync(fd, "busy");',
  "  closeSync(fd);",
  "  try {",
  "    unlinkSync(lockPath);",
  "    cycles += 1;",
  "  } catch {}",
  "}",
  "process.stdout.write(String(cycles));",
].join("\n");

const HOUR_MS = 3_600_000;

/** A lock that is never taken over by age, and a wait short enough to time out in a test. */
const QUICK_TIMEOUT = { staleMs: HOUR_MS, timeoutMs: 250 };

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function entry(tool: string, outcome: AuditEntry["outcome"]): AuditEntry {
  return { ts: "2026-08-23T00:00:00.000Z", tool, outcome, connector: "github", detail: {} };
}

describe("audit chain", () => {
  test("an empty/absent log verifies as an empty chain", async () => {
    const p = await tempLog();
    expect(await verifyAuditChain(p)).toEqual({ ok: true, count: 0 });
  });

  test("appends verify, and the chain survives multiple entries", async () => {
    const p = await tempLog();
    await appendAuditEntry(p, entry("github_pr_merge", "requested"));
    await appendAuditEntry(p, entry("github_pr_merge", "accepted"));
    await appendAuditEntry(p, entry("github_pr_merge", "executed"));
    expect(await verifyAuditChain(p)).toEqual({ ok: true, count: 3 });
  });

  test("a TAMPERED entry breaks verification at its line", async () => {
    const p = await tempLog();
    await appendAuditEntry(p, entry("github_pr_merge", "declined"));
    await appendAuditEntry(p, entry("github_branch_delete", "executed"));

    const lines = (await readFile(p, "utf8")).trimEnd().split("\n");
    const first = JSON.parse(lines[0] as string) as { entry: AuditEntry };
    (first.entry as { outcome: string }).outcome = "accepted";
    lines[0] = JSON.stringify(first);
    await writeFile(p, `${lines.join("\n")}\n`);

    expect(await verifyAuditChain(p)).toEqual({ ok: false, brokenAtLine: 1 });
  });

  test("a DELETED middle entry breaks the chain — append-only is enforced by the links", async () => {
    const p = await tempLog();
    await appendAuditEntry(p, entry("a", "executed"));
    await appendAuditEntry(p, entry("b", "executed"));
    await appendAuditEntry(p, entry("c", "executed"));

    const lines = (await readFile(p, "utf8")).trimEnd().split("\n");
    await writeFile(p, `${[lines[0], lines[2]].join("\n")}\n`);

    expect(await verifyAuditChain(p)).toEqual({ ok: false, brokenAtLine: 2 });
  });

  test("an unparseable line is reported at its own position, not as a silent pass", async () => {
    const p = await tempLog();
    await appendAuditEntry(p, entry("a", "executed"));
    await writeFile(p, `${(await readFile(p, "utf8")).trimEnd()}\nnot-json\n`);
    expect(await verifyAuditChain(p)).toEqual({ ok: false, brokenAtLine: 2 });
  });

  test("key order in detail does not affect verification", async () => {
    const p = await tempLog();
    await appendAuditEntry(p, {
      ts: "2026-08-23T00:00:00.000Z",
      connector: "github",
      tool: "t",
      outcome: "executed",
      detail: { b: 2, a: 1 },
    });
    expect(await verifyAuditChain(p)).toEqual({ ok: true, count: 1 });
  });

  test("two entries differing ONLY in key insertion order hash identically", async () => {
    // The case above verifies a chain against ITSELF, so any self-consistent key order passes it —
    // including one that preserves insertion order. The property that actually matters is that the
    // order is CANONICAL: the same entry written on two hosts, or built by two code paths that
    // happened to assign `detail` keys in different orders, must produce the same digest, or a
    // chain written by one fails to verify against the other. Two independent chains, compared.
    async function firstHash(detail: Record<string, unknown>): Promise<string> {
      const p = await tempLog();
      await appendAuditEntry(p, {
        ts: "2026-08-23T00:00:00.000Z",
        connector: "github",
        tool: "t",
        outcome: "executed",
        detail,
      });
      const line = (await readFile(p, "utf8")).trimEnd();
      return (JSON.parse(line) as { hash: string }).hash;
    }
    // Single-character keys on purpose: a comparator that sorted by anything other than the key
    // text — length, say — leaves these in insertion order and the two digests diverge.
    const forward = await firstHash({ a: 1, b: 2, z: 3 });
    const shuffled = await firstHash({ z: 3, b: 2, a: 1 });
    expect(shuffled).toBe(forward);
    // Nested objects go through the same comparator, so pin that too.
    expect(await firstHash({ o: { p: 1, q: 2 } })).toBe(await firstHash({ o: { q: 2, p: 1 } }));
  });

  test("an entry with an undefined value verifies, hashed as the line that was written", async () => {
    // JSON.stringify drops a key whose value is undefined, so that key is not in the log. The hash
    // used to include it as `null`, and the entry then failed verification on its first read.
    const p = await tempLog();
    await appendAuditEntry(p, {
      ts: "2026-08-23T00:00:00.000Z",
      connector: "kubernetes",
      tool: "k8s_pod_delete",
      outcome: "executed",
      // In an ARRAY, JSON.stringify writes undefined as null - and so must the hash.
      detail: {
        preState: { namespace: undefined, podName: "web-1" },
        list: [1, "two", null, undefined],
      },
    });
    await appendAuditEntry(p, entry("k8s_pod_delete", "executed"));
    const written = JSON.parse((await readFile(p, "utf8")).split("\n")[0] as string) as {
      entry: AuditEntry;
    };
    expect(written.entry.detail).toEqual({
      preState: { podName: "web-1" },
      list: [1, "two", null, null],
    });
    expect(await verifyAuditChain(p)).toEqual({ ok: true, count: 2 });
  });

  test("an undefined value hashes exactly like the absent key, and unlike null", async () => {
    async function firstHash(detail: Record<string, unknown>): Promise<string> {
      const p = await tempLog();
      await appendAuditEntry(p, {
        ts: "2026-08-23T00:00:00.000Z",
        connector: "kubernetes",
        tool: "t",
        outcome: "executed",
        detail,
      });
      return (JSON.parse((await readFile(p, "utf8")).trimEnd()) as { hash: string }).hash;
    }
    const absent = await firstHash({ podName: "web-1" });
    expect(await firstHash({ namespace: undefined, podName: "web-1" })).toBe(absent);
    // A null IS written, so it must still count.
    expect(await firstHash({ namespace: null, podName: "web-1" })).not.toBe(absent);
  });

  test("a log file that is empty or only whitespace verifies as an empty chain", async () => {
    const p = await tempLog();
    await writeFile(p, "\n  \n");
    expect(await verifyAuditChain(p)).toEqual({ ok: true, count: 0 });
  });
});

describe("concurrent appends", () => {
  test("parallel appends in one process all chain, in the order they were made", async () => {
    // The consent kit records from every tool call in flight, and the SDK runs those calls
    // concurrently. Each append read the tail, then wrote after it, so all of these used to read
    // the same empty log: fifty lines, every one `seq: 1` linked to the genesis hash, and the chain
    // broken at line 2.
    const p = await tempLog();
    const n = 100;
    await Promise.all(oneTo(n).map((i) => appendAuditEntry(p, entry(`t${i}`, "executed"))));

    expect(await verifyAuditChain(p)).toEqual({ ok: true, count: n });
    const lines = await chainedLines(p);
    expect(lines.map((l) => l.seq)).toEqual(oneTo(n));
    // In CALL order, not merely in some order: within a process appends queue, so the log tells
    // the order in which things were recorded.
    expect(lines.map((l) => l.entry.tool)).toEqual(oneTo(n).map((i) => `t${i}`));
    expect(await leftovers(p)).toEqual([]);
  }, 30_000);

  test("appends from several processes at once all chain", async () => {
    // Every MCP client session starts its own copy of each configured connector, and the
    // documented config names one log for all of them, so separate processes append to one file.
    // Measured before the fix: four processes of 25 appends each broke the chain on every run.
    const p = await tempLog();
    const writers = 4;
    const each = 25;
    await writeConcurrently(p, writers, each, (lockPath) => rm(lockPath));

    expect(await verifyAuditChain(p)).toEqual({ ok: true, count: writers * each });
    const lines = await chainedLines(p);
    expect(lines.map((l) => l.seq)).toEqual(oneTo(writers * each));
    for (let k = 0; k < writers; k += 1) {
      const mine = lines.filter((l) => l.entry.connector === `w${k}`).map((l) => l.entry.tool);
      expect(mine).toEqual(oneTo(each).map((i) => `t${i - 1}`));
    }
    expect(await leftovers(p)).toEqual([]);
  }, 60_000);

  test("a failed append releases the lock and does not stall the appends queued behind it", async () => {
    const p = await tempLog();
    // A BigInt cannot be serialised, so this append fails while it holds the lock.
    const unwritable: AuditEntry = { ...entry("bad", "executed"), detail: { n: 1n } };
    const [bad, good] = await Promise.allSettled([
      appendAuditEntry(p, unwritable),
      appendAuditEntry(p, entry("good", "executed")),
    ]);
    expect(bad.status).toBe("rejected");
    expect(good.status).toBe("fulfilled");
    expect(await verifyAuditChain(p)).toEqual({ ok: true, count: 1 });
    expect((await chainedLines(p)).map((l) => l.entry.tool)).toEqual(["good"]);
    expect(await leftovers(p)).toEqual([]);
  });
});

describe("a lock left behind", () => {
  test("by a process that has exited is taken over at once", async () => {
    // A connector killed mid-append — a client closing its stdio servers — leaves its lock behind.
    // Its pid is provably dead, so the lock is taken over without waiting for it to age: the wait
    // allowed here is far shorter than the age that would otherwise be needed.
    const p = await tempLog();
    await plantLock(p, lockBody(exitedPid()));
    await appendAuditEntry(p, entry("after-crash", "executed"), {
      staleMs: HOUR_MS,
      timeoutMs: 10_000,
    });
    expect(await verifyAuditChain(p)).toEqual({ ok: true, count: 1 });
    expect(await leftovers(p)).toEqual([]);
  });

  test("by a live holder is waited for, and the append then fails closed", async () => {
    const p = await tempLog();
    const lockPath = await plantLock(p, lockBody(process.pid));
    await expect(appendAuditEntry(p, entry("blocked", "executed"), QUICK_TIMEOUT)).rejects.toThrow(
      `gave up after 250 ms waiting for its lock ${lockPath}, held by process ${process.pid}; the entry was not written`,
    );
    // Nothing written, and the live holder's lock untouched.
    expect(await leftovers(p)).toEqual([basename(lockPath)]);
    expect(await readFile(lockPath, "utf8")).toBe(lockBody(process.pid));
    expect(await verifyAuditChain(p)).toEqual({ ok: true, count: 0 });
  });

  test("older than staleMs is taken over even though its holder still runs", async () => {
    // A pid can be reused by an unrelated process, so a live pid alone cannot hold a log forever.
    const p = await tempLog();
    await plantLock(p, lockBody(process.pid), HOUR_MS);
    await appendAuditEntry(p, entry("after-stale", "executed"));
    expect(await verifyAuditChain(p)).toEqual({ ok: true, count: 1 });
    expect(await leftovers(p)).toEqual([]);
  });

  test("with no body — its holder died between creating and writing it — is judged by age", async () => {
    const fresh = await tempLog();
    await plantLock(fresh, "");
    await expect(appendAuditEntry(fresh, entry("x", "executed"), QUICK_TIMEOUT)).rejects.toThrow(
      /gave up after 250 ms/,
    );

    const old = await tempLog();
    await plantLock(old, "", HOUR_MS);
    await appendAuditEntry(old, entry("x", "executed"));
    expect(await verifyAuditChain(old)).toEqual({ ok: true, count: 1 });
    expect(await leftovers(old)).toEqual([]);
  });

  test("from another host is judged by age alone, never by a pid this host cannot see", async () => {
    // The pid is dead HERE, which says nothing about a process on the machine that wrote it.
    const body = lockBody(exitedPid(), `${hostname()}-elsewhere`);
    const fresh = await tempLog();
    await plantLock(fresh, body);
    await expect(appendAuditEntry(fresh, entry("x", "executed"), QUICK_TIMEOUT)).rejects.toThrow(
      /gave up after 250 ms/,
    );

    const old = await tempLog();
    await plantLock(old, body, HOUR_MS);
    await appendAuditEntry(old, entry("x", "executed"));
    expect(await verifyAuditChain(old)).toEqual({ ok: true, count: 1 });
  });

  test("that another process keeps deleting by hand is waited out, never an error", async () => {
    // Windows answers an open of a file that is being deleted with EPERM, not ENOENT, until the
    // deleting handle closes. A waiting writer took that for a failure to read the lock and refused
    // its write: one run in sixty of the cross-process test above, which releases its lock by
    // deleting it. Here the lock is deleted thousands of times while appends wait on it.
    const p = await tempLog();
    const dir = await mkdtemp(join(tmpdir(), "nimbus-audit-churn-"));
    tempDirs.push(dir);
    const script = join(dir, "churner.ts");
    const started = join(dir, "started");
    await writeFile(script, CHURNER_SOURCE);
    const churner = Bun.spawn([process.execPath, script, `${p}.lock`, "2000", started], {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    try {
      while (!(await readdir(dir)).includes("started")) await Bun.sleep(5);
      let appended = 0;
      const until = Date.now() + 1000;
      while (Date.now() < until) {
        await appendAuditEntry(p, entry(`t${appended}`, "executed"), {
          staleMs: HOUR_MS,
          timeoutMs: 10_000,
        });
        appended += 1;
      }
      expect(await churner.exited).toBe(0);
      // The premise: the lock really was being deleted all the while.
      expect(Number(await new Response(churner.stdout).text())).toBeGreaterThan(100);
      expect(await verifyAuditChain(p)).toEqual({ ok: true, count: appended });
    } finally {
      churner.kill();
    }
  }, 30_000);

  test("is taken over by one writer at a time: a takeover under way is waited for", async () => {
    // The lock's holder is dead, but another writer is in the middle of taking it over. Acting on
    // the same judgement could remove the fresh lock that writer is about to take.
    const p = await tempLog();
    const lockPath = await plantLock(p, lockBody(exitedPid()));
    await writeFile(`${lockPath}.takeover`, "another-writer");
    await expect(appendAuditEntry(p, entry("x", "executed"), QUICK_TIMEOUT)).rejects.toThrow(
      /gave up after 250 ms/,
    );
    expect((await leftovers(p)).sort()).toEqual([
      basename(lockPath),
      `${basename(lockPath)}.takeover`,
    ]);
  });

  test("is still taken over when a writer died in the middle of taking it over", async () => {
    // A takeover lock is held for a moment, so an old one is abandoned too. Left in place it would
    // block every takeover, and with them every write, until someone deleted it by hand.
    const p = await tempLog();
    const lockPath = await plantLock(p, lockBody(exitedPid()));
    await writeFile(`${lockPath}.takeover`, "dead-writer");
    const then = new Date(Date.now() - HOUR_MS);
    await utimes(`${lockPath}.takeover`, then, then);
    await appendAuditEntry(p, entry("x", "executed"), { staleMs: 10_000, timeoutMs: 5_000 });
    expect(await verifyAuditChain(p)).toEqual({ ok: true, count: 1 });
    expect(await leftovers(p)).toEqual([]);
  });

  test("found by several processes at once is taken over once, and every entry still chains", async () => {
    // Every writer is already waiting on the lock when it ages past staleMs, so all of them judge
    // it abandoned together and race to take it over. Before takeovers took a lock of their own, a
    // slower writer could move aside the fresh lock a faster one had just taken, and the faster one
    // then refused its own entry: one run in thirty with four writers, and in the full suite.
    const p = await tempLog();
    const writers = 8;
    await writeConcurrently(p, writers, 5, async (lockPath) => {
      const then = new Date(Date.now() - HOUR_MS);
      await utimes(lockPath, then, then);
    });
    expect(await verifyAuditChain(p)).toEqual({ ok: true, count: writers * 5 });
    expect(await leftovers(p)).toEqual([]);
  }, 60_000);
});

describe("an append fails closed", () => {
  test("when its lock is taken over while it reads the log, and writes nothing", async () => {
    // A live writer's lock is taken over only once it is older than staleMs: a writer stalled
    // mid-append. An entry linked from that writer's stale read, after the new holder may have
    // written, would break the chain, so the append checks that it still holds the lock just
    // before it writes. A 32 MB log keeps the read slow enough for the test to act during it.
    const p = await tempLog();
    await appendAuditEntry(p, entry("a", "executed"));
    const last = await readFile(p, "utf8");
    await writeFile(p, `${`${"x".repeat(1023)}\n`.repeat(32 * 1024)}${last}`);
    const before = await readFile(p);
    const lockPath = `${p}.lock`;

    const pending = appendAuditEntry(p, entry("b", "executed"));
    // Wait for the append's own lock, then take it over the way another writer would.
    while (!(await readFile(lockPath, "utf8").catch(() => "")).includes('"nonce"')) {
      await new Promise((r) => setImmediate(r));
    }
    await writeFile(lockPath, "another-writer");

    await expect(pending).rejects.toThrow(
      "another writer took over this append's lock as abandoned; the entry was not written",
    );
    expect((await readFile(p)).equals(before)).toBe(true);
    // The lock is the other writer's now, so it is left for that writer to release.
    expect(await readFile(lockPath, "utf8")).toBe("another-writer");
  });

  test("on a log that exists but cannot be read, which is not an empty one", async () => {
    // Read as empty, the next entry was linked to the genesis hash after whatever the log already
    // held, and verification passed on a log nobody could read.
    const p = await tempLog();
    await mkdir(p);
    await expect(verifyAuditChain(p)).rejects.toThrow();
    await expect(appendAuditEntry(p, entry("x", "executed"))).rejects.toThrow();
    expect(await leftovers(p)).toEqual([]);
  });

  test("after a last line that is not a chained entry, and writes nothing", async () => {
    for (const torn of ["not-json", "{}", '{"hash":7}']) {
      const p = await tempLog();
      await appendAuditEntry(p, entry("a", "executed"));
      await writeFile(p, `${(await readFile(p, "utf8")).trimEnd()}\n${torn}\n`);
      const before = await readFile(p, "utf8");
      await expect(appendAuditEntry(p, entry("b", "executed"))).rejects.toThrow(
        "line 2 is not a chained entry, so no entry can be linked after it",
      );
      expect(await readFile(p, "utf8")).toBe(before);
      expect(await leftovers(p)).toEqual([]);
    }
  });
});
