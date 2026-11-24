// Overview widgets (owner's exec call, Nov 24 2026: "add widget, like Stripe's dashboard"): the registry, who can add
// each one, and a person's saved choice cleaned. The list with data sources: docs/WIDGETS.md. Pure: tests/widgets.test.ts.

export type WidgetId = "mrr" | "projection" | "pipeline" | "clients-risk" | "spend" | "team-load" | "my-targets" | "my-load";

export type Widget = { id: WidgetId; title: string; blurb: string; who: "exec" | "lead" | "all"; group: "Finance and sales" | "Clients and performance" | "You" };

export const WIDGETS: readonly Widget[] = [
  { id: "mrr", title: "Revenue by line", blurb: "Monthly recurring revenue per line, and the total", who: "exec", group: "Finance and sales" },
  { id: "projection", title: "Retainer projection", blurb: "Revenue to month end and quarter end, less clients at risk", who: "exec", group: "Finance and sales" },
  { id: "pipeline", title: "Sales pipeline", blurb: "Prospects by stage, and won this month", who: "exec", group: "Finance and sales" },
  { id: "clients-risk", title: "Clients and churn risk", blurb: "Live clients, and who's at risk of leaving", who: "lead", group: "Clients and performance" },
  { id: "spend", title: "Spend under management", blurb: "Ad spend in the last 30 days across every account", who: "lead", group: "Clients and performance" },
  { id: "team-load", title: "Team load", blurb: "Open items per teammate: asks, stuck work, escalations", who: "lead", group: "Clients and performance" },
  { id: "my-targets", title: "My clients' targets", blurb: "Each of your clients on target, close or off, worst first", who: "all", group: "Clients and performance" },
  { id: "my-load", title: "My load", blurb: "What's asked of you, by whom, and what's overdue", who: "all", group: "You" },
];

/** Whether this person can add a widget: execs everything, leads the client and team ones, everyone their own */
export function mayAdd(w: Pick<Widget, "who">, me: { isExec: boolean; isLead: boolean }): boolean {
  return w.who === "all" || (w.who === "lead" && (me.isExec || me.isLead)) || (w.who === "exec" && me.isExec);
}

/** The gallery for this person, grouped */
export function gallery(me: { isExec: boolean; isLead: boolean }): { group: Widget["group"]; widgets: Widget[] }[] {
  const mine = WIDGETS.filter((w) => mayAdd(w, me));
  return (["Finance and sales", "Clients and performance", "You"] as const).map((group) => ({ group, widgets: mine.filter((w) => w.group === group) })).filter((g) => g.widgets.length);
}

/** A saved choice cleaned: known ids this person may add, each once, in their order (at most 12) */
export function cleanChoice(raw: unknown, me: { isExec: boolean; isLead: boolean }): WidgetId[] {
  const ids = Array.isArray(raw) ? raw.map(String) : [];
  const ok = new Map(WIDGETS.filter((w) => mayAdd(w, me)).map((w) => [w.id as string, w.id]));
  return [...new Set(ids)].map((i) => ok.get(i)).filter((x): x is WidgetId => Boolean(x)).slice(0, 12);
}

/** Moved one place up or down (the gallery's arrows) */
export function moveWidget(ids: readonly WidgetId[], id: WidgetId, dir: -1 | 1): WidgetId[] {
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return [...ids];
  const out = [...ids];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** The line a billed service belongs to (clients.billed_services keys: "facebook-ads", "google-ads", "email-marketing"...) */
export function lineOfService(key: string): string {
  const k = key.toLowerCase();
  if (/facebook|meta|instagram/.test(k)) return "Meta";
  if (/google|youtube|pmax/.test(k)) return "Google";
  if (/tiktok/.test(k)) return "TikTok";
  if (/email|sms|klaviyo/.test(k)) return "Email";
  if (/social|organic/.test(k)) return "Social";
  if (/creative|design|video|ugc/.test(k)) return "Creative";
  if (/web|site|seo|landing/.test(k)) return "Web";
  return "Other";
}

/** Revenue by line from each client's billed services (the latest amount per service) */
export function mrrByLine(clients: readonly { billed_services: Record<string, { amount?: number | null } | null> | null }[]): { total: number; lines: [string, number][] } {
  const by = new Map<string, number>();
  for (const c of clients)
    for (const [k, v] of Object.entries(c.billed_services ?? {})) {
      const amt = Number(v?.amount ?? 0);
      if (amt > 0) by.set(lineOfService(k), (by.get(lineOfService(k)) ?? 0) + amt);
    }
  const lines = [...by].sort((a, b) => b[1] - a[1]);
  return { total: lines.reduce((s, [, n]) => s + n, 0), lines };
}

/** Months of revenue left to collect this month and this quarter (today's included), New York days */
export function monthsLeft(now = new Date()): { month: number; quarter: number } {
  const d = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const days = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const month = (days - d.getDate() + 1) / days;
  const quarterMonthsAfter = 2 - (d.getMonth() % 3);
  return { month, quarter: month + quarterMonthsAfter };
}
