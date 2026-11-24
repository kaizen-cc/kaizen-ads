// Client emails drafted from conversations, the pure part: what the AI hands back is checked and cleaned here (kinds,
// subject and body present, Kaizen's no-em-dash rule, a sensible length), each draft gets a stable key so a scan never
// drafts the same thing twice, and the right person is picked to send it. No database, no AI.

export const DRAFT_KINDS = ["promise", "follow_up", "apology", "upsell", "report", "other"] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];
export const DRAFT_KIND_LABEL: Record<DraftKind, string> = { promise: "Promise", follow_up: "Follow-up", apology: "Correction", upsell: "Offer", report: "Report", other: "Note" };

export const SOURCE_KINDS = ["call", "commitment", "slack", "email", "upsell", "meeting", "assistant"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** The line the email is about, so it goes from the person on that seat */
export type DraftLine = "ads" | "meta" | "google" | "tiktok" | "email" | "social" | "creative" | "account";

export type DraftItem = {
  kind: DraftKind;
  subject: string;
  body: string;
  /** Why it needs an email, in a line ("Promised the new landing page by Friday on the Nov 12 call") */
  reason: string;
  sourceKind: SourceKind;
  sourceId: string | null;
  line: DraftLine;
};

const LINES: readonly DraftLine[] = ["ads", "meta", "google", "tiktok", "email", "social", "creative", "account"];

/** Kaizen's writing rules on a draft: no em or en dashes as punctuation, no stray markdown, tidy spacing */
export function cleanDraftText(s: unknown, max = 6000): string {
  return String(s ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\s+[—–]\s+/g, ", ")
    .replace(/[—–]/g, "-")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

const oneLine = (s: unknown, max: number) => cleanDraftText(s, max * 2).replace(/\s+/g, " ").trim().slice(0, max);

/**
 * The AI's answer as drafts: accepts { items: [...] }, a bare array, or JSON text (fenced or not). Anything without a
 * subject and a body is dropped; unknown kinds become "other", unknown sources the fallback. At most `max`.
 */
export function parseDraftItems(raw: unknown, fallbackSource: SourceKind = "call", max = 10): DraftItem[] {
  let v: unknown = raw;
  if (typeof v === "string") {
    const text = v.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    try {
      v = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      try {
        v = m ? JSON.parse(m[0]) : null;
      } catch {
        v = null;
      }
    }
  }
  const list = Array.isArray(v) ? v : v && typeof v === "object" && Array.isArray((v as { items?: unknown }).items) ? (v as { items: unknown[] }).items : [];
  const out: DraftItem[] = [];
  for (const x of list) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const subject = oneLine(o.subject, 140);
    const body = cleanDraftText(o.body);
    if (!subject || body.length < 20) continue;
    const kind = (DRAFT_KINDS as readonly string[]).includes(String(o.kind)) ? (o.kind as DraftKind) : "other";
    const sourceKind = (SOURCE_KINDS as readonly string[]).includes(String(o.source_kind ?? o.sourceKind)) ? (String(o.source_kind ?? o.sourceKind) as SourceKind) : fallbackSource;
    const sid = o.source_id ?? o.sourceId;
    const line = (LINES as readonly string[]).includes(String(o.line)) ? (o.line as DraftLine) : "account";
    out.push({ kind, subject, body, reason: oneLine(o.reason, 240), sourceKind, sourceId: sid == null || sid === "" ? null : String(sid).slice(0, 80), line });
    if (out.length >= max) break;
  }
  return out;
}

/** A stable key for a draft: the same promise or upsell found again maps to the same key (no second draft) */
export function draftKey(clientId: string, d: Pick<DraftItem, "kind" | "sourceKind" | "sourceId" | "subject">): string {
  const subj = d.subject.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").slice(0, 6).join("-");
  return [clientId, d.sourceKind, d.sourceId ?? subj, d.kind].join(":").slice(0, 300);
}

/** The seat that owns a line's emails to the client */
const SEAT_OF: Record<DraftLine, readonly string[]> = {
  ads: ["meta_buyer", "google_buyer", "tiktok_buyer"],
  meta: ["meta_buyer"],
  google: ["google_buyer"],
  tiktok: ["tiktok_buyer", "meta_buyer"],
  email: ["email_strategist"],
  social: ["social_manager"],
  // An email to the client about creative is the account's (its buyer), never the designer's or editor's (owner, Nov 24
  // 2026: designers were handed client emails they don't send)
  creative: ["meta_buyer", "google_buyer", "tiktok_buyer", "social_manager"],
  account: ["meta_buyer", "google_buyer", "email_strategist", "social_manager"],
};

/**
 * Who sends it: whoever made the promise on the call when they're on the team, else the person on the line's seat, else
 * the client's first seat holder, else the one asking (a bulk draft from the assistant is theirs).
 */
export function pickOwner(o: { line: DraftLine; speakerId?: string | null; seats: Readonly<Record<string, string | null | undefined>>; fallbackId?: string | null }): string | null {
  if (o.speakerId) return o.speakerId;
  for (const seat of SEAT_OF[o.line]) if (o.seats[seat]) return o.seats[seat] as string;
  for (const seat of SEAT_OF.account) if (o.seats[seat]) return o.seats[seat] as string;
  return o.fallbackId ?? null;
}

/** A compose link that opens with the draft filled in, for when it can't be put in their Gmail: Gmail's own, then mailto */
export function composeLinks(d: { to: readonly string[]; subject: string; body: string }): { gmail: string; mailto: string } {
  const to = d.to.filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)).join(",");
  const q = (k: string, v: string) => `${k}=${encodeURIComponent(v)}`;
  return {
    gmail: `https://mail.google.com/mail/?view=cm&fs=1&${[q("to", to), q("su", d.subject), q("body", d.body.slice(0, 1800))].join("&")}`,
    mailto: `mailto:${to}?${[q("subject", d.subject), q("body", d.body.slice(0, 1800))].join("&")}`,
  };
}

export type Revision = { reply: string; subject: string; body: string };

/**
 * The AI's rewrite of a draft under review, cleaned like any draft. A missing or too-short subject or body keeps the
 * current one (a question back changes nothing); the reply is one line to the person.
 */
export function parseRevision(raw: unknown, current: { subject: string; body: string }): Revision {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const subject = oneLine(o.subject, 200);
  const body = cleanDraftText(o.body, 8000);
  return {
    reply: oneLine(o.reply, 400) || "Done.",
    subject: subject || current.subject,
    body: body.length >= 20 ? body : current.body,
  };
}
