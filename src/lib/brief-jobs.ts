import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AiUnavailable } from "@/lib/ai";
import { notify } from "@/lib/owed-replies";
import { loadSuggestion, suggestFromWinner, suggestRefresh, type SuggestionDraft, type WinnerSource } from "@/lib/suggestions";
import type { BriefSource, QuickBrief } from "@/lib/quick-brief";

// Briefs written in the background. Asking for one queues a job; the server writes it right after answering (and a
// cron run every five minutes picks up anything a cut-off server left behind), so a refresh or leaving the page never
// loses it. Its progress is measured against how long that kind of brief has taken lately, and when it's ready the
// person gets a toast and a bell notification that open it as a draft in Ready to send (/requests/new?draft=).
// Every full brief a person picks from a quick preview is written here, wherever the preview was opened.

export type BriefJobKind = "winner" | "refresh" | "market" | "pattern" | "promise" | "idea" | "talk" | "suggestion";
export type BriefJobInput = {
  winner?: WinnerSource;
  adId?: string;
  from?: string | null;
  /** The quick preview the person agreed (and maybe edited): the full brief follows it */
  seed?: QuickBrief | null;
  /** What it's written from (the first two kinds also keep winner and adId, as they always have) */
  source?: BriefSource;
  /** The person changed the preview of a brief already written: it's rewritten to match */
  edited?: boolean;
};
export type BriefJob = {
  id: string;
  kind: BriefJobKind;
  title: string | null;
  client: string | null;
  status: "queued" | "writing" | "ready" | "failed";
  suggestionId: string | null;
  error: string | null;
  expectedMs: number;
  startedAt: string | null;
  createdAt: string;
  finishedAt: string | null;
  seen: boolean;
  from: string | null;
  /** The ad (or source) it's written from (jobKeyOf in src/lib/quick-brief.ts; a split's briefs add "#part") */
  key: string | null;
  clientId: string | null;
};

export const JOB_LABEL: Record<BriefJobKind, string> = {
  winner: "brief from a winner",
  refresh: "refresh a tiring ad",
  market: "brief from a market ad",
  pattern: "brief from a pattern",
  promise: "brief from a call",
  idea: "brief from an idea",
  talk: "brief from an idea",
  suggestion: "brief from a summary",
};
const FALLBACK_MS: Record<BriefJobKind, number> = { winner: 45_000, refresh: 50_000, market: 60_000, pattern: 60_000, promise: 60_000, idea: 60_000, talk: 60_000, suggestion: 60_000 };

/** Which job writes a brief from this source */
export const JOB_KIND: Record<BriefSource["kind"], BriefJobKind> = { winner: "winner", refresh: "refresh", market: "market", pattern: "pattern", promise: "promise", idea: "idea", talk: "talk", suggestion: "suggestion" };

/** Where a finished brief opens: as a draft in Ready to send, the request as the team will receive it */
export const readyHref = (suggestionId: string) => `/requests/new?draft=${suggestionId}`;

/** A reason the brief can't be written that the person should read as it is */
class JobRefused extends Error {}

/** How long this kind of brief usually takes: the last 20 finished jobs and AI runs for it, the typical one */
export async function expectedMs(admin: SupabaseClient, kind: BriefJobKind) {
  const [{ data: runs }, { data: jobs }] = await Promise.all([
    admin.from("ai_runs").select("ms").eq("label", JOB_LABEL[kind]).not("ms", "is", null).order("created_at", { ascending: false }).limit(20),
    admin.from("brief_jobs").select("started_at, finished_at").eq("kind", kind).eq("status", "ready").not("started_at", "is", null).order("created_at", { ascending: false }).limit(20),
  ]);
  const xs = [
    ...(runs ?? []).map((r) => Number(r.ms)),
    ...(jobs ?? []).map((j) => Date.parse(j.finished_at as string) - Date.parse(j.started_at as string)),
  ].filter((x) => Number.isFinite(x) && x > 2000 && x < 600_000);
  if (xs.length < 3) return FALLBACK_MS[kind];
  // The middle of the spread, nudged up a little so the bar rarely runs past the end
  const sorted = xs.sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length * 0.6)] * 1.1);
}

