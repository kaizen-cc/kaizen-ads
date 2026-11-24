// Kaizen's document system: every client-facing document the assistant or Kaizen AI makes, as a Google file in the
// house style. Three templates are Kaizen's own documents, kept as section schemas the AI fills (never free prose):
//   proposal: a sales proposal deck, Google Slides (the Aesthetic Edge relaunch proposal)
//   quote:    a project quote for a one-time build, Google Doc (the Michelle Behre website quote)
//   sow:      a Scope of Work for a retainer, sprint or tier options, Google Doc (the Angry Chickz SOW)
// plus two open shapes in the same looks: doc (plans, audits, client briefs, case studies: the SOW look) and deck (the
// proposal look). A price is only one from Kaizen's rate card, the email packages, or one the person confirmed in the
// conversation (relationship pricing); anything else is drawn as [Price to confirm]. Pure: no keys, no network.

export const TEMPLATE_KEYS = ["proposal", "quote", "sow", "doc", "deck"] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];
export const isTemplate = (v: unknown): v is TemplateKey => (TEMPLATE_KEYS as readonly string[]).includes(String(v));

export const PRICE_TBD = "[Price to confirm]";

/** What a section holds: the AI's guide for it */
export type SectionDef = { key: string; heading: string; guide: string; optional?: boolean };
export type Template = { key: TemplateKey; label: string; output: "doc" | "slides"; look: "sow" | "quote" | "deck"; restricted: boolean; purpose: string; sections: SectionDef[] };

const T = (key: TemplateKey, label: string, output: Template["output"], look: Template["look"], restricted: boolean, purpose: string, sections: SectionDef[]): Template => ({ key, label, output, look, restricted, purpose, sections });

