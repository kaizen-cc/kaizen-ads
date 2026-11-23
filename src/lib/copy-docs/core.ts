// Copy documents: campaign, flow and SMS copy the specialists write for the email team (not a message to anyone).
// Written on a call or in the chat (create_copy_doc), shown as a document card, read and commented on line by line in
// the document view, revised live with the assistant, approved into a Google Doc in the client's headquarters Drive
// folder ("Email Marketing"), then requested in Asana's Email Marketing project the way the team makes them.
// Pure: no database, Drive or Asana calls, so the naming, field mapping, folders and dates are tested on their own.

export type CopyKind = "campaign" | "flow" | "sms" | "creative" | "social";
export const COPY_KINDS: readonly CopyKind[] = ["campaign", "flow", "sms", "creative", "social"];
/** Kinds with no subject or preview line: a text, an ad concept, an organic post (the document view and the Doc skip them) */
export const noSubject = (k: CopyKind) => k === "sms" || k === "creative" || k === "social";

export type CopySection = { heading: string; body: string };
export type CopyEmail = {
  name: string;
  /** SMS: empty */
  subject: string;
  preview: string;
  sections: CopySection[];
  cta: { label: string; url: string } | null;
  designNotes: string[];
  /** A flow step's timing ("Right away", "2 days after the first") */
  timing: string;
};
export type CopyBrief = {
  goal: string;
  audience: string;
  /** As said ("Monday morning, 9am ET") */
  sendAt: string;
  /** YYYY-MM-DD when known */
  sendDate: string | null;
  offer: string;
  rules: string[];
  signoff: string[];
  assets: string;
  designDirection: string;
};
export type CopyContent = { kind: CopyKind; title: string; shortName: string; emails: CopyEmail[]; brief: CopyBrief };
export type CopyComment = { id: string; anchor: string; quote: string; text: string; by: string; byName: string; at: string; resolved: boolean };
export type CopyStatus = "draft" | "approved" | "requested";

/** The copy_docs kinds a deliverable line's documents are saved under (email: campaign, flow, sms; creative; social) */
export const docKindsFor = (line: string): string[] => (line === "email" ? ["campaign", "flow", "sms"] : [line]);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** En and em dashes, written as code points so the source holds none */
const DASHES = new RegExp(`\\s*[${String.fromCharCode(0x2013, 0x2014)}]\\s*`, "g");

const str = (v: unknown, n: number) =>
  String(v ?? "")
    .replace(DASHES, ", ")
    .replace(/[ \t]+/g, " ")
    .trim()
    .slice(0, n);
