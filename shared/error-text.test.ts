import { describe, expect, test } from "bun:test";

import { scrubErrorText } from "./error-text.ts";

const HOME = "C:\\Users\\avery";
const TMP = "C:\\Users\\avery\\AppData\\Local\\Temp";
const scrub = (message: string, env: Record<string, string | undefined> = {}): string =>
  scrubErrorText(message, { env, home: HOME, tmp: TMP });

describe("scrubErrorText", () => {
  test("an ordinary diagnostic passes through unchanged", () => {
    expect(scrub("GitHub 404: Not Found")).toBe("GitHub 404: Not Found");
    expect(scrub("pull request 12 is not open")).toBe("pull request 12 is not open");
  });

  test("the value of a credential variable is redacted wherever it appears", () => {
    const env = { GITHUB_TOKEN: "s3cr3t-value-0123456789", GITHUB_OWNER: "acme-corp-owner" };
    expect(
      scrub("Bad credentials for s3cr3t-value-0123456789 (again s3cr3t-value-0123456789)", env),
    ).toBe("Bad credentials for [redacted] (again [redacted])");
    // A variable whose name is not a credential's keeps its value: it is a diagnostic. A base URL
    // is one of those; a URL that carries a credential does so in its userinfo, redacted below.
    expect(scrub("no repo under acme-corp-owner", env)).toBe("no repo under acme-corp-owner");
    const api = { GITHUB_API_URL: "https://api.github.example" };
    expect(scrub("GET https://api.github.example/repos 502", api)).toBe(
      "GET https://api.github.example/repos 502",
    );
  });

  test("prose around the words Bearer and Basic is not mistaken for a credential", () => {
    expect(scrub("Bearer token required")).toBe("Bearer token required");
    expect(scrub("Basic authentication is disabled")).toBe("Basic authentication is disabled");
  });

  test("a PEM private key is redacted whole", () => {
    expect(
      scrub("bad key -----BEGIN PRIVATE KEY-----\nMIIEvQ\nabc\n-----END PRIVATE KEY----- end"),
    ).toBe("bad key [redacted] end");
  });

  test("a short or blank credential value is not treated as a pattern", () => {
    // Redacting "abc" or "" would shred ordinary text; a credential that short is not one.
    expect(scrub("abc not found", { API_TOKEN: "abc", OTHER_SECRET: "" })).toBe("abc not found");
  });

  test("credential variable names are recognised by their usual spellings", () => {
    const value = "zz-credential-value-42";
    for (const name of [
      "SLACK_BOT_TOKEN",
      "STRIPE_SECRET_KEY",
      "DATADOG_API_KEY",
      "JIRA_API_TOKEN",
      "SMTP_PASSWORD",
      "IMAP_PASS",
      "AZURE_CLIENT_SECRET",
      "GOOGLE_APPLICATION_CREDENTIALS_JSON",
      "SNOWFLAKE_PRIVATE_KEY",
      "BITBUCKET_APP_PASSWORD",
      "GITLAB_PAT",
      "POSTGRES_DSN",
      "MONGODB_CONNECTION_STRING",
      "SESSION_COOKIE",
    ]) {
      expect(scrub(`echoed ${value}`, { [name]: value })).toBe("echoed [redacted]");
    }
  });

  test("an authorization header value is redacted", () => {
    expect(scrub("sent Authorization: Bearer abc.def.ghi and failed")).toBe(
      "sent Authorization: Bearer [redacted] and failed",
    );
    expect(scrub("Basic dXNlcjpwYXNz rejected")).toBe("Basic [redacted] rejected");
  });

  test("a secret query parameter is redacted, the rest of the URL is kept", () => {
    expect(scrub("GET https://api.example.com/v1/items?api_key=K123456&page=2 failed")).toBe(
      "GET https://api.example.com/v1/items?api_key=[redacted]&page=2 failed",
    );
    expect(scrub("https://h/x?access_token=abc&client_secret=def")).toBe(
      "https://h/x?access_token=[redacted]&client_secret=[redacted]",
    );
  });

  test("URL userinfo is redacted", () => {
    expect(scrub("connect postgres://admin:hunter2@db.internal:5432/app refused")).toBe(
      "connect postgres://[redacted]@db.internal:5432/app refused",
    );
  });

  test("a secret JSON member in an echoed reply body is redacted", () => {
    expect(
      scrub(
        'token endpoint 400: {"error":"invalid_grant","refresh_token":"1//0gabc","client_secret": "xyz"}',
      ),
    ).toBe(
      'token endpoint 400: {"error":"invalid_grant","refresh_token":"[redacted]","client_secret": "[redacted]"}',
    );
  });

  test("well-known token shapes are redacted without any variable to match", () => {
    // Each fake is assembled from its prefix and a body at run time: written whole, it is exactly
    // what GitHub's push protection blocks as a leaked secret.
    for (const [prefix, body] of [
      ["ghp", "_abcdefghijklmnopqrstuvwxyz0123456789"],
      ["github_pat", "_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz"],
      ["glpat", "-abcdefghij0123456789"],
      ["xoxb", "-1234567890-0987654321-abcdefghijklmnop"],
      ["sk_live", "_abcdefghijklmnop0123"],
      ["AKIA", "IOSFODNN7EXAMPLE"],
      [
        "eyJ",
        "hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      ],
    ]) {
      const token = `${prefix ?? ""}${body ?? ""}`;
      expect(scrub(`rejected ${token} here`)).toBe("rejected [redacted] here");
    }
  });

  test("the home and temp directories are replaced, in either slash direction and any case", () => {
    expect(
      scrub("ENOENT: open 'C:\\Users\\avery\\AppData\\Local\\Temp\\nimbus-x1\\kubeconfig'"),
    ).toBe("ENOENT: open '<tmp>\\nimbus-x1\\kubeconfig'");
    expect(scrub("read c:/users/avery/.aws/credentials failed")).toBe(
      "read ~/.aws/credentials failed",
    );
    expect(scrub("at C:\\Users\\avery\\.kube\\config")).toBe("at ~\\.kube\\config");
  });

  test("POSIX home and temp directories are replaced too", () => {
    const posix = (m: string): string =>
      scrubErrorText(m, { env: {}, home: "/home/avery", tmp: "/tmp" });
    expect(posix("open /tmp/nimbus-abc/kubeconfig: denied")).toBe(
      "open <tmp>/nimbus-abc/kubeconfig: denied",
    );
    expect(posix("no such file /home/avery/.config/gcloud")).toBe("no such file ~/.config/gcloud");
    // A path that only starts with the same letters is a different directory.
    expect(posix("/home/averyl/notes")).toBe("/home/averyl/notes");
  });

  test("a configured path is named by its variable, wherever it lives", () => {
    const env = {
      NIMBUS_MCP_AUDIT_LOG: "D:\\logs\\nimbus\\audit.jsonl",
      OBSIDIAN_VAULT_PATHS_JSON: '["E:\\\\Notes\\\\Work","/srv/vault"]',
      KUBECONFIG: "C:\\kube\\a.yaml;C:\\kube\\b.yaml",
      STORYBOOK_DIR: "relative/dir",
    };
    expect(scrub("EACCES: open 'D:\\logs\\nimbus\\audit.jsonl.lock'", env)).toBe(
      "EACCES: open '$NIMBUS_MCP_AUDIT_LOG.lock'",
    );
    expect(scrub("ENOENT: 'e:/notes/work/x.md' and '/srv/vault/y.md'", env)).toBe(
      "ENOENT: '$OBSIDIAN_VAULT_PATHS_JSON/x.md' and '$OBSIDIAN_VAULT_PATHS_JSON/y.md'",
    );
    expect(scrub('error loading config file "C:\\kube\\b.yaml"', env)).toBe(
      'error loading config file "$KUBECONFIG"',
    );
    // A relative value is not a location on this machine, and PATH is a search list.
    expect(scrub("relative/dir missing", { ...env, PATH: "C:\\Windows" })).toBe(
      "relative/dir missing",
    );
    expect(scrub("C:\\Windows\\system32", { PATH: "C:\\Windows" })).toBe("C:\\Windows\\system32");
  });

  test("a secret key of any spelling in a JSON body, and a form body's first pair, are redacted", () => {
    expect(scrub('{"personalAccessTokenSecret":"pat-value","site":"x"}')).toBe(
      '{"personalAccessTokenSecret":"[redacted]","site":"x"}',
    );
    expect(scrub("token 400: client_secret=abc123&grant_type=client_credentials")).toBe(
      "token 400: client_secret=[redacted]&grant_type=client_credentials",
    );
  });

  test("a root or blank home is never used as a pattern", () => {
    expect(scrubErrorText("/usr/lib/x failed", { env: {}, home: "/", tmp: "" })).toBe(
      "/usr/lib/x failed",
    );
  });

  test("defaults read this process's environment and directories", () => {
    expect(scrubErrorText("GitHub 404")).toBe("GitHub 404");
  });
});
