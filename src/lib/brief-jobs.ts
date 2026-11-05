import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AiUnavailable } from "@/lib/ai";
import { notify } from "@/lib/owed-replies";
import { loadSuggestion, suggestFromWinner, suggestRefresh, type WinnerSource } from "@/lib/suggestions";
import type { QuickBrief } from "@/lib/quick-brief";

// Briefs written in the background. Asking for one queues a job; the server writes it right after answering (and a
// cron run every five minutes picks up anything a cut-off server left behind), so a refresh or leaving the page never
// loses it. Its progress is measured against how long that kind of brief has taken lately, and when it's ready the
// person gets a toast and a bell notification that open it.

export type BriefJobKind = "winner" | "refresh";
export type BriefJobInput = { winner?: WinnerSource; adId?: string; from?: string | null; /** The quick preview the person agreed (and maybe edited): the full brief follows it */ seed?: QuickBrief | null };
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
  /** The ad it's written from */
  key: string | null;
};

export const JOB_LABEL: Record<BriefJobKind, string> = { winner: "brief from a winner", refresh: "refresh a tiring ad" };
const FALLBACK_MS: Record<BriefJobKind, number> = { winner: 45_000, refresh: 50_000 };

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

/** Queue one; an open job for the same ad and person is reused instead of starting another */
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

const withParam = (from: string | null | undefined, key: string, value: string) => {
  const base = from && from.startsWith("/") ? from : "/pipeline";
  const [path, query = ""] = base.split("?");
  const q = new URLSearchParams(query);
  q.set(key, value);
  return `${path}?${q.toString()}`;
};

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
    const sid =
      kind === "winner"
        ? await suggestFromWinner(admin, job.client_id as string, input.winner as WinnerSource, job.profile_id as string, undefined, input.seed ?? null)
        : await suggestRefresh(admin, job.client_id as string, input.adId as string, job.profile_id as string, input.seed ?? null);
    const s = await loadSuggestion(admin, sid);
    await admin.from("brief_jobs").update({ status: "ready", suggestion_id: sid, finished_at: new Date().toISOString(), title: s?.draft.title ?? job.title }).eq("id", id);
    await notify(admin, [job.profile_id as string], {
      key: `brief_ready:${id}`,
      kind: "brief_ready",
      title: `Your brief is ready${s?.client ? ` — ${s.client}` : ""}`,
      body: s?.draft.title ?? (job.title as string | null) ?? "Open it to approve, create it or send it to Asana.",
      href: withParam(input.from, "ready", sid),
      clientId: job.client_id as string | null,
      priority: "normal",
    });
    return { ran: true, ok: true };
  } catch (e) {
    const message = e instanceof AiUnavailable ? e.message : "The strategist couldn't write it. Try again.";
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

/** A person's jobs still writing, and the finished ones they haven't been shown yet */
export async function myBriefJobs(db: SupabaseClient, profileId: string): Promise<BriefJob[]> {
  const since = new Date(Date.now() - 6 * 3600_000).toISOString();
  const { data } = await db
    .from("brief_jobs")
    .select("id, kind, title, status, suggestion_id, error, expected_ms, started_at, created_at, finished_at, seen_at, input, clients(name)")
    .eq("profile_id", profileId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(12);
  return (data ?? [])
    .filter((j) => j.status === "queued" || j.status === "writing" || !j.seen_at)
    .map((j) => ({
      id: j.id as string,
      kind: j.kind as BriefJobKind,
      title: (j.title as string | null) ?? null,
      client: ((j.clients as unknown as { name?: string } | null)?.name as string | undefined) ?? null,
      status: j.status as BriefJob["status"],
      suggestionId: (j.suggestion_id as string | null) ?? null,
      error: (j.error as string | null) ?? null,
      expectedMs: (j.expected_ms as number | null) ?? FALLBACK_MS[j.kind as BriefJobKind],
      startedAt: (j.started_at as string | null) ?? null,
      createdAt: j.created_at as string,
      finishedAt: (j.finished_at as string | null) ?? null,
      seen: Boolean(j.seen_at),
      from: ((j.input as BriefJobInput | null)?.from as string | null | undefined) ?? null,
      key: ((j.input as { key?: string } | null)?.key as string | undefined) ?? null,
    }));
}
