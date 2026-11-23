// Multi-location email reporting (Crust Pizza Co., Angry Chickz, Atomic Wings...): each conversion metric's attributed
// orders split by the restaurant they came from, per campaign. Pure (no database, no network), so the sync, the report,
// the board and the tests agree.
//   - which event property holds the location (Toast and a custom POS name it differently), detected from sample events
//   - Klaviyo's answers read into rows: the Events API with its attributions, or a metric aggregate grouped by message
//   - the breakdown the Head of Email builds by hand: totals per metric, location x campaign, and locations ranked

// ─── Klaviyo field names (verified against the developer docs, revision 2026-07-15 / 2026-10-15) ──────────────────
// GET /api/events/ (https://developers.klaviyo.com/en/reference/get_events): `include` accepts "attributions"; filter
// on metric_id (equals) and datetime (greater-or-equal, less-than); page[size] up to 1000 (default 200);
// fields[event] has datetime and event_properties.
// The included "attribution" resource (https://developers.klaviyo.com/en/reference/get_event) has no attributes, only
// relationships: event, attributed-event, campaign, campaign-message, flow, flow-message, flow-message-variation.
export const ATTRIBUTION_TYPE = "attribution";
export const ATTR_CAMPAIGN = "campaign";
export const ATTR_CAMPAIGN_MESSAGE = "campaign-message";
export const ATTR_FLOW = "flow";
export const ATTR_FLOW_MESSAGE = "flow-message";
/** The order's value on an event (Klaviyo's reserved $value property) */
export const VALUE_PROP = "$value";
// POST /api/metric-aggregates/ (https://developers.klaviyo.com/en/reference/query_metric_aggregates): `by` is a fixed
// list that includes "$attributed_message" but no custom event property, so grouping by a location is tried once per
// client and the Events API used when Klaviyo refuses it.
export const BY_MESSAGE = "$attributed_message";

/** How a client's location rows are read: tried in this order, the one that worked remembered */
export type LocationRoute = "aggregates" | "events";

/** Property names that hold a restaurant's location, compared without case, spaces or punctuation */
const LOCATION_WORDS = ["location", "locationname", "locationid", "store", "storename", "storelocation", "storeid", "restaurant", "restaurantname", "restaurantlocation", "restaurantid", "venue", "venuename", "branch", "branchname", "shop", "shopname", "outlet", "site", "sitename"];
const squash = (k: string) => k.toLowerCase().replace(/[^a-z]/g, "");

/** Whether a property's name reads like a location ("Location Name", "Store", "$location", "restaurant_name") */
export function isLocationLike(name: string): boolean {
  const k = squash(name.split(".").at(-1) ?? name);
  return LOCATION_WORDS.includes(k);
}

/** A location as it's kept: trimmed, inner spaces collapsed; nothing at all is an unknown location */
export const UNKNOWN_LOCATION = "Unknown location";
export function cleanLocation(v: unknown): string {
  const s = typeof v === "number" && Number.isFinite(v) ? String(v) : typeof v === "string" ? v : "";
  const t = s.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, 120) : UNKNOWN_LOCATION;
}

/** A property's value on an event: a top-level name, or "Parent.Child" one level down */
export function propValue(props: Record<string, unknown> | null | undefined, path: string): unknown {
  if (!props) return undefined;
  if (path in props) return props[path];
  const dot = path.indexOf(".");
  if (dot < 0) return undefined;
  const inner = props[path.slice(0, dot)];
  return inner && typeof inner === "object" && !Array.isArray(inner) ? (inner as Record<string, unknown>)[path.slice(dot + 1)] : undefined;
}

export type LocationCandidate = { prop: string; distinct: number; samples: string[]; /** Share of the sampled events carrying it */ coverage: number; likely: boolean };

/**
 * The properties of a metric's sample events that could hold the location: named like one ("Location Name", "Store") or
 * any short text property with a handful of values. The likely ones first, then by how many values they take.
 */
