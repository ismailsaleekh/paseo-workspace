import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  FailedToolSchema,
  packageRoot,
  runCommand,
  visualTools,
  withIsolatedHome,
  withSdk,
} from "../helpers/pi-harness.js";

const ManifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  license: z.string(),
  keywords: z.array(z.string()),
  pi: z.object({ extensions: z.array(z.string()) }),
  scripts: z.record(z.string(), z.string()),
  peerDependencies: z.record(z.string(), z.string()),
  devDependencies: z.record(z.string(), z.string()),
  dependencies: z.record(z.string(), z.string()),
});
const PackSchema = z
  .array(z.object({ filename: z.string(), files: z.array(z.object({ path: z.string() })) }))
  .length(1);
async function digest(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

async function verifyInstalledExtension(session: AgentSession): Promise<void> {
  assert.deepEqual(session.getActiveToolNames().sort(), visualTools);
  await session.prompt('call:{"name":"visual_list","arguments":{}}');
  const result = FailedToolSchema.parse(
    session.messages.findLast((message) => message.role === "toolResult"),
  );
  assert.equal(result.details.error.code, "HOST_UNAVAILABLE");
  assert.equal(session.getLastAssistantText(), "TEST_TOOL_COMPLETE");
}

test("manifest pins development SDK, declares peers and packages every public document", async () => {
  const raw: unknown = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const manifest = ManifestSchema.parse(raw);
  assert.equal(manifest.name, "@getpaseo/pi-workspace");
  assert.equal(manifest.license, "Apache-2.0");
  assert.equal(manifest.keywords.includes("pi-package"), true);
  assert.equal(manifest.keywords.includes("pi-extension"), true);
  assert.deepEqual(manifest.pi.extensions, ["./extensions/workspace.ts"]);
  for (const peer of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "typebox"]) {
    assert.equal(manifest.peerDependencies[peer], "*");
    assert.equal(
      manifest.dependencies[peer],
      undefined,
      `${peer} must not be a runtime dependency`,
    );
  }
  assert.equal(manifest.devDependencies["@earendil-works/pi-coding-agent"], "1.0.0");
  assert.equal(manifest.devDependencies["@earendil-works/pi-ai"], "1.0.0");
  assert.equal(manifest.devDependencies["typebox"], "1.3.27");
  assert.equal(manifest.dependencies["zod"], "4.4.3");
  for (const document of ["README.md", "TEST_PLAN.md", "TESTING.md", "PUBLISHING.md", "LICENSE"]) {
    assert.notEqual((await readFile(join(packageRoot, document), "utf8")).trim(), "");
  }
  const qa = manifest.scripts["test"];
  if (!qa) throw new Error("Missing default QA script");
  for (const gate of [
    "typecheck",
    "test:type-safety",
    "test:unit",
    "test:sdk",
    "test:rpc",
    "test:package",
    "test:host",
  ])
    assert.equal(qa.includes(`npm run ${gate}`), true);
  assert.equal(manifest.scripts["pack:dry-run"], "npm pack --dry-run --ignore-scripts");
});

test(
  "paired fork tarballs install without workspace links and the installed extension executes in real Pi",
  { timeout: 180_000 },
  async () => {
    await withIsolatedHome(async (home) => {
      const artifacts = join(home.root, "artifacts");
      const installed = join(home.root, "installed");
      await Promise.all([mkdir(artifacts), mkdir(installed)]);
      await writeFile(
        join(installed, "package.json"),
        JSON.stringify({ private: true, type: "module" }),
      );
      const protocolRoot = resolve(packageRoot, "../protocol");
      const packArgs = [
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        artifacts,
        "--offline",
        "--cache",
        home.cache,
      ];
      const protocolRaw: unknown = JSON.parse(
        runCommand({ program: "npm", args: packArgs, cwd: protocolRoot, env: home.env }),
      );
      const workspaceRaw: unknown = JSON.parse(
        runCommand({ program: "npm", args: packArgs, cwd: packageRoot, env: home.env }),
      );
      const protocol = PackSchema.parse(protocolRaw)[0];
      const workspace = PackSchema.parse(workspaceRaw)[0];
      if (!protocol || !workspace) throw new Error("npm omitted a packed artifact");
      const protocolFiles = new Set(protocol.files.map((file) => file.path));
      assert.equal(protocolFiles.has("dist/pi-workspace/contracts.js"), true);
      assert.equal(protocolFiles.has("dist/pi-workspace/contracts.d.ts"), true);
      const files = workspace.files.map((file) => file.path);
      for (const file of [
        "extensions/workspace.ts",
        "src/extension.ts",
        "src/connection.ts",
        "src/tools.ts",
        "src/source.ts",
        "README.md",
        "TESTING.md",
        "TEST_PLAN.md",
        "PUBLISHING.md",
        "LICENSE",
      ])
        assert.equal(files.includes(file), true, file);
      assert.equal(
        files.some((file) => file.startsWith("tests/") || file.endsWith(".test.ts")),
        false,
      );
      runCommand({
        program: "npm",
        cwd: installed,
        env: home.env,
        args: [
          "install",
          "--offline",
          "--ignore-scripts",
          "--legacy-peer-deps",
          "--no-audit",
          "--no-fund",
          "--cache",
          home.cache,
          join(artifacts, protocol.filename),
          join(artifacts, workspace.filename),
        ],
      });
      const installedProtocol = join(installed, "node_modules/@getpaseo/protocol");
      const installedPackage = join(installed, "node_modules/@getpaseo/pi-workspace");
      assert.equal((await lstat(installedProtocol)).isSymbolicLink(), false);
      assert.equal((await lstat(installedPackage)).isSymbolicLink(), false);
      for (const origin of [
        join(installedProtocol, "dist/pi-workspace/contracts.js"),
        join(installedPackage, "src/tools.ts"),
      ]) {
        const dependency = createRequire(origin).resolve("zod/package.json");
        const raw: unknown = JSON.parse(await readFile(dependency, "utf8"));
        assert.equal(z.object({ version: z.string() }).parse(raw).version, "4.4.3");
      }
      assert.equal(
        await digest(join(installedProtocol, "dist/pi-workspace/contracts.js")),
        await digest(join(protocolRoot, "dist/pi-workspace/contracts.js")),
      );
      for (const file of [
        "src/extension.ts",
        "src/connection.ts",
        "src/tools.ts",
        "src/source.ts",
      ]) {
        assert.equal(
          await digest(join(installedPackage, file)),
          await digest(join(packageRoot, file)),
        );
      }
      const entry = join(installedPackage, "extensions/workspace.ts");
      await withSdk(home, verifyInstalledExtension, entry);
    });
  },
);
