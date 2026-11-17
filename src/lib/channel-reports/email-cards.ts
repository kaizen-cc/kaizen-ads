import { EMAIL_CHECKS } from "@/lib/email-score";
import type { LocationMetricBreakdown } from "@/lib/klaviyo/locations";
import { int, pct } from "./core";
import { wholeMoney } from "./email-message";
import { grade, RATE_BARS, type Grade, type MessageRow } from "./email-detail";

// What the email report's campaign cards and location visuals show, worked out once so the PDF (channel-doc.tsx) and the
// live page the client opens (/r/<token>) say the same thing. Pure: no database, no network.

// ─── Campaign cards ────────────────────────────────────────────────────────

/** How many campaigns get a card with the email's picture; the rest stay in the table under them */
export const CARD_LIMIT = 6;

/** Kaizen's revenue per recipient bar (src/lib/email-score.ts) */
export const RPR_BAR = EMAIL_CHECKS.find((c) => c.key === "rpr")?.bar ?? 0.15;

/** The campaigns that get a card: every one when there are a few, else the best by revenue, shown in send order */
export function cardCampaigns<T extends Pick<MessageRow, "id" | "revenue" | "date">>(rows: T[], limit = CARD_LIMIT): T[] {
  if (rows.length <= limit) return rows;
  const best = new Set([...rows].sort((a, b) => b.revenue - a.revenue).slice(0, limit).map((r) => r.id));
  return rows.filter((r) => best.has(r.id));
}

/** The campaign's own report in Klaviyo (only for a report whose numbers come from Klaviyo) */
export const klaviyoCampaignUrl = (id: string) => `https://www.klaviyo.com/campaign/${encodeURIComponent(id)}/reports`;
export const fromKlaviyo = (source: string | null | undefined) => !source || source === "Klaviyo";

/** One number on a card: its value, an optional line under it, and how it stands against Kaizen's bar */
export type CardStat = { key: string; label: string; value: string; sub?: string | null; grade?: Grade | null; /** 0..1 along the gauge, and where the bar sits on it */ gauge?: { fill: number; mark: number } | null; strong?: boolean };

/** The gauge runs to 1.6 times the bar, so the bar sits a little past the middle and a strong number still has room */
const SPAN = 1.6;
const gaugeOf = (v: number | null | undefined, target: number) => (v == null || !Number.isFinite(v) ? null : { fill: Math.max(0, Math.min(1, v / (target * SPAN))), mark: 1 / SPAN });

/** A campaign card's numbers: recipients, open and click rate, orders, revenue and revenue per recipient (rates graded against the bars) */
export function cardStats(r: Pick<MessageRow, "channel" | "recipients" | "openRate" | "clickRate" | "orders" | "orderRate" | "revenue">, currency: string | null, revenueMeasured = true): CardStat[] {
  const sms = r.channel === "sms";
  const rpr = r.recipients > 0 ? r.revenue / r.recipients : null;
  const bars = RATE_BARS.campaign;
  const out: CardStat[] = [
    { key: "recipients", label: "Recipients", value: int(r.recipients) },
    { key: "open", label: "Open rate", value: sms ? "SMS" : pct(r.openRate, 1), grade: sms ? null : grade(r.openRate, bars.open), gauge: sms ? null : gaugeOf(r.openRate, bars.open), sub: sms ? "Texts aren't opened" : `Bar ${pct(bars.open, 0)}` },
    { key: "click", label: "Click rate", value: pct(r.clickRate, 2), grade: grade(r.clickRate, bars.click), gauge: gaugeOf(r.clickRate, bars.click), sub: `Bar ${pct(bars.click, 0)}` },
  ];
  if (!revenueMeasured) return out;
  out.push(
    { key: "orders", label: "Orders", value: int(r.orders), sub: r.orderRate != null ? `${pct(r.orderRate, 2)} ordered` : null },
    { key: "revenue", label: "Revenue", value: wholeMoney(r.revenue, currency), strong: true },
    { key: "rpr", label: "Revenue per recipient", value: rpr == null ? "–" : rprMoney(rpr, currency), grade: grade(rpr, RPR_BAR), gauge: gaugeOf(rpr, RPR_BAR), sub: `Bar ${rprMoney(RPR_BAR, currency)}` },
  );
  return out;
}

