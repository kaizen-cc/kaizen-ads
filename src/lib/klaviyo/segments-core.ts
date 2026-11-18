// How each list and segment performs for one email account, and what to do about it. Pure: no database, no network
// (the loader is segments.ts). A campaign's audiences come from klaviyo_campaigns.audiences_detail (who it went to and who
// it left out); a campaign sent to two segments counts for both (its totals can't be split between them).
//
// What it says:
//   - per segment: campaigns sent to it, recipients, open, click, unsubscribes, revenue and revenue per recipient (RPR),
//     over a window, flagged underperforming (clearly under the account's own average) or overused (sent to too often
//     with signs of fatigue);
//   - suggestions from other clients in the same industry (and sub-category): which KINDS of segment earn there, by
//     name pattern (engaged 30/60/90, VIP, winback, zero-time purchasers...), never another client's name or numbers
//     per client;
//   - inclusion and exclusion advice from the account's own signals (low deliverability, many zero-time purchasers,
//     whole-list sends with nothing left out).

import { parseAudiencesJson, type AudienceRef } from "./audiences";

export type SegPattern = "engaged30" | "engaged60" | "engaged90" | "engaged" | "vip" | "winback" | "zero_purchase" | "recent_buyers" | "repeat_buyers" | "unengaged" | "new_subscribers" | "all" | "other";

export const PATTERN_LABEL: Record<SegPattern, string> = {
  engaged30: "Engaged in the last 30 days",
  engaged60: "Engaged in the last 60 days",
  engaged90: "Engaged in the last 90 days",
  engaged: "Engaged subscribers",
  vip: "VIP and best customers",
  winback: "Winback and lapsed",
  zero_purchase: "Zero-time purchasers",
  recent_buyers: "Recent buyers",
  repeat_buyers: "Repeat buyers",
  unengaged: "Unengaged",
  new_subscribers: "New subscribers",
  all: "Whole list",
  other: "Other",
};

/** What kind of audience a name describes (Klaviyo's own names and the usual ones people give them) */
export function segmentPattern(name: string, type: "list" | "segment" = "segment"): SegPattern {
  const n = name.toLowerCase().replace(/[_/]+/g, " ");
  if (/\bun-?engaged\b|\bnon-?engaged\b|\bnot engaged\b|\binactive\b|\bsunset\b|\bdormant\b|\bdisengaged\b/.test(n)) return "unengaged";
  if (/\bwin-?back\b|\blapsed\b|\bchurn|\bat[ -]risk\b|\breactivat|\bre-?engage/.test(n)) return "winback";
  if (/\b(zero|0)[ -]*(time[ -]*)?(purchas|buyer|order|customer)|\bnever[ -]*(purchased|bought|ordered|buy)|\bnon[ -]?(purchas|buyer|customer)|\b(haven'?t|have not|has not|hasn'?t)[ -]*(yet )?(purchased|ordered|bought)|\bno purchase|\bnot purchased|\bprospects?\b/.test(n)) return "zero_purchase";
  if (/\bvip\b|\btop customers?\b|\bbest customers?\b|\bhigh[ -]*value\b|\bhvc\b|\bbig spenders?\b|\bhigh ltv\b/.test(n)) return "vip";
  if (/\brepeat\b|\breturning\b|\bloyal|\b2\+|\bmulti[ -]*(time|purchas)|\bsecond purchase/.test(n)) return "repeat_buyers";
  if (/\b(recent|new|last\s*\d+|past\s*\d+)[ -]*(days?[ -]*)?(purchas\w*|buyers?|customers?|orders?)\b|\bpurchased (in )?(the )?(last|past)\b|\bbought (in )?(the )?(last|past)\b|\bplaced order (in )?(the )?(last|past)\b/.test(n)) return "recent_buyers";
  if (/\bengag/.test(n)) {
    if (/\b30\b/.test(n)) return "engaged30";
    if (/\b60\b/.test(n)) return "engaged60";
    if (/\b90\b/.test(n)) return "engaged90";
    return "engaged";
  }
  if (/\bnew subscribers?\b|\bwelcome\b|\bnew (sign|join)|\brecently (joined|subscribed|signed)/.test(n)) return "new_subscribers";
  if (type === "list" || /^all\b|\ball (subscribers|profiles|contacts|emails|marketing)\b|^newsletter$|\bmain list\b|\bmaster list\b|\beveryone\b|^subscribers$/.test(n)) return "all";
  return "other";
}

