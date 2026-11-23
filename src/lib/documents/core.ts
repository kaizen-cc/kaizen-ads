// Kaizen-branded documents (create_document): a Scope of Work, a proposal, a handoff summary or a one-pager, written by
// the agent and drawn as a PDF in the report look. This is the pure part: what a document may hold, the clean-up that
// keeps every part readable, and the price guard. A price is only ever one that's stored (a package record's price,
// or what Stripe bills the client via Kaizen Track): anything else becomes a clearly marked placeholder, in the
// pricing table and in the text. Pure: no keys, no network.

export const DOC_KINDS = ["sow", "proposal", "handoff", "one_pager"] as const;
export type DocKind = (typeof DOC_KINDS)[number];
export const DOC_LABEL: Record<DocKind, string> = { sow: "Scope of Work", proposal: "Proposal", handoff: "Handoff summary", one_pager: "One-pager" };

export const PRICE_PLACEHOLDER = "Price to confirm";

export type DocStat = { value: string; label: string; note: string };
export type DocSection = { heading: string; body: string; bullets: string[] };
export type DocDeliverable = { item: string; detail: string; qty: string };
export type DocCadence = { what: string; when: string };
export type DocPrice = { item: string; price: string; cadence: string; note: string; placeholder: boolean; source: StoredPrice["source"] | null };

export type DocContent = {
  kind: DocKind;
  title: string;
  subtitle: string;
  client: string | null;
  /** The band under the title: "December 2026 onward", "Oct 1 to Nov 15, 2026" */
  period: string;
  summary: string;
  stats: DocStat[];
  sections: DocSection[];
  deliverables: DocDeliverable[];
  cadence: DocCadence[];
  pricing: DocPrice[];
  inclusions: string[];
  exclusions: string[];
  nextSteps: string[];
  preparedBy: string;
};

/** A price that's stored: a package record's (service_tiers) or the client's current Stripe billing (via Track) */
export type StoredPrice = { label: string; amount: number; cadence: "month" | "one_time"; source: "package" | "stripe" | "confirmed" };

