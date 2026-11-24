// Kaizen's Email SOW Generator: the one source for every email Scope of Work (the assistant's create_document for an
// email SOW or pitch, the client page's Draft SOW, and a Basic to Silver pitch). It writes in the structure of Kaizen's
// "Sprint Recap & Ongoing Management SOW" (the reference: the Kaizen x The Yost Nightlife document, Nov 2026):
//   cover, 1 Sprint wrap-up (when there was a sprint), 2 The numbers, 3 Where deliverability stands,
//   4 Ongoing management scope of work (recommended start + pricing, what's included, the tiers, the path to the next
//   tier, the first 90 days, what Kaizen needs, out of scope, future automation roadmap), then Let's Keep It Rolling.
// The AI writes the words and the client's own numbers; the prices and the tier table come from email_packages (or
// prices confirmed in the conversation), never from the AI. A fact that isn't known stays a bracketed placeholder
// ([XX], [$X,XXX], [Start Date]) the way Kaizen's own documents mark them. Pure: no keys, no network.

export type SowPackage = {
  key: string;
  label: string;
  kind: string;
  price_monthly: number | null;
  campaigns_min: number | null;
  campaigns: number | null;
  flow_emails_min: number | null;
  flow_emails: number | null;
  sms_min: number | null;
  sms: number | null;
  design_hours: number | null;
  note: string | null;
};

/** A price the person confirmed in the conversation (documents/core confirmedPrices), or one stored */
export type SowPrice = { label: string; amount: number; cadence: "month" | "one_time" };

export type Lead = { lead: string; text: string };
export type Stat = { value: string; label: string };
export type Row = string[];
export type Table = { head: string[]; rows: Row[]; total?: Row | null };

export type EmailSow = {
  client: string;
  /** "Prepared for: <contact>, <client>" */
  contact: string;
  /** "November 2026" */
  dated: string;
  title: string;
  subtitle: string;
  recap: { heading: string; paragraphs: string[]; stats: Stat[]; built: Lead[] } | null;
  numbers: {
    intro: string;
    totalHeading: string;
    totalText: string;
    sources: Table | null;
    sendsText: string;
    campaigns: Table | null;
    campaignsCallout: string;
    channels: Table | null;
    channelsCallout: string;
  } | null;
  deliverability: { paragraphs: string[]; metrics: Table | null; levers: Lead[] } | null;
  scope: {
    intro: string;
    startHeading: string;
    startText: string;
    pricing: Table;
    startLine: string;
    included: { heading: string; intro: string; bullets: string[] }[];
    tiersNote: string;
    tiers: Table;
    nextTier: string | null;
    pathText: string;
    triggers: Table | null;
    triggersCallout: string;
    ninetyDays: Table | null;
    needs: Lead[];
    outOfScope: string[];
    roadmapIntro: string;
    roadmap: Lead[];
  };
  closing: { heading: string; paragraph: string; nextSteps: string[] };
  /** The bracketed spots still to fill, for the person to see */
  placeholders: string[];
};

export const SOW_DOC_TITLE = "Sprint Recap & Ongoing Management SOW";
export const PLACEHOLDER_RE = /\[(?:\$?X[X,.]*|XX+|\$X,XXX|\$XXX|Start Date|Client Contact|[A-Z][A-Za-z ]{2,30})\]/g;

/** Segmentation per tier, as Kaizen's tier sheet words it */
const SEGMENTATION: Record<string, string> = { basic: "List hygiene & segmentation", silver: "Enhanced strategies", gold: "Advanced + personalization" };

const TIER_ORDER = ["basic", "silver", "gold"];

// ─── The generator's instructions ───────────────────────────────────────────