// ─── From campaign rows to segment numbers ──────────────────────────────────

/** One sent campaign with who it went to (email only: SMS lists are their own thing) */
export type SegCampaign = {
  id: string;
  sendTime: string;
  recipients: number;
  delivered: number;
  opens: number;
  clicks: number;
  unsubscribes: number;
  bounced: number;
  spam: number;
  revenue: number;
  included: AudienceRef[];
  excluded: AudienceRef[];
};

const num = (v: unknown) => Number(v ?? 0) || 0;

/**
 * A klaviyo_campaigns row as a SegCampaign. Audiences come from audiences_detail when it is there; before the sync has
 * filled it (or the column exists but is empty for older campaigns) the older text[] of included names stands in, with
 * the kind looked up by name. Null for an SMS campaign or one that hasn't been sent.
 */
export function segCampaignOf(row: Record<string, unknown>, kindByName?: Map<string, "list" | "segment">): SegCampaign | null {
  if (String(row.channel ?? "email") === "sms") return null;
  const sendTime = typeof row.send_time === "string" ? row.send_time : null;
  if (!sendTime || Date.parse(sendTime) > Date.now()) return null;
  const detail = parseAudiencesJson(row.audiences_detail);
  const names = Array.isArray(row.audiences) ? (row.audiences as unknown[]).filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
  const included = detail?.included.length ? detail.included : names.map((nm) => ({ id: nm, name: nm, type: kindByName?.get(nm) ?? ("segment" as const) }));
  return {
    id: String(row.campaign_id ?? row.id ?? ""),
    sendTime,
    recipients: num(row.recipients),
    delivered: num(row.delivered),
    opens: num(row.opens_unique),
    clicks: num(row.clicks_unique),
    unsubscribes: num(row.unsubscribes),
    bounced: num(row.bounced),
    spam: num(row.spam_complaints),
    revenue: num(row.revenue),
    included,
    excluded: detail?.excluded ?? [],
  };
}

export type SegFlag = { kind: "underperforming" | "overused"; why: string };

export type SegmentStat = {
  id: string;
  name: string;
  type: "list" | "segment";
  pattern: SegPattern;
  campaigns: number;
  recipients: number;
  openRate: number | null;
  clickRate: number | null;
  unsubscribeRate: number | null;
  revenue: number;
  /** Revenue per recipient */
  rpr: number | null;
  /** Campaigns a week, over the window */
  perWeek: number;
  /** Campaigns that left this audience out */
  excludedIn: number;
  lastSent: string | null;
  /** Its size now, when the audience was counted */
  profiles: number | null;
  /** Revenue per recipient in the second half of the window against the first, when both halves had sends */
  rprTrend: number | null;
  flags: SegFlag[];
};

export type Baseline = { campaigns: number; recipients: number; openRate: number | null; clickRate: number | null; unsubscribeRate: number | null; spamRate: number | null; bounceRate: number | null; rpr: number | null; revenue: number };

const div = (a: number, b: number) => (b > 0 ? a / b : null);
const money = (x: number) => `$${x >= 10 ? Math.round(x) : x.toFixed(2)}`;
const p = (x: number | null, d = 1) => (x == null ? "n/a" : `${(x * 100).toFixed(d)}%`);

/** Healthy lines (the same as the account's health checks in insights.ts, repeated so this file stays free of imports) */
const BAR = { unsubscribe: 0.003, spam: 0.0001, bounce: 0.01 } as const;

