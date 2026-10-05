/**
 * windows-batch-args — refuse an argument cmd.exe would act on, when the CLI being spawned may
 * start a Windows batch file.
 *
 * Every spawn in this package passes an argv array with no shell, so on Linux and macOS each
 * argument reaches the CLI byte for byte. Windows breaks that for one kind of executable. A batch
 * file — a `.cmd` or `.bat` — cannot be started on its own, so CreateProcess runs it as
 * `cmd.exe /c <command line>`, and cmd.exe parses the whole command line again before the batch
 * file sees any of it. `az` and `gcloud` are batch files on Windows. Measured with Bun 1.3.14, which
 * resolves a bare `az` to `az.cmd` whenever the spawn environment spells the variable `PATH`, and
 * whose `node:child_process` launches one the same way:
 *
 *  - `&`, `|`, `<` and `>` in an argument the runtime did not quote — any argument without a space
 *    — start a second command, a pipe or a redirection: `x&echo,INJECTED` printed `INJECTED`.
 *  - `"` ends the quoting the runtime added, so an argument with a space is no defence:
 *    `q"&echo INJECTED&"` ran the `echo` too.
 *  - `%NAME%` is replaced by the value of an environment variable even inside quotes, and `!NAME!`
 *    is too in a batch file that turns on delayed expansion — so a credential in the connector's
 *    environment would be sent to the cloud API as the argument, where an error could quote it.
 *  - `(` and `)` close a parenthesised block early. `az.cmd` runs the CLI inside one, and in a
 *    batch file of that shape an unquoted argument holding `)` is a syntax error — "... was
 *    unexpected at this time" — before the CLI starts.
 *  - `^` is consumed as an escape, and a line break ends the command.
 *
 * Quoting for cmd.exe is possible, but it is a second grammar layered on the first, with `%` and
 * `!` that no quote stops; refusing is simpler and can be verified. What the refusal costs was
 * checked against every value the connectors pass: none of these characters is valid in a GCP or
 * AWS resource name, an Azure app, cluster or node pool name, or a subscription id. An Azure
 * resource group may hold `(` and `)`, but never a space, so the runtime never quotes it and
 * `az.cmd` already failed on it as above. What did work and is now refused: an Azure subscription
 * passed by a display name holding one of these characters and a space — its id still works. A
 * CloudFormation template, full of quotes, was refused too whenever the `aws` that runs is a batch
 * file, until it began to reach `aws` as a file instead of an argument.
 *
 * Which file runs is decided the way the runtime decides it — see {@link mayRunAsBatchFile} — so
 * an `aws.exe` found first is never refused, whatever batch file of that name comes later.
 *
 * Node itself never gets this far: it resolves a bare name only to `.com` or `.exe`, and it has
 * refused to spawn a `.cmd` or `.bat` without a shell since 18.20.2 / 20.12.2 (CVE-2024-27980).
 * The rule applies to both runtimes all the same, since the check costs nothing where Node would
 * have refused anyway.
 */

import { statSync } from "node:fs";
import { win32 } from "node:path";

/** The characters cmd.exe acts on when it parses a command line again, line breaks aside. */
const CMD_METACHARACTERS: ReadonlySet<string> = new Set([
  "%",
  "!",
  '"',
  "&",
  "|",
  "<",
  ">",
  "^",
  "(",
  ")",
]);

/** The extensions CreateProcess hands to cmd.exe. */
const BATCH_EXTENSIONS = [".cmd", ".bat"] as const;

/** The extensions Bun tries, in this order, on a name it looks up on Windows. */
const LOOKUP_EXTENSIONS = [".exe", ".cmd", ".bat"] as const;

/**
 * The first character of `value` that cmd.exe would act on — one of `% ! " & | < > ^ ( )`, or a
 * control character such as a line break — or `undefined` when there is none.
 */