export const TEMPLATES: Record<TemplateKey, Template> = {
  proposal: T("proposal", "Sales proposal", "slides", "deck", true, "Pitching a prospect or client on new work: what we heard, what we propose, the plan, the investment.", [
    { key: "executive_summary", heading: "Executive Summary", guide: "lede: two sentences on the situation and the promise. stats: exactly 4 big tiles (a day or week milestone, a one-time investment, a monthly fee...). columns: two, 'What we heard' (4 bullets) and 'What we are proposing' (4 to 5 bullets)." },
    { key: "situation", heading: "The Situation and What It Means", guide: "lede: one sentence. table: Reality | What it means | How we handle it, 4 to 6 rows." },
    { key: "scope", heading: "Scope of Work", guide: "lede: 'N workstreams, one team, one point of contact.' table: Workstream | What is included | Type (One-time or Monthly), numbered workstreams." },
    { key: "timeline", heading: "Launch Timeline", guide: "lede: why the sequence. table: Phase | Window | Kaizen delivers | We need from you." },
    { key: "strategy", heading: "Go-to-Market Strategy", guide: "lede: the core idea. columns: two or three, each a red subhead (Offer architecture, Campaign structure, Creative approach) with 3 to 5 bullets." },
    { key: "planning_model", heading: "90-Day Planning Model", guide: "lede: what the budget should produce, planning ranges not guarantees. bullets: the assumptions. table: spend levels against leads, consults, sales, revenue. callout: what this means.", optional: true },
    { key: "why_kaizen", heading: "Why Kaizen", guide: "lede: one sentence. columns: two or three proof points (red subhead + a short paragraph), then bullets 'How Kaizen operates' (you own every asset, no ad spend markup, no long contracts)." },
    { key: "needs", heading: "What We Need From You", guide: "lede: short on purpose. columns: groups (content, access and information, approvals), each with bullets." },
    { key: "investment", heading: "Investment", guide: "lede: 'Relationship pricing, as discussed.' when prices were confirmed in conversation, else how the fees split. tables: One-time build (Scope | Investment) with a Total row; Monthly management (Scope | Investment) with a Total row; Media budget when ads (paid directly to the platform). paragraph: Month 1 total and months 2 onward." },
    { key: "terms", heading: "Engagement Terms", guide: "lede: simple terms. table: Term | Detail (pilot period, notice to cancel, payment schedule, monthly billing, ownership, revisions, out of scope add-ons)." },
    { key: "pilot", heading: "Included Pilot", guide: "Only when something is included at no charge: what it is, what you can ask it, what it is not yet, how the pilot works.", optional: true },
    { key: "next_steps", heading: "Next Steps", guide: "lede: how many steps and which can happen this week. table: Step | Owner | Target, numbered steps." },
  ]),
  quote: T("quote", "Project quote", "doc", "quote", true, "A one-time build (a website, a setup, a migration): what we build, how, when, and what it costs.", [
    { key: "description", heading: "Description", guide: "Two short paragraphs: what the project is and what moves over or is built." },
    { key: "context_goals", heading: "Project Context & Goals", guide: "keyvalue rows: Where you are today, Main goal, Growth focus, Your priority. Then a subheading 'Success KPI' and 1 to 3 bullets." },
    { key: "why_recommend", heading: "Why We Recommend This", guide: "One paragraph, then bullets with a bold lead (Speed:, Control:, SEO:)." },
    { key: "how_built", heading: "How It's Built", guide: "Paragraph on the build approach, then keyvalue rows of the stack or parts." },
    { key: "what_you_edit", heading: "What You Can Edit", guide: "Bullets of what the client edits on their own, plus one line on what Kaizen handles." },
    { key: "process", heading: "Implementation Process", guide: "steps: numbered steps each with a short title and one sentence (Discovery, Design, Build, Content, SEO & Redirects, Hosting, Launch & Training)." },
    { key: "timeline", heading: "Estimated Timeline", guide: "gantt rows: task with start and end week numbers (1-based), across 4 to 10 weeks. Then one sentence on what moves the dates." },
    { key: "included", heading: "Included Services", guide: "Bullets with a bold lead of everything included." },
    { key: "not_included", heading: "What's NOT Included", guide: "One line, then bullets of what's out of scope unless quoted separately." },
    { key: "dependencies", heading: "Client Dependencies", guide: "One line, then table: Item | Detail | Due." },
    { key: "monthly_costs", heading: "Monthly Costs After Launch", guide: "table: Item | Who pays | Monthly cost (hosting, platform, domain...). Costs paid to others are theirs to confirm." },
    { key: "cost_summary", heading: "Cost Summary", guide: "table: Item | Cost, then a total block (TOTAL INVESTMENT and the amount)." },
    { key: "move_forward", heading: "How Do We Move Forward", guide: "steps: approve, deposit, kickoff... Then subheading 'Important notes' with bullets." },
    { key: "terms", heading: "Terms & Conditions", guide: "Bullets: payment schedule, revisions, ownership, validity (30 days), cancellation." },
  ]),
  sow: T("sow", "Scope of Work", "doc", "sow", true, "A retainer, a sprint or tier options: the engagement, where the client is, the plan, the tiers, what success looks like.", [
    { key: "overview", heading: "Engagement Overview", guide: "Two paragraphs on the engagement. callout: anything gifted or a special offer, else leave out." },
    { key: "at_a_glance", heading: "Engagement at a Glance", guide: "table: Item | Detail (engagement, length, investment, start, team, reporting)." },
    { key: "today", heading: "Where {client} Is Today", guide: "Paragraph, then table: Area | Current State from their own data (platform, list, flows, deliverability, team...)." },
    { key: "goals", heading: "Goals for This Engagement", guide: "Bullets with a bold lead, 3 to 5." },
    { key: "month_one", heading: "Month 1", guide: "When there are options: heading 'Month 1: The Sprint (Choose One Option)', a paragraph, subheading 'Included in Both Options' with bullets, subheading per option with bullets, then a side-by-side table. Otherwise what month 1 delivers." },
    { key: "phases", heading: "The Plan", guide: "One or more phases: subheadings with bullets (warming plan, build phases).", optional: true },
    { key: "integrations", heading: "Integrations and Data", guide: "Bullets with a bold lead.", optional: true },
    { key: "ninety_days", heading: "The Full 90 Days", guide: "table: Month | Focus | Deliverables." },
    { key: "tiers", heading: "Ongoing Management Tiers", guide: "A paragraph; the tier table is drawn from Kaizen's packages when the line has them (email), else table: Included | tiers." },
    { key: "success", heading: "What Success Looks Like", guide: "table: Milestone | Target | Why It Matters. callout: how we measure it." },
    { key: "out_of_scope", heading: "Out of Scope", guide: "Bullets." },
    { key: "needs", heading: "What Kaizen Needs to Get Started", guide: "Bullets with a bold lead (access, approvals, assets)." },
    { key: "timeline", heading: "Timeline", guide: "table: Week | What happens." },
    { key: "next_step", heading: "Next Step", guide: "One paragraph and 2 to 3 bullets." },
  ]),
  doc: T("doc", "Kaizen document", "doc", "sow", false, "Any other client-facing document (a plan, an audit, a client brief, a recap, a case study) in the Scope of Work look.", []),
  deck: T("deck", "Kaizen deck", "slides", "deck", false, "Any other client-facing deck in the proposal look (a plan, a pitch to an existing client, a case study).", []),
};