/** Cents always shown: revenue per recipient is a small number */
const rprMoney = (n: number, currency: string | null) => `${!currency || currency === "USD" ? "$" : `${currency} `}${n.toFixed(2)}`;

// ─── Locations ─────────────────────────────────────────────────────────────

/** The part before a separator ("Crust Pizza Co. - Heights" gives "Crust Pizza Co."), compared without case or punctuation */
const SEP = /\s+[-–—|:·]\s+/;
const squash = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Location names without the brand every one of them starts with ("Crust Pizza Co - Heights" and "Crust Pizza Co. -
 * Magnolia" read "Heights" and "Magnolia"). A prefix is dropped only when most names share it, and a name that would be
 * left empty keeps its full name.
 */
export function locationNamer(names: string[]): (name: string) => string {
  const counts = new Map<string, number>();
  for (const n of names) {
    const m = SEP.exec(n);
    if (m && m.index > 0) counts.set(squash(n.slice(0, m.index)), (counts.get(squash(n.slice(0, m.index))) ?? 0) + 1);
  }
  const [brand, seen] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  const real = names.filter((n) => n.trim()).length;
  if (!brand || seen < 2 || seen < real * 0.5) return (n) => n;
  return (n) => {
    const m = SEP.exec(n);
    if (!m || m.index === 0 || squash(n.slice(0, m.index)) !== brand) return n;
    const rest = n.slice(m.index + m[0].length).trim();
    return rest || n;
  };
}

export type LocationView = {
  name: string;
  full: string;
  rank: number;
  revenue: number;
  conversions: number;
  share: number;
  /** The column that earned this location the most (a campaign or "Flows") and its share of the location's revenue */
  best: { id: string; name: string; share: number } | null;
};

/** One metric's locations ready to draw: brand stripped, each one's share, the leader and the long tail */
export function locationViews(x: LocationMetricBreakdown, top = 15) {
  const name = locationNamer(x.ranked.map((r) => r.location));
  const rows = new Map(x.rows.map((r) => [r.location, r]));
  const all: LocationView[] = x.ranked.map((r) => {
    const row = rows.get(r.location);
    let best: LocationView["best"] = null;
    if (row && row.total > 0)
      row.cells.forEach((v, i) => {
        if (v && (!best || v / row.total > best.share)) best = { id: x.columns[i]?.id ?? "", name: x.columns[i]?.name ?? "", share: v / row.total };
      });
    return { name: name(r.location), full: r.location, rank: r.rank, revenue: r.revenue, conversions: r.conversions, share: x.revenue > 0 ? r.revenue / x.revenue : 0, best };
  });
  const shown = all.slice(0, top);
  const rest = all.slice(top);
  const restRevenue = rest.reduce((s, r) => s + r.revenue, 0);
  return {
    all,
    shown,
    rest: rest.length ? { count: rest.length, revenue: restRevenue, share: x.revenue > 0 ? restRevenue / x.revenue : 0 } : null,
    leader: all[0] ?? null,
    name,
    /** Average revenue per converting location */
    average: all.length ? x.revenue / all.length : 0,
    /** The biggest single cell, for shading the table */
    maxCell: Math.max(0, ...x.rows.flatMap((r) => r.cells.map((v) => v ?? 0))),
  };
}

/** A share as a whole percent, with "<1%" for a sliver */
export const shareText = (x: number) => (x > 0 && x < 0.005 ? "<1%" : `${Math.round(x * 100)}%`);

/** How strong a cell's shade is (0 for nothing, then 0.08 to 0.9 by value against the biggest cell, on a gentle curve) */
export function heat(v: number | null | undefined, max: number): number {
  if (!v || v <= 0 || max <= 0) return 0;
  return 0.08 + 0.82 * Math.sqrt(Math.min(1, v / max));
}

/** A colour mixed toward white: t = 1 is the colour itself */
export function tint(hex: string, t: number): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
  const n = Number.parseInt(full, 16);
  if (!Number.isFinite(n)) return hex;
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(255 + (c - 255) * Math.max(0, Math.min(1, t))));
  return `#${ch.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}