/** Every amount written in a text ("$1,750", "1750", "1.75k", "$2k"), as numbers */
export function amountsIn(text: string): number[] {
  return [...text.toLowerCase().matchAll(/\$?(\d[\d,]*(?:\.\d+)?)\s*(k\b)?/g)].map((m) => Number(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1)).filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * Prices the person confirmed in the conversation (Basic at $1,000/mo, Silver at $1,750/mo), so every document made
 * from it carries them instead of "Price to confirm". Kept only when the person said that amount (in what they wrote
 * this turn), or they're an executive (who sets prices); anything else stays a placeholder.
 */
export function confirmedPrices(raw: unknown, said: string, isExec: boolean): StoredPrice[] {
  const heardAmounts = amountsIn(said);
  const out: StoredPrice[] = [];
  for (const r of Array.isArray(raw) ? raw.slice(0, 12) : []) {
    const o = (r ?? {}) as Record<string, unknown>;
    const amount = Number(String(o.amount ?? "").replace(/[$,\s]/g, ""));
    const label = String(o.item ?? "").trim().slice(0, 120);
    if (!label || !Number.isFinite(amount) || amount <= 0) continue;
    if (!isExec && !heardAmounts.some((h) => Math.abs(h - amount) < 0.005)) continue;
    out.push({ label, amount, cadence: String(o.cadence ?? "").toLowerCase().startsWith("one") ? "one_time" : "month", source: "confirmed" });
  }
  return out;
}

/** Plain text, one line, cut at a word to at most n characters; dashes used as punctuation become commas */
export function line(v: unknown, n: number): string {
  const t = noDashes(String(v ?? ""))
    .replace(/\s+/g, " ")
    .trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > n * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

/** Paragraph text: line breaks kept (at most one blank line), cut at n */
export function para(v: unknown, n: number): string {
  const t = noDashes(String(v ?? ""))
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).replace(/\s+\S*$/, "")}…`;
}

/** Em and en dashes used as punctuation read as commas (Kaizen's writing never uses them); ranges keep a hyphen */
export function noDashes(s: string): string {
  return s
    .replace(/(\d)\s*[–—]\s*(\d)/g, "$1-$2")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/,\s*,/g, ",");
}

const list = (v: unknown, max: number, each: number) =>
  (Array.isArray(v) ? v : [])
    .map((x) => line(x, each))
    .filter(Boolean)
    .slice(0, max);

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export const isDocKind = (v: unknown): v is DocKind => (DOC_KINDS as readonly string[]).includes(String(v));

/** "$1,500", "1500", "$1.5k", "USD 2,000.00" → 1500 / 2000; null when it isn't a price */
export function parseAmount(v: unknown): number | null {
  const s = String(v ?? "")
    .toLowerCase()
    .replace(/usd|us\$|\$|,|\s/g, "");
  const m = s.match(/^(\d+(?:\.\d+)?)(k)?/);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] ? 1000 : 1);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

export const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

/** The stored price a line's price matches (the same amount), if any */
export function matchStored(amount: number | null, stored: readonly StoredPrice[]): StoredPrice | null {
  if (amount == null) return null;
  return stored.find((p) => Math.abs(p.amount - amount) < 0.01) ?? null;
}

/**
 * A pricing line, guarded: its price stays only when it's a stored price; otherwise (or when it's missing) the line
 * shows the placeholder. A line with no price but naming a stored package (its label) gets that stored price.
 */
export function guardPrice(raw: Record<string, unknown>, stored: readonly StoredPrice[]): DocPrice | null {
  const item = line(raw.item ?? raw.label ?? raw.name, 80);
  if (!item) return null;
  const given = parseAmount(raw.price ?? raw.amount);
  let hit = matchStored(given, stored);
  if (!hit && given == null) {
    const k = item.toLowerCase();
    hit = stored.find((p) => k.includes(p.label.toLowerCase()) || p.label.toLowerCase().includes(k)) ?? null;
  }
  const cadence = line(raw.cadence, 30) || (hit ? (hit.cadence === "month" ? "per month" : "one time") : "");
  return { item, price: hit ? money(hit.amount) : PRICE_PLACEHOLDER, cadence, note: line(raw.note, 140), placeholder: !hit, source: hit?.source ?? null };
}

/**
 * Money written into the text that isn't a stored price becomes the placeholder, so a price can't slip in through a
 * paragraph. Percentages, counts and revenue figures the client earned are left alone only when they aren't dollar
 * amounts; dollar amounts are checked against what's allowed (stored prices, plus figures read from their own data).
 */
export function scrubPrices(text: string, allowed: readonly number[]): { text: string; scrubbed: number } {
  let scrubbed = 0;
  const out = text.replace(/\$\s?\d[\d,]*(?:\.\d+)?\s?(?:k\b)?/gi, (m) => {
    const n = parseAmount(m);
    if (n != null && allowed.some((a) => Math.abs(a - n) < 0.01)) return m;
    scrubbed++;
    return `[${PRICE_PLACEHOLDER.toLowerCase()}]`;
  });
  return { text: out, scrubbed };
}

export type CleanOpts = {
  stored: readonly StoredPrice[];
  /** Dollar figures the agent read from the client's own data (revenue, wins): fine in a handoff's text */
  dataFigures?: readonly number[];
  client: string | null;
  preparedBy: string;
};

/**
 * The document as the agent wrote it, made strict: limits on every part (so each table and list fits the page),
 * prices guarded, dashes out. The placeholders it had to use are listed for the agent to mention.
 */
export function cleanDocument(raw: unknown, opts: CleanOpts): { doc: DocContent; placeholders: string[] } {
  const r = rec(raw);
  const kind: DocKind = isDocKind(r.kind) ? r.kind : "one_pager";
  // Scope of Work and proposal text may not carry prices of its own; a handoff may quote the client's own results
  const allowed = [...opts.stored.map((p) => p.amount), ...(kind === "handoff" || kind === "one_pager" ? (opts.dataFigures ?? []) : [])];
  let scrubbed = 0;
  const safe = (s: string) => {
    const x = scrubPrices(s, allowed);
    scrubbed += x.scrubbed;
    return x.text;
  };
  const sections = (Array.isArray(r.sections) ? r.sections : [])
    .map((s) => rec(s))
    .map((s) => ({ heading: line(s.heading ?? s.title, 70), body: safe(para(s.body ?? s.text, 1400)), bullets: list(s.bullets, 10, 220).map(safe) }))
    .filter((s) => s.heading || s.body || s.bullets.length)
    .slice(0, 12);
  const pricing = (Array.isArray(r.pricing) ? r.pricing : [])
    .map((p) => guardPrice(rec(p), opts.stored))
    .filter((p): p is DocPrice => Boolean(p))
    .slice(0, 10);
  const doc: DocContent = {
    kind,
    title: line(r.title, 90) || DOC_LABEL[kind],
    subtitle: safe(line(r.subtitle, 160)),
    client: opts.client,
    period: line(r.period, 60),
    summary: safe(para(r.summary, 1200)),
    stats: (Array.isArray(r.stats) ? r.stats : [])
      .map((s) => rec(s))
      .map((s) => ({ value: line(s.value, 14), label: line(s.label, 40), note: line(s.note, 90) }))
      .filter((s) => s.value && s.label)
      .slice(0, 4),
    sections,
    deliverables: (Array.isArray(r.deliverables) ? r.deliverables : [])
      .map((d) => rec(d))
      .map((d) => ({ item: line(d.item ?? d.name, 70), detail: safe(line(d.detail, 200)), qty: line(d.qty ?? d.quantity, 24) }))
      .filter((d) => d.item)
      .slice(0, 16),
    cadence: (Array.isArray(r.cadence) ? r.cadence : [])
      .map((c) => rec(c))
      .map((c) => ({ what: line(c.what ?? c.item, 80), when: line(c.when ?? c.frequency, 60) }))
      .filter((c) => c.what && c.when)
      .slice(0, 10),
    pricing,
    inclusions: list(r.inclusions, 14, 180).map(safe),
    exclusions: list(r.exclusions, 14, 180).map(safe),
    nextSteps: list(r.next_steps ?? r.nextSteps, 8, 200).map(safe),
    preparedBy: line(opts.preparedBy, 80),
  };
  const placeholders = [...pricing.filter((p) => p.placeholder).map((p) => p.item), ...(scrubbed ? [`${scrubbed} price${scrubbed === 1 ? "" : "s"} in the text`] : [])];
  return { doc, placeholders };
}

/** Whether a document has anything to show beyond its title */
export const hasBody = (d: DocContent) => Boolean(d.summary || d.sections.length || d.deliverables.length || d.stats.length || d.pricing.length || d.inclusions.length || d.nextSteps.length);

/** A file name people can read: "Kaizen - Sierra Dreams - Scope of Work.pdf" */
export function docFileName(d: Pick<DocContent, "kind" | "title" | "client">): string {
  const safe = (s: string) =>
    s
      .replace(/[^\p{L}\p{N} &'().]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
  const title = safe(d.title) || DOC_LABEL[d.kind];
  const client = d.client ? safe(d.client) : "";
  return `${["Kaizen", client && !title.toLowerCase().includes(client.toLowerCase()) ? client : "", title].filter(Boolean).join(" - ")}.pdf`;
}

/** The document as plain text (kept with the client's documents, for the AI to read later) */
export function plainText(d: DocContent): string {
  const out: string[] = [`${DOC_LABEL[d.kind]}: ${d.title}`];
  if (d.client) out.push(`Client: ${d.client}`);
  if (d.period) out.push(d.period);
  if (d.subtitle) out.push(d.subtitle);
  if (d.summary) out.push("", d.summary);
  if (d.stats.length) out.push("", ...d.stats.map((s) => `${s.label}: ${s.value}${s.note ? ` (${s.note})` : ""}`));
  for (const s of d.sections) out.push("", s.heading, ...(s.body ? [s.body] : []), ...s.bullets.map((b) => `- ${b}`));
  if (d.deliverables.length) out.push("", "Deliverables", ...d.deliverables.map((x) => `- ${x.item}${x.qty ? ` (${x.qty})` : ""}${x.detail ? `: ${x.detail}` : ""}`));
  if (d.cadence.length) out.push("", "Cadence", ...d.cadence.map((c) => `- ${c.what}: ${c.when}`));
  if (d.pricing.length) out.push("", "Investment", ...d.pricing.map((p) => `- ${p.item}: ${p.price}${p.cadence ? ` ${p.cadence}` : ""}`));
  if (d.inclusions.length) out.push("", "Included", ...d.inclusions.map((x) => `- ${x}`));
  if (d.exclusions.length) out.push("", "Not included", ...d.exclusions.map((x) => `- ${x}`));
  if (d.nextSteps.length) out.push("", "Next steps", ...d.nextSteps.map((x) => `- ${x}`));
  return out.join("\n").slice(0, 20000);
}

/** The editable text of a document (the card's Edit), back into the shape cleanDocument takes */
export function toLoose(d: DocContent): Record<string, unknown> {
  return {
    kind: d.kind,
    title: d.title,
    subtitle: d.subtitle,
    period: d.period,
    summary: d.summary,
    stats: d.stats,
    sections: d.sections,
    deliverables: d.deliverables,
    cadence: d.cadence,
    // A placeholder stays a placeholder; a stored price is given back as its amount so it's matched again
    pricing: d.pricing.map((p) => ({ item: p.item, price: p.placeholder ? null : p.price, cadence: p.cadence, note: p.note })),
    inclusions: d.inclusions,
    exclusions: d.exclusions,
    next_steps: d.nextSteps,
  };
}

// ─── Package knowledge ──────────────────────────────────────────────────────

export type KnowledgeItem = { title: string; body: string };

const TIER_WORDS = /\b(sprint|basic|silver|gold|mvp|package|retainer|tier)s?\b/i;

/**
 * The Email Strategist's knowledge about Kaizen's packages: items about sprint packages and the tiers, the one asked
 * for first. Each body is kept whole up to a limit so flows, campaigns a month, SMS, reporting, inclusions and
 * exclusions come through as written.
 */
export function packageKnowledge(items: readonly KnowledgeItem[], tier: string | null, max = 6): KnowledgeItem[] {
  const t = (tier ?? "").toLowerCase().trim();
  const scored = items
    .filter((k) => TIER_WORDS.test(k.title) || TIER_WORDS.test(k.body.slice(0, 600)))
    .map((k) => {
      const title = k.title.toLowerCase();
      let score = /package|tier|sprint/.test(title) ? 2 : 1;
      if (t && title.includes(t)) score += 5;
      else if (t && k.body.toLowerCase().includes(t)) score += 2;
      return { k, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map(({ k }) => ({ title: k.title, body: k.body.length > 5000 ? `${k.body.slice(0, 5000)}…` : k.body }));
}

/** The prices that are stored for a service: the package records' and what Stripe bills this client for it */
export function storedPrices(tiers: readonly { label: string; price_monthly: number | null; price_one_time: number | null }[], billed: { amount: number } | null | undefined, serviceLabel: string): StoredPrice[] {
  const out: StoredPrice[] = [];
  for (const t of tiers) {
    if (t.price_monthly != null && Number(t.price_monthly) > 0) out.push({ label: t.label, amount: Number(t.price_monthly), cadence: "month", source: "package" });
    if (t.price_one_time != null && Number(t.price_one_time) > 0) out.push({ label: t.label, amount: Number(t.price_one_time), cadence: "one_time", source: "package" });
  }
  if (billed && Number(billed.amount) > 0) out.push({ label: `${serviceLabel} (current billing)`, amount: Number(billed.amount), cadence: "month", source: "stripe" });
  return out;
}
