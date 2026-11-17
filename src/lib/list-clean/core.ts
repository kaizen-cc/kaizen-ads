// Cleans a contact list (the rows of a CSV or Excel file) to what Klaviyo's importer wants: the email column found and
// normalised, invalid, duplicate, disposable and role addresses taken out (each with its reason), phone numbers in
// E.164, names split and title-cased, consent columns turned into one $consent column, and the headers renamed to
// Klaviyo's own profile properties ($email, $first_name, $last_name, $phone_number, $city, $region, $country, $zip...)
// with every other column kept as a custom property. Pure: no server or browser APIs, so it's tested on its own
// (tests/list-clean.test.ts) and runs 100,000 rows in about a second.

// ─── Addresses ───────────────────────────────────────────────────────────────────────────────────────────────────────

const EMAIL = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const TLD = /^(?:[a-z]{2,24}|xn--[a-z0-9-]{2,59})$/;

/** Whether a (lowercased) address is one a mail server could accept */
export function validEmail(e: string): boolean {
  if (e.length > 254 || !EMAIL.test(e)) return false;
  const at = e.lastIndexOf("@");
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  return TLD.test(domain.slice(domain.lastIndexOf(".") + 1));
}

const DOMAIN_FIXES: Record<string, string> = {
  "gmial.com": "gmail.com", "gmai.com": "gmail.com", "gamil.com": "gmail.com", "gmal.com": "gmail.com", "gnail.com": "gmail.com", "gmaill.com": "gmail.com", "gemail.com": "gmail.com", "gmail.co": "gmail.com", "gmail.cm": "gmail.com", "gmail.om": "gmail.com",
  "yahooo.com": "yahoo.com", "yaho.com": "yahoo.com", "yhoo.com": "yahoo.com", "yahoo.co": "yahoo.com", "yahoo.cm": "yahoo.com",
  "hotnail.com": "hotmail.com", "hotmial.com": "hotmail.com", "homail.com": "hotmail.com", "hotmal.com": "hotmail.com", "hotmail.co": "hotmail.com",
  "outlok.com": "outlook.com", "outloo.com": "outlook.com", "outlook.co": "outlook.com",
  "iclould.com": "icloud.com", "icoud.com": "icloud.com", "icloud.co": "icloud.com",
  "comcast.nt": "comcast.net", "aol.co": "aol.com",
};
const TLD_TYPO = /\.(con|cmo|ocm|vom|xom|comm|coom|cim)$/;

const DISPOSABLE = new Set(
  ("mailinator.com guerrillamail.com guerrillamail.net guerrillamail.org guerrillamail.biz guerrillamailblock.com sharklasers.com grr.la 10minutemail.com 10minutemail.net 20minutemail.com tempmail.com temp-mail.org temp-mail.io tempmail.net tempmailo.com tempr.email trashmail.com trashmail.net trash-mail.com yopmail.com yopmail.net yopmail.fr getnada.com nada.email maildrop.cc dispostable.com fakeinbox.com throwawaymail.com throwam.com mintemail.com mailnesia.com mohmal.com emailondeck.com getairmail.com spamgourmet.com spam4.me mytemp.email burnermail.io discard.email discardmail.com anonbox.net mailcatch.com tmpmail.org tmpmail.net moakt.com mail-temp.com fakemail.net fake-mail.net emailfake.com crazymailing.com inboxkitten.com harakirimail.com mailforspam.com spambox.us mailtemp.info luxusmail.org tempinbox.com instantemailaddress.com jetable.org mvrht.net owlymail.com sogetthis.com").split(" "),
);

const ROLE = new Set(
  ("abuse admin administrator billing compliance contact customerservice devnull dns enquiries enquiry feedback ftp help hello helpdesk hostmaster hr info inoc inquiries inquiry ispfeedback ispsupport jobs list list-request maildaemon mailer-daemon marketing media newsletter noc no-reply noreply no_reply donotreply do-not-reply null office orders phish phishing postmaster press privacy registrar root sales security service spam subscribe support sysadmin team tech undisclosed-recipients unsubscribe usenet uucp webmaster www").split(" "),
);

const PLACEHOLDER_DOMAIN = new Set(["example.com", "example.org", "example.net", "test.com", "none.com", "noemail.com", "nomail.com", "domain.com", "email.test", "mail.test"]);
const PLACEHOLDER_LOCAL = new Set(["test", "testing", "none", "noemail", "no-email", "nomail", "na", "n-a", "null", "unknown", "asdf", "abc", "xxx", "email", "name"]);