/** The account over the same campaigns: what a segment is held against */
export function baselineOf(campaigns: SegCampaign[]): Baseline {
  const sum = (f: (c: SegCampaign) => number) => campaigns.reduce((s, c) => s + f(c), 0);
  const delivered = sum((c) => c.delivered);
  const recipients = sum((c) => c.recipients);
  const revenue = sum((c) => c.revenue);
  return {
    campaigns: campaigns.length,
    recipients,
    openRate: div(sum((c) => c.opens), delivered),
    clickRate: div(sum((c) => c.clicks), delivered),
    unsubscribeRate: div(sum((c) => c.unsubscribes), delivered),
    spamRate: div(sum((c) => c.spam), delivered),
    bounceRate: div(sum((c) => c.bounced), recipients),
    rpr: div(revenue, recipients),
    revenue,
  };
}

export type SizeLookup = Map<string, { name: string; type: "list" | "segment"; profiles: number | null }>;

/** Every audience the window's campaigns went to, with its numbers and flags (best revenue first) */
export function aggregateSegments(campaigns: SegCampaign[], opts: { days: number; today?: string; sizes?: SizeLookup }): SegmentStat[] {
  const base = baselineOf(campaigns);
  const weeks = Math.max(1, opts.days) / 7;
  const mid = Date.parse(opts.today ?? new Date().toISOString().slice(0, 10)) - (opts.days / 2) * 86_400_000;
  type Acc = { ref: AudienceRef; list: SegCampaign[] };
  const by = new Map<string, Acc>();
  const excl = new Map<string, number>();
  for (const c of campaigns) {
    for (const r of c.included) {
      const a = by.get(r.id) ?? { ref: r, list: [] };
      a.list.push(c);
      by.set(r.id, a);
    }
    for (const r of c.excluded) excl.set(r.id, (excl.get(r.id) ?? 0) + 1);
  }
  const out: SegmentStat[] = [];
  for (const { ref, list } of by.values()) {
    const sum = (f: (c: SegCampaign) => number, l = list) => l.reduce((s, c) => s + f(c), 0);
    const recipients = sum((c) => c.recipients);
    const delivered = sum((c) => c.delivered);
    const revenue = sum((c) => c.revenue);
    const rprOf = (l: SegCampaign[]) => div(sum((c) => c.revenue, l), sum((c) => c.recipients, l));
    const early = list.filter((c) => Date.parse(c.sendTime) < mid);
    const late = list.filter((c) => Date.parse(c.sendTime) >= mid);
    const e = rprOf(early);
    const l = rprOf(late);
    const size = opts.sizes?.get(ref.id);
    const stat: SegmentStat = {
      id: ref.id,
      name: ref.name,
      type: ref.type,
      pattern: segmentPattern(ref.name, ref.type),
      campaigns: list.length,
      recipients,
      openRate: div(sum((c) => c.opens), delivered),
      clickRate: div(sum((c) => c.clicks), delivered),
      unsubscribeRate: div(sum((c) => c.unsubscribes), delivered),
      revenue,
      rpr: div(revenue, recipients),
      perWeek: list.length / weeks,
      excludedIn: excl.get(ref.id) ?? 0,
      lastSent: list.map((c) => c.sendTime).sort().at(-1) ?? null,
      profiles: size?.profiles ?? null,
      rprTrend: early.length && late.length && e != null && e > 0 && l != null ? (l - e) / e : null,
      flags: [],
    };
    stat.flags = flagsOf(stat, base);
    out.push(stat);
  }
  return out.sort((a, b) => b.revenue - a.revenue || b.recipients - a.recipients);
}

/**
 * Underperforming: at least 2 campaigns and 500 recipients, and revenue per recipient under half the account's, or open
 * rate under 70% of it, or click rate under 60% of it. Overused: sent to at least 4 times at 2 or more a week, with a
 * sign of fatigue (unsubscribes or spam over the healthy line, revenue per recipient clearly under the account's or
 * down a quarter from the first half of the window).
 */
