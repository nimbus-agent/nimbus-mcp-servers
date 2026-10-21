import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkPublish,
  decodeSeed,
  derivePublicKey,
  loadIndex,
  type PublishDeps,
  planPublish,
  publishRegistry,
  type RegistryIndex,
  stageManifest,
  stagePackage,
} from "./publish-registry.ts";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

/** RFC 8032 §7.1, TEST 1. */
const RFC8032_SEED_HEX = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const RFC8032_PUB_HEX = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const SEED_B64 = Buffer.from(RFC8032_SEED_HEX, "hex").toString("base64");
const PUB_B64 = Buffer.from(RFC8032_PUB_HEX, "hex").toString("base64");
/** A second, different seed — all 0x01 bytes. Throwaway test material, not a real key. */
const OTHER_SEED_B64 = Buffer.alloc(32, 1).toString("base64");

const ID = "com.nimbus.readwise";
const PUBLISHER = { id: "nimbus", key: PUB_B64 };

function indexWith(extensions: RegistryIndex["extensions"], sequence = 3): RegistryIndex {
  return { rootKey: derivePublicKey(OTHER_SEED_B64), sequence, extensions };
}

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "publish-registry-test-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("derivePublicKey", () => {
  test("matches RFC 8032 test vector 1", () => {
    expect(derivePublicKey(SEED_B64)).toBe(PUB_B64);
  });

  test("a different seed gives a different key", () => {
    expect(derivePublicKey(OTHER_SEED_B64)).not.toBe(PUB_B64);
  });
});

describe("decodeSeed", () => {
  test("accepts one line of base64 with a trailing newline", () => {
    expect(decodeSeed(`${SEED_B64}\n`).toString("hex")).toBe(RFC8032_SEED_HEX);
  });

  test("refuses anything that is not exactly 32 bytes of base64, without quoting it", () => {
    const secretish = "not-a-key-but-pretend-it-is-secret";
    let message = "";
    try {
      decodeSeed(secretish);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("32-byte");
    expect(message).not.toContain(secretish);
    expect(() => decodeSeed(Buffer.alloc(31).toString("base64"))).toThrow();
    expect(() => decodeSeed("")).toThrow();
  });
});

describe("loadIndex", () => {
  test("a missing index.json fails with the bootstrap instruction, and does not create one", () => {
    expect(() => loadIndex(scratch)).toThrow(/nimbus registry maintain init/);
    expect(existsSync(join(scratch, "index.json"))).toBe(false);
  });

  test("reads an index that exists", () => {
    const index = indexWith({ [ID]: { publisher: PUBLISHER, versions: { "0.1.0": {} } } });
    writeFileSync(join(scratch, "index.json"), JSON.stringify(index));
    expect(loadIndex(scratch).extensions[ID]?.versions).toEqual({ "0.1.0": {} });
  });

  test("refuses an index without an extensions map", () => {
    writeFileSync(join(scratch, "index.json"), JSON.stringify({ format: 1 }));
    expect(() => loadIndex(scratch)).toThrow(/extensions/);
  });
});

describe("planPublish", () => {
  test("a version already in the index is a no-op", () => {
    const index = indexWith({ [ID]: { publisher: PUBLISHER, versions: { "0.2.0": {} } } });
    expect(planPublish(index, ID, "0.2.0", PUBLISHER)).toEqual({
      action: "skip",
      reason: expect.stringContaining("already published"),
    });
  });

  test("a new version of a known extension proceeds", () => {
    const index = indexWith({ [ID]: { publisher: PUBLISHER, versions: { "0.1.0": {} } } });
    expect(planPublish(index, ID, "0.2.0", PUBLISHER).action).toBe("publish");
  });

  test("the first version of an extension proceeds", () => {
    expect(planPublish(indexWith({}), ID, "0.2.0", PUBLISHER).action).toBe("publish");
  });

  test("a publisher key that differs from the index refuses, saying why", () => {
    const index = indexWith({
      [ID]: { publisher: { id: "nimbus", key: derivePublicKey(OTHER_SEED_B64) }, versions: {} },
    });
    const plan = planPublish(index, ID, "0.2.0", PUBLISHER);
    expect(plan.action).toBe("refuse");
    expect(plan.action === "refuse" ? plan.reason : "").toMatch(/publisher key/);
  });

  test("a publisher id that differs from the index refuses", () => {
    const index = indexWith({ [ID]: { publisher: { id: "someone", key: PUB_B64 }, versions: {} } });
    expect(planPublish(index, ID, "0.2.0", PUBLISHER).action).toBe("refuse");
  });
});

describe("stageManifest", () => {
  const repoManifest = { id: ID, version: "0.2.0", entrypoint: "dist/server.js" };

  test("adds the publisher and the `entry` shim equal to `entrypoint`", () => {
    const staged = stageManifest(repoManifest, PUBLISHER);
    expect(staged["publisher"]).toEqual(PUBLISHER);
    expect(staged["entry"]).toBe("dist/server.js");
    expect(staged["entrypoint"]).toBe("dist/server.js");
  });

  test("does not mutate the manifest it was given", () => {
    const before = structuredClone(repoManifest);
    stageManifest(repoManifest, PUBLISHER);
    expect(repoManifest).toEqual(before);
  });

  test("refuses a manifest with no entrypoint, or an `entry` that disagrees with it", () => {
    expect(() => stageManifest({ id: ID, version: "0.2.0" }, PUBLISHER)).toThrow(/entrypoint/);
    expect(() => stageManifest({ ...repoManifest, entry: "dist/index.js" }, PUBLISHER)).toThrow(
      /entry/,
    );
  });
});

/** A connector directory shaped like connectors/readwise, in the scratch dir. */
function fakeConnector(version = "0.2.0"): string {
  const dir = join(scratch, "connector");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "nimbus.extension.json"),
    `${JSON.stringify({ id: ID, version, entrypoint: "dist/server.js", description: "é ✓" }, null, 2)}\n`,
  );
  writeFileSync(join(dir, "README.md"), "# Readwise\n");
  return dir;
}

