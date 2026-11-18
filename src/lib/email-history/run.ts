import "server-only";
import { clientsWithLine } from "@/lib/service-gate";
import type { SupabaseClient } from "@supabase/supabase-js";
import { providerName } from "@/lib/email-providers/core";
import { emailConnection } from "@/lib/email-providers/which";
import { historyBusy, historyGap, historyHolds, historySource, readingLine, HISTORY_MAX_DAYS, type HistoryState } from "./core";

// Deeper email history, read from the provider when a report or the KPI sheet asks for dates before what is stored. The
// state of each client's read lives in sync_state ("email-history:<client>"), so no table of its own: queued, running
// (with the oldest day read so far), done or failed. Klaviyo is read in pieces newest first (its Reporting API allows two
// queries a minute per account), Brevo and Customer.io with one deeper full read. Reports waiting on it are held and
// drafted when it lands.

const etToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const dayShift = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The first day the client has daily numbers for (null when nothing is stored yet) */
export async function storedFrom(admin: SupabaseClient, clientId: string): Promise<string | null> {
  const { data } = await admin.from("klaviyo_daily").select("date").eq("client_id", clientId).order("date", { ascending: true }).limit(1).maybeSingle();
  return (data?.date as string | undefined) ?? null;
}

export async function readHistoryState(admin: SupabaseClient, clientId: string): Promise<HistoryState | null> {
  const { data } = await admin.from("sync_state").select("last_result").eq("source", historySource(clientId)).maybeSingle();
  const s = data?.last_result as HistoryState | null | undefined;
  return s && typeof s === "object" && "status" in s ? s : null;
}

async function writeState(admin: SupabaseClient, clientId: string, s: HistoryState) {
  await admin.from("sync_state").upsert({ source: historySource(clientId), last_run_at: s.at, last_result: s });
}

export type HistoryAsk = { queued: boolean; state: HistoryState | null; line: string | null };

/**
 * A report (or the KPI sheet) wants numbers from `wantStart`: when that is before what is stored, queues the read of the
 * missing months (once; a read already covering the dates is left as it is). `floor` is the earliest day worth reading.
 */
export async function requestHistory(admin: SupabaseClient, clientId: string, p: { wantStart: string; asked: NonNullable<HistoryState["asked"]>; floor?: string | null }): Promise<HistoryAsk> {
  const conn = await emailConnection(admin, clientId);
  if (!conn || conn.status !== "active") return { queued: false, state: null, line: null };
  const today = etToday();
  const [stored, state] = await Promise.all([storedFrom(admin, clientId), readHistoryState(admin, clientId)]);
  const name = providerName(conn.provider);
  // What an earlier read already went through counts as covered, even when it found nothing there
  const covered = state && state.cursor && (state.status === "done" || state.status === "running" || state.status === "queued" || state.status === "failed") ? state.cursor : null;
  const gap = historyGap({ wantStart: p.wantStart, stored, covered, today, floor: p.floor });
  if (!gap) return { queued: false, state: historyBusy(state) ? state : null, line: historyBusy(state) && state ? readingLine(name, state.want, state.to) : null };
  if (historyBusy(state) && state && state.want <= gap.from) return { queued: false, state, line: readingLine(name, state.want, state.to) };
  const next: HistoryState = { status: "queued", want: gap.from, to: gap.to, cursor: null, pct: 0, step: "Waiting its turn", at: new Date().toISOString(), error: null, asked: p.asked };
  await writeState(admin, clientId, next);
  return { queued: true, state: next, line: readingLine(name, gap.from, gap.to) };
}

/** The read that holds a report back: queued or running, covering the report's first day */
export async function historyHolding(admin: SupabaseClient, clientId: string, periodStart: string): Promise<HistoryState | null> {
  const s = await readHistoryState(admin, clientId);
  return historyHolds(s, periodStart) ? s : null;
}

/** The line a report shows while it waits (null when nothing holds it) */
export async function readingFor(admin: SupabaseClient, clientId: string, periodStart: string): Promise<{ line: string; pct: number } | null> {
  const s = await historyHolding(admin, clientId, periodStart);
  if (!s) return null;
  const conn = await emailConnection(admin, clientId);
  return { line: readingLine(providerName(conn?.provider), s.want, s.to), pct: s.pct };
}

