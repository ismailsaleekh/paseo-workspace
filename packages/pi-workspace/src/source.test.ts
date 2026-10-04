import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VISUAL_SOURCE_BYTES, VisualFailure } from "@getpaseo/protocol/pi-workspace/contracts";
import { readVisualSource } from "./source.js";

async function withDirectory(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "paseo-visual-source-"));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function failure(code: string): (error: unknown) => boolean {
  return (error) => error instanceof VisualFailure && error.code === code;
}

test("inline and explicit relative/absolute files preserve exactly the same UTF-8 document", async () => {
  await withDirectory(async (cwd) => {
    const html = "\uFEFF<!doctype html><p>π — 東京 🧭</p><script>let value = 1;</script>";
    await writeFile(join(cwd, "visual.html"), html);
    assert.equal(await readVisualSource({ cwd, source: { html } }), html);
    assert.equal(await readVisualSource({ cwd, source: { file: "visual.html" } }), html);
    assert.equal(await readVisualSource({ cwd, source: { file: join(cwd, "visual.html") } }), html);
  });
});

test("byte limit is inclusive and uses bytes rather than UTF-16 characters", async () => {
  await withDirectory(async (cwd) => {
    const html = "a".repeat(VISUAL_SOURCE_BYTES);
    await writeFile(join(cwd, "limit.html"), html);
    assert.equal((await readVisualSource({ cwd, source: { html } })).length, VISUAL_SOURCE_BYTES);
    assert.equal(
      (await readVisualSource({ cwd, source: { file: "limit.html" } })).length,
      VISUAL_SOURCE_BYTES,
    );
    await assert.rejects(
      readVisualSource({ cwd, source: { html: `${html}a` } }),
      failure("SOURCE_TOO_LARGE"),
    );
    await assert.rejects(
      readVisualSource({ cwd, source: { html: "é".repeat(VISUAL_SOURCE_BYTES) } }),
      failure("SOURCE_TOO_LARGE"),
    );
    await writeFile(join(cwd, "limit.html"), `${html}a`);
    await assert.rejects(
      readVisualSource({ cwd, source: { file: "limit.html" } }),
      failure("SOURCE_TOO_LARGE"),
    );
  });
});

test("invalid Unicode/UTF-8 and empty sources fail without replacement or truncation", async () => {
  await withDirectory(async (cwd) => {
    await writeFile(join(cwd, "invalid.html"), Buffer.from([0xc3, 0x28]));
    await writeFile(join(cwd, "empty.html"), "");
    await assert.rejects(
      readVisualSource({ cwd, source: { file: "invalid.html" } }),
      failure("INVALID_SOURCE"),
    );
    await assert.rejects(
      readVisualSource({ cwd, source: { file: "empty.html" } }),
      failure("INVALID_SOURCE"),
    );
    await assert.rejects(
      readVisualSource({ cwd, source: { html: "" } }),
      failure("INVALID_SOURCE"),
    );
    await assert.rejects(
      readVisualSource({ cwd, source: { html: "\ud800" } }),
      failure("INVALID_SOURCE"),
    );
    await assert.rejects(
      readVisualSource({ cwd, source: { file: "  " } }),
      failure("INVALID_SOURCE"),
    );
  });
});

test("missing paths, directories and symbolic links are explicit failures", async () => {
  await withDirectory(async (cwd) => {
    await mkdir(join(cwd, "directory"));
    await writeFile(join(cwd, "target.html"), "<p>target</p>");
    await symlink(join(cwd, "target.html"), join(cwd, "link.html"));
    await assert.rejects(
      readVisualSource({ cwd, source: { file: "missing.html" } }),
      failure("SOURCE_UNAVAILABLE"),
    );
    await assert.rejects(
      readVisualSource({ cwd, source: { file: "directory" } }),
      failure("INVALID_SOURCE"),
    );
    await assert.rejects(
      readVisualSource({ cwd, source: { file: "link.html" } }),
      failure("SOURCE_UNAVAILABLE"),
    );
  });
});

test("cancellation takes precedence and no file or inline work is accepted", async () => {
  const signal = AbortSignal.abort();
  await assert.rejects(
    readVisualSource({ cwd: "/", source: { html: "<p>x</p>" }, signal }),
    failure("CANCELLED"),
  );
  await assert.rejects(
    readVisualSource({ cwd: "/", source: { file: "missing" }, signal }),
    failure("CANCELLED"),
  );
});
