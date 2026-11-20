import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { addedLines, changeLine, currentVersion, mergeRules, nextVersion, sectionsDiff, type StyleLine, type StyleRule, type StyleSource, type StyleVersion } from "./style-core";
import type { ReportLayout } from "./format";

// Reading and teaching a client's report style (see style-core.ts for what it is). Read with the server's rights by
// callers that already checked the person may work on the client's reports. A database without the table yet falls
// back to the old single list of notes, so drafting never fails on it.

const FIELDS = "id, version, rules, change, source, taught_by_name, created_at, undone_at, layout_target, layout_before";
type Row = StyleVersion & { layout_target: string | null; layout_before: ReportLayout | null };
export type Who = { id: string | null; name: string | null };

/** Every version (newest first, at most 20) and the one in use */
export async function loadStyle(admin: SupabaseClient, clientId: string, line: StyleLine): Promise<{ current: Row | null; history: Row[]; table: boolean }> {
  const { data, error } = await admin.from("client_report_style").select(FIELDS).eq("client_id", clientId).eq("line", line).order("version", { ascending: false }).limit(20);
  if (error) {
    // The table isn't there yet: the old notes (ads only), read as one version
    if (line !== "ads") return { current: null, history: [], table: false };
    const { data: old } = await admin.from("client_report_prefs").select("notes, updated_at").eq("client_id", clientId).maybeSingle();
    const notes = ((old?.notes ?? []) as string[]).filter((n) => typeof n === "string");
    if (!notes.length) return { current: null, history: [], table: false };
    const at = (old?.updated_at as string | null) ?? new Date().toISOString();
    const v: Row = { id: "old", version: 1, rules: notes.map((text) => ({ text, topic: null, by: null, at, source: "import" as const })), change: "Carried over from earlier reports", source: "import", taught_by_name: null, created_at: at, undone_at: null, layout_target: null, layout_before: null };
    return { current: v, history: [v], table: false };
  }
  const rows = ((data ?? []) as Row[]).map((r) => ({ ...r, rules: Array.isArray(r.rules) ? r.rules : [] }));
  return { current: currentVersion(rows), history: rows, table: true };
}

/** The rules in use, newest last (what the writer reads) */
export async function styleRules(admin: SupabaseClient, clientId: string, line: StyleLine): Promise<StyleRule[]> {
  return (await loadStyle(admin, clientId, line).catch(() => ({ current: null }))).current?.rules ?? [];
}

/**
 * Teaches the style: new rules, rules to drop. A new version only when something changed. Returns what changed.
 * A metrics change (source "layout") from the same person on the same account within half an hour updates its own
 * version instead of stacking one per click.
 */
export async function teachStyle(
  admin: SupabaseClient,
  opts: { clientId: string; line: StyleLine; rules?: string[]; remove?: string[]; source: StyleSource; by: Who; reportId?: string | null; layout?: { target: string; before: ReportLayout | null } },
): Promise<{ changed: boolean; version: number | null; change: string; rules: StyleRule[] }> {
  const { current, history, table } = await loadStyle(admin, opts.clientId, opts.line);
  const base = current?.rules ?? [];
  const merged = mergeRules(base, (opts.rules ?? []).map((text) => ({ text, by: opts.by.name, source: opts.source })), opts.remove ?? []);
  if (!merged.changed) return { changed: false, version: current?.version ?? null, change: "No change", rules: base };
  const change = changeLine(merged);
  const now = new Date().toISOString();
  if (!table) {
    // Before the migration: the old notes list, ads only
    if (opts.line === "ads") await admin.from("client_report_prefs").upsert({ client_id: opts.clientId, notes: merged.rules.map((r) => r.text), updated_at: now });
    return { changed: true, version: null, change, rules: merged.rules };
  }
  // A run of metric clicks: one version
  if (opts.source === "layout" && current && current.source === "layout" && opts.layout && current.layout_target === opts.layout.target && opts.by.id && Date.now() - Date.parse(current.created_at) < 30 * 60_000) {
    const { data: mine } = await admin.from("client_report_style").select("taught_by").eq("id", current.id).maybeSingle();
    if (mine?.taught_by === opts.by.id) {
      await admin.from("client_report_style").update({ rules: merged.rules, change, updated_at: now }).eq("id", current.id);
      return { changed: true, version: current.version, change, rules: merged.rules };
    }
  }
  const version = nextVersion(history);
  const { error } = await admin.from("client_report_style").insert({
    client_id: opts.clientId,
    line: opts.line,
    version,
    rules: merged.rules,
    change,
    source: opts.source,
    report_id: opts.reportId ?? null,
    taught_by: opts.by.id,
    taught_by_name: opts.by.name,
    layout_target: opts.layout?.target ?? null,
    layout_before: opts.layout?.before ?? null,
  });
  // Two lessons at the same moment: the second takes the next number
  if (error && /duplicate|unique/i.test(error.message)) return teachStyle(admin, opts);
  if (error) throw new Error(error.message);
  return { changed: true, version, change, rules: merged.rules };
}