export const SOW_SYSTEM = `You are Kaizen Marketing Agency's Email SOW Generator. You write the client-facing "Sprint Recap & Ongoing Management SOW" for an email and SMS client: a recap of what Kaizen built and what it earned, then the scope Kaizen recommends for ongoing management. It is sent to the client's decision maker, so it reads like a confident partner, warm, specific and honest.

STRUCTURE (always this order; the code draws the cover, the tables' look, the prices and the tier table):
1. recap ("We're Done. And It's Live." / SECTION 1 | SPRINT WRAP-UP), only when Kaizen ran a sprint or setup for them (otherwise null):
   - two short paragraphs: what is now live and why it matters; then that it is already paying for itself (the headline revenue figure) and what the document walks through.
   - up to 4 stat tiles: a big value and a short label ("$33,180" / "Klaviyo attributed revenue", "991K+" / "Email + SMS messages sent", "3" / "Flows delivered in October", "12.6%" / "Best email open rate, up from 9.3%").
   - "What We Built Together": 4 to 7 items, each a bold lead ("Eventbrite integration.") then one to three sentences of what it does for them.
2. numbers ("The Numbers" / SECTION 2 | REVENUE & PERFORMANCE):
   - intro: "Here is the full picture from Klaviyo as of <date>." and what views follow.
   - totalHeading "Account Total: $X in Attributed Revenue" + a sentence on the trend; sources table (Source | Attributed Revenue | Share, with a Total row) when known.
   - sendsText ("What Kaizen's Sends Drove"): what Kaizen's own sends reached and earned; campaigns table (Campaign | Sent | Recipients | Delivered | Open Rate | Clicks, Total row) from their campaigns; campaignsCallout: "The trend that matters: ..." one or two sentences.
   - channels table ("Performance by Channel": Channel | Recipients | Open Rate | Click Rate | <their conversion> Rate, SMS open rate "n/a"); channelsCallout: "Biggest standout: ...".
3. deliverability ("Where Deliverability Stands" / SECTION 3 | THE HONEST PICTURE): two paragraphs (no sugarcoating, the score or [XX], why a domain earns trust); metrics table (Metric | Current | Status | Where We're Taking It) with Status words Healthy, Excellent, Good, Building, Needs work; levers "What Moves the Score": 4 to 6 bold-lead items (Consistency., Engaged-first sending., Segment every send., One coordinated calendar., Ongoing list care.).
4. scope ("Building on the Momentum" / SECTION 4 | ONGOING MANAGEMENT SCOPE OF WORK):
   - intro paragraph; start_tier (basic, silver or gold) and add_ons (a custom scope on top, e.g. "Full SMS Program (custom scope)"; never price them); startText: why this starting point fits them.
   - included: for each add-on a block (heading "What's Included: <add-on>", an intro line saying what it replaces, 4 to 7 bullets). The starting tier's own block is written by the code from the package; you may give tier_bullet_context, a few words appended to its campaign line ("planned around the event calendar").
   - tiersNote: one sentence on how any add-on carries across tiers (or "").
   - pathText: the path to the next tier ("Basic is where we build trust with inbox providers..."), then triggers (Milestone | Target | Why It Matters): usually deliverability score above 60, list reach (sending to at least 80% of total recipients), revenue at least 3x the tier fee from Kaizen-managed sends; triggersCallout "How we measure it: ...".
   - ninetyDays (Phase | Focus | What You'll See): Days 1 to 30, 31 to 60, 61 to 90.
   - needs "What Kaizen Needs From <client>": 3 to 5 bold-lead items (event calendar or promo calendar, approvals with a 48-hour turnaround, access...).
   - outOfScope: 3 to 5 bullets. roadmapIntro + roadmap: 3 to 6 bold-lead future automations specific to their data, "Not included in the starting scope".
5. closing ("Let's Keep It Rolling"): one paragraph that recaps the month in a line and ends on growing them 1% every single day; nextSteps: 3 bullets (approve this scope of work, kickoff call, first sends in week one).

RULES:
- Use only facts given (the client's numbers, what was built, the person's brief). Never invent a number. A figure you don't have is written as a bracketed placeholder: [$X,XXX] for money, [XX] for a score or count, [Start Date], [Client Contact]. Tables can hold placeholders too, or be left out (null) when there is no data at all.
- Never write a price for a tier or an add-on anywhere: the pricing table is drawn by the code from Kaizen's package records. Revenue the client earned is fine.
- Plain words, short sentences, active voice. No em dashes or en dashes (use commas or periods). Numbers as digits. "3 to 5", never "3-5". Write money as $1,000.
- Kaizen roles, never team members' names. The client's own name is fine.
- Specific to their business and industry (ticket buyers and events for nightlife, orders for ecommerce, bookings for services); the conversion column and the roadmap use their words.
- A pitch (moving them up a tier) still uses this structure: the recap and numbers argue the case, start_tier is the tier pitched.`;

