// The Email tab's reading of a client's Klaviyo numbers, kept apart from the network and the database so it can be
// tested and used on the page itself: Reporting API timeframes that stay inside Klaviyo's limits, the store's own
// revenue (Placed Order) by day, the 30-day windows (with a backstop when the daily rows are missing), the key flows
// every store should run, the account's health in plain alerts and strengths, campaign sorting and filters,
// deliverability over time, and the email HTML made safe to preview. Read only: nothing here changes Klaviyo.

const DAY = 86_400_000;
export const shiftDay = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const num = (v: unknown) => {
  const x = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(x) ? x : 0;
};

// ─── Reporting API timeframes ──────────────────────────────────────────────

/**
 * Klaviyo's series reports refuse a daily interval over more than 60 days (hourly 7 days, monthly 52 weeks), with a
 * 400. A longer stretch is asked for in pieces of at most `maxDays` calendar days, oldest first. Times are written
 * without meaning an offset: Klaviyo reads them in the account's own time zone. The last piece ends at `endIso` when
 * given (now), else at the end of `to`.
 */
export const SERIES_DAILY_MAX_DAYS = 60;
export function seriesChunks(from: string, to: string, opts: { maxDays?: number; endIso?: string } = {}): { start: string; end: string }[] {
  const max = Math.max(1, Math.min(opts.maxDays ?? 45, SERIES_DAILY_MAX_DAYS));
  const out: { start: string; end: string }[] = [];
  for (let s = from; s <= to; s = shiftDay(s, max)) {
    const last = shiftDay(s, max - 1) >= to;
    const endDay = last ? to : shiftDay(s, max - 1);
    out.push({ start: `${s}T00:00:00+00:00`, end: last && opts.endIso ? opts.endIso : `${shiftDay(endDay, 1)}T00:00:00+00:00` });
  }
  return out;
}

// ─── The store's own revenue (Placed Order, metric aggregates) ─────────────

export type DayValue = { date: string; value: number; count: number };

/**
 * POST /api/metric-aggregates (interval day, measurements sum_value and count): each day's total. The dates come in
 * data.attributes.dates; each row's measurements are arrays lined up with them. Rows (when grouped) are added up.
 */
export function parseMetricAggregate(json: unknown): DayValue[] {
  const root = obj(json);
  const attrs = obj(obj(root.data).attributes);
  const dates = (Array.isArray(attrs.dates) ? attrs.dates : []).map((d) => String(d ?? "").slice(0, 10));
  const rows = Array.isArray(attrs.data) ? attrs.data : [];
  const by = new Map<string, DayValue>();
  dates.forEach((date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && by.set(date, { date, value: 0, count: 0 }));
  for (const r of rows) {
    const m = obj(obj(r).measurements);
    const sum = Array.isArray(m.sum_value) ? m.sum_value : [];
    const cnt = Array.isArray(m.count) ? m.count : [];
    dates.forEach((date, i) => {
      const t = by.get(date);
      if (!t) return;
      t.value += num(sum[i]);
      t.count += num(cnt[i]);
    });
  }
  return [...by.values()].map((d) => ({ ...d, value: Math.round(d.value * 100) / 100 })).sort((a, b) => a.date.localeCompare(b.date));
}

/** The metric-aggregates body for one metric's daily totals in [from, to] (calendar days in `tz`) */
export function aggregateBody(metricId: string, from: string, to: string, tz: string | null, measurements: ("sum_value" | "count" | "unique")[] = ["sum_value", "count"]) {
  return {
    data: {
      type: "metric-aggregate",
      attributes: { metric_id: metricId, measurements, interval: "day", page_size: 500, timezone: tz || "America/New_York", filter: [`greater-or-equal(datetime,${from}T00:00:00)`, `less-than(datetime,${shiftDay(to, 1)}T00:00:00)`] },
    },
  };
}

/** Email's share of the store's revenue as a fraction, null without a store total (or with none in the window) */
export function shareOfRevenue(email: number, store: number | null | undefined): number | null {
  if (!store || store <= 0) return null;
  return Math.max(0, email / store);
}

// ─── The windows ───────────────────────────────────────────────────────────

export type DailyRow = { date: string; revenue: number; campaignRevenue: number; flowRevenue: number; smsRevenue: number; sends: number; campaignsSent: number; storeRevenue: number | null; storeOrders: number | null; subscribed: number | null; unsubscribed: number | null };
export type CampaignLite = { id: string; name: string; channel: string; sendTime: string | null; subject: string | null; recipients: number; delivered: number; opensUnique: number; clicksUnique: number; unsubscribes: number; bounced: number; spamComplaints: number; revenue: number; conversions: number; openRate: number | null; clickRate: number | null };
export type FlowLite = { id: string; name: string; status: string | null; trigger: string | null; revenue30: number; revenue90: number; recipients30: number; recipients90: number; openRate30: number | null; clickRate30: number | null; openRate90: number | null; clickRate90: number | null };

export type PulseWindow = {
  revenue: number;
  campaignRevenue: number;
  flowRevenue: number;
  smsRevenue: number;
  sends: number;
  campaignsSent: number;
  /** Campaigns a week, over the window */
  cadence: number;
  openRate: number | null;
  clickRate: number | null;
  unsubscribeRate: number | null;
  spamRate: number | null;
  bounceRate: number | null;
  revenuePerRecipient: number | null;
  storeRevenue: number | null;
  share: number | null;
  /** Net new profiles on lists (subscribed minus unsubscribed), null when Klaviyo had no list metrics */
  listGrowth: number | null;
  /** The daily rows were missing or short: revenue added up from the campaigns sent in the window and the flows' own totals */
  estimated: boolean;
};

const sendDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) : "");

