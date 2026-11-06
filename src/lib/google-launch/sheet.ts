// A Google buyer's sheet (a Google Sheets link, an Excel file or a CSV) read into the launch's draft, whatever layout
// they use: one row per keyword with Campaign / Ad group / Keyword / Match type, a wide row per ad group with
// Headline 1..15 and Description 1..4, one tab per ad group, or loose lists (a Keywords column and a Headlines
// column). Match types written as [exact] and "phrase" are understood, pins written into the copy too ("(pin 1)").
// Pure: the model reads only what this can't (tests/google-launch.test.ts).

import type { Cell, Grid } from "@/lib/launch-sheet/types";
import { matchOf, parsePinned, splitKeywords, uniqKeywords, type AdLine, type DraftAdGroup, type GoogleDraft, type Kw, type Match, type Rsa } from "./core";

export type Tab = { title: string; grid: Grid };

type Role = "campaign" | "ad_group" | "keyword" | "match" | "headline" | "headlines" | "description" | "descriptions" | "path1" | "path2" | "final_url" | "negative" | "ag_negative" | "other";
type Col = { index: number; role: Role; n: number | null };

/** What a column holds, by its header */
export function googleRole(header: string): { role: Role; n: number | null } {
  const h = header.replace(/\s+/g, " ").trim().toLowerCase();
  if (!h) return { role: "other", n: null };
  let m: RegExpMatchArray | null;
  if (/^campaign( name)?$/.test(h)) return { role: "campaign", n: null };
  if (/^ad ?group( name)?$/.test(h)) return { role: "ad_group", n: null };
  if (/ad ?group negative/.test(h)) return { role: "ag_negative", n: null };
  if (/negative/.test(h)) return { role: "negative", n: null };
  if (/match ?type|^match$/.test(h)) return { role: "match", n: null };
  if (/^(keywords?|keyword text|search terms?|kws?|terms?)$/.test(h)) return { role: "keyword", n: null };
  if ((m = h.match(/^(?:rsa )?headline\s*#?\s*(\d{1,2})\b/))) return { role: "headline", n: Number(m[1]) };
  if (/^(rsa )?headlines$/.test(h)) return { role: "headlines", n: null };
  if ((m = h.match(/^(?:rsa )?desc(?:ription)?\.?\s*#?\s*(\d)\b/))) return { role: "description", n: Number(m[1]) };
  if (/^(rsa )?descriptions$/.test(h)) return { role: "descriptions", n: null };
  if (/^(display )?path ?1$/.test(h)) return { role: "path1", n: null };
  if (/^(display )?path ?2$/.test(h)) return { role: "path2", n: null };
  if (/final ?url|landing ?page|^url$|^link$|destination/.test(h)) return { role: "final_url", n: null };
  return { role: "other", n: null };
}

const MEANINGFUL: Role[] = ["campaign", "ad_group", "keyword", "match", "headline", "headlines", "description", "descriptions", "negative", "ag_negative", "final_url"];

/** The header row: the first 20 rows' best at naming Google's columns (at least two, one of them keywords or copy) */
function findHeader(rows: Cell[][]): { at: number; cols: Col[] } | null {
  let best: { at: number; cols: Col[]; score: number } | null = null;
  rows.slice(0, 20).forEach((row, at) => {
    const cols = row.map((c, index) => ({ index, ...googleRole(c.text) })).filter((c) => c.role !== "other");
    const roles = new Set(cols.map((c) => c.role));
    const score = cols.filter((c) => MEANINGFUL.includes(c.role)).length;
    const core = ["keyword", "headline", "headlines", "description", "descriptions", "negative", "ag_negative"].some((r) => roles.has(r as Role));
    if (core && (score >= 2 || (score === 1 && roles.size === 1)) && (!best || score > best.score)) best = { at, cols, score };
  });
  return best ? { at: (best as { at: number }).at, cols: (best as { cols: Col[] }).cols } : null;
}

/** Does this sheet read like a Google launch (keywords, match types, RSA headlines and descriptions)? */
export function looksLikeGoogleSheet(grid: Grid | null | undefined) {
  if (!grid) return false;
  const h = findHeader(grid.rows);
  if (!h) return false;
  const roles = new Set(h.cols.map((c) => c.role));
  return roles.has("keyword") || roles.has("match") || (roles.has("headline") && roles.has("description")) || roles.has("ad_group");
}

const GENERIC_TAB = /^(sheet|tab|page|hoja)\s*\d*$|^(keywords?|copy|ads?|rsas?|data|summary|overview|instructions?|notes?)$/i;
const isUrl = (s: string) => /^https?:\/\//i.test(s.trim());

/** The links in a cell (its text when it's a link, or its hyperlink) */
const urlOf = (c: Cell | undefined) => (c ? (isUrl(c.text) ? c.text.trim() : (c.links.find(isUrl) ?? "")) : "");

/**
 * The sheet's tabs read into a draft: ad groups (with their campaign as the sheet names it), keywords, negatives and
 * RSAs, and notes on anything that couldn't be placed. recognized: false when no tab had Google columns (the model
 * reads it instead). fallback: the match type for a plain keyword when nothing says (marked so the buyer is asked).
 */
export function tabsToDraft(tabs: Tab[], fallback: Match = "PHRASE"): { draft: GoogleDraft; recognized: boolean } {
  const groups = new Map<string, DraftAdGroup & { list: { h: AdLine[]; d: AdLine[] } }>();
  const campaignNegs = new Map<string, Kw[]>();
  const notes: string[] = [];
  let recognized = false;
  const named = tabs.filter((t) => !GENERIC_TAB.test(t.title.trim())).length;
  for (const tab of tabs) {
    const head = findHeader(tab.grid.rows);
    if (!head) continue;
    recognized = true;
    const byRole = (r: Role) => head.cols.filter((c) => c.role === r);
    const one = (row: Cell[], r: Role) => {
      const c = byRole(r)[0];
      return c ? (row[c.index]?.text ?? "").trim() : "";
    };
    const negTab = /negative/i.test(tab.title);
    const tabGroup = !byRole("ad_group").length && named > 1 && !GENERIC_TAB.test(tab.title.trim()) && !negTab ? tab.title.trim() : "";
    let campaign = "";
    let adGroup = "";
    const group = (c: string, g: string) => {
      const key = `${c.toLowerCase()}|${g.toLowerCase()}`;
      let x = groups.get(key);
      if (!x) {
        x = { campaign: c, name: g, finalUrl: "", keywords: [], negatives: [], rsas: [], list: { h: [], d: [] } };
        groups.set(key, x);
      }
      return x;
    };
    for (const row of tab.grid.rows.slice(head.at + 1)) {
      if (!row.some((c) => c.text.trim())) continue;
      const c = one(row, "campaign");
      const g = one(row, "ad_group");
      if (c && c !== campaign) {
        campaign = c;
        if (!g) adGroup = "";
      }
      if (g) adGroup = g;
      const gName = adGroup || tabGroup;
      const match = matchOf(one(row, "match"));
      const kws = byRole("keyword").flatMap((col) => splitKeywords(row[col.index]?.text ?? "", match, fallback));
      const negs = [...byRole("negative"), ...byRole("ag_negative")].flatMap((col) => splitKeywords(row[col.index]?.text ?? "", matchOf(one(row, "match")) ?? null, "PHRASE").map((k) => ({ ...k, level: col.role })));
      const heads = byRole("headline")
        .sort((a, b) => (a.n ?? 0) - (b.n ?? 0))
        .map((col) => parsePinned(row[col.index]?.text ?? "", 3))
        .filter((l) => l.text);
      const descs = byRole("description")
        .sort((a, b) => (a.n ?? 0) - (b.n ?? 0))
        .map((col) => parsePinned(row[col.index]?.text ?? "", 2))
        .filter((l) => l.text);
      const listH = byRole("headlines").flatMap((col) => (row[col.index]?.text ?? "").split(/\r?\n/).map((t) => parsePinned(t, 3)).filter((l) => l.text));
      const listD = byRole("descriptions").flatMap((col) => (row[col.index]?.text ?? "").split(/\r?\n/).map((t) => parsePinned(t, 2)).filter((l) => l.text));
      const url = byRole("final_url").map((col) => urlOf(row[col.index])).find(Boolean) ?? "";
      const path1 = one(row, "path1").replace(/^\/+/, "");
      const path2 = one(row, "path2").replace(/^\/+/, "");
      // A keyword written as a negative ("-free") in the keyword column is a negative
      const plainKws: Kw[] = kws.filter((k) => !k.negative).map((k) => ({ text: k.text, match: k.match, from: k.from }));
      const allNegs = [...negs, ...kws.filter((k) => k.negative).map((k) => ({ ...k, level: "negative" as Role }))];
      const needsGroup = plainKws.length || heads.length || descs.length || listH.length || listD.length || allNegs.some((n) => n.level === "ag_negative");
      if (needsGroup) {
        const x = group(campaign, gName);
        x.keywords.push(...plainKws);
        if (url && !x.finalUrl) x.finalUrl = url;
        if (heads.length || descs.length) {
          const rsa = { headlines: heads, descriptions: descs, path1, path2, finalUrl: url };
          if (!x.rsas.some((r) => JSON.stringify(r) === JSON.stringify(rsa))) x.rsas.push(rsa);
        }
        x.list.h.push(...listH);
        x.list.d.push(...listD);
        for (const n of allNegs.filter((n) => n.level === "ag_negative")) x.negatives.push({ text: n.text, match: n.match, from: n.from });
      }
      for (const n of allNegs.filter((n) => n.level !== "ag_negative")) {
        const k = negTab && !campaign ? "" : campaign;
        campaignNegs.set(k, [...(campaignNegs.get(k) ?? []), { text: n.text, match: n.match, from: n.from }]);
      }
    }
  }
  const adGroups: DraftAdGroup[] = [...groups.values()].map(({ list, ...g }) => {
    const rsas: Omit<Rsa, "key">[] = [...g.rsas];
    if (list.h.length || list.d.length) rsas.push({ headlines: dedupeLines(list.h), descriptions: dedupeLines(list.d), path1: "", path2: "", finalUrl: g.finalUrl });
    return { ...g, keywords: uniqKeywords(g.keywords), negatives: uniqKeywords(g.negatives), rsas: rsas.map((r) => ({ ...r, finalUrl: r.finalUrl || g.finalUrl })) };
  });
  const unnamed = adGroups.filter((g) => !g.name);
  if (unnamed.length) notes.push(`${unnamed.length === 1 ? "One group of keywords or copy has" : `${unnamed.length} groups of keywords or copy have`} no ad group name: they're asked about.`);
  const dupes = new Map<string, string[]>();
  for (const g of adGroups) for (const k of g.keywords) dupes.set(`${k.match}|${k.text}`, [...(dupes.get(`${k.match}|${k.text}`) ?? []), g.name || "(no name)"]);
  const across = [...dupes].filter(([, gs]) => new Set(gs).size > 1);
  if (across.length) notes.push(`${across.length} keyword${across.length === 1 ? " is" : "s are"} in more than one ad group (${across.slice(0, 3).map(([k, gs]) => `${k.split("|")[1]} in ${[...new Set(gs)].join(" and ")}`).join("; ")}).`);
  return { draft: { adGroups, campaignNegatives: [...campaignNegs].map(([campaign, keywords]) => ({ campaign, keywords: uniqKeywords(keywords) })), notes }, recognized };
}

const dedupeLines = (l: AdLine[]) => {
  const seen = new Set<string>();
  return l.filter((x) => {
    const n = x.text.toLowerCase();
    if (seen.has(n)) return false;
    seen.add(n);
    return true;
  });
};

/** The buyer's answer to "which match type" applied to the keywords that had none ("Exact and phrase, both" adds both) */
export function applyMatchAnswer(d: GoogleDraft, answer: string): GoogleDraft {
  const a = answer.toLowerCase();
  const both = /both|and/.test(a) && /exact/.test(a) && /phrase/.test(a);
  const m: Match | null = both ? "EXACT" : /exact/.test(a) ? "EXACT" : /phrase/.test(a) ? "PHRASE" : /broad/.test(a) ? "BROAD" : null;
  if (!m) return d;
  return {
    ...d,
    adGroups: d.adGroups.map((g) => ({
      ...g,
      keywords: uniqKeywords(g.keywords.flatMap((k): Kw[] => (k.from !== "default" ? [k] : both ? [{ ...k, match: "EXACT", from: "column" }, { ...k, match: "PHRASE", from: "column" }] : [{ ...k, match: m, from: "column" }]))),
    })),
  };
}
