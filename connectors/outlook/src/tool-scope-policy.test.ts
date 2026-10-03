import { afterEach, describe, expect, test } from "bun:test";

import {
  outlookToolAllowed,
  outlookToolShouldRegister,
  parseMicrosoftOAuthScopesFromEnv,
} from "./tool-scope-policy.ts";

describe("outlookToolAllowed", () => {
  test("Calendars.Read enables calendar read tools only", () => {
    const g = ["Calendars.Read"];
    expect(outlookToolAllowed("outlook_calendar_list", g)).toBe(true);
    expect(outlookToolAllowed("outlook_calendar_get", g)).toBe(true);
    expect(outlookToolAllowed("outlook_mail_folders", g)).toBe(false);
    expect(outlookToolAllowed("outlook_mail_send", g)).toBe(false);
    expect(outlookToolAllowed("outlook_calendar_create", g)).toBe(false);
    expect(outlookToolAllowed("outlook_contact_list", g)).toBe(false);
  });

  test("Calendars.ReadWrite implies calendar read", () => {
    expect(outlookToolAllowed("outlook_calendar_list", ["Calendars.ReadWrite"])).toBe(true);
    expect(outlookToolAllowed("outlook_calendar_create", ["Calendars.ReadWrite"])).toBe(true);
  });

  test("Mail.ReadWrite satisfies Mail.Read requirement", () => {
    expect(outlookToolAllowed("outlook_mail_list", ["Mail.ReadWrite"])).toBe(true);
  });

  test("Mail.ReadWrite does not imply Mail.Send", () => {
    expect(outlookToolAllowed("outlook_mail_send", ["Mail.ReadWrite"])).toBe(false);
  });

  test("a tool with no declared minimum scope is allowed whatever was granted", () => {
    expect(outlookToolAllowed("outlook_future_tool", [])).toBe(true);
  });
});

describe("outlookToolShouldRegister", () => {
  test("undefined granted list registers all tools", () => {
    expect(outlookToolShouldRegister("outlook_mail_folders", undefined)).toBe(true);
  });

  test("a declared granted list is checked against the tool's minimum scopes", () => {
    expect(outlookToolShouldRegister("outlook_mail_folders", ["Calendars.Read"])).toBe(false);
    expect(outlookToolShouldRegister("outlook_calendar_get", ["Calendars.Read"])).toBe(true);
  });
});

describe("parseMicrosoftOAuthScopesFromEnv", () => {
  const prev = process.env["MICROSOFT_OAUTH_SCOPES"];

  afterEach(() => {
    if (prev === undefined) {
      delete process.env["MICROSOFT_OAUTH_SCOPES"];
    } else {
      process.env["MICROSOFT_OAUTH_SCOPES"] = prev;
    }
  });

  test("parses space-separated scopes", () => {
    process.env["MICROSOFT_OAUTH_SCOPES"] = "Calendars.Read offline_access";
    expect(parseMicrosoftOAuthScopesFromEnv()).toEqual(["Calendars.Read", "offline_access"]);
  });

  test("missing env returns undefined", () => {
    delete process.env["MICROSOFT_OAUTH_SCOPES"];
    expect(parseMicrosoftOAuthScopesFromEnv()).toBeUndefined();
  });

  test("empty string returns undefined", () => {
    process.env["MICROSOFT_OAUTH_SCOPES"] = "  ";
    expect(parseMicrosoftOAuthScopesFromEnv()).toBeUndefined();
  });
});