export function detectLocationProps(events: (Record<string, unknown> | null | undefined)[], opts: { maxSamples?: number } = {}): LocationCandidate[] {
  const seen = new Map<string, { values: Map<string, number>; count: number }>();
  const note = (path: string, v: unknown) => {
    if (typeof v !== "string" && typeof v !== "number") return;
    const s = String(v).trim();
    if (!s || s.length > 80) return;
    const e = seen.get(path) ?? { values: new Map(), count: 0 };
    e.count++;
    e.values.set(s, (e.values.get(s) ?? 0) + 1);
    seen.set(path, e);
  };
  const n = events.filter(Boolean).length;
  for (const ev of events) {
    if (!ev) continue;
    for (const [k, v] of Object.entries(ev)) {
      if (v && typeof v === "object" && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) note(`${k}.${k2}`, v2);
      else note(k, v);
    }
  }
  const out: LocationCandidate[] = [];
  for (const [prop, e] of seen) {
    const likely = isLocationLike(prop);
    const distinct = e.values.size;
    // Anything else must look like a short label taking a few values (not an order id, a price or a name per person)
    if (!likely && (distinct < 2 || distinct > 200 || distinct > e.count * 0.6 || /id$|^\$|price|total|value|amount|email|phone|name$/i.test(prop.replace(/[^A-Za-z$]/g, "")))) continue;
    const samples = [...e.values.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v).slice(0, opts.maxSamples ?? 5);
    out.push({ prop, distinct, samples, coverage: n ? e.count / n : 0, likely });
  }
  return out.sort((a, b) => Number(b.likely) - Number(a.likely) || b.coverage - a.coverage || b.distinct - a.distinct || a.prop.localeCompare(b.prop)).slice(0, 12);
}

/** The property to suggest for a metric: a likely one with more than one value, carried by most events */
export function suggestedProp(cands: LocationCandidate[]): LocationCandidate | null {
  return cands.find((c) => c.likely && c.distinct > 1 && c.coverage >= 0.5) ?? null;
}

/** Whether the account looks multi-location: any metric's sample shows more than one location */
export const looksMultiLocation = (byMetric: Record<string, LocationCandidate[]>) => Object.values(byMetric).some((c) => suggestedProp(c) != null);

/** The saved {metricId: property} map, cleaned (blank or odd entries dropped) */
export function locationPropsOf(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (k.trim() && typeof v === "string" && v.trim()) out[k.trim().slice(0, 64)] = v.trim().slice(0, 120);
  return out;
}

// ─── Klaviyo's answers into rows ───────────────────────────────────────────

/** One metric's attributed conversions at a location on a day, for one message */
export type LocationRow = { metricId: string; date: string; location: string; messageId: string; campaignId: string | null; flowId: string | null; conversions: number; revenue: number };

export type LocationEvent = { date: string; location: string; value: number; campaignId: string | null; flowId: string | null; messageId: string | null };

const obj = (x: unknown): Record<string, unknown> => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
const relId = (rels: Record<string, unknown>, name: string): string | null => {
  const d = obj(rels[name]).data;
  const one = Array.isArray(d) ? d[0] : d;
  const id = obj(one).id;
  return typeof id === "string" && id ? id : null;
};
const toNum = (v: unknown) => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};

/**
 * A page of GET /api/events/?include=attributions as events with their location and the message credited. `dayOf`
 * turns the event's datetime into the account's calendar day. An event with no attribution keeps nulls.
 */
