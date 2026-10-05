import { describe, expect, test } from "bun:test";
import {
  AWS_CLI_LOADING_PREFIXES,
  assertSafeCliArg,
  awsCliArgProblem,
  awsCliDocumentProblem,
  azCliArgProblem,
  cliArgProblem,
  isSafeCliArg,
} from "./safe-cli-arg.ts";

const NUL = String.fromCharCode(0);
const UNIT_SEP = String.fromCharCode(0x1f); // the last control character
const LF = String.fromCharCode(0x0a);
const TAB = String.fromCharCode(0x09);
const CR = String.fromCharCode(0x0d);

/**
 * This is a security control, not a formatter: it is the universal guard against
 * "argv flag smuggling", where a tool-supplied value beginning with `-` is
 * parsed by a spawned CLI as a FLAG rather than as a positional. Spawns use an
 * argv array, so there is no shell to inject into — the flag itself is the
 * injection.
 *
 * Every REJECT arm therefore needs cover. Before this file the module sat at
 * 62.5% line coverage with no test of its own: the accept path was exercised
 * incidentally by connectors that call it inline, and the arms that actually
 * stop an attack were exercised by nothing.
 */
describe("assertSafeCliArg — accepts", () => {
  test("returns the value unchanged so it can be used inline", () => {
    expect(assertSafeCliArg("my-sink-1")).toBe("my-sink-1");
  });

  test("allows the per-service charsets the docblock names", () => {
    // sink ids, CloudWatch log-group names (slashes), BigQuery refs (dots)
    expect(assertSafeCliArg("a_b.c-d")).toBe("a_b.c-d");
    expect(assertSafeCliArg("/aws/lambda/my-fn")).toBe("/aws/lambda/my-fn");
    expect(assertSafeCliArg("project.dataset.table")).toBe("project.dataset.table");
  });

  test("allows a hyphen anywhere except the first character", () => {
    expect(assertSafeCliArg("not-a-flag")).toBe("not-a-flag");
  });

  test("allows exactly 1024 characters — the boundary is inclusive", () => {
    const at = "a".repeat(1024);
    expect(assertSafeCliArg(at)).toBe(at);
  });

  /**
   * The boundary is `< 0x20`, so SPACE (0x20) is deliberately allowed. Pinned
   * because it reads like an oversight and is not: a spawn passes argv entries
   * verbatim with no word-splitting, so an embedded space is inert, while
   * rejecting it would break services whose resource names permit spaces.
   */
  test("allows space, which is 0x20 and therefore not a control character", () => {
    expect(assertSafeCliArg("my resource")).toBe("my resource");
  });
});

describe("assertSafeCliArg — rejects", () => {
  test("an empty string", () => {
    expect(() => assertSafeCliArg("")).toThrow(/must be a non-empty string/);
  });

  test("a non-string, even though the type says otherwise", () => {
    // The runtime guard exists because tool input crosses a JSON boundary where
    // the declared type is not enforced.
    expect(() => assertSafeCliArg(undefined as unknown as string)).toThrow(
      /must be a non-empty string/,
    );
    expect(() => assertSafeCliArg(42 as unknown as string)).toThrow(/must be a non-empty string/);
  });

  test("a value over 1024 characters", () => {
    expect(() => assertSafeCliArg("a".repeat(1025))).toThrow(/exceeds 1024 characters/);
  });

  // The arm this module exists for.
  test("a value starting with a dash — the flag-smuggling case", () => {
    expect(() => assertSafeCliArg("--project=attacker")).toThrow(/argv flag smuggling/);
    expect(() => assertSafeCliArg("-h")).toThrow(/argv flag smuggling/);
    expect(() => assertSafeCliArg("-")).toThrow(/argv flag smuggling/);
  });

  test("control characters, wherever they sit in the value", () => {
    expect(() => assertSafeCliArg(`${NUL}abc`)).toThrow(/control characters/);
    expect(() => assertSafeCliArg(`ab${LF}cd`)).toThrow(/control characters/);
    expect(() => assertSafeCliArg(`ab${TAB}cd`)).toThrow(/control characters/);
    expect(() => assertSafeCliArg(`trailing${CR}`)).toThrow(/control characters/);
    expect(() => assertSafeCliArg(`x${UNIT_SEP}`)).toThrow(/control characters/);
  });

  test("names the caller's label in the message, so the failure is attributable", () => {
    expect(() => assertSafeCliArg("-x", "sinkName")).toThrow(/Invalid sinkName/);
  });
});

describe("isSafeCliArg — the non-throwing predicate form", () => {
  test("is true for a safe value", () => {
    expect(isSafeCliArg("my-sink-1")).toBe(true);
  });

  test("is false for every reject arm, rather than throwing", () => {
    for (const bad of ["", "-h", "--flag", `a${NUL}b`, "a".repeat(1025)]) {
      expect(isSafeCliArg(bad)).toBe(false);
    }
  });

  test("is false for non-strings, which is what makes it usable in .refine()", () => {
    for (const bad of [undefined, null, 42, {}, []]) {
      expect(isSafeCliArg(bad)).toBe(false);
    }
  });

  /**
   * The two must never disagree: `isSafeCliArg` is the schema-boundary form of
   * the same rule, so a value the predicate waves through must also survive the
   * assertion the handler later makes.
   */
  test("agrees with assertSafeCliArg on every case", () => {
    const cases = [
      "ok",
      "a.b-c",
      "my resource",
      "",
      "-x",
      `a${LF}b`,
      "a".repeat(1025),
      "a".repeat(1024),
    ];
    for (const v of cases) {
      let asserted = true;
      try {
        assertSafeCliArg(v);
      } catch {
        asserted = false;
      }
      expect(isSafeCliArg(v)).toBe(asserted);
    }
  });
});

