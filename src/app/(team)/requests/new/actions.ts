"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import {
  AGENCY_SYSTEM,
  AiUnavailable,
  REVIEW_SCHEMA,
  SUGGESTIONS_SCHEMA,
  askJson,
  clientContext,
  contextBlock,
  type Review,
  type Suggestions,
} from "@/lib/ai";
import { createClient } from "@/lib/supabase/server";
import { FORMATS, SIZES, describeDraft, refLinks, selectedFormats, type Draft } from "./draft";

type Fail = { ok: false; error: string };
export type CreateResult = { ok: true; numbers: number[] } | Fail;
/** What the AI read, so the form can say so. */
export type ContextSummary = { requests: number; angles: number; memory: number; adAccount: boolean };
export type SuggestResult = { ok: true; suggestions: Suggestions; context: ContextSummary } | Fail;
export type ReviewResult = { ok: true; review: Review } | Fail;

const clamp = (n: unknown) => Math.min(100, Math.max(0, Math.floor(Number(n) || 0)));

async function loadContext(clientId: string | null) {
  await requireStaff();
  if (!clientId) return null;
  const supabase = await createClient();
  return clientContext(supabase, clientId);
}

/** Suggestions for every field, from what we know about the client and what's filled in so far. */
export async function suggestForRequest(draft: Draft): Promise<SuggestResult> {
  const ctx = await loadContext(draft.clientId);
  if (!ctx) return { ok: false, error: "Pick a client first." };
  try {
    const raw = await askJson<Suggestions>({
      system: AGENCY_SYSTEM,
      effort: "low",
      schema: SUGGESTIONS_SCHEMA,
      prompt: `${contextBlock(ctx)}

<draft_so_far>
${describeDraft(draft, ctx.name)}
</draft_so_far>

Suggest values for this request. Build on what's already filled in; don't contradict it.
- titles: 3 short ticket titles (under 50 characters), in the style of the recent requests if there are any.
- angles: up to 3. Prefer existing angles that fit; a new one only when it's clearly better. "why" is one short sentence.
- audiences: up to 3 short audience descriptions.
- mix: the formats and counts you'd make for this request, with 1 to 6 net new per format and variations only when testing copy or hooks makes sense. mixWhy: one sentence.
- sizes: the sizes to deliver.
- brief: a ready-to-use brief for the designer or editor, 4 to 8 lines: what to show, what to say, the hook, on-image text limits, and what to avoid from client memory.
- hooks: up to 4 opening hooks or headlines to try.
- watchouts: client memory items that matter for this request, rephrased as short reminders. Empty if none.`,
    });
    // Keep the model's output inside what the form accepts
    const suggestions: Suggestions = {
      ...raw,
      titles: raw.titles.slice(0, 3),
      angles: raw.angles.slice(0, 3),
      audiences: raw.audiences.slice(0, 3),
      hooks: raw.hooks.slice(0, 4),
      watchouts: raw.watchouts.slice(0, 4),
      mix: raw.mix
        .filter((m, i, all) => FORMATS.includes(m.format) && all.findIndex((x) => x.format === m.format) === i)
        .map((m) => ({ ...m, new: clamp(m.new), variations: clamp(m.variations) }))
        .filter((m) => m.new + m.variations > 0),
      sizes: raw.sizes.filter((s) => SIZES.includes(s)),
    };
    return {
      ok: true,
      suggestions,
      context: { requests: ctx.recent.length, angles: ctx.angles.length, memory: ctx.memory.length, adAccount: ctx.adAccountConnected },
    };
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
      system: AGENCY_SYSTEM,
      effort: "medium",
      schema: REVIEW_SCHEMA,
      prompt: `${contextBlock(ctx)}

<request>
${describeDraft(draft, ctx.name)}
</request>

Review this request before it goes to the creative team. Flag only real problems:
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