const block = (v: unknown, n: number) =>
  String(v ?? "")
    .replace(DASHES, ", ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, n);
const list = (v: unknown, each: number, max: number) => (Array.isArray(v) ? v : typeof v === "string" ? v.split("\n") : []).map((x) => str(String(x).replace(/^\s*[-*•]\s*/, ""), each)).filter(Boolean).slice(0, max);

export const isCopyKind = (v: unknown): v is CopyKind => typeof v === "string" && (COPY_KINDS as readonly string[]).includes(v);

/** What the model wrote (loose) as the document's content: trimmed, no dashes, at most 6 emails */
export function normalizeCopy(input: Record<string, unknown>): CopyContent {
  const kind: CopyKind = isCopyKind(input.kind) ? input.kind : "campaign";
  const raw = Array.isArray(input.emails) ? (input.emails as Record<string, unknown>[]) : [];
  const emails: CopyEmail[] = raw.slice(0, 6).map((e, i) => {
    const sections = (Array.isArray(e.sections) ? (e.sections as Record<string, unknown>[]) : []).map((s) => ({ heading: str(s.heading, 160), body: block(s.body, 3000) })).filter((s) => s.heading || s.body).slice(0, 12);
    const cta = e.cta && typeof e.cta === "object" ? (e.cta as Record<string, unknown>) : null;
    const label = str(cta?.label ?? (typeof e.cta === "string" ? e.cta : ""), 60);
    return {
      name: str(e.name, 80) || (kind === "flow" ? `Email ${i + 1}` : kind === "sms" ? `Text ${i + 1}` : kind === "social" ? `Post ${i + 1}` : kind === "creative" ? "Concept" : raw.length > 1 ? `Email ${i + 1}` : "Email"),
      subject: noSubject(kind) ? "" : str(e.subject, 200),
      preview: noSubject(kind) ? "" : str(e.preview ?? e.preheader, 250),
      sections,
      cta: label ? { label, url: str(cta?.url, 500) } : null,
      designNotes: list(e.design_notes ?? e.designNotes, 300, 12),
      timing: str(e.timing, 120),
    };
  });
  const b = (input.brief && typeof input.brief === "object" ? input.brief : {}) as Record<string, unknown>;
  const sendDate = DAY.test(String(b.send_date ?? b.sendDate ?? "")) ? String(b.send_date ?? b.sendDate) : null;
  const title = str(input.title, 140) || "Email copy";
  return {
    kind,
    title,
    shortName: str(input.short_name ?? input.shortName, 80) || title,
    emails,
    brief: {
      goal: block(b.goal, 1200),
      audience: block(b.audience, 600),
      sendAt: str(b.send_at ?? b.sendAt, 120),
      sendDate,
      offer: block(b.offer, 1200),
      rules: list(b.rules, 300, 12),
      signoff: list(b.signoff, 300, 8),
      assets: block(b.assets, 1200),
      designDirection: block(b.design_direction ?? b.designDirection, 1500),
    },
  };
}

/** Back to the loose shape the tool takes (a revision starts from the current content) */
export function toLooseCopy(c: CopyContent): Record<string, unknown> {
  return {
    kind: c.kind,
    title: c.title,
    short_name: c.shortName,
    emails: c.emails.map((e) => ({ name: e.name, subject: e.subject, preview: e.preview, sections: e.sections, cta: e.cta, design_notes: e.designNotes, timing: e.timing })),
    brief: { goal: c.brief.goal, audience: c.brief.audience, send_at: c.brief.sendAt, send_date: c.brief.sendDate, offer: c.brief.offer, rules: c.brief.rules, signoff: c.brief.signoff, assets: c.brief.assets, design_direction: c.brief.designDirection },
  };
}

// ─── Lines: what a comment points at, and what changed between versions ────────────────────────────────────────────

export type CopyLine = { anchor: string; label: string; text: string };

/** Every line of the copy a person can comment on, with a stable anchor ("e0.subject", "e1.s2.body") */
export function copyLines(c: CopyContent): CopyLine[] {
  const out: CopyLine[] = [];
  c.emails.forEach((e, i) => {
    const at = (k: string) => `e${i}.${k}`;
    if (e.subject) out.push({ anchor: at("subject"), label: `${e.name}: subject`, text: e.subject });
    if (e.preview) out.push({ anchor: at("preview"), label: `${e.name}: preview text`, text: e.preview });
    e.sections.forEach((s, j) => {
      if (s.heading) out.push({ anchor: at(`s${j}.heading`), label: `${e.name}: section ${j + 1} heading`, text: s.heading });
      if (s.body) out.push({ anchor: at(`s${j}.body`), label: `${e.name}: section ${j + 1}`, text: s.body });
    });
    if (e.cta) out.push({ anchor: at("cta"), label: `${e.name}: button`, text: e.cta.label });
    e.designNotes.forEach((n, j) => out.push({ anchor: at(`d${j}`), label: `${e.name}: design note ${j + 1}`, text: n }));
  });
  return out;
}

/** The copy with one line's words replaced (by its anchor, as copyLines names it); null when no such line */
export function setCopyLine(c: CopyContent, anchor: string, text: string): CopyContent | null {
  const m = anchor.match(/^e(\d+)\.(subject|preview|cta|s(\d+)\.(heading|body)|d(\d+))$/);
  const i = m ? Number(m[1]) : -1;
  const e = c.emails[i];
  if (!m || !e) return null;
  const t = text.replace(/\r\n/g, "\n").trim().slice(0, 4000);
  const next: CopyEmail = { ...e, sections: e.sections.map((s) => ({ ...s })), designNotes: [...e.designNotes], cta: e.cta ? { ...e.cta } : null };
  if (m[2] === "subject") next.subject = t;
  else if (m[2] === "preview") next.preview = t;
  else if (m[2] === "cta") {
    if (!next.cta) return null;
    next.cta.label = t;
  } else if (m[3] != null) {
    const s = next.sections[Number(m[3])];
    if (!s) return null;
    s[m[4] as "heading" | "body"] = t;
  } else {
    const j = Number(m[5]);
    if (j >= next.designNotes.length) return null;
    next.designNotes[j] = t;
  }
  return { ...c, emails: c.emails.map((x, k) => (k === i ? next : x)) };
}

/** The anchors whose words changed from one version to the next (new lines count as changed) */
export function changedLines(before: CopyContent | null, after: CopyContent): string[] {
  if (!before) return [];
  const was = new Map(copyLines(before).map((l) => [l.anchor, l.text]));
  return copyLines(after)
    .filter((l) => was.get(l.anchor) !== l.text)
    .map((l) => l.anchor);
}

// ─── Campaign copy or a message to someone ─────────────────────────────────────────────────────────────────────────

const REPLY = /\b(?:reply(?:ing)?|respond(?:ing)?|write back|get back to|answer (?:him|her|them|the client|their email))\b/i;
const FLOW = /\b(?:flows?|automations?|(?:welcome|nurture|winback|win-back|post[- ]purchase|browse abandon\w*|abandon(?:ed)? (?:cart|checkout)) ?(?:series|sequence|flow)?|drip|sequence)\b/i;
const SMS = /\b(?:sms|text message (?:campaign|blast)|text blast)\b/i;
const CAMPAIGN = /\b(?:campaign|newsletter|blast|promo(?:tional)? email|email copy|copy for (?:an?|the|their) (?:email|campaign|newsletter|send)|(?:to|for) (?:the|our|their) (?:list|subscribers|audience|segment)|for the (?:email )?designer|to send to the (?:email )?designer|klaviyo|brevo|customer\.io|subject lines?|preview text|send(?:s|ing)? (?:on|this|next) (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week))\b/i;
const MESSAGE = /\b(?:(?:draft|write|send|compose) (?:an? |the )?(?:email|note|message|slack) (?:to|for) (?!(?:the|our|their) (?:list|subscribers|audience|segment|designer))|email (?:him|her|them|the client|the contact)\b|follow up with)/i;

/**
 * What a writing ask is: campaign, flow or SMS copy for the email team (a document, never addressed to anyone), or a
 * message the person sends someone (an email or Slack draft). A reply is always a message; campaign words win over
 * "send it to the designer" (that's who builds it, not who it's to). Null: not about writing either.
 */
export function emailWritingKind(text: string): CopyKind | "message" | null {
  const t = String(text ?? "");
  if (REPLY.test(t)) return "message";
  if (SMS.test(t)) return "sms";
  if (FLOW.test(t) && /\b(?:email|copy|write|draft|flow|series|sequence)\b/i.test(t)) return "flow";
  if (CAMPAIGN.test(t) && /\b(?:email|copy|write|draft|campaign|newsletter|blast|subject)\b/i.test(t)) return "campaign";
  if (MESSAGE.test(t)) return "message";
  return null;
}

// ─── The Asana task, the way the email team makes it ──────────────────────────────────────────────────────────────

export const REQUEST_TYPE: Record<CopyKind, string> = { campaign: "Email Campaign", flow: "Email Flow", sms: "SMS", creative: "Ad Creative Brief", social: "Organic Social" };

/** "KZN x Candy Cloud | Email Campaign - Scratch to Win"; a flow carries its email count: "Email Flow - Welcome Series (3)" */
export function asanaTaskName(p: { client: string; kind: CopyKind; shortName: string; count: number }) {
  // One request per batch of up to 5 emails: the count shows whenever there's more than one (a flow always shows it)
  const many = Math.max(1, p.count) > 1;
  const what = p.kind === "flow" ? "Email Flow" : p.kind === "sms" ? (many ? "SMS Campaigns" : "SMS Campaign") : many ? "Email Campaigns" : "Email Campaign";
  const name = str(p.shortName, 90).replace(/\s*\(\d+\)\s*$/, "") || "Untitled";
  return `KZN x ${str(p.client, 80)} | ${what} - ${name}${p.kind === "flow" || many ? ` (${Math.max(1, p.count)})` : ""}`.slice(0, 250);
}

export type Urgency = "urgent" | "high" | "normal" | "low";

/** How urgent a request is: what was said, else how close the send is (two business days or less is high) */
export function urgencyFor(said: string | null | undefined, sendDate: string | null, today: string): Urgency {
  const s = String(said ?? "").toLowerCase();
  if (/\b(?:urgent|asap|right away|today|rush|emergency)\b/.test(s)) return "urgent";
  if (/\b(?:high priority|priority|soon|quick(?:ly)?)\b/.test(s)) return "high";
  if (/\blow priority|no rush|whenever\b/.test(s)) return "low";
  if (sendDate && DAY.test(sendDate)) {
    const days = businessDaysBetween(today, sendDate);
    if (days <= 1) return "urgent";
    if (days <= 3) return "high";
  }
  return "normal";
}

const ymd = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
const at = (day: string) => new Date(`${day}T12:00:00Z`);
const weekend = (d: Date) => d.getUTCDay() === 0 || d.getUTCDay() === 6;

/** Business days from one day to a later one (0 when it's the same day or earlier) */
export function businessDaysBetween(from: string, to: string) {
  if (!DAY.test(from) || !DAY.test(to) || to <= from) return 0;
  const d = at(from);
  let n = 0;
  while (ymd(d) < to) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (!weekend(d)) n++;
  }
  return n;
}