/**
 * One window's numbers [start, end]. Revenue comes from the daily rows when they're there; when they are missing or
 * plainly short (under half of what the campaigns sent in the window and the flows' own totals add up to), that
 * backstop is used instead, so a missing series never reads as $0 when there is revenue. `flowTotal` is the flows'
 * revenue for this window as Klaviyo's flow report gives it (revenue_30, or an estimate for the window before).
 */
export function pulseWindow(input: { days: DailyRow[]; campaigns: CampaignLite[]; start: string; end: string; flowTotal: number; flowRecipients: number }): PulseWindow {
  const { start, end } = input;
  const ds = input.days.filter((d) => d.date >= start && d.date <= end);
  // Sent means it reached someone: a scheduled, cancelled or test campaign with no recipients doesn't count
  const cs = input.campaigns.filter((c) => {
    const d = sendDay(c.sendTime);
    return d >= start && d <= end && c.recipients > 0;
  });
  const sum = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);
  // Open, click, unsubscribe, spam and bounce rates are email's (an SMS has no opens and would drag them down)
  const em = cs.filter((c) => c.channel !== "sms");
  const delivered = sum(em, (c) => c.delivered || c.recipients);
  const emailRecipients = sum(em, (c) => c.recipients);
  const recipients = sum(cs, (c) => c.recipients);
  const campRev = sum(cs, (c) => c.revenue);
  const smsCamp = sum(cs.filter((c) => c.channel === "sms"), (c) => c.revenue);
  const backstop = campRev + input.flowTotal;
  const dailyRev = sum(ds, (d) => d.revenue);
  const estimated = backstop > 0 && dailyRev < backstop * 0.5;
  const revenue = estimated ? backstop : dailyRev;
  const campaignRevenue = estimated ? campRev : sum(ds, (d) => d.campaignRevenue);
  const flowRevenue = estimated ? input.flowTotal : sum(ds, (d) => d.flowRevenue);
  const smsDaily = sum(ds, (d) => d.smsRevenue);
  const sends = estimated || !ds.length ? recipients + input.flowRecipients : sum(ds, (d) => d.sends);
  const storeDays = ds.filter((d) => d.storeRevenue != null);
  const storeRevenue = storeDays.length ? sum(storeDays, (d) => d.storeRevenue ?? 0) : null;
  const subDays = ds.filter((d) => d.subscribed != null || d.unsubscribed != null);
  const weeks = Math.max(1, (daysBetween(start, end) + 1) / 7);
  const campaignsSent = cs.length;
  return {
    revenue,
    campaignRevenue,
    flowRevenue,
    smsRevenue: estimated ? smsCamp : Math.max(smsDaily, smsCamp),
    sends,
    campaignsSent,
    cadence: Math.round((campaignsSent / weeks) * 10) / 10,
    openRate: delivered ? sum(em, (c) => c.opensUnique) / delivered : null,
    clickRate: delivered ? sum(em, (c) => c.clicksUnique) / delivered : null,
    unsubscribeRate: delivered ? sum(em, (c) => c.unsubscribes) / delivered : null,
    spamRate: delivered ? sum(em, (c) => c.spamComplaints) / delivered : null,
    bounceRate: emailRecipients ? sum(em, (c) => c.bounced) / emailRecipients : null,
    revenuePerRecipient: sends ? revenue / sends : null,
    storeRevenue,
    share: shareOfRevenue(revenue, storeRevenue),
    listGrowth: subDays.length ? sum(subDays, (d) => (d.subscribed ?? 0) - (d.unsubscribed ?? 0)) : null,
    estimated,
  };
}