/** The JSON shape the generator answers in */
export const SOW_SCHEMA: Record<string, unknown> = (() => {
  const str = { type: "string" };
  const strs = { type: "array", items: str };
  const lead = { type: "object", properties: { lead: str, text: str }, required: ["lead", "text"], additionalProperties: false };
  const leads = { type: "array", items: lead };
  const table = { anyOf: [{ type: "null" }, { type: "object", properties: { head: strs, rows: { type: "array", items: strs }, total: { anyOf: [{ type: "null" }, strs] } }, required: ["head", "rows", "total"], additionalProperties: false }] };
  const obj = (props: Record<string, unknown>) => ({ type: "object", properties: props, required: Object.keys(props), additionalProperties: false });
  return obj({
    contact: str,
    subtitle: str,
    recap: { anyOf: [{ type: "null" }, obj({ heading: str, paragraphs: strs, stats: { type: "array", items: obj({ value: str, label: str }) }, built: leads })] },
    numbers: { anyOf: [{ type: "null" }, obj({ intro: str, total_heading: str, total_text: str, sources: table, sends_text: str, campaigns: table, campaigns_callout: str, channels: table, channels_callout: str })] },
    deliverability: { anyOf: [{ type: "null" }, obj({ paragraphs: strs, metrics: table, levers: leads })] },
    scope: obj({
      intro: str,
      start_tier: { type: "string", enum: TIER_ORDER },
      add_ons: { type: "array", items: obj({ item: str, replaces_tier_sms: { type: "boolean" } }) },
      start_text: str,
      tier_bullet_context: str,
      included: { type: "array", items: obj({ heading: str, intro: str, bullets: strs }) },
      tiers_note: str,
      path_text: str,
      triggers: table,
      triggers_callout: str,
      ninety_days: table,
      needs: leads,
      out_of_scope: strs,
      roadmap_intro: str,
      roadmap: leads,
    }),
    closing: obj({ paragraph: str, next_steps: strs }),
  });
})();

// ─── Clean-up ───────────────────────────────────────────────────────────────

/** Em and en dashes read as commas; numeric ranges keep "to" */
export function noDash(s: string): string {
  return s
    .replace(/(\d)\s*[–—]\s*(\d)/g, "$1 to $2")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/,\s*,/g, ",")
    .trim();
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const txt = (v: unknown, n = 1600) => noDash(String(v ?? "").replace(/\s+/g, " ")).slice(0, n);
const txts = (v: unknown, max: number, n = 400) =>
  (Array.isArray(v) ? v : [])
    .map((x) => txt(x, n))
    .filter(Boolean)
    .slice(0, max);
const leadsOf = (v: unknown, max: number): Lead[] =>
  (Array.isArray(v) ? v : [])
    .map((x) => rec(x))
    .map((x) => ({ lead: txt(x.lead, 80).replace(/([^.!?:])$/, "$1."), text: txt(x.text, 500) }))
    .filter((x) => x.lead.length > 1 || x.text)
    .slice(0, max);

/** A table the AI wrote, made strict: every row as wide as the head, at most n rows */
export function tableOf(v: unknown, n = 12): Table | null {
  const t = rec(v);
  const head = txts(t.head, 7, 40);
  if (head.length < 2) return null;
  const fit = (r: unknown) => {
    const cells = (Array.isArray(r) ? r : []).map((c) => txt(c, 160));
    return head.map((_, i) => cells[i] ?? "");
  };
  const rows = (Array.isArray(t.rows) ? t.rows : []).map(fit).filter((r) => r.some(Boolean)).slice(0, n);
  if (!rows.length) return null;
  const total = Array.isArray(t.total) && t.total.some((c) => String(c ?? "").trim()) ? fit(t.total) : null;
  return { head, rows, total };
}

