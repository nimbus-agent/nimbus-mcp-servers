import { describe, expect, it } from "bun:test";
import { withEnv } from "../../../scripts/connector-tool-harness.ts";
import { calendarWritesAllowed, parseGoogleOAuthScopesFromEnv } from "../src/tool-scope-policy.ts";

const READONLY = "https://www.googleapis.com/auth/calendar.readonly";
const FULL = "https://www.googleapis.com/auth/calendar";
const EVENTS = "https://www.googleapis.com/auth/calendar.events";
const EVENTS_READONLY = "https://www.googleapis.com/auth/calendar.events.readonly";

describe("google calendar tool scope policy", () => {
  it("hides the writes when the scopes are unknown (fail closed)", () => {
    expect(calendarWritesAllowed(undefined)).toBe(false);
  });

  it("hides the writes for a read-only grant", () => {
    expect(calendarWritesAllowed([READONLY])).toBe(false);
    expect(calendarWritesAllowed([READONLY, EVENTS_READONLY])).toBe(false);
  });

  it("lists the writes for the full calendar scope, or for calendar.events", () => {
    expect(calendarWritesAllowed([READONLY, FULL])).toBe(true);
    expect(calendarWritesAllowed([EVENTS])).toBe(true);
  });

  it("does not accept a short form, which is not a token scope Google returns", () => {
    expect(calendarWritesAllowed(["calendar"])).toBe(false);
    expect(calendarWritesAllowed([`${FULL}.readonly.extra`])).toBe(false);
  });

  it("parses GOOGLE_OAUTH_SCOPES on whitespace; unset or blank is unknown", async () => {
    await withEnv({ GOOGLE_OAUTH_SCOPES: ` ${READONLY}  ${FULL}\n` }, () => {
      expect(parseGoogleOAuthScopesFromEnv()).toEqual([READONLY, FULL]);
    });
    await withEnv({ GOOGLE_OAUTH_SCOPES: "   " }, () => {
      expect(parseGoogleOAuthScopesFromEnv()).toBeUndefined();
    });
    await withEnv({ GOOGLE_OAUTH_SCOPES: undefined }, () => {
      expect(parseGoogleOAuthScopesFromEnv()).toBeUndefined();
    });
  });
});