// ─── Key flows ─────────────────────────────────────────────────────────────

export type KeyFlowId = "welcome" | "abandoned" | "browse" | "post_purchase" | "winback";
export type KeyFlow = { id: KeyFlowId; label: string; why: string; state: "live" | "present" | "missing"; flows: { id: string; name: string; status: string | null; revenue30: number }[] };

const KEY_FLOWS: { id: KeyFlowId; label: string; why: string; name: RegExp; critical: boolean }[] = [
  { id: "welcome", label: "Welcome series", why: "Greets every new subscriber while they're most interested; usually the first flow to earn.", name: /welcome|new subscriber|nurture|sign[- ]?up|onboard/i, critical: true },
  { id: "abandoned", label: "Abandoned checkout or cart", why: "Wins back people who nearly bought; most stores' biggest flow.", name: /abandon|checkout|cart/i, critical: true },
  { id: "browse", label: "Browse abandonment", why: "Follows up on products someone looked at without adding to cart.", name: /browse|viewed product|product view|site abandon/i, critical: false },
  { id: "post_purchase", label: "Post-purchase", why: "Thanks buyers, cross-sells and asks for the review that brings the second order.", name: /post[- ]?purchase|thank you|thanks for|order (confirm|follow)|first purchase|customer thank|repeat|replenish|review request/i, critical: false },
  { id: "winback", label: "Winback", why: "Brings lapsed customers back before they're gone for good.", name: /win[- ]?back|lapsed|re-?engage|we miss you|come back|sunset/i, critical: false },
];
export const CRITICAL_FLOWS = new Set(KEY_FLOWS.filter((k) => k.critical).map((k) => k.id));

/** Which key flows the account has, by the flow's name (live, built but not live, or missing) */
export function keyFlowCoverage(flows: Pick<FlowLite, "id" | "name" | "status" | "trigger" | "revenue30">[]): KeyFlow[] {
  return KEY_FLOWS.map((k) => {
    const match = flows.filter((f) => k.name.test(f.name) && !(k.id === "abandoned" && /browse/i.test(f.name)));
    const live = match.some((f) => (f.status ?? "").toLowerCase() === "live");
    return { id: k.id, label: k.label, why: k.why, state: live ? "live" : match.length ? "present" : "missing", flows: match.map((f) => ({ id: f.id, name: f.name, status: f.status, revenue30: f.revenue30 })) };
  });
}

// ─── Health ────────────────────────────────────────────────────────────────

export type HealthTone = "bad" | "warn" | "good";
export type HealthFinding = { id: string; tone: HealthTone; title: string; detail: string; action: string | null };

/** Healthy lines the alerts are held against (campaigns, per delivered message) */
export const BENCHMARKS = { unsubscribe: { warn: 0.003, bad: 0.005 }, spam: { warn: 0.0005, bad: 0.001 }, bounce: { warn: 0.01, bad: 0.02 }, clickLow: 0.01 } as const;

