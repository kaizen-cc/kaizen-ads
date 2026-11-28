// Messages the assistant drafts and sends as the person: where a Slack reply goes (from the stored message keys), the
// email itself (headers that keep it in the thread, files attached as multipart MIME, encoded the way Gmail takes it),
// and whether a tool's answer was a failure on our side (so a yes isn't used up by it). Pure: no keys, no network,
// tested on its own.

/** A Slack message's place from how it's stored ("C123:1700000000.0001" keys; a thread key when it's in one) */
export function slackPlace(externalId: string, threadId: string | null | undefined): { channel: string; thread: string } | null {
  const [channel, ts] = externalId.split(":");
  if (!channel || !ts || !/^[CGD][A-Z0-9]+$/.test(channel)) return null;
  const t = threadId?.split(":")[1] ?? null;
  return { channel, thread: t || ts };
}

/** "Re: Subject" once, however many times it's been replied to */
export const reSubject = (subject: string) => (/^\s*re:/i.test(subject) ? subject.trim() : `Re: ${subject.trim() || "(no subject)"}`);

/** Just the address in "Dana Kim <dana@x.com>" */
export const addressOf = (header: string) => (header.match(/<([^>]+)>/)?.[1] ?? header).trim();

const headerSafe = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

/** Base64url, the way Gmail's API takes a raw message */
export const base64url = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** RFC 2047 for a header with anything beyond plain ASCII */
const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

/** A file on an email: its name, type and bytes */
export type MailAttachment = { name: string; mime: string; data: Uint8Array };

export type MailParts = {
  from: string;
  to: string;
  cc?: string | null;
  subject: string;
  body: string;
  inReplyTo?: string | null;
  references?: string | null;
  attachments?: readonly MailAttachment[];
  /** Their own Gmail signature (HTML, as Gmail's settings give it), added under the text */
  signature?: string | null;
};

const CRLF = "\r\n";

/** Base64 wrapped at 76 characters, the way MIME bodies carry it */
const wrap76 = (b64: string) => (b64.match(/.{1,76}/g) ?? []).join(CRLF);

/** A file name safe inside a quoted header parameter (RFC 2231 when it isn't plain ASCII) */
function fileParam(key: "filename" | "name", name: string): string {
  const clean =
    name
      .replace(/["\\\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "attachment";
  if (/^[\x20-\x7e]*$/.test(clean)) return `${key}="${clean}"`;
  return `${key}*=UTF-8''${encodeURIComponent(clean)}`;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Linked words the way the assistant writes them ("[pick a time here](https://…)"), and a bare web address */
const LINKS = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>]*[^\s<>.,!?;:'")\]])/g;
/** Words in **bold** */
const BOLD = /\*\*([^*\n]+)\*\*/g;

/** A markdown table's divider row ("|---|:---:|") */
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const isTableRow = (line: string) => line.includes("|") && line.trim() !== "";
/** A table row's cells ("| a | b |" → ["a", "b"]); an escaped "\|" stays in its cell */
const tableCells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, "|").trim());

type BodyPiece = { text: string } | { head: string[]; rows: string[][] };

/** The text cut into its markdown tables (a header row, a divider, then rows) and the words between them */
function bodyPieces(text: string): BodyPiece[] {
  const lines = text.split(/\r?\n/);
  const out: BodyPiece[] = [];
  let words: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isTableRow(lines[i]) && lines[i + 1] !== undefined && lines[i + 1].includes("|") && TABLE_RULE.test(lines[i + 1])) {
      if (words.length) out.push({ text: words.join("\n") });
      words = [];
      const head = tableCells(lines[i]);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) rows.push(tableCells(lines[i++]));
      i--;
      out.push({ head, rows });
    } else words.push(lines[i]);
  }
  if (words.length) out.push({ text: words.join("\n") });
  return out;
}

/** Whether the text has a markdown table, which plain text can't show */
const hasTable = (text: string) => bodyPieces(text).some((p) => "head" in p);

/** Whether the text needs HTML to read right: linked words, bold or a table (a bare address Gmail links by itself) */
const hasMarkup = (text: string) => /\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)/.test(text) || /\*\*[^*\n]+\*\*/.test(text) || hasTable(text);

/** A table row as one dash line: "- Gift Card 1 · Send date: Dec 1 · Exclusions: V3" (empty cells left out) */
function tableDashLine(head: string[], row: string[]): string {
  const [first, ...rest] = row;
  const parts = rest.map((c, k) => (c ? (head[k + 1] ? `${head[k + 1]}: ${c}` : c) : "")).filter(Boolean);
  return `- ${[first || (head[0] ? `${head[0]}: -` : ""), ...parts].filter(Boolean).join(" · ")}`;
}

