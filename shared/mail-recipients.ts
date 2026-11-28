/**
 * The write-scope targets of an outgoing mail: one `recipient:<address>` per address it is sent
 * to, across `to`, `cc` and `bcc`.
 *
 * Until this existed the scope was checked against `to` as one string. That let a send scoped to
 * one recipient carry any number of others in `cc` or `bcc`, and made a multi-recipient `to`
 * impossible to scope at all (the scope grammar separates terms with commas). With every address
 * checked, `recipient:ada@example.com,recipient:bob@example.com` allows exactly those two,
 * wherever they appear.
 *
 * It FAILS CLOSED, entry by entry. A field is split into entries at each comma outside a quoted
 * string and outside `<...>`. An entry yields its address only when it is exactly one simple
 * address, bare (`ada@example.com`) or after a display name (`Ada <ada@example.com>`,
 * `"Lovelace, Ada" <ada@example.com>`). Any other entry is returned as written, so it is refused
 * unless the operator scoped that exact text. That covers a quoted local part, a group, a second
 * address in the same entry and a `;` separator. A parser that skipped what it could not read
 * would let that entry reach the mail server unchecked, next to an in-scope recipient.
 */

/** A simple addr-spec: no quotes, spaces, brackets or separators anywhere in it. */
const ADDRESS = /^[^\s@<>",;:()[\]\\]+@[^\s@<>",;:()[\]\\]+$/;

/** `Display Name <address>`: an optional name (quoted, or plain words), then ONE `<address>`. */
const NAMED = /^(?:"(?:[^"\\]|\\.)*"|[^"<>@,;]*)\s*<([^<>]*)>$/;

/** `field` cut at each comma that is outside a quoted string and outside `<...>`. */
function entriesOf(field: string): string[] {
  const entries: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  for (let i = 0; i < field.length; i += 1) {
    const c = field[i] ?? "";
    if (quoted && c === "\\") {
      current += c + (field[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (c === '"' && !angled) quoted = !quoted;
    else if (c === "<" && !quoted) angled = true;
    else if (c === ">" && !quoted) angled = false;
    if (c === "," && !quoted && !angled) {
      entries.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  entries.push(current);
  return entries.map((e) => e.trim()).filter((e) => e !== "");
}

/** The one address an entry names, or the entry itself when it is not exactly one. */
function targetOf(entry: string): string {
  if (ADDRESS.test(entry)) return entry;
  const named = NAMED.exec(entry);
  const inner = named?.[1]?.trim();
  return inner !== undefined && ADDRESS.test(inner) ? inner : entry;
}

/**
 * The recipients one field names, exactly as {@link recipientScopeTargets} checks them. A
 * transport that builds its own recipient list (Microsoft Graph's `toRecipients`) builds it from
 * this, so what is delivered is what was checked.
 */
export function mailAddresses(field: string): string[] {
  return entriesOf(field).map(targetOf);
}

export function recipientScopeTargets(args: {
  readonly to: string;
  readonly cc?: string | undefined;
  readonly bcc?: string | undefined;
}): Array<{ kind: string; value: string }> {
  const seen = new Set<string>();
  for (const field of [args.to, args.cc, args.bcc]) {
    if (field === undefined) continue;
    for (const entry of entriesOf(field)) seen.add(targetOf(entry));
  }
  return [...seen].map((value) => ({ kind: "recipient", value }));
}
