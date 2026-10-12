import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The compiled bundle lives next to the compiled bridge source in dist. */
const BUNDLE_RELATIVE_URL = "../agent/providers/pi/background-jobs-bridge/extension.bundle.mjs";
const SOURCE_RELATIVE_URL = "../agent/providers/pi/background-jobs-bridge/extension.ts";

export type CompileBridgeSource = (sourcePath: string) => Promise<Uint8Array>;

/**
 * Loads the standalone bridge bytes. A compiled or packaged daemon reads the bundle produced by
 * `build:lib` (Electron's fs reads it from inside app.asar); it never compiles at runtime. Only a
 * source checkout running this TypeScript module bundles the source on demand.
 */
export async function loadBackgroundJobsBridgeArtifact(
  moduleUrl: string = import.meta.url,
  compileSource: CompileBridgeSource = compileBridgeSource,
): Promise<Uint8Array> {
  try {
    return await readFile(new URL(BUNDLE_RELATIVE_URL, moduleUrl));
  } catch (error) {
    if (!fileURLToPath(moduleUrl).endsWith(".ts"))
      throw new Error("Bundled Pi background jobs bridge is missing from this build", {
        cause: error,
      });
  }
  return compileSource(fileURLToPath(new URL(SOURCE_RELATIVE_URL, moduleUrl)));
}

async function compileBridgeSource(sourcePath: string): Promise<Uint8Array> {
  const { build } = await import("esbuild");
  const result = await build({
    entryPoints: [sourcePath],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false,
    logLevel: "silent",
  });
  const artifact = result.outputFiles[0]?.contents;
  if (!artifact) throw new Error("Failed to bundle the Pi background jobs bridge");
  return artifact;
}

/**
 * Writes the bridge to a hash-named private file under the Paseo runtime directory and returns
 * its path. The directory is 0700 and the file 0600; the write is atomic.
 */
export async function materializeBackgroundJobsBridge(
  paseoHome: string,
  artifact: Uint8Array,
): Promise<string> {
  const digest = createHash("sha256").update(artifact).digest("hex");
  const directory = path.join(paseoHome, "runtime", "pi-background-jobs");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const destination = path.join(directory, `paseo-bg-${digest.slice(0, 32)}.mjs`);
  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, artifact, { mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await chmod(destination, 0o600);
  return destination;
}
