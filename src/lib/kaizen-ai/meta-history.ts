// A client's Meta performance month by month over a chosen range, read live from the ad account (read only), so a
// month-by-month trends report (April through October, say) is one ask in Kaizen AI rather than an export sorted by
// hand. The pure part lives here (the range and the rows); the tool that calls Meta is meta_history in tools.ts.

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Meta keeps insights for 37 months */
export const HISTORY_MAX_MONTHS = 37;
export const HISTORY_FIELDS = "spend,impressions,reach,frequency,inline_link_clicks,actions,action_values";
/** What counts as a result when the KPI doesn't say, most valuable first */
export const HISTORY_FALLBACK = ["omni_purchase", "purchase", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead", "lead", "complete_registration", "schedule_total", "landing_page_view", "link_click"];

const num = (v: unknown) => (v == null || v === "" ? 0 : Number(v) || 0);
const r2 = (x: number | null) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);
const actionMap = (v: unknown) => Object.fromEntries(((Array.isArray(v) ? v : []) as { action_type: string; value: string }[]).map((a) => [a.action_type, num(a.value)]));

/**
 * The months to read: since from the first of its month, until no later than yesterday (today's numbers are partial),
 * at most 37 months back (what Meta keeps). Returns an error for anything that isn't a range.
 */
export function historyRange(since: unknown, until: unknown, today: string): { since: string; until: string } | { error: string } {
  const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const s = String(since ?? "");
  const u = until == null || until === "" ? yesterday : String(until);
  if (!DAY.test(s) || !DAY.test(u)) return { error: "Dates must be YYYY-MM-DD." };
  const end = u > yesterday ? yesterday : u;
  const start = `${s.slice(0, 7)}-01`;
  if (start > end) return { error: "since must be before until (and before today)." };
  const months = (Number(end.slice(0, 4)) - Number(start.slice(0, 4))) * 12 + Number(end.slice(5, 7)) - Number(start.slice(5, 7)) + 1;
  if (months > HISTORY_MAX_MONTHS) return { error: `Meta keeps ${HISTORY_MAX_MONTHS} months of history; ask for a shorter range.` };
  return { since: start, until: end };
}

export type MonthRow = { month: string; name: string; spend: number; results: number | null; cpr: number | null; revenue: number | null; roas: number | null; ctr: number | null; cpm: number | null; freq: number | null; reach: number | null; clicks: number; impressions: number };

/** The result type to count: the first preferred one the account reports at all over the range */
export function historyResultType(rows: Record<string, unknown>[], preferred: string[]) {
  const prefs = [...preferred.filter((t) => t && t !== "campaign_goal"), ...HISTORY_FALLBACK];
  return prefs.find((t) => rows.some((r) => num(actionMap(r.actions)[t]) > 0)) ?? null;
}

/**
 * Meta's monthly insight rows (time_increment=monthly) as one row per month (and campaign, at the campaign level),
 * oldest first.
 */
export function monthRows(rows: Record<string, unknown>[], type: string | null, roas: boolean): MonthRow[] {
  const out = rows.map((r) => {
    const spend = num(r.spend);
    const impressions = num(r.impressions);
    const clicks = num(r.inline_link_clicks);
    const results = type ? num(actionMap(r.actions)[type]) : 0;
    const value = type ? num(actionMap(r.action_values)[type]) : 0;
    const month = String(r.date_start ?? "").slice(0, 7);
    return {
      month,
      name: r.campaign_name ? `${month} · ${String(r.campaign_name)}` : month,
      spend: r2(spend) ?? 0,
      results: type ? r2(results) : null,
      cpr: results ? r2(spend / results) : null,
      revenue: roas ? r2(value) : null,
      roas: roas && spend ? r2(value / spend) : null,
      ctr: impressions ? r2((clicks / impressions) * 100) : null,
      cpm: impressions ? r2((spend / impressions) * 1000) : null,
      freq: r.frequency != null ? r2(num(r.frequency)) : null,
      reach: r.reach != null ? num(r.reach) : null,
      clicks,
      impressions,
    };
  });
  return out.sort((a, z) => a.month.localeCompare(z.month) || z.spend - a.spend);
}

/** Percent change month over month for the headline numbers (account level), for the AI to read the trend from */
export function monthChanges(rows: MonthRow[]) {
  const pct = (a: number | null, b: number | null) => (a == null || b == null || !b ? null : Math.round(((a - b) / b) * 1000) / 10);
  return rows.slice(1).map((r, i) => ({ month: r.month, spend_pct: pct(r.spend, rows[i].spend), results_pct: pct(r.results, rows[i].results), cpr_pct: pct(r.cpr, rows[i].cpr), roas_pct: pct(r.roas, rows[i].roas), ctr_pct: pct(r.ctr, rows[i].ctr), cpm_pct: pct(r.cpm, rows[i].cpm) }));
}