/** The design lead time the email team works to: the design is due this many business days before the send */
export const DESIGN_LEAD_DAYS = 2;

/**
 * The designer's due date: the send date less the design lead time in business days, never before today; a date that
 * was said wins. No send date: the lead time from today.
 */
export function designDueDate(p: { sendDate: string | null; said?: string | null; today: string; leadDays?: number }): string {
  if (p.said && DAY.test(p.said)) return p.said < p.today ? p.today : p.said;
  const lead = p.leadDays ?? DESIGN_LEAD_DAYS;
  const d = at(p.sendDate && DAY.test(p.sendDate) ? p.sendDate : p.today);
  if (p.sendDate && DAY.test(p.sendDate)) {
    let n = 0;
    while (n < lead) {
      d.setUTCDate(d.getUTCDate() - 1);
      if (!weekend(d)) n++;
    }
  } else {
    let n = 0;
    while (n < lead) {
      d.setUTCDate(d.getUTCDate() + 1);
      if (!weekend(d)) n++;
    }
  }
  while (weekend(d)) d.setUTCDate(d.getUTCDate() - 1);
  const due = ymd(d);
  return due < p.today ? p.today : due;
}

/** A name compared loosely: case, spaces, punctuation and a leading "40 - " number don't matter */
export const looseName = (s: string) =>
  String(s ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/^\s*\d+\s*[-._)]*\s*/, "")
    .replace(/[^a-z0-9]+/g, "");

