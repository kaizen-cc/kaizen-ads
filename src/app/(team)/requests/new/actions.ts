"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { industryLabel, industryWinners, type Winner } from "@/lib/industry";
import { requireStaff } from "@/lib/auth";
import {
  AGENCY_SYSTEM,
  AiUnavailable,
  PATCH_SCHEMA,
  REVIEW_SCHEMA,
  SUGGESTIONS_SCHEMA,
  SUGGEST_FIELDS,
  askJson,
  getAgent,
  cleanSuggestions,
  clientContext,
  contextBlock,
  type ClientContext,
  type DraftPatch,
  type Review,
  type Suggestions,
} from "@/lib/ai";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { stageInfo, type Stage } from "@/lib/stages";
import { draws } from "@/lib/allotment";
import { readReferences, referencesBlock } from "@/lib/references";
import { MAX_VARIATIONS, SIZES, describeDraft, refLinks, selectedFormats, type Draft } from "./draft";
import { notLive } from "@/lib/live-guard";

type Fail = { ok: false; error: string };
export type CreateResult = { ok: true; numbers: number[] } | Fail;
/** What the AI read, so the form can say so. */
export type ContextSummary = {
  requests: number;
  angles: number;
  memory: number;
  adAccount: boolean;
  briefing: { generatedAt: string; slack: number; gmail: number; drive: number } | null;
};
export type SuggestResult = { ok: true; suggestions: Suggestions; context: ContextSummary } | Fail;
/** A recent ticket the review thinks asks for the same thing, with enough to judge without opening it. */
export type SimilarCard = {
  number: number;
  title: string;
  format: string;
  stage: string;
  stageLabel: string;
  assignee: string | null;
  createdAt: string;
  brief: string | null;
  overlap: "same" | "close";
  why: string;
};
/** What the reference reader managed to open, shown under the review. */
export type RefSummary = { url: string; label: string; kind: string; ok: boolean; note: string | null };
export type ReviewResult = { ok: true; review: Review; similar: SimilarCard[]; refs: RefSummary[] } | Fail;
/** What the person did with the review: issues they dismissed and similar tickets they went past. */
export type ReviewDecisions = {
  dismissed: { severity: string; field: string; issue: string }[];
  fixed: { severity: string; field: string; issue: string }[];
  continuedPast: number[];
  usedStrongerBrief: boolean;
};

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3));
const overlapScore = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / Math.min(a.size, b.size);
};