export const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
const range = (a: number | null, b: number | null) => (a == null && b == null ? "" : a == null || a === b ? String(b ?? a) : b == null ? String(a) : `${a} to ${b}`);

/** The ongoing tiers in order (Basic, Silver, Gold), each priced: a confirmed price wins over the stored one */
export function ongoingTiers(pkgs: readonly SowPackage[], confirmed: readonly SowPrice[] = []): (SowPackage & { price: number | null })[] {
  return TIER_ORDER.map((k) => pkgs.find((p) => p.key === k && p.kind !== "setup"))
    .filter((p): p is SowPackage => Boolean(p))
    .map((p) => {
      const hit = confirmed.find((c) => c.cadence === "month" && new RegExp(`\\b${p.label}\\b`, "i").test(c.label));
      return { ...p, price: hit ? hit.amount : p.price_monthly == null ? null : Number(p.price_monthly) };
    });
}

/** "6 to 10" from the package's note ("6 to 10 emails a month"), else campaigns plus flow emails */
export function totalEmails(p: SowPackage): string {
  const m = String(p.note ?? "").match(/(\d+)\s*(?:to|-)\s*(\d+)\s*emails/i);
  if (m) return `${m[1]} to ${m[2]}`;
  return range((p.campaigns_min ?? 0) + (p.flow_emails_min ?? 0), (p.campaigns ?? 0) + (p.flow_emails ?? 0));
}

/** The "Ongoing Management Tiers" table, from the package records */
export function tierTable(tiers: ReturnType<typeof ongoingTiers>): Table {
  const col = (f: (p: (typeof tiers)[number]) => string) => tiers.map(f);
  return {
    head: ["Included", ...tiers.map((t) => t.label)],
    rows: [
      ["Monthly price", ...col((t) => (t.price == null ? "[$X,XXX]" : money(t.price)))],
      ["Campaign emails", ...col((t) => range(t.campaigns_min, t.campaigns))],
      ["Flow optimization / new automation", ...col((t) => range(t.flow_emails_min, t.flow_emails))],
      ["SMS campaign messages", ...col((t) => range(t.sms_min, t.sms))],
      ["Total emails per month", ...col(totalEmails)],
      ["Segmentation", ...col((t) => SEGMENTATION[t.key] ?? "Included")],
      ["A/B testing", ...col(() => "Included")],
      ["Performance reporting", ...col(() => "Weekly and monthly")],
      ["Design hours included", ...col((t) => (t.design_hours ? `Up to ${t.design_hours}` : "Included"))],
    ],
    total: null,
  };
}

/** The starting tier's "What's Included" bullets, from its package record */
export function tierBullets(t: ReturnType<typeof ongoingTiers>[number], context: string, smsReplaced: boolean): string[] {
  const ctx = context.trim() ? `, ${context.trim().replace(/^,\s*/, "").replace(/\.$/, "")}` : "";
  return [
    `${range(t.campaigns_min, t.campaigns)} campaign emails per month${ctx}`,
    `${range(t.flow_emails_min, t.flow_emails)} flow optimization emails or new automation per month`,
    ...(smsReplaced || !t.sms ? [] : [`${range(t.sms_min, t.sms)} SMS campaign messages per month`]),
    t.key === "basic" ? "Segmentation applied to every send, plus ongoing list hygiene" : `${SEGMENTATION[t.key] ?? "Segmentation"} on every send, plus ongoing list hygiene`,
    "A/B testing on subject lines, send times and creative",
    "Weekly and monthly performance reporting with revenue attribution",
    ...(t.design_hours ? [`Up to ${t.design_hours} hours of design included`] : []),
    `Total: ${totalEmails(t)} emails per month`,
  ];
}

