/**
 * The ONE build of the Readwise extension bundle. The production `build:extension` script and the
 * test-fixture builder both go through {@link buildExtension}, so the entry and the `Bun.build`
 * options cannot drift between them; the fixture adds a plugin and nothing else.
 *
 *   bun scripts/build-extension.ts   ->   dist/server.js
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONNECTOR_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

export const EXTENSION_ENTRY = join(CONNECTOR_DIR, "src", "extension.ts");
export const DEFAULT_OUT_FILE = join(CONNECTOR_DIR, "dist", "server.js");

/** Bundle the extension entry into one self-contained file at `outFile`. */
export async function buildExtension(
  outFile: string = DEFAULT_OUT_FILE,
  plugins: Bun.BunPlugin[] = [],
  external: readonly string[] = [],
): Promise<void> {
  const result = await Bun.build({
    entrypoints: [EXTENSION_ENTRY],
    target: "bun",
    external: [...external],
    outdir: dirname(outFile),
    naming: basename(outFile),
    plugins,
  });
  if (!result.success) {
    throw new Error(`bun build failed: ${result.logs.map((l) => l.message).join("; ")}`);
  }
}

if (import.meta.main) {
  await buildExtension();
}
