// Which other clients count as "like this one" when we show what's working for similar clients. Closest first:
// a business that sells the same thing (a bedding brand and a sheets brand), then the same sub-vertical, and only when
// neither has anything, the same broad industry (labelled as such, so nobody mistakes a supplement ad for a peer).
// Plain functions, so the request page, the AI blocks and the tests all agree.

export type PeerInfo = { id: string; industry: string | null; industry_detail: string | null; vertical_id: string | null };
export type VerticalInfo = { id: string; name: string; parent_id: string | null };
/** 1: sells the same thing, 2: same sub-vertical, 3: only the same broad industry */
export type PeerMatch = { tier: 1 | 2 | 3; why: string };

// Words that say how or where something is sold, not what it is
const STOP = new Set(
  "a an and the of for to in on with by at from or & brand brands online dtc d2c ecommerce e-commerce commerce shop shops store stores retailer retail company co products product goods sold seller sells selling direct consumer consumers business local premium luxury high-end affordable delivery delivered subscription service services gear equipment supply supplies women's womens men's mens kids kid's custom specialty us usa american".split(
    " ",
  ),
);

// Different words for the same kind of product, so "bedding" meets "sheets" and "duvet covers"
const GROUPS: [string, string[]][] = [
  ["bedding and sleep", ["bedding", "bed", "sheet", "duvet", "linen", "pillow", "mattress", "sleep", "sleeping", "sleepwear", "comforter", "blanket", "quilt", "bedroom"]],
  ["coffee", ["coffee", "espresso", "roaster", "brew"]],
  ["apparel", ["apparel", "clothing", "clothes", "shirt", "t-shirt", "tee", "tees", "dress", "fashion", "loungewear", "wear"]],
  ["footwear", ["shoe", "footwear", "sneaker", "boot", "sandal"]],
  ["supplements", ["supplement", "nootropic", "vitamin", "protein", "functional"]],
  ["nicotine and pouches", ["pouch", "nicotine"]],
  ["fragrance", ["perfume", "fragrance", "cologne", "scent", "candle"]],
  ["seafood and meat", ["seafood", "fish", "lobster", "crab", "meat", "steak", "beef"]],
  ["drinks", ["drink", "beverage", "soda", "seltzer", "thc"]],
  ["paintball", ["paintball", "airsoft"]],
  ["dental", ["dental", "dentist", "dentistry", "toothbrush", "teeth", "orthodontic"]],
  ["outdoor", ["outdoor", "camping", "camp", "hiking", "kayak", "paddle", "fishing", "hunting"]],
  ["pizza", ["pizza", "pizzeria", "wings"]],
];
const CANON = new Map<string, string>();
for (const [label, words] of GROUPS) for (const w of words) CANON.set(w, label);

const singular = (w: string) => (w.length > 4 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

/** What a business sells, as product words ("Bedding DTC brand" → bedding and sleep) */
export function productWords(detail: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const raw of (detail ?? "").toLowerCase().split(/[^a-z0-9'-]+/)) {
    const w = raw.replace(/^'+|'+$/g, "");
    if (w.length < 3 || STOP.has(w)) continue;
    const s = singular(w);
    if (STOP.has(s)) continue;
    out.add(CANON.get(w) ?? CANON.get(s) ?? s);
  }
  return out;
}

/** How close each peer is to the client, or nothing when it isn't comparable at all */
export function matchPeers(me: PeerInfo, peers: PeerInfo[], verticals: VerticalInfo[]): Map<string, PeerMatch> {
  const vById = new Map(verticals.map((v) => [v.id, v]));
  const myV = me.vertical_id ? vById.get(me.vertical_id) : undefined;
  const myParent = myV?.parent_id ? vById.get(myV.parent_id) : undefined;
  const mine = productWords(me.industry_detail);
  const out = new Map<string, PeerMatch>();
  for (const p of peers) {
    if (p.id === me.id) continue;
    const shared = [...productWords(p.industry_detail)].filter((w) => mine.has(w));
    const pv = p.vertical_id ? vById.get(p.vertical_id) : undefined;
    if (shared.length) {
      out.set(p.id, { tier: 1, why: `Also sells ${shared.slice(0, 2).join(", ")}${p.industry_detail ? ` (${p.industry_detail})` : ""}` });
    } else if (myV && pv && pv.id === myV.id) {
      out.set(p.id, { tier: 2, why: `Same niche: ${myV.name}${p.industry_detail ? `, though it sells ${p.industry_detail.toLowerCase()}` : ""}` });
    } else if ((myParent && pv?.parent_id === myParent.id) || (me.industry && me.industry !== "other" && p.industry === me.industry)) {
      out.set(p.id, { tier: 3, why: `Different product, same way of selling${myParent ? ` (${myParent.name})` : ""}${p.industry_detail ? `: ${p.industry_detail.toLowerCase()}` : ""}` });
    }
  }
  return out;
}

