#!/usr/bin/env node
// Judge-owned registration boundary. This is necessary, not sufficient, for workspace acceptance.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sdkRoot = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent";
const sdkManifest = JSON.parse(await readFile(path.join(sdkRoot, "package.json"), "utf8"));
assert.equal(
  sdkManifest.version,
  "1.0.0",
  "Revalidate this oracle before changing the Pi SDK version",
);

const args = process.argv.slice(2);
const selfCheck = args.length === 1 && args[0] === "--self-check";
const visualPhase = args.length === 2 && args[0] === "--phase" && args[1] === "visual";
const speechPhase = args.length === 2 && args[0] === "--phase" && args[1] === "speech";
if (args.length !== 0 && !selfCheck && !visualPhase && !speechPhase) {
  throw new Error(
    "Use no arguments for all eight tools, --phase visual for the five-tool slice, --phase speech for visual tools plus speak, or --self-check",
  );
}
const repository = process.cwd();
const entrypoint = selfCheck
  ? path.join(sdkRoot, "examples/extensions/hello.ts")
  : path.join(repository, "packages/pi-workspace/extensions/workspace.ts");
const completeNames = [
  "branch_open",
  "branch_return",
  "speak",
  "visual_act",
  "visual_inspect",
  "visual_list",
  "visual_present",
  "visual_update",
];
let expectedNames = completeNames;
if (selfCheck) expectedNames = ["hello"];
else if (visualPhase) expectedNames = completeNames.filter((name) => name.startsWith("visual_"));
else if (speechPhase)
  expectedNames = completeNames.filter((name) => name.startsWith("visual_") || name === "speak");

assert.equal(
  existsSync(entrypoint),
  true,
  `Required Pi package entrypoint is absent: ${entrypoint}`,
);
const temporary = await mkdtemp(path.join(tmpdir(), "pi-workspace-oracle-"));
const agentDir = path.join(temporary, "agent");
const projectDir = path.join(temporary, "project");
await mkdir(agentDir);
await mkdir(projectDir);
const inheritedEnvironment = new Set(["PATH", "TMPDIR", "LANG", "LC_ALL", "SHELL"]);
for (const key of Object.keys(process.env)) {
  if (!inheritedEnvironment.has(key)) delete process.env[key];
}
process.env.HOME = temporary;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
process.env.PI_SKIP_VERSION_CHECK = "1";
process.env.PI_TELEMETRY = "0";
process.env.CI = "1";
const tracePath = path.join(temporary, "scripted-model.jsonl");
process.env.PI_WORKSPACE_ORACLE_TRACE = tracePath;

const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(
  pathToFileURL(path.join(sdkRoot, "dist/index.js")).href
);
let session;
try {
  const resourceLoader = new DefaultResourceLoader({
    cwd: projectDir,
    agentDir,
    additionalExtensionPaths: [
      entrypoint,
      fileURLToPath(new URL("./scripted-provider.mjs", import.meta.url)),
    ],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const loaded = resourceLoader.getExtensions();
  assert.deepEqual(loaded.errors, [], "Pi must load the real extension without diagnostics");
  const registeredNames = [];
  for (const extension of loaded.extensions) {
    for (const name of extension.tools.keys()) registeredNames.push(name);
  }
  registeredNames.sort();
  assert.deepEqual(registeredNames, expectedNames, "Register exactly the agreed extension tools");

  const created = await createAgentSession({
    cwd: projectDir,
    agentDir,
    noTools: "builtin",
    resourceLoader,
    sessionManager: SessionManager.inMemory(projectDir),
    settingsManager: SettingsManager.inMemory(),
  });
  session = created.session;
  await session.bindExtensions({});
  assert.deepEqual(
    session.getActiveToolNames().slice().sort(),
    expectedNames,
    "Tools must be directly model-callable",
  );

  for (const name of expectedNames) {
    const definition = session.getToolDefinition(name);
    assert.notEqual(definition, undefined, `${name} must be a real Pi tool definition`);
    assert.equal(
      typeof definition.execute,
      "function",
      `${name} needs an executable tool, not a CLI instruction`,
    );
    assert.equal(typeof definition.description, "string");
    assert.notEqual(definition.description.trim(), "", `${name} needs model-facing usage guidance`);
    assert.equal(
      typeof definition.parameters,
      "object",
      `${name} needs a structured parameter schema`,
    );
    assert.notEqual(definition.parameters, null);
  }

  assert.equal(
    session.messages.some((message) => message.role === "assistant"),
    false,
    "Loading/registering the package must not start a model turn",
  );
  const model = session.modelRuntime.getModel("pi-workspace-oracle", "scripted");
  assert.notEqual(model, undefined, "Load the isolated deterministic provider");
  await session.setModel(model);
  if (selfCheck) {
    await session.prompt('oracle-call:{"name":"hello","arguments":{"name":"workspace oracle"}}');
    const results = session.messages.filter((message) => message.role === "toolResult");
    assert.equal(results.length, 1, "Exercise the real Pi model-to-tool loop once");
    assert.equal(results[0].toolName, "hello");
    assert.equal(results[0].isError, false);
    assert.deepEqual(results[0].content, [{ type: "text", text: "Hello, workspace oracle!" }]);
    const requests = (await readFile(tracePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(requests.length, 2, "One scripted tool request and its ordinary follow-up");
    assert.equal(
      requests.every((request) => request.provider === "pi-workspace-oracle"),
      true,
    );
    assert.equal(requests[0].tools.includes("hello"), true);
    console.log("PASS real-Pi registration and scripted model-to-tool harness");
  } else {
    const unavailableCalls = [
      {
        name: "visual_present",
        arguments: { mode: "new", title: "Oracle", html: "<p>Fixture</p>" },
      },
      { name: "visual_update", arguments: { id: "missing", revision: 1, html: "<p>Changed</p>" } },
      { name: "visual_act", arguments: { id: "missing", action: "pause" } },
      { name: "visual_inspect", arguments: { screenshot: true } },
      { name: "visual_list", arguments: {} },
      { name: "speak", arguments: { text: "Exact supplied words." } },
      { name: "branch_open", arguments: { title: "Unavailable host" } },
      { name: "branch_return", arguments: { notes: "No active detour." } },
    ];
    const selectedCalls = unavailableCalls.filter((call) => expectedNames.includes(call.name));
    for (const call of selectedCalls) {
      let timeout;
      try {
        await Promise.race([
          session.prompt(`oracle-call:${JSON.stringify(call)}`),
          new Promise((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error(`${call.name}: unavailable-host result did not arrive`)),
              5000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
      const results = session.messages.filter((message) => message.role === "toolResult");
      const result = results.at(-1);
      assert.notEqual(
        result,
        undefined,
        `${call.name} must complete through Pi's actual tool loop`,
      );
      assert.equal(result.toolName, call.name);
      assert.equal(
        result.isError,
        true,
        `${call.name} must fail without an attached host, not silently start one or claim success`,
      );
      assert.equal(
        typeof result.details?.error?.code,
        "string",
        `${call.name} must return a structured error code`,
      );
      assert.notEqual(result.details.error.code, "");
    }
    let scope = "all eight tools";
    if (visualPhase) scope = "five visual tools only; speech/branches pending";
    else if (speechPhase) scope = "five visual tools plus speak; branches pending";
    console.log(`PASS real-Pi registration and unavailable-host behavior: ${scope}`);
  }
} finally {
  session?.dispose();
  await rm(temporary, { recursive: true, force: true });
}