export function flagsOf(s: SegmentStat, base: Baseline): SegFlag[] {
  const flags: SegFlag[] = [];
  if (s.campaigns >= 2 && s.recipients >= 500) {
    const why: string[] = [];
    if (base.rpr != null && base.rpr > 0 && s.rpr != null && s.rpr < base.rpr * 0.5) why.push(`${money(s.rpr)} per recipient against ${money(base.rpr)} for the account`);
    if (base.openRate != null && s.openRate != null && s.openRate < base.openRate * 0.7) why.push(`open rate ${p(s.openRate)} against ${p(base.openRate)}`);
    if (base.clickRate != null && base.clickRate > 0 && s.clickRate != null && s.clickRate < base.clickRate * 0.6) why.push(`click rate ${p(s.clickRate, 2)} against ${p(base.clickRate, 2)}`);
    if (why.length) flags.push({ kind: "underperforming", why: why.join("; ") });
  }
  if (s.campaigns >= 4 && s.perWeek >= 2) {
    const sign: string[] = [];
    if (s.unsubscribeRate != null && s.unsubscribeRate > BAR.unsubscribe) sign.push(`unsubscribes ${p(s.unsubscribeRate, 2)}`);
    if (base.rpr != null && base.rpr > 0 && s.rpr != null && s.rpr < base.rpr * 0.85) sign.push(`${money(s.rpr)} per recipient against ${money(base.rpr)}`);
    if (s.rprTrend != null && s.rprTrend <= -0.25) sign.push(`revenue per recipient down ${Math.round(Math.abs(s.rprTrend) * 100)}% from the first half`);
    if (sign.length) flags.push({ kind: "overused", why: `Sent to ${s.campaigns} times (${s.perWeek.toFixed(1)} a week) and ${sign.join(", ")}` });
  }
  return flags;
}

// ─── What works for similar clients ─────────────────────────────────────────

/** A kind of segment, across the other clients in the same industry (never one client's own numbers) */
export type PeerPattern = { pattern: SegPattern; label: string; clients: number; campaigns: number; recipients: number; rpr: number | null; openRate: number | null };

/** Patterns that tell you something when they work for peers (the whole list and "other" don't) */
const USEFUL: SegPattern[] = ["engaged30", "engaged60", "engaged90", "engaged", "vip", "winback", "zero_purchase", "recent_buyers", "repeat_buyers", "new_subscribers"];

/**
 * What kinds of segment earn for the given other clients: per pattern, how many clients use it, over how many
 * campaigns and recipients, and what it earned per recipient. A pattern needs at least `minClients` clients and
 * `minRecipients` recipients to count (one client's habit isn't a pattern).
 */
export function peerPatterns(peers: { clientId: string; campaigns: SegCampaign[] }[], opts: { minClients?: number; minRecipients?: number } = {}): PeerPattern[] {
  const minClients = opts.minClients ?? 2;
  const minRecipients = opts.minRecipients ?? 1000;
  const acc = new Map<SegPattern, { clients: Set<string>; campaigns: number; recipients: number; delivered: number; opens: number; revenue: number }>();
  for (const peer of peers) {
    for (const c of peer.campaigns) {
      const kinds = new Set(c.included.map((r) => segmentPattern(r.name, r.type)).filter((k) => USEFUL.includes(k)));
      for (const k of kinds) {
        const a = acc.get(k) ?? { clients: new Set<string>(), campaigns: 0, recipients: 0, delivered: 0, opens: 0, revenue: 0 };
        a.clients.add(peer.clientId);
        a.campaigns += 1;
        a.recipients += c.recipients;
        a.delivered += c.delivered;
        a.opens += c.opens;
        a.revenue += c.revenue;
        acc.set(k, a);
      }
    }
  }
  return [...acc.entries()]
    .filter(([, a]) => a.clients.size >= minClients && a.recipients >= minRecipients)
    .map(([pattern, a]) => ({ pattern, label: PATTERN_LABEL[pattern], clients: a.clients.size, campaigns: a.campaigns, recipients: a.recipients, rpr: div(a.revenue, a.recipients), openRate: div(a.opens, a.delivered) }))
    .sort((a, b) => (b.rpr ?? 0) - (a.rpr ?? 0));
}

