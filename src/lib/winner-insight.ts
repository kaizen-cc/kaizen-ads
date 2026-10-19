import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import type { Winner } from "@/lib/industry";

// The AI's read of a winning ad: what its numbers show against its own account (and over its own last weeks), and why
// the creative most likely works, from the image and the copy. Kept per ad; rewritten when it's a week old.

export type WinnerInsight = { observation: string; creative: string; hook: string | null; angle: string | null; takeaways: string[]; generatedAt: string };

const SCHEMA = {
  type: "object",
  properties: {
    observation: { type: "string" },
    creative: { type: "string" },
    hook: { type: "string" },
    angle: { type: "string" },
    takeaways: { type: "array", items: { type: "string" } },
  },
  required: ["observation", "creative", "hook", "angle", "takeaways"],
  additionalProperties: false,
};

const SYSTEM = `You are the senior strategist at Kaizen, a paid social agency, reading one of our winning Meta ads for the team. It's a winner because it gets its result clearly cheaper than its own account usually does.
observation: what the numbers show, 2 to 3 sentences: how it compares with its account, what's driving it (cheap clicks from a strong CTR, a strong hook rate, steady results at scale, rising or falling over its weeks), and anything to watch (frequency climbing, results thinning). Only numbers given; never invent one.
creative: why this creative most likely works, 2 to 4 sentences: the hook (first line, on-image headline, first seconds), the angle, the proof or offer, the format and visual choices, how the copy and the image work together. Be specific to this ad, not generic advice.
hook: the hook in a few words. angle: the selling idea in a few words.
takeaways: 2 or 3 short, concrete things another client's creative could borrow (the structure, not the words).
Plain, direct, no hype.`;

const n = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? Number(v) || 0 : 0);
const act = (list: unknown, type: string) => n((list as { action_type: string; value: string }[] | undefined)?.find((a) => a.action_type === type)?.value);

/** The ad's own last four weeks, by week: spend, CTR, frequency and hook rate. */
async function weeksOf(db: SupabaseClient, adId: string) {
  const since = new Date(Date.now() - 28 * 86_400_000).toISOString().slice(0, 10);
  const { data } = await db.from("meta_ad_daily").select("date, metrics").eq("ad_id", adId).gte("date", since).order("date");
  const weeks: { spend: number; impressions: number; clicks: number; reach: number; plays3s: number }[] = [];
  for (const r of data ?? []) {
    const m = r.metrics as Record<string, unknown>;
    const i = Math.min(3, Math.floor((Date.now() - Date.parse(String(r.date))) / (7 * 86_400_000)));
    const w = (weeks[3 - i] ??= { spend: 0, impressions: 0, clicks: 0, reach: 0, plays3s: 0 });
    w.spend += n(m.spend);
    w.impressions += n(m.impressions);
    w.clicks += n(m.inline_link_clicks);
    w.reach += n(m.reach);
    w.plays3s += act(m.actions, "video_view");
  }
  return weeks
    .map((w, i) =>
      w
        ? `week ${i + 1}: $${w.spend.toFixed(0)} spent, CTR ${w.impressions ? ((w.clicks / w.impressions) * 100).toFixed(2) : "0"}%, frequency ${w.reach ? (w.impressions / w.reach).toFixed(2) : "?"}${w.plays3s ? `, hook rate ${((w.plays3s / Math.max(1, w.impressions)) * 100).toFixed(1)}%` : ""}`
        : null,
    )
    .filter(Boolean)
    .join("\n");
}

async function imageOf(url: string | null) {
  if (!url) return [];
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !/image\/(jpeg|png|webp|gif)/.test(type)) return [];
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 4_500_000) return [];
    return [{ mediaType: type.split(";")[0] as "image/jpeg" | "image/png" | "image/webp" | "image/gif", data: buf.toString("base64") }];
  } catch {
    return [];
  }
}

