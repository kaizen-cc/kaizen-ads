// Client emails that change who gets our emails ("please remove Sam from this distribution list, and start including
// alex@..."): the plain parts, with no server code, so they're tested. The reading, the AI and the writes are in
// contact-changes.ts.
//
//   1. prefilter: a cheap look at what the client wrote, before any AI: words about the list, and an address or a name.
//   2. The AI reads what passed (quoted history taken off) and lists who to add and who to take off, as written.
//   3. resolveRemoval: each "take off" against the client's contacts: the exact address, the part before the @, a name,
//      a near spelling, else the AI's pick from the list, but only one contact that clearly fits.
//   4. decide: applied on its own only when it is safe (the sender is the client's contact, every name resolved, no
//      teammate on it, at least one contact left), else it waits for the account team to confirm.

export type ContactLite = { id: string; email: string; name: string | null };
export type Extracted = { add: { email: string; name?: string | null }[]; remove: { asWritten: string; reason?: string | null; pick?: string | null }[]; quote: string };
export type Match = "exact" | "local" | "name" | "fuzzy" | "model";
export type Resolution = { contactId: string; match: Match } | { contactId: null; why: string; candidates: string[] };

export type ChangeStatus = "applied" | "pending" | "dismissed" | "blocked" | "undone";
export type ChangeItem = {
  kind: "add" | "remove";
  /** What the client wrote ("sam@acmeco", "Smtih", "alex@acmecorp.com") */
  asWritten: string;
  email: string | null;
  name: string | null;
  contactId: string | null;
  reason: string | null;
  match: Match | "new" | "existing" | null;
  status: ChangeStatus;
  note: string | null;
};

/** The account team that hears about a client's contacts and may confirm or undo changes: its buyers, email strategist, social manager and customer success */
export const CONTACT_TEAM_SEATS: readonly string[] = ["meta_buyer", "google_buyer", "tiktok_buyer", "email_strategist", "social_manager", "coordinator"];

export const STAFF_DOMAIN = "kaizenmarketing.agency";
/** Free mail: an address there says nothing about the company, so only the exact address counts as the client's */
export const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "comcast.net", "att.net", "verizon.net", "ymail.com", "gmx.com", "mail.com", "zoho.com", "sbcglobal.net", "bellsouth.net", "cox.net", "charter.net"]);

