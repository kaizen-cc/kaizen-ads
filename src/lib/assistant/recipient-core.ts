// Finding someone's email address before asking for it. The assistant said a client's second contact "isn't in your
// inbox" without looking (Nov 23 2026): a name is now looked for everywhere it could be, in this order, and only asked
// for when every place comes up empty (saying where it looked). A likely address from the pattern the client's other
// addresses follow (firstname@theirdomain.com) is offered as a suggestion to confirm, never used silently. Pure: the
// server does the lookups (find_email_address in comms-tools.ts).

/** Where a name is looked for, in order */
export const SEARCH_ORDER = ["client contacts in Kaizen OS", "Gmail (all mail: from, to and cc, by name and by the client's domain)", "the client's Slack channel members", "the address pattern the client's other contacts follow"] as const;

export type Address = { name: string; email: string };

/** "Jason Smith <jason@x.com>, a@b.com, \"Lee, Ann\" <ann@y.com>" as names and addresses */
export function parseAddresses(header: string): Address[] {
  const out: Address[] = [];
  for (const m of header.matchAll(/(?:"?([^"<,]*?)"?\s*<([^<>\s@]+@[^<>\s]+)>|([^\s<>,;"]+@[^\s<>,;"]+))/g)) {
    const email = (m[2] ?? m[3] ?? "").trim().toLowerCase();
    if (email) out.push({ name: (m[1] ?? "").trim(), email });
  }
  return out;
}

const tokens = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Whether an address belongs to the person named: their name on it, or their first name at the start of the address */
export function matchesName(a: Address, name: string): boolean {
  const want = tokens(name);
  if (!want.length) return false;
  const [first, ...rest] = want;
  const shown = tokens(a.name);
  if (shown.includes(first) && (!rest.length || rest.some((r) => shown.includes(r)))) return true;
  const local = a.email.split("@")[0];
  const parts = tokens(local);
  if (parts[0] === first) return true;
  // "jsmith@" for Jason Smith
  return rest.length > 0 && local.replace(/[^a-z]/g, "") === `${first[0]}${rest[rest.length - 1]}`;
}

/** The Gmail searches for a name, across all mail (sent, archived, every label), and for the client's domains */
export function gmailQueries(name: string, domains: readonly string[]): string[] {
  const t = tokens(name);
  const first = t[0] ?? "";
  const full = t.join(" ");
  const qs: string[] = [];
  if (full) qs.push(`in:anywhere (from:"${full}" OR to:"${full}" OR cc:"${full}")`);
  if (first && first !== full) qs.push(`in:anywhere (from:${first} OR to:${first} OR cc:${first})`);
  for (const d of domains.slice(0, 3)) qs.push(`in:anywhere (from:@${d} OR to:@${d} OR cc:@${d})${first ? ` ${first}` : ""}`);
  for (const d of domains.slice(0, 3)) qs.push(`in:anywhere (from:@${d} OR to:@${d} OR cc:@${d})`);
  return [...new Set(qs)];
}

/** A domain worth searching: the client's own (not a free mail provider) */
const FREE = new Set(["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com", "aol.com", "me.com", "live.com", "msn.com", "proton.me", "protonmail.com"]);
export const clientDomain = (emailOrUrl: string | null | undefined): string | null => {
  const s = String(emailOrUrl ?? "").toLowerCase().trim();
  const d = s.includes("@") ? s.split("@")[1] : s.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  return d && d.includes(".") && !FREE.has(d) ? d : null;
};

/**
 * The address this person likely has, from how the client's known addresses are made (jaime@theyost.com, so Jason is
 * jason@theyost.com): a suggestion to confirm with the person, never used without their yes. Null when there's no
 * clear pattern.
 */
export function suggestAddress(name: string, known: readonly Address[]): { email: string; why: string } | null {
  const t = tokens(name);
  if (!t.length) return null;
  const [first, ...rest] = t;
  const last = rest[rest.length - 1] ?? null;
  for (const k of known) {
    const kt = tokens(k.name);
    if (!kt.length) continue;
    const [kf, ...kr] = kt;
    const kl = kr[kr.length - 1] ?? null;
    const [local, domain] = k.email.split("@");
    if (!domain) continue;
    const pattern =
      local === kf ? "first" : kl && local === `${kf}.${kl}` ? "first.last" : kl && local === `${kf}${kl}` ? "firstlast" : kl && local === `${kf[0]}${kl}` ? "flast" : null;
    if (!pattern || (pattern !== "first" && !last)) continue;
    const email = `${pattern === "first" ? first : pattern === "first.last" ? `${first}.${last}` : pattern === "firstlast" ? `${first}${last}` : `${first[0]}${last}`}@${domain}`;
    if (email === k.email) continue;
    return { email, why: `${k.name || k.email} is ${k.email}, so ${name} is likely ${email}` };
  }
  return null;
}