export type AsanaFieldSetting = { gid: string; name: string; type: string; options: { gid: string; name: string; enabled?: boolean }[] };
export type WantedField = { name: string; value: string; aliases?: string[] };

const OPTION_ALIASES: Record<string, string[]> = {
  urgent: ["urgent", "critical", "highest", "asap", "high"],
  high: ["high", "important", "urgent"],
  normal: ["medium", "normal", "standard", "regular", "mid"],
  low: ["low", "lowest", "whenever"],
  emailcampaign: ["emailcampaign", "campaign", "email", "newsletter"],
  emailflow: ["emailflow", "flow", "automation"],
  sms: ["sms", "text", "textmessage", "smscampaign"],
  customerio: ["customerio", "cio"],
};

/** The enum option for a value: the same name, then a known alias, then one that contains it */
export function pickOption(options: AsanaFieldSetting["options"], value: string) {
  const live = options.filter((o) => o.enabled !== false);
  const want = looseName(value);
  if (!want) return null;
  const exact = live.find((o) => looseName(o.name) === want);
  if (exact) return exact;
  for (const alias of OPTION_ALIASES[want] ?? []) {
    const hit = live.find((o) => looseName(o.name) === alias) ?? live.find((o) => looseName(o.name).includes(alias));
    if (hit) return hit;
  }
  return live.find((o) => looseName(o.name).includes(want) || (looseName(o.name).length >= 3 && want.includes(looseName(o.name)))) ?? null;
}

