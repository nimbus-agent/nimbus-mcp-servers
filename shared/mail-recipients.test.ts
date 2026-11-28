import { describe, expect, test } from "bun:test";

import { recipientScopeTargets } from "./mail-recipients.ts";

const values = (args: Parameters<typeof recipientScopeTargets>[0]): string[] =>
  recipientScopeTargets(args).map((t) => {
    expect(t.kind).toBe("recipient");
    return t.value;
  });

describe("recipientScopeTargets", () => {
  test("one recipient is one target, as the whole-`to` check gave", () => {
    expect(values({ to: "ada@example.com" })).toEqual(["ada@example.com"]);
  });

  test("every address in to, cc and bcc is its own target, in order", () => {
    expect(
      values({
        to: "ada@example.com, bob@example.com",
        cc: "cy@example.org",
        bcc: "dee@example.net,  ,eve@example.net",
      }),
    ).toEqual([
      "ada@example.com",
      "bob@example.com",
      "cy@example.org",
      "dee@example.net",
      "eve@example.net",
    ]);
  });

  test("a display name is dropped and the address inside <> is what is checked", () => {
    expect(
      values({ to: '"Lovelace, Ada" <ada@example.com>', cc: "Bob <bob@example.com>" }),
    ).toEqual(["ada@example.com", "bob@example.com"]);
  });

  test("an empty or absent cc and bcc add nothing", () => {
    expect(values({ to: "ada@example.com", cc: "", bcc: undefined })).toEqual(["ada@example.com"]);
  });

  test("a field that names no address is checked as written, so it can only pass if scoped verbatim", () => {
    // Never 'nothing to check': a cc of 'undisclosed-recipients:;' or a bare name must not vanish.
    expect(values({ to: "ada@example.com", cc: "undisclosed-recipients:;" })).toEqual([
      "ada@example.com",
      "undisclosed-recipients:;",
    ]);
  });

  test("an entry the parser cannot read is checked as written, never dropped beside a readable one", () => {
    // A quoted local part is a real address to a mail server; dropping it would let it ride along
    // with an in-scope recipient.
    expect(values({ to: 'ada@example.com, "x"@evil.example' })).toEqual([
      "ada@example.com",
      '"x"@evil.example',
    ]);
    expect(values({ to: "ada@example.com", cc: "bob@example.com; eve@evil.example" })).toEqual([
      "ada@example.com",
      "bob@example.com; eve@evil.example",
    ]);
    expect(values({ to: "ada@example.com eve@evil.example" })).toEqual([
      "ada@example.com eve@evil.example",
    ]);
    expect(values({ to: "Ada <ada@example.com> <eve@evil.example>" })).toEqual([
      "Ada <ada@example.com> <eve@evil.example>",
    ]);
  });

  test("a comma inside a quoted display name or inside <> does not split the entry", () => {
    expect(values({ to: '"Lovelace, Ada" <ada@example.com>, bob@example.com' })).toEqual([
      "ada@example.com",
      "bob@example.com",
    ]);
  });

  test("a repeated address is checked once", () => {
    expect(values({ to: "ada@example.com", cc: "ada@example.com" })).toEqual(["ada@example.com"]);
  });
});
