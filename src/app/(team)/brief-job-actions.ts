"use server";

import { after } from "next/server";
import { aiEnabled } from "@/lib/ai";
import { requireStaff } from "@/lib/auth";
import { myBriefJobs, queueBriefJob, runBriefJob, type BriefJob } from "@/lib/brief-jobs";
import { notLive } from "@/lib/live-guard";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { loadSuggestion, type OpenSuggestion, type WinnerSource } from "@/lib/suggestions";

// Briefs asked for from a card (a winner, a tiring ad): written in the background (src/lib/brief-jobs.ts). A draft
// already written for the same ad opens at once; otherwise a job starts and the page follows its progress.

type Started = { ok: true; suggestion: OpenSuggestion } | { ok: true; job: BriefJob } | { ok: false; error: string };

async function started(jobId: string): Promise<Started> {
  const me = await requireStaff();
  const jobs = await myBriefJobs(createAdminClient(), me.id);
  const job = jobs.find((j) => j.id === jobId);
  return job ? { ok: true, job } : { ok: false, error: "Couldn't start the brief." };
}

/** Brief more like this winning ad */
export async function startWinnerBrief(w: WinnerSource, clientId: string, from: string | null): Promise<Started> {
  { const why = await notLive(await createClient(), clientId); if (why) return { ok: false, error: why }; }
  const me = await requireStaff();
  if (!aiEnabled() || !adminConfigured()) return { ok: false, error: "The AI isn't connected here." };
  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("creative_suggestions")
    .select("id")
    .eq("kind", "winner")
    .eq("status", "open")
    .eq("client_id", clientId)
    .eq("created_by", me.id)
    .eq("source->>adId", w.adId)
    .limit(1);
  if (existing?.[0]) {
    const suggestion = await loadSuggestion(supabase, existing[0].id as string);
    if (suggestion) return { ok: true, suggestion };
  }
  const admin = createAdminClient();
  const id = await queueBriefJob(admin, { kind: "winner", clientId, profileId: me.id, input: { winner: w, from }, title: w.headline ? `More like “${w.headline}”` : "More like this winner", key: w.adId });
  after(() => runBriefJob(createAdminClient(), id));
  return started(id);
}

/** A refresh for a tiring ad (the watch list's own rules: only clients this person works on) */
export async function startRefreshBrief(clientId: string, adId: string, headline: string | null, from: string | null): Promise<Started> {
  { const why = await notLive(await createClient(), clientId); if (why) return { ok: false, error: why }; }
  const me = await requireStaff();
  if (!aiEnabled() || !adminConfigured()) return { ok: false, error: "The AI isn't connected here." };
  const supabase = await createClient();
  const { data: watched } = await supabase.from("ad_fatigue").select("ad_id").eq("client_id", clientId).eq("ad_id", adId).maybeSingle();
  if (!watched) return { ok: false, error: "That ad isn't on your watch list." };
  const { data: existing } = await supabase.from("creative_suggestions").select("id").eq("kind", "refresh").eq("status", "open").eq("client_id", clientId).eq("source->>adId", adId).limit(1);
  if (existing?.[0]) {
    const suggestion = await loadSuggestion(supabase, existing[0].id as string);
    if (suggestion) return { ok: true, suggestion };
  }
  const admin = createAdminClient();
  const id = await queueBriefJob(admin, { kind: "refresh", clientId, profileId: me.id, input: { adId, from }, title: headline ? `A refresh for “${headline}”` : "A refresh for a tiring ad", key: adId });
  after(() => runBriefJob(createAdminClient(), id));
  return started(id);
}

/** The briefs this person has writing, and the finished ones not yet shown. Quiet when signed out. */
export async function myJobs(): Promise<BriefJob[]> {
  const db = await createClient();
  const { data: claims } = await db.auth.getClaims();
  const id = claims?.claims?.sub as string | undefined;
  if (!id) return [];
  return myBriefJobs(db, id).catch(() => []);
}

/** Shown (the toast went up, or it was opened): it stops coming back */
export async function markJobsSeen(ids: string[]) {
  const me = await requireStaff();
  if (!ids.length || !adminConfigured()) return;
  await createAdminClient().from("brief_jobs").update({ seen_at: new Date().toISOString() }).in("id", ids.slice(0, 20)).eq("profile_id", me.id).is("seen_at", null);
}

/** A finished brief, to open in its sheet */
export async function openBrief(suggestionId: string): Promise<OpenSuggestion | null> {
  await requireStaff();
  return loadSuggestion(await createClient(), suggestionId);
}
