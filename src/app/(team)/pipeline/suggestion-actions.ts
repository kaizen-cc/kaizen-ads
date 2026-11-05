"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { AiUnavailable, aiEnabled } from "@/lib/ai";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { createAdminClient, adminConfigured } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { byConcept, regenerate, runStrategist, type SuggestionDraft } from "@/lib/suggestions";
import { conceptLine } from "@/lib/allotment";
import { formatsFor, formatsOutside, formatsPhrase } from "@/lib/creative-formats";

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
  await requireStaff(); // the suggestion's own rules decide: execs, leads, or whoever started it from a winner
  const supabase = await createClient();
  const { error } = await supabase.from("creative_suggestions").update({ draft, edited: true, updated_at: new Date().toISOString() }).eq("id", id).eq("status", "open");
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Approve: the tickets are made from the suggestion as it stands, and go straight to the makers. */
export async function approveSuggestion(id: string, draft: SuggestionDraft): Promise<Result<{ numbers: number[] }>> {
  const me = await requireStaff(); // the suggestion's own rules decide: execs, leads, or whoever started it from a winner
  const supabase = await createClient();
  const { data: s } = await supabase.from("creative_suggestions").select("client_id, status, original, signal, kind, source, draft").eq("id", id).single();
  if (!s || s.status !== "open") return { ok: false, error: "This suggestion was already decided." };
  // Only its summary so far: nothing is made from a brief nobody wrote. The full brief comes first (its quick preview)
  if ((s.draft as SuggestionDraft | null)?.summary || draft.summary) return { ok: false, error: "Only its summary is written so far. Write the full brief first." };
  if (!draft.title.trim()) return { ok: false, error: "Give it a title." };
  if (!draft.formats.some((f) => f.new + f.variations > 0)) return { ok: false, error: "Pick at least one format." };
  {
    // Only the formats this person requests (a designer images and carousels, a video editor video; leads everything)
    const allowed = formatsFor(me);
    if (formatsOutside(draft.formats.filter((f) => f.new + f.variations > 0).map((f) => f.format), allowed).length) return { ok: false, error: `Your requests are for ${formatsPhrase(allowed)}. A lead can approve the rest.` };
  }

  // One concept per brief and per ticket: a suggestion is written with one concept (a new client's first round is one
  // suggestion per concept); one that still holds several becomes one ticket each, with that concept's own counts
  const rows: { id: string; number: number }[] = [];
  for (const part of byConcept(draft)) {
    const items = part.formats.filter((f) => f.new + f.variations > 0);
    if (!items.length) continue;
    const c = part.concepts[0];
    const concept = c ? `\n\nConcept (${items.map((f) => conceptLine(f.format, f)).join("; ")}): ${c.name}\n   Hook: ${c.hook}\n   Visual: ${c.visual}\n   Copy: ${c.copy}` : "";
    const hooks = part.hooks.length ? `\n\nWhat each version tests:\n${part.hooks.map((h) => `- ${h}`).join("\n")}` : "";
    const { data: batch, error } = await supabase.rpc("create_request_batch", {
      p_client: s.client_id,
      p_title: part.title.trim() || draft.title.trim(),
      p_items: items,
      p_priority: "normal",
      p_angle: part.angle.trim() || null,
      p_audience: part.audience.trim() || null,
      p_brief: `${part.brief.trim()}${concept}${hooks}\n\n(Suggested by the AI strategist: ${s.signal})`,
      p_refs: (part.refs ?? []).filter((u) => /^https?:\/\//i.test(u)).slice(0, 20),
      p_sizes: part.sizes,
      p_ai_review: null,
    });
    if (error) return { ok: false, error: rows.length ? `${error.message} (tickets ${rows.map((r) => `#${r.number}`).join(", ")} were made)` : error.message };
    const { data: made } = await supabase.from("requests").select("id, number").eq("batch_id", batch).order("number");
    rows.push(...((made ?? []) as { id: string; number: number }[]));
  }
  if (!rows.length) return { ok: false, error: "Pick at least one format." };
  const numbers = rows.map((r) => r.number);
  if (adminConfigured()) {
    const admin = createAdminClient();
    const landing = draft.landing?.trim();
    if (landing && /^https?:\/\/\S+\.\S+/i.test(landing) && rows?.length) await admin.from("requests").update({ landing_url: landing.slice(0, 500) }).in("id", rows.map((r) => r.id));
    // What it was built on, on every ticket: the winner, the market ad, the promise, or the AI's read of the account
    const src = (s.source ?? {}) as { headline?: string | null; client?: string | null; thumbnail?: string | null };
    const kind = s.kind === "winner" ? "winner" : s.kind === "market" ? "market" : s.kind === "call" ? "promise" : "brief";
    const origin = {
      kind,
      label: (kind === "winner" ? `${src.client ?? "A client"}'s winning ad${src.headline ? `: "${src.headline}"` : ""}` : kind === "market" ? `${src.client ?? "A brand"}'s live ad${src.headline ? `: ${src.headline}` : ""}` : s.signal).slice(0, 200),
      link: (draft.refs ?? [])[0] ?? null,
      thumb: src.thumbnail ?? null,
    };
    if (rows?.length) await admin.from("requests").update({ origin }).in("id", rows.map((r) => r.id));
    await admin
      .from("creative_suggestions")
      .update({ status: "approved", draft, edited: JSON.stringify(draft) !== JSON.stringify(s.original), decided_by: me.id, decided_at: new Date().toISOString(), request_numbers: numbers })
      .eq("id", id);
    // A refresh for a tiring ad: the watch list shows it's being replaced, with the tickets
    const adId = (s.source as { adId?: string } | null)?.adId;
    // A promise from a call: it's in motion now, with the tickets
    if (s.kind === "call")
      await admin.from("call_commitments").update({ status: "in_motion", request_numbers: numbers }).eq("suggestion_id", id);
    if (s.kind === "refresh" && adId)
      await admin.from("ad_fatigue").update({ state: "refreshing", request_numbers: numbers, updated_at: new Date().toISOString() }).eq("client_id", s.client_id).eq("ad_id", adId);
    // Anyone who saved this idea for the client: it's in motion now (out of their saved list, and they hear who has it)
    try {
      const { markIdeasUsed } = await import("@/lib/saved-used");
      await markIdeasUsed(admin, { clientId: s.client_id as string, suggestionId: id, requestId: rows[0].id, href: `/board?t=${rows[0].number}`, title: draft.title.trim() || null, by: { id: me.id, name: me.fullName } });
    } catch (e) {
      console.error("[saved] marking used failed:", e instanceof Error ? e.message : e);
    }
    // Any other brief that happens to make something promised on a call clears that promise too
    if (s.kind !== "call") {
      const clientId = s.client_id as string;
      after(async () => {
        const { sweepCovered } = await import("@/lib/calls");
        await sweepCovered(createAdminClient(), clientId).catch((e) => console.error("[calls] promise check failed:", e instanceof Error ? e.message : e));
      });
    }
  }
  revalidatePath("/pipeline");
  revalidatePath("/board");
  return { ok: true, numbers };
}

/**
 * Approve all: every concept of a batch still open (a new client's first round), each as it stands, each its own
 * ticket. Concepts someone already approved or declined are left as they are.
 */
export async function approveRound(batchId: string): Promise<Result<{ numbers: number[]; skipped: string[] }>> {
  await requireStaff(); // each suggestion's own rules decide, as for one
  const supabase = await createClient();
  const { data: open } = await supabase.from("creative_suggestions").select("id, draft").eq("batch_id", batchId).eq("status", "open").order("created_at");
  if (!open?.length) return { ok: false, error: "Nothing left to approve in this round." };
  const numbers: number[] = [];
  const skipped: string[] = [];
  for (const s of open) {
    const draft = s.draft as SuggestionDraft;
    const r = await approveSuggestion(s.id as string, draft);
    if (r.ok) numbers.push(...r.numbers);
    else skipped.push(`${draft.title || "A concept"}: ${r.error}`);
  }
  if (!numbers.length) return { ok: false, error: skipped.join(" · ") || "Nothing was approved." };
  return { ok: true, numbers, skipped };
}

/** Decline, with the reason (the strategist reads it next time). Optionally remembered for the client too. */
export async function declineSuggestion(id: string, reason: string, remember: boolean): Promise<Result> {
  const me = await requireStaff(); // the suggestion's own rules decide: execs, leads, or whoever started it from a winner
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
  if (adminConfigured())
    await createAdminClient().from("call_commitments").update({ status: "dismissed", dismissed_by: me.id, dismiss_reason: why.slice(0, 300) }).eq("suggestion_id", id).eq("status", "briefed");
  if (remember)
    await supabase.from("client_memory").insert({ client_id: s.client_id, kind: "note", body: `Strategy: "${(s.draft as SuggestionDraft).title}" was declined: ${why}`.slice(0, 1000), source: "team", created_by: me.id });
  revalidatePath("/pipeline");
  return { ok: true };
}

/** A message to the strategist about one suggestion; it answers and rewrites the suggestion if asked. */
export async function chatSuggestion(id: string, text: string): Promise<Result<{ draft: SuggestionDraft; why: string; reply: string }>> {
  const me = await requireStaff(); // the suggestion's own rules decide: execs, leads, or whoever started it from a winner
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
