import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReportMetrics } from "./metrics";
import { freshNumbers, rediagnose, reviseReport } from "./write";
import { blockedMessage, canRefresh, changesBetween, mergeChanges, sameNumbers, stableJson, textBehind, type RefreshNote, type TextState } from "./refresh-core";

// Keeping a report's numbers current until it is sent. The ad platforms keep revising the last days (late conversions),
// so a report waiting for review can drift from the account. Until it is sent, its numbers are worked out again from the
// synced data (no AI, no call to the platform) when the studio opens it, when its PDF is made or previewed, and right
// before it goes out; saved only when they moved. When what the text quotes moved (the result, spend, cost per result,
// revenue, ROAS), the text is brought up to date with the lightest path there is: the revise step, told what changed and
// to touch only those figures, so the buyer's own wording stays. A sent report is a record and never changes here.

/** The most a refresh may hold up a page, a PDF or a preview: past it the stored numbers are used as they are */
const NUMBERS_MS = 25_000;

const within = <T,>(ms: number, p: Promise<T>, fallback: T): Promise<T> => Promise.race([p, new Promise<T>((done) => setTimeout(() => done(fallback), ms))]);

type Row = { id: string; status: string; metrics: ReportMetrics | null; sections: unknown; report_bundles: { status: string } | null };

async function readRow(admin: SupabaseClient, id: string): Promise<Row | null> {
  const { data } = await admin.from("reports").select("id, status, metrics, sections, report_bundles(status)").eq("id", id).maybeSingle();
  return (data as unknown as Row | null) ?? null;
}

const refreshable = (r: Row | null) => Boolean(r && canRefresh({ status: r.status, hasMetrics: Boolean(r.metrics), hasSections: Boolean(r.sections), bundleStatus: r.report_bundles?.status ?? null }));

/**
 * One report's numbers worked out again from the synced data, saved when they moved (never otherwise). Returns the note
 * the buyer sees when the numbers the text quotes moved. A report that can't be refreshed (sent, being written) and a
 * refresh that runs out of time both leave the stored numbers as they are.
 */
