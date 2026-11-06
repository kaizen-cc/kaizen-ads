"use server";

import { after } from "next/server";
import { aiEnabled } from "@/lib/ai";
import { requireStaff } from "@/lib/auth";
import { JOB_KIND, myBriefJobs, queueBriefJob, runBriefJob, type BriefJob } from "@/lib/brief-jobs";
import { notLive } from "@/lib/live-guard";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { loadSuggestion, type OpenSuggestion, type SuggestionDraft, type WinnerSource } from "@/lib/suggestions";
import { jobKeyOf, type BriefSource, type QuickBrief } from "@/lib/quick-brief";
import { clampFormats, formatsFor } from "@/lib/creative-formats";

// Briefs asked for from a card (a winner, a tiring ad): written in the background (src/lib/brief-jobs.ts). A draft
// already written for the same ad opens at once; otherwise a job starts and the page follows its progress. From the
// quick preview (seed: what the person agreed), a fresh one is always written, following it; part numbers the briefs of
// a split, each its own job.

/** What was agreed, kept to the formats this person requests (a designer images and carousels, a video editor video) */
const fitSeed = (seed: QuickBrief | null, me: { role: string; isExec: boolean; isLead: boolean }): QuickBrief | null => (seed ? { ...seed, formats: clampFormats(seed.formats ?? [], formatsFor(me)) } : null);

type Started = { ok: true; suggestion: OpenSuggestion } | { ok: true; job: BriefJob } | { ok: false; error: string };

async function started(jobId: string): Promise<Started> {
  const me = await requireStaff();
  const jobs = await myBriefJobs(createAdminClient(), me.id);
  const job = jobs.find((j) => j.id === jobId);
  return job ? { ok: true, job } : { ok: false, error: "Couldn't start the brief." };
}

/** Brief more like this winning ad */
export async function startWinnerBrief(w: WinnerSource, clientId: string, from: string | null, agreed: QuickBrief | null = null, part = 0): Promise<Started> {
  { const why = await notLive(await createClient(), clientId); if (why) return { ok: false, error: why }; }
  const me = await requireStaff();
  const seed = fitSeed(agreed, me);
  if (!aiEnabled() || !adminConfigured()) return { ok: false, error: "The AI isn't connected here." };
  const supabase = await createClient();
  const { data: existing } = seed
    ? { data: null }
    : await supabase.from("creative_suggestions").select("id").eq("kind", "winner").eq("status", "open").eq("client_id", clientId).eq("created_by", me.id).eq("source->>adId", w.adId).limit(1);
  if (existing?.[0]) {
    const suggestion = await loadSuggestion(supabase, existing[0].id as string);
    if (suggestion) return { ok: true, suggestion };
  }
  // Nothing written without someone agreeing its quick preview first
  if (!seed) return { ok: false, error: "Open its quick preview first." };
  const admin = createAdminClient();
  // Winners only from a client selling the same thing or in the same niche (the owner's rule)
  const { assertRelevantWinner } = await import("@/lib/industry");
  const unrelated = await assertRelevantWinner(admin, clientId, w).then(() => null, (e: unknown) => (e instanceof Error ? e.message : "That winner can't be briefed for this client."));
  if (unrelated) return { ok: false, error: unrelated };
  const id = await queueBriefJob(admin, { kind: "winner", clientId, profileId: me.id, input: { winner: w, from, seed }, title: seed?.title || (w.headline ? `More like “${w.headline}”` : "More like this winner"), key: part ? `${w.adId}#${part}` : w.adId });
  after(() => runBriefJob(createAdminClient(), id));
  return started(id);
}

/** A refresh for a tiring ad (the watch list's own rules: only clients this person works on) */
export async function startRefreshBrief(clientId: string, adId: string, headline: string | null, from: string | null, agreed: QuickBrief | null = null, part = 0): Promise<Started> {
  { const why = await notLive(await createClient(), clientId); if (why) return { ok: false, error: why }; }
  const me = await requireStaff();
  const seed = fitSeed(agreed, me);
  if (!aiEnabled() || !adminConfigured()) return { ok: false, error: "The AI isn't connected here." };
  const supabase = await createClient();
  const { data: watched } = await supabase.from("ad_fatigue").select("ad_id").eq("client_id", clientId).eq("ad_id", adId).maybeSingle();
  if (!watched) return { ok: false, error: "That ad isn't on your watch list." };
  const { data: existing } = seed ? { data: null } : await supabase.from("creative_suggestions").select("id").eq("kind", "refresh").eq("status", "open").eq("client_id", clientId).eq("source->>adId", adId).limit(1);
  if (existing?.[0]) {
    const suggestion = await loadSuggestion(supabase, existing[0].id as string);
    if (suggestion) return { ok: true, suggestion };
  }
  // Nothing written without someone agreeing its quick preview first
  if (!seed) return { ok: false, error: "Open its quick preview first." };
  const admin = createAdminClient();
  const id = await queueBriefJob(admin, { kind: "refresh", clientId, profileId: me.id, input: { adId, from, seed }, title: seed?.title || (headline ? `A refresh for “${headline}”` : "A refresh for a tiring ad"), key: part ? `${adId}#${part}` : adId });
  after(() => runBriefJob(createAdminClient(), id));
  return started(id);
}

