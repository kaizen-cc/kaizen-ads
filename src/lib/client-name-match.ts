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

function domainRoot(site: string | null | undefined) {
  const d = (site ?? "").toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").replace(/[/?#:].*$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) return null;
  const parts = d.split(".");
  const tail = parts.length > 2 && parts[parts.length - 2].length <= 3 ? 3 : 2;
  const root = parts[parts.length - tail] ?? "";
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
  const brandAll = b.every((w) => has(w.t, b.length === 1 ? "name" : null)) || (b.length > 1 && joined.has(brandJoined));
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