/** Queue one; an open job for the same source and person is reused instead of starting another */
export async function queueBriefJob(admin: SupabaseClient, j: { kind: BriefJobKind; clientId: string; profileId: string; input: BriefJobInput; title: string | null; key: string }) {
  const { data: open } = await admin
    .from("brief_jobs")
    .select("id")
    .eq("profile_id", j.profileId)
    .eq("kind", j.kind)
    .eq("client_id", j.clientId)
    .eq("input->>key", j.key)
    .in("status", ["queued", "writing"])
    .limit(1);
  if (open?.[0]) return open[0].id as string;
  const { data, error } = await admin
    .from("brief_jobs")
    .insert({ kind: j.kind, label: JOB_LABEL[j.kind], client_id: j.clientId, profile_id: j.profileId, input: { ...j.input, key: j.key }, title: j.title?.slice(0, 160) ?? null, expected_ms: await expectedMs(admin, j.kind) })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Couldn't queue the brief.");
  return data.id as string;
}

/** The full brief for one job, written through its usual writer: the suggestion it's kept as */
async function writeJob(admin: SupabaseClient, kind: BriefJobKind, clientId: string, by: string, input: BriefJobInput): Promise<string> {
  const seed = input.seed ?? null;
  const src = input.source;
  if (kind === "winner") return suggestFromWinner(admin, clientId, (input.winner ?? (src?.kind === "winner" ? src.winner : null)) as WinnerSource, by, src?.kind === "winner" ? src.format : undefined, seed);
  if (kind === "refresh") return suggestRefresh(admin, clientId, (input.adId ?? (src?.kind === "refresh" ? src.adId : "")) as string, by, seed);
  const s = await import("@/lib/suggestions");
  switch (src?.kind) {
    case "market":
      return s.suggestFromMarket(admin, clientId, src.adId, by, src.format, seed);
    case "pattern": {
      const { patternById } = await import("@/lib/patterns");
      const p = await patternById(admin, src.patternId);
      if (!p) throw new JobRefused("That pattern isn't there any more.");
      return s.suggestForPattern(admin, clientId, p, by, seed);
    }
    case "promise": {
      const { data: before } = await admin.from("call_commitments").select("suggestion_id").eq("id", src.commitmentId).maybeSingle();
      const { briefPromise } = await import("@/lib/calls");
      const id = await briefPromise(admin, src.commitmentId, seed);
      if (!id) throw new JobRefused("This promise isn't paid ads or creative work, so it's been taken off the list.");
      // Its brief was there already: written in full now if it was only a summary, or rewritten to what was changed
      if (id === before?.suggestion_id) {
        const { data: was } = await admin.from("creative_suggestions").select("draft").eq("id", id).maybeSingle();
        if ((was?.draft as SuggestionDraft | null)?.summary || input.edited) await s.rewriteWithSeed(admin, id, seed);
      }
      return id;
    }
    case "idea":
      return s.suggestFromIdeaSaved(admin, clientId, { label: src.label.slice(0, 300), text: src.text.slice(0, 4000) }, seed, by);
    case "talk":
      return s.suggestFromIdeaSaved(
        admin,
        clientId,
        { label: "Talked through with the strategist", text: src.turns.slice(-16).map((t) => `${t.role === "user" ? "Team member" : "Strategist"}: ${t.text.slice(0, 2000)}`).join("\n\n") },
        seed,
        by,
      );
    case "suggestion":
      await s.rewriteWithSeed(admin, src.id, seed);
      return src.id;
    default:
      throw new JobRefused("That isn't something a brief can be written from.");
  }
}

