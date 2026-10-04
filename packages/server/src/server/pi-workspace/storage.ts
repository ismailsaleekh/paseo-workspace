import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  VisualFailure,
  VisualIdSchema,
  VisualOwnerSchema,
  VisualRevisionSchema,
  VISUAL_FRAME_BYTES,
  parseVisualSnapshot,
  validateVisualHtml,
  type VisualDocument,
  type VisualOwner,
  type VisualSnapshot,
} from "@getpaseo/protocol/pi-workspace/contracts";

const StoredVisualSchema = z
  .object({
    format: z.literal(1),
    id: VisualIdSchema,
    owner: VisualOwnerSchema,
    title: z.string().min(1).max(256),
    revision: VisualRevisionSchema,
    nextRevision: VisualRevisionSchema,
    stateRevision: VisualRevisionSchema,
    stateFile: VisualIdSchema,
  })
  .strict();
const StoredSourceSchema = z
  .object({
    revision: VisualRevisionSchema,
    previousRevision: z.number().int().nonnegative(),
    html: z.string(),
  })
  .strict();
const StoredSnapshotSchema = z
  .object({
    stateRevision: VisualRevisionSchema,
    snapshot: z.unknown(),
  })
  .strict();
type StoredVisual = z.infer<typeof StoredVisualSchema>;

export interface CreateVisualInput {
  owner: VisualOwner;
  title: string;
  html: string;
}
export interface VisualAddress {
  owner: VisualOwner;
  id: string;
}
export interface StageVisualSourceInput extends VisualAddress {
  revision: number;
  html: string;
}
export interface CommitVisualSourceInput extends VisualAddress {
  previousRevision: number;
  revision: number;
  stateRevision: number;
  snapshot: VisualSnapshot;
}
export interface SaveVisualStateInput extends VisualAddress {
  revision: number;
  stateRevision: number;
  snapshot: VisualSnapshot;
}
export interface ListVisualsInput {
  owner: VisualOwner;
  cursor?: string;
}
export interface VisualListItem {
  id: string;
  title: string;
  revision: number;
}
export interface VisualPage {
  items: VisualListItem[];
  nextCursor: string | null;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readJson(filename: string): Promise<unknown> {
  const file = await open(filename, "r");
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > VISUAL_FRAME_BYTES) {
      throw new VisualFailure(
        "CORRUPT_STORAGE",
        "Visual storage record is not a bounded regular file",
      );
    }
    const bytes = Buffer.alloc(metadata.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length !== metadata.size)
      throw new VisualFailure("CORRUPT_STORAGE", "Visual storage record changed during read");
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
      const parsed: unknown = JSON.parse(text);
      return parsed;
    } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
      throw new VisualFailure("CORRUPT_STORAGE", "Visual storage contains invalid UTF-8 or JSON");
    }
  } finally {
    await file.close();
  }
}

