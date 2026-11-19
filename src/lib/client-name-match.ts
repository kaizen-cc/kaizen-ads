// Which client a piece of text (a promise, an email) is about, from the client's name as people actually write it:
// misspelled ("Glenlock" for "Gleannloch"), without the brand's generic words ("Crust" for "Crust Pizza"), or naming
// just the location of a "Brand - Location" client. Pure, so it's tested.

const STOP = new Set(["llc", "inc", "co", "corp", "ltd", "limited", "company", "the", "and", "group", "usa", "us", "of", "a", "an", "at", "by", "in", "on", "for"]);

/** cap: written with a capital; name: and not just because it starts a sentence */
type Token = { t: string; cap: boolean; name: boolean };

/**
 * Words in order, lowercased, with whether each was written as a name: a capital in the middle of a sentence (the
 * first word of a sentence is capitalized whatever it is)
 */
export function words(s: string | null | undefined): Token[] {
  const text = (s ?? "").replace(/&/g, " and ");
  return [...text.matchAll(/[A-Za-z0-9']+/g)]
    .map((m) => {
      const before = text.slice(0, m.index).trimEnd();
      const starts = !before || /[.!?>"()\n]$/.test(before);
      const cap = /^[A-Z0-9]/.test(m[0]);
      return { t: m[0].toLowerCase().replace(/'/g, ""), cap, name: cap && (!starts || /^[A-Z0-9]{2,}$|^\d/.test(m[0])) };
    })
    .filter((w) => w.t);
}

/** A word by its consonant sound ("Gleannloch" and "Glenlock" both → "glnlk") */
export function skeleton(w: string) {
  const s = w
    .toLowerCase()
    .replace(/[^a-z]/g, "")
    .replace(/ck/g, "k")
    .replace(/ch/g, "k")
    .replace(/ph/g, "f")
    .replace(/[cq]/g, "k")
    .replace(/z/g, "s")
    .replace(/h/g, "");
  if (!s) return "";
  return (s[0] + s.slice(1).replace(/[aeiouy]/g, "")).replace(/(.)\1+/g, "$1");
}

const singular = (w: string) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w);

/** Whether two words are the same name, spelled however: exact, plural, or the same sound (not merely close: "Glenrock" isn't "Glenlock") */
export function sameWord(a: string, b: string) {
  if (a === b || singular(a) === singular(b)) return true;
  if (/\d/.test(a) || /\d/.test(b)) return false;
  if (a.length >= 4 && b.length >= 4) {
    const sa = skeleton(a);
    if (sa.length >= 3 && sa === skeleton(b)) return true;
  }
  return false;
}

export type NamedClient = { id: string; name: string; website?: string | null };

/** "Crust Pizza - Gleannloch Farms" → brand "Crust Pizza", location "Gleannloch Farms" (also "Brand (Location)", "Brand | Location") */
export function splitName(name: string) {
  const [brand, ...rest] = name.split(/\s+[-\u2013\u2014|:]\s+|\s*[(/]\s*/);
  return { brand: brand.trim(), location: rest.join(" ").replace(/[)]/g, "").trim() };
}

const keyWords = (s: string) => words(s).filter((w) => !STOP.has(w.t));

// Sites that host someone's page rather than being their own (an Instagram profile as the "website"): the platform's
// name is in every other email ("connect your Instagram"), so it never names a client
const PLATFORMS = new Set(["instagram", "facebook", "tiktok", "youtube", "linkedin", "twitter", "threads", "pinterest", "linktr", "linktree", "google", "goo", "yelp", "shopify", "myshopify", "etsy", "amazon", "squarespace", "wixsite", "wordpress", "godaddysites", "square", "toasttab", "doordash", "ubereats", "grubhub", "calendly", "beacons", "carrd", "canva", "klaviyo"]);

function domainRoot(site: string | null | undefined) {
  const d = (site ?? "").toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").replace(/[/?#:].*$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) return null;
  const parts = d.split(".");
  const tail = parts.length > 2 && parts[parts.length - 2].length <= 3 ? 3 : 2;
  const root = parts[parts.length - tail] ?? "";
  if (parts.some((x) => PLATFORMS.has(x))) return null;
  return root.length >= 5 ? root : null;
}

/**
 * How strongly the text names the client: 4 brand and location, 3 its location with the brand's lead word, or the
 * whole name of a client without a location, or its website; 1 only part of it (the brand of a chain, the location
 * alone, the brand's lead word); 0 nothing.
 */
export function scoreClient(text: string, c: NamedClient, siteCounts = true) {
  const ws = words(text);
  const has = (w: string, need: "cap" | "name" | null = null) => ws.some((x) => (!need || x[need]) && sameWord(x.t, w));
  // Words run together ("DumpDaddy") count as the name too
  const joined = new Set(ws.flatMap((x, i) => [x.t, i + 1 < ws.length ? x.t + ws[i + 1].t : ""]).filter(Boolean));
  // A website counts unless other clients share it (a chain's locations on the brand's site)
  const site = siteCounts ? domainRoot(c.website) : null;
  if (site && [...joined].some((j) => j === site)) return 3;
  const { brand, location } = splitName(c.name);
  const b = keyWords(brand);
  const l = keyWords(location);
  if (!b.length) return 0;
  const lead = b.find((w) => w.t.length >= 4) ?? null;
  const brandJoined = b.map((w) => w.t).join("");
  // A one-word brand has to be written as a name (capitalized mid-sentence), so "Elevate the ads" isn't the client Elevate
  // and a one-word brand written as two capitalized words ("Ocean Box" for OceanBox) counts too
  const capPairs = new Set(ws.flatMap((x, i) => (i + 1 < ws.length && x.cap && ws[i + 1].cap ? [x.t + ws[i + 1].t] : [])));
  const brandAll = b.every((w) => has(w.t, b.length === 1 ? "name" : null)) || (b.length > 1 && joined.has(brandJoined)) || (b.length === 1 && brandJoined.length >= 6 && capPairs.has(brandJoined));
  const brandLead = Boolean(lead && has(lead.t, "cap"));
  const locAll = l.length > 0 && l.some((w) => w.t.length >= 4) && l.every((w) => has(w.t));
  if (!l.length) return brandAll && brandJoined.length >= 4 ? 3 : brandLead ? 1 : 0;
  if (brandAll && locAll) return 4;
  if (brandLead && locAll) return 3;
  if (brandAll || brandLead || locAll) return 1;
  return 0;
}

/**
 * The client the text is about. Sure only when one client is clearly named (score 3 or more and no other as strong);
 * otherwise the ones it might be, best first, for someone (or the AI) to decide.
 */
export function matchClientName<C extends NamedClient>(text: string, clients: C[]): { sure: C | null; maybe: C[] } {
  const roots = new Map<string, number>();
  for (const c of clients) {
    const r = domainRoot(c.website);
    if (r) roots.set(r, (roots.get(r) ?? 0) + 1);
  }
  const scored = clients
    .map((c) => ({ c, s: scoreClient(text, c, (roots.get(domainRoot(c.website) ?? "") ?? 0) <= 1) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  const top = scored[0];
  const sure = top && top.s >= 3 && scored.filter((x) => x.s >= 3).length === 1 ? top.c : top && top.s === 4 && scored.filter((x) => x.s === 4).length === 1 ? top.c : null;
  return { sure, maybe: scored.slice(0, 8).map((x) => x.c) };
}

// ─── A client asked for by name (the assistant's, the agents' and Kaizen AI's tools) ─────────────────────────────

/** Case, spaces, punctuation and "&"/"and" don't matter ("Ocean Box" = "OceanBox" = "ocean-box") */
export const compactName = (s: string) =>
  String(s ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]/g, "");

export type NamePick<C> = { hit: C | null; close: C[] };

/**
 * The client someone named, from the clients they can see, in order: the exact name, the same name ignoring spaces,
 * punctuation and case ("Ocean Box" is OceanBox, never Ocean & Acre), the brand or location of a "Brand - Location"
 * client, a name it starts, then every word matching (spelled however). Ambiguous only when two are genuinely as
 * close; then `close` holds them to ask between, best first.
 */
export function pickClientByName<C extends { name: string }>(asked: string, clients: readonly C[]): NamePick<C> {
  const a = String(asked ?? "").trim();
  const k = compactName(a);
  if (!k) return { hit: null, close: [] };
  const one = (xs: C[]): NamePick<C> | null => (xs.length === 1 ? { hit: xs[0], close: [] } : xs.length > 1 ? { hit: null, close: xs.slice(0, 5) } : null);
  const exact = clients.filter((c) => c.name.trim().toLowerCase() === a.toLowerCase());
  if (exact.length === 1) return { hit: exact[0], close: [] };
  const tiers: ((c: C) => boolean)[] = [
    (c) => compactName(c.name) === k,
    (c) => {
      const { brand, location } = splitName(c.name);
      return compactName(brand) === k || (location !== "" && compactName(location) === k);
    },
    (c) => k.length >= 3 && compactName(c.name).startsWith(k),
  ];
  for (const t of tiers) {
    const r = one(clients.filter(t));
    if (r) return r;
  }
  // Every word they said is a word of the name (plural, misspelled), the closest cover of the name first
  const asked_ = words(a).filter((w) => !STOP.has(w.t)).map((w) => w.t);
  if (!asked_.length) return { hit: null, close: [] };
  const scored = clients
    .map((c) => {
      const ws = words(c.name).filter((w) => !STOP.has(w.t)).map((w) => w.t);
      const joined = ws.join("");
      const all = asked_.every((w) => ws.some((x) => sameWord(x, w)) || (w.length >= 4 && joined.includes(w)));
      const cover = ws.length ? ws.filter((x) => asked_.some((w) => sameWord(x, w))).length / ws.length : 0;
      return { c, all, cover };
    })
    .filter((x) => x.all)
    .sort((x, y) => y.cover - x.cover);
  if (!scored.length) return { hit: null, close: [] };
  const top = scored[0];
  const near = scored.filter((x) => top.cover - x.cover < 0.2);
  return near.length === 1 ? { hit: top.c, close: [] } : { hit: null, close: near.slice(0, 5).map((x) => x.c) };
}