// ─── Advice ─────────────────────────────────────────────────────────────────

export type SegAdvice = {
  kind: "include" | "exclude" | "target" | "rotate" | "try";
  title: string;
  detail: string;
  /** The segments by name (this account's own where it has one, otherwise what to create) */
  segments: string[];
  /** Whether the account already has the segment or it would have to be created */
  exists: boolean;
};

export type AudienceInfo = { name: string; type: "list" | "segment"; profiles: number | null };

type AdviceInput = {
  own: SegmentStat[];
  campaigns: SegCampaign[];
  base: Baseline;
  /** Every list and segment the account has (sized where counted), not only those sent to in the window */
  audiences: AudienceInfo[];
  peers: PeerPattern[];
  days: number;
};

/** The account's own segment of this kind, preferring the one sent to most, then the biggest */
function ownOf(kind: SegPattern[], input: AdviceInput): { name: string; profiles: number | null } | null {
  const sent = input.own.filter((s) => kind.includes(s.pattern)).sort((a, b) => b.campaigns - a.campaigns);
  if (sent[0]) return { name: sent[0].name, profiles: sent[0].profiles };
  const aud = input.audiences.filter((a) => kind.includes(segmentPattern(a.name, a.type))).sort((a, b) => (b.profiles ?? 0) - (a.profiles ?? 0));
  return aud[0] ? { name: aud[0].name, profiles: aud[0].profiles } : null;
}

/**
 * Inclusion and exclusion advice for the sends coming, and segments worth trying from similar clients. Most urgent
 * first; at most 8 pieces of advice.
 */
