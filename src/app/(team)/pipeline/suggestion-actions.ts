"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { AiUnavailable, aiEnabled } from "@/lib/ai";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { createAdminClient, adminConfigured } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { regenerate, runStrategist, type SuggestionDraft } from "@/lib/suggestions";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

async function lead() {
  const me = await requireStaff();
  if (!isExecOrLead(me)) throw new Error("Only execs and leads can do this.");
  return me;
}

/** Look across the accounts now (in the background; the Home page picks the suggestions up as they land). */
export async function refreshSuggestions(): Promise<Result> {
  const me = await lead();
  if (!aiEnabled() || !adminConfigured()) return { ok: false, error: "The AI isn't connected here." };
  const admin = createAdminClient();
  const { data: running } = await admin
    .from("suggestion_runs")
    .select("id")
    .is("finished_at", null)
    .gte("started_at", new Date(Date.now() - 10 * 60_000).toISOString())
    .limit(1);
  if (running?.length) return { ok: true };
  after(() => runStrategist(admin, me.id).then(() => revalidatePath("/pipeline")));
  return { ok: true };
}

/** Edits are kept as they're made. */
export async function saveSuggestion(id: string, draft: SuggestionDraft): Promise<Result> {
  await lead();
  const supabase = await createClient();
  const { error } = await supabase.from("creative_suggestions").update({ draft, edited: true, updated_at: new Date().toISOString() }).eq("id", id).eq("status", "open");
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Approve: the tickets are made from the suggestion as it stands, and go straight to the makers. */
export async function approveSuggestion(id: string, draft: SuggestionDraft): Promise<Result<{ numbers: number[] }>> {
  const me = await lead();
  const supabase = await createClient();
  const { data: s } = await supabase.from("creative_suggestions").select("client_id, status, original, signal").eq("id", id).single();
  if (!s || s.status !== "open") return { ok: false, error: "This suggestion was already decided." };
  const items = draft.formats.filter((f) => f.new + f.variations > 0);
  if (!draft.title.trim()) return { ok: false, error: "Give it a title." };
  if (!items.length) return { ok: false, error: "Pick at least one format." };

  const concepts = draft.concepts.length
    ? `\n\nConcepts:\n${draft.concepts.map((c, i) => `${i + 1}. ${c.name}\n   Hook: ${c.hook}\n   Visual: ${c.visual}\n   Copy: ${c.copy}`).join("\n")}`
    : "";
  const hooks = draft.hooks.length ? `\n\nHooks to try:\n${draft.hooks.map((h) => `- ${h}`).join("\n")}` : "";
  const { data: batch, error } = await supabase.rpc("create_request_batch", {
    p_client: s.client_id,
    p_title: draft.title.trim(),
    p_items: items,
    p_priority: "normal",
    p_angle: draft.angle.trim() || null,
    p_audience: draft.audience.trim() || null,
    p_brief: `${draft.brief.trim()}${concepts}${hooks}\n\n(Suggested by the AI strategist: ${s.signal})`,
    p_refs: [],
    p_sizes: draft.sizes,
    p_ai_review: null,
  });
  if (error) return { ok: false, error: error.message };
  const { data: rows } = await supabase.from("requests").select("id, number").eq("batch_id", batch).order("number");
  const numbers = (rows ?? []).map((r) => r.number as number);
  if (adminConfigured()) {
    const admin = createAdminClient();
    const landing = draft.landing?.trim();
    if (landing && /^https?:\/\/\S+\.\S+/i.test(landing) && rows?.length) await admin.from("requests").update({ landing_url: landing.slice(0, 500) }).in("id", rows.map((r) => r.id));
    await admin
      .from("creative_suggestions")
      .update({ status: "approved", draft, edited: JSON.stringify(draft) !== JSON.stringify(s.original), decided_by: me.id, decided_at: new Date().toISOString(), request_numbers: numbers })
      .eq("id", id);
  }
  revalidatePath("/pipeline");
  revalidatePath("/board");
  return { ok: true, numbers };
}

/** Decline, with the reason (the strategist reads it next time). Optionally remembered for the client too. */
export async function declineSuggestion(id: string, reason: string, remember: boolean): Promise<Result> {
  const me = await lead();
  const why = reason.trim();
  if (why.length < 3) return { ok: false, error: "Say why, so it learns." };
  const supabase = await createClient();
  const { data: s, error } = await supabase
    .from("creative_suggestions")
    .update({ status: "declined", decline_reason: why.slice(0, 600), decided_by: me.id, decided_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "open")
    .select("client_id, draft")
    .single();
  if (error || !s) return { ok: false, error: error?.message ?? "Already decided." };
  if (remember)
    await supabase.from("client_memory").insert({ client_id: s.client_id, kind: "note", body: `Strategy: "${(s.draft as SuggestionDraft).title}" was declined: ${why}`.slice(0, 1000), source: "team", created_by: me.id });
  revalidatePath("/pipeline");
  return { ok: true };
}

/** A message to the strategist about one suggestion; it answers and rewrites the suggestion if asked. */
export async function chatSuggestion(id: string, text: string): Promise<Result<{ draft: SuggestionDraft; why: string; reply: string }>> {
  const me = await lead();
  const body = text.trim();
  if (!body) return { ok: false, error: "Write something first." };
  if (!adminConfigured()) return { ok: false, error: "The AI isn't connected here." };
  const supabase = await createClient();
  const { error } = await supabase.from("suggestion_messages").insert({ suggestion_id: id, role: "user", author_id: me.id, body: body.slice(0, 2000) });
  if (error) return { ok: false, error: error.message };
  try {
    return { ok: true, ...(await regenerate(createAdminClient(), id)) };
  } catch (e) {
    return { ok: false, error: e instanceof AiUnavailable ? e.message : "The strategist couldn't answer. Try again." };
  }
}
