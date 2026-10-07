import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { test } from "vitest";
import { z } from "zod";
import type {
  VisualReceipt,
  VisualRenderDocument,
} from "@getpaseo/protocol/pi-workspace/rpc-schemas";
import {
  DocumentMessageSchema,
  visualAcknowledgementMessage,
  visualDocumentHtml,
  visualStateMessage,
} from "./document-bridge";

const id = "25afcecf-bc68-4c7f-b408-2640ed2a0026";
const nonce = "7c6c0224-4617-4c5b-bbfe-03c3c330c608";
const generation = "b5bed943-2cd8-48bd-ab77-8808b6284674";
const renderId = "0b8b0f4e-8d0c-4b38-9e0c-6f0f8f6a2a11";
const current: VisualRenderDocument = {
  binding: { id, revision: 1, nonce, clientGeneration: generation },
  document: {
    id,
    title: "Bridge test",
    revision: 1,
    stateRevision: 1,
    html: "<p>fields</p>",
    snapshot: { state: null, selection: null },
  },
};
const FieldsSchema = z.object({ state: z.object({ text: z.string() }), selection: z.null() });

type Listener = (event: unknown) => unknown;
interface Registration {
  read(): unknown;
  restore(snapshot: unknown): void;
  actions: Record<string, never>;
}
interface PaseoVisual {
  register(registration: Registration): void;
  publish(): void;
}
function isPaseoVisual(value: unknown): value is PaseoVisual {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "register") === "function" &&
    typeof Reflect.get(value, "publish") === "function"
  );
}

/**
 * Runs the bridge script exactly as `visualDocumentHtml` builds it, in its own JavaScript realm,
 * with the smallest host surface it uses on the web: window events in, parent messages out.
 */
class DocumentHost {
  readonly receipts: VisualReceipt[] = [];
  readonly restored: string[] = [];
  text = "";
  private readonly listeners = new Map<string, Listener[]>();
  private readonly parent = {
    postMessage: (message: unknown) => {
      // Normalize into this realm; the shipped schema validates what the app would receive.
      const parsed = DocumentMessageSchema.parse(JSON.parse(JSON.stringify(message)));
      this.receipts.push(parsed.receipt);
    },
  };
  private readonly visual: PaseoVisual;

  constructor(commandId: string | null, document: VisualRenderDocument = current) {
    const html = visualDocumentHtml({ current: document, commandId, platform: "web" });
    const open = html.indexOf("<script>");
    const start = open + "<script>".length;
    const end = html.indexOf("</script>", start);
    assert.ok(open !== -1 && end > start, "The bridge script is missing");
    const window = {
      parent: this.parent,
      addEventListener: (type: string, listener: Listener) => {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      },
    };
    runInContext(html.slice(start, end), createContext({ window, structuredClone }));
    const visual: unknown = Reflect.get(window, "paseoVisual");
    if (!isPaseoVisual(visual)) throw new Error("The bridge did not expose paseoVisual");
    this.visual = visual;
    this.visual.register({
      read: () => ({ state: { text: this.text }, selection: null }),
      restore: (snapshot) => {
        const restored = FieldsSchema.parse(snapshot).state.text;
        this.restored.push(restored);
        this.text = restored;
      },
      actions: {},
    });
  }

  async load(): Promise<void> {
    this.dispatch("load", {});
    await settle();
  }

  /** A user edit that the document publishes, as the fixture page does on every input event. */
  edit(text: string): void {
    this.text = text;
    this.visual.publish();
  }

  async stored(stateRevision: number, text: string): Promise<void> {
    const document = {
      ...current.document,
      stateRevision,
      snapshot: { state: { text }, selection: null },
    };
    this.dispatch("message", {
      source: this.parent,
      data: visualStateMessage({ binding: current.binding, document }),
    });
    await settle();
  }

  async acknowledged(sequence: number, stateRevision: number | null): Promise<void> {
    this.dispatch("message", {
      source: this.parent,
      data: visualAcknowledgementMessage({ binding: current.binding, sequence, stateRevision }),
    });
    await settle();
  }

  async message(data: unknown): Promise<void> {
    this.dispatch("message", { source: this.parent, data });
    await settle();
  }

