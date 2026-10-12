import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

// The Pi bridge runs inside an external Pi process, which cannot import from app.asar or compile
// TypeScript. Bundle it into one standalone ESM file that the daemon materializes at runtime.
const sourcePath = fileURLToPath(
  new URL("../src/server/agent/providers/pi/background-jobs-bridge/extension.ts", import.meta.url),
);
const outputPath = fileURLToPath(
  new URL(
    "../dist/server/server/agent/providers/pi/background-jobs-bridge/extension.bundle.mjs",
    import.meta.url,
  ),
);
await mkdir(path.dirname(outputPath), { recursive: true });
await build({
  entryPoints: [sourcePath],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: outputPath,
  logLevel: "warning",
});
