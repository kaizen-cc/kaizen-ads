// Where a link card's Open (or the agent's open_screen) goes: an outside site opens in a new tab; anything in the app
// goes through the app's router so the call stays up (a full link to the app itself counts as in the app); the screen
// already showing is refreshed instead of pushed again, so Open never looks like it did nothing. Pure, tested.

export type OpenPlan = { how: "tab"; href: string } | { how: "push"; href: string } | { how: "refresh"; href: string };

type Here = { origin: string; pathname: string; search: string; hash: string };

export function openPlan(card: { href: string; external?: boolean }, here: Here): OpenPlan {
  const raw = String(card.href ?? "").trim();
  let u: URL;
  try {
    u = new URL(raw, here.origin);
  } catch {
    return { how: "push", href: raw || "/" };
  }
  if (u.origin !== here.origin) return { how: "tab", href: u.toString() };
  const path = `${u.pathname}${u.search}${u.hash}`;
  // Same screen and same view: show it fresh (a hash change still moves to its spot)
  if (u.pathname === here.pathname && sameSearch(u.search, here.search) && (u.hash || "") === (here.hash || "")) return { how: "refresh", href: path };
  return { how: "push", href: path };
}

/** The same query whatever the order of its params */
function sameSearch(a: string, b: string): boolean {
  const norm = (s: string) => [...new URLSearchParams(s).entries()].map(([k, v]) => `${k}=${v}`).sort().join("&");
  return norm(a) === norm(b);
}