const EMAIL = /^[^\s@<>(),;:"'[\]]+@[^\s@<>(),;:"'[\]]+\.[a-z]{2,}$/i;
export const validEmail = (s: string | null | undefined) => {
  const e = String(s ?? "").trim().toLowerCase();
  return e.length <= 254 && EMAIL.test(e) ? e : null;
};
export const domainOf = (email: string) => email.toLowerCase().split("@")[1] ?? "";
export const isStaffEmail = (email: string) => {
  const d = domainOf(email);
  return d === STAFF_DOMAIN || d.endsWith(`.${STAFF_DOMAIN}`);
};
/** A company domain (not free mail, not ours): someone else there may speak for the client, but is only matched by domain */
export const companyDomain = (email: string) => {
  const d = domainOf(email);
  return d && !FREE_MAIL.has(d) && !isStaffEmail(email) ? d : null;
};

// ─── 1. The prefilter ───────────────────────────────────────────────────────

/** Words that only come up about who's on the list: enough on their own */
const STRONG = /\b(distribution|mailing|email|e-mail|recipient|contact)s?\s+list\b|\bstop\s+sending\b|\bunsubscribe\s+me\b|\b(take|remove)\s+(me|him|her|them)\b|\bleft\s+the\s+(company|business|team)\b|\bno\s+longer\s+(with|at|works?|working|employed|part\s+of|needs?\s+to\s+(receive|get|be))\b|\b(is|are)\s+(gone|no\s+longer\s+here)\b|\bdoes(n'?t| not)\s+need\s+to\s+(receive|get|be\s+(on|copied|included))\b|\bnew\s+(point\s+of\s+)?contact\b|\b(start|begin)\s+(including|copying|cc'?ing|sending)\b|\b(cc|copy)\s+\S+\s+(on|in)\s+(these|this|the|future|all)\b|\bin\s+place\s+of\b|\b(off|from)\s+(this|the|your|these)\s+(list|emails?|reports?|thread|distribution)\b|\bto\s+(this|the|your)\s+(list|distribution|reports?|emails?)\b/i;
/** Common words that need an address or a name close after them ("remove Sam", "add alex@...") */
const WEAK = /\b(remove|removing|add|adding|include|including|cc|copy|replace|swap)\b[^.\n!?]{0,40}?([\w.+'-]+@[\w.-]*|\b[A-Z][a-z]{2,}\b)/;

/** Whether what the client wrote might change who gets our emails: a cheap first look, the AI decides */
export function prefilter(text: string | null | undefined): boolean {
  const t = String(text ?? "").slice(0, 6000);
  if (!t.trim()) return false;
  return STRONG.test(t) || WEAK.test(t);
}

// ─── Forwards ───────────────────────────────────────────────────────────────

const FORWARD_MARK = /^\s*(?:-{3,}\s*Forwarded message\s*-{3,}|Begin forwarded message:|-{3,}\s*Original Message\s*-{3,})\s*$/im;
const OUTLOOK_HEAD = /^\s*From:\s*.+\n\s*Sent:\s*.+$/im;

/**
 * A forwarded email's original: who wrote it, and what they wrote (from after its header block). Gmail's "Forwarded
 * message", Apple Mail's "Begin forwarded message" and Outlook's From/Sent block. Null when it isn't a forward.
 */
export function parseForward(text: string | null | undefined): { from: string; fromName: string | null; body: string } | null {
  const t = String(text ?? "").replace(/\r\n/g, "\n");
  const mark = FORWARD_MARK.exec(t);
  const outlook = OUTLOOK_HEAD.exec(t);
  const at = mark ? mark.index + mark[0].length : outlook ? outlook.index : -1;
  if (at < 0) return null;
  const rest = t.slice(at).replace(/^\n+/, "");
  // The header block: lines until the first blank one (quoted ">" marks taken off)
  const lines = rest.split("\n");
  let end = 0;
  const head: string[] = [];
  for (; end < lines.length && end < 14; end++) {
    const line = lines[end].replace(/^>\s?/, "");
    if (!line.trim()) break;
    head.push(line);
  }
  const fromLine = head.find((l) => /^\s*\*?From:\*?/i.test(l));
  if (!fromLine) return null;
  const from = fromLine.toLowerCase().match(/[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/)?.[0];
  if (!from) return null;
  const fromName = fromLine.replace(/^\s*\*?From:\*?\s*/i, "").replace(/<[^>]*>|\[mailto:[^\]]*\]/g, "").replace(/[\w.%+'-]+@[\w.-]+\.[a-z]{2,}/gi, "").replace(/["*]/g, "").trim() || null;
  const body = lines.slice(end + 1).map((l) => l.replace(/^>\s?/, "")).join("\n").trim();
  return { from, fromName, body };
}

/** A sender and what they wrote, squeezed: an email read in one inbox and forwarded into another is the same request */
export function contentKey(from: string, body: string) {
  const words = body.toLowerCase().replace(/[^a-z0-9@.]+/g, " ").trim().slice(0, 200);
  return `${from.toLowerCase()}|${words}`;
}

// ─── 3. Who a "take off" means ──────────────────────────────────────────────

const letters = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
const tokensOf = (s: string) => s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 2);

/** Edits between two words (a swap of neighbours counts as one) */
function distance(a: string, b: string) {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

/** How close a written word is to one of a contact's (1 the same, an anagram 0.9, else by edits) */
function closeness(word: string, key: string) {
  if (word.length < 3 || key.length < 3) return word === key ? 1 : 0;
  if (word === key) return 1;
  if ([...word].sort().join("") === [...key].sort().join("")) return 0.9;
  return 1 - distance(word, key) / Math.max(word.length, key.length);
}

/** The words a contact goes by: their address before the @ (whole and in pieces), and their name (whole and each part) */
function keysOf(c: ContactLite) {
  const local = c.email.toLowerCase().split("@")[0];
  return [...new Set([letters(local), ...tokensOf(local), ...(c.name ? [letters(c.name), ...tokensOf(c.name)] : [])].filter((k) => k.length >= 2))];
}

/** "acmeus" read as short for "acmeoutdoorsus": every letter there, in order */
const inOrder = (short: string, long: string) => {
  let i = 0;
  for (const ch of long) if (ch === short[i]) i++;
  return short.length > 0 && i === short.length;
};

/** One contact, or none with why (and who it might be) */
const one = (list: ContactLite[], match: Match): Resolution | null => (list.length === 1 ? { contactId: list[0].id, match } : null);

/**
 * Who a "take off" means among the client's contacts (the active ones). In order: the exact address; the part before the
 * @ ("Sam@acmeus" is sam@acmeoutdoorsus.com, the domain read as short for theirs when two share the name); a name or a
 * piece of one ("Dani" in Daniela); a near spelling ("Smtih" for smith). Each only when exactly one contact fits.
 * Else the AI's pick (`pick`, an address from the list it was given), taken only when it is one of the contacts and
 * nothing written points to someone else.
 */
export function resolveRemoval(asWritten: string, contacts: readonly ContactLite[], pick?: string | null): Resolution {
  const written = asWritten.trim().toLowerCase();
  const list = contacts.filter((c) => c.email);
  const picked = pick ? list.find((c) => c.email.toLowerCase() === pick.trim().toLowerCase()) : undefined;
  const none = (why: string, candidates: ContactLite[] = []): Resolution => ({ contactId: null, why, candidates: candidates.map((c) => c.id) });
  if (!written) return none("Nothing written to match");

  // An address, whole or cut short
  const addr = written.match(/[a-z0-9._%+'-]+@[a-z0-9.-]*/)?.[0];
  if (addr) {
    const exact = list.filter((c) => c.email.toLowerCase() === addr);
    if (exact.length) return one(exact, "exact")!;
    const [local, dom = ""] = addr.split("@");
    const sameLocal = list.filter((c) => c.email.toLowerCase().split("@")[0] === local);
    const r = one(sameLocal, "local");
    if (r) return r;
    if (sameLocal.length > 1) {
      const short = letters(dom.split(".")[0]);
      const byDomain = sameLocal.filter((c) => short && inOrder(short, letters(domainOf(c.email).split(".")[0])));
      return one(byDomain, "local") ?? none(`"${asWritten}" fits more than one contact`, sameLocal);
    }
    // Fall through: the part before the @ may still be a name ("jsmith@" when the contact is john.smith@)
  }

  const words = tokensOf(addr ? addr.split("@")[0] : written).filter((w) => w.length >= 3);
  const whole = letters(addr ? addr.split("@")[0] : written);
  if (!words.length && whole.length < 3) return picked ? { contactId: picked.id, match: "model" } : none(`Couldn't read "${asWritten}"`);

  // A name, a part of one, or the whole of it
  const named = list.filter((c) => {
    const keys = keysOf(c);
    return keys.includes(whole) || words.some((w) => keys.includes(w)) || words.some((w) => w.length >= 4 && keys.some((k) => k.length > w.length && k.includes(w)));
  });
  const byName = one(named, "name");
  if (byName) return picked && picked.id !== byName.contactId ? none(`"${asWritten}" could be more than one contact`, [named[0], picked]) : byName;
  if (named.length > 1) {
    if (picked && named.some((c) => c.id === picked.id)) return { contactId: picked.id, match: "model" };
    return none(`"${asWritten}" fits more than one contact`, named);
  }

  // A near spelling: the closest contact, clearly closer than the next
  const scored = list
    .map((c) => ({ c, score: Math.max(...keysOf(c).flatMap((k) => [whole, ...words].map((w) => closeness(w, k)))) }))
    .sort((a, b) => b.score - a.score);
  const [best, next] = scored;
  if (best && best.score >= 0.75 && (!next || best.score - next.score >= 0.15)) {
    if (picked && picked.id !== best.c.id) return none(`"${asWritten}" could be more than one contact`, [best.c, picked]);
    return { contactId: best.c.id, match: "fuzzy" };
  }

  // The AI's read, with the email and the list in front of it (a nickname, a misspelling too far off to score)
  if (picked) return { contactId: picked.id, match: "model" };
  return none(`Couldn't tell who "${asWritten}" is`, scored.filter((s) => s.score >= 0.5).slice(0, 3).map((s) => s.c));
}

// ─── 4. Applied on its own, or confirmed by the team ─────────────────────────

export type Situation = {
  /** The sender is one of this client's active contacts, by their exact address */
  senderIsContact: boolean;
  /** Read from a teammate's forward, not from the client directly */
  forwarded: boolean;
  /** The client's active contacts now */
  contacts: readonly ContactLite[];
};

/**
 * The changes an email asks for, each resolved, and whether they may be applied on their own. They are, all together,
 * only when: the sender is one of the client's contacts (their exact address, and not a forward); every "take off"
 * is exactly one contact and every "add" a real address; nobody on our team is on either side; and the client keeps
 * at least one contact. Anything else waits for the account team, with why.
 */
export function decide(x: Extracted, s: Situation): { changes: ChangeItem[]; auto: boolean; why: string[] } {
  const why: string[] = [];
  const changes: ChangeItem[] = [];
  const byId = new Map(s.contacts.map((c) => [c.id, c]));
  const active = new Set(s.contacts.map((c) => c.email.toLowerCase()));
  const removing = new Set<string>();

  for (const r of x.remove) {
    const asWritten = String(r.asWritten ?? "").trim().slice(0, 120);
    if (!asWritten) continue;
    const res = resolveRemoval(asWritten, s.contacts, r.pick);
    if (res.contactId !== null) {
      // A surname and a nickname for one person in one email: taken off once
      if (removing.has(res.contactId)) continue;
      removing.add(res.contactId);
      const c = byId.get(res.contactId)!;
      changes.push({ kind: "remove", asWritten, email: c.email, name: c.name, contactId: c.id, reason: r.reason?.trim().slice(0, 200) || null, match: res.match, status: "pending", note: null });
    } else {
      why.push(res.why);
      changes.push({ kind: "remove", asWritten, email: null, name: null, contactId: null, reason: r.reason?.trim().slice(0, 200) || null, match: null, status: "pending", note: res.why });
    }
  }

  const adding = new Set<string>();
  for (const a of x.add) {
    const asWritten = String(a.email ?? "").trim().slice(0, 254);
    const email = validEmail(asWritten);
    if (!email) {
      why.push(`"${asWritten || a.name || "someone"}" isn't a full email address`);
      changes.push({ kind: "add", asWritten: asWritten || String(a.name ?? ""), email: null, name: a.name?.trim() || null, contactId: null, reason: null, match: null, status: "pending", note: "Not a full email address" });
      continue;
    }
    if (adding.has(email)) continue;
    adding.add(email);
    if (isStaffEmail(email)) {
      why.push(`${email} is on our team, not the client's`);
      changes.push({ kind: "add", asWritten, email, name: a.name?.trim() || null, contactId: null, reason: null, match: null, status: "blocked", note: "A Kaizen address is never a client contact" });
      continue;
    }
    const existing = s.contacts.find((c) => c.email.toLowerCase() === email);
    // Already on the list (and not being taken off in the same email): nothing to do
    if (existing && !removing.has(existing.id)) continue;
    changes.push({ kind: "add", asWritten, email, name: a.name?.trim().slice(0, 80) || null, contactId: existing?.id ?? null, reason: null, match: "new", status: "pending", note: null });
  }

  for (const c of changes) if (c.kind === "remove" && c.email && isStaffEmail(c.email)) why.push(`${c.email} is on our team`);
  if (!changes.length) return { changes, auto: false, why };

  if (s.forwarded) why.push("Forwarded by a teammate, not sent by the client");
  else if (!s.senderIsContact) why.push("The sender isn't one of their contacts (only their company's domain matches)");
  const left = [...active].filter((e) => ![...removing].some((id) => byId.get(id)?.email.toLowerCase() === e)).length + changes.filter((c) => c.kind === "add" && c.email && c.status === "pending" && !active.has(c.email)).length;
  if (removing.size && left < 1) why.push("It would leave them with no contact");

  return { changes, auto: why.length === 0, why: [...new Set(why)] };
}

/** "took Sam Lee (sam@x.com) off and added alex@x.com", for the notice */
export function describeChanges(changes: readonly ChangeItem[], verb: "did" | "asks" = "did") {
  const who = (c: ChangeItem) => (c.name && c.email ? `${c.name} (${c.email})` : c.email ?? `"${c.asWritten}"`);
  const off = changes.filter((c) => c.kind === "remove").map(who);
  const on = changes.filter((c) => c.kind === "add").map(who);
  const list = (xs: string[]) => (xs.length <= 2 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  const parts = verb === "did" ? [off.length ? `took ${list(off)} off` : "", on.length ? `added ${list(on)}` : ""] : [off.length ? `take ${list(off)} off` : "", on.length ? `add ${list(on)}` : ""];
  return parts.filter(Boolean).join(" and ");
}