/** The plain text part: linked words read "words (address)", bold marks dropped, a markdown table as one dash line per row */
export function plainBody(text: string): string {
  const flat = bodyPieces(text)
    .map((p) => ("head" in p ? p.rows.map((r) => tableDashLine(p.head, r)).join("\n") : p.text))
    .join("\n");
  return flat.replace(LINKS, (m, label: string | undefined, href: string | undefined) => (label && href ? `${label} (${href})` : m)).replace(BOLD, "$1");
}

const CELL = 'style="border:1px solid #d0d0d0;padding:6px 10px;text-align:left;vertical-align:top"';

/** A markdown table as a real HTML table, which Gmail shows as one */
function htmlTable(head: string[], rows: string[][]): string {
  const cols = Math.max(head.length, ...rows.map((r) => r.length));
  const cells = (r: string[], tag: "th" | "td") => Array.from({ length: cols }, (_, k) => `<${tag} ${CELL}>${htmlWords(r[k] ?? "")}</${tag}>`).join("");
  return `<table style="border-collapse:collapse;margin:8px 0"><thead><tr>${cells(head, "th")}</tr></thead><tbody>${rows.map((r) => `<tr>${cells(r, "td")}</tr>`).join("")}</tbody></table>`;
}

/** The HTML part: the text escaped, linked words as real links, bold as bold, each line break kept, a markdown table as a table */
export function htmlBody(text: string): string {
  return bodyPieces(text)
    .map((p) => ("head" in p ? htmlTable(p.head, p.rows) : htmlWords(p.text)))
    .join("\r\n");
}

/** Words as HTML: escaped, linked words as real links, bold as bold, each line break kept */
function htmlWords(text: string): string {
  let out = "";
  let at = 0;
  const inline = (s: string) => escapeHtml(s).replace(BOLD, "<b>$1</b>");
  for (const m of text.matchAll(LINKS)) {
    out += inline(text.slice(at, m.index));
    const href = m[2] ?? m[3];
    out += `<a href="${escapeHtml(href)}">${m[1] ? inline(m[1]) : escapeHtml(href)}</a>`;
    at = m.index + m[0].length;
  }
  out += inline(text.slice(at));
  return out.replace(/\r?\n/g, "<br>\r\n");
}

/** A Gmail signature (HTML) as plain text, for the plain part */
export function signatureText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:div|p|li|tr|h[1-6])>/gi, "\n")
    .replace(/<a\s[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const l = label.replace(/<[^>]+>/g, "").trim();
      return l && l !== href ? `${l} (${href})` : href;
    })
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The body as the two forms an email carries: plain text (linked words as "words (address)", the signature as text)
 * and, when it has links, bold or a signature, the HTML (real links, their Gmail signature where Gmail puts it). The
 * one source for the REST draft (MIME) and the MCP draft, so both read the same in Gmail.
 */