export function parseEventsPage(json: unknown, prop: string, dayOf: (iso: string) => string): LocationEvent[] {
  const root = obj(json);
  const attrs = new Map<string, Record<string, unknown>>();
  for (const inc of Array.isArray(root.included) ? root.included : []) {
    const r = obj(inc);
    if (r.type === ATTRIBUTION_TYPE && typeof r.id === "string") attrs.set(r.id, obj(r.relationships));
  }
  const out: LocationEvent[] = [];
  for (const raw of Array.isArray(root.data) ? root.data : []) {
    const ev = obj(raw);
    const a = obj(ev.attributes);
    const when = typeof a.datetime === "string" ? a.datetime : typeof a.timestamp === "number" ? new Date(a.timestamp * 1000).toISOString() : null;
    if (!when) continue;
    const props = obj(a.event_properties);
    const links = obj(obj(ev.relationships).attributions).data;
    const first = (Array.isArray(links) ? links : []).map((l) => attrs.get(String(obj(l).id))).find(Boolean) ?? null;
    out.push({
      date: dayOf(when),
      location: cleanLocation(propValue(props, prop)),
      value: toNum(props[VALUE_PROP]),
      campaignId: first ? relId(first, ATTR_CAMPAIGN) : null,
      flowId: first ? relId(first, ATTR_FLOW) : null,
      messageId: first ? (relId(first, ATTR_CAMPAIGN_MESSAGE) ?? relId(first, ATTR_FLOW_MESSAGE) ?? relId(first, ATTR_CAMPAIGN) ?? relId(first, ATTR_FLOW)) : null,
    });
  }
  return out;
}

/** Attributed events added up per day, location and message (unattributed orders aren't email's, so they're left out) */
export function rollupEvents(metricId: string, events: LocationEvent[]): LocationRow[] {
  const by = new Map<string, LocationRow>();
  for (const e of events) {
    if (!e.messageId) continue;
    const k = `${e.date}|${e.location}|${e.messageId}`;
    const had = by.get(k);
    if (had) {
      had.conversions += 1;
      had.revenue += e.value;
    } else by.set(k, { metricId, date: e.date, location: e.location, messageId: e.messageId, campaignId: e.campaignId, flowId: e.flowId, conversions: 1, revenue: e.value });
  }
  return [...by.values()].map((r) => ({ ...r, revenue: Math.round(r.revenue * 100) / 100 }));
}

/**
 * A metric aggregate grouped by ["$attributed_message", <location property>] with a daily interval, as rows. Null when
 * the answer isn't grouped by both (Klaviyo ignored the location), so the caller can fall back to the Events API.
 */
export function parseLocationAggregate(json: unknown, metricId: string): LocationRow[] | null {
  const attrs = obj(obj(obj(json).data).attributes);
  const dates = (Array.isArray(attrs.dates) ? attrs.dates : []).map((d) => String(d ?? "").slice(0, 10));
  const rows = Array.isArray(attrs.data) ? attrs.data : [];
  const out: LocationRow[] = [];
  for (const r of rows) {
    const dims = obj(r).dimensions;
    if (!Array.isArray(dims) || dims.length < 2) return null;
    const messageId = String(dims[0] ?? "").trim();
    if (!messageId) continue;
    const m = obj(obj(r).measurements);
    const sum = Array.isArray(m.sum_value) ? m.sum_value : [];
    const cnt = Array.isArray(m.count) ? m.count : [];
    dates.forEach((date, i) => {
      const conversions = toNum(cnt[i]);
      const revenue = toNum(sum[i]);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || (!conversions && !revenue)) return;
      out.push({ metricId, date, location: cleanLocation(dims[1]), messageId, campaignId: null, flowId: null, conversions, revenue: Math.round(revenue * 100) / 100 });
    });
  }
  return out;
}

/**
 * A message id read from an aggregate, matched to its campaign: Klaviyo's campaign message id (an SMS campaign's differs
 * from the campaign's own id) or the campaign id itself. A message no campaign claims is left as a flow's (its flow
 * unknown until the Events API names it).
 */
export function resolveMessages(rows: LocationRow[], campaigns: { campaignId: string; messageId: string | null }[]): LocationRow[] {
  const byMessage = new Map<string, string>();
  for (const c of campaigns) {
    byMessage.set(c.campaignId, c.campaignId);
    if (c.messageId) byMessage.set(c.messageId, c.campaignId);
  }
  return rows.map((r) => (r.campaignId || r.flowId ? r : { ...r, campaignId: byMessage.get(r.messageId) ?? null }));
}