const fakeBuild = async (outFile: string): Promise<void> => {
  writeFileSync(outFile, "export {};\n");
};

describe("stagePackage", () => {
  test("stages manifest, README and dist; the repo manifest is byte-for-byte untouched", async () => {
    const connector = fakeConnector();
    const repoBytes = readFileSync(join(connector, "nimbus.extension.json"));
    const stage = join(scratch, "stage");
    await stagePackage({
      connectorDir: connector,
      stageDir: stage,
      publisher: PUBLISHER,
      build: fakeBuild,
    });

    expect(readFileSync(join(connector, "nimbus.extension.json")).equals(repoBytes)).toBe(true);
    const staged = JSON.parse(readFileSync(join(stage, "nimbus.extension.json"), "utf8"));
    expect(staged.publisher).toEqual(PUBLISHER);
    expect(staged.entry).toBe("dist/server.js");
    expect(staged.description).toBe("é ✓");
    expect(readdirSync(stage).sort()).toEqual([
      "LICENSE",
      "README.md",
      "dist",
      "nimbus.extension.json",
    ]);
    expect(existsSync(join(stage, "dist", "server.js"))).toBe(true);
  });

  test("a connector without a LICENSE ships the repository's AGPL text", async () => {
    const connector = fakeConnector();
    const stage = join(scratch, "stage");
    await stagePackage({
      connectorDir: connector,
      stageDir: stage,
      publisher: PUBLISHER,
      build: fakeBuild,
    });
    const rootLicense = readFileSync(join(ROOT, "LICENSE"));
    expect(rootLicense.toString("utf8")).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(readFileSync(join(stage, "LICENSE")).equals(rootLicense)).toBe(true);
  });

  test("the real readwise connector has no LICENSE of its own, so it relies on the root one", () => {
    expect(
      readdirSync(join(ROOT, "connectors", "readwise")).filter((n) => /^LICENSE/i.test(n)),
    ).toEqual([]);
  });

  test("a missing licence file fails the staging rather than shipping without one", async () => {
    await expect(
      stagePackage({
        connectorDir: fakeConnector(),
        stageDir: join(scratch, "stage"),
        publisher: PUBLISHER,
        build: fakeBuild,
        licenseFile: join(scratch, "no-such-LICENSE"),
      }),
    ).rejects.toThrow(/licence file/);
  });

  test("copies a LICENSE when the connector has one", async () => {
    const connector = fakeConnector();
    writeFileSync(join(connector, "LICENSE"), "AGPL\n");
    const stage = join(scratch, "stage");
    await stagePackage({
      connectorDir: connector,
      stageDir: stage,
      publisher: PUBLISHER,
      build: fakeBuild,
    });
    expect(readFileSync(join(stage, "LICENSE"), "utf8")).toBe("AGPL\n");
  });

  test("the real readwise manifest still has an entrypoint and no publisher block", () => {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, "connectors", "readwise", "nimbus.extension.json"), "utf8"),
    );
    expect(manifest.id).toBe(ID);
    expect(manifest.entrypoint).toBe("dist/server.js");
    expect(manifest.publisher).toBeUndefined();
  });
});

