/**
 * reply-fields: the argument schema and the reply readers the deploy and mobile-build connectors
 * (bitrise, codemagic, netlify, vercel) had each copied.
 */

import { z } from "zod";

/**
 * An id that goes into a URL path: 1 to 128 letters, digits, `.`, `_` or `-`, and never `.` or `..`
 * (a URL parser collapses those out of the path).
 */
export const pathIdArg = z
  .string()
  .regex(/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/, "letters, digits, '.', '_' and '-' only");

export type Obj = Record<string, unknown>;

/** `v` when it is a plain object, else `{}`, so a missing or malformed member reads as absent. */
export function asObj(v: unknown): Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}

/** `v` when it is a non-empty string, else undefined. */
export function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}
