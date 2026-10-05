/**
 * Guard a tool-supplied value before it is passed as an argument to a spawned CLI
 * (`gcloud` / `aws` / `az` / `kubectl` / …).
 *
 * Spawns use an argv array (no shell), so there is no classic shell injection — but
 * a value that begins with `-` would be parsed by the CLI as a FLAG rather than a
 * positional / flag-value. This "argv flag smuggling" lets tool input inject
 * arbitrary CLI flags (e.g. a `sinkName` of `--project=attacker`, or a pod name of
 * `--kubeconfig=<path>`, whose exec credential plugin runs a command). Reject
 * any value that is empty, over-long, starts with `-`, or contains control
 * characters.
 *
 * Resource-id charsets vary per service (sink ids are `[A-Za-z0-9_.-]`, CloudWatch
 * log-group names contain `/`, BigQuery refs contain `.`), so this is the UNIVERSAL
 * guard against flag smuggling; callers may layer a stricter per-resource regex on
 * top. Two CLIs need one: `aws` and `az` read some argument values from a file
 * instead of taking them as written — see {@link awsCliArgProblem} and
 * {@link azCliArgProblem}. A third rule is not per value at all: an argument to a CLI
 * that Windows runs as a batch file is checked at the spawn itself, in
 * `windows-batch-args.ts`.
 *
 * Returns the value unchanged so it can be used inline:
 * `cli(["describe", assertSafeCliArg(p.id, "id")])`.
 *
 * @throws {Error} when the value is unsafe to pass as a CLI argument.
 */
export function assertSafeCliArg(value: string, label = "argument"): string {
  const problem = cliArgProblem(value);
  if (problem !== undefined) {
    throw new Error(`Invalid ${label}: ${problem}`);
  }
  return value;
}

/** The longest value accepted as one CLI argument. */
const MAX_CLI_ARG_LENGTH = 1024;

/**
 * Why `value` must not be passed to a spawned CLI as one argument, or `undefined` when it may.
 *
 * The reason is the whole of the message a refusal carries, so it says what to change. It is the
 * rule {@link assertSafeCliArg} throws on and {@link isSafeCliArg} tests, written once so that the
 * two can never disagree.
 */
export function cliArgProblem(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return "must be a non-empty string";
  }
  if (value.length > MAX_CLI_ARG_LENGTH) {
    return `exceeds ${String(MAX_CLI_ARG_LENGTH)} characters`;
  }
  if (value.startsWith("-")) {
    return 'must not start with "-" (argv flag smuggling is not allowed)';
  }
  if (hasControlCharacter(value)) {
    return "must not contain control characters";
  }
  return undefined;
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if ((value.codePointAt(i) ?? 0) < 0x20) {
      return true;
    }
  }
  return false;
}

/**
 * Non-throwing predicate form of {@link assertSafeCliArg}, for use in a Zod
 * `.refine(...)` so a `-`-prefixed / control-char value is rejected at the tool's
 * schema boundary before the handler ever shells out.
 */
export function isSafeCliArg(value: unknown): value is string {
  return cliArgProblem(value) === undefined;
}

// ---------------------------------------------------------------------------
// aws
// ---------------------------------------------------------------------------

/**
 * The prefixes with which the AWS CLI REPLACES a parameter's value by what it reads from
 * somewhere else. Matched here case-insensitively and after leading whitespace, though the CLI
 * matches them exactly: refusing a value the CLI would have taken as written costs nothing.
 *
 * `file://` and `fileb://` read a local file — for nearly every parameter, not only the ones
 * documented as taking a document; the CLI exempts a short list whose value is itself a URL — and
 * v1 of the CLI fetches an `http://` or `https://` value too, unless `cli_follow_urlparam` is
 * turned off. The CLI then sends what it read to AWS as the value, and an
 * error can quote it back — AWS's own validation errors name the value they reject — so a tool
 * argument of `file://<path>` could hand the model the contents of a file on the user's machine.
 */
export const AWS_CLI_LOADING_PREFIXES = ["file://", "fileb://", "http://", "https://"] as const;

function awsPrefixProblem(value: string): string | undefined {
  const head = value.trimStart().toLowerCase();
  const prefix = AWS_CLI_LOADING_PREFIXES.find((p) => head.startsWith(p));
  return prefix === undefined
    ? undefined
    : `must not start with "${prefix}" (the aws CLI would read the value from that location)`;
}

/**
 * `@=` is the AWS CLI v2 shorthand-syntax operator that loads a file into one key of a structure
 * parameter, as in `TemplateBody@=file://<path>`. No tool passes a structure parameter today, so
 * this is refused for the next tool that does rather than for any value that reaches the CLI now.
 */
function awsShorthandProblem(value: string): string | undefined {
  return value.includes("@=")
    ? 'must not contain "@=" (aws shorthand syntax would read a file into the value)'
    : undefined;
}

/**
 * Why `value` must not be passed to the AWS CLI as one argument, or `undefined` when it may: the
 * universal rule, then a loading prefix ({@link AWS_CLI_LOADING_PREFIXES}), then `@=`.
 */
export function awsCliArgProblem(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return cliArgProblem(value);
  }
  return cliArgProblem(value) ?? awsPrefixProblem(value) ?? awsShorthandProblem(value);
}

// ---------------------------------------------------------------------------
// az
// ---------------------------------------------------------------------------

function azFileProblem(value: string): string | undefined {
  if (value.startsWith("@")) {
    return 'must not start with "@" (az would read the value from a file)';
  }
  if (value.includes("=@")) {
    return 'must not contain "=@" (az would read what follows from a file)';
  }
  return undefined;
}

/**
 * Why `value` must not be passed to the Azure CLI as one argument, or `undefined` when it may: the
 * universal rule, then a leading `@`, then `=@`.
 *
 * Before it parses anything, `az` replaces every argument that starts with `@` by the contents of
 * the file named after it — with `~` expanded, and `@-` read from stdin — and does the same to
 * whatever follows the first `=` in an argument. A resource group of
 * `@~/.azure/msal_token_cache.json` would be sent to Azure as that cache, which a "could not be
 * found" error can quote back. An `@` anywhere else, as in an email address, is left alone by `az`
 * and is accepted here.
 */
export function azCliArgProblem(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return cliArgProblem(value);
  }
  return cliArgProblem(value) ?? azFileProblem(value);
}
