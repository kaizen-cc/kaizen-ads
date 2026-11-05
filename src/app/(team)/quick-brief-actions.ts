"use server";

import { AGENCY_SYSTEM, AiUnavailable, aiEnabled, askJson, clientContext, contextBlock, getAgent } from "@/lib/ai";
import { toAllotment, type Allotment, type UsageRow } from "@/lib/allotment";
import { requireStaff } from "@/lib/auth";
import { quickFromDraftAll, type BriefSource, type QuickBrief, type QuickFormat } from "@/lib/quick-brief";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { SuggestionDraft } from "@/lib/suggestions";

// The quick preview every brief starts from (src/lib/quick-brief.ts): a short summary in a few seconds, from a fast
// model at low effort, or at once when the brief is already written. The full brief is written after, from what the
// person agreed.

export type PreviewResult = { ok: true; brief: QuickBrief; /** Other distinct concepts in it: one concept per brief, so these can be split off */ others: QuickBrief[]; allotment: Allotment | null; client: string; instant: boolean } | { ok: false; error: string };

const FORMATS = ["image", "video", "carousel"] as const;

const ONE = {
  type: "object",
  properties: {
    title: { type: "string" },
    concept: { type: "string" },
    angle: { type: "string" },
    audience: { type: "string" },
    hook: { type: "string" },
    formats: {
      type: "array",
      items: { type: "object", properties: { format: { type: "string", enum: [...FORMATS] }, new: { type: "integer" }, variations: { type: "integer" } }, required: ["format", "new", "variations"], additionalProperties: false },
    },
    why: { type: "string" },
  },
  required: ["title", "concept", "angle", "audience", "hook", "formats", "why"],
  additionalProperties: false,
};
const SCHEMA = { type: "object", properties: { briefs: { type: "array", items: ONE } }, required: ["briefs"], additionalProperties: false };

const SYSTEM = `${AGENCY_SYSTEM}

You are the agency's strategist, giving a quick first look at a creative request before the full brief is written. Someone on the team is deciding whether this idea is worth briefing for this client, and will edit your lines before the full brief is written from them. Be fast, specific and short. Plain words, no jargon, no em dashes.
One concept per brief. briefs: one entry per distinct concept (one idea, one angle) in what you're given; almost always exactly one. Only when the source clearly holds several different concepts, give each its own entry, the strongest first.
- title: short and specific, under 60 characters.
- concept: one or two sentences on what the creative shows and does.
- angle: the angle in a few words.
- audience: who it's for, in one line.
- hook: the opening line or on-image headline it leads with, in the client's voice.
- formats: what gets made for this one concept, each format with net new and variations (0 to 5). Every version counts toward the allotment (net new and variations alike, and each carousel slide; sizes of the same version don't), so the total must fit what's left (images and carousels share the image pool).
- why: one or two sentences on why it fits this client now (their offer, audience, goal, what's working for them, and the allotment if it limited the counts).
Only facts from the client context: never invent prices, offers, dates or claims. Never name another business or client.`;

const clean = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

function cleanFormats(list: QuickFormat[], only?: QuickFormat["format"]): QuickFormat[] {
  const out: QuickFormat[] = [];
  for (const f of list ?? []) {
    if (!FORMATS.includes(f.format) || out.some((x) => x.format === f.format)) continue;
    if (only && f.format !== only) continue;
    const n = Math.max(0, Math.min(10, Math.floor(Number(f.new) || 0)));
    const v = Math.max(0, Math.min(5, Math.floor(Number(f.variations) || 0)));
    if (n + v > 0) out.push({ format: f.format, new: n, variations: v });
  }
  return out.length ? out : [{ format: only ?? "image", new: 1, variations: 0 }];
}

/** What the source is, in words for the strategist (read with the service role, after the person's access was checked) */
async function sourceBlock(admin: ReturnType<typeof createAdminClient>, clientId: string, source: BriefSource): Promise<string | null> {
  switch (source.kind) {
    case "winner": {
      const w = source.winner;
      return `<winning_ad>\nFrom another Kaizen account (${w.detail ?? "another business"}). ${w.ratio}x better cost per ${w.result ?? "result"} than that account's usual.\nHeadline: ${w.headline ?? "(none)"}\nPrimary text: ${(w.text ?? "(none)").slice(0, 600)}\n</winning_ad>\nBuild this client's version of what makes the winning ad work.`;
    }
    case "market": {
      const { loadMarketAd } = await import("@/lib/market");
      const a = await loadMarketAd(admin, source.adId);
      if (!a) return null;
      return `<market_ad>\nA live ad from a brand like them${a.daysActive != null ? `, running ${a.daysActive} days` : ""}.\n${a.angle ? `Angle: ${a.angle}\n` : ""}${a.hook ? `Hook: ${a.hook}\n` : ""}${a.why ? `Why it likely works: ${a.why}\n` : ""}Headline: ${a.headline ?? "(none)"}\nCopy: ${(a.body ?? "(none)").slice(0, 600)}\n</market_ad>\nBuild this client's version of the idea. Never borrow the other brand's offer or claims.`;
    }
    case "pattern": {
      const { patternById } = await import("@/lib/patterns");
      const p = await patternById(admin, source.patternId);
      if (!p) return null;
      return `<pattern_across_clients>\n${p.title} (${p.kind}) · proven for ${p.evidence.clients} of ${p.evidence.of} ${p.group.toLowerCase()}\n${p.detail}\n</pattern_across_clients>\nBuild this client's version of the pattern.`;
    }
    case "refresh": {
      const { data: f } = await admin.from("ad_fatigue").select("ad_name, headline, severity, signals").eq("client_id", clientId).eq("ad_id", source.adId).maybeSingle();
      if (!f) return null;
      const { describeFatigue } = await import("@/lib/fatigue");
      return `<tiring_ad>\n"${f.headline ?? f.ad_name}" is ${f.severity === "tired" ? "tired" : "tiring"}.\n${describeFatigue([f] as Parameters<typeof describeFatigue>[0])}\n</tiring_ad>\nA refresh: keep what made it work (the angle, the offer, the proof), change what people are tired of (the visual, the hook, the first seconds). Usually variations and 1 to 2 net new.`;
    }
    case "promise": {
      const { data: c } = await admin.from("call_commitments").select("what, why, client_calls(title, occurred_at)").eq("id", source.commitmentId).maybeSingle();
      if (!c) return null;
      const call = c.client_calls as unknown as { title: string; occurred_at: string } | null;
      return `<what_we_promised>\nOn the call "${call?.title ?? "a call"}"${call?.occurred_at ? ` (${call.occurred_at.slice(0, 10)})` : ""} Kaizen promised: ${c.what}${c.why ? `\nContext: ${c.why}` : ""}\n</what_we_promised>\nKeep it to exactly what was promised.`;
    }
    case "idea":
      return `<the_idea>\n${source.label}\n${source.text.slice(0, 3000)}\n</the_idea>`;
    case "talk":
      return `<conversation>\n${source.turns
        .slice(-16)
        .map((t) => `${t.role === "user" ? "Team member" : "Strategist"}: ${t.text.slice(0, 2000)}`)
        .join("\n\n")}\n</conversation>\nSummarize the request the team member wants: their idea, their format and counts.`;
    default:
      return null;
  }
}