export function cmdMetacharacterIn(value: string): string | undefined {
  for (const ch of value) {
    if (CMD_METACHARACTERS.has(ch) || (ch.codePointAt(0) ?? 0) < 0x20) {
      return ch;
    }
  }
  return undefined;
}

/**
 * Whether Windows runs a file of this name through cmd.exe: a `.cmd` or a `.bat`, in any case,
 * after the trailing dots and spaces Windows drops from a file name — `az.cmd.` opens `az.cmd`.
 */
export function isBatchFileName(name: string): boolean {
  const trimmed = name.replace(/[. ]+$/, "").toLowerCase();
  return BATCH_EXTENSIONS.some((ext) => trimmed.endsWith(ext));
}

/**
 * Whether Bun looks `name` up exactly as written instead of trying extensions on it: when it ends
 * in `.exe`, `.cmd` or `.bat`, in any case. `.com` is not among them, so `x.com` is looked up as
 * `x.com.exe`, `x.com.cmd` and `x.com.bat`.
 */
function endsWithLookupExtension(name: string): boolean {
  return /\.(?:exe|cmd|bat)$/i.test(name);
}

/** The filesystem a batch-file check looks at. Production leaves both to their defaults. */
export interface BatchFileProbe {
  /**
   * Whether a FILE exists at a path. A directory does not count, as it does not for Bun's lookup.
   * Defaults to a `statSync` check, which follows a link to what it points at.
   */
  readonly exists?: (path: string) => boolean;
  /**
   * The directory a relative name or `PATH` entry is resolved against. Defaults to
   * `process.cwd()`: nothing here spawns with a `cwd` of its own.
   */
  readonly cwd?: string;
}

/** Whether a file — not a directory — exists at `path`. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The value of each PATH variable of `env` that is set and not empty, in every spelling of its
 * name: `PATH`, the one Bun reads, and `Path`, which is how Windows spells it and which a copy of
 * a Windows-launched process's environment keeps.
 */
function pathValues(env: Record<string, string | undefined>): string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === "path" && value !== undefined && value !== "") {
      values.push(value);
    }
  }
  return values;
}

/**
 * The orders in which a PATH value's directories are searched: its entries as written, which is
 * how Bun reads them, and — when that differs — with whitespace and surrounding quotes removed
 * from each, as cmd.exe reads them. An empty entry is skipped, as Bun skips it.
 */
function searchOrders(value: string): string[][] {
  const written = value.split(win32.delimiter).filter((entry) => entry !== "");
  const cleaned = written
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry !== "");
  const same =
    cleaned.length === written.length && cleaned.every((entry, i) => entry === written[i]);
  return same ? [written] : [written, cleaned];
}

/**
 * Whether the first of `bases` that a file `<base>.exe`, `<base>.cmd` or `<base>.bat` exists for
 * has a `.cmd` or `.bat` one: the lookup stops at the first such place, and that place decides.
 */
function firstHolderIsBatch(bases: readonly string[], exists: (path: string) => boolean): boolean {
  for (const base of bases) {
    const found = LOOKUP_EXTENSIONS.filter((ext) => exists(base + ext));
    if (found.length > 0) {
      return found.some((ext) => ext !== ".exe");
    }
  }
  return false;
}