/** Proposals, quotes and SOWs are made by the executives and the line heads; anyone can make the open doc and deck */
export function mayMake(t: TemplateKey, me: { isExec: boolean; isLead: boolean; role: string }): boolean {
  return !TEMPLATES[t].restricted || me.isExec || me.isLead || me.role.startsWith("head_of");
}

/**
 * The template an ask means: a pitch or proposal → the proposal deck; a one-time build (website, landing page, setup,
 * migration) quoted → the quote; a retainer, sprint, tiers or a Scope of Work → the SOW. Null when it isn't clear.
 */
export function pickTemplate(ask: string): TemplateKey | null {
  const a = ask.toLowerCase();
  if (/\b(sow|scope of work|retainer|sprint|tiers?|ongoing management|monthly management)\b/.test(a)) return "sow";
  if (/\b(quote|estimate)\b/.test(a) || (/\b(website|web ?site|landing page|site build|migration|one[- ]time build|rebuild)\b/.test(a) && !/\bproposal|pitch|deck\b/.test(a))) return "quote";
  if (/\b(proposal|pitch|relaunch|growth plan for a prospect)\b/.test(a)) return "proposal";
  if (/\b(deck|slides|presentation)\b/.test(a)) return "deck";
  if (/\b(plan|audit|brief|recap|case study|one[- ]pager|summary|report|handoff)\b/.test(a)) return "doc";
  return null;
}

// ─── The document as the AI writes it ───────────────────────────────────────

export type Item = { lead: string; text: string };
export type Block =
  | { type: "paragraph"; text: string }
  | { type: "subheading"; text: string }
  | { type: "bullets"; items: Item[] }
  | { type: "stats"; items: { value: string; label: string }[] }
  | { type: "table"; head: string[]; rows: string[][]; total: string[] | null }
  | { type: "keyvalue"; rows: { label: string; value: string }[] }
  | { type: "columns"; columns: { heading: string; text: string; items: Item[] }[] }
  | { type: "callout"; text: string }
  | { type: "steps"; items: Item[] }
  | { type: "gantt"; weeks: number; rows: { task: string; start: number; end: number }[] }
  | { type: "total"; label: string; value: string };

export type KSection = { key: string; heading: string; lede: string; blocks: Block[] };

export type KDoc = {
  template: TemplateKey;
  title: string;
  subtitle: string;
  /** The client's or prospect's name ("Kaizen x <client>"); null for an internal document */
  client: string | null;
  preparedFor: string;
  preparedBy: string;
  dated: string;
  /** "Scope of Work | 1-Month Klaviyo Sprint + 90-Day Roadmap", "Web Development Proposal" */
  kicker: string;
  sections: KSection[];
  /** The bracketed spots still to fill */
  placeholders: string[];
  relationshipPricing: boolean;
};

/** The JSON the AI answers in: one flat block shape (unused fields empty) so every model fills it the same way */
export const KDOC_SCHEMA: Record<string, unknown> = (() => {
  const str = { type: "string" };
  const strs = { type: "array", items: str };
  const item = { type: "object", properties: { lead: str, text: str }, required: ["lead", "text"], additionalProperties: false };
  const obj = (p: Record<string, unknown>) => ({ type: "object", properties: p, required: Object.keys(p), additionalProperties: false });
  const block = obj({
    type: { type: "string", enum: ["paragraph", "subheading", "bullets", "stats", "table", "keyvalue", "columns", "callout", "steps", "gantt", "total"] },
    text: str,
    items: { type: "array", items: item },
    head: strs,
    rows: { type: "array", items: strs },
    total: { anyOf: [{ type: "null" }, strs] },
    columns: { type: "array", items: obj({ heading: str, text: str, items: { type: "array", items: item } }) },
    weeks: { type: "integer" },
  });
  return obj({
    title: str,
    subtitle: str,
    kicker: str,
    prepared_for: str,
    sections: { type: "array", items: obj({ key: str, heading: str, lede: str, blocks: { type: "array", items: block } }) },
  });
})();

