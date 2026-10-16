import { createHash } from "node:crypto";
import { z } from "zod";
import type { AccountUsage } from "@getpaseo/protocol/subscription-accounts";
import { providerJson } from "./oauth.js";

const Percent = z
  .union([z.number(), z.string().trim().min(1)])
  .transform((value) => Number(value))
  .pipe(z.number().finite())
  .nullish();
const Window = z.object({ utilization: Percent, resets_at: z.string().nullish() });
const Response = z.object({
  five_hour: Window.nullish(),
  seven_day: Window.nullish(),
  seven_day_opus: Window.nullish(),
  seven_day_omelette: Window.nullish(),
  limits: z.array(z.unknown()).nullish(),
});
const Scope = z.object({ id: z.string().nullish(), display_name: z.string().nullish() }).nullish();
const Limit = z.object({
  kind: z.string(),
  percent: Percent,
  resets_at: z.string().nullish(),
  scope: z.object({ model: Scope, surface: Scope }).nullish(),
});
interface ScopedWindow {
  dimension: "model" | "surface";
  id: string | null;
  name: string;
  usedPercent: number | null;
  resetsAt: string | null;
}

/** Account management supplies the exact credential; never discovers or falls back to a CLI login. */
export class ClaudeAccountUsage {
  private readonly blockedUntil = new Map<string, number>();
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly warn: (message: string) => void = (message) => console.warn(message),
  ) {}

  async read(access: string): Promise<AccountUsage> {
    const key = createHash("sha256").update(access).digest("hex");
    for (const [id, until] of this.blockedUntil)
      if (until <= this.now()) this.blockedUntil.delete(id);
    if (this.blockedUntil.has(key))
      throw new Error("Claude usage is rate limited; wait before refreshing again");
    const fetchUsage: typeof fetch = async (url, init) => {
      const response = await this.fetcher(url, init);
      if (response.status === 429) {
        const header = response.headers.get("retry-after");
        const seconds = header === null ? NaN : Number(header);
        const until = Number.isFinite(seconds)
          ? this.now() + seconds * 1000
          : Date.parse(header ?? "");
        if (Number.isFinite(until) && until > this.now()) this.blockedUntil.set(key, until);
      }
      return response;
    };
    const response = await providerJson(fetchUsage, "https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${access}`,
        Accept: "application/json",
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(15_000),
    });
    return {
      source: "claude",
      fetchedAt: new Date(this.now()).toISOString(),
      error: null,
      manageUrl: "https://claude.ai/settings/usage",
      resets: null,
      windows: claudeWindows(response, this.warn),
    };
  }
}

function normalized(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
function sameScope(a: ScopedWindow, b: ScopedWindow): boolean {
  if (a.dimension !== b.dimension) return false;
  return a.id && b.id ? a.id === b.id : normalized(a.name) === normalized(b.name);
}

function scopedWindow(value: unknown, warn: (message: string) => void): ScopedWindow | null {
  const parsed = Limit.safeParse(value);
  if (!parsed.success) {
    warn("Claude account usage contains an unrecognized scoped limit");
    return null;
  }
  const limit = parsed.data;
  if (limit.kind !== "weekly_scoped") return null;
  const dimension = limit.scope?.model ? "model" : "surface";
  const scope = limit.scope?.[dimension];
  const name = scope?.display_name || scope?.id;
  if (!name) {
    warn("Claude account usage contains an unnamed scoped limit");
    return null;
  }
  return {
    dimension,
    id: scope?.id ?? null,
    name,
    usedPercent: limit.percent ?? null,
    resetsAt: limit.resets_at ?? null,
  };
}

export function claudeWindows(
  value: unknown,
  warn: (message: string) => void,
): AccountUsage["windows"] {
  const response = Response.parse(value);
  const windows: AccountUsage["windows"] = [];
  for (const [field, id, label] of [
    ["five_hour", "five_hour", "Session"],
    ["seven_day", "weekly", "Weekly"],
  ] as const) {
    const window = response[field];
    if (window)
      windows.push({
        id,
        label,
        usedPercent: window.utilization ?? null,
        resetsAt: window.resets_at ?? null,
      });
  }
  const scoped: ScopedWindow[] = [];
  for (const [field, name] of [
    ["seven_day_opus", "Opus"],
    ["seven_day_omelette", "Omelette"],
  ] as const) {
    const window = response[field];
    if (window)
      scoped.push({
        dimension: "model",
        id: null,
        name,
        usedPercent: window.utilization ?? null,
        resetsAt: window.resets_at ?? null,
      });
  }
  for (const entry of response.limits ?? []) {
    const window = scopedWindow(entry, warn);
    if (!window) continue;
    const index = scoped.findIndex((existing) => sameScope(existing, window));
    if (index < 0) scoped.push(window);
    else scoped[index] = window;
  }
  const ids = new Set<string>();
  for (const window of scoped) {
    const base = `weekly:${window.dimension}:${window.id ?? normalized(window.name)}`;
    let id = base;
    for (let suffix = 2; ids.has(id); suffix += 1) id = `${base}:${suffix}`;
    ids.add(id);
    windows.push({
      id,
      label: `Weekly · ${window.name}`,
      usedPercent: window.usedPercent,
      resetsAt: window.resetsAt,
    });
  }
  if (windows.length === 0) throw new Error("Claude returned no recognized quota windows");
  return windows;
}