describe("publishRegistry", () => {
  function setup(index: RegistryIndex | undefined) {
    const registry = join(scratch, "registry");
    mkdirSync(registry);
    if (index !== undefined) {
      writeFileSync(join(registry, "index.json"), JSON.stringify(index));
    }
    const keys = join(scratch, "keys");
    mkdirSync(keys);
    writeFileSync(join(keys, "publisher.key"), `${SEED_B64}\n`);
    writeFileSync(join(keys, "root.key"), `${OTHER_SEED_B64}\n`);
    return {
      registry,
      options: {
        cli: "/opt/nimbus",
        registryDir: registry,
        publisherKeyFile: join(keys, "publisher.key"),
        rootKeyFile: join(keys, "root.key"),
        publisherId: "nimbus",
        connectorDir: fakeConnector(),
      },
    };
  }

  /** A CLI stand-in: records argv, and `maintain add` writes the version into the index. */
  function fakeDeps(registry: string, calls: string[][], stages: string[]): PublishDeps {
    return {
      build: fakeBuild,
      log: () => {},
      run: async (argv) => {
        calls.push(argv);
        if (argv[1] === "extension") {
          stages.push(argv[3] ?? "");
          expect(existsSync(join(argv[3] ?? "", "nimbus.extension.json"))).toBe(true);
        }
        if (argv[1] === "registry") {
          const index = JSON.parse(readFileSync(join(registry, "index.json"), "utf8"));
          index.sequence += 1;
          index.extensions[ID] = { publisher: PUBLISHER, versions: { "0.2.0": {} } };
          writeFileSync(join(registry, "index.json"), JSON.stringify(index));
        }
        return 0;
      },
    };
  }

  test("signs and adds a new version, passing keys only as file paths, then cleans the stage", async () => {
    const { registry, options } = setup(indexWith({}, 7));
    const calls: string[][] = [];
    const stages: string[] = [];
    const result = await publishRegistry(options, fakeDeps(registry, calls, stages));

    expect(result).toEqual({ status: "published", id: ID, version: "0.2.0", sequence: 8 });
    expect(calls).toEqual([
      ["/opt/nimbus", "extension", "sign", stages[0] ?? "", "--key", options.publisherKeyFile],
      [
        "/opt/nimbus",
        "registry",
        "maintain",
        "add",
        registry,
        stages[0] ?? "",
        "--key",
        options.rootKeyFile,
      ],
    ]);
    const argvText = calls.flat().join(" ");
    expect(argvText).not.toContain(SEED_B64);
    expect(argvText).not.toContain(OTHER_SEED_B64);
    expect(existsSync(stages[0] ?? "")).toBe(false);
  });

  test("an already-published version runs nothing", async () => {
    const { registry, options } = setup(
      indexWith({ [ID]: { publisher: PUBLISHER, versions: { "0.2.0": {} } } }),
    );
    const calls: string[][] = [];
    const result = await publishRegistry(options, fakeDeps(registry, calls, []));
    expect(result).toEqual({ status: "skipped", id: ID, version: "0.2.0" });
    expect(calls).toEqual([]);
  });

  test("a publisher-key mismatch refuses before running anything", async () => {
    const { registry, options } = setup(
      indexWith({
        [ID]: { publisher: { id: "nimbus", key: derivePublicKey(OTHER_SEED_B64) }, versions: {} },
      }),
    );
    const calls: string[][] = [];
    await expect(publishRegistry(options, fakeDeps(registry, calls, []))).rejects.toThrow(
      /publisher key/,
    );
    expect(calls).toEqual([]);
  });

  test("a root key that does not match the index refuses before running anything", async () => {
    const { registry, options } = setup({ ...indexWith({}), rootKey: PUB_B64 });
    const calls: string[][] = [];
    await expect(publishRegistry(options, fakeDeps(registry, calls, []))).rejects.toThrow(
      /root key/,
    );
    expect(calls).toEqual([]);
  });

  test("a missing index fails with the bootstrap instruction", async () => {
    const { registry, options } = setup(undefined);
    await expect(publishRegistry(options, fakeDeps(registry, [], []))).rejects.toThrow(
      /nimbus registry maintain init/,
    );
  });

  test("a failing CLI step fails the publish and still cleans the stage", async () => {
    const { registry, options } = setup(indexWith({}));
    const stages: string[] = [];
    const deps: PublishDeps = {
      ...fakeDeps(registry, [], stages),
      run: async (argv) => {
        stages.push(argv[3] ?? "");
        return 2;
      },
    };
    await expect(publishRegistry(options, deps)).rejects.toThrow(/exited 2/);
    expect(stages.length).toBe(1);
    expect(existsSync(stages[0] ?? "")).toBe(false);
  });

  test("an add that does not land the version in the index fails", async () => {
    const { registry, options } = setup(indexWith({}));
    const deps: PublishDeps = { ...fakeDeps(registry, [], []), run: async () => 0 };
    await expect(publishRegistry(options, deps)).rejects.toThrow(/not in index.json/);
  });
});

