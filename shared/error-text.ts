/**
 * The text of a tool's error, made safe to send to the client.
 *
 * A standalone connector passes a tool's thrown message on to the client (see
 * `shared/layer-server.ts`): it is the tool's diagnostic, and for a write it can be the only word
 * that the write ran. But much of that text is not the connector's own. A kit that fails on an
 * HTTP status quotes the start of the reply body, a CLI's stderr is quoted when it exits non-zero,
 * and a library's error names the URL or file it failed on. Any of those can carry what the client
 * must not get: a credential an upstream service echoed back, or a path under the user's home or
 * temporary directory.
 *
 * This removes those and nothing else, so the diagnostic survives:
 *   - the exact value of every credential variable in the process environment (by name: a TOKEN,
 *     SECRET, PASSWORD, KEY, PAT, CREDENTIAL, COOKIE, SESSION, DSN or CONNECTION_STRING);
 *   - credential SHAPES with no variable to match: an `Authorization` value, a secret query
 *     parameter, URL userinfo, a secret member of an echoed JSON body, a PEM private key, and the
 *     published token prefixes of the vendors these connectors talk to;
 *   - the home and temporary directories, which become `~` and `<tmp>`.
 *
 * It is a backstop, not a licence: a kit should still not put a credential into an error, and
 * value redaction cannot catch a credential the process derived (an exchanged access token) that
 * has none of the shapes above.
 */
import { homedir, tmpdir } from "node:os";

export const REDACTED = "[redacted]";

/** Shorter than this, a value is not a credential and redacting it would shred ordinary text. */
const MIN_SECRET_LENGTH = 8;

/** A variable whose value is a credential, by the names connectors give them. */
const CREDENTIAL_NAME =
  /TOKEN|SECRET|PASSWORD|PASSWD|(?:^|_)PASS$|API_?KEY|(?:^|_)KEY$|PRIVATE|CREDENTIAL|(?:^|_)PAT$|COOKIE|SESSION|(?:^|_)DSN$|CONNECTION_STRING/i;

/**
 * A word that looks like a credential, not prose: it has a digit or one of `+ / = . _ -`, or a
 * capital after a lower-case letter. "authentication" has neither; base64 and JWTs have one.
 */
const CREDENTIAL_WORD = String.raw`(?=[^\s"']*(?:[0-9+/=._-]|[a-z][^\s"']*[A-Z]))[A-Za-z0-9+/=._~-]{8,}`;

const SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  // A PEM private key, whole.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  // An Authorization header's value. Case-sensitive on purpose: under `i`, the capital in
  // CREDENTIAL_WORD's prose test would match any letter, and "token required" would go.
  [
    new RegExp(String.raw`\b([Bb]earer|[Bb]asic|[Tt]oken)\s+${CREDENTIAL_WORD}`, "g"),
    `$1 ${REDACTED}`,
  ],
  // A secret member of a JSON body a kit quoted, by any key that names one: `client_secret`,
  // `refresh_token`, Tableau's `personalAccessTokenSecret`.
  [
    /("[A-Za-z0-9_-]*(?:secret|password|passwd|token|api_?key|private_?key|assertion)[A-Za-z0-9_-]*"\s*:\s*")(?:[^"\\]|\\.)*"/gi,
    `$1${REDACTED}"`,
  ],
  // A secret query parameter, or the same pair later in a form body.
  [
    /([?&;](?:access_token|refresh_token|id_token|token|api_?key|apikey|key|client_secret|client_assertion|secret|password|passwd|pwd|signature|sig|code|x-amz-signature|x-amz-credential|x-amz-security-token)=)[^&#\s"'<>]+/gi,
    `$1${REDACTED}`,
  ],
  // The first pair of a form body an OAuth token endpoint echoed. Narrower than the query list:
  // after a space, "exit code=2" is a diagnostic, not an authorization code.
  [
    /((?:^|\s)(?:access_token|refresh_token|id_token|client_secret|client_assertion|password|passwd|api_?key|apikey|secret|token)=)[^&#\s"'<>]+/gi,
    `$1${REDACTED}`,
  ],
  // URL userinfo: scheme://user:password@host.
  [/([a-z][a-z0-9+.-]*:\/\/)[^/\s@:]+:[^/\s@]*@/gi, `$1${REDACTED}@`],
  // Published token prefixes: GitHub, GitLab, Slack, Stripe, AWS access key ids, and JWTs.
  [
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|[sr]k_(?:live|test)_[A-Za-z0-9]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g,
    REDACTED,
  ],
];

export interface ScrubContext {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
  readonly tmp?: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * A pattern for path `dir` as it appears in text, alone or at the start of a longer path: either
 * slash direction between its parts, any case on Windows (a drive letter), and not as the prefix
 * of a longer name (`/home/avery` is not inside `/home/averyl`). With `file`, a following `.` is
 * still a boundary, so a configured `audit.jsonl` is found in `audit.jsonl.lock`.
 */
function pathPattern(dir: string, file = false): RegExp | undefined {
  const parts = dir.split(/[\\/]+/).filter((p) => p !== "");
  // The filesystem root is never one to hide: "/" would match every absolute path.
  if (parts.length === 0) return undefined;
  const leading = /^[\\/]/.test(dir) ? String.raw`[\\/]` : "";
  const body = parts.map(escapeRegExp).join(String.raw`[\\/]+`);
  const windows = /^[A-Za-z]:/.test(dir);
  // What may follow the path: a separator, whitespace, a quote (\x60 is the backtick), or closing
  // punctuation.
  const after = String.raw`[\\/\s'"\x60:;,)\]>${file ? "." : ""}]`;
  return new RegExp(`${leading}${body}(?=$|${after})`, windows ? "gi" : "g");
}

/**
 * A variable that names a location on this machine: `*_PATH(S)`, `*_DIR(S)`, `*_FILE`, `*_ROOT(S)`,
 * `*_LOG`, each optionally `_JSON`, and `KUBECONFIG`. `PATH` itself is a search list, not a
 * location anything is read from, and stays out.
 */
const PATH_NAME = /(?:^|_)(?:PATHS?|DIRS?|FILE|ROOTS?|LOG)(?:_JSON)?$|^KUBECONFIG$/i;

const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/])/;