const p1 = (x: number) => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`;
const rel = (a: number | null, b: number | null) => (a != null && b != null && b > 0 ? (a - b) / b : null);

/**
 * The account's health in plain words, worst first: sending cadence, open rate against the 30 days before, unsubscribe,
 * spam and bounce rates against healthy lines, the key flows, revenue leaning on one flow, flows against campaigns,
 * share of the store, SMS, revenue trend and list growth. Each says what to do.
 */
export function emailHealth(input: { now: PulseWindow; before: PulseWindow | null; campaigns: CampaignLite[]; flows: FlowLite[]; keyFlows: KeyFlow[]; today: string; money: (x: number) => string }): HealthFinding[] {
  const { now, before, today, money } = input;
  const out: HealthFinding[] = [];
  const add = (f: HealthFinding) => out.push(f);

  // Cadence
  const lastEmail = input.campaigns.filter((c) => c.sendTime && c.channel !== "sms" && c.recipients > 0 && sendDay(c.sendTime) <= today).map((c) => sendDay(c.sendTime)).sort().at(-1) ?? null;
  const quiet = lastEmail ? daysBetween(lastEmail, today) : null;
  if (quiet == null) add({ id: "cadence", tone: "bad", title: "No email campaign in 120 days", detail: "The list only hears from flows.", action: "Plan a campaign calendar: at least one send a week keeps the list warm." });
  else if (quiet >= 14) add({ id: "cadence", tone: "bad", title: `No campaign sent in ${quiet} days`, detail: `The last email campaign went out on ${lastEmail}.`, action: "Get a campaign out this week; a cold list opens less and complains more." });
  else if (quiet >= 7) add({ id: "cadence", tone: "warn", title: `No campaign sent in ${quiet} days`, detail: `The last email campaign went out on ${lastEmail}.`, action: "Schedule the next send; aim for at least one a week." });
  else if (now.cadence >= 1) add({ id: "cadence", tone: "good", title: `Sending steadily: ${now.cadence} campaigns a week`, detail: `${now.campaignsSent} in the last 30 days.`, action: null });
  else add({ id: "cadence", tone: "warn", title: `Light sending: ${now.cadence} campaigns a week`, detail: `${now.campaignsSent} in the last 30 days.`, action: "One to two sends a week is a healthy floor for most stores." });

  // Open rate against the 30 days before
  const openMove = rel(now.openRate, before?.openRate ?? null);
  if (openMove != null && now.openRate != null && before?.openRate != null) {
    if (openMove <= -0.2) add({ id: "open", tone: "bad", title: `Open rate down ${Math.round(-openMove * 100)}%`, detail: `${p1(now.openRate)} against ${p1(before.openRate)} the 30 days before.`, action: "Check the inbox placement and subject lines; trim unengaged profiles from sends." });
    else if (openMove <= -0.1) add({ id: "open", tone: "warn", title: `Open rate down ${Math.round(-openMove * 100)}%`, detail: `${p1(now.openRate)} against ${p1(before.openRate)} the 30 days before.`, action: "Test subject lines and send to engaged segments first." });
    else if (openMove >= 0.05) add({ id: "open", tone: "good", title: `Open rate up ${Math.round(openMove * 100)}%`, detail: `${p1(now.openRate)} against ${p1(before.openRate)}.`, action: null });
  }
  if (now.clickRate != null && now.campaignsSent >= 2 && now.clickRate < BENCHMARKS.clickLow) add({ id: "click", tone: "warn", title: `Click rate low at ${p1(now.clickRate)}`, detail: "Campaigns get opened but few people click through.", action: "One clear offer and one button above the fold; test the hero image and call to action." });

  // Deliverability
  const rate = (id: string, label: string, x: number | null, b: { warn: number; bad: number }, fix: string) => {
    if (x == null) return;
    if (x > b.bad) add({ id, tone: "bad", title: `${label} high at ${p1(x)}`, detail: `Healthy is under ${p1(b.warn)}.`, action: fix });
    else if (x > b.warn) add({ id, tone: "warn", title: `${label} rising at ${p1(x)}`, detail: `Healthy is under ${p1(b.warn)}.`, action: fix });
  };
  rate("unsub", "Unsubscribe rate", now.unsubscribeRate, BENCHMARKS.unsubscribe, "Send less to unengaged profiles and match content to what they signed up for.");
  rate("spam", "Spam complaints", now.spamRate, BENCHMARKS.spam, "Suppress unengaged profiles now; Gmail and Yahoo filter senders above 0.1% (block at 0.3%).");
  rate("bounce", "Bounce rate", now.bounceRate, BENCHMARKS.bounce, "Clean the list: suppress hard bounces and check how sign-ups are collected.");
  if (now.unsubscribeRate != null && now.spamRate != null && now.unsubscribeRate <= BENCHMARKS.unsubscribe.warn && now.spamRate <= BENCHMARKS.spam.warn && (now.bounceRate ?? 0) <= BENCHMARKS.bounce.warn)
    add({ id: "deliverability", tone: "good", title: "Deliverability healthy", detail: `Unsubscribes ${p1(now.unsubscribeRate)}, spam ${p1(now.spamRate)}${now.bounceRate != null ? `, bounces ${p1(now.bounceRate)}` : ""}.`, action: null });

  // Key flows
  for (const k of input.keyFlows) {
    if (k.state === "missing") add({ id: `flow_${k.id}`, tone: CRITICAL_FLOWS.has(k.id) ? "bad" : "warn", title: `No ${k.label.toLowerCase()} flow`, detail: k.why, action: `Build a ${k.label.toLowerCase()} flow.` });
    else if (k.state === "present") add({ id: `flow_${k.id}`, tone: "warn", title: `${k.label} built but not live`, detail: `${k.flows.map((f) => `${f.name} (${f.status ?? "no status"})`).slice(0, 2).join(", ")}.`, action: "Review it and switch it live." });
  }
  const liveKeys = input.keyFlows.filter((k) => k.state === "live").length;
  if (liveKeys === input.keyFlows.length) add({ id: "flows_all", tone: "good", title: "Every key flow is live", detail: input.keyFlows.map((k) => k.label).join(", ") + ".", action: null });

  // Revenue leaning on one flow
  const flowTotal = input.flows.reduce((s, f) => s + f.revenue30, 0);
  const top = [...input.flows].sort((a, b) => b.revenue30 - a.revenue30)[0];
  if (top && flowTotal > 0 && input.flows.filter((f) => f.revenue30 > 0).length >= 2 && top.revenue30 / flowTotal >= 0.6)
    add({ id: "concentration", tone: "warn", title: `${Math.round((top.revenue30 / flowTotal) * 100)}% of flow revenue from one flow`, detail: `${top.name} earns ${money(top.revenue30)} of ${money(flowTotal)} in 30 days.`, action: "Build out the other key flows so revenue doesn't hang on one." });

  // Flows against campaigns
  if (now.revenue > 0) {
    const flowShare = now.flowRevenue / now.revenue;
    if (flowShare < 0.25) add({ id: "split", tone: "warn", title: `Flows bring only ${Math.round(flowShare * 100)}% of email revenue`, detail: `Flows ${money(now.flowRevenue)}, campaigns ${money(now.campaignRevenue)}.`, action: "Healthy accounts get a third or more from flows: strengthen welcome, abandonment and post-purchase." });
    else if (flowShare >= 0.3 && flowShare <= 0.75) add({ id: "split", tone: "good", title: `Balanced: flows bring ${Math.round(flowShare * 100)}% of email revenue`, detail: `Flows ${money(now.flowRevenue)}, campaigns ${money(now.campaignRevenue)}.`, action: null });
    else if (flowShare > 0.85 && now.campaignsSent < 4) add({ id: "split", tone: "warn", title: "Campaigns barely contribute", detail: `Flows ${money(now.flowRevenue)}, campaigns ${money(now.campaignRevenue)}.`, action: "Campaigns are untapped revenue: plan a steady calendar of offers and launches." });
  }

  // Share of the store
  if (now.share != null) {
    if (now.share < 0.1) add({ id: "share", tone: "warn", title: `Email is ${Math.round(now.share * 100)}% of store revenue`, detail: `${money(now.revenue)} of ${money(now.storeRevenue ?? 0)}.`, action: "Strong programs carry 20 to 30%: more flows and a steadier campaign calendar." });
    else if (now.share >= 0.2) add({ id: "share", tone: "good", title: `Email drives ${Math.round(now.share * 100)}% of store revenue`, detail: `${money(now.revenue)} of ${money(now.storeRevenue ?? 0)}.`, action: null });
  }

  // SMS
  const smsSent = input.campaigns.some((c) => c.channel === "sms");
  if (!smsSent && now.smsRevenue === 0) add({ id: "sms", tone: "warn", title: "No SMS", detail: "Everything goes out by email.", action: "Consider SMS for launches and abandonment: it reaches people email misses." });
  else if (now.revenue > 0 && now.smsRevenue > 0) add({ id: "sms", tone: "good", title: `SMS brings ${Math.round((now.smsRevenue / now.revenue) * 100)}% of revenue`, detail: `${money(now.smsRevenue)} by SMS, ${money(now.revenue - now.smsRevenue)} by email.`, action: null });

  // Revenue trend
  const revMove = rel(now.revenue, before?.revenue ?? null);
  if (revMove != null) {
    if (revMove <= -0.25) add({ id: "trend", tone: "bad", title: `Email revenue down ${Math.round(-revMove * 100)}%`, detail: `${money(now.revenue)} against ${money(before!.revenue)} the 30 days before.`, action: "See which flows and campaigns fell, and check flows are still live." });
    else if (revMove >= 0.1) add({ id: "trend", tone: "good", title: `Email revenue up ${Math.round(revMove * 100)}%`, detail: `${money(now.revenue)} against ${money(before!.revenue)} the 30 days before.`, action: null });
  }

  // List growth
  if (now.listGrowth != null) {
    if (now.listGrowth < 0) add({ id: "growth", tone: "bad", title: `The list shrank by ${Math.abs(now.listGrowth).toLocaleString("en-US")}`, detail: "More profiles left lists than joined in 30 days.", action: "Check sign-up forms are live and add a pop-up offer; slow down sends to unengaged profiles." });
    else if (now.listGrowth > 0) add({ id: "growth", tone: "good", title: `${now.listGrowth.toLocaleString("en-US")} net new subscribers`, detail: "Joined minus left, last 30 days.", action: null });
  }

  const order = { bad: 0, warn: 1, good: 2 } as const;
  return out.map((f, i) => ({ f, i })).sort((a, b) => order[a.f.tone] - order[b.f.tone] || a.i - b.i).map((x) => x.f);
}

/** How the account reads overall from its findings: any red needs attention, more than two ambers is worth watching */
export function pulseStatus(health: Pick<HealthFinding, "tone">[]): { tone: HealthTone; label: string } {
  const bad = health.filter((h) => h.tone === "bad").length;
  const warn = health.filter((h) => h.tone === "warn").length;
  if (bad) return { tone: "bad", label: "Needs attention" };
  if (warn > 2) return { tone: "warn", label: "Watch" };
  return { tone: "good", label: "Healthy" };
}

// ─── Campaigns: sorting and filters ────────────────────────────────────────

export type CampaignSort = "date" | "recipients" | "open" | "click" | "revenue" | "rpr";
export type CampaignFilter = { channel: "all" | "email" | "sms"; days: 30 | 90 | 120 };
export const CAMPAIGN_SORTS: CampaignSort[] = ["date", "recipients", "open", "click", "revenue", "rpr"];

export const revenuePerRecipient = (c: Pick<CampaignLite, "revenue" | "recipients">) => (c.recipients ? c.revenue / c.recipients : null);

export function filterCampaigns<T extends CampaignLite>(list: T[], f: CampaignFilter, today: string): T[] {
  const from = shiftDay(today, -(f.days - 1));
  return list.filter((c) => c.sendTime && sendDay(c.sendTime) >= from && (f.channel === "all" || (f.channel === "sms" ? c.channel === "sms" : c.channel !== "sms")));
}

/** Sorted by one column; a missing value (no opens on SMS) always goes last, whichever way */
export function sortCampaigns<T extends CampaignLite>(list: T[], by: CampaignSort, dir: "asc" | "desc" = "desc"): T[] {
  const val = (c: T): number | null => (by === "date" ? (c.sendTime ? Date.parse(c.sendTime) : null) : by === "recipients" ? c.recipients : by === "open" ? (c.channel === "sms" ? null : c.openRate) : by === "click" ? c.clickRate : by === "revenue" ? c.revenue : revenuePerRecipient(c));
  const s = dir === "asc" ? 1 : -1;
  return [...list].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x - y) * s;
  });
}

/** The subject lines their list opened most (email, at least `minRecipients` sent so a tiny test doesn't win) */
export function bestSubjects<T extends CampaignLite>(list: T[], n = 5, minRecipients = 200): T[] {
  return sortCampaigns(list.filter((c) => c.channel !== "sms" && c.subject && c.openRate != null && c.recipients >= minRecipients), "open").slice(0, n);
}

// ─── Deliverability over time ──────────────────────────────────────────────

export type DeliverabilityWeek = { week: string; delivered: number; bounceRate: number | null; spamRate: number | null; unsubscribeRate: number | null; campaigns: number };

/** Monday of the week a day falls in */
export const weekOf = (day: string) => {
  const d = new Date(`${day}T12:00:00Z`);
  return shiftDay(day, -((d.getUTCDay() + 6) % 7));
};

/** Email campaigns' bounce, spam and unsubscribe rates by week (by send day), oldest first */
export function deliverabilityByWeek(campaigns: CampaignLite[]): DeliverabilityWeek[] {
  const by = new Map<string, { delivered: number; recipients: number; bounced: number; spam: number; unsub: number; campaigns: number }>();
  for (const c of campaigns) {
    if (!c.sendTime || c.channel === "sms" || !c.recipients) continue;
    const w = weekOf(sendDay(c.sendTime));
    const t = by.get(w) ?? { delivered: 0, recipients: 0, bounced: 0, spam: 0, unsub: 0, campaigns: 0 };
    t.delivered += c.delivered || c.recipients;
    t.recipients += c.recipients;
    t.bounced += c.bounced;
    t.spam += c.spamComplaints;
    t.unsub += c.unsubscribes;
    t.campaigns += 1;
    by.set(w, t);
  }
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, t]) => ({ week, delivered: t.delivered, campaigns: t.campaigns, bounceRate: t.recipients ? t.bounced / t.recipients : null, spamRate: t.delivered ? t.spam / t.delivered : null, unsubscribeRate: t.delivered ? t.unsub / t.delivered : null }));
}

export type Outlier<T> = { campaign: T; issues: { kind: "bounce" | "spam" | "unsubscribe"; rate: number }[] };

/** Email campaigns over the healthy lines on bounces, spam or unsubscribes (at least `minDelivered` sent), worst first */
export function deliverabilityOutliers<T extends CampaignLite>(campaigns: T[], minDelivered = 200): Outlier<T>[] {
  const out: (Outlier<T> & { score: number })[] = [];
  for (const c of campaigns) {
    const d = c.delivered || c.recipients;
    if (c.channel === "sms" || d < minDelivered) continue;
    const issues: Outlier<T>["issues"] = [];
    const b = c.recipients ? c.bounced / c.recipients : 0;
    const s = c.spamComplaints / d;
    const u = c.unsubscribes / d;
    if (b > BENCHMARKS.bounce.warn) issues.push({ kind: "bounce", rate: b });
    if (s > BENCHMARKS.spam.warn) issues.push({ kind: "spam", rate: s });
    if (u > BENCHMARKS.unsubscribe.warn) issues.push({ kind: "unsubscribe", rate: u });
    if (issues.length) out.push({ campaign: c, issues, score: b / BENCHMARKS.bounce.warn + s / BENCHMARKS.spam.warn + u / BENCHMARKS.unsubscribe.warn });
  }
  return out.sort((a, b) => b.score - a.score).map(({ campaign, issues }) => ({ campaign, issues }));
}

// ─── Audience growth ───────────────────────────────────────────────────────

/** A list's growth from its size snapshots: the latest against the one closest to `days` before it (null with one) */
export function audienceGrowth(snaps: { date: string; profiles: number }[], days = 30): { change: number; since: string } | null {
  if (snaps.length < 2) return null;
  const s = [...snaps].sort((a, b) => a.date.localeCompare(b.date));
  const last = s.at(-1)!;
  const target = shiftDay(last.date, -days);
  const earlier = s.slice(0, -1);
  const base = earlier.reduce((best, x) => (Math.abs(daysBetween(x.date, target)) < Math.abs(daysBetween(best.date, target)) ? x : best), earlier[0]);
  return { change: last.profiles - base.profiles, since: base.date };
}

// ─── The email, safe to preview ────────────────────────────────────────────

/**
 * A campaign's email HTML made safe to show inside a sandboxed iframe (no scripts allowed there either): scripts,
 * frames, objects, forms, base and refresh tags, event handlers and javascript: links removed; Klaviyo's template tags
 * turned into readable placeholders; a strict Content-Security-Policy (images, inline styles and web fonts only) and
 * links opening in a new tab added to the head.
 */
export function sanitizeEmailHtml(raw: string): string {
  let h = String(raw ?? "");
  h = h.replace(/<!--[\s\S]*?-->/g, (m) => (/\[if |<!\[endif/i.test(m) ? "" : ""));
  h = h.replace(/<(script|iframe|frame|frameset|object|embed|applet|form|noscript|template|svg|math)\b[\s\S]*?<\/\1\s*>/gi, "");
  h = h.replace(/<(script|iframe|frame|object|embed|applet|base|meta|link|form|input|button|textarea|select)\b[^>]*>/gi, (m, tag: string) => {
    const t = tag.toLowerCase();
    if (t === "meta" && !/http-equiv/i.test(m)) return m;
    if (t === "link" && /rel\s*=\s*["']?stylesheet/i.test(m) && /href\s*=\s*["']?https:/i.test(m)) return m;
    return "";
  });
  h = h.replace(/<\/(form|button|textarea|select|svg)\s*>/gi, "");
  // Event handlers, quoted or not
  h = h.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  // Script and data-html links
  h = h.replace(/\s(href|src|action|formaction|xlink:href|background)\s*=\s*("|')\s*(javascript|vbscript|data:text\/html)[^"']*\2/gi, ' $1="#"');
  h = h.replace(/\s(href|src|action|formaction|background)\s*=\s*(javascript|vbscript):[^\s>]*/gi, ' $1="#"');
  // CSS that runs code in old engines
  h = h.replace(/expression\s*\(/gi, "(").replace(/url\(\s*["']?\s*javascript:[^)]*\)/gi, "none");
  // Klaviyo's template language
  h = h.replace(/\{%\s*unsubscribe[^%]*%\}/gi, "#").replace(/\{%\s*manage_preferences[^%]*%\}/gi, "#").replace(/\{%\s*web_view[^%]*%\}/gi, "#");
  h = h.replace(/\{%[\s\S]*?%\}/g, "");
  h = h.replace(/\{\{\s*([^}|]*?)(\|[^}]*)?\s*\}\}/g, (_m, name: string) => {
    const key = name.trim().toLowerCase();
    if (/first_name/.test(key)) return "there";
    if (/organization\.name|company/.test(key)) return "";
    if (/url|link/.test(key)) return "#";
    return "";
  });
  const head = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline' https:; font-src https: data:"><base target="_blank"><style>html,body{margin:0;background:#fff}img{max-width:100%;height:auto}</style>`;
  if (/<head[^>]*>/i.test(h)) return h.replace(/<head[^>]*>/i, (m) => `${m}${head}`);
  if (/<html[^>]*>/i.test(h)) return h.replace(/<html[^>]*>/i, (m) => `${m}<head>${head}</head>`);
  return `<!doctype html><html><head>${head}</head><body>${h}</body></html>`;
}
