// Sorting the KPI card's "Ads this week" table. The sort lives in the address (?adsort=hook, ?adsort=cost.desc) so
// back and forward walk through it. Plain functions, shared by the table and the tests.

export type AdSortKey = "spend" | "results" | "cost" | "ctr" | "hook" | "hold" | "watch";
export type AdSort = { key: AdSortKey; dir: "asc" | "desc" };

type Sortable = { spend: number; results: number; value: number | null; ctr: number | null; hookRate: number | null; holdRate: number | null; watchPct: number | null };

export const AD_SORT_KEYS: AdSortKey[] = ["spend", "results", "cost", "ctr", "hook", "hold", "watch"];

/**
 * Which way a column sorts first: the best first. Cost per result is best when lowest; on a ROAS card the "cost" column
 * is ROAS, best when highest.
 */
export const firstDir = (key: AdSortKey, roas: boolean): AdSort["dir"] => (key === "cost" && !roas ? "asc" : "desc");

/** The sort in the address, or biggest spend first. */
export function parseAdSort(v: string | null | undefined, roas: boolean): AdSort {
  const [k, d] = String(v ?? "").split(".");
  const key = (AD_SORT_KEYS as string[]).includes(k) ? (k as AdSortKey) : "spend";
  return { key, dir: d === "asc" || d === "desc" ? d : firstDir(key, roas) };
}

/** How a sort is written in the address: just the column when it runs its first way, null for the default. */
export function adSortParam(s: AdSort, roas: boolean): string | null {
  if (s.key === "spend" && s.dir === "desc") return null;
  return s.dir === firstDir(s.key, roas) ? s.key : `${s.key}.${s.dir}`;
}

/** Clicking a column: its best-first way, or the other way when it's already sorted by it. */
export function nextAdSort(cur: AdSort, key: AdSortKey, roas: boolean): AdSort {
  if (cur.key !== key) return { key, dir: firstDir(key, roas) };
  return { key, dir: cur.dir === "asc" ? "desc" : "asc" };
}

const pick = (a: Sortable, key: AdSortKey): number | null =>
  key === "spend" ? a.spend : key === "results" ? a.results : key === "cost" ? a.value : key === "ctr" ? a.ctr : key === "hook" ? a.hookRate : key === "hold" ? a.holdRate : a.watchPct;

/** Sorted by the column; ads without a value (an image ad on hook rate, no results on cost) always last, by spend. */
export function sortAds<T extends Sortable>(ads: T[], s: AdSort): T[] {
  return [...ads].sort((a, b) => {
    const x = pick(a, s.key);
    const y = pick(b, s.key);
    if (x == null && y == null) return b.spend - a.spend;
    if (x == null) return 1;
    if (y == null) return -1;
    return (s.dir === "asc" ? x - y : y - x) || b.spend - a.spend;
  });
}