/** Works on one client's queued read for up to `budgetMs`; whatever is not done goes back in the queue from where it got to */
export async function runHistory(admin: SupabaseClient, clientId: string, budgetMs: number): Promise<{ ran: boolean; done?: boolean; error?: string | null }> {
  const state = await readHistoryState(admin, clientId);
  if (!state || state.status === "done" || state.status === "failed" || (state.status === "running" && historyBusy(state))) return { ran: false };
  const conn = await emailConnection(admin, clientId);
  if (!conn) return { ran: false };
  const at = () => new Date().toISOString();
  let cur: HistoryState = { ...state, status: "running", at: at(), error: null };
  await writeState(admin, clientId, cur);
  let done = false;
  let error: string | null = null;
  let cursor = state.cursor;
  if (conn.provider === "klaviyo") {
    const { readKlaviyoHistory } = await import("@/lib/klaviyo/store");
    const r = await readKlaviyoHistory(admin, clientId, { from: state.want, to: state.to, cursor: state.cursor }, {
      budgetMs,
      piece: async (c, pct, step) => {
        cursor = c;
        cur = { ...cur, cursor: c, pct, step, at: at() };
        await writeState(admin, clientId, cur);
      },
    });
    done = r.done;
    error = r.error;
    cursor = r.cursor;
  } else {
    // Brevo and Customer.io: one deeper full read (their campaigns and totals come from lists, not the Reporting API)
    const { DEFS } = await import("@/lib/email-providers");
    const { syncProvider } = await import("@/lib/email-providers/runner");
    const days = Math.min(HISTORY_MAX_DAYS, Math.round((Date.parse(`${etToday()}T12:00:00Z`) - Date.parse(`${state.want}T12:00:00Z`)) / 86_400_000) + 1);

    const r = await syncProvider(admin, DEFS[conn.provider], clientId, { window: "full", depthDays: days });
    done = r.ok;
    error = r.ok ? null : (r.error ?? "The read failed.");
    cursor = r.ok ? state.want : state.cursor;
  }
  // A read that ran out of time goes back in the queue (the schedule picks it up); a refused one stops with its reason
  const finished: HistoryState = done ? { ...cur, status: "done", cursor: state.want, pct: 100, step: "Done", at: at(), error: null } : error ? { ...cur, status: "failed", cursor, error, step: "Could not finish", at: at() } : { ...cur, status: "queued", cursor, at: at() };
  await writeState(admin, clientId, finished);
  if (done) {
    // A draft written before these months were here covered them thin: written again (the earlier one stays, to undo)
    const { data: thin } = await admin.from("reports").select("id").eq("client_id", clientId).eq("platform", "klaviyo").is("target_id", null).eq("status", "draft").lte("period_start", state.to).gte("period_end", state.want);
    if (thin?.length) await import("@/lib/reports/regenerate").then((m) => m.markForRegenerate(admin, thin.map((x) => x.id as string), "Kaizen OS", "queued")).catch(() => null);
  }
  if (finished.status !== "queued") {
    // The reports that waited are written now, with whatever came in
    const { draftChannelQueued } = await import("@/lib/channel-reports/queue");
    await draftChannelQueued(admin, 200_000).catch(() => 0);
  }
  return { ran: true, done, error };
}

/** The schedule's step: every queued read (and any that died mid-way), one after the other, until the time is up */
export async function runHistoryJobs(admin: SupabaseClient, budgetMs = 240_000): Promise<{ ran: number }> {
  const until = Date.now() + budgetMs;
  const { data } = await admin.from("sync_state").select("source, last_result").like("source", "email-history:%");
  const ids = (data ?? [])
    .filter((r) => {
      const s = r.last_result as HistoryState | null;
      return s && (s.status === "queued" || (s.status === "running" && !historyBusy(s)));
    })
    .map((r) => String(r.source).slice("email-history:".length));
  // Only clients that buy email marketing (src/lib/service-gate.ts): the job waits, kept, until the service is back
  const buying = await clientsWithLine(admin, "email", ids);
  let ran = 0;
  for (const id of ids.filter((x) => buying.has(x))) {
    const left = until - Date.now();
    if (left < 60_000) break;
    const r = await runHistory(admin, id, left - 15_000).catch(() => ({ ran: false }));
    if (r.ran) ran++;
  }
  return { ran };
}

/** Where a "Read full history" starts: the client's start (never past two years) or two years back */
export const historyFloor = (clientStart: string | null, span: "start" | "2y", today = etToday()) => (span === "start" && clientStart ? clientStart.slice(0, 10) : dayShift(today, -HISTORY_MAX_DAYS));

/**
 * A report about to be written (a regenerate, or one built by hand) whose dates reach before the stored history: queues
 * the missing months and puts the report back in the queue, where it waits for them. False when nothing holds it.
 */
export async function holdForHistory(admin: SupabaseClient, reportId: string): Promise<boolean> {
  const { data } = await admin.from("reports").select("client_id, period_start, platform, status").eq("id", reportId).maybeSingle();
  if (!data || data.platform !== "klaviyo") return false;
  const ask = await requestHistory(admin, data.client_id as string, { wantStart: data.period_start as string, asked: "report" }).catch(() => null);
  if (!ask?.state || !historyHolds(ask.state, data.period_start as string)) return false;
  await admin.from("reports").update({ status: "queued", updated_at: new Date().toISOString() }).eq("id", reportId).in("status", ["drafting", "queued"]);
  return true;
}
