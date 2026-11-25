// The Sales agent's go-to-market strategy: the plain parts (no server imports; tested in tests/sales-gtm.test.ts).
// The client-facing document follows the gold-standard structure the CEO's Proposal Builder produced (cover, 01 exec
// summary with three stat tiles, 02 who they are, 03 digital footprint leaks, 04 market + competitive landscape,
// 05 positioning & offer, 06 channel plan, 07 investment tiers + projections + benchmarks + "the math that matters",
// 08 90-day plan + 12-month calendar, 09 measurement + next steps, sources). The internal talking notes are never sent:
// flags, strategy decisions, numbers caveats, risks and objections (with the vertical's compliance rules), firm facts,
// every claim tagged [certain] / [likely] / [guessing, informed].

export type Row = string[];
export type Table = { head: string[]; rows: Row[]; note?: string };
export type Stat = { value: string; label: string };

export type GtmContent = {
  cover: { short: string; eyebrow: string; headline: string; highlight: string; subtitle: string; location: string; site: string; date: string };
  exec: { lede: string; stats: Stat[]; opportunity: string; recommend: { lead: string; text: string }[]; why_now: string };
  who: { title: string; lede: string; table: Table; sources: string };
  footprint: { title: string; lede: string; table: Table; bottom_line: string };
  market: { title: string; lede: string; stats: Stat[]; avatar: string; tam: string; implications: { lead: string; text: string }[]; competitors: Table; trends: Table; sources: string };
  positioning: { title: string; lede: string; services: Table; core: string; offer: { name: string; text: string; why: string }; pillars: { lead: string; text: string }[] };
  channels: { title: string; lede: string; google: Table; google_note: string; meta: Table; creative: { title: string; text: string } };
  investment: { title: string; lede: string; tiers: Table; assumptions: string; benchmarks: Table; benchmarks_note: string; math: string };
  plan: { title: string; ninety: Table; calendar: Table };
  measure: { title: string; table: Table; note: string; needs: string[]; next: { lead: string; text: string }[]; one_line: string };
  sources: string[];
};

export type Claim = { text: string; tag: "certain" | "likely" | "guessing" };
export type GtmNotes = { headline: string; competitors: Claim[]; flags: Claim[]; decisions: Claim[]; caveats: Claim[]; risks: Claim[]; facts: Claim[]; partner_label: string | null };

