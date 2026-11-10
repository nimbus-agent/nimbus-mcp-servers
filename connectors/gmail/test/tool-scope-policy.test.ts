import { describe, expect, it } from "bun:test";
import { withEnv } from "../../../scripts/connector-tool-harness.ts";
import {
  gmailToolShouldRegister,
  parseGoogleOAuthScopesFromEnv,
} from "../src/tool-scope-policy.ts";

const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const COMPOSE = "https://www.googleapis.com/auth/gmail.compose";
const MODIFY = "https://www.googleapis.com/auth/gmail.modify";
const FULL = "https://mail.google.com/";

describe("gmail tool scope policy", () => {
  it("hides the archive when the scopes are unknown (fail closed), and keeps every other tool", () => {
    expect(gmailToolShouldRegister("gmail_thread_archive", undefined)).toBe(false);
    for (const id of ["gmail_message_list", "gmail_thread_read", "gmail_draft_create"]) {
      expect(gmailToolShouldRegister(id, undefined)).toBe(true);
    }
  });

  it("hides the archive for the default read + compose grant", () => {
    expect(gmailToolShouldRegister("gmail_thread_archive", [READONLY, COMPOSE])).toBe(false);
  });

  it("lists the archive with gmail.modify, or with the full-mailbox scope alone", () => {
    expect(gmailToolShouldRegister("gmail_thread_archive", [READONLY, COMPOSE, MODIFY])).toBe(true);
    expect(gmailToolShouldRegister("gmail_thread_archive", [FULL])).toBe(true);
  });

  it("does not accept the short form, which is not a token scope Google returns", () => {
    expect(gmailToolShouldRegister("gmail_thread_archive", ["gmail.modify"])).toBe(false);
  });

  it("parses GOOGLE_OAUTH_SCOPES on whitespace; unset or blank is unknown", async () => {
    await withEnv({ GOOGLE_OAUTH_SCOPES: ` ${READONLY}  ${MODIFY}\n` }, () => {
      expect(parseGoogleOAuthScopesFromEnv()).toEqual([READONLY, MODIFY]);
    });
    await withEnv({ GOOGLE_OAUTH_SCOPES: "   " }, () => {
      expect(parseGoogleOAuthScopesFromEnv()).toBeUndefined();
    });
    await withEnv({ GOOGLE_OAUTH_SCOPES: undefined }, () => {
      expect(parseGoogleOAuthScopesFromEnv()).toBeUndefined();
    });
  });
});