// ─── The breakdown ─────────────────────────────────────────────────────────

/** A campaign sent in the period, as a column */
export type LocationCampaign = { id: string; name: string; sendDay: string };

export type LocationColumn = { id: string; name: string; sendDay: string | null; revenue: number; /** "Other campaigns": how many it holds */ count?: number };
export type LocationTableRow = { location: string; cells: (number | null)[]; conversions: number; total: number };
export type RankedLocation = { rank: number; location: string; conversions: number; revenue: number };

export type LocationMetricBreakdown = {
  metricId: string;
  name: string;
  conversions: number;
  revenue: number;
  /** Part 1: the campaigns as columns (the best few by revenue, in send order, and the rest together) */
  columns: LocationColumn[];
  rows: LocationTableRow[];
  /** Part 2: every location by revenue */
  ranked: RankedLocation[];
  summary: string;
};

export type LocationBreakdown = {
  version: 1;
  metrics: LocationMetricBreakdown[];
  /** Every metric summed, not deduplicated */
  combined: { conversions: number; revenue: number };
  campaigns: number;
  locations: number;
  note: string;
};

export const COMBINED_NOTE = "Combined = each metric summed, not deduplicated; may include transition-period overlap as locations continue migrating between POS systems.";

/** The combined line's note with the metrics named ("Toast + Custom POS summed...") */
export const combinedNote = (names: string[]) => (names.length > 1 ? `Combined = ${names.join(" + ")} summed, not deduplicated; may include transition-period overlap as locations continue migrating between POS systems.` : COMBINED_NOTE);

const r2 = (n: number) => Math.round(n * 100) / 100;
const moneyText = (n: number, currency: string | null) => `${!currency || currency === "USD" ? "$" : `${currency} `}${Math.round(n).toLocaleString("en-US")}`;

/**
 * The location breakdown for a period: each metric's attributed conversions and revenue by location, for the campaigns
 * sent in it (rows already limited to the dates the caller counts). Columns past `maxColumns` campaigns fold into
 * "Other campaigns". Null when no metric has a single location row.
 */