/**
 * The task's custom fields as Asana takes them ({ field gid: text, number or option gid }), matched by the field's
 * name in the project (never a hard-coded gid). An empty value leaves the field alone; a field the project lacks, or
 * an option it doesn't have, is listed as missing so the description can carry it instead.
 */
export function mapAsanaFields(settings: readonly AsanaFieldSetting[], wanted: readonly WantedField[]) {
  const custom_fields: Record<string, string | number | string[]> = {};
  const missing: WantedField[] = [];
  const set: string[] = [];
  for (const w of wanted) {
    const value = w.value.trim();
    if (!value) continue;
    const names = [w.name, ...(w.aliases ?? [])].map(looseName);
    const s = settings.find((x) => names.includes(looseName(x.name))) ?? settings.find((x) => names.some((n) => n.length >= 4 && looseName(x.name).startsWith(n)));
    if (!s) {
      missing.push(w);
      continue;
    }
    if (s.type === "number") {
      const n = Number(value.replace(/[^\d.-]/g, ""));
      if (!Number.isFinite(n)) {
        missing.push(w);
        continue;
      }
      custom_fields[s.gid] = n;
    } else if (s.type === "enum" || s.type === "multi_enum") {
      const o = pickOption(s.options, value);
      if (!o) {
        missing.push(w);
        continue;
      }
      custom_fields[s.gid] = s.type === "multi_enum" ? [o.gid] : o.gid;
    } else if (s.type === "text") custom_fields[s.gid] = value.slice(0, 1000);
    else {
      missing.push(w);
      continue;
    }
    set.push(s.name);
  }
  return { custom_fields, missing, set };
}

/** The column a new request starts in: "Ready for Design" (any spelling), else the first one named like it */
export function pickSection(sections: readonly { gid: string; name: string }[], want = "Ready for Design") {
  const w = looseName(want);
  return sections.find((s) => looseName(s.name) === w) ?? sections.find((s) => looseName(s.name).startsWith(w)) ?? sections.find((s) => /ready\s*for\s*design|^design/i.test(s.name.trim())) ?? null;
}

/**
 * The column new requests go in, by name only ("Email Requests", "email requests", "1 - Email Requests", "Email
 * Requests 📥"): the same name, then one starting with it, then one holding it. Never a guess at another column: with
 * none, the error names the columns the project has.
 */
export function requestSection(sections: readonly { gid: string; name: string }[], want: string): { ok: true; section: { gid: string; name: string } } | { ok: false; error: string } {
  const w = looseName(want);
  const hit = sections.find((s) => looseName(s.name) === w) ?? sections.find((s) => looseName(s.name).startsWith(w)) ?? (w.length >= 5 ? sections.find((s) => looseName(s.name).includes(w)) : undefined);
  if (hit) return { ok: true, section: hit };
  const names = sections.map((s) => s.name.trim()).filter(Boolean);
  return { ok: false, error: `The Asana project has no "${want}" column${names.length ? ` (its columns: ${names.slice(0, 15).join(", ")})` : " (it has no columns)"}. Add the column, or say which one to use.` };
}

