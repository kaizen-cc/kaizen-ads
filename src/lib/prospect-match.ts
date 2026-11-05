// A sales prospect (from a pre-sale audit Loom) matched to a client once they sign: by name, website or ad account,
// normalized so "Dump Daddy LLC", "dumpdaddy.com" and "Dump Daddy" are the same business. Pure, so it's tested.

const STOP = /\b(llc|inc|co|corp|ltd|limited|company|the|and|group|usa|us)\b/g;

/** A business name reduced to its letters and digits ("The Dump Daddy, LLC" → "dumpdaddy") */
export function nameKey(s: string | null | undefined) {
  return (s ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(STOP, " ").replace(/\s+/g, "");
}

/** A website's domain without www, path or protocol ("https://www.DumpDaddy.com/quote" → "dumpdaddy.com"); null when it isn't one */
export function domainOf(s: string | null | undefined) {
  const d = (s ?? "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#:].*$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : null;
}

/** The part of a domain that names the business ("dumpdaddy.com" → "dumpdaddy", "shop.feetje.co.uk" → "feetje") */
export function domainRoot(d: string | null) {
  if (!d) return null;
  const parts = d.split(".");
  const tail = parts.length > 2 && parts[parts.length - 2].length <= 3 ? 3 : 2;
  return nameKey(parts[parts.length - tail] ?? "") || null;
}

/** An ad account as its digits (act_123…, 123-456-7890), only when long enough to mean one account */
export function accountKey(s: string | null | undefined) {
  const d = (s ?? "").replace(/\D/g, "");
  return d.length >= 6 ? d : null;
}

export type ProspectRef = { name: string | null; domain: string | null; adAccount: string | null };
export type ClientRef = { id: string; name: string; website: string | null; accounts: string[] };

/** The keys a business is known by: its name, its domain's name and domain, its ad accounts */
function keys(name: string | null, site: string | null, accounts: (string | null)[]) {
  const out = new Set<string>();
  const n = nameKey(name);
  if (n.length >= 4) out.add(`n:${n}`);
  const d = domainOf(site);
  if (d) {
    out.add(`d:${d}`);
    const r = domainRoot(d);
    if (r && r.length >= 4) out.add(`n:${r}`);
  }
  for (const a of accounts) {
    const k = accountKey(a);
    if (k) out.add(`a:${k}`);
  }
  return out;
}

/** Whether a prospect and a client are the same business */
export function sameBusiness(p: ProspectRef, c: ClientRef) {
  const pk = keys(p.name, p.domain, [p.adAccount]);
  if (!pk.size) return false;
  for (const k of keys(c.name, c.website, c.accounts)) if (pk.has(k)) return true;
  return false;
}

/** The one client a prospect became, or null when none or more than one fit (those wait for someone to pick) */
export function matchProspect(p: ProspectRef, clients: ClientRef[]) {
  const hits = clients.filter((c) => sameBusiness(p, c));
  return hits.length === 1 ? hits[0] : null;
}

/** Whether two prospects are the same business (so "This prospect became client X" takes all their Looms) */
export function sameProspect(a: ProspectRef, b: ProspectRef) {
  const ak = keys(a.name, a.domain, [a.adAccount]);
  for (const k of keys(b.name, b.domain, [b.adAccount])) if (ak.has(k)) return true;
  return false;
}