/** How each block is filled, for the AI */
export const BLOCK_GUIDE = `Blocks (one flat shape: fill the fields the type uses, leave the rest "" / [] / null / 0):
- paragraph: text. subheading: text (a red subhead). callout: text (a grey box with a red bar; start with a few words and a colon, "How we measure it: ...").
- bullets: items (lead = a few bold words ending in a period or colon, or ""; text).
- steps: items (numbered: lead = the step's short title, text = one sentence).
- stats: items (lead = the big value "Day 10", "$7,000", "Week 6"; text = the label under it). Up to 4.
- table: head (column names), rows (each as wide as head), total (a bold last row, or null).
- keyvalue: rows as items (lead = label, text = value).
- columns: columns (heading = a red subhead; text = a short paragraph or ""; items = bullets).
- gantt: weeks (how many), rows as items (lead = task, text = "start-end" week numbers, e.g. "1-2").
- total: items[0] (lead = "TOTAL INVESTMENT", text = the amount).`;

// ─── Clean-up ───────────────────────────────────────────────────────────────

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** Plain text: no em or en dashes (ranges read "to"), one line */
export function clean(v: unknown, n = 1500): string {
  return String(v ?? "")
    .replace(/(\d)\s*[–—]\s*(\d)/g, "$1 to $2")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/,\s*,/g, ",")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);
}
const items = (v: unknown, max: number): Item[] =>
  (Array.isArray(v) ? v : [])
    .map((x) => rec(x))
    .map((x) => ({ lead: clean(x.lead, 90), text: clean(x.text, 700) }))
    .filter((x) => x.lead || x.text)
    .slice(0, max);

/** One block the AI wrote, made strict (null when it has nothing) */
export function cleanBlock(raw: unknown): Block | null {
  const b = rec(raw);
  const text = clean(b.text, 1800);
  switch (b.type) {
    case "paragraph":
    case "subheading":
    case "callout":
      return text ? { type: b.type, text: b.type === "subheading" ? text.slice(0, 90) : text } : null;
    case "bullets":
    case "steps": {
      const it = items(b.items, 14);
      return it.length ? { type: b.type, items: it } : null;
    }
    case "stats": {
      const it = items(b.items, 4).map((x) => ({ value: x.lead.slice(0, 16), label: x.text.slice(0, 70) })).filter((x) => x.value);
      return it.length ? { type: "stats", items: it } : null;
    }
    case "keyvalue": {
      const rows = items(b.items, 12).map((x) => ({ label: x.lead, value: x.text }));
      return rows.length ? { type: "keyvalue", rows } : null;
    }
    case "table": {
      const head = (Array.isArray(b.head) ? b.head : []).map((h) => clean(h, 50)).filter(Boolean).slice(0, 6);
      if (head.length < 2) return null;
      const fit = (r: unknown) => head.map((_, i) => clean((Array.isArray(r) ? r : [])[i], 400));
      const rows = (Array.isArray(b.rows) ? b.rows : []).map(fit).filter((r) => r.some(Boolean)).slice(0, 14);
      if (!rows.length) return null;
      const total = Array.isArray(b.total) && b.total.some((c) => clean(c)) ? fit(b.total) : null;
      return { type: "table", head, rows, total };
    }
    case "columns": {
      const columns = (Array.isArray(b.columns) ? b.columns : [])
        .map((c) => rec(c))
        .map((c) => ({ heading: clean(c.heading, 70), text: clean(c.text, 700), items: items(c.items, 8) }))
        .filter((c) => c.heading || c.text || c.items.length)
        .slice(0, 3);
      return columns.length ? { type: "columns", columns } : null;
    }
    case "gantt": {
      const weeks = Math.max(1, Math.min(26, Math.round(Number(b.weeks) || 0)));
      const rows = items(b.items, 12)
        .map((x) => {
          const m = x.text.match(/(\d+)\D+(\d+)/) ?? x.text.match(/(\d+)/);
          const start = Math.max(1, Number(m?.[1] ?? 1));
          const end = Math.max(start, Number(m?.[2] ?? start));
          return { task: x.lead || x.text, start: Math.min(start, weeks), end: Math.min(end, weeks) };
        })
        .filter((r) => r.task);
      return rows.length ? { type: "gantt", weeks: Math.max(weeks, ...rows.map((r) => r.end)), rows } : null;
    }
    case "total": {
      const it = items(b.items, 1)[0];
      return it ? { type: "total", label: it.lead || "TOTAL INVESTMENT", value: it.text } : null;
    }
    default:
      return null;
  }
}

