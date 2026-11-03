import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addToRegistry,
  assertOutside,
  type CliIo,
  checkedPath,
  checkPublish,
  decodeSeed,
  derivePublicKey,
  fixedLayout,
  isInside,
  LAYOUT,
  type Layout,
  loadIndex,
  type PublishDeps,
  packForRegistry,
  planPublish,
  READWISE_DIR,
  type RegistryIndex,
  runCli,
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

/** Parse a JSON object file as `unknown` and narrow it — never the `any` a bare JSON.parse gives. */
function readJsonObject(file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`${file} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

const READWISE_MANIFEST = join(ROOT, "connectors", "readwise", "nimbus.extension.json");

/** The real Readwise manifest's id@version, which runCli labels its log lines with. */
const READWISE = (() => {
  const manifest = readJsonObject(READWISE_MANIFEST);
  const id = manifest["id"];
  const version = manifest["version"];
  if (typeof id !== "string" || typeof version !== "string") {
    throw new TypeError("the Readwise manifest needs a string id and version");
  }
  return { id, version };
})();

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
    const staged = readJsonObject(join(stage, "nimbus.extension.json"));
    expect(staged["publisher"]).toEqual(PUBLISHER);
    expect(staged["entry"]).toBe("dist/server.js");
    expect(staged["description"]).toBe("é ✓");
    expect(readdirSync(stage).sort()).toEqual([
      "LICENSE",
      "README.md",
      "dist",
      "nimbus.extension.json",
    ]);
    expect(existsSync(join(stage, "dist", "server.js"))).toBe(true);
  });

  test("the real Readwise connector has an offline eval suite, and staging copies it byte for byte", async () => {
    const suiteFile = join(READWISE_DIR, "evals", "offline.eval.json");
    expect(existsSync(suiteFile)).toBe(true);
    const stage = join(scratch, "stage");
    await stagePackage({
      connectorDir: READWISE_DIR,
      stageDir: stage,
      publisher: PUBLISHER,
      build: fakeBuild,
    });
    expect(
      readFileSync(join(stage, "evals", "offline.eval.json")).equals(readFileSync(suiteFile)),
    ).toBe(true);
    // The package version and the manifest's agree: the version that is published is the one tested.
    const pkg = readJsonObject(join(READWISE_DIR, "package.json"));
    expect(pkg["version"]).toBe(
      readJsonObject(join(READWISE_DIR, "nimbus.extension.json"))["version"],
    );
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

  test("copies evals/ when the connector has one, each suite byte-identical", async () => {
    const connector = fakeConnector();
    mkdirSync(join(connector, "evals", "nested"), { recursive: true });
    const suite = Buffer.from([0x7b, 0x0a, 0xc3, 0xa9, 0x0d, 0x0a, 0x7d]);
    writeFileSync(join(connector, "evals", "a.eval.json"), suite);
    writeFileSync(join(connector, "evals", "nested", "b.eval.json"), "{}\n");
    const stage = join(scratch, "stage");
    await stagePackage({
      connectorDir: connector,
      stageDir: stage,
      publisher: PUBLISHER,
      build: fakeBuild,
    });
    expect(readFileSync(join(stage, "evals", "a.eval.json")).equals(suite)).toBe(true);
    expect(readFileSync(join(stage, "evals", "nested", "b.eval.json"), "utf8")).toBe("{}\n");
  });

  test("stages nothing from the connector directory beyond the expected files", async () => {
    const connector = fakeConnector();
    mkdirSync(join(connector, "evals"), { recursive: true });
    writeFileSync(join(connector, "evals", "a.eval.json"), "{}\n");
    mkdirSync(join(connector, "src"), { recursive: true });
    writeFileSync(join(connector, "src", "secret.ts"), "export {};\n");
    writeFileSync(join(connector, ".env"), "TOKEN=x\n");
    const stage = join(scratch, "stage");
    await stagePackage({
      connectorDir: connector,
      stageDir: stage,
      publisher: PUBLISHER,
      build: fakeBuild,
    });
    expect(readdirSync(stage).sort()).toEqual([
      "LICENSE",
      "README.md",
      "dist",
      "evals",
      "nimbus.extension.json",
    ]);
  });

  test("refuses evals/ itself being a symlink", async () => {
    const connector = fakeConnector();
    const elsewhere = join(scratch, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "a.eval.json"), "{}\n");
    try {
      symlinkSync(elsewhere, join(connector, "evals"), "dir");
    } catch {
      return; // Creating symlinks needs a privilege on Windows; the POSIX legs cover this.
    }
    await expect(
      stagePackage({
        connectorDir: connector,
        stageDir: join(scratch, "stage"),
        publisher: PUBLISHER,
        build: fakeBuild,
      }),
    ).rejects.toThrow(/not a regular directory/);
  });

  test("refuses a symlink nested inside evals/", async () => {
    const connector = fakeConnector();
    mkdirSync(join(connector, "evals", "nested"), { recursive: true });
    writeFileSync(join(scratch, "target"), "secret");
    try {
      symlinkSync(join(scratch, "target"), join(connector, "evals", "nested", "leak.json"));
    } catch {
      return; // Creating symlinks needs a privilege on Windows; the POSIX legs cover this.
    }
    await expect(
      stagePackage({
        connectorDir: connector,
        stageDir: join(scratch, "stage"),
        publisher: PUBLISHER,
        build: fakeBuild,
      }),
    ).rejects.toThrow(/is a symlink/);
  });

  test("a connector without evals/ stages none", async () => {
    const stage = join(scratch, "stage");
    await stagePackage({
      connectorDir: fakeConnector(),
      stageDir: stage,
      publisher: PUBLISHER,
      build: fakeBuild,
    });
    expect(existsSync(join(stage, "evals"))).toBe(false);
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
    const manifest = readJsonObject(READWISE_MANIFEST);
    expect(manifest["id"]).toBe(ID);
    expect(manifest["entrypoint"]).toBe("dist/server.js");
    expect(manifest["publisher"]).toBeUndefined();
  });
});

const PACKED_BYTES = "pretend-tgz-bytes";
const sha256Of = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");

/** Registry, key files, package and scores dirs for the two keyed steps, all in the scratch dir. */
function keyedSetup(index: RegistryIndex | undefined) {
  const registry = join(scratch, "registry");
  mkdirSync(registry);
  if (index !== undefined) {
    writeFileSync(join(registry, "index.json"), JSON.stringify(index));
  }
  const keys = join(scratch, "keys");
  mkdirSync(keys);
  writeFileSync(join(keys, "publisher.key"), `${SEED_B64}\n`, { mode: 0o600 });
  writeFileSync(join(keys, "root.key"), `${OTHER_SEED_B64}\n`, { mode: 0o600 });
  const packageDir = join(scratch, "package");
  const scoresDir = join(scratch, "scores");
  mkdirSync(packageDir);
  mkdirSync(scoresDir);
  const packageFile = join(packageDir, "package.tgz");
  const scoresFile = join(scoresDir, "scores.json");
  return {
    registry,
    packageFile,
    scoresFile,
    pack: {
      cli: "/opt/nimbus",
      registryDir: registry,
      publisherKeyFile: join(keys, "publisher.key"),
      publisherId: "nimbus",
      packageFile,
      connectorDir: fakeConnector(),
    },
    add: {
      cli: "/opt/nimbus",
      registryDir: registry,
      rootKeyFile: join(keys, "root.key"),
      packageFile,
      scoresFile,
      packageSha256: sha256Of(PACKED_BYTES),
      connectorDir: fakeConnector(),
    },
  };
}

describe("packForRegistry", () => {
  /** A CLI stand-in: records argv; `pack` writes the file at `--out`, whatever it prints. */
  function packDeps(calls: string[][], stages: string[]): PublishDeps {
    return {
      build: fakeBuild,
      log: () => {},
      run: async (argv) => {
        calls.push(argv);
        const stage = argv[3] ?? "";
        stages.push(stage);
        expect(existsSync(join(stage, "nimbus.extension.json"))).toBe(true);
        if (argv[2] === "pack") writeFileSync(argv[5] ?? "", PACKED_BYTES);
        return 0;
      },
    };
  }

  test("signs, then packs once to the fixed file; no root key anywhere; the stage is removed", async () => {
    const s = keyedSetup(indexWith({}, 7));
    const calls: string[][] = [];
    const stages: string[] = [];
    const result = await packForRegistry(s.pack, packDeps(calls, stages));

    expect(result).toEqual({
      status: "packed",
      id: ID,
      version: "0.2.0",
      sha256: sha256Of(PACKED_BYTES),
    });
    expect(calls).toEqual([
      ["/opt/nimbus", "extension", "sign", stages[0] ?? "", "--key", s.pack.publisherKeyFile],
      ["/opt/nimbus", "extension", "pack", stages[0] ?? "", "--out", s.packageFile],
    ]);
    const argvText = calls.flat().join(" ");
    expect(argvText).not.toContain(SEED_B64);
    expect(argvText).not.toContain(OTHER_SEED_B64);
    expect(argvText).not.toContain("root.key");
    expect(existsSync(stages[0] ?? "")).toBe(false);
  });

  test("the hash is of the bytes on disk, not of anything the CLI printed", async () => {
    const s = keyedSetup(indexWith({}));
    const deps: PublishDeps = {
      ...packDeps([], []),
      run: async (argv) => {
        if (argv[2] === "pack") {
          console.log(`sha256 ${"ab".repeat(32)}`);
          writeFileSync(argv[5] ?? "", "other bytes");
        }
        return 0;
      },
    };
    const result = await packForRegistry(s.pack, deps);
    expect(result.status === "packed" ? result.sha256 : "").toBe(sha256Of("other bytes"));
  });

  test("an already-published version runs nothing", async () => {
    const s = keyedSetup(indexWith({ [ID]: { publisher: PUBLISHER, versions: { "0.2.0": {} } } }));
    const calls: string[][] = [];
    const result = await packForRegistry(s.pack, packDeps(calls, []));
    expect(result).toEqual({ status: "skipped", id: ID, version: "0.2.0" });
    expect(calls).toEqual([]);
  });

  test("a publisher-key mismatch refuses before running anything", async () => {
    const s = keyedSetup(
      indexWith({
        [ID]: { publisher: { id: "nimbus", key: derivePublicKey(OTHER_SEED_B64) }, versions: {} },
      }),
    );
    const calls: string[][] = [];
    await expect(packForRegistry(s.pack, packDeps(calls, []))).rejects.toThrow(/publisher key/);
    expect(calls).toEqual([]);
  });

  test("a publisher-id mismatch refuses before running anything", async () => {
    const s = keyedSetup(
      indexWith({ [ID]: { publisher: { id: "someone", key: PUB_B64 }, versions: {} } }),
    );
    const calls: string[][] = [];
    await expect(packForRegistry(s.pack, packDeps(calls, []))).rejects.toThrow(/publisher id/);
    expect(calls).toEqual([]);
  });

  test("a package already on disk is refused: it is packed once", async () => {
    const s = keyedSetup(indexWith({}));
    writeFileSync(s.packageFile, "earlier");
    const calls: string[][] = [];
    await expect(packForRegistry(s.pack, packDeps(calls, []))).rejects.toThrow(/already exists/);
    expect(calls).toEqual([]);
  });

  test("a missing index fails with the bootstrap instruction", async () => {
    const s = keyedSetup(undefined);
    await expect(packForRegistry(s.pack, packDeps([], []))).rejects.toThrow(
      /nimbus registry maintain init/,
    );
  });

  test("a failing CLI step fails the pack and still cleans the stage", async () => {
    const s = keyedSetup(indexWith({}));
    const stages: string[] = [];
    const deps: PublishDeps = {
      ...packDeps([], []),
      run: async (argv) => {
        stages.push(argv[3] ?? "");
        return 2;
      },
    };
    await expect(packForRegistry(s.pack, deps)).rejects.toThrow(/exited 2/);
    expect(stages).toHaveLength(1);
    expect(existsSync(stages[0] ?? "")).toBe(false);
  });

  test("a pack that wrote no file fails", async () => {
    const s = keyedSetup(indexWith({}));
    const deps: PublishDeps = { ...packDeps([], []), run: async () => 0 };
    await expect(packForRegistry(s.pack, deps)).rejects.toThrow(/package .* does not exist/);
  });
});

describe("addToRegistry", () => {
  /** A CLI stand-in: records argv, and `maintain add` writes the version into the index. */
  function addDeps(registry: string, calls: string[][]): Pick<PublishDeps, "run" | "log"> {
    return {
      log: () => {},
      run: async (argv) => {
        calls.push(argv);
        const current = loadIndex(registry);
        const next: RegistryIndex = {
          ...current,
          sequence: (current.sequence ?? 0) + 1,
          extensions: {
            ...current.extensions,
            [ID]: { publisher: PUBLISHER, versions: { "0.2.0": {} } },
          },
        };
        writeFileSync(join(registry, "index.json"), JSON.stringify(next));
        return 0;
      },
    };
  }

  function ready(index: RegistryIndex | null = indexWith({}, 7)) {
    const s = keyedSetup(index ?? undefined);
    writeFileSync(s.packageFile, PACKED_BYTES);
    writeFileSync(s.scoresFile, "{}");
    return s;
  }

  test("adds the package with its scores under the root key, and nothing else", async () => {
    const s = ready();
    const calls: string[][] = [];
    const result = await addToRegistry(s.add, addDeps(s.registry, calls));
    expect(result).toEqual({ status: "published", id: ID, version: "0.2.0", sequence: 8 });
    expect(calls).toEqual([
      [
        "/opt/nimbus",
        "registry",
        "maintain",
        "add",
        s.registry,
        s.packageFile,
        "--scores",
        s.scoresFile,
        "--key",
        s.add.rootKeyFile,
      ],
    ]);
    expect(calls.flat().join(" ")).not.toContain("publisher.key");
  });

  test("a package whose hash differs from --package-sha256 is refused before anything runs", async () => {
    const s = ready();
    const calls: string[][] = [];
    await expect(
      addToRegistry(
        { ...s.add, packageSha256: sha256Of("a swapped file") },
        addDeps(s.registry, calls),
      ),
    ).rejects.toThrow(/SHA-256/);
    expect(calls).toEqual([]);
  });

  test("a missing scores file is refused before anything runs", async () => {
    const s = ready();
    rmSync(s.scoresFile);
    const calls: string[][] = [];
    await expect(addToRegistry(s.add, addDeps(s.registry, calls))).rejects.toThrow(/scores file/);
    expect(calls).toEqual([]);
  });

  test("a missing package is refused before anything runs", async () => {
    const s = ready();
    rmSync(s.packageFile);
    const calls: string[][] = [];
    await expect(addToRegistry(s.add, addDeps(s.registry, calls))).rejects.toThrow(
      /package .* does not exist/,
    );
    expect(calls).toEqual([]);
  });

  test("a hash that is not 64 lowercase hex is refused, without repeating a long value", async () => {
    const s = ready();
    const calls: string[][] = [];
    const long = "A".repeat(500);
    for (const bad of [long, sha256Of("x").toUpperCase(), sha256Of("x").slice(1), ""]) {
      let message = "";
      try {
        await addToRegistry({ ...s.add, packageSha256: bad }, addDeps(s.registry, calls));
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/64 lowercase hex/);
      expect(message).not.toContain(long);
    }
    expect(calls).toEqual([]);
  });

  test("a root key that does not match the index refuses before running anything", async () => {
    const s = ready({ ...indexWith({}), rootKey: PUB_B64 });
    const calls: string[][] = [];
    await expect(addToRegistry(s.add, addDeps(s.registry, calls))).rejects.toThrow(/root key/);
    expect(calls).toEqual([]);
  });

  test("an already-published version runs nothing", async () => {
    const s = ready(indexWith({ [ID]: { publisher: PUBLISHER, versions: { "0.2.0": {} } } }));
    const calls: string[][] = [];
    const result = await addToRegistry(s.add, addDeps(s.registry, calls));
    expect(result).toEqual({ status: "skipped", id: ID, version: "0.2.0" });
    expect(calls).toEqual([]);
  });

  test("a missing index fails with the bootstrap instruction", async () => {
    const s = ready(null);
    await expect(addToRegistry(s.add, addDeps(s.registry, []))).rejects.toThrow(
      /nimbus registry maintain init/,
    );
  });

  test("a failing add fails the step", async () => {
    const s = ready();
    await expect(addToRegistry(s.add, { log: () => {}, run: async () => 3 })).rejects.toThrow(
      /exited 3/,
    );
  });

  test("an add that does not land the version in the index fails", async () => {
    const s = ready();
    await expect(addToRegistry(s.add, { log: () => {}, run: async () => 0 })).rejects.toThrow(
      /not in index.json/,
    );
  });

  test("a publisher key file is never needed or read", async () => {
    const s = ready();
    rmSync(join(scratch, "keys", "publisher.key"));
    const result = await addToRegistry(s.add, addDeps(s.registry, []));
    expect(result.status).toBe("published");
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
  const pack = parsed.jobs["package"];
  const score = parsed.jobs["score"];
  const publish = parsed.jobs["publish"];
  const preflightSteps = preflight?.steps ?? [];
  const packSteps = pack?.steps ?? [];
  const scoreSteps = score?.steps ?? [];
  const publishSteps = publish?.steps ?? [];
  const allSteps = [...preflightSteps, ...packSteps, ...scoreSteps, ...publishSteps];
  const stepNamed = (steps: Step[], name: string): Step | undefined =>
    steps.find((s) => s.name === name);
  const indexNamed = (steps: Step[], name: string): number =>
    steps.findIndex((s) => s.name === name);
  const isDownload = (s: Step): boolean => (s.uses ?? "").startsWith("actions/download-artifact@");
  const isUpload = (s: Step): boolean => (s.uses ?? "").startsWith("actions/upload-artifact@");
  const ASSET = "nimbus-gateway-linux-x64";

  test("has exactly the four jobs these assertions are about, in order", () => {
    expect(Object.keys(parsed.jobs)).toEqual(["preflight", "package", "score", "publish"]);
    expect(preflightSteps.length).toBeGreaterThan(3);
    expect(packSteps.length).toBeGreaterThan(5);
    expect(scoreSteps.length).toBeGreaterThan(3);
    expect(publishSteps.length).toBeGreaterThan(5);
  });

  test("the jobs chain preflight, package, score, publish; publish has no always()", () => {
    expect(pack?.needs).toBe("preflight");
    expect(pack?.if).toBe("needs.preflight.outputs.publish == 'true'");
    expect(score?.needs).toBe("package");
    expect(score?.if).toBe("needs.package.outputs.packed == 'true'");
    expect(publish?.needs).toEqual(["package", "score"]);
    expect(publish?.if).toBe("needs.package.outputs.packed == 'true'");
    // A failed or skipped score job must skip publish: nothing may override that.
    const withAlways = publishSteps
      .filter((s) => (s.if ?? "").includes("always()"))
      .map((s) => s.name);
    expect(withAlways).toEqual(["Delete the signing keys"]);
    expect(publish?.if ?? "").not.toMatch(/always|failure|cancelled|success/);
  });

  test("package outputs the digest, id, version and whether it packed", () => {
    expect(pack?.outputs).toEqual({
      package_sha256: gha("steps.pack.outputs.package_sha256"),
      id: gha("steps.pack.outputs.id"),
      version: gha("steps.pack.outputs.version"),
      packed: gha("steps.pack.outputs.packed"),
    });
    expect(stepNamed(packSteps, "Sign and pack the extension")?.id).toBe("pack");
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

  test("preflight decides keylessly", () => {
    const check = stepNamed(preflightSteps, "Is there anything to publish?");
    expect(check?.id).toBe("check");
    expect(check?.run).toMatch(/^bun scripts\/publish-registry\.ts --check\s*$/);
    expect(preflight?.outputs?.["publish"]).toBe(gha("steps.check.outputs.publish"));
  });

  test("the two keyed jobs use the environment; score uses none and holds no secret", () => {
    expect(pack?.environment).toBe("official-registry");
    expect(publish?.environment).toBe("official-registry");
    expect(score?.environment).toBeUndefined();
    expect(JSON.stringify(score)).not.toMatch(/secrets\./);
    expect(JSON.stringify(score)).not.toMatch(/KEY/);
    expect(JSON.stringify(preflight)).not.toMatch(/secrets\./);
  });

  test("per-job permissions: package and score read, publish holds contents: write", () => {
    expect(parsed.permissions).toEqual({ contents: "read" });
    expect([{}, { contents: "read" }]).toContainEqual(preflight?.permissions ?? "missing");
    expect(pack?.permissions).toEqual({ contents: "read" });
    expect(score?.permissions).toEqual({ contents: "read" });
    expect(publish?.permissions).toEqual({ contents: "write" });
  });

  test("score is bounded to 20 minutes, publish keeps the registry concurrency group", () => {
    expect(score?.["timeout-minutes"]).toBe(20);
    expect(publish?.concurrency).toEqual({
      group: "official-registry",
      "cancel-in-progress": false,
    });
  });

  test("every checkout sets persist-credentials: false; score has none", () => {
    const checkoutsOf = (steps: Step[]): Step[] =>
      steps.filter((s) => (s.uses ?? "").startsWith("actions/checkout@"));
    expect(checkoutsOf(preflightSteps)).toHaveLength(2);
    expect(checkoutsOf(packSteps)).toHaveLength(2);
    expect(checkoutsOf(scoreSteps)).toHaveLength(0);
    expect(checkoutsOf(publishSteps)).toHaveLength(2);
    const all = checkoutsOf(allSteps);
    expect(all).toHaveLength(6);
    expect(all.map((s) => s.with?.["persist-credentials"])).toEqual(Array(6).fill(false));
  });

  test("both key-deletion steps run always()", () => {
    for (const steps of [packSteps, publishSteps]) {
      const step = stepNamed(steps, "Delete the signing keys");
      expect(step?.if).toBe("always()");
      expect(step?.run).toMatch(/rm -rf "\$RUNNER_TEMP\/nimbus-keys"/);
    }
  });

  test("each key appears only in its own job, in the step that writes it", () => {
    const packWriter = stepNamed(packSteps, "Write the publisher key");
    const publishWriter = stepNamed(publishSteps, "Write the registry root key");
    expect(packWriter?.env?.["PUBLISHER_KEY"]).toBe(gha("secrets.NIMBUS_PUBLISHER_KEY"));
    expect(publishWriter?.env?.["ROOT_KEY"]).toBe(gha("secrets.NIMBUS_REGISTRY_ROOT_KEY"));
    expect(packWriter?.env?.["ROOT_KEY"]).toBeUndefined();
    expect(publishWriter?.env?.["PUBLISHER_KEY"]).toBeUndefined();
    const without = (job: object, steps: Step[], writer: Step | undefined): string =>
      JSON.stringify({ ...job, steps: steps.filter((s) => s !== writer) });
    // Everything but the writer, per job and for the rest of the workflow, names no secret at all.
    expect(without(pack ?? {}, packSteps, packWriter)).not.toMatch(/secrets\./);
    expect(without(publish ?? {}, publishSteps, publishWriter)).not.toMatch(/secrets\./);
    expect(JSON.stringify({ ...parsed, jobs: { preflight, score } })).not.toMatch(/secrets\./);
    // NIMBUS_PUBLISHER_KEY only in package; NIMBUS_REGISTRY_ROOT_KEY only in publish.
    expect(JSON.stringify(pack)).not.toMatch(/ROOT_KEY|root\.key/);
    expect(JSON.stringify(publish)).not.toMatch(/PUBLISHER_KEY|publisher\.key/);
    expect(packWriter?.run).toContain(`> "$keys/${LAYOUT.publisherKey}"`);
    expect(publishWriter?.run).toContain(`> "$keys/${LAYOUT.rootKey}"`);
  });

  test("package writes the publisher key right before the step that reads it", () => {
    const install = indexNamed(packSteps, "Install");
    const build = indexNamed(packSteps, "Build the extension bundle");
    const write = indexNamed(packSteps, "Write the publisher key");
    const sign = indexNamed(packSteps, "Sign and pack the extension");
    expect(install).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(install);
    expect(write).toBeGreaterThan(build);
    expect(sign).toBe(write + 1);
    expect(packSteps[sign]?.env?.["PUBLISHER_ID"]).toBe(gha("vars.NIMBUS_PUBLISHER_ID"));
    expect(packSteps[sign]?.run).toMatch(
      /^bun scripts\/publish-registry\.ts --pack --publisher-id "\$PUBLISHER_ID"\s*$/,
    );
    expect(indexNamed(packSteps, "Delete the signing keys")).toBeGreaterThan(sign);
  });

  test("publish writes the root key right before the step that reads it", () => {
    const download = indexNamed(publishSteps, "Download and verify the Nimbus CLI");
    const write = indexNamed(publishSteps, "Write the registry root key");
    const add = indexNamed(publishSteps, "Add to the registry");
    expect(download).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(download);
    expect(add).toBe(write + 1);
    expect(publishSteps[add]?.id).toBe("publish");
    expect(publishSteps[add]?.env?.["PACKAGE_SHA256"]).toBe(
      gha("needs.package.outputs.package_sha256"),
    );
    expect(publishSteps[add]?.run).toMatch(
      /^bun scripts\/publish-registry\.ts --publish --package-sha256 "\$PACKAGE_SHA256"\s*$/,
    );
    expect(indexNamed(publishSteps, "Delete the signing keys")).toBeGreaterThan(add);
    // No repository code is built or installed where the root key is.
    expect(indexNamed(publishSteps, "Install")).toBe(-1);
    expect(indexNamed(publishSteps, "Build the extension bundle")).toBe(-1);
  });

  test("every artifact download lands under runner.temp; uploads fail on a missing file", () => {
    const downloads = allSteps.filter(isDownload);
    expect(downloads).toHaveLength(3);
    for (const step of downloads) {
      expect(String(step.with?.["path"])).toStartWith(gha("runner.temp"));
    }
    const uploads = allSteps.filter(isUpload);
    expect(uploads).toHaveLength(2);
    for (const step of uploads) expect(step.with?.["if-no-files-found"]).toBe("error");
  });

  test("package uploads the one .tgz that publish later hashes", () => {
    const upload = packSteps.find(isUpload);
    expect(upload?.with?.["name"]).toBe("readwise-package");
    expect(upload?.with?.["path"]).toBe(
      `${gha("runner.temp")}/${LAYOUT.packageDir}/${LAYOUT.packageFile}`,
    );
    expect(upload?.if).toBe("steps.pack.outputs.packed == 'true'");
  });

  test("score downloads the package, runs the action on the .tgz and uploads scores.json", () => {
    expect(scoreSteps.map((s) => s.name)).toEqual([
      "Harden Runner",
      "Download the package",
      "Set up the sandbox",
      "Download the Nimbus gateway",
      "Score the package",
      "Upload the scores",
    ]);
    expect(stepNamed(scoreSteps, "Download the package")?.with).toEqual({
      name: "readwise-package",
      path: `${gha("runner.temp")}/readwise-package`,
    });
    const action = stepNamed(scoreSteps, "Score the package");
    expect(action?.uses).toMatch(
      /^nimbus-agent\/Nimbus\/packages\/github-actions\/registry-action@[0-9a-f]{40}$/,
    );
    // `scores` is left unset so the action writes scores.json in the workspace.
    expect(action?.with).toEqual({
      mode: "score-package",
      package: `${gha("runner.temp")}/readwise-package/package.tgz`,
      "nimbus-gateway": `${gha("github.workspace")}/${ASSET}`,
    });
    expect(stepNamed(scoreSteps, "Upload the scores")?.with).toEqual({
      name: "registry-scores",
      path: "scores.json",
      "if-no-files-found": "error",
    });
  });

  test("score sets up the sandbox as the generated template does, probing as the runner user", () => {
    const run = stepNamed(scoreSteps, "Set up the sandbox")?.run ?? "";
    expect(run).toContain("install -y -qq bubblewrap");
    const lines = run.split("\n").map((l) => l.trim());
    const sysctl = lines.findIndex((l) =>
      l.startsWith("sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0"),
    );
    const probe = lines.findIndex((l) => l.startsWith("bwrap --unshare-user"));
    const probeLine = lines[probe];
    expect(sysctl).toBeGreaterThan(-1);
    expect(probe).toBeGreaterThan(sysctl);
    // Root bypasses the userns restriction, so a probe under sudo would prove nothing.
    expect(lines.filter((l) => l.includes("bwrap")).every((l) => !l.includes("sudo"))).toBe(true);
    // The rest of the block, pinned: without it a good package is signed `no-listing` for good.
    expect(lines).toContain(
      "sudo rm -f /etc/apt/sources.list.d/*microsoft* /etc/apt/sources.list.d/*azure*",
    );
    expect(lines).toContain("sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0");
    expect(lines).toContain("sudo sysctl -w kernel.unprivileged_userns_clone=1 || true");
    expect(probeLine).toBe(
      [
        "bwrap --unshare-user --unshare-net --new-session --ro-bind /usr /usr --ro-bind /etc /etc",
        '--ro-bind /lib /lib "$' + '{lib64[@]}" --proc /proc --dev /dev --tmpfs /tmp /usr/bin/true',
      ].join(" "),
    );
    expect(lines).toContain("if [ -d /lib64 ]; then lib64=(--ro-bind /lib64 /lib64); fi");
    expect(lines.findIndex((l) => l.startsWith("sudo rm -f"))).toBeLessThan(
      lines.findIndex((l) => l.includes("apt-get") && l.includes(" update ")),
    );
  });

  test("no pinned SHA-256 or commit is all zeros", () => {
    const pins = [
      ...workflow.matchAll(/"([0-9a-f]{64})"/g),
      ...workflow.matchAll(/@([0-9a-f]{40})/g),
    ].map((m) => m[1] ?? "");
    // Two CLI literals, one gateway literal, and every pinned action (including the Nimbus one).
    expect(pins.length).toBeGreaterThanOrEqual(4);
    for (const pin of pins) expect(pin).not.toMatch(/^0+$/);
    for (const job of [pack, publish]) {
      expect(job?.env?.["NIMBUS_CLI_SHA256"]).not.toMatch(/^0+$/);
    }
    expect(score?.env?.["NIMBUS_GATEWAY_SHA256"]).not.toMatch(/^0+$/);
  });

  test("the gateway is pinned to v10.17.0, checked against a literal and its SHA256SUMS line", () => {
    expect(score?.env?.["NIMBUS_GATEWAY_VERSION"]).toBe("v10.17.0");
    expect(score?.env?.["NIMBUS_GATEWAY_SHA256"]).toBe(
      "9fc1640a305a1a7c4b421f2b42371ddd2e075c1aafcd3c04a17b0072ac7318",
    );
    const run = stepNamed(scoreSteps, "Download the Nimbus gateway")?.run ?? "";
    expect(run).toMatch(/\/releases\/download\/\$\{NIMBUS_GATEWAY_VERSION\}"/);
    expect(run).toContain(`"$base/${ASSET}"`);
    expect(run).toContain('"$NIMBUS_GATEWAY_SHA256"');
    expect(run).toContain("sha256sum --check --strict");
    expect(run).toContain("SHA256SUMS");
    expect(run).toContain(`'^[0-9a-f]{64}  ${ASSET}$'`);
    expect(run).toContain("sha256sum -c CHECKSUM.txt");
  });

  test("the CLI is v10.17.0 with a 64-hex literal in both keyed jobs, the action by 40 hex", () => {
    for (const job of [pack, publish]) {
      expect(job?.env?.["NIMBUS_CLI_VERSION"]).toBe("v10.17.0");
      expect(job?.env?.["NIMBUS_CLI_SHA256"]).toBe(
        "840fdc4f7d529e9aa986a9e57272d5584cf719d3f482468c498b31bb74920fe2",
      );
      expect(stepNamed(job?.steps ?? [], "Download and verify the Nimbus CLI")?.run).toContain(
        "sha256sum --check --strict",
      );
    }
    // The version comment is not in the parsed tree; read it from the text.
    expect(workflow).toMatch(
      /uses: nimbus-agent\/Nimbus\/packages\/github-actions\/registry-action@90515ccbb2c4d74aa5db31cfe17d9c0dcf44e669 # v10\.17\.0(?: |$)/m,
    );
  });

  test("the steps put every file where the script's fixed layout looks for it", () => {
    const registryCheckouts = allSteps.filter((s) => s.with?.["ref"] === "gh-pages");
    expect(registryCheckouts.map((s) => s.with?.["path"])).toEqual([
      LAYOUT.registry,
      LAYOUT.registry,
      LAYOUT.registry,
    ]);
    expect(stepNamed(packSteps, "Build the extension bundle")?.run).toBe(
      "bun connectors/readwise/scripts/build-extension.ts",
    );
    expect(LAYOUT.bundle.replaceAll("\\", "/")).toBe("connectors/readwise/dist/server.js");
    for (const steps of [packSteps, publishSteps]) {
      const download = stepNamed(steps, "Download and verify the Nimbus CLI")?.run ?? "";
      expect(download).toContain('dir="$RUNNER_TEMP/nimbus-cli"');
      expect(download).toContain('-o "$dir/nimbus"');
      const writer =
        stepNamed(steps, "Write the publisher key") ??
        stepNamed(steps, "Write the registry root key");
      expect(writer?.run).toContain(`keys="$RUNNER_TEMP/${LAYOUT.keyDir}"`);
    }
    // publish downloads both artifacts to the places the script's LAYOUT reads.
    expect(publishSteps.filter(isDownload).map((s) => s.with)).toEqual([
      { name: "readwise-package", path: `${gha("runner.temp")}/${LAYOUT.packageDir}` },
      { name: "registry-scores", path: `${gha("runner.temp")}/${LAYOUT.scoresDir}` },
    ]);
    expect(LAYOUT.packageFile).toBe("package.tgz");
    expect(LAYOUT.scoresFile).toBe("scores.json");
  });

  test("install uses the frozen lockfile and runs no lifecycle scripts", () => {
    const run = stepNamed(packSteps, "Install")?.run ?? "";
    expect(run).toMatch(/^bun install\b/);
    expect(run).toContain("--frozen-lockfile");
    expect(run).toContain("--ignore-scripts");
  });

  test("Harden Runner, in audit mode, is the first step of every job", () => {
    for (const steps of [preflightSteps, packSteps, scoreSteps, publishSteps]) {
      expect(steps[0]?.uses).toMatch(/^step-security\/harden-runner@[0-9a-f]{40}$/);
      expect(steps[0]?.with).toEqual({ "egress-policy": "audit" });
    }
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
      concurrency?: unknown;
      "timeout-minutes"?: number;
      env?: Record<string, string>;
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
    const proc = Bun.spawn(["bun", join(ROOT, "scripts", "publish-registry.ts"), "--check"], {
      cwd: scratch,
      env: { ...process.env, GITHUB_OUTPUT: out },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(
      `publish=true\nid=${READWISE.id}\nversion=${READWISE.version}\n`,
    );
  });

  test("the CLI mode fails, naming the bootstrap, when index.json is missing", async () => {
    mkdirSync(join(scratch, "registry"));
    const proc = Bun.spawn(["bun", join(ROOT, "scripts", "publish-registry.ts"), "--check"], {
      cwd: scratch,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stderr).text()).toContain("nimbus registry maintain init");
  });
});

describe("checkedPath", () => {
  test("resolves a relative path inside its base to the real absolute path", () => {
    mkdirSync(join(scratch, "a", "b"), { recursive: true });
    const real = realpathSync(join(scratch, "a", "b"));
    expect(checkedPath("a/b", { cwd: scratch, kind: "directory", what: "x", base: scratch })).toBe(
      real,
    );
  });

  test("refuses a traversal out of the base", () => {
    mkdirSync(join(scratch, "inner"));
    writeFileSync(join(scratch, "outside.txt"), "x");
    expect(() =>
      checkedPath("../outside.txt", {
        cwd: join(scratch, "inner"),
        kind: "file",
        what: "--prebuilt",
        base: join(scratch, "inner"),
      }),
    ).toThrow(/outside/);
  });

  test("refuses the base itself, a missing path, the wrong kind and an empty path", () => {
    writeFileSync(join(scratch, "f"), "x");
    const opts = { cwd: scratch, base: scratch, what: "--registry" };
    expect(() => checkedPath(".", { ...opts, kind: "directory" })).toThrow(/outside/);
    expect(() => checkedPath("nope", { ...opts, kind: "directory" })).toThrow(/does not exist/);
    expect(() => checkedPath("f", { ...opts, kind: "directory" })).toThrow(/not a directory/);
    expect(() => checkedPath("", { ...opts, kind: "file" })).toThrow(/empty/);
  });

  test("refuses a symlink", () => {
    writeFileSync(join(scratch, "target"), "x");
    try {
      symlinkSync(join(scratch, "target"), join(scratch, "link"));
    } catch {
      return; // Creating symlinks needs a privilege on Windows; the POSIX legs cover this.
    }
    expect(() =>
      checkedPath("link", { cwd: scratch, kind: "file", what: "--x", base: scratch }),
    ).toThrow(/symlink/);
  });

  test("isInside is strict and is not fooled by a shared prefix", () => {
    expect(isInside(join(scratch, "reg"), join(scratch, "reg", "k"))).toBe(true);
    expect(isInside(join(scratch, "reg"), join(scratch, "reg"))).toBe(false);
    expect(isInside(join(scratch, "reg"), join(scratch, "registry", "k"))).toBe(false);
  });
});

describe("runCli", () => {
  /**
   * scratch/work is the workspace (registry checkout, prebuilt bundle); scratch/tmp stands in for
   * $RUNNER_TEMP (the CLI, the keys, the package, the scores). Every file sits where fixedLayout
   * puts it. The CLI is a stand-in that records argv, writes the packed file for `extension pack`
   * and lands the version in the index for `registry maintain add`.
   */
  function world(index: RegistryIndex | undefined = indexWith({}, 4)) {
    const work = join(scratch, "work");
    const temp = join(scratch, "tmp");
    const paths = fixedLayout(work, temp);
    mkdirSync(paths.registryDir, { recursive: true });
    mkdirSync(join(paths.bundle, ".."), { recursive: true });
    mkdirSync(join(paths.cli, ".."), { recursive: true });
    mkdirSync(join(paths.publisherKeyFile, ".."), { recursive: true });
    if (index !== undefined) {
      writeFileSync(join(paths.registryDir, "index.json"), JSON.stringify(index));
    }
    writeFileSync(paths.bundle, "export {};\n");
    writeFileSync(paths.publisherKeyFile, `${SEED_B64}\n`, { mode: 0o600 });
    writeFileSync(paths.rootKeyFile, `${OTHER_SEED_B64}\n`, { mode: 0o600 });
    writeFileSync(paths.cli, "");
    const out = join(scratch, "github-output");
    writeFileSync(out, "");
    const logs: string[] = [];
    const calls: string[][] = [];
    const io: CliIo = {
      workspace: work,
      tempDir: temp,
      githubOutput: out,
      log: (m) => logs.push(m),
      run: async (argv) => {
        calls.push(argv);
        if (argv[2] === "pack") writeFileSync(argv[5] ?? "", PACKED_BYTES);
        if (argv[1] === "registry") {
          const current = loadIndex(paths.registryDir);
          const next: RegistryIndex = {
            ...current,
            sequence: (current.sequence ?? 0) + 1,
            extensions: {
              ...current.extensions,
              [READWISE.id]: { publisher: PUBLISHER, versions: { [READWISE.version]: {} } },
            },
          };
          writeFileSync(join(paths.registryDir, "index.json"), JSON.stringify(next));
        }
        return 0;
      },
    };
    /** What the keyless job leaves for the publish step: the packed file and its scores. */
    const stageForPublish = (paths_: Layout = paths): void => {
      mkdirSync(join(paths_.packageFile, ".."), { recursive: true });
      mkdirSync(join(paths_.scoresFile, ".."), { recursive: true });
      writeFileSync(paths_.packageFile, PACKED_BYTES);
      writeFileSync(paths_.scoresFile, "{}");
    };
    return {
      work,
      temp,
      paths,
      out,
      logs,
      calls,
      io,
      stageForPublish,
      packArgs: ["--pack", "--publisher-id", "nimbus"],
      publishArgs: ["--publish", "--package-sha256", sha256Of(PACKED_BYTES)],
    };
  }

  const label = `${READWISE.id}@${READWISE.version}`;
  const publishedIndex = () =>
    indexWith({ [READWISE.id]: { publisher: PUBLISHER, versions: { [READWISE.version]: {} } } });

  test("every path is a constant name under one of the two bases", () => {
    const p = fixedLayout(join("W"), join("T"));
    expect(p).toEqual({
      registryDir: join("W", "registry"),
      bundle: join("W", "connectors", "readwise", "dist", "server.js"),
      cli: join("T", "nimbus-cli", process.platform === "win32" ? "nimbus.exe" : "nimbus"),
      publisherKeyFile: join("T", "nimbus-keys", "publisher.key"),
      rootKeyFile: join("T", "nimbus-keys", "root.key"),
      packageDir: join("T", "nimbus-package"),
      packageFile: join("T", "nimbus-package", "package.tgz"),
      scoresDir: join("T", "registry-scores"),
      scoresFile: join("T", "registry-scores", "scores.json"),
    });
  });

  test("argv takes no path: the old path flags are unknown options", async () => {
    const w = world();
    for (const flag of [
      "--registry",
      "--cli",
      "--publisher-key-file",
      "--root-key-file",
      "--prebuilt",
      "--package",
      "--scores",
    ]) {
      await expect(runCli([flag, "x"], w.io)).rejects.toThrow(/Unknown option/);
    }
    expect(w.calls).toHaveLength(0);
  });

  test("--check writes publish=true and logs only the label", async () => {
    const w = world();
    await runCli(["--check"], w.io);
    expect(readFileSync(w.out, "utf8")).toBe(
      `publish=true\nid=${READWISE.id}\nversion=${READWISE.version}\n`,
    );
    expect(w.logs).toEqual([`${label}: not in the registry; publishing.`]);
  });

  test("--check writes publish=false for a published version", async () => {
    const w = world(publishedIndex());
    await runCli(["--check"], w.io);
    expect(readFileSync(w.out, "utf8")).toStartWith("publish=false\n");
    expect(w.logs).toEqual([`${label}: already published.`]);
  });

  test("--check fails clearly when there is no registry checkout", async () => {
    const w = world();
    rmSync(w.paths.registryDir, { recursive: true });
    await expect(runCli(["--check"], w.io)).rejects.toThrow(
      /the registry checkout .* does not exist/,
    );
  });

  describe("the mode flags", () => {
    test("--check, --pack and --publish are mutually exclusive", async () => {
      const w = world();
      for (const modes of [
        ["--check", "--pack"],
        ["--check", "--publish"],
        ["--pack", "--publish"],
        ["--check", "--pack", "--publish"],
      ]) {
        await expect(runCli(modes, w.io)).rejects.toThrow(/mutually exclusive/);
      }
      expect(w.calls).toHaveLength(0);
    });

    test("the old single-step invocation is refused, naming the new flags", async () => {
      const w = world();
      const error = await runCli(["--publisher-id", "nimbus"], w.io).then(
        () => "",
        (e: Error) => e.message,
      );
      expect(error).toContain("--pack");
      expect(error).toContain("--publish");
      expect(w.calls).toHaveLength(0);
      expect(readFileSync(w.out, "utf8")).toBe("");
    });

    test("no mode at all is refused", async () => {
      const w = world();
      await expect(runCli([], w.io)).rejects.toThrow(/--check, --pack or --publish/);
    });

    test("a flag belonging to the other mode is refused", async () => {
      const w = world();
      await expect(
        runCli(["--publish", "--publisher-id", "nimbus", ...w.publishArgs.slice(1)], w.io),
      ).rejects.toThrow(/--publisher-id belongs to --pack/);
      await expect(
        runCli([...w.packArgs, "--package-sha256", sha256Of("x")], w.io),
      ).rejects.toThrow(/--package-sha256 belongs to --publish/);
      expect(w.calls).toHaveLength(0);
    });
  });

  describe("--pack", () => {
    test("signs and packs the prebuilt bundle; reports the hash of the file; no secret leaks", async () => {
      const w = world();
      await runCli(w.packArgs, w.io);
      expect(readFileSync(w.out, "utf8")).toBe(
        `package_sha256=${sha256Of(PACKED_BYTES)}\nid=${READWISE.id}\nversion=${READWISE.version}\npacked=true\n`,
      );
      expect(w.logs).toEqual([`${label}: packed.`]);
      expect(w.calls.map((c) => c.slice(0, 3))).toEqual([
        [realpathSync(w.paths.cli), "extension", "sign"],
        [realpathSync(w.paths.cli), "extension", "pack"],
      ]);
      expect(w.calls[0]?.at(-1)).toBe(realpathSync(w.paths.publisherKeyFile));
      expect(w.calls[1]?.at(-1)).toBe(join(realpathSync(w.paths.packageDir), "package.tgz"));
      const everything = [...w.logs, ...w.calls.flat(), readFileSync(w.out, "utf8")].join("\n");
      for (const secretish of [
        SEED_B64,
        OTHER_SEED_B64,
        PUB_B64,
        derivePublicKey(OTHER_SEED_B64),
      ]) {
        expect(everything).not.toContain(secretish);
      }
      expect(everything).not.toContain(realpathSync(w.paths.rootKeyFile));
    });

    test("needs no root key file", async () => {
      const w = world();
      rmSync(w.paths.rootKeyFile);
      await runCli(w.packArgs, w.io);
      expect(readFileSync(w.out, "utf8")).toContain("packed=true");
    });

    test("an already-published version is a no-op: packed=false and no hash", async () => {
      const w = world(publishedIndex());
      await runCli(w.packArgs, w.io);
      expect(w.calls).toHaveLength(0);
      expect(readFileSync(w.out, "utf8")).toBe(
        `package_sha256=\nid=${READWISE.id}\nversion=${READWISE.version}\npacked=false\n`,
      );
    });

    test("requires a non-empty --publisher-id", async () => {
      const w = world();
      await expect(runCli(["--pack"], w.io)).rejects.toThrow(
        "missing required flag --publisher-id",
      );
      await expect(runCli(["--pack", "--publisher-id", " "], w.io)).rejects.toThrow(
        /--publisher-id/,
      );
    });

    test("refuses to pack without a prebuilt bundle, rather than building", async () => {
      const w = world();
      rmSync(w.paths.bundle);
      await expect(runCli(w.packArgs, w.io)).rejects.toThrow(/prebuilt bundle .*build-extension/);
      expect(w.calls).toHaveLength(0);
    });

    test("refuses a missing publisher key file or CLI before running anything", async () => {
      for (const which of ["publisherKeyFile", "cli"] as const) {
        const w = world();
        rmSync(w.paths[which]);
        await expect(runCli(w.packArgs, w.io)).rejects.toThrow(/does not exist/);
        expect(w.calls).toHaveLength(0);
        rmSync(scratch, { recursive: true, force: true });
        mkdirSync(scratch);
      }
    });

    test("refuses a publisher key file inside the registry, when the temp dir is the workspace", async () => {
      const w = world();
      // The temp base is the registry checkout itself, so the key directory lands inside it.
      const io: CliIo = { ...w.io, tempDir: w.paths.registryDir };
      const inside = fixedLayout(w.work, w.paths.registryDir);
      mkdirSync(join(inside.publisherKeyFile, ".."), { recursive: true });
      mkdirSync(join(inside.cli, ".."), { recursive: true });
      writeFileSync(inside.cli, "");
      writeFileSync(inside.publisherKeyFile, `${SEED_B64}\n`, { mode: 0o600 });
      await expect(runCli(w.packArgs, io)).rejects.toThrow(/is inside the registry/);
      expect(w.calls).toHaveLength(0);
    });

    test.skipIf(process.platform === "win32")(
      "refuses a publisher key file readable by group or others",
      async () => {
        const w = world();
        chmodSync(w.paths.publisherKeyFile, 0o644);
        await expect(runCli(w.packArgs, w.io)).rejects.toThrow(/readable by group or others/);
        expect(w.calls).toHaveLength(0);
      },
    );

    test("refuses a key directory that is a symlink", async () => {
      const w = world();
      const keyDir = join(w.paths.publisherKeyFile, "..");
      const elsewhere = join(scratch, "elsewhere");
      mkdirSync(elsewhere);
      rmSync(keyDir, { recursive: true });
      try {
        symlinkSync(elsewhere, keyDir, "dir");
      } catch {
        return; // Creating symlinks needs a privilege on Windows; the POSIX legs cover this.
      }
      writeFileSync(join(elsewhere, "publisher.key"), `${SEED_B64}\n`, { mode: 0o600 });
      await expect(runCli(w.packArgs, w.io)).rejects.toThrow(/outside/);
      expect(w.calls).toHaveLength(0);
    });

    test("refuses a package already on disk", async () => {
      const w = world();
      w.stageForPublish();
      await expect(runCli(w.packArgs, w.io)).rejects.toThrow(/already exists/);
      expect(w.calls).toHaveLength(0);
    });
  });

  describe("--publish", () => {
    test("adds the package with its scores under the root key; reads no publisher key", async () => {
      const w = world();
      w.stageForPublish();
      rmSync(w.paths.publisherKeyFile);
      await runCli(w.publishArgs, w.io);
      expect(readFileSync(w.out, "utf8")).toBe(
        `published=true\nid=${READWISE.id}\nversion=${READWISE.version}\nsequence=5\n`,
      );
      expect(w.logs).toEqual([`${label}: published.`]);
      expect(w.calls).toEqual([
        [
          realpathSync(w.paths.cli),
          "registry",
          "maintain",
          "add",
          realpathSync(w.paths.registryDir),
          realpathSync(w.paths.packageFile),
          "--scores",
          realpathSync(w.paths.scoresFile),
          "--key",
          realpathSync(w.paths.rootKeyFile),
        ],
      ]);
      const everything = [...w.logs, ...w.calls.flat(), readFileSync(w.out, "utf8")].join("\n");
      for (const secretish of [
        SEED_B64,
        OTHER_SEED_B64,
        PUB_B64,
        derivePublicKey(OTHER_SEED_B64),
      ]) {
        expect(everything).not.toContain(secretish);
      }
    });

    test("an already-published version is a logged no-op", async () => {
      const w = world(publishedIndex());
      w.stageForPublish();
      await runCli(w.publishArgs, w.io);
      expect(w.calls).toHaveLength(0);
      expect(readFileSync(w.out, "utf8")).toStartWith("published=false\n");
    });

    test("requires --package-sha256 of exactly 64 lowercase hex, refused before anything runs", async () => {
      const w = world();
      w.stageForPublish();
      await expect(runCli(["--publish"], w.io)).rejects.toThrow(
        "missing required flag --package-sha256",
      );
      const long = "z".repeat(400);
      for (const bad of [long, sha256Of("x").toUpperCase(), "abc", ""]) {
        const message = await runCli(["--publish", "--package-sha256", bad], w.io).then(
          () => "",
          (e: Error) => e.message,
        );
        expect(message).toMatch(/64 lowercase hex/);
        expect(message).not.toContain(long);
      }
      expect(w.calls).toHaveLength(0);
    });

    test("a swapped package is refused before anything runs", async () => {
      const w = world();
      w.stageForPublish();
      writeFileSync(w.paths.packageFile, "swapped by another job");
      await expect(runCli(w.publishArgs, w.io)).rejects.toThrow(/SHA-256/);
      expect(w.calls).toHaveLength(0);
    });

    test("refuses a missing package, scores, key file or CLI before running anything", async () => {
      for (const which of ["packageFile", "scoresFile", "rootKeyFile", "cli"] as const) {
        const w = world();
        w.stageForPublish();
        rmSync(w.paths[which]);
        await expect(runCli(w.publishArgs, w.io)).rejects.toThrow(/does not exist/);
        expect(w.calls).toHaveLength(0);
        rmSync(scratch, { recursive: true, force: true });
        mkdirSync(scratch);
      }
    });

    test("refuses a root key file inside the registry, when the temp dir is the workspace", async () => {
      const w = world();
      const io: CliIo = { ...w.io, tempDir: w.paths.registryDir };
      const inside = fixedLayout(w.work, w.paths.registryDir);
      mkdirSync(join(inside.rootKeyFile, ".."), { recursive: true });
      mkdirSync(join(inside.cli, ".."), { recursive: true });
      writeFileSync(inside.cli, "");
      writeFileSync(inside.rootKeyFile, `${OTHER_SEED_B64}\n`, { mode: 0o600 });
      w.stageForPublish(inside);
      await expect(runCli(w.publishArgs, io)).rejects.toThrow(/is inside the registry/);
      expect(w.calls).toHaveLength(0);
    });

    test.skipIf(process.platform === "win32")(
      "refuses a root key file readable by group or others",
      async () => {
        const w = world();
        w.stageForPublish();
        chmodSync(w.paths.rootKeyFile, 0o644);
        await expect(runCli(w.publishArgs, w.io)).rejects.toThrow(/readable by group or others/);
        expect(w.calls).toHaveLength(0);
      },
    );
  });

  test("a key or scores file inside the package dir (or a key in the scores dir) is refused", () => {
    const pkg = join(scratch, "pkg");
    const scores = join(scratch, "scores");
    const dirs: Array<[string, string]> = [
      [pkg, "the package directory"],
      [scores, "the scores directory"],
    ];
    expect(() => assertOutside(join(pkg, "root.key"), dirs, "the root key file")).toThrow(
      /inside the package directory/,
    );
    expect(() => assertOutside(join(scores, "root.key"), dirs, "the root key file")).toThrow(
      /inside the scores directory/,
    );
    expect(() =>
      assertOutside(join(pkg, "scores.json"), [[pkg, "the package directory"]], "the scores file"),
    ).toThrow(/inside the package directory/);
    expect(() => assertOutside(join(scratch, "keys", "root.key"), dirs, "the key")).not.toThrow();
  });
});

describe("no key-derived value reaches a message", () => {
  test("a publisher-key refusal names the registry's key, not the supplied one", () => {
    const index = indexWith({
      [ID]: { publisher: { id: "nimbus", key: derivePublicKey(OTHER_SEED_B64) }, versions: {} },
    });
    const plan = planPublish(index, ID, "0.2.0", PUBLISHER);
    const reason = plan.action === "refuse" ? plan.reason : "";
    expect(reason).toContain(derivePublicKey(OTHER_SEED_B64));
    expect(reason).not.toContain(PUBLISHER.key);
  });

  test("a root-key refusal does not name the key derived from the supplied seed", async () => {
    const s = keyedSetup(undefined);
    writeFileSync(
      join(s.registry, "index.json"),
      JSON.stringify({ ...indexWith({}), rootKey: PUB_B64 }),
    );
    writeFileSync(s.packageFile, PACKED_BYTES);
    writeFileSync(s.scoresFile, "{}");
    let message = "";
    try {
      await addToRegistry(s.add, { log: () => {}, run: async () => 0 });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/root key/);
    expect(message).not.toContain(derivePublicKey(OTHER_SEED_B64));
    expect(message).not.toContain(OTHER_SEED_B64);
  });

  test("a key file that is not a seed is refused without quoting it", async () => {
    const s = keyedSetup(indexWith({}));
    writeFileSync(s.pack.publisherKeyFile, "pretend-this-is-secret", { mode: 0o600 });
    const run = packForRegistry(s.pack, { build: fakeBuild, log: () => {}, run: async () => 0 });
    await expect(run).rejects.toThrow(/is not one line of base64/);
    await expect(run).rejects.not.toThrow(/pretend-this-is-secret/);
  });

  test("a key path that is a directory or missing is refused", async () => {
    const s = keyedSetup(indexWith({}));
    const deps = { build: fakeBuild, log: () => {}, run: async () => 0 };
    await expect(
      packForRegistry({ ...s.pack, publisherKeyFile: s.registry }, deps),
    ).rejects.toThrow(/not a regular file/);
    await expect(
      addToRegistry({ ...s.add, rootKeyFile: join(scratch, "nope.key") }, deps),
    ).rejects.toThrow(/root key file .* does not exist/);
  });

  test("an index.json that is not a regular file is refused", () => {
    mkdirSync(join(scratch, "index.json"));
    expect(() => loadIndex(scratch)).toThrow(/not a regular file/);
  });

  test("an empty publisher id is refused", async () => {
    await expect(
      packForRegistry(
        {
          cli: "nimbus",
          registryDir: scratch,
          publisherKeyFile: "x",
          publisherId: " ",
          packageFile: join(scratch, "p.tgz"),
          connectorDir: fakeConnector(),
        },
        { build: fakeBuild, log: () => {}, run: async () => 0 },
      ),
    ).rejects.toThrow(/publisher id is empty/);
  });
});

describe("publish-registry.ts imports", () => {
  test("only node: builtins, so no package code runs beside the root key", () => {
    const src = readFileSync(
      join(fileURLToPath(import.meta.url), "..", "publish-registry.ts"),
      "utf8",
    );
    const specs = [
      ...src.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gms),
      ...src.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
      ...src.matchAll(/\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/g),
    ].map((m) => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.filter((s) => !s?.startsWith("node:"))).toEqual([]);
  });
});