export function locationBreakdown(input: { metrics: { id: string; name: string }[]; rows: LocationRow[]; campaigns: LocationCampaign[]; maxColumns?: number; currency?: string | null }): LocationBreakdown | null {
  const max = input.maxColumns ?? 6;
  const sent = new Map(input.campaigns.map((c) => [c.id, c]));
  const order = new Map([...input.campaigns].sort((a, b) => a.sendDay.localeCompare(b.sendDay) || a.name.localeCompare(b.name)).map((c, i) => [c.id, i]));
  const metrics: LocationMetricBreakdown[] = [];
  const allLocations = new Set<string>();
  const anyCampaign = new Set<string>();
  for (const m of input.metrics) {
    // Every attributed order in the dates: a campaign's (sent then or earlier and still earning) or a flow's
    const rows = input.rows.filter((r) => r.metricId === m.id && (r.campaignId || r.flowId));
    if (!rows.length) continue;
    // Campaign totals pick the columns: the best by revenue, shown in send order
    const byCampaign = new Map<string, number>();
    for (const r of rows) if (r.campaignId) byCampaign.set(r.campaignId, (byCampaign.get(r.campaignId) ?? 0) + r.revenue);
    const flowTotal = rows.filter((r) => !r.campaignId).reduce((s, r) => s + r.revenue, 0);
    const ranked = [...byCampaign.entries()].sort((a, b) => b[1] - a[1] || (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0));
    const fold = ranked.length > max;
    const shown = (fold ? ranked.slice(0, max) : ranked).map(([id]) => id).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    const shownSet = new Set(shown);
    const rest = ranked.filter(([id]) => !shownSet.has(id));
    const columns: LocationColumn[] = shown.map((id) => ({ id, name: sent.get(id)?.name ?? "Earlier campaign", sendDay: sent.get(id)?.sendDay ?? null, revenue: r2(byCampaign.get(id) ?? 0) }));
    const otherAt = rest.length ? columns.push({ id: "other", name: `Other campaigns (${rest.length})`, sendDay: null, revenue: r2(rest.reduce((s, [, v]) => s + v, 0)), count: rest.length }) - 1 : -1;
    // The flows' orders (welcome, abandoned cart, win-back...) in one column of their own
    const flowAt = flowTotal > 0 ? columns.push({ id: "flows", name: "Flows", sendDay: null, revenue: r2(flowTotal) }) - 1 : -1;
    const colIndex = new Map(shown.map((id, i) => [id, i]));
    // Locations: one row each, cells by column
    const table = new Map<string, LocationTableRow>();
    for (const r of rows) {
      const t = table.get(r.location) ?? { location: r.location, cells: columns.map(() => null), conversions: 0, total: 0 };
      const i = r.campaignId ? (colIndex.get(r.campaignId) ?? otherAt) : flowAt;
      if (i < 0) continue;
      t.cells[i] = r2((t.cells[i] ?? 0) + r.revenue);
      t.conversions += r.conversions;
      t.total = r2(t.total + r.revenue);
      table.set(r.location, t);
      allLocations.add(r.location);
      if (r.campaignId) anyCampaign.add(r.campaignId);
    }
    const list = [...table.values()].sort((a, b) => b.total - a.total || b.conversions - a.conversions || a.location.localeCompare(b.location));
    const conversions = Math.round(list.reduce((s, x) => s + x.conversions, 0));
    const revenue = r2(list.reduce((s, x) => s + x.total, 0));
    const rankedLocs: RankedLocation[] = list.map((x, i) => ({ rank: i + 1, location: x.location, conversions: Math.round(x.conversions), revenue: x.total }));
    metrics.push({ metricId: m.id, name: m.name, conversions, revenue, columns, rows: list, ranked: rankedLocs, summary: summaryLine(rankedLocs, revenue, byCampaign.size, input.currency ?? null, flowTotal > 0) });
  }
  if (!metrics.length) return null;
  return {
    version: 1,
    metrics,
    combined: { conversions: metrics.reduce((s, m) => s + m.conversions, 0), revenue: r2(metrics.reduce((s, m) => s + m.revenue, 0)) },
    campaigns: anyCampaign.size,
    locations: allLocations.size,
    note: combinedNote(metrics.map((m) => m.name)),
  };
}

/** Part 2's one-line summary: how many locations converted, the leader and its share, and the last */
export function summaryLine(ranked: RankedLocation[], revenue: number, campaigns: number, currency: string | null, flows = false): string {
  if (!ranked.length) return "No attributed orders carried a location.";
  const top = ranked[0];
  const share = revenue > 0 ? Math.round((top.revenue / revenue) * 100) : 0;
  const from = [campaigns ? `${campaigns} ${campaigns === 1 ? "campaign" : "campaigns"}` : "", flows ? "the flows" : ""].filter(Boolean).join(" and ") || "email";
  const head = `${ranked.length} ${ranked.length === 1 ? "location" : "locations"} converted from ${from}. ${top.location} led with ${moneyText(top.revenue, currency)} (${share}% of the total, ${top.conversions} conversions)`;
  if (ranked.length < 3) return `${head}.`;
  const last = ranked[ranked.length - 1];
  return `${head}; ${last.location} had the least at ${moneyText(last.revenue, currency)}.`;
}

/**
 * Plain checks for the QA: a breakdown that adds up well short of (or over) what Klaviyo attributes to the same campaigns,
 * and orders with no location. `attributed` is each metric's campaign revenue for the campaigns sent in the period.
 */