// ─── Prices ─────────────────────────────────────────────────────────────────

export type RatePrice = { label: string; amount: number; cadence: "one_time" | "month"; source: "rate_card" | "package" | "confirmed" };

/** A written amount for an allowed one: exact, to the dollar, or rounded to the hundred or thousand */
export function sameAmount(allowed: number, written: number): boolean {
  if (Math.abs(allowed - written) < 1) return true;
  if (written >= 1000 && written % 100 === 0) return [100, 1000].some((u) => Math.abs(Math.round(allowed / u) * u - written) < 0.5);
  return false;
}

/** Every sum of a subset of the amounts (a total line adds up some of the prices), for up to 12 of them */
export function subsetSums(amounts: readonly number[]): number[] {
  const xs = [...new Set(amounts.filter((n) => n > 0))].slice(0, 12);
  const out = new Set<number>();
  for (let mask = 1; mask < 1 << xs.length; mask++) {
    let s = 0;
    for (let i = 0; i < xs.length; i++) if (mask & (1 << i)) s += xs[i];
    out.add(Math.round(s * 100) / 100);
  }
  return [...out];
}

const MONEY = /\$\s?\d[\d,]*(?:\.\d+)?(?:\s?[kK]\b)?/g;
const amountOf = (m: string) => Number(m.replace(/[$,\s]/g, "").replace(/k$/i, "")) * (/k\s*$/i.test(m) ? 1000 : 1);

/** Dollar amounts that aren't allowed become [Price to confirm] */
export function guardPrices(text: string, allowed: readonly number[]): string {
  return text.replace(MONEY, (m) => (allowed.some((a) => sameAmount(a, amountOf(m))) ? m : PRICE_TBD));
}

export const dollarsIn = (text: string) => [...text.matchAll(MONEY)].map((m) => amountOf(m[0])).filter((n) => Number.isFinite(n) && n > 0);

// ─── The whole document ─────────────────────────────────────────────────────

export type CleanCtx = {
  template: TemplateKey;
  client: string | null;
  preparedBy: string;
  dated: string;
  prices: readonly RatePrice[];
  /** Dollar figures from the client's own data and what the person said (revenue, ad budgets they named) */
  figures: readonly number[];
};

const PLACEHOLDER = /\[(?:Price to confirm|\$?X[X,.]*|XX+|Start Date|Client Contact|[A-Z][A-Za-z ]{2,28})\]/g;