/** Text that went through a Latin-1 round trip ("Days 1-14 Â·", "â€“"): the characters put back */
export function demojibake(t: string): string {
  if (!/[ÂÃâ]/.test(t)) return t;
  return t
    .replace(/â€“/g, "–")
    .replace(/â€”/g, "—")
    .replace(/â€™/g, "’")
    .replace(/â€˜/g, "‘")
    .replace(/â€œ/g, "“")
    .replace(/â€\u009d/g, "”")
    .replace(/â€¦/g, "…")
    .replace(/â€¢/g, "•")
    .replace(/Â([\u00a0-\u00bf])/g, "$1");
}
/** Text kept to a length, never cut mid-sentence: over the limit, it ends at the last full sentence (or word, with "…") */
export function fit(t: string, n: number): string {
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.endsWith(".") ? n - 1 : -1);
  return end >= n * 0.5 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, "").replace(/[,;:\s]+$/, "")}…`;
}
/** "$0.00-$0.00" is Keyword Planner returning no bid estimate, never a free click */
const noZeroBids = (t: string) => t.replace(/\$0\.00\s*[-–]\s*\$0\.00/g, "No bid data");
const s = (v: unknown, n = 1200) => fit(noZeroBids(demojibake(String(v ?? "")).replace(/\s+/g, " ").trim()), n);
const list = (v: unknown, n = 10, len = 600) => (Array.isArray(v) ? v.map((x) => s(x, len)).filter(Boolean).slice(0, n) : []);
const table = (v: unknown, maxRows = 10): Table => {
  const t = (v ?? {}) as Record<string, unknown>;
  // Kept as given, empty cells too (a tier table's first head cell is the row labels' column)
  const head0 = Array.isArray(t.head) ? t.head.slice(0, 6).map((x) => s(x, 60)) : [];
  const head = head0.some(Boolean) ? head0 : [];
  const rows = (Array.isArray(t.rows) ? t.rows : []).slice(0, maxRows).map((r) => (Array.isArray(r) ? r.slice(0, Math.max(1, head.length || 6)).map((c) => s(c, 400)) : [])).filter((r) => r.some(Boolean));
  return { head, rows, ...(t.note ? { note: s(t.note, 500) } : {}) };
};
const stats = (v: unknown): Stat[] =>
  (Array.isArray(v) ? v : [])
    .slice(0, 3)
    .map((x) => ({ value: s((x as Stat)?.value, 24), label: s((x as Stat)?.label, 140) }))
    .filter((x) => x.value);
const leads = (v: unknown, n = 6) =>
  (Array.isArray(v) ? v : [])
    .slice(0, n)
    .map((x) => ({ lead: s((x as { lead?: unknown })?.lead, 80), text: s((x as { text?: unknown })?.text, 500) }))
    .filter((x) => x.text);

/** The model's document, made safe to keep and draw */
export function cleanGtm(raw: unknown): GtmContent {
  const r = (raw ?? {}) as Record<string, Record<string, unknown>>;
  const c = r.cover ?? {};
  const e = r.exec ?? {};
  const w = r.who ?? {};
  const f = r.footprint ?? {};
  const m = r.market ?? {};
  const p = r.positioning ?? {};
  const ch = r.channels ?? {};
  const i = r.investment ?? {};
  const pl = r.plan ?? {};
  const me = r.measure ?? {};
  const offer = (p.offer ?? {}) as Record<string, unknown>;
  const creative = (ch.creative ?? {}) as Record<string, unknown>;
  return {
    cover: { short: s(c.short, 30), eyebrow: s(c.eyebrow, 80) || "Go-to-market strategy · Paid media overview", headline: s(c.headline, 120), highlight: s(c.highlight, 80), subtitle: s(c.subtitle, 160), location: s(c.location, 120), site: s(c.site, 120), date: s(c.date, 40) },
    exec: { lede: s(e.lede, 1400), stats: stats(e.stats), opportunity: s(e.opportunity, 1800), recommend: leads(e.recommend, 5), why_now: s(e.why_now, 700) },
    who: { title: s(w.title, 90), lede: s(w.lede, 800), table: table(w.table, 8), sources: s(w.sources, 800) },
    footprint: { title: s(f.title, 90), lede: s(f.lede, 800), table: table(f.table, 10), bottom_line: s(f.bottom_line, 600) },
    market: { title: s(m.title, 110), lede: s(m.lede, 800), stats: stats(m.stats), avatar: s(m.avatar, 1800), tam: s(m.tam, 1200), implications: leads(m.implications, 4), competitors: table(m.competitors, 6), trends: table(m.trends, 8), sources: s(m.sources, 1200) },
    positioning: { title: s(p.title, 90), lede: s(p.lede, 800), services: table(p.services, 6), core: s(p.core, 1200), offer: { name: s(offer.name, 80), text: s(offer.text, 1000), why: s(offer.why, 600) }, pillars: leads(p.pillars, 5) },
    channels: { title: s(ch.title, 90), lede: s(ch.lede, 800), google: table(ch.google, 6), google_note: s(ch.google_note, 400), meta: table(ch.meta, 5), creative: { title: s(creative.title, 80) || "Creative package", text: s(creative.text, 1400) } },
    investment: { title: s(i.title, 90), lede: s(i.lede, 800), tiers: table(i.tiers, 9), assumptions: s(i.assumptions, 1400), benchmarks: table(i.benchmarks, 6), benchmarks_note: s(i.benchmarks_note, 500), math: s(i.math, 1200) },
    plan: { title: s(pl.title, 90), ninety: table(pl.ninety, 4), calendar: table(pl.calendar, 8) },
    measure: { title: s(me.title, 90), table: table(me.table, 4), note: s(me.note, 600), needs: list(me.needs, 8, 200), next: leads(me.next, 5), one_line: s(me.one_line, 400) },
    sources: list((raw as { sources?: unknown } | null)?.sources, 30, 300),
  };
}

const TAGS = { certain: "certain", likely: "likely", guessing: "guessing" } as const;
const claims = (v: unknown, n = 12): Claim[] =>
  (Array.isArray(v) ? v : [])
    .slice(0, n)
    .map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const tag = String(o.tag ?? "").toLowerCase();
      return { text: s(o.text, 1200), tag: tag.startsWith("cert") ? TAGS.certain : tag.startsWith("lik") ? TAGS.likely : TAGS.guessing };
    })
    .filter((x) => x.text);

export function cleanNotes(raw: unknown, partnerLabel: string | null = null): GtmNotes {
  const r = (raw ?? {}) as Record<string, unknown>;
  return { headline: s(r.headline, 600), competitors: claims(r.competitors, 8), flags: claims(r.flags), decisions: claims(r.decisions), caveats: claims(r.caveats), risks: claims(r.risks), facts: claims(r.facts, 16), partner_label: partnerLabel };
}

export const TAG_LABEL: Record<Claim["tag"], string> = { certain: "[certain]", likely: "[likely]", guessing: "[guessing, informed]" };

/** The notes as plain text (the agent reads them; copy-paste for the call) */
export function notesText(name: string, n: GtmNotes): string {
  const sec = (title: string, xs: Claim[]) => (xs.length ? `${title}\n${xs.map((x) => `- ${x.text} ${TAG_LABEL[x.tag]}`).join("\n")}` : "");
  return [n.partner_label ? `Internal · for ${n.partner_label} only · do not share with ${name}` : `Internal talking notes · ${name} · never sent`, n.headline, sec("Competitor ads", n.competitors ?? []), sec("Flags", n.flags), sec("Strategy decisions", n.decisions), sec("Numbers caveats", n.caveats), sec("Risks and objections", n.risks), sec("Firm facts", n.facts)].filter(Boolean).join("\n\n");
}

// ─── The strategy rules (the CEO's) ─────────────────────────────────────────

/** The Basic creative package: the "310", 3 images + 10 videos a month */
export const BASIC_CREATIVE = { images: 3, videos: 10, label: 'Basic creative, the "310": 3 images + 10 videos a month' };

export type Vertical = "ecommerce" | "local" | "lead_gen" | "professional";

/** The kind of business, from its industry words */
export function verticalOf(industry: string | null | undefined, sells?: string | null): Vertical {
  const t = `${industry ?? ""} ${sells ?? ""}`.toLowerCase();
  if (/\b(e-?com\w*|dtc|shopify|online store|apparel|skincare|supplement|coffee brand|products? (?:sold|shipped) online|direct[- ]to[- ]consumer)\b/.test(t)) return "ecommerce";
  if (/\b(cpa|accounting|accountant|law|legal|attorney|dental|dentist|medical|clinic|med ?spa|financ\w*|insurance|wealth|advisor|consult\w*|b2b)\b/.test(t)) return "professional";
  if (/\b(restaurant|cafe|bar|pizza|salon|gym|studio|retail|hospitality|hotel|bakery|franchise)\b/.test(t)) return "local";
  return "lead_gen";
}

/** What leads the strategy for that kind of business, and the add-ons further down */
export const VERTICAL_FOCUS: Record<Vertical, { lead: string[]; addons: string[] }> = {
  ecommerce: { lead: ["CRO", "Creative development", "Meta advertising", "Email marketing"], addons: ["Google advertising", "TikTok ads", "Landing pages", "Influencer campaigns", "PR", "SEO"] },
  local: { lead: ["Google advertising (local + Maps)", "Meta advertising", "Creative development", "Reviews"], addons: ["Email marketing", "TikTok ads", "Organic social", "Landing pages"] },
  lead_gen: { lead: ["Google advertising", "Meta advertising", "Creative development", "Landing pages + CRM"], addons: ["Email marketing", "YouTube", "SEO", "Organic social"] },
  professional: { lead: ["Google advertising (high-intent search)", "Meta advertising", "Landing pages + booking", "CRM follow-up"], addons: ["Email nurture", "YouTube", "SEO", "Reviews"] },
};

/** The three tiers the CEO wants on every strategy */
export function tierPlan(v: Vertical): { name: string; services: string[] }[] {
  if (v === "ecommerce")
    return [
      { name: "Tier 1 · Minimal", services: ["Meta advertising", BASIC_CREATIVE.label] },
      { name: "Tier 2 · MVP", services: ["Meta advertising", "Creative development (Silver)", "Email marketing", "CRO / landing pages"] },
      { name: "Tier 3 · Elite", services: ["On-site photo and video", "Meta advertising", "Google advertising", "Email + SMS", "Creative development (Gold)", "CRM / CRO"] },
    ];
  return [
    { name: "Tier 1 · Minimal", services: ["Google advertising"] },
    { name: "Tier 2 · MVP", services: ["Google advertising", "Meta advertising", `${BASIC_CREATIVE.label} (attached to Meta)`] },
    { name: "Tier 3 · Elite", services: ["On-site photo and video", "Meta advertising", "Google advertising", "Email marketing", "CRM build or optimization"] },
  ];
}

export type CaseStudy = { key: string; name: string; vertical: string; fits: string[]; services: string; results: string; connection: string };

/** The case study that fits the prospect best (by its industry words), then the rest in their order */
export function pickCaseStudies(industry: string | null | undefined, studies: readonly CaseStudy[], vertical?: Vertical): CaseStudy[] {
  const t = ` ${String(industry ?? "").toLowerCase()} `;
  const score = (c: CaseStudy) => c.fits.reduce((n, f) => n + (t.includes(f.toLowerCase()) ? f.length : 0), 0) + (vertical === "ecommerce" && c.key === "aldecoa" ? 5 : 0) + (vertical === "professional" && c.key === "marquee" ? 5 : 0) + (vertical === "local" && c.key === "gumbys" ? 5 : 0);
  return [...studies].sort((a, b) => score(b) - score(a));
}

export type Partner = { key: string; name: string; prepared_by: string; brand: Record<string, string>; rules: string; show_fees: boolean; contact?: { name?: string; role?: string; email?: string } | null; pitcher?: string | null; pitcher_title?: string | null; website?: string | null; kit_confirmed_at?: string | null };

/** Whether a prospect's site or research credits a partner ("Powered by ZenChange", forms on links.zenchange.com) */
export function partnerCredited(text: string, p: { key: string; name: string; website?: string | null }): boolean {
  const t = text.toLowerCase();
  const name = p.name.toLowerCase();
  const host = String(p.website ?? "").replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase();
  const squash = (x: string) => x.replace(/[^a-z0-9]/g, "");
  return (
    new RegExp(`(?:powered by|built by|designed by|website by|site by|managed by)\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(t) ||
    (Boolean(host) && t.includes(host)) ||
    (squash(name).length >= 5 && /powered by|built by|website by/.test(t) && squash(t).includes(`poweredby${squash(name)}`))
  );
}

