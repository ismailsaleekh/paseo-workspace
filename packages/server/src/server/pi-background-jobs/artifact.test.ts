import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadBackgroundJobsBridgeArtifact, materializeBackgroundJobsBridge } from "./artifact.js";

const STUB = "export default function () {}\n";
let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "paseo-bg-artifact-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The compiled layout: dist/server/server/{pi-background-jobs,agent/providers/pi/...}. */
async function productionLayout(bundle: string | null): Promise<string> {
  const moduleFile = path.join(root, "dist", "pi-background-jobs", "artifact.js");
  await mkdir(path.dirname(moduleFile), { recursive: true });
  await writeFile(moduleFile, "");
  if (bundle !== null) {
    const bundleFile = path.join(
      root,
      "dist/agent/providers/pi/background-jobs-bridge/extension.bundle.mjs",
    );
    await mkdir(path.dirname(bundleFile), { recursive: true });
    await writeFile(bundleFile, bundle);
  }
  return pathToFileURL(moduleFile).href;
}

async function neverCompile(): Promise<Uint8Array> {
  throw new Error("A compiled build must not compile at runtime");
}

function moduleDefault(loaded: unknown): unknown {
  return typeof loaded === "object" && loaded !== null && "default" in loaded
    ? loaded.default
    : null;
}

function withBridgeEnvironment(socket: string | undefined, capability: string | undefined) {
  const saved = {
    socket: process.env.PASEO_BG_SOCKET,
    capability: process.env.PASEO_BG_CAPABILITY,
  };
  const assign = (name: "PASEO_BG_SOCKET" | "PASEO_BG_CAPABILITY", value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  assign("PASEO_BG_SOCKET", socket);
  assign("PASEO_BG_CAPABILITY", capability);
  return () => {
    assign("PASEO_BG_SOCKET", saved.socket);
    assign("PASEO_BG_CAPABILITY", saved.capability);
  };
}

describe("bridge artifact", () => {
  test("a compiled build reads its bundle and never compiles at runtime", async () => {
    const moduleUrl = await productionLayout(STUB);
    const compile = vi.fn(neverCompile);
    const artifact = await loadBackgroundJobsBridgeArtifact(moduleUrl, compile);
    expect(Buffer.from(artifact).toString("utf8")).toBe(STUB);
    expect(compile).not.toHaveBeenCalled();
  });

  test("a compiled build without its bundle fails loudly instead of compiling", async () => {
    const moduleUrl = await productionLayout(null);
    const compile = vi.fn(neverCompile);
    await expect(loadBackgroundJobsBridgeArtifact(moduleUrl, compile)).rejects.toThrow(
      /missing from this build/,
    );
    expect(compile).not.toHaveBeenCalled();
  });

  test("materialization is private, hash-named and stable", async () => {
    const bytes = new TextEncoder().encode(STUB);
    const first = await materializeBackgroundJobsBridge(root, bytes);
    const second = await materializeBackgroundJobsBridge(root, bytes);
    expect(second).toBe(first);
    expect(path.basename(first)).toMatch(/^paseo-bg-[0-9a-f]{32}\.mjs$/);
    expect((await stat(first)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(first))).mode & 0o777).toBe(0o700);
    expect(await readFile(first, "utf8")).toBe(STUB);
  });

  test("the bundle is standalone: it loads without Pi or daemon packages", async () => {
    const artifact = await loadBackgroundJobsBridgeArtifact();
    const text = Buffer.from(artifact).toString("utf8");
    expect(text).not.toMatch(/from\s*["'](?!node:)[^"']+["']/);
    expect(text).not.toMatch(/require\(["'](?!node:)/);
    const file = await materializeBackgroundJobsBridge(root, artifact);
    const register = moduleDefault(await import(pathToFileURL(file).href));
    expect(typeof register).toBe("function");
    if (typeof register !== "function") return;
    const events: string[] = [];
    const pi = {
      events: { on: () => () => {}, emit: () => {} },
      on: (event: string) => {
        events.push(event);
      },
    };
    let restore = withBridgeEnvironment(undefined, undefined);
    try {
      register(pi);
      // Without the injected environment the bridge registers nothing.
      expect(events).toEqual([]);
    } finally {
      restore();
    }
    restore = withBridgeEnvironment("/tmp/paseo-bg-test/h.sock", "a".repeat(64));
    try {
      register(pi);
      expect(events).toEqual(["session_start", "session_shutdown"]);
    } finally {
      restore();
    }
  }, 30_000);
});
