// Where a Google launch shows, as the buyer says it ("US excluding Hawaii and Alaska", "the lower 48", "Texas and
// Oklahoma"), turned into Google's geo target constants: places to show in and places excluded (negative location
// criteria). Countries and US states are known here (no call needed); anything else is left for Google's own
// suggestion (suggestGeo) and, if that finds nothing either, it stays unresolved so the deploy is blocked instead of
// silently showing everywhere. Pure: the plan, the card and the tests (tests/google-places.test.ts) agree.

export type Place = { geo: string; name: string };
export type Places = { include: Place[]; exclude: Place[]; unresolved: string[] };

const C = (id: number) => `geoTargetConstants/${id}`;

/** Countries Kaizen's clients ship to or serve, by the names buyers use */
const COUNTRIES: [RegExp, Place][] = [
  [/^(the )?(us|usa|united states( of america)?|america|nationwide|the states|all (50|fifty) states)$/i, { geo: C(2840), name: "United States" }],
  [/^canada$/i, { geo: C(2124), name: "Canada" }],
  [/^(the )?(uk|u\.k|united kingdom|great britain|britain)$/i, { geo: C(2826), name: "United Kingdom" }],
  [/^australia$/i, { geo: C(2036), name: "Australia" }],
  [/^mexico$/i, { geo: C(2484), name: "Mexico" }],
  [/^puerto rico$/i, { geo: C(2630), name: "Puerto Rico" }],
];

/** US states (and DC) as Google's geo target constants */
export const US_STATES: Record<string, number> = {
  alabama: 21133, alaska: 21132, arizona: 21136, arkansas: 21135, california: 21137, colorado: 21138, connecticut: 21139, delaware: 21141,
  "district of columbia": 21140, florida: 21142, georgia: 21143, hawaii: 21144, idaho: 21146, illinois: 21147, indiana: 21148, iowa: 21145,
  kansas: 21149, kentucky: 21150, louisiana: 21151, maine: 21154, maryland: 21153, massachusetts: 21152, michigan: 21155, minnesota: 21156,
  mississippi: 21158, missouri: 21157, montana: 21159, nebraska: 21162, nevada: 21166, "new hampshire": 21163, "new jersey": 21164,
  "new mexico": 21165, "new york": 21167, "north carolina": 21160, "north dakota": 21161, ohio: 21168, oklahoma: 21169, oregon: 21170,
  pennsylvania: 21171, "rhode island": 21172, "south carolina": 21173, "south dakota": 21174, tennessee: 21175, texas: 21176, utah: 21177,
  vermont: 21179, virginia: 21178, washington: 21180, "west virginia": 21183, wisconsin: 21182, wyoming: 21184,
};
const ABBR: Record<string, string> = { ak: "alaska", hi: "hawaii", dc: "district of columbia", "washington dc": "district of columbia", tx: "texas", ca: "california", ny: "new york", fl: "florida", nj: "new jersey" };

const titled = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\bOf\b/, "of");

/** One place name, if it's a country or US state known here */
export function knownPlace(raw: string): Place | null {
  const t = raw.replace(/[.,;:]+$/g, "").replace(/\s+/g, " ").trim().toLowerCase().replace(/\s+only$/, "");
  if (!t) return null;
  for (const [re, p] of COUNTRIES) if (re.test(t)) return p;
  const state = ABBR[t] ?? t.replace(/^(the )?state of /, "").replace(/,?\s*(usa|us|united states)$/, "").trim();
  if (US_STATES[state]) return { geo: C(US_STATES[state]), name: `${titled(state)}, United States` };
  return null;
}