/** Writes (or rewrites) the read of one winning ad. */
export async function analyzeWinner(admin: SupabaseClient, w: Winner, extra: { text?: string | null; headline?: string | null; image?: string | null; cta?: string | null } = {}) {
  const weeks = await weeksOf(admin, w.id);
  const metrics = { ratio: w.ratio, costPerResult: w.costPerResult, usual: w.usual, result: w.result, results: w.results, spend: w.spend, ctr: w.ctr };
  const out = await askJson<{ observation: string; creative: string; hook: string; angle: string; takeaways: string[] }>({
    agent: "winners",
    label: "read a winner",
    system: SYSTEM,
    schema: SCHEMA,
    images: await imageOf(extra.image ?? w.thumbnail),
    prompt: `${w.client} (${w.detail ?? w.industry ?? "business"}) · ${w.fame ? `Hall of Fame: ${w.fame.days} days live` : "last 30 days"}
${
  w.fame
    ? w.fame.roas
      ? `ROAS ${w.costPerResult.toFixed(2)}x vs a ${w.usual}x ${w.fame.basis === "kpi" ? "KPI target" : "sub-vertical benchmark"} (${Math.round(w.fame.beatBy * 100)}% above it)`
      : `Cost per ${w.result ?? "result"}: $${w.costPerResult.toFixed(2)} vs a $${w.usual.toFixed(2)} ${w.fame.basis === "kpi" ? "KPI target" : "sub-vertical benchmark"} (${Math.round(w.fame.beatBy * 100)}% under it)`
    : `Cost per ${w.result ?? "result"}: $${w.costPerResult.toFixed(2)} vs the account's usual $${w.usual.toFixed(2)} (${w.ratio}x better)`
}
${w.results} ${w.result ?? "results"} on $${w.spend.toFixed(0)} spent${w.fame ? "" : ` · CTR ${w.ctr}%`} · ${w.live ? "running now" : "not delivering right now"}
${weeks ? `Its own weeks (oldest first):\n${weeks}` : ""}

Ad name: ${w.name}
Headline: ${extra.headline ?? w.headline ?? "(none)"}
Primary text: ${extra.text ?? w.text ?? "(none)"}
Button: ${extra.cta ?? "(unknown)"}
${(extra.image ?? w.thumbnail) ? "The image (or the video's first frame) is attached." : "No image available."}`,
  });
  const row = {
    ad_id: w.id,
    client_id: w.clientId,
    observation: out.observation,
    creative: out.creative,
    hook: out.hook || null,
    angle: out.angle || null,
    takeaways: out.takeaways.slice(0, 3),
    metrics,
    generated_at: new Date().toISOString(),
  };
  await admin.from("winner_insights").upsert(row, { onConflict: "ad_id" });
  return toInsight(row);
}

export const toInsight = (r: { observation: string; creative: string; hook: string | null; angle: string | null; takeaways: string[] | null; generated_at: string }): WinnerInsight => ({
  observation: r.observation,
  creative: r.creative,
  hook: r.hook,
  angle: r.angle,
  takeaways: r.takeaways ?? [],
  generatedAt: r.generated_at,
});

/** After a Meta sync: winners without a read (or with one over a week old) get one, best first. */
export async function analyzeWinners(admin: SupabaseClient, max = 15) {
  const { allWinners } = await import("@/lib/industry");
  const winners = await allWinners(admin);
  const { data: have } = await admin.from("winner_insights").select("ad_id, generated_at");
  const fresh = new Set((have ?? []).filter((h) => Date.now() - Date.parse(h.generated_at) < 7 * 86_400_000).map((h) => h.ad_id));
  let done = 0;
  for (const w of winners.filter((x) => !fresh.has(x.id)).slice(0, max)) {
    try {
      await analyzeWinner(admin, w);
      done++;
    } catch (e) {
      console.error("[winners] couldn't read", w.id, e instanceof Error ? e.message : e);
    }
  }
  return { winners: winners.length, read: done };
}
