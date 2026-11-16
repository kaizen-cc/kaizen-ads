import type { ReportMetrics } from "./metrics";

// Keeping a report's numbers current until it is sent. A report's numbers are worked out when it is written; the ad
// platforms then keep revising the last days (late conversions), so a report that waits for review can drift from the
// account. These are the pure rules (which reports refresh, what counts as a real change, the notice the buyer sees),
// kept apart from the database so they are tested. The work itself is in refresh.ts.

/** pending: numbers changed, the text not yet updated; updated: the text was rewritten to match; needs_look: the rewrite failed; kept: the buyer said the text is fine */
export type TextState = "pending" | "updated" | "needs_look" | "kept";
export type NumberChange = { label: string; was: string; now: string };
/** Kept on the report's metrics, so it travels with the numbers and clears when the report is written again */
export type RefreshNote = { at: string; changes: NumberChange[]; text: TextState };

/** Only a report that was written and has not gone to the client changes: a sent one is a record */
export function canRefresh(r: { status: string; hasMetrics: boolean; hasSections: boolean; bundleStatus?: string | null }): boolean {
  if (!r.hasMetrics || !r.hasSections) return false;
  if (r.bundleStatus === "sent") return false;
  return r.status === "draft" || r.status === "submitted";
}

/** JSON with the keys in order, so numbers read back from the database compare equal to freshly worked out ones */
export function stableJson(v: unknown): string {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x as Record<string, unknown>).filter(([, y]) => y !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, y]) => [k, walk(y)]));
    return x;
  };
  return JSON.stringify(walk(v));
}

const stripNote = (m: ReportMetrics | null | undefined) => {
  if (!m) return null;
  const { refreshNote: _gone, ...rest } = m;
  void _gone;
  return rest;
};

/** Whether two sets of numbers are the same (the refresh note aside), so nothing is saved when nothing moved */
export const sameNumbers = (a: ReportMetrics | null | undefined, b: ReportMetrics | null | undefined) => stableJson(stripNote(a)) === stableJson(stripNote(b));

type Kind = "count" | "money" | "ratio";
type Line = { key: string; label: string; kind: Kind; value: number | null };

const finite = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** The numbers a written report quotes: the main result and its cost, spend, revenue and ROAS, and what they are compared with */
function keyLines(m: ReportMetrics): Line[] {
  return [
    { key: "results", label: m.conversion, kind: "count", value: finite(m.main.results) },
    { key: "spend", label: "Spend", kind: "money", value: finite(m.main.spend) },
    { key: "cpr", label: "Cost per result", kind: "ratio", value: finite(m.main.costPerResult) },
    { key: "revenue", label: "Revenue", kind: "money", value: finite(m.main.revenue) },
    { key: "roas", label: "ROAS", kind: "ratio", value: finite(m.main.roas) },
    { key: "prevResults", label: `${m.conversion} in the period before`, kind: "count", value: finite(m.compare.results) },
    { key: "prevSpend", label: "Spend in the period before", kind: "money", value: finite(m.compare.spend) },
  ];
}

/** A real change, not rounding: a whole result, a dollar and half a percent of spend, a hundredth and a percent of a ratio */
function moved(kind: Kind, a: number | null, b: number | null): boolean {
  if (a == null && b == null) return false;
  if (a == null || b == null) return true;
  const d = Math.abs(a - b);
  const big = Math.max(Math.abs(a), Math.abs(b));
  if (kind === "count") return d >= 0.5;
  if (kind === "money") return d >= 1 && d >= big * 0.005;
  return d >= 0.01 && d >= big * 0.01;
}

const fmt = (kind: Kind, label: string, v: number | null): string => {
  if (v == null) return "n/a";
  if (kind === "count") return v.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (label === "ROAS") return `${v.toFixed(2)}x`;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })}`;
};

/** The numbers the text quotes that moved between two versions of a report's numbers (empty: nothing the text needs to follow) */
export function changesBetween(was: ReportMetrics | null | undefined, now: ReportMetrics, extraWas?: ReportMetrics[] | null, extraNow?: ReportMetrics[] | null): NumberChange[] {
  const out: NumberChange[] = [];
  const add = (a: ReportMetrics, b: ReportMetrics, prefix: string) => {
    const before = keyLines(a);
    for (const l of keyLines(b)) {
      const o = before.find((x) => x.key === l.key);
      if (o && moved(l.kind, o.value, l.value)) out.push({ label: `${prefix}${l.label}`, was: fmt(l.kind, l.label, o.value), now: fmt(l.kind, l.label, l.value) });
    }
  };
  if (was) add(was, now, "");
  // A built report's other date ranges, each with its own numbers
  (extraNow ?? []).forEach((b, i) => {
    const a = extraWas?.[i];
    if (a) add(a, b, `${b.main.label}: `);
  });
  return out;
}

/** Changes noticed earlier and not yet seen by the buyer, with the new ones: the first "was" and the latest "now" per number, nothing where it came back */
export function mergeChanges(prev: NumberChange[] | undefined, next: NumberChange[]): NumberChange[] {
  const byLabel = new Map<string, NumberChange>();
  for (const c of prev ?? []) byLabel.set(c.label, c);
  for (const c of next) {
    const o = byLabel.get(c.label);
    byLabel.set(c.label, o ? { label: c.label, was: o.was, now: c.now } : c);
  }
  return [...byLabel.values()].filter((c) => c.was !== c.now);
}

const platformWord = (p: string) => (p === "google" ? "Google" : p === "tiktok" ? "TikTok" : "Meta");

/** The calm line the studio shows: what moved, and what became of the text */
export function noteText(platform: string, note: RefreshNote): string {
  const shown = note.changes.slice(0, 4).map((c) => `${c.label} ${c.was} → ${c.now}`);
  const more = note.changes.length > 4 ? ` and ${note.changes.length - 4} more` : "";
  const head = `Numbers updated from ${platformWord(platform)} since this was written: ${shown.join(", ")}${more}.`;
  if (note.text === "updated") return `${head} The summary was updated to match.`;
  if (note.text === "needs_look") return `${head} The text couldn't be updated automatically and may still show the old figures. Update it before sending.`;
  if (note.text === "kept") return `${head} The text was left as it is.`;
  return `${head} The text is being updated to match.`;
}

/** Whether the text still has to follow the numbers (a send waits for it) */
export const textBehind = (m: Pick<ReportMetrics, "refreshNote"> | null | undefined) => m?.refreshNote?.text === "pending" || m?.refreshNote?.text === "needs_look";

/** Why a send is held, in the buyer's words */
export function blockedMessage(platform: string, note: RefreshNote): string {
  const shown = note.changes.slice(0, 3).map((c) => `${c.label} ${c.was} → ${c.now}`).join(", ");
  return `The ${platformWord(platform)} numbers changed since the text was written (${shown}) and the text hasn't been updated to match. Open the report and press "Update the text", then send.`;
}