/** The "Recommended Starting Point" pricing table: the tier from its record, an add-on only at a confirmed price */
export function pricingTable(tier: ReturnType<typeof ongoingTiers>[number], addOns: readonly string[], confirmed: readonly SowPrice[]): Table {
  const words = (s: string) =>
    s
      .toLowerCase()
      .replace(/\(.*?\)/g, " ")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !["full", "program", "custom", "scope", "the", "and"].includes(w));
  const priced = addOns.map((a) => {
    const w = words(a);
    const hit = confirmed.find((c) => c.cadence === "month" && w.some((x) => c.label.toLowerCase().includes(x)) && !new RegExp(`\\b${tier.label}\\b`, "i").test(c.label));
    return { item: a, amount: hit?.amount ?? null };
  });
  const all = [tier.price, ...priced.map((p) => p.amount)];
  const total = all.every((n) => n != null) ? money(all.reduce<number>((s, n) => s + (n ?? 0), 0)) : "[$X,XXX]";
  const rows: Row[] = [[`${tier.label} Package (email management)`, tier.price == null ? "[$X,XXX]/month" : `${money(tier.price)}/month`], ...priced.map((p): Row => [p.item, p.amount == null ? "[$XXX]/month" : `${money(p.amount)}/month`])];
  return { head: ["Component", "Monthly Investment"], rows, total: addOns.length ? ["Total monthly investment", `${total}/month`] : null };
}

/**
 * Money the AI wrote that isn't allowed (a tier or add-on price it made up) becomes [$X,XXX]. Allowed: the package
 * prices and confirmed ones (and up to 5 times a tier fee, "at least $3,000 (3x the Basic fee)"), and any dollar
 * figure from the client's own data.
 */
export function guardMoney(text: string, allowed: readonly number[]): string {
  return text.replace(/\$\s?\d[\d,]*(?:\.\d+)?(?:\s?[kK]\b)?/g, (m) => {
    const n = Number(m.replace(/[$,\s]/g, "").replace(/k$/i, "")) * (/k$/i.test(m.trim()) ? 1000 : 1);
    return allowed.some((a) => sameFigure(a, n)) ? m : "[$X,XXX]";
  });
}

/** A figure written for an allowed amount: exact, to the dollar, or rounded to the hundred or thousand ("over $33,000") */
export function sameFigure(allowed: number, written: number): boolean {
  if (Math.abs(allowed - written) < 1) return true;
  if (written >= 1000 && written % 100 === 0) return [100, 1000].some((u) => Math.abs(Math.round(allowed / u) * u - written) < 0.5 || Math.abs(Math.floor(allowed / u) * u - written) < 0.5);
  return false;
}

/** Every dollar figure in a text (the facts), so the client's own numbers stay */
export function dollarsIn(text: string): number[] {
  return [...text.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)/g)].map((m) => Number(m[1].replace(/,/g, ""))).filter((n) => Number.isFinite(n) && n > 0);
}

export type SowContext = {
  client: string;
  contact: string | null;
  dated: string;
  packages: readonly SowPackage[];
  confirmed: readonly SowPrice[];
  /** Dollar figures from the client's own data (revenue), allowed in the text */
  dataFigures: readonly number[];
  /** Email & SMS Marketing | Klaviyo */
  platform: string;
};