/** Write one queued job (claimed first, so two runners never write the same brief) */
export async function runBriefJob(admin: SupabaseClient, id: string) {
  const { data: job } = await admin
    .from("brief_jobs")
    .update({ status: "writing", started_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "queued")
    .select("id, kind, client_id, profile_id, input, title, attempts")
    .maybeSingle();
  if (!job) return { ran: false };
  await admin.from("brief_jobs").update({ attempts: (job.attempts as number) + 1 }).eq("id", id);
  const input = (job.input ?? {}) as BriefJobInput;
  const kind = job.kind as BriefJobKind;
  try {
    const sid = await writeJob(admin, kind, job.client_id as string, job.profile_id as string, input);
    // An idea with no id of its own (an audit's idea, a Kaizen AI card): kept on the brief, so sending it marks every
    // person's save of that idea used
    if (input.source?.kind === "idea") {
      const { ideaKeyOf } = await import("@/lib/saved-references");
      const k = ideaKeyOf(input.source);
      const { data: row } = await admin.from("creative_suggestions").select("source").eq("id", sid).maybeSingle();
      if (k && row) await admin.from("creative_suggestions").update({ source: { ...((row.source as Record<string, unknown> | null) ?? {}), savedKey: k } }).eq("id", sid);
    }
    const s = await loadSuggestion(admin, sid);
    await admin.from("brief_jobs").update({ status: "ready", suggestion_id: sid, finished_at: new Date().toISOString(), title: s?.draft.title ?? job.title }).eq("id", id);
    await notify(admin, [job.profile_id as string], {
      key: `brief_ready:${id}`,
      kind: "brief_ready",
      title: `Your brief is ready${s?.client ? `: ${s.client}` : ""}`,
      body: s?.draft.title ?? (job.title as string | null) ?? "Open it in Ready to send: check it, change anything, and send it.",
      href: readyHref(sid),
      clientId: job.client_id as string | null,
      priority: "normal",
    });
    return { ran: true, ok: true };
  } catch (e) {
    const message = e instanceof AiUnavailable || e instanceof JobRefused ? e.message : "The strategist couldn't write it. Try again.";
    console.error("[brief-jobs]", id, e instanceof Error ? e.message : e);
    await admin.from("brief_jobs").update({ status: "failed", error: message, finished_at: new Date().toISOString() }).eq("id", id);
    return { ran: true, ok: false };
  }
}

/** The cron's pickup: queued jobs nobody started (a server cut off before it began), and writes that died mid-way */
export async function pickUpBriefJobs(admin: SupabaseClient) {
  const stale = new Date(Date.now() - 60_000).toISOString();
  const dead = new Date(Date.now() - 12 * 60_000).toISOString();
  // A write that's run far past any brief: back in the queue once, then failed
  const { data: stuck } = await admin.from("brief_jobs").select("id, attempts").eq("status", "writing").lt("started_at", dead).limit(20);
  for (const j of stuck ?? []) {
    if ((j.attempts as number) >= 2) await admin.from("brief_jobs").update({ status: "failed", error: "It took too long. Try again.", finished_at: new Date().toISOString() }).eq("id", j.id);
    else await admin.from("brief_jobs").update({ status: "queued" }).eq("id", j.id).eq("status", "writing");
  }
  const { data: queued } = await admin.from("brief_jobs").select("id").eq("status", "queued").lt("created_at", stale).order("created_at").limit(4);
  let written = 0;
  for (const j of queued ?? []) if ((await runBriefJob(admin, j.id as string)).ok) written++;
  return { requeued: stuck?.length ?? 0, picked: queued?.length ?? 0, written };
}

/**
 * A person's jobs from the last few hours: still writing, or finished (shown or not), so the card each was started
 * from keeps its progress and then "Brief ready" through a refresh or another page
 */
export async function myBriefJobs(db: SupabaseClient, profileId: string): Promise<BriefJob[]> {
  const since = new Date(Date.now() - 6 * 3600_000).toISOString();
  const { data } = await db
    .from("brief_jobs")
    .select("id, kind, title, status, suggestion_id, error, expected_ms, started_at, created_at, finished_at, seen_at, input, client_id, clients(name)")
    .eq("profile_id", profileId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(30);
  return (data ?? [])
    .map((j) => ({
      id: j.id as string,
      kind: j.kind as BriefJobKind,
      title: (j.title as string | null) ?? null,
      client: ((j.clients as unknown as { name?: string } | null)?.name as string | undefined) ?? null,
      status: j.status as BriefJob["status"],
      suggestionId: (j.suggestion_id as string | null) ?? null,
      error: (j.error as string | null) ?? null,
      expectedMs: (j.expected_ms as number | null) ?? FALLBACK_MS[j.kind as BriefJobKind] ?? 60_000,
      startedAt: (j.started_at as string | null) ?? null,
      createdAt: j.created_at as string,
      finishedAt: (j.finished_at as string | null) ?? null,
      seen: Boolean(j.seen_at),
      from: ((j.input as BriefJobInput | null)?.from as string | null | undefined) ?? null,
      key: ((j.input as { key?: string } | null)?.key as string | undefined) ?? null,
      clientId: (j.client_id as string | null) ?? null,
    }));
}