/** What the agent asks when a prospect's record doesn't say (once) */
export const RELATIONSHIP_QUESTION = "Is this a direct Kaizen deal or a white-label pitch for a partner agency?";

/** The mode label shown on the prospect sheet and beside the PDF, so nobody sends the wrong brand */
export const modeLabel = (relationship: string | null | undefined, partner: string | null | undefined) => (relationship === "white_label" ? `White label · ${partner ?? "partner"}` : relationship === "direct" ? "Direct · Kaizen branding" : "Branding not set");

/** Every place a white-label document still says Kaizen (it must say none) */
export function kaizenMentions(v: unknown): string[] {
  const out: string[] = [];
  const walk = (x: unknown, at: string) => {
    if (typeof x === "string") {
      if (/kaizen|1% agency|get 1% better/i.test(x)) out.push(at);
    } else if (Array.isArray(x)) x.forEach((y, i) => walk(y, `${at}[${i}]`));
    else if (x && typeof x === "object") for (const [k, y] of Object.entries(x)) walk(y, at ? `${at}.${k}` : k);
  };
  walk(v, "");
  return out;
}

/** White-label: any stray mention replaced with the partner's name (after the model was told not to; belt and braces) */
export function scrubKaizen<T>(v: T, partner: string): T {
  const fix = (x: unknown): unknown =>
    typeof x === "string" ? x.replace(/kaizen marketing/gi, partner).replace(/\bkaizen\b/gi, partner).replace(/the 1% agency/gi, partner) : Array.isArray(x) ? x.map(fix) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, fix(y)])) : x;
  return fix(v) as T;
}

/** Fees in a document that shouldn't show them (a partner that shows ad spend only) */
export function feeMentions(c: GtmContent): string[] {
  const t = JSON.stringify([c.investment, c.channels, c.exec]).toLowerCase();
  return ["management fee", "/mo management", "retainer", "our fee", "agency fee"].filter((w) => t.includes(w));
}

export const GTM_FILE = (name: string, partner: string | null) => `${name.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 60)} — Go-To-Market Strategy${partner ? "" : " — Kaizen"}.pdf`;

/** A guess at the short name ("De La Hoz, Perez & Barbeito, PLLC" → "HPB"); the writer gives the one the business uses (DPB) */
export function shortName(name: string): string {
  const clean = name.replace(/,?\s+(llc|pllc|inc\.?|corp\.?|co\.?|ltd\.?|p\.?a\.?|pc)$/i, "").trim();
  if (clean.length <= 18) return clean;
  const words = clean.split(/[\s,&-]+/).filter((w) => /^[A-Za-z]/.test(w) && !/^(and|of|the|de|la|del|y)$/i.test(w));
  return words.length >= 2 && words.length <= 5 ? words.map((w) => w[0].toUpperCase()).join("") : clean.split(/\s+/).slice(0, 2).join(" ");
}

