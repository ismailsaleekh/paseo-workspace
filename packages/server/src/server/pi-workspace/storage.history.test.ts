import { test, expect } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { VisualStorage } from "./storage.js";

const owner = { agentId: "library", sessionId: "conversation" };
test("committed ancestry excludes abandoned stages, archives state, and preserves latest across reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "history-"));
  try {
    const store = new VisualStorage(root);
    let first = await store.create({ owner, title: "Drawing", html: "<p>one</p>" });
    const address = { owner, id: first.id };
    first = await store.saveState({
      ...address,
      revision: 1,
      stateRevision: 1,
      snapshot: { state: 7, selection: null },
    });
    const abandoned = await store.stageSource({
      ...address,
      revision: 1,
      html: "<p>abandoned</p>",
    });
    const staged = await store.stageSource({ ...address, revision: 1, html: "<p>two</p>" });
    let latest = await store.commitSource({
      ...address,
      previousRevision: 1,
      revision: staged.revision,
      stateRevision: first.stateRevision,
      snapshot: first.snapshot,
    });
    latest = await store.saveState({
      ...address,
      revision: latest.revision,
      stateRevision: latest.stateRevision,
      snapshot: { state: 9, selection: null },
    });
    const reopened = new VisualStorage(root);
    expect(await reopened.listVersions(address)).toEqual({
      items: [{ revision: latest.revision }, { revision: 1 }],
      nextCursor: null,
    });
    const old = await reopened.getVersion({ ...address, revision: 1 });
    expect(old.snapshot).toEqual(first.snapshot);
    expect(old.historyState).toBe("archived");
    expect(await reopened.get(address)).toEqual(latest);
    expect(await reopened.getVersion({ ...address, revision: latest.revision })).toEqual(latest);
    await expect(
      reopened.getVersion({ ...address, revision: abandoned.revision }),
    ).rejects.toMatchObject({ code: "UNKNOWN_REVISION" });
    await expect(
      reopened.getVersion({ owner: { ...owner, sessionId: "foreign" }, id: first.id, revision: 1 }),
    ).rejects.toMatchObject({ code: "UNKNOWN_ID" });
    await expect(
      reopened.listVersions({ ...address, cursor: abandoned.revision }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    await expect(
      reopened.saveState({
        ...address,
        revision: 1,
        stateRevision: old.stateRevision,
        snapshot: { state: 99, selection: null },
      }),
    ).rejects.toMatchObject({ code: "STALE_REVISION" });
    expect(await reopened.get(address)).toEqual(latest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy source-only ancestors are explicitly initial, and malformed ancestry fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "history-"));
  try {
    const store = new VisualStorage(root);
    const first = await store.create({ owner, title: "Legacy", html: "<p>first</p>" });
    const address = { owner, id: first.id };
    const staged = await store.stageSource({ ...address, revision: 1, html: "<p>second</p>" });
    await store.commitSource({
      ...address,
      previousRevision: 1,
      revision: staged.revision,
      stateRevision: 1,
      snapshot: first.snapshot,
    });
    const digest = createHash("sha256")
      .update(JSON.stringify([owner.agentId, owner.sessionId]))
      .digest("hex");
    const directory = join(root, digest, first.id);
    await rm(join(directory, `archive-${staged.revision}.json`));
    expect(await store.getVersion({ ...address, revision: 1 })).toMatchObject({
      historyState: "initial",
      snapshot: { state: null, selection: null },
    });
    const filename = join(directory, `source-${staged.revision}.json`);
    const source = JSON.parse(await readFile(filename, "utf8"));
    await writeFile(filename, JSON.stringify({ ...source, previousRevision: staged.revision }));
    await expect(store.listVersions(address)).rejects.toMatchObject({ code: "CORRUPT_STORAGE" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