/** "the lower 48", "contiguous US": the US with Alaska and Hawaii left out */
const LOWER48 = /\b(?:the )?(?:lower ?(?:48|forty[- ]eight)|contiguous|continental)(?: (?:us|usa|united states))?(?: states)?\b|\b48 states\b/i;
const DC = /^(dc|district of columbia|washington dc)$/i;
/** Where the exclusions start: "excluding", "except", "but not", "minus", "without", "not" */
const EXCEPT = /\s*(?:\(|,|;)?\s*\b(?:excluding|exclude|excludes|except(?: for)?|but not|minus|without|other than|not including|leave out|leaving out|no)\b\s*/i;

/** A list of places in words: "Hawaii and Alaska", "Texas, Oklahoma & Kansas" */
export function splitPlaces(s: string): string[] {
  return s
    .replace(/[()]/g, " ")
    .split(/\s*(?:,|;|\/|&|\band\b|\bor\b|\bplus\b|\+)\s*/i)
    .map((x) => x.replace(/^(?:the|only|just|in|all of|all)\s+/i, "").replace(/\s+/g, " ").trim())
    .filter((x) => x && !/^(states?|only|too|also)$/i.test(x));
}

/**
 * The buyer's words about where to show, as Google's places: known countries and US states resolved here, "the lower
 * 48" as the US minus Alaska and Hawaii (DC is in the US already), exclusions as negative places. What isn't known
 * here is returned in unresolved, for Google's suggestion; `extra` resolves those (name, lower case → place).
 */
export function resolvePlaces(text: string | null | undefined, extra: Map<string, Place> = new Map()): Places {
  const out: Places = { include: [], exclude: [], unresolved: [] };
  // "U.S.A." and "U.S." read as "usa" and "us"; a trailing period or "only" dropped
  const t = String(text ?? "")
    .replace(/\bu\.\s?s\.\s?a\.?/gi, "usa")
    .replace(/\bu\.\s?s\.?(?=\W|$)/gi, "us")
    .replace(/\bd\.\s?c\.?(?=\W|$)/gi, "dc")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!]+$/, "");
  if (!t) return out;
  const add = (list: Place[], p: Place) => !list.some((x) => x.geo === p.geo) && list.push(p);
  const m = t.match(EXCEPT);
  const head = m && m.index != null ? t.slice(0, m.index) : t;
  const tail = m && m.index != null ? t.slice(m.index + m[0].length) : "";
  const lower48 = LOWER48.test(t);
  const US = C(2840);
  const heads = splitPlaces(head.replace(LOWER48, "United States"));
  const hasUs = lower48 || heads.some((raw) => knownPlace(raw)?.geo === US);
  for (const raw of heads) {
    // "plus DC" with the US: DC is already in it
    if (hasUs && DC.test(raw)) continue;
    const p = knownPlace(raw) ?? extra.get(raw.toLowerCase()) ?? null;
    if (p) add(out.include, p);
    else out.unresolved.push(raw);
  }
  if (lower48) {
    add(out.include, { geo: US, name: "United States" });
    add(out.exclude, knownPlace("alaska")!);
    add(out.exclude, knownPlace("hawaii")!);
  }
  for (const raw of splitPlaces(tail)) {
    const p = knownPlace(raw) ?? extra.get(raw.toLowerCase()) ?? null;
    if (p) add(out.exclude, p);
    else out.unresolved.push(raw);
  }
  return out;
}

/**
 * A new campaign's places: the buyer's own words first (the answer to "where should it show"), else the plan's list
 * (each item may say its own exclusions), with exclusions the plan listed apart. `ask` is what the buyer asked for,
 * kept so a launch whose places didn't resolve is blocked (never shown everywhere by accident).
 */
export function campaignPlaces(ask: string | null | undefined, include: string[], exclude: string[] = [], extra: Map<string, Place> = new Map()) {
  const fromModel = (): Places => {
    const out: Places = { include: [], exclude: [], unresolved: [] };
    const add = (list: Place[], p: Place) => !list.some((x) => x.geo === p.geo) && list.push(p);
    for (const raw of include) {
      const direct = extra.get(raw.toLowerCase().trim());
      if (direct) {
        add(out.include, direct);
        continue;
      }
      const r = resolvePlaces(raw, extra);
      r.include.forEach((p) => add(out.include, p));
      r.exclude.forEach((p) => add(out.exclude, p));
      out.unresolved.push(...r.unresolved);
    }
    for (const raw of exclude) {
      const p = extra.get(raw.toLowerCase().trim()) ?? resolvePlaces(raw, extra).include[0] ?? null;
      if (p) add(out.exclude, p);
      else out.unresolved.push(raw);
    }
    return out;
  };
  const words = String(ask ?? "").trim();
  const said = words ? resolvePlaces(words, extra) : null;
  const listed = fromModel();
  // The buyer's words when they resolve whole; the plan's list when they don't but it does
  const pick = said && said.include.length && !said.unresolved.length ? said : listed.include.length && !listed.unresolved.length ? listed : (said ?? listed);
  const asked = words || (include.length ? `${include.join(", ")}${exclude.length ? ` excluding ${exclude.join(", ")}` : ""}` : "");
  return { locations: pick.include, excluded: pick.exclude, unresolved: pick.include.length ? pick.unresolved : pick.unresolved.length ? pick.unresolved : asked ? [asked] : [], ask: asked || null };
}

/** "United States, excluding Alaska and Hawaii" */
export function placesLabel(include: Place[], exclude: Place[] = []) {
  const short = (p: Place) => p.name.split(",")[0];
  const inc = include.map(short).join(", ");
  const exc = exclude.map(short);
  return `${inc || "Everywhere"}${exc.length ? `, excluding ${exc.length > 1 ? `${exc.slice(0, -1).join(", ")} and ${exc[exc.length - 1]}` : exc[0]}` : ""}`;
}