export function locationChecks(b: LocationBreakdown | null, attributed: Record<string, number | null>, currency: string | null): string[] {
  if (!b) return [];
  const out: string[] = [];
  for (const m of b.metrics) {
    const want = attributed[m.metricId];
    if (want != null && want > 0) {
      const r = m.revenue / want;
      if (r < 0.85 || r > 1.05) out.push(`${m.name}: the locations add up to ${moneyText(m.revenue, currency)} against ${moneyText(want, currency)} Klaviyo attributes to the same campaigns (${Math.round(r * 100)}%).`);
    }
    const unknown = m.ranked.find((x) => x.location === UNKNOWN_LOCATION);
    if (unknown && m.revenue > 0 && unknown.revenue / m.revenue > 0.1) out.push(`${m.name}: ${Math.round((unknown.revenue / m.revenue) * 100)}% of the revenue carries no location (${moneyText(unknown.revenue, currency)}).`);
  }
  return out;
}

/** The breakdown as the writer and the QA read it */
export function locationText(b: LocationBreakdown, currency: string | null): string {
  const out: string[] = [`Location breakdown (campaigns sent in the period, revenue attributed by Klaviyo, split by the restaurant the order came from; the report's last section):`];
  for (const m of b.metrics) out.push(`- ${m.name}: ${m.conversions} conversions, ${moneyText(m.revenue, currency)} across ${m.ranked.length} locations. ${m.summary} Ranked: ${m.ranked.map((x) => `${x.rank}. ${x.location} ${moneyText(x.revenue, currency)} (${x.conversions})`).join("; ")}.`);
  if (b.metrics.length > 1) out.push(`- Combined: ${b.combined.conversions} conversions, ${moneyText(b.combined.revenue, currency)}. ${b.note}`);
  return out.join("\n");
}

// ─── Days in the account's time zone ───────────────────────────────────────

/** How far a time zone is ahead of UTC at an instant, in milliseconds */
function offsetMs(at: number, tz: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return local - Math.floor(at / 1000) * 1000;
}

/**
 * The instant a calendar day starts in a time zone, as Klaviyo's filters take it ("2026-10-05T04:00:00+00:00" for New
 * York in October), so a day's events are read exactly and a re-read never mixes in the neighbouring days.
 */
export function dayStartUtc(day: string, tz: string | null): string {
  const zone = tz || "America/New_York";
  const guess = Date.parse(`${day}T00:00:00Z`);
  let at = guess;
  try {
    at = guess - offsetMs(guess, zone);
    // Across a clock change the offset at the start differs from the guess's: once more settles it
    at = guess - offsetMs(at, zone);
  } catch {
    at = guess;
  }
  return new Date(at).toISOString().replace(/\.\d+Z$/, "+00:00");
}

// ─── The board's dates ─────────────────────────────────────────────────────

export const LOCATION_RANGES = [
  { id: "month", label: "This month" },
  { id: "last-month", label: "Last month" },
  { id: "30d", label: "Last 30 days" },
  { id: "7d", label: "Last 7 days" },
] as const;
export type LocationRange = (typeof LOCATION_RANGES)[number]["id"];
export const isLocationRange = (x: unknown): x is LocationRange => LOCATION_RANGES.some((r) => r.id === x);

/** The dates a range covers, up to today (calendar days) */
export function locationWindow(range: LocationRange, today: string): { start: string; end: string } {
  const back = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
  const first = `${today.slice(0, 8)}01`;
  if (range === "month") return { start: first, end: today };
  if (range === "last-month") {
    const end = new Date(Date.parse(`${first}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    return { start: `${end.slice(0, 8)}01`, end };
  }
  return { start: back(range === "7d" ? 6 : 29), end: today };
}

/**
 * A ranked order system whose orders carry no location (a POS's API sending only totals): its orders are still read, as
 * one line of their own, "<system> orders (all locations)", so the location section adds up to every source.
 */
export const allLocationsLabel = (integration: string | null | undefined, name: string) => `${(integration ?? "").trim() || name} orders (all locations)`;

/** The location property to use for a ranked metric that has none: the one the check found likely, when only one is */
export function likelyLocationProp(candidates: { prop: string; likely: boolean }[] | undefined): string | null {
  const likely = (candidates ?? []).filter((c) => c.likely);
  return likely.length === 1 ? likely[0].prop : null;
}