  published(): Array<{ sequence: number; base: number | undefined; text: string | null }> {
    return this.receipts.map((receipt) => ({
      sequence: receipt.sequence,
      base: receipt.stateRevision,
      text: receipt.error ? null : FieldsSchema.parse(receipt.snapshot).state.text,
    }));
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("edits made before a publication is acknowledged are published together on the acknowledged base and own returned states never restore", async () => {
  const host = new DocumentHost(renderId);
  await host.load();
  host.edit("H");
  host.edit("He");
  host.edit("Hel");
  assert.deepEqual(host.published(), [
    { sequence: 1, base: 1, text: "" },
    { sequence: 2, base: 1, text: "H" },
  ]);
  // The render commit and the first publication come back while newer edits are local.
  await host.stored(2, "");
  await host.stored(3, "H");
  assert.equal(host.text, "Hel");
  await host.acknowledged(2, 3);
  host.edit("Hell");
  await host.stored(4, "Hel");
  await host.acknowledged(3, 4);
  assert.deepEqual(host.published(), [
    { sequence: 1, base: 1, text: "" },
    { sequence: 2, base: 1, text: "H" },
    { sequence: 3, base: 3, text: "Hel" },
    { sequence: 4, base: 4, text: "Hell" },
  ]);
  assert.deepEqual(host.restored, []);
  assert.equal(host.text, "Hell");
});

test("an unchanged publication is acknowledged without a returned state and repeated or older revisions never roll back", async () => {
  const host = new DocumentHost(null);
  await host.load();
  host.edit("a");
  assert.deepEqual(host.published(), [{ sequence: 1, base: 1, text: "" }]);
  await host.acknowledged(1, 1);
  await host.stored(2, "a");
  host.edit("ab");
  // The same stored revision again (normal synchronization, then stale-state recovery) and an
  // older one: none of them may replace the newer local state.
  await host.stored(2, "a");
  await host.stored(1, "");
  assert.equal(host.text, "ab");
  await host.acknowledged(2, 2);
  assert.deepEqual(host.published(), [
    { sequence: 1, base: 1, text: "" },
    { sequence: 2, base: 1, text: "a" },
    { sequence: 3, base: 2, text: "ab" },
  ]);
  assert.deepEqual(host.restored, []);
});

test("another writer's newer state is adopted, unpublished local edits lose the conflict and the late rejection does not republish", async () => {
  const host = new DocumentHost(renderId);
  await host.load();
  host.edit("mine");
  host.edit("mine, more");
  await host.stored(2, "theirs");
  assert.deepEqual(host.restored, ["theirs"]);
  assert.equal(host.text, "theirs");
  await host.acknowledged(2, null);
  assert.equal(host.receipts.length, 2);
  host.edit("theirs!");
  assert.deepEqual(host.published(), [
    { sequence: 1, base: 1, text: "" },
    { sequence: 2, base: 1, text: "mine" },
    { sequence: 3, base: 2, text: "theirs!" },
  ]);
});

test("a publication rejected because the document's own receipt advanced the base is published again on that base", async () => {
  const host = new DocumentHost(renderId);
  await host.load();
  host.edit("H");
  // The render commit is stored after the first keystroke was published on the older base.
  await host.stored(2, "");
  await host.acknowledged(2, null);
  assert.deepEqual(host.published(), [
    { sequence: 1, base: 1, text: "" },
    { sequence: 2, base: 1, text: "H" },
    { sequence: 3, base: 2, text: "H" },
  ]);
  assert.deepEqual(host.restored, []);
});

test("a rejection that did not change the stored state waits for the next change instead of retrying", async () => {
  const host = new DocumentHost(renderId);
  await host.load();
  host.edit("too large for the daemon");
  await host.acknowledged(2, null);
  assert.equal(host.receipts.length, 2);
  host.edit("fits");
  assert.deepEqual(host.published().at(-1), { sequence: 3, base: 1, text: "fits" });
});

test("acknowledgements for other documents or other publications are ignored and malformed ones fail visibly", async () => {
  const host = new DocumentHost(renderId);
  await host.load();
  host.edit("x");
  host.edit("xy");
  await host.message(
    visualAcknowledgementMessage({
      binding: { ...current.binding, nonce: generation },
      sequence: 2,
      stateRevision: 2,
    }),
  );
  await host.acknowledged(7, 2);
  assert.equal(host.receipts.length, 2);
  await host.message({
    type: "paseo-visual-ack",
    binding: current.binding,
    sequence: 2,
    stateRevision: 0,
  });
  const failure = host.receipts.at(-1);
  assert.equal(failure?.error?.code, "DOCUMENT_ERROR");
  assert.equal(failure?.error?.message, "Invalid acknowledged state revision");
  await host.acknowledged(2, 2);
  assert.deepEqual(host.published().at(-1), { sequence: 4, base: 2, text: "xy" });
});