async function writeDurableJson(filename: string, value: unknown): Promise<void> {
  const file = await open(filename, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value), "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const file = await open(directory, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

/** One instance per daemon. Immutable source/state files precede an atomic current pointer. */
export class VisualStorage {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  constructor(private readonly directory: string) {}

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending >= 128) throw new VisualFailure("BUSY", "Visual storage queue is full");
    this.pending += 1;
    const previous = this.tail;
    let release: () => void = () => {
      throw new Error("Storage lock was not initialized");
    };
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      this.pending -= 1;
      // Only the lock barrier resolves here; operation failures propagate to their caller.
      release();
    }
  }

  private scope(owner: VisualOwner): string {
    const parsed = VisualOwnerSchema.parse(owner);
    const digest = createHash("sha256")
      .update(JSON.stringify([parsed.agentId, parsed.sessionId]))
      .digest("hex");
    return join(this.directory, digest);
  }

  private location(address: VisualAddress): string {
    return join(this.scope(address.owner), VisualIdSchema.parse(address.id));
  }

  private async load(address: VisualAddress): Promise<StoredVisual> {
    let value: unknown;
    try {
      value = await readJson(`${this.location(address)}.json`);
    } catch (error) {
      if (isMissing(error))
        throw new VisualFailure("UNKNOWN_ID", "Visual is not stored in this conversation");
      throw error;
    }
    const parsed = StoredVisualSchema.safeParse(value);
    if (!parsed.success) throw new VisualFailure("CORRUPT_STORAGE", "Invalid visual metadata");
    const record = parsed.data;
    if (
      record.id !== address.id ||
      record.owner.agentId !== address.owner.agentId ||
      record.owner.sessionId !== address.owner.sessionId
    ) {
      throw new VisualFailure(
        "CORRUPT_STORAGE",
        "Visual metadata does not match its storage identity",
      );
    }
    return record;
  }

  private async replace(record: StoredVisual): Promise<void> {
    const scope = this.scope(record.owner);
    const temporary = join(scope, `.${record.id}.${randomUUID()}.tmp`);
    try {
      await writeDurableJson(temporary, record);
      await rename(temporary, join(scope, `${record.id}.json`));
      await syncDirectory(scope);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  private async source(
    address: VisualAddress,
    revision: number,
  ): Promise<z.infer<typeof StoredSourceSchema>> {
    VisualRevisionSchema.parse(revision);
    const value = await readJson(join(this.location(address), `source-${revision}.json`));
    const parsed = StoredSourceSchema.safeParse(value);
    if (!parsed.success || parsed.data.revision !== revision) {
      throw new VisualFailure("CORRUPT_STORAGE", "Invalid visual source version");
    }
    validateVisualHtml(parsed.data.html);
    return parsed.data;
  }

  private async document(record: StoredVisual): Promise<VisualDocument> {
    const address = { owner: record.owner, id: record.id };
    const value = await readJson(join(this.location(address), `state-${record.stateFile}.json`));
    const parsed = StoredSnapshotSchema.safeParse(value);
    if (!parsed.success || parsed.data.stateRevision !== record.stateRevision) {
      throw new VisualFailure("CORRUPT_STORAGE", "Invalid visual state version");
    }
    return {
      id: record.id,
      title: record.title,
      revision: record.revision,
      stateRevision: record.stateRevision,
      html: (await this.source(address, record.revision)).html,
      snapshot: parseVisualSnapshot(parsed.data.snapshot),
    };
  }

  async create(input: CreateVisualInput): Promise<VisualDocument> {
    const owner = VisualOwnerSchema.parse(input.owner);
    const title = StoredVisualSchema.shape.title.parse(input.title);
    const html = validateVisualHtml(input.html);
    return this.serialized(async () => {
      const id = randomUUID();
      const address = { owner, id };
      const location = this.location(address);
      const stateFile = randomUUID();
      const snapshot: VisualSnapshot = { state: null, selection: null };
      await mkdir(location, { recursive: true, mode: 0o700 });
      await writeDurableJson(join(location, "source-1.json"), {
        revision: 1,
        previousRevision: 0,
        html,
      });
      await writeDurableJson(join(location, `state-${stateFile}.json`), {
        stateRevision: 1,
        snapshot,
      });
      await syncDirectory(location);
      const record: StoredVisual = {
        format: 1,
        id,
        owner,
        title,
        revision: 1,
        nextRevision: 2,
        stateRevision: 1,
        stateFile,
      };
      await this.replace(record);
      return { id, title, revision: 1, stateRevision: 1, html, snapshot };
    });
  }

  async get(address: VisualAddress): Promise<VisualDocument> {
    return this.serialized(async () => this.document(await this.load(address)));
  }

  async list(input: ListVisualsInput): Promise<VisualPage> {
    if (input.cursor !== undefined) VisualIdSchema.parse(input.cursor);
    return this.serialized(async () => {
      let names: string[];
      try {
        names = await readdir(this.scope(input.owner));
      } catch (error) {
        if (isMissing(error)) return { items: [], nextCursor: null };
        throw error;
      }
      const ids = names
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -5))
        .sort();
      if (input.cursor !== undefined && !ids.includes(input.cursor)) {
        throw new VisualFailure(
          "INVALID_CURSOR",
          "Visual list cursor does not belong to this conversation",
        );
      }
      const cursor = input.cursor;
      const after = cursor === undefined ? ids : ids.filter((id) => id > cursor);
      const pageIds = after.slice(0, 50);
      const items: VisualListItem[] = [];
      for (const id of pageIds) {
        const record = await this.load({ owner: input.owner, id });
        items.push({ id, title: record.title, revision: record.revision });
      }
      const last = items.at(-1);
      return { items, nextCursor: after.length > 50 && last ? last.id : null };
    });
  }

  async saveState(input: SaveVisualStateInput): Promise<VisualDocument> {
    const snapshot = parseVisualSnapshot(input.snapshot);
    return this.serialized(async () => {
      const record = await this.load(input);
      this.checkRevision(record, input.revision, input.stateRevision);
      const updated = await this.writeState(record, snapshot);
      await this.replace(updated);
      return this.document(updated);
    });
  }

  async stageSource(input: StageVisualSourceInput): Promise<VisualDocument> {
    const html = validateVisualHtml(input.html);
    return this.serialized(async () => {
      const record = await this.load(input);
      if (record.revision !== input.revision)
        throw new VisualFailure("STALE_REVISION", "Visual source revision has changed");
      const revision = record.nextRevision;
      VisualRevisionSchema.parse(revision + 1);
      // Reserve a revision durably before writing it: interrupted staging never reuses an identity.
      await this.replace({ ...record, nextRevision: revision + 1 });
      const location = this.location(input);
      await writeDurableJson(join(location, `source-${revision}.json`), {
        revision,
        previousRevision: record.revision,
        html,
      });
      await syncDirectory(location);
      return { ...(await this.document(record)), revision, html };
    });
  }

  async commitSource(input: CommitVisualSourceInput): Promise<VisualDocument> {
    const snapshot = parseVisualSnapshot(input.snapshot);
    return this.serialized(async () => {
      const record = await this.load(input);
      this.checkRevision(record, input.previousRevision, input.stateRevision);
      if (input.revision <= record.revision || input.revision >= record.nextRevision) {
        throw new VisualFailure(
          "STALE_REVISION",
          "Visual replacement was not staged against this source",
        );
      }
      const staged = await this.source(input, input.revision);
      if (staged.previousRevision !== record.revision) {
        throw new VisualFailure("STALE_REVISION", "Visual replacement belongs to an older source");
      }
      const updated = await this.writeState({ ...record, revision: input.revision }, snapshot);
      await this.replace(updated);
      return this.document(updated);
    });
  }

  async readSourceVersion(address: VisualAddress, revision: number): Promise<string> {
    return this.serialized(async () => {
      const record = await this.load(address);
      if (revision >= record.nextRevision)
        throw new VisualFailure("UNKNOWN_REVISION", "Visual source version does not exist");
      return (await this.source(address, revision)).html;
    });
  }

  private checkRevision(record: StoredVisual, revision: number, stateRevision: number): void {
    if (record.revision !== revision)
      throw new VisualFailure("STALE_REVISION", "Visual source revision has changed");
    if (record.stateRevision !== stateRevision)
      throw new VisualFailure("STALE_STATE", "Visual interaction state has changed");
  }

  private async writeState(record: StoredVisual, snapshot: VisualSnapshot): Promise<StoredVisual> {
    const stateRevision = VisualRevisionSchema.parse(record.stateRevision + 1);
    const stateFile = randomUUID();
    const location = this.location({ owner: record.owner, id: record.id });
    await writeDurableJson(join(location, `state-${stateFile}.json`), { stateRevision, snapshot });
    await syncDirectory(location);
    return { ...record, stateRevision, stateFile };
  }
}