/** The AI's document, made strict: the template's sections in its order, prices guarded, placeholders listed */
export function cleanKDoc(raw: unknown, ctx: CleanCtx): KDoc {
  const r = rec(raw);
  const t = TEMPLATES[ctx.template];
  const prices = ctx.prices.map((p) => p.amount);
  const allowed = [...subsetSums(prices), ...ctx.figures];
  const g = (s: string) => guardPrices(s, allowed);
  const guardBlock = (b: Block): Block => {
    switch (b.type) {
      case "paragraph":
      case "subheading":
      case "callout":
        return { ...b, text: g(b.text) };
      case "bullets":
      case "steps":
        return { ...b, items: b.items.map((i) => ({ lead: g(i.lead), text: g(i.text) })) };
      case "stats":
        return { ...b, items: b.items.map((i) => ({ value: g(i.value), label: g(i.label) })) };
      case "table":
        return { ...b, rows: b.rows.map((row) => row.map(g)), total: b.total ? b.total.map(g) : null };
      case "keyvalue":
        return { ...b, rows: b.rows.map((x) => ({ label: x.label, value: g(x.value) })) };
      case "columns":
        return { ...b, columns: b.columns.map((c) => ({ heading: c.heading, text: g(c.text), items: c.items.map((i) => ({ lead: g(i.lead), text: g(i.text) })) })) };
      case "total":
        return { ...b, value: g(b.value) };
      default:
        return b;
    }
  };
  const fill = (s: string) => s.replace(/\{client\}/g, ctx.client ?? "the client");
  const wrote = (Array.isArray(r.sections) ? r.sections : []).map((s) => rec(s));
  const section = (s: Record<string, unknown>, def: SectionDef | null): KSection => ({
    key: def?.key ?? (clean(s.key, 40) || "section"),
    heading: clean(s.heading, 90) || fill(def?.heading ?? "") || "Section",
    lede: g(clean(s.lede, 600)),
    blocks: (Array.isArray(s.blocks) ? s.blocks : [])
      .map(cleanBlock)
      .filter((b): b is Block => Boolean(b))
      .map(guardBlock)
      .slice(0, 12),
  });
  // A template keeps its own sections in its order (a missing required one stays, marked to fill); an open doc keeps the AI's
  const sections = t.sections.length
    ? t.sections.flatMap((def) => {
        const hit = wrote.find((s) => clean(s.key, 40) === def.key);
        if (!hit) return def.optional ? [] : [{ key: def.key, heading: fill(def.heading), lede: "", blocks: [{ type: "paragraph", text: "[To be written]" } as Block] }];
        return [section(hit, def)];
      })
    : wrote.map((s) => section(s, null)).filter((s) => s.blocks.length || s.lede).slice(0, 16);
  const doc: KDoc = {
    template: ctx.template,
    title: clean(r.title, 110) || t.label,
    subtitle: g(clean(r.subtitle, 220)),
    client: ctx.client,
    preparedFor: clean(r.prepared_for, 140) || (ctx.client ? `[Client Contact], ${ctx.client}` : ""),
    preparedBy: ctx.preparedBy,
    dated: ctx.dated,
    kicker: clean(r.kicker, 120) || (ctx.template === "quote" ? "Project Proposal" : ctx.template === "sow" ? "Scope of Work" : ""),
    sections,
    placeholders: [],
    relationshipPricing: ctx.prices.some((p) => p.source === "confirmed"),
  };
  doc.placeholders = [...new Set(docText(doc).match(PLACEHOLDER) ?? [])];
  return doc;
}

// ─── Text ───────────────────────────────────────────────────────────────────

const itemText = (i: Item) => `- ${[i.lead, i.text].filter(Boolean).join(" ")}`;
export function blockText(b: Block): string[] {
  switch (b.type) {
    case "paragraph":
    case "subheading":
    case "callout":
      return [b.text];
    case "bullets":
    case "steps":
      return b.items.map(itemText);
    case "stats":
      return b.items.map((i) => `${i.value}: ${i.label}`);
    case "table":
      return [b.head.join(" | "), ...b.rows.map((r) => r.join(" | ")), ...(b.total ? [b.total.join(" | ")] : [])];
    case "keyvalue":
      return b.rows.map((x) => `${x.label}: ${x.value}`);
    case "columns":
      return b.columns.flatMap((c) => [c.heading, ...(c.text ? [c.text] : []), ...c.items.map(itemText)]);
    case "gantt":
      return b.rows.map((x) => `${x.task}: week ${x.start}${x.end > x.start ? ` to ${x.end}` : ""}`);
    case "total":
      return [`${b.label}: ${b.value}`];
  }
}

/** The whole document as plain text (kept with the client's documents for the AI to read later) */
export function docText(d: KDoc): string {
  const out = [d.client ? `Kaizen x ${d.client}` : "Kaizen", d.title, d.subtitle, d.kicker, d.preparedFor && `Prepared for ${d.preparedFor}`, `Prepared by ${d.preparedBy}`, d.dated];
  for (const s of d.sections) out.push("", s.heading, s.lede, ...s.blocks.flatMap(blockText));
  return out.filter((x) => x !== "" && x != null).join("\n").slice(0, 40000);
}

/** "Kaizen x Angry Chickz - Scope of Work" */
export function fileName(d: Pick<KDoc, "client" | "title" | "template">): string {
  const safe = (s: string) =>
    s
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
  return [d.client ? `Kaizen x ${safe(d.client)}` : "Kaizen", safe(d.title) || TEMPLATES[d.template].label].join(" - ");
}