export function emailBodies(body: string, signature?: string | null): { plain: string; html: string | null } {
  const sig = signature?.trim() || "";
  const sigText = sig ? signatureText(sig) : "";
  const plain = plainBody(body) + (sigText ? `\n\n${sigText}` : "");
  if (!sig && !hasMarkup(body)) return { plain, html: null };
  return { plain, html: `<div dir="ltr">${htmlBody(body)}${sig ? `<br><br><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature">${sig}</div>` : ""}</div>` };
}

/**
 * The body as MIME: plain text alone when it's just words, else multipart/alternative with an HTML part (real links,
 * their Gmail signature where Gmail puts it) after the plain one. The HTML in base64, so long lines are safe.
 */
function bodyPart(m: MailParts, boundary: string): string[] {
  const forms = emailBodies(m.body, m.signature);
  const plain = forms.plain.replace(/\r?\n/g, CRLF);
  if (!forms.html) return ['Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: 8bit", "", plain];
  const html = forms.html;
  const b = `${boundary}_alt`;
  return [
    `Content-Type: multipart/alternative; boundary="${b}"`,
    "",
    `--${b}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    plain,
    `--${b}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(html, "utf8").toString("base64")),
    `--${b}--`,
  ];
}

/**
 * The whole message as MIME text: the body (plain text, or plain and HTML when it has links or a signature) alone
 * when there's nothing attached, else multipart/mixed with the body first and each file as a base64 attachment. `boundary` is fixed in tests; a random one otherwise.
 */
export function mimeMessage(m: MailParts, boundary = `kaizen_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`): string {
  const head = [
    `From: ${headerSafe(m.from)}`,
    `To: ${headerSafe(m.to)}`,
    ...(m.cc ? [`Cc: ${headerSafe(m.cc)}`] : []),
    `Subject: ${encodeHeader(headerSafe(m.subject))}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${headerSafe(m.inReplyTo)}`] : []),
    ...(m.inReplyTo || m.references ? [`References: ${headerSafe([m.references, m.inReplyTo].filter(Boolean).join(" "))}`] : []),
    "MIME-Version: 1.0",
  ];
  const files = (m.attachments ?? []).filter((a) => a.data.length > 0);
  const b = boundary.replace(/[^A-Za-z0-9'()+_,./:=?-]/g, "");
  if (!files.length) return [...head, ...bodyPart(m, b)].join(CRLF);
  const parts = [
    [`--${b}`, ...bodyPart(m, b)].join(CRLF),
    ...files.map((f) =>
      [`--${b}`, `Content-Type: ${headerSafe(f.mime) || "application/octet-stream"}; ${fileParam("name", f.name)}`, `Content-Disposition: attachment; ${fileParam("filename", f.name)}`, "Content-Transfer-Encoding: base64", "", wrap76(Buffer.from(f.data).toString("base64"))].join(CRLF),
    ),
  ];
  return [...head, `Content-Type: multipart/mixed; boundary="${b}"`, "", ...parts, `--${b}--`, ""].join(CRLF);
}

/**
 * An email (a reply in its thread when In-Reply-To and References are given) as Gmail's raw message: UTF-8, headers on
 * one line each (no header injection from a subject or a name), any files attached.
 */
export function rawEmail(m: MailParts): string {
  return base64url(mimeMessage(m));
}

/** Every address in a header list ("Dana <d@x.com>, e@y.com"), lowercased */
export const addressesIn = (header: string | null | undefined) => [...new Set((String(header ?? "").match(/[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? []).map((a) => a.toLowerCase()))];

/**
 * Reply all: everyone else on the last message (its To and Cc) on Cc, never the person themselves nor whoever the reply
 * already goes to. Null when nobody's left.
 */
export function replyAllCc(last: { to: string; cc?: string | null }, mailbox: string, replyingTo: string): string | null {
  const skip = new Set([mailbox.toLowerCase(), ...addressesIn(replyingTo)]);
  const rest = [...addressesIn(last.to), ...addressesIn(last.cc)].filter((a) => !skip.has(a));
  return rest.length ? [...new Set(rest)].join(", ") : null;
}

/**
 * A Gmail thread the person pointed at: a thread id from a search (hex), or a Gmail link whose last part is one
 * ("…/#inbox/18c2f0a1b2c3d4e5"). Gmail's newer link tokens ("FMfcg…") can't be read by the API: null.
 */
export function gmailThreadId(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (/^[0-9a-f]{12,24}$/i.test(s)) return s.toLowerCase();
  const m = s.match(/mail\.google\.com\/[^#]*#[^/]+(?:\/[^/?#]+)*\/([0-9a-f]{12,24})(?:[/?#]|$)/i);
  return m ? m[1].toLowerCase() : null;
}

/** "Re: Fwd: BFCM offer" → "BFCM offer": the subject a reply's thread is found by */
export const subjectCore = (s: string) => s.replace(/^\s*((re|fwd?|fw|aw)\s*:\s*)+/i, "").replace(/\s+/g, " ").trim();

/** Who a reply goes to: the last message's sender, or (when that was the person themselves) who they wrote to */
export function replyTo(last: { from: string; to: string; replyTo?: string | null }, mailbox: string): string {
  const from = addressOf(last.from).toLowerCase();
  if (from === mailbox.toLowerCase()) return last.to;
  return last.replyTo?.trim() || last.from;
}

/**
 * Whether a tool's answer means it didn't happen for a reason the person didn't cause (an error, a failed send), as
 * opposed to "not run: ask first" or a question back. A yes given for it carries to the next try.
 */
export function failedOnOurSide(out: unknown): boolean {
  if (!out || typeof out !== "object") return false;
  const o = out as Record<string, unknown>;
  if (typeof o.note === "string" && /^Not run: (?:say|ask)/.test(o.note)) return false;
  if (Array.isArray(o.options)) return false;
  return Boolean(o.error) || o.sent === false || o.ok === false || (o.done === false && Boolean(o.error));
}
