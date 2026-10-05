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
 *    environment would be sent to the cloud API as the argument, and come back in its error.
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
 * passed by a display name holding one of these characters and a space — its id still works — and
 * a CloudFormation template body, whenever `aws` is itself a batch file, as a pip-installed v1 is.
 *
 * Node itself never gets this far: it resolves a bare name only to `.com` or `.exe`, and it has
 * refused to spawn a `.cmd` or `.bat` without a shell since 18.20.2 / 20.12.2 (CVE-2024-27980).
 * The rule applies to both runtimes all the same, since the check costs nothing where Node would
 * have refused anyway.
 */

import { existsSync } from "node:fs";
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

/** Whether `name` names a program file explicitly, so no resolver appends an extension to it. */
function isProgramFileName(name: string): boolean {
  const trimmed = name.replace(/[. ]+$/, "").toLowerCase();
  return trimmed.endsWith(".exe") || trimmed.endsWith(".com");
}

/** The filesystem a batch-file check looks at. Production leaves both to their defaults. */
export interface BatchFileProbe {
  /** Whether a path exists. Defaults to `existsSync`. */
  readonly exists?: (path: string) => boolean;
  /** The directory a relative command or `PATH` entry is resolved against. Defaults to `process.cwd()`. */
  readonly cwd?: string;
}

/**
 * Every directory a `PATH` variable of `env` lists, in any spelling of its name — Windows spells it
 * `Path`, and a copy of the environment keeps that spelling while an MCP client usually writes
 * `PATH`. Each entry is offered both as written and without surrounding whitespace and quotes,
 * since the resolvers involved do not agree on whether to strip them.
 */
function pathDirectories(env: Record<string, string | undefined>): string[] {
  const dirs = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() !== "path" || value === undefined) {
      continue;
    }
    for (const entry of value.split(win32.delimiter)) {
      const cleaned = entry.trim().replace(/^"(.*)"$/, "$1");
      for (const dir of [entry, cleaned]) {
        if (dir !== "") {
          dirs.add(dir);
        }
      }
    }
  }
  return [...dirs];
}

/**
 * Whether spawning `bin` may start a batch file, given the environment the child is spawned with.
 *
 * A SUPERSET of what any one resolver does, on purpose. Bun looks up a bare name in the
 * environment's `PATH` trying `.exe`, `.cmd` and `.bat` in each directory; libuv, behind Node and
 * behind Bun when the environment spells the variable `Path`, tries only `.com` and `.exe`; cmd.exe
 * starts with the current directory. Predicting which of several same-named files one of them
 * would pick is exactly the reasoning that goes wrong across runtime versions, so this does not
 * try: a batch file by that name in the current directory or in any directory of any `PATH`
 * variable of `env` or of this process makes the answer yes. A name that is itself a `.cmd` or
 * `.bat` is always yes; one that is itself an `.exe` or `.com` is always no.
 */
export function mayRunAsBatchFile(
  bin: string,
  env: Record<string, string | undefined>,
  probe: BatchFileProbe = {},
): boolean {
  if (isBatchFileName(bin)) {
    return true;
  }
  if (isProgramFileName(bin)) {
    return false;
  }
  const exists = probe.exists ?? existsSync;
  const cwd = probe.cwd ?? process.cwd();
  // A name with a separator is a path, and no resolver searches PATH for it.
  const hasSeparator = bin.includes("/") || bin.includes("\\");
  const dirs = hasSeparator
    ? [cwd]
    : [cwd, ...pathDirectories(env), ...pathDirectories(process.env)];
  return dirs.some((dir) =>
    BATCH_EXTENSIONS.some((ext) => exists(win32.resolve(cwd, dir, bin + ext))),
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
