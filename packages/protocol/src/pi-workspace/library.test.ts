import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "../messages.js";
import {
  DesktopVisualBoundsUpdateSchema,
  encodeVisualView,
  decodeVisualView,
  VisualLibraryRequestSchema,
} from "./rpc-schemas.js";
import { VisualLibraryPageSchema, VisualVersionsPageSchema } from "./contracts.js";

test("library wire contracts preserve old observations and bounded committed history pages", () => {
  expect(
    SessionInboundMessageSchema.parse({
      type: "pi_workspace.observe.request",
      requestId: "old",
      agentId: "a",
    }),
  ).toEqual({ type: "pi_workspace.observe.request", requestId: "old", agentId: "a" });
  const id = randomUUID();
  const generation = randomUUID();
  const request = {
    type: "pi_workspace.library.request",
    requestId: "read",
    agentId: "a",
    clientGeneration: generation,
    operation: { kind: "select", id, revision: 2 },
  };
  expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
  expect(
    VisualLibraryRequestSchema.safeParse({ ...request, clientGeneration: "foreign-unbound" })
      .success,
  ).toBe(false);
  expect(
    VisualLibraryPageSchema.safeParse({
      items: Array.from({ length: 51 }, () => ({ id, title: "D", revision: 1 })),
      nextCursor: null,
    }).success,
  ).toBe(false);
  expect(
    VisualVersionsPageSchema.safeParse({ items: [{ revision: 0 }], nextCursor: null }).success,
  ).toBe(false);
  const view = {
    generation,
    sequence: 0,
    current: {
      binding: { id, revision: 2, clientGeneration: generation, nonce: randomUUID() },
      document: {
        id,
        title: "D",
        revision: 2,
        stateRevision: 1,
        html: "<p>D</p>",
        snapshot: { state: { value: 3 }, selection: null },
        historyState: "initial" as const,
      },
    },
  };
  const wire = encodeVisualView(view);
  expect(decodeVisualView(wire)).toEqual(view);
  expect(
    SessionOutboundMessageSchema.parse({
      type: "pi_workspace.library.response",
      payload: { requestId: "read", agentId: "a", result: { kind: "view", view: wire } },
    }),
  ).toMatchObject({ payload: { result: { view: wire } } });
  const bounds = {
    nonce: view.current.binding.nonce,
    bounds: { x: 0, y: 0, width: 400, height: 300 },
  };
  expect(DesktopVisualBoundsUpdateSchema.parse(bounds)).toEqual(bounds);
  expect(DesktopVisualBoundsUpdateSchema.parse({ ...bounds, occluded: true })).toEqual({
    ...bounds,
    occluded: true,
  });
});