export type BriefStarted = Started | { ok: true; ready: string };

/**
 * "Write the full brief" on any quick preview, from anywhere in the app: the full brief is written in the background
 * from what the person agreed (seed), and lands as a draft in Ready to send. A suggested brief already written in full
 * and left as it was needs no writing: it opens there at once. part numbers the briefs of a split (each its own job).
 */
export async function startBrief(clientId: string, source: BriefSource, agreed: QuickBrief, editedAsked: boolean, part = 0, from: string | null = null): Promise<BriefStarted> {
  const me = await requireStaff();
  // Only the formats this person can request (a designer images and carousels, a video editor video)
  const seed: QuickBrief = { ...agreed, formats: clampFormats(agreed.formats ?? [], formatsFor(me)) };
  const edited = editedAsked || seed.formats.length !== (agreed.formats ?? []).length;
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) return { ok: false, error: "Pick a client first." };
  const supabase = await createClient();
  {
    const why = await notLive(supabase, clientId);
    if (why) return { ok: false, error: why };
  }
  const { data: client } = await supabase.from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!client) return { ok: false, error: "That client isn't one you work on." };
  if (!aiEnabled() || !adminConfigured()) return { ok: false, error: "The AI isn't connected here." };
  // The same key the card it was started from looks its job up by (its progress, then "Brief ready")
  const key = jobKeyOf(source);
  let title = seed.title.trim() || null;
  switch (source.kind) {
    case "winner":
      title ??= source.winner.headline ? `More like “${source.winner.headline}”` : "More like this winner";
      break;
    case "refresh": {
      const { data: watched } = await supabase.from("ad_fatigue").select("ad_id, headline").eq("client_id", clientId).eq("ad_id", source.adId).maybeSingle();
      if (!watched) return { ok: false, error: "That ad isn't on your watch list." };
      title ??= watched.headline ? `A refresh for “${watched.headline}”` : "A refresh for a tiring ad";
      break;
    }
    case "market":
    case "pattern":
    case "idea":
    case "talk":
      break;
    case "promise": {
      const { data: c } = await supabase.from("call_commitments").select("id, client_id").eq("id", source.commitmentId).maybeSingle();
      if (!c || c.client_id !== clientId) return { ok: false, error: "That promise isn't on a client you work on." };
      break;
    }
    case "suggestion": {
      const { data: s } = await supabase.from("creative_suggestions").select("id, client_id, status, draft").eq("id", source.id).maybeSingle();
      if (!s || s.status !== "open" || s.client_id !== clientId) return { ok: false, error: "That brief isn't open any more." };
      // Written in full already and left as it was: straight to Ready to send
      if (!edited && !(s.draft as SuggestionDraft | null)?.summary) return { ok: true, ready: s.id as string };
      break;
    }
    default:
      return { ok: false, error: "That can't be briefed." };
  }
  const admin = createAdminClient();
  const kind = JOB_KIND[source.kind];
  const id = await queueBriefJob(admin, {
    kind,
    clientId,
    profileId: me.id,
    input: {
      source,
      seed,
      edited,
      from,
      ...(source.kind === "winner" ? { winner: source.winner } : {}),
      ...(source.kind === "refresh" ? { adId: source.adId } : {}),
    },
    title: title ?? "A new brief",
    key: part ? `${key}#${part}` : key,
  });
  after(() => runBriefJob(createAdminClient(), id));
  return started(id);
}

/**
 * The briefs this person has writing, and the finished ones not yet shown. Quiet when signed out. Read by their
 * profile id: profiles.id isn't the auth uid, and reading by the uid found nothing, so the card's progress went
 * away on the first check and no toast ever came (the bell's notice still did).
 */
export async function myJobs(): Promise<BriefJob[]> {
  const db = await createClient();
  const { data: claims } = await db.auth.getClaims();
  if (!claims?.claims?.sub) return [];
  const me = await requireStaff();
  return myBriefJobs(adminConfigured() ? createAdminClient() : db, me.id).catch(() => []);
}

/** A brief that couldn't be written, asked for again from what was agreed (the same source, seed and key) */
export async function retryBriefJob(jobId: string): Promise<Started> {
  const me = await requireStaff();
  if (!/^[0-9a-f-]{36}$/i.test(jobId) || !adminConfigured()) return { ok: false, error: "That brief isn't there." };
  const admin = createAdminClient();
  const { data: j } = await admin.from("brief_jobs").select("id, kind, client_id, profile_id, input, title, status").eq("id", jobId).maybeSingle();
  if (!j || j.profile_id !== me.id) return { ok: false, error: "That brief isn't yours." };
  if (j.status !== "failed") return started(j.id as string);
  {
    const why = await notLive(await createClient(), j.client_id as string);
    if (why) return { ok: false, error: why };
  }
  if (!aiEnabled()) return { ok: false, error: "The AI isn't connected here." };
  const input = (j.input ?? {}) as import("@/lib/brief-jobs").BriefJobInput & { key?: string };
  const id = await queueBriefJob(admin, { kind: j.kind as import("@/lib/brief-jobs").BriefJobKind, clientId: j.client_id as string, profileId: me.id, input, title: (j.title as string | null) ?? null, key: input.key ?? jobId });
  after(() => runBriefJob(createAdminClient(), id));
  return started(id);
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