/** The absolute paths one variable's value holds: one path, a JSON array, or a `;`/`:` list. */
function pathsIn(value: string): string[] {
  let pieces: string[];
  if (value.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(value);
      pieces = Array.isArray(parsed)
        ? parsed.filter((p): p is string => typeof p === "string")
        : [];
    } catch {
      pieces = [];
    }
  } else {
    // `;` on Windows, `:` elsewhere; a drive letter's colon is not a separator.
    pieces = value.split(";").flatMap((p) => (/^[A-Za-z]:[\\/]/.test(p) ? [p] : p.split(":")));
  }
  return pieces.map((p) => p.trim()).filter((p) => ABSOLUTE.test(p));
}

/** Each configured absolute path with the variable that names it, longest first. */
function configuredPaths(
  env: Readonly<Record<string, string | undefined>>,
): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  for (const [name, raw] of Object.entries(env)) {
    if (/^path$/i.test(name) || !PATH_NAME.test(name)) continue;
    for (const path of pathsIn(raw ?? "")) out.push([path, name]);
  }
  return out.sort((a, b) => b[0].length - a[0].length);
}

/** The credential values to redact, longest first so one that contains another goes whole. */
function credentialValues(env: Readonly<Record<string, string | undefined>>): string[] {
  const values = new Set<string>();
  for (const [name, raw] of Object.entries(env)) {
    if (!CREDENTIAL_NAME.test(name)) continue;
    const value = (raw ?? "").trim();
    if (value.length >= MIN_SECRET_LENGTH) values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/** `message` with every credential and local directory it names replaced. See the file comment. */
export function scrubErrorText(message: string, context: ScrubContext = {}): string {
  const env = context.env ?? process.env;
  let out = message;
  for (const value of credentialValues(env)) out = out.split(value).join(REDACTED);
  for (const [pattern, replacement] of SHAPES) out = out.replace(pattern, replacement);
  // A configured location says most by its variable's name, so it goes before the directories.
  for (const [path, name] of configuredPaths(env)) {
    const pattern = pathPattern(path, true);
    // A function replacement: a `$` in the name must not be read as a group reference.
    if (pattern !== undefined) out = out.replace(pattern, () => `$${name}`);
  }
  // Temp next: on Windows it sits inside home, and "<tmp>" says more than "~\AppData\…".
  const tmp = pathPattern(context.tmp ?? tmpdir());
  if (tmp !== undefined) out = out.replace(tmp, "<tmp>");
  const home = pathPattern(context.home ?? homedir());
  if (home !== undefined) out = out.replace(home, "~");
  return out;
}