/** A GitHub Actions expression, `${{ … }}`, as the parsed workflow holds it. */
const gha = (expression: string): string => `\${{ ${expression} }}`;

describe("the registry workflow", () => {
  const workflow = readFileSync(join(ROOT, ".github", "workflows", "registry-publish.yml"), "utf8");
  const release = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");

  test("pins every action by commit SHA", () => {
    const uses = [...workflow.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((m) => m[1] ?? "");
    expect(uses.length).toBeGreaterThan(2);
    expect(uses.filter((u) => !/@[0-9a-f]{40}$/.test(u))).toEqual([]);
  });

  test("verifies the CLI against a pinned literal SHA-256", () => {
    expect(workflow).toMatch(/NIMBUS_CLI_SHA256: "?[0-9a-f]{64}"?/);
    expect(workflow).toContain("sha256sum");
  });

  test("never traces the shell, and never echoes a key", () => {
    expect(workflow).not.toMatch(/set -[a-z]*x/);
    expect(workflow).not.toMatch(/echo[^\n]*(?:ROOT_KEY|PUBLISHER_KEY)/);
  });

  test("release.yml calls it after the npm publish, only when a release was created", () => {
    expect(release).toContain("uses: ./.github/workflows/registry-publish.yml");
    expect(release).toMatch(/publish-registry:[\s\S]*needs: \[release-please, publish\]/);
  });

  test("release.yml runs it only once the owner has set OFFICIAL_REGISTRY_ENABLED", () => {
    const job = release.slice(release.indexOf("  publish-registry:"));
    expect(job).toMatch(
      /if: needs\.release-please\.outputs\.releases_created == 'true' && vars\.OFFICIAL_REGISTRY_ENABLED == 'true'/,
    );
  });

  // Every assertion below reads the PARSED workflow, so a comment that mentions a protection does
  // not count as the protection.
  const parsed = Bun.YAML.parse(workflow) as Workflow;
  const preflight = parsed.jobs["preflight"];
  const publish = parsed.jobs["publish"];
  const preflightSteps = preflight?.steps ?? [];
  const publishSteps = publish?.steps ?? [];
  const stepNamed = (steps: Step[], name: string): Step | undefined =>
    steps.find((s) => s.name === name);
  const indexNamed = (steps: Step[], name: string): number =>
    steps.findIndex((s) => s.name === name);

  test("has exactly the two jobs these assertions are about", () => {
    expect(Object.keys(parsed.jobs).sort()).toEqual(["preflight", "publish"]);
    expect(preflightSteps.length).toBeGreaterThan(3);
    expect(publishSteps.length).toBeGreaterThan(5);
  });

  test("preflight holds no environment and refuses unless OFFICIAL_REGISTRY_ENABLED is 'true'", () => {
    expect(preflight?.environment).toBeUndefined();
    const step = stepNamed(preflightSteps, "Refuse unless the registry is enabled");
    expect(step?.env?.["ENABLED"]).toBe(gha("vars.OFFICIAL_REGISTRY_ENABLED"));
    expect(step?.run).toMatch(/if \[ "\$ENABLED" != "true" \]; then[\s\S]*exit 1/);
  });

  test("preflight refuses a ref other than refs/heads/main", () => {
    const step = stepNamed(preflightSteps, "Refuse a ref other than main");
    expect(step?.env?.["REF"]).toBe(gha("github.ref"));
    expect(step?.run).toMatch(/if \[ "\$REF" != "refs\/heads\/main" \]; then[\s\S]*exit 1/);
  });

  test("preflight decides keylessly, and publish runs only when it says there is work", () => {
    const check = stepNamed(preflightSteps, "Is there anything to publish?");
    expect(check?.id).toBe("check");
    expect(check?.run).toMatch(
      /^bun scripts\/publish-registry\.ts --check --registry registry\s*$/,
    );
    expect(preflight?.outputs?.["publish"]).toBe(gha("steps.check.outputs.publish"));
    expect(publish?.needs).toBe("preflight");
    expect(publish?.if).toBe("needs.preflight.outputs.publish == 'true'");
    expect(publish?.environment).toBe("official-registry");
  });

  test("per-job permissions: preflight reads, publish holds contents: write and nothing else", () => {
    expect(parsed.permissions).toEqual({ contents: "read" });
    expect([{}, { contents: "read" }]).toContainEqual(preflight?.permissions ?? "missing");
    expect(publish?.permissions).toEqual({ contents: "write" });
  });

  test("every checkout sets persist-credentials: false", () => {
    const checkouts = [...preflightSteps, ...publishSteps].filter((s) =>
      (s.uses ?? "").startsWith("actions/checkout@"),
    );
    expect(checkouts.length).toBe(4);
    expect(checkouts.map((s) => s.with?.["persist-credentials"])).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  test("the key-deletion step runs always()", () => {
    const step = stepNamed(publishSteps, "Delete the signing keys");
    expect(step?.if).toBe("always()");
    expect(step?.run).toMatch(/rm -rf "\$RUNNER_TEMP\/nimbus-keys"/);
  });

  test("the key secrets appear only in the step that writes them", () => {
    const writer = stepNamed(publishSteps, "Write the signing keys");
    expect(writer?.env?.["ROOT_KEY"]).toBe(gha("secrets.NIMBUS_REGISTRY_ROOT_KEY"));
    expect(writer?.env?.["PUBLISHER_KEY"]).toBe(gha("secrets.NIMBUS_PUBLISHER_KEY"));
    // The whole workflow — top level, both jobs, every other step — with only the writer removed.
    const withoutWriter = {
      ...parsed,
      jobs: {
        preflight,
        publish: { ...publish, steps: publishSteps.filter((s) => s !== writer) },
      },
    };
    expect(JSON.stringify(withoutWriter)).not.toMatch(/secrets\./);
  });

  test("the keys are written after the build, immediately before the step that reads them", () => {
    const build = indexNamed(publishSteps, "Build the extension bundle");
    const install = indexNamed(publishSteps, "Install");
    const write = indexNamed(publishSteps, "Write the signing keys");
    const sign = indexNamed(publishSteps, "Sign and add to the registry");
    expect(install).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(install);
    expect(write).toBeGreaterThan(build);
    expect(sign).toBe(write + 1);
    expect(publishSteps[sign]?.run).toContain("--prebuilt connectors/readwise/dist/server.js");
  });

  test("install uses the frozen lockfile and runs no lifecycle scripts", () => {
    const run = stepNamed(publishSteps, "Install")?.run ?? "";
    expect(run).toMatch(/^bun install\b/);
    expect(run).toContain("--frozen-lockfile");
    expect(run).toContain("--ignore-scripts");
  });

  test("the push targets gh-pages and nothing else", () => {
    const run = stepNamed(publishSteps, "Commit and push the registry")?.run ?? "";
    const pushes = [...run.matchAll(/git push (.*)$/gm)].map((m) => m[1]?.trim());
    // The remote is this repository, by the runner-set GITHUB_REPOSITORY; the refspec is gh-pages.
    expect(pushes).toEqual([`"https://github.com/\${GITHUB_REPOSITORY}.git" HEAD:gh-pages`]);
  });
});

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface Workflow {
  permissions?: unknown;
  jobs: Record<
    string,
    {
      needs?: unknown;
      if?: string;
      environment?: unknown;
      permissions?: unknown;
      outputs?: Record<string, string>;
      steps?: Step[];
    }
  >;
}

describe("checkPublish (the keyless --check mode)", () => {
  test("a version not in the index means publish", () => {
    writeFileSync(join(scratch, "index.json"), JSON.stringify(indexWith({})));
    expect(checkPublish(scratch, fakeConnector())).toEqual({
      publish: true,
      id: ID,
      version: "0.2.0",
      reason: expect.stringContaining("will be published"),
    });
  });

  test("a version already in the index means no publish", () => {
    writeFileSync(
      join(scratch, "index.json"),
      JSON.stringify(indexWith({ [ID]: { publisher: PUBLISHER, versions: { "0.2.0": {} } } })),
    );
    expect(checkPublish(scratch, fakeConnector()).publish).toBe(false);
  });

  test("a missing index.json fails with the bootstrap instruction", () => {
    expect(() => checkPublish(scratch, fakeConnector())).toThrow(/nimbus registry maintain init/);
  });

  test("the CLI mode writes publish=… to GITHUB_OUTPUT and needs no key", async () => {
    const registry = join(scratch, "registry");
    mkdirSync(registry);
    writeFileSync(join(registry, "index.json"), JSON.stringify(indexWith({})));
    const out = join(scratch, "github-output");
    writeFileSync(out, "");
    const proc = Bun.spawn(
      ["bun", join(ROOT, "scripts", "publish-registry.ts"), "--check", "--registry", registry],
      { env: { ...process.env, GITHUB_OUTPUT: out }, stdout: "pipe", stderr: "pipe" },
    );
    expect(await proc.exited).toBe(0);
    const manifest = JSON.parse(
      readFileSync(join(ROOT, "connectors", "readwise", "nimbus.extension.json"), "utf8"),
    );
    expect(readFileSync(out, "utf8")).toBe(`publish=true\nid=${ID}\nversion=${manifest.version}\n`);
  });

  test("the CLI mode fails, naming the bootstrap, when index.json is missing", async () => {
    const proc = Bun.spawn(
      ["bun", join(ROOT, "scripts", "publish-registry.ts"), "--check", "--registry", scratch],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stderr).text()).toContain("nimbus registry maintain init");
  });
});
