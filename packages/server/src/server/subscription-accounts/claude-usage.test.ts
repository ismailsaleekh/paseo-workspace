import { expect, test } from "vitest";
import { ClaudeAccountUsage, claudeWindows } from "./claude-usage.js";

const rejectWarning = (message: string): never => {
  throw new Error(message);
};

test("account quota windows preserve unknown values and reconcile model versus surface limits", () => {
  const warnings: string[] = [];
  expect(
    claudeWindows(
      {
        five_hour: { utilization: null },
        seven_day: { utilization: "30", resets_at: "2026-10-21T12:00:00Z" },
        seven_day_opus: { utilization: 10 },
        limits: [
          {
            kind: "weekly_scoped",
            percent: 25,
            scope: { model: { id: "opus-v1", display_name: "Opus" } },
          },
          {
            kind: "weekly_scoped",
            percent: 8,
            scope: { surface: { id: "opus-v1", display_name: "Opus" } },
          },
          { future_format: true },
        ],
      },
      (warning) => warnings.push(warning),
    ),
  ).toEqual([
    { id: "five_hour", label: "Session", usedPercent: null, resetsAt: null },
    { id: "weekly", label: "Weekly", usedPercent: 30, resetsAt: "2026-10-21T12:00:00Z" },
    { id: "weekly:model:opus-v1", label: "Weekly · Opus", usedPercent: 25, resetsAt: null },
    { id: "weekly:surface:opus-v1", label: "Weekly · Opus", usedPercent: 8, resetsAt: null },
  ]);
  expect(warnings).toEqual(["Claude account usage contains an unrecognized scoped limit"]);
});

test("different provider scope IDs remain distinct even when their display names normalize alike", () => {
  expect(
    claudeWindows(
      {
        limits: [
          {
            kind: "weekly_scoped",
            percent: 1,
            scope: { model: { id: "a-b", display_name: "Same name" } },
          },
          {
            kind: "weekly_scoped",
            percent: 2,
            scope: { model: { id: "a_b", display_name: "Same name" } },
          },
        ],
      },
      rejectWarning,
    ).map((window) => window.id),
  ).toEqual(["weekly:model:a-b", "weekly:model:a_b"]);
  expect(() => claudeWindows({}, rejectWarning)).toThrow("no recognized quota windows");
});

test("only the supplied account token is sent; another account is not rate-limited with it", async () => {
  let now = 1_800_000_000_000;
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
    const authorization = new Headers(init?.headers).get("Authorization") ?? "";
    calls.push(authorization);
    if (calls.length === 1)
      return new Response("private provider body", {
        status: 429,
        headers: { "retry-after": "60" },
      });
    return Response.json({ five_hour: { utilization: 12 } });
  };
  const usage = new ClaudeAccountUsage(fetcher, () => now, rejectWarning);
  await expect(usage.read("fixture-A")).rejects.toThrow("Provider request failed (429)");
  await expect(usage.read("fixture-A")).rejects.toThrow("rate limited");
  expect((await usage.read("fixture-B")).windows[0]?.usedPercent).toBe(12);
  now += 60_001;
  expect((await usage.read("fixture-A")).windows[0]?.usedPercent).toBe(12);
  expect(calls).toEqual(["Bearer fixture-A", "Bearer fixture-B", "Bearer fixture-A"]);
});

test("provider errors cannot expose its body or the credential", async () => {
  const fetcher: typeof fetch = async () => new Response("SECRET fixture-token", { status: 401 });
  await expect(new ClaudeAccountUsage(fetcher).read("fixture-token")).rejects.toThrow(
    "Provider request failed (401)",
  );
});