/** This client's tickets from the last 120 days that look closest to the draft (the AI decides which really match). */
async function candidates(clientId: string, draft: Draft) {
  const supabase = await createClient();
  const since = new Date(Date.now() - 120 * 86_400_000).toISOString();
  const { data } = await supabase
    .from("board_requests")
    .select("number, title, format, stage, angle_name, audience, brief, assignee_name, created_at")
    .eq("client_id", clientId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(150);
  const mine = words(`${draft.title} ${draft.angle} ${draft.audience} ${draft.brief}`);
  return (data ?? [])
    .map((r) => ({ r, score: overlapScore(mine, words(`${r.title} ${r.angle_name ?? ""} ${r.audience ?? ""} ${r.brief ?? ""}`)) }))
    .filter((x) => x.score > 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((x) => x.r);
}

const clamp = (n: unknown) => Math.min(100, Math.max(0, Math.floor(Number(n) || 0)));

async function loadContext(clientId: string | null) {
  await requireStaff();
  if (!clientId) return null;
  const supabase = await createClient();
  return clientContext(supabase, clientId);
}

async function summarize(ctx: ClientContext, clientId: string): Promise<ContextSummary> {
  const supabase = await createClient();
  const { data: b } = await supabase.from("client_briefings").select("generated_at, sources").eq("client_id", clientId).maybeSingle();
  const src = (b?.sources ?? {}) as Record<string, number>;
  return {
    requests: ctx.recent.length,
    angles: ctx.angles.length,
    memory: ctx.memory.length,
    adAccount: ctx.adAccountConnected,
    briefing: b ? { generatedAt: b.generated_at, slack: src.slack ?? 0, gmail: src.gmail ?? 0, drive: src.drive ?? 0 } : null,
  };
}

/** Suggestions made by the twice-daily briefing, so the form fills in instantly. Null when there are none yet. */
export async function loadBriefing(clientId: string): Promise<SuggestResult | null> {
  const ctx = await loadContext(clientId);
  if (!ctx) return null;
  const supabase = await createClient();
  const { data } = await supabase.from("client_briefings").select("suggestions").eq("client_id", clientId).maybeSingle();
  if (!data?.suggestions) return null;
  return { ok: true, suggestions: cleanSuggestions(data.suggestions as Suggestions), context: await summarize(ctx, clientId) };
}

/** Suggestions for every field, from what we know about the client and what's filled in so far. */
export async function suggestForRequest(draft: Draft): Promise<SuggestResult> {
  const ctx = await loadContext(draft.clientId);
  if (!ctx) return { ok: false, error: "Pick a client first." };
  try {
    const [{ sources }, refs] = await Promise.all([getAgent("suggest"), readReferences(refLinks(draft.refs))]);
    const raw = await askJson<Suggestions>({
      agent: "suggest",
      label: "suggest",
      system: AGENCY_SYSTEM,
      schema: SUGGESTIONS_SCHEMA,
      images: refs.images,
      prompt: `${contextBlock(ctx, undefined, sources)}
${referencesBlock(refs.reads)}

<draft_so_far>
${describeDraft(draft, ctx.name)}
</draft_so_far>

${SUGGEST_FIELDS}`,
    });
    const suggestions = cleanSuggestions(raw);
    return { ok: true, suggestions, context: await summarize(ctx, draft.clientId!) };
  } catch (e) {
    return { ok: false, error: e instanceof AiUnavailable ? e.message : "Couldn't get suggestions." };
  }
}

/**
 * Scrub the finished request before it goes to the team: flag real problems, write a stronger brief from
 * everything known about the client, and catch tickets that already ask for the same thing.
 */
export async function reviewRequest(draft: Draft): Promise<ReviewResult> {
  const ctx = await loadContext(draft.clientId);
  if (!ctx) return { ok: false, error: "Pick a client first." };
  try {
    const [{ sources }, recent, refs] = await Promise.all([getAgent("review"), candidates(draft.clientId!, draft), readReferences(refLinks(draft.refs))]);
    const review = await askJson<Review>({
      agent: "review",
      label: "review",
      system: AGENCY_SYSTEM,
      schema: REVIEW_SCHEMA,
      images: refs.images,
      prompt: `${contextBlock(ctx, draws(draft.formats), sources)}

<request>
${describeDraft(draft, ctx.name)}
</request>
${referencesBlock(refs.reads)}

<recent_tickets_that_look_similar>
${
  recent
    .map((r) => `#${r.number} · ${r.created_at.slice(0, 10)} · ${r.format} · ${stageInfo(r.stage as Stage).label} · "${r.title}"${r.angle_name ? ` · angle: ${r.angle_name}` : ""}${r.brief ? `\n  brief: ${r.brief.replace(/\s+/g, " ").slice(0, 400)}` : ""}`)
    .join("\n") || "None."
}
</recent_tickets_that_look_similar>

Review this request before it goes to the creative team.

issues: flag only real problems:
- net new counts that go over what's left of the monthly allotment (block; say by how much and that it needs an upgrade or variations instead). Skip this if no allotment is set.
- on a temporary sprint package: a due date after the sprint ends (block), or more work than fits before it ends (warn). Mention the end date.
- anything that goes against client memory, especially "avoid" items (block)
- content that's off-topic for this client or doesn't match the campaign direction set by the title, angle and audience (block if clearly wrong, warn if unclear)
- contradictions inside the request, e.g. the brief describes video but only images are picked, or sizes that don't fit the formats (warn)
- a brief too thin for a designer to start without questions (warn)
- claims that could get the ad rejected by Meta, e.g. personal attributes, before/after, guaranteed results (warn)
- references: the brief contradicts what a linked page says (a different price or offer than the landing page: block), it mentions references that aren't linked, or it doesn't say what to take from a reference (warn). If a reference couldn't be read, say so only when the brief relies on it.
Don't flag style preferences or nitpicks. "fix" is a concrete change, written so it can be applied to the request as-is.

strongerBrief: the brief a designer or editor should get, rewritten and filled in from everything you know about this client (briefing, client memory, performance, angles, past requests, Brand Bible) following the brief structure skill. Keep everything the person wrote that's right; fill the gaps (audience, hook, on-image text, offer, must-include, references), resolve your own issues where the fix is in the brief, and never invent offers, prices, claims or facts. Use what the references show: describe the reference images' layout, style and on-image text the designer should borrow, and take offers and prices from the linked pages. Say which reference each borrowed element comes from ("layout from Reference 2"). If their brief is already strong and complete, return "".

similar: tickets from the list above that ask for the same thing ("same": a duplicate) or nearly the same thing ("close": same angle and idea, could be a variation). why: one short sentence. Empty when none truly match; a shared client or format alone isn't similar.

verdict "clear" only when there are no issues and no similar tickets. summary: one sentence for the person who wrote it.`,
    });
    const byNumber = new Map(recent.map((r) => [r.number, r]));
    const similar: SimilarCard[] = (review.similar ?? [])
      .filter((x) => byNumber.has(x.number))
      .slice(0, 3)
      .map((x) => {
        const r = byNumber.get(x.number)!;
        return {
          number: r.number,
          title: r.title,
          format: r.format,
          stage: r.stage,
          stageLabel: stageInfo(r.stage as Stage).label,
          assignee: r.assignee_name,
          createdAt: r.created_at,
          brief: r.brief,
          overlap: x.overlap,
          why: x.why,
        };
      });
    return {
      ok: true,
      review: { ...review, issues: review.issues.slice(0, 6), strongerBrief: review.strongerBrief?.trim() ?? "", similar: review.similar ?? [] },
      similar,
      refs: refs.reads.map((r) => ({ url: r.url, label: r.label, kind: r.kind, ok: r.ok, note: r.note ?? null })),
    };
  } catch (e) {
    return { ok: false, error: e instanceof AiUnavailable ? e.message : "Couldn't review the request." };
  }
}

/** "Make this change": the AI applies one or more review fixes to the request's text fields. */
export async function applyFixes(draft: Draft, issues: { field: string; issue: string; fix: string }[]): Promise<{ ok: true; patch: DraftPatch } | Fail> {
  const ctx = await loadContext(draft.clientId);
  if (!ctx) return { ok: false, error: "Pick a client first." };
  try {
    const [{ sources }, refs] = await Promise.all([getAgent("suggest"), readReferences(refLinks(draft.refs))]);
    const patch = await askJson<DraftPatch>({
      agent: "suggest",
      label: "apply fix",
      system: AGENCY_SYSTEM,
      schema: PATCH_SCHEMA,
      images: refs.images,
      prompt: `${contextBlock(ctx, draws(draft.formats), sources)}

<request>
${describeDraft(draft, ctx.name)}
</request>
${referencesBlock(refs.reads)}

<fixes_to_apply>
${issues.map((x, i) => `${i + 1}. [${x.field}] ${x.issue}\n   Fix: ${x.fix}`).join("\n")}
</fixes_to_apply>

Apply these fixes to the request and return the whole request after the change. Leave everything a fix doesn't touch exactly as it is.
- title, angle, audience, brief: text. Keep what the person wrote that the fixes don't touch.
- refs: the reference links, one per line, exactly as given (only remove a link if a fix says to; never invent a link).
- sizes: from 1x1, 4x5, 9x16.
- formats: every format in the request with its counts (new = net new designs, variations up to ${MAX_VARIATIONS} per format). Net new must fit what's left of the allotment; if a fix would go over, keep the counts and say so in note.
Use only facts from the client context; never invent offers, prices, claims or references.
changed: which of title, angle, audience, brief, refs, sizes, formats you changed. note: one short sentence on anything a fix needs that you can't do here (e.g. attaching a file, getting client sign-off), or "".`,
    });
    return { ok: true, patch };
  } catch (e) {
    return { ok: false, error: e instanceof AiUnavailable ? e.message : "Couldn't apply the change." };
  }
}

/** One ticket per selected format, routed to that format's maker. */
export async function createBatch(draft: Draft, review: Review | null, decisions?: ReviewDecisions): Promise<CreateResult> {
  const me = await requireStaff();
  if (!draft.clientId) return { ok: false, error: "Pick a client." };
  {
    const why = await notLive(await createClient(), draft.clientId);
    if (why) return { ok: false, error: why };
  }
  if (!draft.title.trim()) return { ok: false, error: "Give the request a title." };
  const formats = selectedFormats(draft);
  if (formats.length === 0) return { ok: false, error: "Pick at least one format." };
  const items = formats.map((f) => ({ format: f, new: clamp(draft.formats[f]!.new), variations: clamp(draft.formats[f]!.variations) }));
  if (items.some((i) => i.variations > MAX_VARIATIONS)) return { ok: false, error: `Up to ${MAX_VARIATIONS} variations per format.` };
  if (items.some((i) => i.new + i.variations < 1)) return { ok: false, error: "Each format needs at least one creative." };

  const supabase = await createClient();
  const { data: batch, error } = await supabase.rpc("create_request_batch", {
    p_client: draft.clientId,
    p_title: draft.title,
    p_items: items,
    p_priority: ["high", "urgent"].includes(draft.priority) ? draft.priority : "normal",
    p_angle: draft.angle.trim() || null,
    p_audience: draft.audience.trim() || null,
    p_brief: draft.brief.trim() || null,
    p_refs: refLinks(draft.refs),
    p_sizes: draft.sizes.filter((s) => SIZES.includes(s)),
    p_ai_review: review ? { ...review, decisions: decisions ?? null } : null,
  });
  if (error) return { ok: false, error: error.message };

  const { data: rows } = await supabase.from("requests").select("id, number").eq("batch_id", batch).order("number");

  // Where the ads send people: on every ticket of the batch (copy and the client's preview use it)
  const landing = draft.landing?.trim();
  if (landing && /^https?:\/\/\S+\.\S+/i.test(landing) && rows?.length && adminConfigured())
    await createAdminClient().from("requests").update({ landing_url: landing.slice(0, 500) }).in("id", rows.map((r) => r.id));

  // On each ticket's history: who went past which heads-ups and similar tickets, so it can be looked back on
  if (decisions && adminConfigured() && rows?.length) {
    const events = rows.flatMap((t) => [
      ...decisions.dismissed.map((d) => ({ request_id: t.id, kind: "review", actor_id: me.id, body: d.issue, data: { action: "dismissed", severity: d.severity, field: d.field } })),
      ...decisions.fixed.map((d) => ({ request_id: t.id, kind: "review", actor_id: me.id, body: d.issue, data: { action: "ai_fixed", severity: d.severity, field: d.field } })),
      ...decisions.continuedPast.map((n) => ({ request_id: t.id, kind: "review", actor_id: me.id, body: null, data: { action: "continued_past_similar", ticket: String(n) } })),
      ...(decisions.usedStrongerBrief ? [{ request_id: t.id, kind: "review", actor_id: me.id, body: null, data: { action: "stronger_brief" } }] : []),
    ]);
    if (events.length) await createAdminClient().from("request_events").insert(events);
  }
  // A request that makes something promised on a call puts that promise in motion and clears its alert on Home
  if (adminConfigured() && rows?.length) {
    const clientId = draft.clientId;
    after(async () => {
      const { sweepCovered } = await import("@/lib/calls");
      await sweepCovered(createAdminClient(), clientId).catch((e) => console.error("[calls] promise check failed:", e instanceof Error ? e.message : e));
    });
  }
  revalidatePath("/board");
  revalidatePath("/pipeline");
  return { ok: true, numbers: (rows ?? []).map((r) => r.number) };
}

export type WinnersResult = { industry: string | null; label: string | null; detail: string | null; winners: Winner[] };

/** What's working for other clients in this client's industry (for the request form). */
export async function industryWinnersFor(clientId: string): Promise<WinnersResult> {
  await requireStaff();
  const supabase = await createClient();
  const { data: c } = await supabase.from("clients").select("industry, industry_detail").eq("id", clientId).maybeSingle();
  if (!c?.industry || c.industry === "other") return { industry: null, label: null, detail: null, winners: [] };
  return { industry: c.industry, label: industryLabel(c.industry), detail: c.industry_detail, winners: await industryWinners(supabase, c.industry, clientId, 6) };
}

export type Promise_ = {
  id: string;
  kind: string;
  what: string;
  callTitle: string;
  callAt: string;
  internal: boolean;
  briefed: boolean; // a brief is already written
};

/** What we promised this client on calls and haven't started (creative, copy, offers): shown when writing a request. */
export async function promisesFor(clientId: string): Promise<Promise_[]> {
  await requireStaff();
  const supabase = await createClient();
  const { data } = await supabase
    .from("call_commitments")
    .select("id, kind, what, status, suggestion_id, client_calls(title, occurred_at, status)")
    .eq("client_id", clientId)
    .in("status", ["open", "briefed"])
    .in("kind", ["creative", "copy", "offer"])
    .order("created_at", { ascending: false })
    .limit(8);
  return (data ?? []).map((c) => {
    const call = c.client_calls as unknown as { title: string; occurred_at: string; status: string } | null;
    return { id: c.id, kind: c.kind, what: c.what, callTitle: call?.title ?? "A call", callAt: call?.occurred_at ?? "", internal: call?.status === "internal", briefed: c.status === "briefed" && Boolean(c.suggestion_id) };
  });
}

/** The brief for a promise, ready to drop into the form (written now if it wasn't already). */
export async function promiseDraft(commitmentId: string): Promise<{ ok: true; patch: Partial<Draft> } | { ok: false; error: string }> {
  await requireStaff();
  const supabase = await createClient();
  const { data: mine } = await supabase.from("call_commitments").select("id").eq("id", commitmentId).maybeSingle();
  if (!mine) return { ok: false, error: "That promise isn't on a client you work on." };
  if (!adminConfigured()) return { ok: false, error: "The AI isn't connected here." };
  try {
    const admin = createAdminClient();
    const { briefPromise } = await import("@/lib/calls");
    const id = await briefPromise(admin, commitmentId);
    if (!id) return { ok: false, error: "This one isn't paid ads or creative work, so it's been taken off the list." };
    const { data: s } = await admin.from("creative_suggestions").select("draft").eq("id", id).single();
    const d = s?.draft as import("@/lib/suggestions").SuggestionDraft;
    const concepts = d.concepts?.length ? `\n\nConcepts:\n${d.concepts.map((c, i) => `${i + 1}. ${c.name}\n   Hook: ${c.hook}\n   Visual: ${c.visual}\n   Copy: ${c.copy}`).join("\n")}` : "";
    const hooks = d.hooks?.length ? `\n\nHooks to try:\n${d.hooks.map((h) => `- ${h}`).join("\n")}` : "";
    return {
      ok: true,
      patch: {
        title: d.title,
        angle: d.angle,
        audience: d.audience,
        brief: `${d.brief}${concepts}${hooks}`,
        formats: Object.fromEntries(d.formats.map((f) => [f.format, { new: f.new, variations: f.variations }])),
        sizes: d.sizes.filter((x) => SIZES.includes(x)),
        landing: d.landing || "",
        ...(d.refs?.length ? { refs: d.refs.join("\n") } : {}),
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof AiUnavailable ? e.message : "Couldn't write the brief. Try again." };
  }
}

/** The request made from a promise: the promise is in motion with these tickets, and its brief is used up. */
export async function fulfilPromise(commitmentId: string, numbers: number[]) {
  const me = await requireStaff();
  if (!adminConfigured()) return;
  const admin = createAdminClient();
  const { data: c } = await admin.from("call_commitments").update({ status: "in_motion", request_numbers: numbers }).eq("id", commitmentId).select("suggestion_id").single();
  if (c?.suggestion_id)
    await admin.from("creative_suggestions").update({ status: "approved", decided_by: me.id, decided_at: new Date().toISOString(), request_numbers: numbers }).eq("id", c.suggestion_id).eq("status", "open");
  revalidatePath("/pipeline");
}

/** What's live in this client's market (Motion): their named competitors first, then proven and testing ads in their industry. */
export async function marketFor(clientId: string): Promise<{ label: string | null; ads: import("@/lib/market").MarketAd[] }> {
  await requireStaff();
  const supabase = await createClient();
  const { data: c } = await supabase.from("clients").select("industry, industry_detail").eq("id", clientId).maybeSingle();
  if (!c?.industry || c.industry === "other") return { label: null, ads: [] };
  const { loadClientMarket } = await import("@/lib/market");
  const all = await loadClientMarket(supabase, clientId, { limit: 200 });
  // One per brand, best matches first
  const seen = new Set<string>();
  const ads = all.filter((a) => (seen.has(a.brand) ? false : (seen.add(a.brand), true))).slice(0, 8);
  return { label: c.industry_detail ?? industryLabel(c.industry), ads };
}
