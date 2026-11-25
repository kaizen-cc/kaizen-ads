import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { canRefresh, mergeChanges, stableJson, textBehind, type RefreshNote, type TextState } from "@/lib/reports/refresh-core";
import { changesBetween, channelBlockedMessage, numbersAsk, type EmailMetrics, type SocialMetrics } from "./core";
import { freshChannelNumbers, reviseChannelReport } from "./write";

// Keeping a channel report's numbers current until it is sent, the way the ads reports do (src/lib/reports/refresh.ts).
// Klaviyo and Meta both keep revising the last days (late attributed orders, insights that settle), so a report waiting for
// review drifts from the account. Until it is sent its numbers are worked out again from the synced data (no AI) when the
// studio opens it, when its PDF is made, and right before it goes out; saved only when they moved. When what the text
// quotes moved, the text is brought up to date by the revise step, told only to touch those figures. A sent report is a
// record and never changes here.

type Metrics = (EmailMetrics | SocialMetrics) & { refreshNote?: RefreshNote };

const NUMBERS_MS = 25_000;
const within = <T,>(ms: number, p: Promise<T>, fallback: T): Promise<T> => Promise.race([p, new Promise<T>((done) => setTimeout(() => done(fallback), ms))]);

type Row = { id: string; status: string; platform: string; metrics: Metrics | null; sections: unknown };

async function readRow(admin: SupabaseClient, id: string): Promise<Row | null> {
  const { data } = await admin.from("reports").select("id, status, platform, metrics, sections").eq("id", id).maybeSingle();
  return (data as unknown as Row | null) ?? null;
}
const refreshable = (r: Row | null) => Boolean(r && canRefresh({ status: r.status, hasMetrics: Boolean(r.metrics), hasSections: Boolean(r.sections) }));

const stripNote = (m: Metrics | null | undefined) => {
  if (!m) return null;
  const { refreshNote: _gone, ...rest } = m;
  void _gone;
  return rest;
};

/** One report's numbers worked out again, saved when they moved (never otherwise); the note the owner sees when the numbers the text quotes moved */
export async function refreshChannelNumbers(admin: SupabaseClient, id: string, budgetMs = NUMBERS_MS): Promise<{ ran: boolean; changed: boolean; note: RefreshNote | null }> {
  const row = await readRow(admin, id);
  if (!row || !refreshable(row)) return { ran: false, changed: false, note: row?.metrics?.refreshNote ?? null };
  const got = await within(budgetMs, freshChannelNumbers(admin, id).catch(() => null), null);
  if (!got) return { ran: false, changed: false, note: row.metrics?.refreshNote ?? null };
  const was = got.was as Metrics | null;
  const metrics = got.metrics as Metrics;
  if (stableJson(stripNote(was)) === stableJson(stripNote(metrics))) return { ran: true, changed: false, note: was?.refreshNote ?? null };
  const changes = changesBetween(was, metrics);
  let note: RefreshNote | undefined = was?.refreshNote;
  if (changes.length) {
    // Numbers that moved again before the text caught up keep the first figure they were written with
    const open = note && (note.text === "pending" || note.text === "needs_look") ? note.changes : [];
    const merged = mergeChanges(open, changes);
    note = merged.length ? { at: new Date().toISOString(), changes: merged, text: "pending" } : undefined;
  }
  if (note) metrics.refreshNote = note;
  const { data: saved } = await admin.from("reports").update({ metrics, updated_at: new Date().toISOString() }).eq("id", id).in("status", ["draft", "submitted"]).select("id").maybeSingle();
  // It went out while this was working: the record stands
  if (!saved) return { ran: true, changed: false, note: was?.refreshNote ?? null };
  return { ran: true, changed: true, note: note ?? null };
}

async function setTextState(admin: SupabaseClient, id: string, text: TextState): Promise<RefreshNote | null> {
  const row = await readRow(admin, id);
  const note = row?.metrics?.refreshNote;
  if (!row?.metrics || !note) return null;
  const next: RefreshNote = { ...note, text };
  await admin.from("reports").update({ metrics: { ...row.metrics, refreshNote: next } }).eq("id", id).in("status", ["draft", "submitted"]);
  return next;
}

/** Brings a report's text up to date with its refreshed numbers. Done: marked updated. The AI couldn't: marked as needing a look (a send waits) */
export async function updateChannelText(admin: SupabaseClient, id: string, by: { id: string | null; name: string }): Promise<RefreshNote | null> {
  const row = await readRow(admin, id);
  const note = row?.metrics?.refreshNote;
  if (!row || !note || !refreshable(row)) return note ?? null;
  try {
    await reviseChannelReport(admin, id, numbersAsk(note), by.name, { echo: false, byId: by.id, numbersOnly: true });
  } catch {
    return setTextState(admin, id, "needs_look");
  }
  return setTextState(admin, id, "updated");
}

/** "The text is fine as it is": the owner's call, so the notice stays as a record and a send isn't held */
export const keepChannelText = (admin: SupabaseClient, id: string) => setTextState(admin, id, "kept");

/** For a PDF or a preview: the numbers only, quick. The text follows when the studio opens it. */
export async function refreshChannelForView(admin: SupabaseClient, id: string, budgetMs = NUMBERS_MS) {
  await refreshChannelNumbers(admin, id, budgetMs).catch(() => null);
}

/** When the studio opens a report: the numbers, and the text (after the page is sent) when the numbers moved */
export async function refreshChannelForStudio(admin: SupabaseClient, id: string, by: { id: string | null; name: string }) {
  const got = await refreshChannelNumbers(admin, id).catch(() => null);
  if (got?.note?.text === "pending") {
    const { after } = await import("next/server");
    after(() => updateChannelText(admin, id, by).catch(() => null));
  }
}

/** Right before a send: the numbers worked out again and the text brought up to date. Throws, in the owner's words, when the text still doesn't follow the numbers */
export async function ensureChannelSendable(admin: SupabaseClient, id: string, by: { id: string | null; name: string }) {
  const got = await refreshChannelNumbers(admin, id).catch(() => null);
  const row = await readRow(admin, id);
  if (!row || !refreshable(row)) return;
  let note = got?.note ?? row.metrics?.refreshNote ?? null;
  if (textBehind(row.metrics)) note = await updateChannelText(admin, id, by).catch(() => null);
  const after = (await readRow(admin, id))?.metrics;
  if (note && textBehind(after)) throw new Error(channelBlockedMessage((after?.platform ?? row.metrics?.platform ?? "klaviyo") as "klaviyo" | "social", after?.refreshNote ?? note));
}