export function segmentAdvice(input: AdviceInput): SegAdvice[] {
  const out: SegAdvice[] = [];
  const { base } = input;
  const eng = (k: SegPattern[], fallback: string) => {
    const o = ownOf(k, input);
    return { name: o?.name ?? fallback, exists: Boolean(o) };
  };

  // 1. Deliverability under its bar: warmer segments in, the cold ones out
  const weak: string[] = [];
  if (base.bounceRate != null && base.bounceRate > BAR.bounce) weak.push(`bounces ${p(base.bounceRate, 2)}`);
  if (base.spamRate != null && base.spamRate > BAR.spam) weak.push(`spam complaints ${p(base.spamRate, 2)}`);
  if (base.unsubscribeRate != null && base.unsubscribeRate > BAR.unsubscribe) weak.push(`unsubscribes ${p(base.unsubscribeRate, 2)}`);
  if (base.campaigns >= 3 && weak.length) {
    const inc = eng(["engaged30"], "Engaged in the last 30 days");
    const exc = eng(["unengaged"], "Unengaged for 90+ days");
    out.push({ kind: "include", title: "Send to the engaged 30 days first", detail: `Deliverability is under its bar (${weak.join(", ")}): campaigns go to ${inc.name} until it's healthy again, not to the whole list.`, segments: [inc.name], exists: inc.exists });
    out.push({ kind: "exclude", title: "Leave out the unengaged", detail: `Keep ${exc.name} off every promotional send while ${weak[0]}: they are what mailbox providers judge a sender by.`, segments: [exc.name], exists: exc.exists });
  }

  // 2. Many zero-time purchasers: they are a first-purchase offer waiting, and recent buyers shouldn't get it
  const zero = input.own.find((s) => s.pattern === "zero_purchase") ?? null;
  const zeroAud = input.audiences.filter((a) => segmentPattern(a.name, a.type) === "zero_purchase").sort((a, b) => (b.profiles ?? 0) - (a.profiles ?? 0))[0] ?? null;
  const largest = Math.max(0, ...input.audiences.map((a) => a.profiles ?? 0));
  const zeroSize = zeroAud?.profiles ?? zero?.profiles ?? null;
  if (zeroAud && zeroSize != null && zeroSize >= Math.max(1000, largest * 0.2) && (zero?.campaigns ?? 0) < 2) {
    const buyers = eng(["recent_buyers"], "Purchased in the last 30 days");
    out.push({ kind: "target", title: "Target the zero-time purchasers", detail: `${zeroAud.name} holds ${zeroSize.toLocaleString("en-US")} people who haven't bought and it has had ${zero?.campaigns ?? 0} ${zero?.campaigns === 1 ? "campaign" : "campaigns"} in ${input.days} days: a first-purchase offer or a story that earns trust.`, segments: [zeroAud.name], exists: true });
    out.push({ kind: "exclude", title: "Exclude recent buyers from first-purchase offers", detail: `Add ${buyers.name} as an exclusion so people who just bought aren't offered a first-order discount.`, segments: [buyers.name], exists: buyers.exists });
  }

  // 3. Whole-list sends with nothing left out
  const sendable = input.campaigns.filter((c) => c.included.length);
  const wholeList = sendable.filter((c) => c.included.every((r) => segmentPattern(r.name, r.type) === "all") && !c.excluded.length);
  if (sendable.length >= 3 && wholeList.length / sendable.length >= 0.5 && !weak.length) {
    const exc = eng(["unengaged"], "Unengaged for 90+ days");
    const buyers = eng(["recent_buyers"], "Purchased in the last 30 days");
    out.push({ kind: "exclude", title: "Stop sending to the whole list with nothing left out", detail: `${wholeList.length} of ${sendable.length} campaigns went to the whole list with no exclusions. On promotions leave out ${exc.name}, and ${buyers.name} when the offer is for new customers.`, segments: [exc.name, buyers.name], exists: exc.exists && buyers.exists });
  }

  // 4. Overused and underperforming segments
  for (const s of input.own.filter((x) => x.flags.some((f) => f.kind === "overused")).slice(0, 2)) {
    const alt = s.pattern === "engaged30" ? eng(["engaged60"], "Engaged in the last 60 days") : eng(["engaged30"], "Engaged in the last 30 days");
    out.push({ kind: "rotate", title: `Rest ${s.name}`, detail: `${s.flags.find((f) => f.kind === "overused")?.why}. Rotate with ${alt.name} and keep ${s.name} for the best offers.`, segments: [s.name, alt.name], exists: alt.exists });
  }
  for (const s of input.own.filter((x) => x.flags.some((f) => f.kind === "underperforming")).slice(0, 2)) {
    out.push({ kind: "rotate", title: `Trim ${s.name}`, detail: `${s.flags.find((f) => f.kind === "underperforming")?.why}. Send it fewer promotions, or move its sends to a warmer segment.`, segments: [s.name], exists: true });
  }

  // 5. What earns for similar clients that this account doesn't use (or uses under its own average)
  for (const peer of input.peers) {
    if (out.length >= 8) break;
    if (peer.rpr == null) continue;
    const mine = input.own.find((s) => s.pattern === peer.pattern);
    const ownAud = ownOf([peer.pattern], input);
    if (mine && mine.campaigns >= 2) continue;
    if (base.rpr != null && peer.rpr < base.rpr * 0.9) continue;
    const used = mine ? `sent to ${mine.campaigns} time${mine.campaigns === 1 ? "" : "s"}` : `not sent to in the last ${input.days} days`;
    out.push({
      kind: "try",
      title: `${peer.label} segments`,
      detail: `Earn ${money(peer.rpr)} per recipient at ${peer.clients} similar clients${peer.openRate != null ? ` (${p(peer.openRate, 0)} opens)` : ""}; here ${ownAud ? `${ownAud.name} is ${used}` : "there isn't one yet"}.`,
      segments: [ownAud?.name ?? peer.label],
      exists: Boolean(ownAud),
    });
  }
  return out.slice(0, 8);
}

// ─── The report ─────────────────────────────────────────────────────────────