export async function refreshNumbers(admin: SupabaseClient, id: string, budgetMs = NUMBERS_MS): Promise<{ ran: boolean; changed: boolean; note: RefreshNote | null }> {
  const row = await readRow(admin, id);
  if (!row || !refreshable(row)) return { ran: false, changed: false, note: row?.metrics?.refreshNote ?? null };
  const got = await within(budgetMs, freshNumbers(admin, id).catch(() => null), null);
  if (!got) return { ran: false, changed: false, note: row.metrics?.refreshNote ?? null };
  const { was, wasExtra, metrics, extra, c } = got;
  const extraNow = extra.length ? extra : null;
  if (sameNumbers(was, metrics) && stableJson(wasExtra ?? null) === stableJson(extraNow)) return { ran: true, changed: false, note: was?.refreshNote ?? null };

  const changes = changesBetween(was, metrics, wasExtra, extraNow);
  let note: RefreshNote | undefined = was?.refreshNote;
  if (changes.length) {
    // Numbers that moved again before the text caught up keep the first figure they were written with
    const open = note && (note.text === "pending" || note.text === "needs_look") ? note.changes : [];
    const merged = mergeChanges(open, changes);
    metrics.diagnosis = await rediagnose(admin, c, metrics);
    note = merged.length ? { at: new Date().toISOString(), changes: merged, text: "pending" } : undefined;
  }
  if (note) metrics.refreshNote = note;
  const { data: saved } = await admin.from("reports").update({ metrics, extra_metrics: extraNow, updated_at: new Date().toISOString() }).eq("id", id).in("status", ["draft", "submitted"]).select("id").maybeSingle();
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

/** The ask that has the text follow the numbers: only the figures, and what depends on them, nothing else */
export function numbersAsk(note: RefreshNote): string {
  const lines = note.changes.map((c) => `- ${c.label}: was ${c.was}, now ${c.now}`).join("\n");
  return `The report's numbers were refreshed from the ad account after this was written. What moved:\n${lines}\nThe <numbers> given now are the right ones. Bring the message and the sections up to date with them: change only the figures, and the statements that depend on them (percent changes, "up" or "down", cost per result, ROAS, a highlight, a takeaway or a bullet that quotes them). Keep everything else exactly as it is, the buyer's own wording and edits included. Don't say the numbers were refreshed or revised. Leave lesson empty.`;
}

/**
 * Brings a report's text up to date with its refreshed numbers. Done: marked updated. The AI couldn't: marked as needing
 * a look (the numbers stay right; the studio says the text may be behind, and a send waits).
 */
export async function updateText(admin: SupabaseClient, id: string, by: { id: string | null; name: string }): Promise<RefreshNote | null> {
  const row = await readRow(admin, id);
  const note = row?.metrics?.refreshNote;
  if (!row || !note || !refreshable(row)) return note ?? null;
  try {
    await reviseReport(admin, id, numbersAsk(note), by.name, { echo: false, byId: by.id });
  } catch {
    return setTextState(admin, id, "needs_look");
  }
  return setTextState(admin, id, "updated");
}

/** "The text is fine as it is": the buyer's call, so the notice stays as a record and a send isn't held */
export const keepText = (admin: SupabaseClient, id: string) => setTextState(admin, id, "kept");

/** The report and the TikTok part riding on it (one document, a section each) */
async function withRiders(admin: SupabaseClient, id: string): Promise<string[]> {
  const { data } = await admin.from("reports").select("id").eq("joined_to", id).neq("status", "skipped");
  return [id, ...((data ?? []) as { id: string }[]).map((x) => x.id)];
}

/** Every part of a built report (Meta, TikTok, Google), each with its own numbers */
export async function bundleParts(admin: SupabaseClient, bundleId: string): Promise<string[]> {
  const { data } = await admin.from("reports").select("id").eq("bundle_id", bundleId).neq("status", "skipped");
  return ((data ?? []) as { id: string }[]).map((x) => x.id);
}

/** For a PDF or a preview: the numbers only, quick, for the report and its riders. The text follows when the studio opens it. */
export async function refreshForView(admin: SupabaseClient, id: string, budgetMs = NUMBERS_MS) {
  const ids = await withRiders(admin, id);
  await Promise.all(ids.map((x) => refreshNumbers(admin, x, budgetMs).catch(() => null)));
}

/** For a built report's PDF or preview: every part's numbers */
export async function refreshBundleForView(admin: SupabaseClient, bundleId: string, budgetMs = NUMBERS_MS) {
  const ids = await bundleParts(admin, bundleId);
  await Promise.all(ids.map((x) => refreshNumbers(admin, x, budgetMs).catch(() => null)));
}

/**
 * When the studio opens a report: the numbers, and the text when the numbers moved (a refresh the PDF or the preview made
 * since the buyer last looked is picked up here too). A text that failed before isn't retried on every open: the studio
 * offers a button.
 */
export async function refreshForStudio(admin: SupabaseClient, id: string, by: { id: string | null; name: string }) {
  const ids = await withRiders(admin, id);
  const behind: string[] = [];
  await Promise.all(
    ids.map(async (x) => {
      const got = await refreshNumbers(admin, x).catch(() => null);
      if (got?.note?.text === "pending") behind.push(x);
    }),
  );
  // The text catching up is an AI pass (up to a minute): it runs after the page is sent, so the studio opens straight
  // away with the new numbers and the "updating the text" note; a send still waits for it (ensureSendable)
  if (behind.length) {
    const { after } = await import("next/server");
    after(() => Promise.all(behind.map((x) => updateText(admin, x, by).catch(() => null))));
  }
}

/**
 * Right before a send: the numbers worked out again and the text brought up to date, for every report that goes out.
 * Throws, in the buyer's words, when the text still doesn't follow the numbers: nothing mismatched goes to the client.
 */
export async function ensureSendable(admin: SupabaseClient, ids: string[], by: { id: string | null; name: string }) {
  await Promise.all(
    [...new Set(ids)].map(async (id) => {
      const got = await refreshNumbers(admin, id).catch(() => null);
      const row = await readRow(admin, id);
      if (!row || !refreshable(row)) return;
      let note = got?.note ?? row.metrics?.refreshNote ?? null;
      if (textBehind(row.metrics)) note = await updateText(admin, id, by).catch(() => null);
      const after = (await readRow(admin, id))?.metrics;
      if (note && textBehind(after)) throw new Error(blockedMessage(after?.platform ?? row.metrics?.platform ?? "meta", after?.refreshNote ?? note));
    }),
  );
}

/** ensureSendable for a report and its TikTok rider */
export async function ensureSendableWithRiders(admin: SupabaseClient, id: string, by: { id: string | null; name: string }) {
  await ensureSendable(admin, await withRiders(admin, id), by);
}