/** The generator's answer, made strict and priced */
export function cleanSow(raw: unknown, ctx: SowContext): EmailSow {
  const r = rec(raw);
  const tiers = ongoingTiers(ctx.packages, ctx.confirmed);
  const s = rec(r.scope);
  const start = tiers.find((t) => t.key === s.start_tier) ?? tiers[0];
  if (!start) throw new Error("No email packages are set up (Basic, Silver, Gold): add them before drafting an SOW.");
  const next = tiers[tiers.indexOf(start) + 1] ?? null;
  const addOnRaw = (Array.isArray(s.add_ons) ? s.add_ons : []).map((a) => rec(a)).filter((a) => txt(a.item, 80));
  const addOns = addOnRaw.map((a) => txt(a.item, 80)).slice(0, 3);
  const smsReplaced = addOnRaw.some((a) => a.replaces_tier_sms === true);
  const allowed = [...tiers.flatMap((t) => (t.price ? [1, 2, 3, 4, 5].map((k) => t.price! * k) : [])), ...ctx.confirmed.map((c) => c.amount), ...ctx.dataFigures];
  const g = (t: string) => guardMoney(t, allowed);
  const gt = (t: Table | null): Table | null => (t ? { head: t.head, rows: t.rows.map((row) => row.map(g)), total: t.total ? t.total.map(g) : null } : null);

  const rc = r.recap ? rec(r.recap) : null;
  const nb = r.numbers ? rec(r.numbers) : null;
  const dv = r.deliverability ? rec(r.deliverability) : null;
  const cl = rec(r.closing);
  const included = [
    { heading: `What's Included: ${start.label} Package (Email)`, intro: "", bullets: tierBullets(start, txt(s.tier_bullet_context, 80), smsReplaced) },
    ...(Array.isArray(s.included) ? s.included : [])
      .map((b) => rec(b))
      .map((b) => ({ heading: txt(b.heading, 90), intro: g(txt(b.intro, 500)), bullets: txts(b.bullets, 8, 260).map(g) }))
      .filter((b) => b.heading && !new RegExp(`${start.label} Package`, "i").test(b.heading) && (b.bullets.length || b.intro))
      .slice(0, 3),
  ];
  const startName = `${start.label} Package${addOns.length ? ` + ${addOns.map((a) => a.replace(/\s*\(custom scope\)/i, "")).join(" + ")}` : ""}`;
  const sow: EmailSow = {
    client: ctx.client,
    contact: txt(r.contact, 80) && !/^\[?client contact\]?$/i.test(txt(r.contact, 80)) ? txt(r.contact, 80) : (ctx.contact ?? "[Client Contact]"),
    dated: ctx.dated,
    title: SOW_DOC_TITLE,
    subtitle: txt(r.subtitle, 80) || ctx.platform,
    recap: rc
      ? {
          heading: "We're Done. And It's Live.",
          paragraphs: txts(rc.paragraphs, 3, 1200).map(g),
          stats: (Array.isArray(rc.stats) ? rc.stats : [])
            .map((x) => rec(x))
            .map((x) => ({ value: txt(x.value, 14), label: txt(x.label, 50) }))
            .filter((x) => x.value && x.label)
            .slice(0, 4),
          built: leadsOf(rc.built, 8).map((l) => ({ lead: l.lead, text: g(l.text) })),
        }
      : null,
    numbers: nb
      ? {
          intro: g(txt(nb.intro, 600)),
          totalHeading: g(txt(nb.total_heading, 90)) || "Account Total: [$X,XXX] in Attributed Revenue",
          totalText: g(txt(nb.total_text, 600)),
          sources: gt(tableOf(nb.sources, 6)),
          sendsText: g(txt(nb.sends_text, 800)),
          campaigns: gt(tableOf(nb.campaigns, 14)),
          campaignsCallout: g(txt(nb.campaigns_callout, 500)),
          channels: gt(tableOf(nb.channels, 8)),
          channelsCallout: g(txt(nb.channels_callout, 500)),
        }
      : null,
    deliverability: dv ? { paragraphs: txts(dv.paragraphs, 3, 900).map(g), metrics: gt(tableOf(dv.metrics, 10)), levers: leadsOf(dv.levers, 7) } : null,
    scope: {
      intro: g(txt(s.intro, 900)),
      startHeading: `Recommended Starting Point: ${startName}`,
      startText: g(txt(s.start_text, 900)),
      pricing: pricingTable(start, addOns, ctx.confirmed),
      startLine: "Start date: [Start Date]. Billed monthly.",
      included,
      tiersNote: g(txt(s.tiers_note, 400)),
      tiers: tierTable(tiers),
      nextTier: next?.label ?? null,
      pathText: g(txt(s.path_text, 900)),
      triggers: next ? gt(tableOf(s.triggers, 5)) : null,
      triggersCallout: next ? g(txt(s.triggers_callout, 500)) : "",
      ninetyDays: gt(tableOf(s.ninety_days, 4)),
      needs: leadsOf(s.needs, 6),
      outOfScope: txts(s.out_of_scope, 6, 300),
      roadmapIntro: txt(s.roadmap_intro, 300) || "Opportunities identified for later phases once the core cadence is stable. Not included in the starting scope.",
      roadmap: leadsOf(s.roadmap, 7),
    },
    closing: {
      heading: "Let's Keep It Rolling",
      paragraph: g(txt(cl.paragraph, 900)),
      nextSteps: txts(cl.next_steps, 5, 200).length ? txts(cl.next_steps, 5, 200) : ["Approve this scope of work.", "Kickoff call to align on the calendar and handoff.", "First coordinated email and SMS sends go out in week one."],
    },
    placeholders: [],
  };
  sow.placeholders = [...new Set(sowText(sow).match(PLACEHOLDER_RE) ?? [])];
  return sow;
}