/** The address in a cell, lowercased and trimmed ("Jo <JO@X.com>" and "mailto:jo@x.com;" included), with whether it had to be repaired */
export function normalizeEmail(raw: string): { email: string; fixed: boolean } {
  let s = raw.replace(/[​-‍⁠﻿ ]/g, " ").trim();
  const angle = s.match(/<([^<>]+)>/);
  if (angle) s = angle[1];
  s = s.replace(/^mailto:/i, "");
  if (/[;,\s]/.test(s.trim())) s = s.split(/[;,\s]+/).find((p) => p.includes("@")) ?? s;
  s = s.replace(/^[\s"'<(]+|[\s"'>).,;:]+$/g, "").toLowerCase();
  const at = s.lastIndexOf("@");
  if (at > 0) {
    let domain = s.slice(at + 1);
    const known = DOMAIN_FIXES[domain];
    if (known) domain = known;
    else if (TLD_TYPO.test(domain)) domain = domain.replace(TLD_TYPO, ".com");
    if (domain !== s.slice(at + 1)) s = `${s.slice(0, at)}@${domain}`;
  }
  // Repaired: more than the case changed (spaces, brackets, a mistyped domain)
  return { email: s, fixed: s !== raw.trim().toLowerCase() };
}

export type EmailFlag = "disposable" | "role" | "placeholder" | null;
/** Whether a valid address is a throwaway, a shared role inbox (info@, support@) or an obvious placeholder */
export function emailFlag(e: string): EmailFlag {
  const at = e.lastIndexOf("@");
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (PLACEHOLDER_DOMAIN.has(domain) || PLACEHOLDER_LOCAL.has(local)) return "placeholder";
  if (DISPOSABLE.has(domain)) return "disposable";
  if (ROLE.has(local.replace(/[+].*$/, ""))) return "role";
  return null;
}

// ─── Phone numbers ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Calling code and the length of the number after it (and whether numbers are dialled with a leading 0 at home) */
const COUNTRIES: Record<string, { code: string; min: number; max: number; trunk?: boolean }> = {
  US: { code: "1", min: 10, max: 10 }, CA: { code: "1", min: 10, max: 10 }, GB: { code: "44", min: 9, max: 10, trunk: true }, IE: { code: "353", min: 7, max: 9, trunk: true },
  AU: { code: "61", min: 9, max: 9, trunk: true }, NZ: { code: "64", min: 8, max: 10, trunk: true }, DE: { code: "49", min: 6, max: 13, trunk: true }, FR: { code: "33", min: 9, max: 9, trunk: true },
  ES: { code: "34", min: 9, max: 9 }, IT: { code: "39", min: 6, max: 11 }, NL: { code: "31", min: 9, max: 9, trunk: true }, BE: { code: "32", min: 8, max: 9, trunk: true },
  CH: { code: "41", min: 9, max: 9, trunk: true }, AT: { code: "43", min: 4, max: 13, trunk: true }, SE: { code: "46", min: 7, max: 13, trunk: true }, NO: { code: "47", min: 8, max: 8 },
  DK: { code: "45", min: 8, max: 8 }, FI: { code: "358", min: 5, max: 12, trunk: true }, PT: { code: "351", min: 9, max: 9 }, PL: { code: "48", min: 9, max: 9 },
  MX: { code: "52", min: 10, max: 10 }, BR: { code: "55", min: 10, max: 11, trunk: true }, AR: { code: "54", min: 10, max: 11 }, CO: { code: "57", min: 10, max: 10 }, CL: { code: "56", min: 9, max: 9 },
  IN: { code: "91", min: 10, max: 10, trunk: true }, PK: { code: "92", min: 10, max: 10, trunk: true }, SG: { code: "65", min: 8, max: 8 }, HK: { code: "852", min: 8, max: 8 },
  JP: { code: "81", min: 9, max: 10, trunk: true }, KR: { code: "82", min: 8, max: 10, trunk: true }, CN: { code: "86", min: 11, max: 11 }, PH: { code: "63", min: 10, max: 10, trunk: true },
  ZA: { code: "27", min: 9, max: 9, trunk: true }, AE: { code: "971", min: 8, max: 9, trunk: true }, IL: { code: "972", min: 8, max: 9, trunk: true }, TR: { code: "90", min: 10, max: 10, trunk: true },
};
export const COUNTRY_CODES = Object.keys(COUNTRIES);
const ALIASES: Record<string, string> = { USA: "US", "UNITED STATES": "US", "UNITED STATES OF AMERICA": "US", AMERICA: "US", UK: "GB", "UNITED KINGDOM": "GB", ENGLAND: "GB", "GREAT BRITAIN": "GB", CANADA: "CA", AUSTRALIA: "AU", "NEW ZEALAND": "NZ", IRELAND: "IE", GERMANY: "DE", FRANCE: "FR", SPAIN: "ES", ITALY: "IT", MEXICO: "MX", INDIA: "IN" };

/** A country as its two letter code (from "US", "usa", "United States"), or null when it isn't one the phone rules know */
export function countryCode(v: string | null | undefined): string | null {
  const s = (v ?? "").trim().toUpperCase();
  if (!s) return null;
  if (COUNTRIES[s]) return s;
  return ALIASES[s] ?? null;
}

// Longest calling codes first, so 353 is read before 3 digits that start the same way
const CODES = [...new Set(Object.values(COUNTRIES).map((c) => c.code))].sort((a, b) => b.length - a.length);
const nanp = (n: string) => n.length === 10 && /^[2-9]\d{2}[2-9]\d{6}$/.test(n) && !/^(\d)\1+$/.test(n);
const boring = (d: string) => /^(\d)\1+$/.test(d) || d === "1234567890" || d === "0123456789";

/** A phone number as E.164 (+15551234567), or null when it can't be one. Numbers without a country code take `country`'s. */
export function normalizePhone(raw: string, country = "US"): string | null {
  let s = raw.trim();
  if (!s) return null;
  s = s.replace(/\s*(?:ext\.?|extension|x|#)\s*\d{1,6}\s*$/i, "");
  const plus = /^\s*\(?\s*\+/.test(s);
  let digits = s.replace(/\D/g, "");
  if (!digits || boring(digits)) return null;
  let international = plus;
  if (!plus && /^00/.test(digits)) {
    digits = digits.slice(2);
    international = true;
  } else if (!plus && country === "US" && /^011/.test(digits) && digits.length > 11) {
    digits = digits.slice(3);
    international = true;
  }
  const cfg = COUNTRIES[country] ?? COUNTRIES.US;
  if (international) {
    if (digits.length < 8 || digits.length > 15) return null;
    const code = CODES.find((c) => digits.startsWith(c));
    if (code === "1") return nanp(digits.slice(1)) ? `+${digits}` : null;
    if (code) {
      const n = digits.slice(code.length);
      const ok = Object.values(COUNTRIES).some((c) => c.code === code && n.length >= c.min && n.length <= c.max);
      return ok ? `+${digits}` : null;
    }
    return `+${digits}`;
  }
  if (cfg.code === "1") {
    if (digits.length === 10 && nanp(digits)) return `+1${digits}`;
    if (digits.length === 11 && digits[0] === "1" && nanp(digits.slice(1))) return `+${digits}`;
  } else {
    const startsWithCode = digits.startsWith(cfg.code) && digits.length - cfg.code.length >= cfg.min && digits.length - cfg.code.length <= cfg.max && !digits.startsWith(`${cfg.code}0`);
    if (startsWithCode && digits.length > cfg.max) return `+${digits}`;
    let national = digits;
    if (cfg.trunk && national.startsWith("0")) national = national.slice(1);
    if (national.length >= cfg.min && national.length <= cfg.max) return `+${cfg.code}${national}`;
    if (startsWithCode) return `+${digits}`;
  }
  // A number typed with another country's code and no plus: 447911123456, 61412345678
  if (digits.length >= 11 && digits.length <= 15) {
    const code = CODES.find((c) => c !== "1" && digits.startsWith(c));
    if (code) {
      const n = digits.slice(code.length);
      if (Object.values(COUNTRIES).some((c) => c.code === code && n.length >= c.min && n.length <= c.max)) return `+${digits}`;
    }
  }
  return null;
}

// ─── Names ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const PARTICLES = new Set(["van", "von", "der", "den", "de", "del", "della", "di", "da", "du", "la", "le", "bin", "ibn", "al", "el", "dos", "das"]);
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v", "md", "phd", "esq", "dds", "dvm", "cpa", "rn"]);
const HONORIFICS = new Set(["mr", "mrs", "ms", "miss", "mx", "dr", "prof", "sir", "madam"]);

const shouty = (s: string) => s === s.toUpperCase() && s !== s.toLowerCase();
const lowerOnly = (s: string) => s === s.toLowerCase() && s !== s.toUpperCase();

function capWord(w: string, first: boolean): string {
  if (!w) return w;
  const bare = w.toLowerCase().replace(/\.$/, "");
  if (!first && PARTICLES.has(bare)) return w.toLowerCase();
  if (SUFFIXES.has(bare)) return ["ii", "iii", "iv", "v"].includes(bare) ? bare.toUpperCase() : bare[0].toUpperCase() + bare.slice(1) + (w.endsWith(".") ? "." : "");
  // Hyphens and apostrophes start a new capital: Mary-Jane, O'Brien, D'Angelo
  const parts = w.toLowerCase().split(/([-'’])/);
  return parts
    .map((p, i) => {
      if (!p || /^[-'’]$/.test(p)) return p;
      if (i > 0 && parts[i - 1] === "'" && p.length === 1) return p; // l'
      let c = p[0].toUpperCase() + p.slice(1);
      if (/^Mc[a-z]{3,}$/.test(c)) c = `Mc${c[2].toUpperCase()}${c.slice(3)}`;
      return c;
    })
    .join("");
}

/** Title case for a shouting or all lowercase name or place; anything already in mixed case is left as typed (McDonald, DeShawn) */
export function titleCase(raw: string): string {
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s) return "";
  if (!shouty(s) && !lowerOnly(s)) return s;
  return s
    .split(" ")
    .map((w, i) => (/^([a-z]\.)+$/i.test(w) ? w.toUpperCase() : capWord(w, i === 0)))
    .join(" ");
}

/** A name field that isn't a name: an email address, a number, nothing but symbols */
const notAName = (s: string) => !s || /@/.test(s) || !/\p{L}/u.test(s) || /^\d+$/.test(s) || /^(n\/?a|none|null|unknown|test)$/i.test(s);

/** "Dr. Mary van der Berg Jr" or "Berg, Mary" as first and last name */
export function splitName(raw: string): { first: string; last: string } {
  let s = raw.replace(/\s+/g, " ").trim();
  if (notAName(s)) return { first: "", last: "" };
  const comma = s.split(",").map((x) => x.trim()).filter(Boolean);
  if (comma.length === 2 && !SUFFIXES.has(comma[1].toLowerCase().replace(/\./g, ""))) s = `${comma[1]} ${comma[0]}`;
  else if (comma.length > 1) s = comma.join(" ");
  let tokens = s.split(" ");
  while (tokens.length > 1 && HONORIFICS.has(tokens[0].toLowerCase().replace(/\./g, ""))) tokens = tokens.slice(1);
  if (tokens.length === 1) return { first: titleCase(tokens[0]), last: "" };
  let suffix = "";
  if (tokens.length > 2 && SUFFIXES.has(tokens[tokens.length - 1].toLowerCase().replace(/\./g, ""))) suffix = ` ${tokens.pop()}`;
  let at = tokens.length - 1;
  while (at > 1 && PARTICLES.has(tokens[at - 1].toLowerCase())) at--;
  return { first: titleCase(tokens.slice(0, at).join(" ")), last: titleCase(tokens.slice(at).join(" ") + suffix) };
}

/** A first or last name cell: trimmed, a shouting or lowercase one in title case, an email or number in its place cleared */
export function cleanName(raw: string): string {
  const s = raw.replace(/\s+/g, " ").trim();
  return notAName(s) ? "" : titleCase(s);
}

// ─── Consent ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type Consent = "yes" | "no" | "suppressed" | "blank";
/** What a consent cell says: subscribed, not, taken off the list (unsubscribed, bounced, complained), or nothing */
export function consentValue(raw: string): Consent {
  const s = raw.trim().toLowerCase().replace(/[_-]+/g, " ");
  if (!s) return "blank";
  if (/^(not|never|non|in ?active)\b|^(no|n|false|f|0|none|pending|unconfirmed|unknown)$/.test(s)) return "no";
  if (/unsub|opted out|opt ?out|clean(ed)?\b|bounc|complain|spam|suppress|do not|dnc|blocked|blacklist/.test(s)) return "suppressed";
  if (/^(y|yes|true|t|1)$|subscri|opt(ed)? ?in|confirmed|consent|active|granted|agree|accept/.test(s)) return "yes";
  return "blank";
}

// ─── Columns ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type Target = "$email" | "$first_name" | "$last_name" | "$phone_number" | "$address1" | "$address2" | "$city" | "$region" | "$zip" | "$country" | "$organization" | "$title" | "$external_id";
const ORDER: Target[] = ["$email", "$first_name", "$last_name", "$phone_number", "$address1", "$address2", "$city", "$region", "$zip", "$country", "$organization", "$title", "$external_id"];

const WORDS: Record<Target | "full" | "consentEmail" | "consentSms" | "consentDate", string> = {
  $email: "email emailaddress emailaddr eemail mail emailid contactemail primaryemail customeremail subscriberemail workemail personalemail",
  $first_name: "firstname first fname givenname forename contactfirstname subscriberfirstname",
  $last_name: "lastname last lname surname familyname contactlastname subscriberlastname",
  $phone_number: "phone phonenumber mobile mobilephone mobilenumber cell cellphone cellnumber telephone tel phone1 primaryphone smsnumber whatsapp defaultaddressphone billingphone textnumber",
  $address1: "address address1 addressline1 street streetaddress defaultaddressaddress1 billingaddress1",
  $address2: "address2 addressline2 apt suite unit defaultaddressaddress2 billingaddress2",
  $city: "city town defaultaddresscity billingcity",
  $region: "state region province stateprovince stateregion stateorprovince defaultaddressprovincecode defaultaddressprovince billingprovince billingstate",
  $zip: "zip zipcode postalcode postcode zippostalcode postalzip defaultaddresszip billingzip",
  $country: "country countrycode countryregion defaultaddresscountrycode defaultaddresscountry billingcountry",
  $organization: "company organization organisation org companyname business defaultaddresscompany",
  $title: "jobtitle position",
  $external_id: "externalid customerid contactid userid",
  full: "name fullname customername contactname subscribername contact",
  consentEmail: "acceptsmarketing acceptsemailmarketing emailmarketing emailsubscribed emailsubscription emailconsent emailoptin marketingconsent optin optedin subscribed subscribe subscribestatus subscriptionstatus emailmarketingstatus emailstatus marketingstatus unsubscribed",
  consentSms: "acceptssmsmarketing smsmarketing smsconsent smsoptin smssubscribed smsmarketingconsent textconsent textoptin smsstatus",
  consentDate: "consenttimestamp consentdate optindate optintime subscribedat subscribedon signupdate dateoptedin optintimestamp subscribedate",
};
const LOOKUP = new Map<string, keyof typeof WORDS>();
for (const [target, list] of Object.entries(WORDS)) for (const w of list.split(" ")) if (!LOOKUP.has(w)) LOOKUP.set(w, target as keyof typeof WORDS);

const keyOf = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

export type Mapping = { source: string; target: string; kind: "standard" | "name" | "consent" | "custom" | "dropped"; note?: string };
export type Reason = "No valid email address" | "Duplicate email" | "Duplicate phone number (no email)" | "Disposable email address" | "Role address (info@, support@ and the like)" | "Placeholder or test address" | "Unsubscribed or suppressed in the source list";
export type Removed = { line: number; reason: Reason; cells: string[] };
export type CleanOptions = {
  /** The country for phone numbers written without a country code (US by default) */
  defaultCountry?: string;
  /** Keep shared inboxes such as info@ and support@ (taken out by default) */
  keepRole?: boolean;
  /** Keep throwaway addresses (taken out by default) */
  keepDisposable?: boolean;
};
export type CleanStats = {
  rowsIn: number;
  kept: number;
  removed: Record<string, number>;
  emailsRepaired: number;
  phonesFormatted: number;
  phonesCleared: number;
  namesSplit: number;
  namesFixed: number;
  zipsPadded: number;
  smsOnly: number;
  consentEmail: number;
  consentSms: number;
};
export type CleanResult =
  | { ok: true; header: string[]; rows: string[][]; removedHeader: string[]; removed: Removed[]; mapping: Mapping[]; stats: CleanStats; defaultCountry: string; headerLine: number }
  | { ok: false; error: string };

const looksLikeStatus = (v: string) => consentValue(v) !== "blank";

/** The column most cells of which are addresses, when no header says so */
function sniffEmailColumn(rows: string[][], skip: Set<number>): number {
  const width = Math.max(0, ...rows.slice(0, 50).map((r) => r.length));
  let best = -1;
  let bestShare = 0.6;
  for (let c = 0; c < width; c++) {
    if (skip.has(c)) continue;
    let seen = 0;
    let hits = 0;
    for (const r of rows) {
      const v = (r[c] ?? "").trim();
      if (!v) continue;
      seen++;
      if (v.includes("@") && validEmail(normalizeEmail(v).email)) hits++;
      if (seen >= 200) break;
    }
    if (seen >= 2 && hits / seen > bestShare) {
      best = c;
      bestShare = hits / seen;
    }
  }
  return best;
}

/**
 * Clean a list. `source` is the file's rows, header first (leading blank lines are skipped). Rows come out in their
 * original order; every row that's taken out is returned with its line number and why.
 */
export function cleanList(source: string[][], opts: CleanOptions = {}): CleanResult {
  const country = countryCode(opts.defaultCountry ?? "US");
  if (!country) return { ok: false, error: `I don't know the country "${opts.defaultCountry}" for phone numbers. Use a two letter code such as US, CA, GB or AU.` };
  const headerAt = source.findIndex((r) => r.some((c) => c.trim()));
  if (headerAt < 0) return { ok: false, error: "The file is empty." };
  const head = source[headerAt].map((h) => h.trim());
  const body = source.slice(headerAt + 1);

  // ── Which column is which
  type Col = { index: number; header: string; key: string; role: keyof typeof WORDS | "custom" | "skip" };
  const cols: Col[] = head.map((h, index) => ({ index, header: h, key: keyOf(h), role: h ? ((LOOKUP.get(keyOf(h)) as keyof typeof WORDS | undefined) ?? "custom") : "skip" }));
  // A plain "status" column that holds subscribed/unsubscribed words is the email consent
  for (const c of cols) {
    if (c.role === "custom" && /^(status|state|emailstatus|subscriptionstatus)$/.test(c.key)) {
      const vals = body.slice(0, 300).map((r) => (r[c.index] ?? "").trim()).filter(Boolean);
      if (vals.length >= 2 && vals.filter(looksLikeStatus).length / vals.length > 0.7 && !cols.some((x) => x.role === "consentEmail")) c.role = "consentEmail";
    }
  }
  if (!cols.some((c) => c.role === "$email")) {
    // A column read as a name ("Contact") may hold the addresses: look inside it too
    const used = new Set(cols.filter((c) => c.role !== "custom" && c.role !== "full").map((c) => c.index));
    const sniffed = sniffEmailColumn(body, used);
    if (sniffed >= 0) cols[sniffed].role = "$email";
  }
  const hasPhone = cols.some((c) => c.role === "$phone_number");
  if (!cols.some((c) => c.role === "$email") && !hasPhone) {
    return { ok: false, error: `I couldn't find an email column. The columns are: ${head.filter(Boolean).slice(0, 15).join(", ")}. Tell me which one holds the email addresses.` };
  }
  const by = (role: Col["role"]) => cols.filter((c) => c.role === role).map((c) => c.index);
  const emailCols = by("$email");
  const phoneCols = by("$phone_number");
  const firstCols = by("$first_name");
  const lastCols = by("$last_name");
  const fullCols = by("full");
  const consentEmailCols = by("consentEmail");
  const consentSmsCols = by("consentSms");
  const consentDateCols = by("consentDate");
  const plain: Target[] = ["$address1", "$address2", "$city", "$region", "$zip", "$country", "$organization", "$title", "$external_id"];
  const plainCols = Object.fromEntries(plain.map((t) => [t, by(t)])) as Record<Target, number[]>;
  const haveConsent = consentEmailCols.length > 0 || consentSmsCols.length > 0;

  const present = new Set<Target | "$consent" | "$consent_timestamp">();
  if (emailCols.length) present.add("$email");
  if (firstCols.length || fullCols.length) present.add("$first_name");
  if (lastCols.length || fullCols.length) present.add("$last_name");
  if (phoneCols.length) present.add("$phone_number");
  for (const t of plain) if (plainCols[t].length) present.add(t);
  const outStandard = ORDER.filter((t) => present.has(t));
  const customCols = cols.filter((c) => c.role === "custom");
  const seen = new Set<string>([...outStandard, "$consent", "$consent_timestamp"]);
  const customHeaders = customCols.map((c) => {
    let h = c.header;
    for (let n = 2; seen.has(h.toLowerCase()); n++) h = `${c.header} (${n})`;
    seen.add(h.toLowerCase());
    return h;
  });
  const header: string[] = [...outStandard, ...(haveConsent ? ["$consent"] : []), ...(haveConsent && consentDateCols.length ? ["$consent_timestamp"] : []), ...customHeaders];

  const mapping: Mapping[] = [];
  const firstOf = (t: string) => cols.find((c) => c.role === t)?.header;
  for (const c of cols) {
    if (c.role === "skip") mapping.push({ source: `(column ${c.index + 1}, no header)`, target: "", kind: "dropped", note: "No header: left out" });
    else if (c.role === "custom") mapping.push({ source: c.header, target: customHeaders[customCols.indexOf(c)], kind: "custom", note: "Kept as a custom property" });
    else if (c.role === "full") mapping.push({ source: c.header, target: "$first_name + $last_name", kind: "name", note: firstCols.length || lastCols.length ? "Used where first or last name is empty" : "Split into first and last name" });
    else if (c.role === "consentEmail") mapping.push({ source: c.header, target: "$consent", kind: "consent", note: "Email consent" });
    else if (c.role === "consentSms") mapping.push({ source: c.header, target: "$consent", kind: "consent", note: "Text (SMS) consent" });
    else if (c.role === "consentDate") mapping.push({ source: c.header, target: haveConsent ? "$consent_timestamp" : c.header, kind: haveConsent ? "consent" : "custom", note: haveConsent ? "When they agreed" : undefined });
    else {
      const first = cols.find((x) => x.role === c.role)!;
      mapping.push({ source: c.header, target: c.role, kind: "standard", note: first === c ? undefined : `Also read for ${c.role}; used when ${firstOf(c.role)} is empty` });
    }
  }
  // A consent date column with no consent column behind it is kept as it is
  if (!haveConsent) for (const c of cols) {
    if (c.role !== "consentDate") continue;
    customCols.push(c);
    customHeaders.push(c.header);
    header.push(c.header);
  }

  // ── Rows
  const stats: CleanStats = { rowsIn: 0, kept: 0, removed: {}, emailsRepaired: 0, phonesFormatted: 0, phonesCleared: 0, namesSplit: 0, namesFixed: 0, zipsPadded: 0, smsOnly: 0, consentEmail: 0, consentSms: 0 };
  const rows: string[][] = [];
  const removed: Removed[] = [];
  const seenEmails = new Set<string>();
  const seenPhones = new Set<string>();
  const take = (r: string[], line: number, reason: Reason) => {
    removed.push({ line, reason, cells: r });
    stats.removed[reason] = (stats.removed[reason] ?? 0) + 1;
  };
  const cell = (r: string[], i: number) => (r[i] ?? "").replace(/\s+/g, " ").trim();
  const firstFilled = (r: string[], idx: number[]) => {
    for (const i of idx) {
      const v = cell(r, i);
      if (v) return v;
    }
    return "";
  };

  for (let n = 0; n < body.length; n++) {
    const r = body[n];
    if (!r.some((c) => c.trim())) continue;
    const line = headerAt + 2 + n;
    stats.rowsIn++;

    // Email: the first column that holds a valid address
    let email = "";
    let repaired = false;
    for (const i of emailCols) {
      const raw = (r[i] ?? "").trim();
      if (!raw) continue;
      const e = normalizeEmail(raw);
      if (validEmail(e.email)) {
        email = e.email;
        repaired = e.fixed;
        break;
      }
    }
    // Phone: the first that works
    let phone = "";
    let phoneSeen = false;
    let phoneChanged = false;
    for (const i of phoneCols) {
      const raw = (r[i] ?? "").trim();
      if (!raw) continue;
      phoneSeen = true;
      const p = normalizePhone(raw, country);
      if (p) {
        phone = p;
        phoneChanged = p !== raw;
        break;
      }
    }

    // Consent first: a person taken off the list stays off
    let emailConsent: Consent = "blank";
    for (const i of consentEmailCols) {
      const v = consentValue(r[i] ?? "");
      if (v !== "blank") {
        emailConsent = v;
        break;
      }
    }
    let smsConsent: Consent = "blank";
    for (const i of consentSmsCols) {
      const v = consentValue(r[i] ?? "");
      if (v !== "blank") {
        smsConsent = v;
        break;
      }
    }
    if (emailConsent === "suppressed") {
      take(r, line, "Unsubscribed or suppressed in the source list");
      continue;
    }

    if (!email && !phone) {
      take(r, line, "No valid email address");
      continue;
    }
    if (email) {
      const flag = emailFlag(email);
      if (flag === "placeholder") {
        if (phone) email = "";
        else {
          take(r, line, "Placeholder or test address");
          continue;
        }
      } else if (flag === "disposable" && !opts.keepDisposable) {
        take(r, line, "Disposable email address");
        continue;
      } else if (flag === "role" && !opts.keepRole) {
        take(r, line, "Role address (info@, support@ and the like)");
        continue;
      }
    }
    if (email) {
      if (seenEmails.has(email)) {
        take(r, line, "Duplicate email");
        continue;
      }
      seenEmails.add(email);
    } else {
      // An SMS-only row: the phone number is who it is
      if (seenPhones.has(phone)) {
        take(r, line, "Duplicate phone number (no email)");
        continue;
      }
      seenPhones.add(phone);
      stats.smsOnly++;
    }
    if (repaired && email) stats.emailsRepaired++;
    if (phone && phoneChanged) stats.phonesFormatted++;
    else if (!phone && phoneSeen) stats.phonesCleared++;

    // Names
    let first = cleanName(firstFilled(r, firstCols));
    let last = cleanName(firstFilled(r, lastCols));
    const rawFirst = firstFilled(r, firstCols);
    const rawLast = firstFilled(r, lastCols);
    if ((!first || !last) && fullCols.length) {
      const sp = splitName(firstFilled(r, fullCols));
      if (!first && sp.first) first = sp.first;
      if (!last && sp.last && !(first === sp.first && !sp.last)) last = sp.last;
      if (sp.first || sp.last) stats.namesSplit++;
    }
    if ((rawFirst && rawFirst !== first) || (rawLast && rawLast !== last)) stats.namesFixed++;

    const out: string[] = [];
    for (const t of outStandard) {
      let v = "";
      if (t === "$email") v = email;
      else if (t === "$first_name") v = first;
      else if (t === "$last_name") v = last;
      else if (t === "$phone_number") v = phone;
      else {
        v = firstFilled(r, plainCols[t]);
        if (t === "$city" || t === "$organization") v = v ? titleCase(v) : v;
        else if (t === "$region") v = /^[a-z]{2}$/i.test(v) ? v.toUpperCase() : titleCase(v);
        else if (t === "$zip" && /^\d{4}$/.test(v)) {
          // Excel drops a ZIP code's leading zero (02134 becomes 2134)
          const named = firstFilled(r, plainCols.$country);
          if (named ? countryCode(named) === "US" : country === "US") {
            v = `0${v}`;
            stats.zipsPadded++;
          }
        }
      }
      out.push(v);
    }
    if (haveConsent) {
      const kinds = [emailConsent === "yes" && email ? "email" : "", smsConsent === "yes" && phone ? "sms" : ""].filter(Boolean);
      if (kinds.includes("email")) stats.consentEmail++;
      if (kinds.includes("sms")) stats.consentSms++;
      out.push(kinds.join(","));
      if (consentDateCols.length) out.push(kinds.length ? firstFilled(r, consentDateCols) : "");
    }
    for (const c of customCols) out.push(cell(r, c.index));
    rows.push(out);
  }
  stats.kept = rows.length;
  return { ok: true, header, rows, removedHeader: head, removed, mapping, stats, defaultCountry: country, headerLine: headerAt + 1 };
}

/** The removed rows as CSV rows: why, the line they were on, then every original column */
export function removedRows(res: Extract<CleanResult, { ok: true }>): string[][] {
  return [["Removed because", "Line in your file", ...res.removedHeader], ...res.removed.map((x) => [x.reason, String(x.line), ...x.cells])];
}
