// Supervisor-owned acceptance contract. Implementers may not edit this file.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { VisualStorage } from "../../../packages/server/src/server/pi-workspace/storage.ts";
const owner = { agentId: "review-library-agent", sessionId: "review-library-session" };
async function withStore(run) {
  const root = await mkdtemp(join(tmpdir(), "review-library-"));
  const store = new VisualStorage(root);
  try {
    await run(store, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function snapshot(value) {
  return { state: { value }, selection: { id: "value", text: String(value) } };
}
async function replace(store, current, html) {
  const address = { owner, id: current.id };
  const staged = await store.stageSource({ ...address, revision: current.revision, html });
  return store.commitSource({
    ...address,
    previousRevision: current.revision,
    revision: staged.revision,
    stateRevision: current.stateRevision,
    snapshot: current.snapshot,
  });
}
function libraryApi(store) {
  assert.equal(
    typeof store.listVersions,
    "function",
    "Missing user-facing committed-version history",
  );
  assert.equal(
    typeof store.getVersion,
    "function",
    "Missing non-destructive historical document read",
  );
}

test("library pages more than fifty distinct drawings without clipping, aliasing or cross-session access", async () => {
  await withStore(async (store) => {
    const ids = [];
    for (let i = 0; i < 103; i++) {
      const doc = await store.create({ owner, title: "Drawing " + i, html: "<p>" + i + "</p>" });
      ids.push(doc.id);
    }
    const first = await store.list({ owner });
    assert.equal(first.items.length, 50);
    assert.equal(typeof first.nextCursor, "string");
    const second = await store.list({ owner, cursor: first.nextCursor });
    assert.equal(second.items.length, 50);
    const third = await store.list({ owner, cursor: second.nextCursor });
    assert.equal(third.items.length, 3);
    assert.equal(third.nextCursor, null);
    assert.deepEqual(
      [...first.items, ...second.items, ...third.items].map((x) => x.id).sort(),
      ids.sort(),
    );
    const foreign = { agentId: owner.agentId, sessionId: "another-session" };
    assert.deepEqual(await store.list({ owner: foreign }), { items: [], nextCursor: null });
    await assert.rejects(
      () => store.get({ owner: foreign, id: ids[0] }),
      (e) => e.code === "UNKNOWN_ID",
    );
    libraryApi(store);
  });
});

test("committed source versions exclude abandoned stages and survive a storage reopen", async () => {
  await withStore(async (store, root) => {
    libraryApi(store);
    let current = await store.create({ owner, title: "A drawing", html: "<p>one</p>" });
    const address = { owner, id: current.id };
    current = await store.saveState({
      ...address,
      revision: current.revision,
      stateRevision: current.stateRevision,
      snapshot: snapshot(7),
    });
    const abandoned = await store.stageSource({
      ...address,
      revision: 1,
      html: "<p>failed stage</p>",
    });
    current = await replace(store, current, "<p>two</p>");
    assert(current.revision > abandoned.revision);
    const page = await store.listVersions(address);
    assert.deepEqual(
      page.items.map((x) => x.revision),
      [current.revision, 1],
    );
    assert.equal(page.nextCursor, null);
    await assert.rejects(
      () => store.getVersion({ ...address, revision: abandoned.revision }),
      (e) => e.code === "UNKNOWN_REVISION",
    );
    const reopened = new VisualStorage(root);
    const old = await reopened.getVersion({ ...address, revision: 1 });
    assert.equal(old.id, current.id);
    assert.equal(old.html, "<p>one</p>");
    assert.deepEqual(old.snapshot, snapshot(7));
    assert.equal((await reopened.get(address)).html, "<p>two</p>");
    assert.deepEqual(
      (await reopened.listVersions(address)).items.map((x) => x.revision),
      [current.revision, 1],
    );
  });
});

test("viewing history does not replace latest source/state or make stale writes authoritative", async () => {
  await withStore(async (store) => {
    libraryApi(store);
    let first = await store.create({ owner, title: "Selected", html: "<p>original</p>" });
    const address = { owner, id: first.id };
    first = await store.saveState({
      ...address,
      revision: first.revision,
      stateRevision: first.stateRevision,
      snapshot: snapshot(2),
    });
    let latest = await replace(store, first, "<p>latest</p>");
    latest = await store.saveState({
      ...address,
      revision: latest.revision,
      stateRevision: latest.stateRevision,
      snapshot: snapshot(9),
    });
    const before = await store.get(address);
    const old = await store.getVersion({ ...address, revision: first.revision });
    assert.equal(old.revision, 1);
    assert.deepEqual(old.snapshot, snapshot(2));
    assert.deepEqual(await store.get(address), before);
    assert.deepEqual(await store.getVersion({ ...address, revision: latest.revision }), before);
    await assert.rejects(
      () =>
        store.saveState({
          ...address,
          revision: 1,
          stateRevision: old.stateRevision,
          snapshot: snapshot(99),
        }),
      (e) => e.code === "STALE_REVISION",
    );
    assert.deepEqual(await store.get(address), before);
    const foreign = { ...owner, agentId: "foreign" };
    await assert.rejects(
      () => store.listVersions({ owner: foreign, id: first.id }),
      (e) => e.code === "UNKNOWN_ID",
    );
    await assert.rejects(
      () => store.getVersion({ owner: foreign, id: first.id, revision: 1 }),
      (e) => e.code === "UNKNOWN_ID",
    );
  });
});

test("source history is paginated independently from interaction state changes", async () => {
  await withStore(async (store) => {
    libraryApi(store);
    let current = await store.create({ owner, title: "Versioned", html: "<p>0</p>" });
    const revisions = [current.revision];
    for (let i = 1; i <= 55; i++) {
      current = await replace(store, current, "<p>" + i + "</p>");
      revisions.push(current.revision);
    }
    const address = { owner, id: current.id };
    for (let i = 0; i < 5; i++)
      current = await store.saveState({
        ...address,
        revision: current.revision,
        stateRevision: current.stateRevision,
        snapshot: snapshot(i),
      });
    const first = await store.listVersions(address);
    assert.equal(first.items.length, 50);
    assert.equal(typeof first.nextCursor, "number");
    const rest = await store.listVersions({ ...address, cursor: first.nextCursor });
    assert.equal(rest.items.length, 6);
    assert.equal(rest.nextCursor, null);
    assert.deepEqual(
      [...first.items, ...rest.items].map((x) => x.revision),
      revisions.toReversed(),
    );
    await assert.rejects(
      () => store.listVersions({ ...address, cursor: 99999 }),
      (e) => e.code === "INVALID_CURSOR",
    );
  });
});
