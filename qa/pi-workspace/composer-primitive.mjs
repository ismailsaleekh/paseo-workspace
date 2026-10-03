#!/usr/bin/env node
// Judge-owned prerequisite guard for the existing ordinary composer path, not full voice acceptance.
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const source = path.join(process.cwd(), "packages/app/src/composer/input/state.ts");
const { applyDictationTranscript } = await import(pathToFileURL(source).href);
const spoken = "I think Tuesday—no, Wednesday; I'm not certain. Keep 3.5%, not 35%.";
const typed = "Already typed: ";
const combined = typed + spoken;

function observe(overrides) {
  const replacements = [];
  const submitted = [];
  const queued = [];
  const context = {
    value: typed,
    defaultSendBehavior: "queue",
    isAgentRunning: false,
    attachments: [],
    cwd: "/fixture/workspace",
    autoSend: false,
    replaceText: (text) => replacements.push(text),
    onSubmit: (payload) => submitted.push(payload),
    onQueue: (payload) => queued.push(payload),
    ...overrides,
  };
  applyDictationTranscript(spoken, context);
  return { replacements, submitted, queued };
}

const draft = observe({});
assert.deepEqual(draft.replacements, [combined]);
assert.deepEqual(draft.submitted, []);
assert.deepEqual(draft.queued, []);

const busy = observe({ autoSend: true, isAgentRunning: true });
assert.deepEqual(busy.queued, [{ text: combined, attachments: [], cwd: "/fixture/workspace" }]);
assert.deepEqual(busy.submitted, []);
assert.deepEqual(busy.replacements, [combined, ""]);

const idle = observe({ autoSend: true });
assert.deepEqual(idle.submitted, [
  {
    text: combined,
    attachments: [],
    cwd: "/fixture/workspace",
    forceSend: undefined,
  },
]);
assert.deepEqual(idle.queued, []);
assert.deepEqual(idle.replacements, [combined]);

const noTrailingSpace = observe({ value: "Typed while recognizing." });
assert.deepEqual(noTrailingSpace.replacements, [`Typed while recognizing. ${spoken}`]);
console.log(
  "PASS existing composer preserves recognized words and uses ordinary draft/queue/submit",
);
