import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { VisualFailure, type VisualOwner } from "@getpaseo/protocol/pi-workspace/contracts";
import { VisualStorage } from "./storage.js";

const owner: VisualOwner = { agentId: "agent-one", sessionId: "session-one" };
const initialHtml = "<p>First document</p>";

async function withStorage(
  run: (storage: VisualStorage, directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-visual-storage-"));
  try {
    await run(new VisualStorage(directory), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function failure(code: string): (error: unknown) => boolean {
  return (error) => error instanceof VisualFailure && error.code === code;
}

test("source and interaction revisions persist separately across storage reopen", async () => {
  await withStorage(async (storage, directory) => {
    const created = await storage.create({ owner, title: "Example", html: initialHtml });
    const address = { owner, id: created.id };
    const snapshot = { state: { angle: 17 }, selection: { id: "angle", text: "17 degrees" } };
    const updated = await storage.saveState({
      ...address,
      revision: 1,
      stateRevision: 1,
      snapshot,
    });
    assert.equal(updated.revision, 1);
    assert.equal(updated.stateRevision, 2);
    const reopened = new VisualStorage(directory);
    assert.deepEqual(await reopened.get(address), updated);
    assert.deepEqual(await reopened.list({ owner }), {
      items: [{ id: created.id, title: "Example", revision: 1 }],
      nextCursor: null,
    });
    assert.equal(await reopened.readSourceVersion(address, 1), initialHtml);
  });
});

test("staging alone never replaces current source or compatible saved state", async () => {
  await withStorage(async (storage, directory) => {
    const created = await storage.create({ owner, title: "Recovery", html: initialHtml });
    const address = { owner, id: created.id };
    const before = await storage.saveState({
      ...address,
      revision: 1,
      stateRevision: 1,
      snapshot: { state: { x: 12 }, selection: "x" },
    });
    const staged = await storage.stageSource({
      ...address,
      revision: 1,
      html: "<p>Replacement</p>",
    });
    assert.equal(staged.revision, 2);
    assert.deepEqual(staged.snapshot, before.snapshot);
    assert.deepEqual(await storage.get(address), before);
    assert.deepEqual(await new VisualStorage(directory).get(address), before);
    const committed = await storage.commitSource({
      ...address,
      previousRevision: 1,
      revision: staged.revision,
      stateRevision: before.stateRevision,
      snapshot: staged.snapshot,
    });
    assert.equal(committed.revision, 2);
    assert.deepEqual(committed.snapshot, before.snapshot);
    assert.equal(await storage.readSourceVersion(address, 1), initialHtml);
    assert.equal(await storage.readSourceVersion(address, 2), "<p>Replacement</p>");
    assert.deepEqual(await new VisualStorage(directory).get(address), committed);
  });
});

test("same cwd or guessed artifact ID grants no access across agent/session owners", async () => {
  await withStorage(async (storage) => {
    const created = await storage.create({ owner, title: "Private", html: initialHtml });
    for (const other of [
      { ...owner, agentId: "agent-two" },
      { ...owner, sessionId: "session-two" },
    ]) {
      assert.deepEqual(await storage.list({ owner: other }), { items: [], nextCursor: null });
      await assert.rejects(storage.get({ owner: other, id: created.id }), failure("UNKNOWN_ID"));
      await assert.rejects(
        storage.stageSource({ owner: other, id: created.id, revision: 1, html: "<p>foreign</p>" }),
        failure("UNKNOWN_ID"),
      );
    }
    await assert.rejects(storage.get({ owner, id: "../../outside" }));
    assert.equal((await storage.get({ owner, id: created.id })).html, initialHtml);
  });
});

test("concurrent state compare-and-swap accepts exactly one writer", async () => {
  await withStorage(async (storage) => {
    const created = await storage.create({ owner, title: "Concurrent", html: initialHtml });
    const address = { owner, id: created.id };
    const first = storage.saveState({
      ...address,
      revision: 1,
      stateRevision: 1,
      snapshot: { state: "first", selection: null },
    });
    const second = storage.saveState({
      ...address,
      revision: 1,
      stateRevision: 1,
      snapshot: { state: "second", selection: null },
    });
    const [accepted, rejected] = await Promise.allSettled([first, second]);
    assert.equal(accepted?.status, "fulfilled");
    assert.equal(rejected?.status, "rejected");
    if (rejected?.status !== "rejected") throw new Error("Expected stale writer rejection");
    assert.equal(failure("STALE_STATE")(rejected.reason), true);
    assert.deepEqual((await storage.get(address)).snapshot, { state: "first", selection: null });
    const third = await storage.saveState({
      ...address,
      revision: 1,
      stateRevision: 2,
      snapshot: { state: "third", selection: null },
    });
    assert.equal(third.stateRevision, 3, "A failed operation must release the serialization lock");
  });
});

test("local interaction during replacement is not overwritten by a late render receipt", async () => {
  await withStorage(async (storage) => {
    const created = await storage.create({ owner, title: "Race", html: initialHtml });
    const address = { owner, id: created.id };
    const staged = await storage.stageSource({ ...address, revision: 1, html: "<p>new</p>" });
    const changed = await storage.saveState({
      ...address,
      revision: 1,
      stateRevision: 1,
      snapshot: { state: { x: 50 }, selection: "latest" },
    });
    await assert.rejects(
      storage.commitSource({
        ...address,
        previousRevision: 1,
        revision: staged.revision,
        stateRevision: staged.stateRevision,
        snapshot: staged.snapshot,
      }),
      failure("STALE_STATE"),
    );
    assert.deepEqual(await storage.get(address), changed);
  });
});

test("stale source and obsolete staged replacements refuse without mutation", async () => {
  await withStorage(async (storage) => {
    const created = await storage.create({ owner, title: "CAS", html: initialHtml });
    const address = { owner, id: created.id };
    const first = await storage.stageSource({ ...address, revision: 1, html: "<p>first</p>" });
    const second = await storage.stageSource({ ...address, revision: 1, html: "<p>second</p>" });
    const committed = await storage.commitSource({
      ...address,
      previousRevision: 1,
      revision: first.revision,
      stateRevision: 1,
      snapshot: first.snapshot,
    });
    await assert.rejects(
      storage.stageSource({ ...address, revision: 1, html: "<p>stale</p>" }),
      failure("STALE_REVISION"),
    );
    await assert.rejects(
      storage.commitSource({
        ...address,
        previousRevision: 2,
        revision: second.revision,
        stateRevision: committed.stateRevision,
        snapshot: second.snapshot,
      }),
      failure("STALE_REVISION"),
    );
    await assert.rejects(
      storage.saveState({
        ...address,
        revision: 1,
        stateRevision: committed.stateRevision,
        snapshot: second.snapshot,
      }),
      failure("STALE_REVISION"),
    );
    assert.deepEqual(await storage.get(address), committed);
  });
});

test("invalid snapshots and corrupt persisted records fail loudly", async () => {
  await withStorage(async (storage, directory) => {
    const created = await storage.create({ owner, title: "Validation", html: initialHtml });
    const address = { owner, id: created.id };
    await assert.rejects(
      storage.saveState({
        ...address,
        revision: 1,
        stateRevision: 1,
        snapshot: { state: "x".repeat(32769), selection: null },
      }),
      failure("INVALID_DATA"),
    );
    assert.deepEqual(await storage.get(address), created);
    const scopes = await readdir(directory);
    const scope = scopes[0];
    if (scope === undefined) throw new Error("Storage scope was not created");
    await writeFile(join(directory, scope, `${created.id}.json`), "{invalid");
    await assert.rejects(storage.get(address), failure("CORRUPT_STORAGE"));
    await assert.rejects(storage.list({ owner }), failure("CORRUPT_STORAGE"));
  });
});

test("a real immutable-version write failure leaves the prior source and state recoverable", async () => {
  await withStorage(async (storage, directory) => {
    const created = await storage.create({ owner, title: "Write failure", html: initialHtml });
    const address = { owner, id: created.id };
    const before = await storage.saveState({
      ...address,
      revision: 1,
      stateRevision: 1,
      snapshot: { state: { value: 7 }, selection: "value" },
    });
    const scope = (await readdir(directory))[0];
    if (!scope) throw new Error("Missing storage scope");
    await mkdir(join(directory, scope, created.id, "source-2.json"));
    await assert.rejects(
      storage.stageSource({ ...address, revision: 1, html: "<p>must not replace</p>" }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "EEXIST",
    );
    assert.deepEqual(await storage.get(address), before);
    assert.deepEqual(await new VisualStorage(directory).get(address), before);
    assert.equal(await storage.readSourceVersion(address, 1), initialHtml);
  });
});

test("bounded listing has stable, scoped pagination with no missing or duplicate IDs", async () => {
  await withStorage(async (storage) => {
    const ids: string[] = [];
    for (let index = 0; index < 51; index += 1) {
      ids.push((await storage.create({ owner, title: `Example ${index}`, html: initialHtml })).id);
    }
    const first = await storage.list({ owner });
    assert.equal(first.items.length, 50);
    assert.notEqual(first.nextCursor, null);
    if (first.nextCursor === null) throw new Error("Missing next cursor");
    const second = await storage.list({ owner, cursor: first.nextCursor });
    assert.equal(second.items.length, 1);
    assert.equal(second.nextCursor, null);
    assert.deepEqual(
      [...first.items, ...second.items].map((item) => item.id),
      ids.sort(),
    );
    await assert.rejects(
      storage.list({ owner, cursor: "00000000-0000-4000-8000-000000000000" }),
      failure("INVALID_CURSOR"),
    );
  });
});
