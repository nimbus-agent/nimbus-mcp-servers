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
 * An address is the part inside `<...>` when a display name is given, else the entry itself.
 * A non-blank field in which no address can be found is returned as written, so it is refused
 * unless the operator scoped that exact text: a field that is not understood is never dropped.
 */

const IN_ANGLES = /<([^<>\s]+@[^<>\s]+)>/g;
const BARE = /[^\s<>,;:"()]+@[^\s<>,;:"()]+/g;

/** The addresses one header-style list names, in order. */
function addressesIn(field: string): string[] {
  // Display names may hold commas ("Lovelace, Ada" <ada@x>), so angle-bracketed addresses are
  // taken first, then any bare address left once they and the quoted names are removed.
  const angled = [...field.matchAll(IN_ANGLES)].map((m) => m[1] ?? "");
  const rest = field.replace(IN_ANGLES, " ").replace(/"[^"]*"/g, " ");
  const bare = rest.match(BARE) ?? [];
  return [...angled, ...bare].filter((a) => a !== "");
}

export function recipientScopeTargets(args: {
  readonly to: string;
  readonly cc?: string | undefined;
  readonly bcc?: string | undefined;
}): Array<{ kind: string; value: string }> {
  const seen = new Set<string>();
  for (const field of [args.to, args.cc, args.bcc]) {
    if (field === undefined || field.trim() === "") continue;
    const found = addressesIn(field);
    for (const value of found.length > 0 ? found : [field.trim()]) seen.add(value);
  }
  return [...seen].map((value) => ({ kind: "recipient", value }));
}