describe("cliArgProblem — the reason behind both forms", () => {
  test("is exactly what assertSafeCliArg throws, after its label", () => {
    for (const v of ["", "-x", `a${LF}b`, "a".repeat(1025)]) {
      expect(() => assertSafeCliArg(v, "name")).toThrow(`Invalid name: ${cliArgProblem(v)}`);
    }
  });

  test("is undefined for a value both forms accept", () => {
    expect(cliArgProblem("my-sink-1")).toBeUndefined();
  });
});

/**
 * The AWS CLI does not take every argument as written: it REPLACES a value that starts with
 * `file://` or `fileb://` by that local file's contents, and v1 does the same for an `http(s)://`
 * URL, before sending it to AWS. An error naming the value it rejects can then quote it back — to
 * a model, in this package — so a tool argument could read any file the user can.
 */
describe("awsCliArgProblem", () => {
  test("accepts what aws resource values look like", () => {
    for (const v of [
      "my-cluster",
      "arn:aws:lambda:us-east-1:123456789012:function:fn",
      "api:7",
      "i-1 i-2",
      "/aws/lambda/my-fn",
      "user@example.com",
      "files://not-a-prefix",
      "my-file://suffix",
    ]) {
      expect({ v, problem: awsCliArgProblem(v) }).toEqual({ v, problem: undefined });
    }
  });

  test("refuses every loading prefix, in any case and after leading whitespace", () => {
    for (const prefix of AWS_CLI_LOADING_PREFIXES) {
      const expected = `must not start with "${prefix}" (the aws CLI would read the value from that location)`;
      expect(awsCliArgProblem(`${prefix}x`)).toBe(expected);
      expect(awsCliArgProblem(`${prefix.toUpperCase()}x`)).toBe(expected);
      expect(awsCliArgProblem(`  ${prefix}x`)).toBe(expected);
    }
    expect(AWS_CLI_LOADING_PREFIXES).toEqual(["file://", "fileb://", "http://", "https://"]);
  });

  test("refuses the shorthand file-load operator @= anywhere", () => {
    for (const v of ["Body@=file:///etc/hosts", "Key=a,Body@=x"]) {
      expect(awsCliArgProblem(v)).toBe(
        'must not contain "@=" (aws shorthand syntax would read a file into the value)',
      );
    }
  });

  test("applies the universal rule first", () => {
    expect(awsCliArgProblem("-x")).toBe(cliArgProblem("-x"));
    expect(awsCliArgProblem(`file://a${LF}b`)).toBe("must not contain control characters");
    expect(awsCliArgProblem(42)).toBe("must be a non-empty string");
    expect(awsCliArgProblem("")).toBe("must be a non-empty string");
  });
});

describe("awsCliDocumentProblem — a template body, not a name", () => {
  test("accepts a document that spans lines and runs past 1024 characters", () => {
    const doc = `Resources:${LF}  Bucket:${LF}    Type: AWS::S3::Bucket${LF}# ${"x".repeat(2000)}`;
    expect(awsCliDocumentProblem(doc)).toBeUndefined();
    expect(awsCliDocumentProblem('{"Resources":{}}')).toBeUndefined();
    // Shorthand syntax applies to structure parameters, and a template body is a string.
    expect(awsCliDocumentProblem("Description: a@=b")).toBeUndefined();
  });

  test("refuses a leading dash and a loading prefix", () => {
    expect(awsCliDocumentProblem("---")).toBe(cliArgProblem("-x"));
    expect(awsCliDocumentProblem("file:///etc/passwd")).toBe(awsCliArgProblem("file:///x"));
    expect(awsCliDocumentProblem(" https://example.invalid/t.yaml")).toBe(
      awsCliArgProblem("https://x"),
    );
  });

  test("refuses an empty or non-string value", () => {
    expect(awsCliDocumentProblem("")).toBe("must be a non-empty string");
    expect(awsCliDocumentProblem(undefined)).toBe("must be a non-empty string");
  });
});

/**
 * `az` replaces an argument that starts with `@` by the contents of the file named after it — `~`
 * expanded, `@-` read from stdin — and does the same to what follows the first `=` of an argument.
 */
describe("azCliArgProblem", () => {
  test("accepts what azure resource values look like, an @ in the middle included", () => {
    for (const v of [
      "rg-1",
      "my_app",
      "00000000-0000-4000-8000-000000000000",
      "user@example.com",
    ]) {
      expect({ v, problem: azCliArgProblem(v) }).toEqual({ v, problem: undefined });
    }
    // `@=` is the aws operator, not az's: no = comes before the @.
    expect(azCliArgProblem("a@=b")).toBeUndefined();
    expect(azCliArgProblem("a=b")).toBeUndefined();
  });

  test("refuses a leading @, the stdin form included", () => {
    for (const v of ["@/etc/hosts", "@~/.azure/msal_token_cache.json", "@-"]) {
      expect(azCliArgProblem(v)).toBe(
        'must not start with "@" (az would read the value from a file)',
      );
    }
  });

  test("refuses =@, after the first = or a later one, and at the very start", () => {
    // az splits an argument at its first =, so a value that starts with =@ is = followed by the
    // file's contents, and =@- by stdin's.
    for (const v of ["name=@/etc/hosts", "a=b=@c", "=@/etc/hosts", "=@-"]) {
      expect(azCliArgProblem(v)).toBe(
        'must not contain "=@" (az would read what follows from a file)',
      );
    }
  });

  test("applies the universal rule first", () => {
    expect(azCliArgProblem("-x")).toBe(cliArgProblem("-x"));
    expect(azCliArgProblem(`@a${LF}`)).toBe("must not contain control characters");
    expect(azCliArgProblem(null)).toBe("must be a non-empty string");
  });
});