export type SegmentReport = {
  days: number;
  from: string;
  to: string;
  /** Sent campaigns read, and how many of them have audiences recorded (the sync fills the rest on its next full read) */
  campaigns: number;
  withAudiences: number;
  base: Baseline;
  segments: SegmentStat[];
  advice: SegAdvice[];
  peers: PeerPattern[];
  /** Who "similar clients" are: the industry (and sub-category), and how many others were read; null when the client has no industry */
  peerScope: { industry: string; detail: string | null; clients: number } | null;
};

/** Everything above in one pass, from the rows already read */
export function buildSegmentReport(input: { campaigns: SegCampaign[]; audiences: AudienceInfo[]; peers: { clientId: string; campaigns: SegCampaign[] }[]; peerScope: SegmentReport["peerScope"]; days: number; today: string }): SegmentReport {
  const from = new Date(Date.parse(input.today) - (input.days - 1) * 86_400_000).toISOString().slice(0, 10);
  const inWindow = input.campaigns.filter((c) => c.sendTime.slice(0, 10) >= from);
  const withAud = inWindow.filter((c) => c.included.length);
  const sizes: SizeLookup = new Map();
  for (const a of input.audiences) sizes.set(a.name, { name: a.name, type: a.type, profiles: a.profiles });
  // Sizes are looked up by name (audiences_detail has ids, the audiences table has both; names are what the two share)
  const named = aggregateSegments(withAud, { days: input.days, today: input.today });
  const own = named.map((s) => ({ ...s, profiles: sizes.get(s.name)?.profiles ?? null }));
  const base = baselineOf(withAud);
  const peers = peerPatterns(input.peers);
  return {
    days: input.days,
    from,
    to: input.today,
    campaigns: inWindow.length,
    withAudiences: withAud.length,
    base,
    segments: own,
    advice: segmentAdvice({ own, campaigns: withAud, base, audiences: input.audiences, peers, days: input.days }),
    peers,
    peerScope: input.peerScope,
  };
}

/** The report as plain lines for the email audit and the assistant: the numbers, the flags and the advice, nothing else */
export function segmentDigest(r: SegmentReport | null, money$: (x: number) => string = (x) => `$${Math.round(x).toLocaleString("en-US")}`): string {
  if (!r || !r.withAudiences) return r ? `Segments: no campaign in the last ${r.days} days has its audiences recorded yet (the next full Klaviyo read fills them in).` : "";
  const lines = [`Segments over ${r.days} days (${r.withAudiences} campaigns with audiences; a campaign sent to two segments counts for both):`];
  for (const s of r.segments.slice(0, 14)) {
    const flag = s.flags.length ? ` [${s.flags.map((f) => f.kind).join(", ")}]` : "";
    lines.push(`- ${s.name} (${s.type}, ${PATTERN_LABEL[s.pattern].toLowerCase()}): ${s.campaigns} campaigns, ${s.recipients.toLocaleString("en-US")} recipients, open ${p(s.openRate)}, click ${p(s.clickRate, 2)}, ${money$(s.revenue)} revenue, ${s.rpr != null ? `${money(s.rpr)} per recipient` : "no revenue per recipient"}${s.excludedIn ? `, left out of ${s.excludedIn}` : ""}${flag}`);
  }
  for (const s of r.segments.filter((x) => x.flags.length)) for (const f of s.flags) lines.push(`Flag, ${s.name}: ${f.kind}: ${f.why}`);
  for (const a of r.advice) lines.push(`Advice (${a.kind}): ${a.title}. ${a.detail}${a.exists ? "" : " (to be created in Klaviyo)"}`);
  if (r.peers.length && r.peerScope) lines.push(`Similar clients (${r.peerScope.detail ? `${r.peerScope.industry}, ${r.peerScope.detail}` : r.peerScope.industry}, ${r.peerScope.clients} others): ${r.peers.slice(0, 5).map((x) => `${x.label} ${x.rpr != null ? `${money(x.rpr)} per recipient` : ""} across ${x.clients} clients`).join("; ")}.`);
  return lines.join("\n");
}
