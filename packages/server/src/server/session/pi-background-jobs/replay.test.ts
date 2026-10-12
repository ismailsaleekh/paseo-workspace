import { describe, expect, test } from "vitest";
import { MutationReplay, ReplayRefusal, canonicalJson, type ReplayOutcome } from "./replay.js";

function deferred<T>() {
  const handle: { resolve: (value: T) => void } = { resolve: () => {} };
  const promise = new Promise<T>((accept) => {
    handle.resolve = accept;
  });
  return { promise, resolve: (value: T) => handle.resolve(value) };
}

function ok(value: string): ReplayOutcome<string> {
  return { ok: true, value };
}

describe("MutationReplay", () => {
  test("a concurrent repeat joins the pending execution instead of running again", async () => {
    const replay = new MutationReplay<string>();
    const gate = deferred<ReplayOutcome<string>>();
    let runs = 0;
    const execute = () => {
      runs += 1;
      return gate.promise;
    };
    const first = replay.run("scope", 1, "rerun:a", execute);
    const second = replay.run("scope", 1, "rerun:a", execute);
    gate.resolve(ok("task-2"));
    await expect(first).resolves.toEqual(ok("task-2"));
    await expect(second).resolves.toEqual(ok("task-2"));
    expect(runs).toBe(1);
  });

  test("a completed repeat replays its outcome, including failures", async () => {
    const replay = new MutationReplay<string>();
    let runs = 0;
    const failing = async (): Promise<ReplayOutcome<string>> => {
      runs += 1;
      throw new Error("host failed");
    };
    const outcome = await replay.run("scope", 1, "stop:a", failing);
    expect(outcome).toEqual({ ok: false, code: "OPERATION_FAILED", message: "host failed" });
    await expect(replay.run("scope", 1, "stop:a", failing)).resolves.toEqual(outcome);
    expect(runs).toBe(1);
  });

  test("a different request with a used sequence conflicts", async () => {
    const replay = new MutationReplay<string>();
    await replay.run("scope", 1, "stop:a", async () => ok("x"));
    const conflicting = () => replay.run("scope", 1, "stop:b", async () => ok("y"));
    expect(conflicting).toThrow(ReplayRefusal);
  });

  test("an evicted sequence is stale and never executes again", async () => {
    const replay = new MutationReplay<string>({ entries: 64, bytes: 2 * 1024 * 1024 });
    let reruns = 0;
    await replay.run("scope", 1, "rerun:a", async () => {
      reruns += 1;
      return ok("first");
    });
    for (let sequence = 2; sequence <= 70; sequence += 1)
      await replay.run("scope", sequence, `stop:${sequence}`, async () => ok("stopped"));
    let refusal: unknown;
    try {
      void replay.run("scope", 1, "rerun:a", async () => {
        reruns += 1;
        return ok("again");
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ReplayRefusal);
    expect(refusal instanceof ReplayRefusal ? refusal.code : null).toBe("STALE_REQUEST");
    expect(reruns).toBe(1);
  });

  test("the byte bound evicts too, and the high-water fence still holds", async () => {
    const replay = new MutationReplay<string>({ entries: 64, bytes: 4096 });
    const large = "x".repeat(3000);
    await replay.run("scope", 1, "a", async () => ok(large));
    await replay.run("scope", 2, "b", async () => ok(large));
    const evicted = () => replay.run("scope", 1, "a", async () => ok(large));
    expect(evicted).toThrow(/high-water/);
    await expect(replay.run("scope", 2, "b", async () => ok("unused"))).resolves.toEqual(ok(large));
  });

  test("retained bytes count each request fingerprint, not only its outcome", async () => {
    const replay = new MutationReplay<string>({ entries: 64, bytes: 4096 });
    const fingerprint = "f".repeat(3000);
    await replay.run("scope", 1, `${fingerprint}1`, async () => ok("x"));
    await replay.run("scope", 2, `${fingerprint}2`, async () => ok("x"));
    const evicted = () => replay.run("scope", 1, `${fingerprint}1`, async () => ok("x"));
    expect(evicted).toThrow(/high-water/);
  });

  test("a new generation releases the old ledgers of the same subscription only", async () => {
    const replay = new MutationReplay<string>();
    for (let generation = 0; generation < 50; generation += 1) {
      const keep = `sub-1\u0000rt-${generation}\u0000act`;
      replay.retainOnly("sub-1\u0000", keep);
      await replay.run(keep, 1, "stop", async () => ok("done"));
    }
    await replay.run("sub-2\u0000rt\u0000act", 1, "stop", async () => ok("other"));
    expect(replay.scopeCount).toBe(2);
  });

  test("scopes are independent and a released subscription forgets its scopes", async () => {
    const replay = new MutationReplay<string>();
    await replay.run("sub-1\u0000rt\u0000act", 5, "a", async () => ok("one"));
    await expect(
      replay.run("sub-2\u0000rt\u0000act", 1, "a", async () => ok("two")),
    ).resolves.toEqual(ok("two"));
    replay.forgetPrefix("sub-1\u0000");
    expect(replay.scopeCount).toBe(1);
  });
});

test("canonical JSON ignores key order and keeps array order", () => {
  expect(canonicalJson({ b: [2, 1], a: { d: 1, c: null } })).toBe(
    canonicalJson({ a: { c: null, d: 1 }, b: [2, 1] }),
  );
  expect(canonicalJson({ ids: ["a", "b"] })).not.toBe(canonicalJson({ ids: ["b", "a"] }));
});