// ─── The Google Doc ───────────────────────────────────────────────────────────────────────────────────────────────

export const EMAIL_FOLDER = "Email Marketing";
/** "Email Marketing", "email marketing", "40 - Email Marketing", "Email_Marketing" are all the same folder */
export const isEmailFolder = (name: string) => looseName(name) === looseName(EMAIL_FOLDER);
/** A folder under the client's HQ found by name whatever its case or numbering, made with this name when missing */
export const folderStep = (folder: string) => ({ key: folder, match: (n: string) => looseName(n) === looseName(folder), name: () => folder });
export const emailFolderStep = folderStep(EMAIL_FOLDER);

/** The Google Doc's name: "Candy Cloud - Email Campaign - Scratch to Win - Nov 23" */
export function copyDocName(p: { client: string; kind: CopyKind; shortName: string; sendDate: string | null }) {
  // Email copy follows the Template Library: "KZN x {Client} | {Flow Name or Monthly Campaigns}"
  if (p.kind === "campaign" || p.kind === "flow" || p.kind === "sms") return `KZN x ${str(p.client, 80)} | ${copyGroupName({ kind: p.kind, shortName: p.shortName, brief: { sendDate: p.sendDate } })}`.replace(/[\\/:*?"<>]/g, " ").slice(0, 200);
  const when = p.sendDate && DAY.test(p.sendDate) ? ` - ${at(p.sendDate).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}` : "";
  return `${str(p.client, 80)} - ${REQUEST_TYPE[p.kind]} - ${str(p.shortName, 90)}${when}`.replace(/[\\/:*?"<>|]/g, " ").slice(0, 200);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const para = (s: string) =>
  s
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");

/**
 * The email's group in Kaizen's naming convention (the Template Library): a flow by its name ("Winback Flow"), campaigns
 * by their month ("December Campaigns"), texts the same way ("December SMS")
 */
export function copyGroupName(c: { kind: CopyKind; shortName: string; brief: { sendDate: string | null } }, now = new Date()) {
  if (c.kind === "flow") {
    const n = str(c.shortName, 80).replace(/\s*\(\d+\)\s*$/, "") || "Email";
    return /\bflow$/i.test(n) ? n : `${n} Flow`;
  }
  const d = c.brief.sendDate && DAY.test(c.brief.sendDate) ? at(c.brief.sendDate) : now;
  const month = d.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  return `${month} ${c.kind === "sms" ? "SMS" : "Campaigns"}`;
}

/** One email's heading in the convention: "KZN x Crust Pizza Co. | December Campaigns | Email #1" */
export const copyEmailHeading = (client: string, group: string, kind: CopyKind, i: number) => `KZN x ${str(client, 80)} | ${group} | ${kind === "sms" ? "Text" : "Email"} #${i + 1}`;

/**
 * Email copy as the designer gets it, exactly the Template Library's layout: per email its heading in the naming
 * convention, then Subject Line, Preview Text, Headline, Sub-headline and Hero CTA (with its link); any further blocks of
 * the email as Block n Headline / Copy / CTA; then the design notes. Nothing the designer doesn't need: no brief, goal,
 * audience, rules or sign-off (those live in the request).
 */
function emailDocHtml(c: CopyContent, client: string) {
  const group = copyGroupName(c);
  const line = (label: string, v: string | null | undefined) => `<p><b>${esc(label)}:</b> ${v ? esc(v).replace(/\n/g, "<br>") : ""}</p>`;
  const link = (cta: { label: string; url: string } | null) => (cta ? `${cta.label}${cta.url ? ` (${cta.url})` : ""}` : "");
  const emails = c.emails
    .map((e, i) => {
      const [hero, ...rest] = e.sections;
      const parts = [`<p><b>${esc(copyEmailHeading(client, group, c.kind, i))}</b></p>`];
      if (c.kind === "sms") {
        parts.push(line("Message", e.sections.map((s) => [s.heading, s.body].filter(Boolean).join("\n")).join("\n\n")));
        if (e.cta) parts.push(line("Link", e.cta.url || e.cta.label));
      } else {
        parts.push(line("Subject Line", e.subject), line("Preview Text", e.preview), line("Headline", hero?.heading), line("Sub-headline", hero?.body), line("Hero CTA", link(e.cta)));
        rest.forEach((s, j) => {
          if (s.heading) parts.push(line(`Block ${j + 1} Headline`, s.heading));
          if (s.body) parts.push(line(`Block ${j + 1} Copy`, s.body));
        });
      }
      if (e.designNotes.length) parts.push(`<p><b>Design Notes:</b></p><ul>${e.designNotes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`);
      return parts.join("");
    })
    .join("<p>&nbsp;</p>");
  return `<html><head><meta charset="utf-8"><title>${esc(`KZN x ${client} | ${group}`)}</title></head><body style="font-family:Arial,sans-serif">${emails}</body></html>`;
}

/** The copy as HTML that Drive turns into a Google Doc. Email copy: the Template Library layout (emailDocHtml); a creative or social brief: the brief, then each concept */
export function copyDocHtml(c: CopyContent, p: { client: string }) {
  if (c.kind === "campaign" || c.kind === "flow" || c.kind === "sms") return emailDocHtml(c, p.client);
  const b = c.brief;
  const briefRows = [
    ["Goal", b.goal],
    ["Audience", b.audience],
    ["Send", [b.sendAt, b.sendDate].filter(Boolean).join(" ")],
    ["Offer", b.offer],
    ["Design direction", b.designDirection],
    ["Assets", b.assets],
  ].filter(([, v]) => v);
  const emails = c.emails
    .map((e) => {
      const head = noSubject(c.kind) ? "" : `<p><b>Subject:</b> ${esc(e.subject)}</p><p><b>Preview text:</b> ${esc(e.preview)}</p>`;
      const sections = e.sections.map((s) => `${s.heading ? `<h3>${esc(s.heading)}</h3>` : ""}${para(s.body)}`).join("");
      const cta = e.cta ? `<p><b>Button:</b> ${esc(e.cta.label)}${e.cta.url ? ` (${esc(e.cta.url)})` : ""}</p>` : "";
      const notes = e.designNotes.length ? `<p><b>Design notes</b></p><ul>${e.designNotes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : "";
      return `<h2>${esc(e.name)}${e.timing ? ` <span style="font-weight:normal">(${esc(e.timing)})</span>` : ""}</h2>${head}${sections}${cta}${notes}`;
    })
    .join("<hr>");
  const rules = b.rules.length ? `<p><b>Rules</b></p><ul>${b.rules.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : "";
  const signoff = b.signoff.length ? `<p><b>Needs the client's sign-off</b></p><ul>${b.signoff.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : "";
  return `<html><head><meta charset="utf-8"><title>${esc(c.title)}</title></head><body style="font-family:Arial,sans-serif"><h1>${esc(c.title)}</h1><p>${esc(p.client)} · ${esc(REQUEST_TYPE[c.kind])}</p>${briefRows.map(([k, v]) => `<p><b>${esc(k)}:</b> ${esc(v)}</p>`).join("")}${rules}${signoff}<hr>${emails}</body></html>`;
}

/** The Asana task's description: the brief, the way the team writes one */
export function requestDescription(c: CopyContent, p: { copyUrl: string | null; hqUrl: string | null; website: string | null; figma: string | null; platform: string | null; requestedBy: string }) {
  const b = c.brief;
  const lines = [
    `Goal: ${b.goal || c.title}`,
    `Audience / segment: ${b.audience || "To confirm"}`,
    `Send: ${[b.sendAt, b.sendDate].filter(Boolean).join(" ") || "To confirm"}`,
    ...(b.offer ? [`Offer: ${b.offer}`] : []),
    `${c.kind === "flow" ? "Emails in the flow" : c.kind === "sms" ? "Texts" : "Emails"}: ${c.emails.length}${c.emails.length ? ` (${c.emails.map((e) => e.name).join(", ")})` : ""}`,
    "",
    ...(b.designDirection ? ["Design direction:", b.designDirection, ""] : []),
    ...(b.assets ? ["Assets:", b.assets, ""] : []),
    ...(b.rules.length ? ["Rules:", ...b.rules.map((r) => `- ${r}`), ""] : []),
    ...(b.signoff.length ? ["Needs the client's sign-off:", ...b.signoff.map((r) => `- ${r}`), ""] : []),
    `Copy (approved): ${p.copyUrl ?? "To come"}`,
    ...(p.hqUrl ? [`Client HQ: ${p.hqUrl}`] : []),
    ...(p.figma ? [`Figma: ${p.figma}`] : []),
    ...(p.website ? [`Website: ${p.website}`] : []),
    ...(p.platform ? [`Platform: ${p.platform}`] : []),
    "",
    `Requested in Kaizen OS by ${p.requestedBy}.`,
  ];
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The Purpose field: what the email is for, the design direction and the asset notes, in one short paragraph */
export function purposeText(c: CopyContent) {
  const b = c.brief;
  return [b.goal || c.title, b.designDirection ? `Design: ${b.designDirection}` : "", b.assets ? `Assets: ${b.assets}` : "", b.rules.length ? `Rules: ${b.rules.join("; ")}` : ""].filter(Boolean).join("\n").slice(0, 1000);
}

// ─── The shape the specialists write in (the tool's input, and the AI revision's answer) ───────────────────────────

const LIST = { type: "array", items: { type: "string" } };
export const COPY_EMAIL_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Email 1, Welcome, Reminder; a text: Text 1" },
    timing: { type: "string", description: "A flow step's timing (Right away, 2 days later); a campaign's send if it differs" },
    subject: { type: "string", description: "Under 55 characters; empty for a text" },
    preview: { type: "string", description: "Preview text that adds to the subject; empty for a text" },
    sections: { type: "array", items: { type: "object", properties: { heading: { type: "string" }, body: { type: "string" } }, required: ["heading", "body"], additionalProperties: false }, description: "The body in order: a hero headline and line, then short sections, written to be designed" },
    cta: { type: "object", properties: { label: { type: "string" }, url: { type: "string" } }, required: ["label", "url"], additionalProperties: false },
    design_notes: { ...LIST, description: "For the designer: layout, imagery ([real photos only] etc.), where the button sits" },
  },
  required: ["name", "subject", "preview", "sections", "cta", "design_notes"],
  additionalProperties: false,
};
export const COPY_BRIEF_SCHEMA = {
  type: "object",
  properties: {
    goal: { type: "string", description: "What the email is for, in a sentence or two" },
    audience: { type: "string", description: "Who it goes to: the list or segment" },
    send_at: { type: "string", description: "When it goes out, as said (Monday morning, 9am ET)" },
    send_date: { type: "string", description: "YYYY-MM-DD" },
    offer: { type: "string" },
    rules: { ...LIST, description: "The client's rules that apply (real photos only, no discount words)" },
    signoff: { ...LIST, description: "What needs the client's sign-off before it sends" },
    assets: { type: "string", description: "Assets to use and where they are" },
    design_direction: { type: "string" },
  },
  additionalProperties: false,
};
export const COPY_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    short_name: { type: "string", description: "The campaign's short name for the request title (Scratch to Win, Welcome Series)" },
    emails: { type: "array", items: COPY_EMAIL_SCHEMA },
    brief: COPY_BRIEF_SCHEMA,
  },
  required: ["title", "short_name", "emails", "brief"],
  additionalProperties: false,
};