/**
 * Whether spawning `bin` with `env` may start a batch file — whether the file that runs would be a
 * `.cmd` or a `.bat`.
 *
 * That depends on how the runtime turns a name into a file, and this answers it the way Bun does
 * on Windows: read from its source, unchanged from 1.2.0 to 1.3.14, and held to what the real
 * lookup does by `windows-batch-args.test.ts` on Windows.
 *
 *  - A name ending in `.cmd` or `.bat`, after the trailing dots and spaces Windows drops from a
 *    file name, is one: every runtime that starts it hands it to cmd.exe.
 *  - A name ending in `.exe` is looked up as written, and an `.exe` never is one.
 *  - Bun looks any other name up only when the spawn environment has a non-empty variable spelled
 *    exactly `PATH`. A bare name is looked for in each of that variable's entries in turn, and a
 *    name written with a `\` in its own directory alone, each time as `<name>.exe`, `<name>.cmd`
 *    and `<name>.bat`, and the first file found is what runs. So an `aws.exe` found before any
 *    `aws.cmd` is not a batch file, whatever comes after it. The current directory is not searched
 *    for a bare name.
 *  - Otherwise — and for any name written with a `/` — Bun hands the name to libuv, as Node does,
 *    and libuv starts only a `.com` or an `.exe`: never a batch file.
 *
 * It says yes where Bun could change without notice, and nowhere else: a PATH variable counts in
 * any spelling, not only `PATH` — Bun reads no other, though `nimbus-spawn.ts` respells the
 * variable `PATH` before every spawn, so a bare `az` under `Path` starts too — and each is searched
 * both as written and with whitespace and quotes stripped from its entries; a name written with a
 * `/` is looked up in its directory as one with a `\` is; and the first place holding the name
 * answers yes if it holds a `.cmd` or `.bat` by that name, even beside an `.exe` Bun would try
 * first.
 */
export function mayRunAsBatchFile(
  bin: string,
  env: Record<string, string | undefined>,
  probe: BatchFileProbe = {},
): boolean {
  if (isBatchFileName(bin)) {
    return true;
  }
  if (bin === "" || endsWithLookupExtension(bin)) {
    return false;
  }
  const paths = pathValues(env);
  if (paths.length === 0) {
    return false;
  }
  const exists = probe.exists ?? isFile;
  const cwd = probe.cwd ?? process.cwd();
  if (bin.includes("/") || bin.includes("\\")) {
    return firstHolderIsBatch([win32.resolve(cwd, bin)], exists);
  }
  return paths.some((value) =>
    searchOrders(value).some((dirs) =>
      firstHolderIsBatch(
        dirs.map((dir) => win32.resolve(cwd, dir, bin)),
        exists,
      ),
    ),
  );
}

/** A character named the way a refusal message can show it. */
function describeCharacter(ch: string): string {
  const code = ch.codePointAt(0) ?? 0;
  return code < 0x20
    ? `the control character U+${code.toString(16).toUpperCase().padStart(4, "0")}`
    : JSON.stringify(ch);
}

/** Options for {@link batchArgumentRefusal}: the filesystem probe, and the platform it applies on. */
export interface BatchArgumentOptions extends BatchFileProbe {
  /** Defaults to `process.platform`. The rule applies only on `"win32"`. */
  readonly platform?: NodeJS.Platform;
}

/**
 * Why `command` must not be spawned with `env`, or `undefined` when it may: on Windows, when the
 * program may start a batch file ({@link mayRunAsBatchFile}) and an argument holds a character
 * cmd.exe would act on ({@link cmdMetacharacterIn}).
 *
 * The arguments are scanned first, so the filesystem is consulted only for a command that would
 * be refused if its program were a batch file — an ordinary spawn costs no lookups at all. The
 * message names the argument by position and the character, never the value, which may be long
 * or private.
 */
export function batchArgumentRefusal(
  command: readonly string[],
  env: Record<string, string | undefined>,
  options: BatchArgumentOptions = {},
): string | undefined {
  if ((options.platform ?? process.platform) !== "win32") {
    return undefined;
  }
  const [bin, ...args] = command;
  if (bin === undefined) {
    return undefined;
  }
  for (const [index, arg] of args.entries()) {
    const ch = cmdMetacharacterIn(arg);
    if (ch === undefined) {
      continue;
    }
    if (!mayRunAsBatchFile(bin, env, options)) {
      return undefined;
    }
    return (
      `refused to run ${JSON.stringify(bin)}: it may start a Windows batch file, which cmd.exe ` +
      `parses again before the CLI sees its arguments, and argument ${String(index + 1)} holds ` +
      `${describeCharacter(ch)}, which cmd.exe would act on. Nothing was run.`
    );
  }
  return undefined;
}
