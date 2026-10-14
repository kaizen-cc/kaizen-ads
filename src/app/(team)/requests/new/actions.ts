"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import {
  AGENCY_SYSTEM,
  AiUnavailable,
  REVIEW_SCHEMA,
  SUGGESTIONS_SCHEMA,
  SUGGEST_FIELDS,
  askJson,
  cleanSuggestions,
  clientContext,
  contextBlock,
  type ClientContext,
  type Review,
  type Suggestions,
} from "@/lib/ai";
import { createClient } from "@/lib/supabase/server";
import { draws } from "@/lib/allotment";
import { MAX_VARIATIONS, SIZES, describeDraft, refLinks, selectedFormats, type Draft } from "./draft";

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
export type ReviewResult = { ok: true; review: Review } | Fail;

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
    const raw = await askJson<Suggestions>({
      label: "suggest",
      model: "fast",
      system: AGENCY_SYSTEM,
      effort: "low",
      schema: SUGGESTIONS_SCHEMA,
      prompt: `${contextBlock(ctx)}

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

/** Scrub the finished request before it goes to the team. */
export async function reviewRequest(draft: Draft): Promise<ReviewResult> {
  const ctx = await loadContext(draft.clientId);
  if (!ctx) return { ok: false, error: "Pick a client first." };
  try {
    const review = await askJson<Review>({
      label: "review",
      system: AGENCY_SYSTEM,
      effort: "medium",
      schema: REVIEW_SCHEMA,
      prompt: `${contextBlock(ctx, draws(draft.formats))}

<request>
${describeDraft(draft, ctx.name)}
</request>

Review this request before it goes to the creative team. Flag only real problems:
- net new counts that go over what's left of the monthly allotment (block; say by how much and that it needs an upgrade or variations instead). Skip this if no allotment is set.
- anything that goes against client memory, especially "avoid" items (block)
- content that's off-topic for this client or doesn't match the campaign direction set by the title, angle and audience (block if clearly wrong, warn if unclear)
- contradictions inside the request, e.g. the brief describes video but only images are picked, or sizes that don't fit the formats (warn)
- a brief too thin for a designer to start without questions (warn)
- claims that could get the ad rejected by Meta, e.g. personal attributes, before/after, guaranteed results (warn)
Don't flag style preferences or nitpicks. If nothing matters, verdict is "clear" with no issues.
summary: one sentence for the person who wrote it. For each issue, "fix" is a concrete change they can make.`,
    });
    return { ok: true, review: { ...review, issues: review.issues.slice(0, 6) } };
  } catch (e) {
    return { ok: false, error: e instanceof AiUnavailable ? e.message : "Couldn't review the request." };
  }
}

/** One ticket per selected format, routed to that format's maker. */
export async function createBatch(draft: Draft, review: Review | null): Promise<CreateResult> {
  await requireStaff();
  if (!draft.clientId) return { ok: false, error: "Pick a client." };
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
    p_ai_review: review,
  });
  if (error) return { ok: false, error: error.message };

  const { data: rows } = await supabase.from("requests").select("number").eq("batch_id", batch).order("number");
  revalidatePath("/board");
  revalidatePath("/pipeline");
  return { ok: true, numbers: (rows ?? []).map((r) => r.number) };
}