/**
 * Undo: the version in use is marked undone, so the one before it is used again (a metrics change also puts the
 * account's metrics back the way they were). Nothing is deleted; the history keeps every version.
 */
export async function undoStyle(admin: SupabaseClient, clientId: string, line: StyleLine, by: Who): Promise<{ undone: number | null; now: Row | null }> {
  const { current, history } = await loadStyle(admin, clientId, line);
  if (!current || current.id === "old") return { undone: null, now: current };
  await admin.from("client_report_style").update({ undone_at: new Date().toISOString(), undone_by: by.id }).eq("id", current.id);
  if (current.source === "layout" && current.layout_target) await admin.from("kpi_targets").update({ report_layout: current.layout_before ?? null }).eq("id", current.layout_target);
  return { undone: current.version, now: currentVersion(history.filter((h) => h.id !== current.id)) };
}

/**
 * A buyer saved hand edits: what they changed structurally (sections cut or added, items cut, charts) and the sentences
 * they typed in are read by the AI, which keeps only what reads as a lasting preference for this client. Runs after
 * the save (never slows it). Light rewording teaches nothing.
 */
export async function learnFromEdit(admin: SupabaseClient, opts: { clientId: string; line: StyleLine; reportId: string; before: unknown; after: unknown; by: Who }) {
  const diff = sectionsDiff(opts.before as Record<string, unknown>, opts.after as Record<string, unknown>);
  const typed = addedLines(opts.before as Record<string, unknown>, opts.after as Record<string, unknown>);
  if (!diff.length && typed.length < 2) return null;
  const rules = await styleRules(admin, opts.clientId, opts.line);
  const out = await askJson<{ lessons: string[] }>({
    agent: "reporter",
    label: "learn report style from edits",
    clientId: opts.clientId,
    override: { model: "sonnet", effort: "low" },
    system:
      "A media buyer edited a client report by hand before sending it. From what they changed, write the lasting preferences for THIS client's future reports (what to always include or leave out, the structure, the order, the length, the comparisons, the tone), as short plain rules a writer can follow, for example \"Leave out the highlights section\" or \"Keep what we did to 2 bullets\". Only lasting preferences: never a one-off fix, a number, a date or a correction of a fact. Nothing already in the style below. Usually none or one; at most three. Roles, never people's names.",
    schema: { type: "object", properties: { lessons: { type: "array", items: { type: "string" } } }, required: ["lessons"], additionalProperties: false },
    maxTokens: 800,
    prompt: `<style_already>\n${rules.map((r) => `- ${r.text}`).join("\n") || "(none yet)"}\n</style_already>\n\n<what_they_changed>\n${diff.map((d) => `- ${d}`).join("\n") || "(no structural change)"}\n</what_they_changed>\n\n<sentences_they_typed_in>\n${typed.map((t) => `- ${t}`).join("\n") || "(none)"}\n</sentences_they_typed_in>`,
  });
  const lessons = (out.lessons ?? []).map((l) => String(l).trim()).filter(Boolean).slice(0, 3);
  if (!lessons.length) return null;
  return teachStyle(admin, { clientId: opts.clientId, line: opts.line, rules: lessons, source: "hand_edit", by: opts.by, reportId: opts.reportId });
}

const LABEL: Record<string, string> = { spend: "Spend", results: "Results", cost_per_result: "Cost per result", revenue: "Revenue", roas: "ROAS", ctr: "CTR", clicks: "Clicks", cpc: "CPC", cpm: "CPM", impressions: "Impressions", views_6s: "6-second views", hook_rate: "Hook rate" };

/** The metrics a buyer picked, as style rules ("Tiles: Spend, Purchases, ROAS"), one per place they can be picked */
export function layoutRules(layout: ReportLayout, platform: string): string[] {
  const where = platform === "google" ? "Google" : platform === "tiktok" ? "TikTok" : "Meta";
  const line = (name: string, keys?: string[]) => (keys?.length ? `${where} ${name.toLowerCase()}: ${keys.map((k) => LABEL[k] ?? k).join(", ")}` : null);
  return [line("Tiles", layout.tiles), line("Key metrics", layout.table), line("Campaign columns", layout.columns)].filter((x): x is string => Boolean(x));
}