// ─── Text views ─────────────────────────────────────────────────────────────

const tableText = (t: Table | null) => (t ? [t.head.join(" | "), ...t.rows.map((r) => r.join(" | ")), ...(t.total ? [t.total.join(" | ")] : [])] : []);
const leadText = (l: Lead) => `- ${l.lead} ${l.text}`.trim();

/** The whole document as plain text (kept with the client's documents, for the AI to read later) */
export function sowText(d: EmailSow): string {
  const out: string[] = [`KAIZEN x ${d.client.toUpperCase()}`, d.title, d.subtitle, `Prepared for: ${d.contact}, ${d.client}`, "Prepared by: Kaizen Marketing Agency", d.dated];
  if (d.recap) out.push("", d.recap.heading, ...d.recap.paragraphs, ...d.recap.stats.map((s) => `${s.value}: ${s.label}`), "What We Built Together", ...d.recap.built.map(leadText));
  if (d.numbers) {
    const n = d.numbers;
    out.push("", "The Numbers", n.intro, n.totalHeading, n.totalText, ...tableText(n.sources), "What Kaizen's Sends Drove", n.sendsText, ...tableText(n.campaigns), n.campaignsCallout, "Performance by Channel", ...tableText(n.channels), n.channelsCallout);
  }
  if (d.deliverability) out.push("", "Where Deliverability Stands", ...d.deliverability.paragraphs, ...tableText(d.deliverability.metrics), "What Moves the Score", ...d.deliverability.levers.map(leadText));
  const s = d.scope;
  out.push("", "Building on the Momentum", s.intro, s.startHeading, s.startText, ...tableText(s.pricing), s.startLine);
  for (const b of s.included) out.push(b.heading, ...(b.intro ? [b.intro] : []), ...b.bullets.map((x) => `- ${x}`));
  out.push("Ongoing Management Tiers", ...tableText(s.tiers), s.tiersNote);
  if (s.nextTier) out.push(`The Path to ${s.nextTier}`, s.pathText, ...tableText(s.triggers), s.triggersCallout);
  out.push("What Success Looks Like: First 90 Days", ...tableText(s.ninetyDays), `What Kaizen Needs From ${d.client}`, ...s.needs.map(leadText), "Out of Scope", ...s.outOfScope.map((x) => `- ${x}`), "Future Automation Roadmap", s.roadmapIntro, ...s.roadmap.map(leadText));
  out.push("", d.closing.heading, d.closing.paragraph, "Next Steps", ...d.closing.nextSteps.map((x) => `- ${x}`));
  return out.filter((x) => x !== "").join("\n").slice(0, 30000);
}

/** "Kaizen x The Yost - Sprint Recap & Ongoing Management SOW" (no extension) */
export function sowFileBase(client: string): string {
  const safe = client
    .replace(/[^\p{L}\p{N} &'().]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return `Kaizen x ${safe} - Sprint Recap and Ongoing Management SOW`;
}

/** Whether a document's service and kind go to this generator (an email SOW or pitch proposal) */
export function isEmailSow(kind: unknown, service: unknown): boolean {
  const k = String(kind ?? "");
  const s = String(service ?? "email")
    .toLowerCase()
    .trim();
  return (k === "sow" || k === "proposal") && (s === "" || s.startsWith("email") || s === "sms" || s === "klaviyo");
}
