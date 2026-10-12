/**
 * At-most-once fence for native background-job controls.
 *
 * The scope is one source-owned subscription on one runtime activation. A repeat of the same
 * sequence and request reuses the pending or completed outcome; a conflicting repeat fails; a
 * sequence at or below the high-water mark whose outcome was evicted is refused and never runs
 * again. Completed outcomes are bounded per scope by entry count and by the UTF-8 bytes of each
 * retained outcome plus its request fingerprint. Pending work is bounded by the hub's in-flight
 * admission, and each retained observation keeps a single generation's scope.
 */

export const REPLAY_MAX_ENTRIES = 64;
export const REPLAY_MAX_BYTES = 2 * 1024 * 1024;

export type ReplayOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string };

export class ReplayRefusal extends Error {
  constructor(
    readonly code: "CONFLICT" | "STALE_REQUEST",
    message: string,
  ) {
    super(message);
    this.name = "ReplayRefusal";
  }
}

interface Completed<T> {
  fingerprint: string;
  outcome: ReplayOutcome<T>;
  bytes: number;
}

interface Scope<T> {
  highWater: number;
  pending: Map<number, { fingerprint: string; outcome: Promise<ReplayOutcome<T>> }>;
  completed: Map<number, Completed<T>>;
  bytes: number;
}

export interface ReplayLimits {
  entries: number;
  bytes: number;
}

export class MutationReplay<T> {
  private readonly scopes = new Map<string, Scope<T>>();

  constructor(
    private readonly limits: ReplayLimits = {
      entries: REPLAY_MAX_ENTRIES,
      bytes: REPLAY_MAX_BYTES,
    },
  ) {}

  /**
   * Runs `execute` at most once for this sequence. A rejected `execute` is recorded as an
   * `OPERATION_FAILED` outcome, so a repeat replays the failure instead of running again.
   */
  run(
    scopeKey: string,
    sequence: number,
    fingerprint: string,
    execute: () => Promise<ReplayOutcome<T>>,
  ): Promise<ReplayOutcome<T>> {
    const scope = this.scope(scopeKey);
    const pending = scope.pending.get(sequence);
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw conflict(sequence);
      return pending.outcome;
    }
    const completed = scope.completed.get(sequence);
    if (completed) {
      if (completed.fingerprint !== fingerprint) throw conflict(sequence);
      return Promise.resolve(completed.outcome);
    }
    if (sequence <= scope.highWater)
      throw new ReplayRefusal(
        "STALE_REQUEST",
        `Sequence ${String(sequence)} is at or below the high-water mark ${String(scope.highWater)} and its outcome is no longer retained; it was not executed again`,
      );
    scope.highWater = sequence;
    const outcome = execute()
      .then(
        (value) => value,
        (error: unknown): ReplayOutcome<T> => ({
          ok: false,
          code: "OPERATION_FAILED",
          message: error instanceof Error ? error.message : String(error),
        }),
      )
      .then((value) => {
        scope.pending.delete(sequence);
        this.retain(scope, sequence, {
          fingerprint,
          outcome: value,
          bytes: sizeOf(value) + utf8Bytes(fingerprint),
        });
        return value;
      });
    scope.pending.set(sequence, { fingerprint, outcome });
    return outcome;
  }

  /** Drops a subscription's scopes when it is released; a later subscription has a fresh ID. */
  forgetPrefix(prefix: string): void {
    for (const key of this.scopes.keys()) if (key.startsWith(prefix)) this.scopes.delete(key);
  }

  /**
   * Keeps only `keep` among the scopes under `prefix`. A subscription's earlier generations can
   * never be addressed again, so their ledgers are released instead of accumulating.
   */
  retainOnly(prefix: string, keep: string): void {
    for (const key of this.scopes.keys())
      if (key.startsWith(prefix) && key !== keep) this.scopes.delete(key);
  }

  get scopeCount(): number {
    return this.scopes.size;
  }

  private scope(key: string): Scope<T> {
    let scope = this.scopes.get(key);
    if (!scope) {
      scope = { highWater: 0, pending: new Map(), completed: new Map(), bytes: 0 };
      this.scopes.set(key, scope);
    }
    return scope;
  }

  private retain(scope: Scope<T>, sequence: number, entry: Completed<T>): void {
    scope.completed.set(sequence, entry);
    scope.bytes += entry.bytes;
    while (scope.completed.size > this.limits.entries || scope.bytes > this.limits.bytes) {
      const oldest = scope.completed.entries().next();
      if (oldest.done) break;
      scope.completed.delete(oldest.value[0]);
      scope.bytes -= oldest.value[1].bytes;
    }
  }
}

function conflict(sequence: number): ReplayRefusal {
  return new ReplayRefusal(
    "CONFLICT",
    `Sequence ${String(sequence)} was already used by a different request on this subscription`,
  );
}

function sizeOf(outcome: ReplayOutcome<unknown>): number {
  return utf8Bytes(JSON.stringify(outcome));
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** Stable JSON: object keys sorted, arrays ordered. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
