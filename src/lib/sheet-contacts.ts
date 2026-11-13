// The client contacts on the Kaizen Account Overview sheet: the points of contact (the "POC" columns) and a column of
// any other emails (the header is matched loosely: "Any other emails", "Other Emails", "Additional emails", "CC"…), on
// every tab (Meta, Google, TikTok). Plain functions (no server code) so the parsing is tested; the sync that adds them
// to the client's contacts is syncSheetContacts in account-sheet.ts.

export type SheetContact = { email: string; name: string | null };

const EMAIL = /^[^\s@<>(),;:"'[\]]+@[^\s@<>(),;:"'[\]]+\.[a-z]{2,}$/i;
const EMAIL_IN_TEXT = /[^\s@<>(),;:"'[\]|]+@[^\s@<>(),;:"'[\]|]+\.[a-z]{2,}/gi;
/** The agency's own addresses are never a client's contact */
const AGENCY = /@([\w-]+\.)*kaizenmarketing\.agency$/i;

/** Every valid address in a cell (split on commas, semicolons, spaces and new lines; "mailto:" and <> taken off), lowercased, once each */
export function parseEmails(text: string | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of String(text ?? "").split(/[\s,;|]+/)) {
    const t = raw.trim().replace(/^mailto:/i, "").replace(/^[<(["']+|[>)\]"'.:]+$/g, "");
    const e = t.toLowerCase();
    if (!e || e.length > 254 || !EMAIL.test(e) || AGENCY.test(e) || seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

const NOT_A_NAME = /^(n\/?a|none|tbd|tba|yes|no|-+|unknown|same|see notes?)$/i;

/** The name next to an address in a cell ("Jane Doe <jane@x.com>" gives "Jane Doe"), or null when the cell has no clean name */
export function nameFrom(cell: string | null | undefined): string | null {
  const t = String(cell ?? "").replace(EMAIL_IN_TEXT, " ").replace(/mailto:/gi, " ").replace(/[<>()[\]"';,|:\-–—]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t || NOT_A_NAME.test(t) || /\d/.test(t) || t.length < 2 || t.length > 60) return null;
  return /^\p{L}[\p{L} .'’]*$/u.test(t) ? t : null;
}

export const isOtherEmailsHeader = (h: string) => /other.*e-?mail|additional.*e-?mail|e-?mails?.*\bcc\b|^\s*cc\b|\bcc\s*e-?mail/i.test(h);
export const isPocHeader = (h: string) => !isOtherEmailsHeader(h) && /\bpoc\b|point.?s?.?of.?contact|^\s*(client |primary )?contacts?\b/i.test(h);
const isEmailHeader = (h: string) => /e-?mail/i.test(h);
const isNameHeader = (h: string) => /name/i.test(h) && !isEmailHeader(h);
/** "POC 2 Email" and "POC 2" belong together: the digits in a header pair a name column with its email column */
const groupOf = (h: string) => h.match(/\d+/)?.[0] ?? "";

/** The contacts on one row: the points of contact (with a name when the sheet gives one) and every other email, each address once */
export function contactsOfRow(head: readonly string[], row: readonly string[]): SheetContact[] {
  const cell = (i: number) => String(row[i] ?? "").trim();
  const heads = head.map((h) => String(h ?? "").trim());
  const nameCols = new Map<string, string>();
  heads.forEach((h, i) => {
    if (isPocHeader(h) && isNameHeader(h) && cell(i)) nameCols.set(groupOf(h), cell(i));
  });
  const out = new Map<string, SheetContact>();
  const add = (email: string, name: string | null) => {
    const have = out.get(email);
    if (!have) out.set(email, { email, name });
    else if (!have.name && name) have.name = name;
  };
  heads.forEach((h, i) => {
    if (!h || !cell(i)) return;
    if (isPocHeader(h) && !isNameHeader(h)) {
      const emails = parseEmails(cell(i));
      const name = emails.length === 1 ? (nameFrom(cell(i)) ?? nameFrom(nameCols.get(groupOf(h)) ?? (nameCols.size === 1 ? [...nameCols.values()][0] : null))) : null;
      for (const e of emails) add(e, name);
    } else if (isOtherEmailsHeader(h)) {
      const emails = parseEmails(cell(i));
      for (const e of emails) add(e, emails.length === 1 ? nameFrom(cell(i)) : null);
    }
  });
  return [...out.values()];
}

const CLIENT_NAME = ["Client Name", "Clients", "Client", "Business Name"];

/** A tab's rows with a client name: its contacts, and the row as header → text (for the ad account on it) */
export function contactsFromTab(values: string[][]): { name: string; row: Record<string, string>; contacts: SheetContact[] }[] {
  const [head = [], ...rest] = values;
  const out: { name: string; row: Record<string, string>; contacts: SheetContact[] }[] = [];
  for (const r of rest) {
    const row = Object.fromEntries(head.map((h, i) => [String(h ?? "").trim(), String(r[i] ?? "").trim()]));
    const name = CLIENT_NAME.map((k) => row[k]).find(Boolean) ?? "";
    if (!name || /^tier \d/i.test(name)) continue;
    const contacts = contactsOfRow(head, r);
    if (contacts.length) out.push({ name, row, contacts });
  }
  return out;
}