/** The quick preview of a brief, before the full one is written */
export async function previewBrief(clientId: string, source: BriefSource, given?: QuickBrief | null): Promise<PreviewResult> {
  await requireStaff();
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) return { ok: false, error: "Pick a client first." };
  const db = await createClient();
  const [{ data: client }, { data: usage }] = await Promise.all([
    db.from("clients").select("id, name").eq("id", clientId).maybeSingle(),
    db.from("client_allotment_usage").select("*").eq("client_id", clientId).maybeSingle(),
  ]);
  if (!client) return { ok: false, error: "That client isn't one you work on." };
  const allotment = usage ? toAllotment(usage as UsageRow) : null;
  const done = (all: QuickBrief[], instant: boolean): PreviewResult => ({ ok: true, brief: all[0], others: all.slice(1, 6), allotment, client: client.name as string, instant });
  // Already agreed (the next of a split): as it is
  if (given) return done([given], false);

  // Already written: its summary, at once
  // A suggestion that's only its summary so far (written on its own) shows at once too, but isn't instant: its full
  // brief is written when the person picks it
  const fromSuggestion = async (id: string) => {
    const { data: s } = await db.from("creative_suggestions").select("draft, why, status").eq("id", id).maybeSingle();
    return s && s.status === "open" ? { briefs: quickFromDraftAll(s.draft as SuggestionDraft, (s.why as string | null) ?? ""), full: !(s.draft as SuggestionDraft).summary } : null;
  };
  if (source.kind === "suggestion") {
    const q = await fromSuggestion(source.id);
    return q ? done(q.briefs, q.full) : { ok: false, error: "That brief isn't open any more." };
  }
  if (source.kind === "promise") {
    const { data: c } = await db.from("call_commitments").select("id, suggestion_id").eq("id", source.commitmentId).maybeSingle();
    if (!c) return { ok: false, error: "That promise isn't on a client you work on." };
    const q = c.suggestion_id ? await fromSuggestion(c.suggestion_id as string) : null;
    if (q) return done(q.briefs, q.full);
  }

  if (!aiEnabled() || !adminConfigured()) return { ok: false, error: "The AI isn't connected here." };
  const admin = createAdminClient();
  // Winners only from a client selling the same thing or in the same niche (the owner's rule)
  if (source.kind === "winner") {
    const { assertRelevantWinner } = await import("@/lib/industry");
    const unrelated = await assertRelevantWinner(admin, clientId, source.winner).then(() => null, (e: unknown) => (e instanceof Error ? e.message : "That winner can't be briefed for this client."));
    if (unrelated) return { ok: false, error: unrelated };
  }
  try {
    const [ctx, { sources }, block] = await Promise.all([clientContext(admin, clientId), getAgent("strategist"), sourceBlock(admin, clientId, source)]);
    if (!ctx) return { ok: false, error: "That client isn't there any more." };
    if (!block) return { ok: false, error: "That isn't there any more." };
    const only = source.kind === "winner" || source.kind === "market" ? source.format : undefined;
    const r = await askJson<{ briefs: Omit<QuickBrief, "note">[] }>({
      agent: "strategist",
      label: "quick brief",
      clientId,
      override: { model: "sonnet", effort: "low" },
      maxTokens: 1500,
      system: SYSTEM,
      schema: SCHEMA,
      prompt: `${contextBlock(ctx, undefined, sources)}

${block}
${only ? `\nThis request is for ${only === "image" ? "single images" : `${only}s`} only: formats has exactly one entry, format "${only}".` : ""}
Give the quick first look at this request for ${ctx.name}.`,
    });
    const briefs = (r.briefs ?? []).map((b) => ({
      title: clean(b.title, 80),
      concept: clean(b.concept, 500),
      angle: clean(b.angle, 160),
      audience: clean(b.audience, 240),
      hook: clean(b.hook, 200),
      formats: cleanFormats(b.formats, only),
      why: clean(b.why, 500),
      note: "",
    }));
    if (!briefs.length) return { ok: false, error: "Couldn't sketch it. Try again." };
    return done(briefs, false);
  } catch (e) {
    return { ok: false, error: e instanceof AiUnavailable ? e.message : "Couldn't sketch it. Try again." };
  }
}
