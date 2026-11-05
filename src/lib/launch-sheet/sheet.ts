import type { BudgetPeriod, BudgetTier, Cell, Column, ColumnRole, Grid, LaunchRow, LaunchSheet } from "./types";

// A grid (from a PDF, an XLSX, a CSV or a Google Sheet) read as a launch sheet: the header lines above the table (the
// event, its date, link, goal and total budget), a budget block (periods with an amount each, per platform), the
// table of ads (one row per ad or post: date, Page, place, creative, copy options) and footnotes. Nothing here is
// specific to one client or one sheet: columns are found by their headers, and anything unknown is kept as is so the
// model and the buyer can read it.

const ROLE_RULES: [RegExp, ColumnRole][] = [
  [/^(start\s*)?(launch\s*)?date|^go.?live|^start$|^when$|^launch on/i, "date"],
  [/^end\s*date|^end$|^stop/i, "end_date"],
  [/landing|url|destination|website|event\s*link/i, "link"],
  [/page|identity|publish|posting as|account to run/i, "page"],
  [/access|granted|permission/i, "access"],
  [/geo|location|city|market|region|radius|zip/i, "geo"],
  [/headline|title/i, "headline"],
  [/primary\s*text|body|caption|ad\s*copy|^copy/i, "primary"],
  [/description|link\s*desc/i, "description"],
  [/creative|asset|image|video|file|design|post\s*link|ad\s*link/i, "creative"],
  [/cta|call.to.action|button/i, "cta"],
  [/audience|targeting|interest/i, "audience"],
  [/budget|spend/i, "budget"],
  [/placement/i, "placement"],
  [/status|launched|live\?/i, "status"],
  [/campaign/i, "campaign"],
  [/ad\s*set|adset/i, "adset"],
  [/ad\s*name/i, "ad_name"],
  [/note|comment/i, "notes"],
];

export function roleOf(header: string): { role: ColumnRole; n: number | null } {
  const h = header.trim();
  const n = Number(h.match(/(\d+)\s*$/)?.[1] ?? NaN);
  for (const [re, role] of ROLE_RULES) if (re.test(h)) return { role, n: Number.isFinite(n) ? n : null };
  return { role: "other", n: null };
}

const HEADER_WORDS = /^(date|start date|end date|page|page to publish on|ad access granted\??|geographic location|geo|location|creative|headline|primary text|description|cta|url|landing page|link|audience|budget|placement|status|notes?|campaign|ad set|ad name)\b/i;

/** The table's header row: the row with the most cells that read like launch sheet headers (at least 3, and copy) */
export function findHeader(rows: Cell[][]): number {
  let best = -1;
  let score = 0;
  rows.forEach((r, i) => {
    const cells = r.map((c) => c.text.trim()).filter(Boolean);
    if (cells.length < 3) return;
    const known = cells.filter((t) => t.length < 40 && (HEADER_WORDS.test(t) || roleOf(t).role !== "other")).length;
    const copy = cells.some((t) => /headline|primary|caption|copy|creative/i.test(t));
    const s = known + (copy ? 2 : 0);
    if (known >= 3 && s > score) {
      score = s;
      best = i;
    }
  });
  return best;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(m)}-${pad(d)}` : null);
const fullYear = (y: string) => (y.length <= 2 ? 2000 + Number(y) : Number(y));

/** "8/10/26", "2026-08-10", "Aug 10", "10/31" (year from the sheet) as YYYY-MM-DD */
export function parseDate(text: string, year: number): string | null {
  const t = text.trim();
  // An Excel date serial (days since 1899-12-30)
  if (/^\d{5}(\.\d+)?$/.test(t) && Number(t) > 30000 && Number(t) < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(t)) * 86_400_000).toISOString().slice(0, 10);
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b/);
  if (m) return iso(m[3] ? fullYear(m[3]) : year, Number(m[1]), Number(m[2]));
  m = t.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/i);
  const month = m ? (MONTHS[m[1].slice(0, 4).toLowerCase()] ?? MONTHS[m[1].slice(0, 3).toLowerCase()]) : undefined;
  if (m && month) return iso(m[3] ? Number(m[3]) : year, month, Number(m[2]));
  return null;
}

/** "Sep 21–27", "Sep 28–Oct 4", "9/21 - 9/27" as a start and end date */
export function parseRange(text: string, year: number): { start: string | null; end: string | null } {
  const t = text.replace(/[–—]/g, "-").trim();
  const [a, b] = t.split(/\s*-\s*|\s+to\s+/i);
  const start = parseDate(a ?? "", year);
  if (!start || !b) return { start, end: null };
  let end = parseDate(b, year);
  if (!end && /^\d{1,2}$/.test(b.trim())) end = `${start.slice(0, 8)}${pad(Number(b))}`;
  // A range across the new year ("Dec 28 - Jan 3")
  if (end && end < start) end = `${Number(end.slice(0, 4)) + 1}${end.slice(4)}`;
  return { start, end };
}

/** "$1,500.00" → 1500 (null when there's no amount) */
export function money(text: string): number | null {
  const m = text.replace(/,/g, "").match(/-?\$?\s*(\d+(?:\.\d+)?)\s*(k)?\b/i);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] ? 1000 : 1);
  return Number.isFinite(n) ? n : null;
}

const NAMED: [string, (r: number, g: number, b: number) => boolean][] = [
  ["red", (r, g, b) => r > 180 && g < 120 && b < 120],
  ["green", (r, g, b) => g > 150 && r < 160 && b < 160],
  ["yellow", (r, g, b) => r > 200 && g > 200 && b < 150],
  ["orange", (r, g, b) => r > 200 && g > 110 && g < 200 && b < 120],
  ["blue", (r, g, b) => b > 180 && r < 170],
  ["purple", (r, g, b) => r > 120 && b > 150 && g < 120],
  ["pink", (r, g, b) => r > 220 && g < 210 && b > 180],
  ["gray", (r, g, b) => Math.abs(r - g) < 12 && Math.abs(g - b) < 12 && r < 230],
];
/** A cell color as a plain word ("red", "green"), for asking what it means */
export function colorName(hex: string | null): string | null {
  if (!hex) return null;
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return NAMED.find(([, f]) => f(r, g, b))?.[0] ?? hex;
}

const POST_RE = /https?:\/\/(?:www\.)?(?:instagram\.com\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/[\w-]+|facebook\.com\/[^\s]+\/(?:posts|videos)\/[\w.-]+|fb\.watch\/[\w-]+)/i;
export const isPostUrl = (u: string) => POST_RE.test(u);
const URL_RE = /https?:\/\/[^\s<>"')]+/g;

const footRefs = (s: string) => [...s.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1]));
const stripRefs = (s: string) => s.replace(/\s*\[\d{1,2}\]/g, "").trim();

/** The year the sheet is about: the most common year among dates written with one, else today's */
function sheetYear(rows: Cell[][], today: string) {
  const years = new Map<number, number>();
  for (const r of rows)
    for (const c of r) {
      const m = c.text.match(/\b\d{1,2}\/\d{1,2}\/(\d{2,4})\b/) ?? c.text.match(/\b(20\d{2})-\d{2}-\d{2}\b/);
      if (m) years.set(fullYear(m[1]), (years.get(fullYear(m[1])) ?? 0) + 1);
    }
  return [...years].sort((a, b) => b[1] - a[1])[0]?.[0] ?? Number(today.slice(0, 4));
}

const first = (r: Cell[], from = 1) => r.slice(from).find((c) => c.text.trim() || c.links.length) ?? null;

/** Reads a grid as a launch sheet. today (YYYY-MM-DD) fills in a year the sheet leaves out. */
export function gridToSheet(grid: Grid, today: string): LaunchSheet {
  const rows = grid.rows;
  const year = sheetYear(rows, today);
  const h = findHeader(rows);
  const warnings: string[] = [];
  const sheet: LaunchSheet = {
    title: "",
    event: { name: "", dateText: "", date: null, link: null, location: "" },
    goal: "",
    totalBudget: null,
    spentToDate: null,
    spentThrough: null,
    budgets: [],
    columns: [],
    rows: [],
    footnotes: [],
    facts: [],
    via: "layout",
    warnings,
  };
  if (h < 0) warnings.push("No table header was found (columns like Date, Page, Creative, Headline, Primary Text).");

  // ─── Above the table: key and value lines, and the budget block ───────────────────────────────────────────
  const above = h < 0 ? [] : rows.slice(0, h);
  let periods: { col: number; label: string; start: string | null; end: string | null }[] = [];
  for (const r of above) {
    const label = r[0]?.text.trim() ?? "";
    const value = first(r);
    const v = value?.text.trim() ?? "";
    const cellsAfter = r.slice(1).filter((c) => c.text.trim());
    if (/^(dates?|periods?|weeks?|flight)$/i.test(label) && cellsAfter.length >= 2) {
      periods = r.slice(1).flatMap((c, i) => (c.text.trim() ? [{ col: i + 1, label: c.text.trim(), ...parseRange(c.text, year) }] : []));
      continue;
    }
    if (periods.length && /budget|spend/i.test(label) && !/^budget tiers?$/i.test(label)) {
      const tier: BudgetTier = {
        platform: label.replace(/\s*budget\s*/i, "").trim() || "All",
        periods: periods.map((p): BudgetPeriod => ({ label: p.label, start: p.start, end: p.end, amount: money(r[p.col]?.text ?? "") })),
      };
      if (tier.periods.some((p) => p.amount != null)) sheet.budgets.push(tier);
      continue;
    }
    if (!label || /^budget tiers?$/i.test(label)) continue;
    if (/^(event|campaign|launch|name|title|show|promotion)( name)?$/i.test(label)) sheet.event.name = v;
    else if (/date/i.test(label)) {
      sheet.event.dateText = v;
      sheet.event.date = parseDate(v, year);
    } else if (/total.*budget|^budget$/i.test(label)) sheet.totalBudget = money(stripRefs(v));
    else if (/link|url|website|landing/i.test(label)) sheet.event.link = value?.links[0] ?? v.match(URL_RE)?.[0] ?? null;
    else if (/goal|objective|optimi[sz]e|kpi/i.test(label)) sheet.goal = v;
    else if (/location|city|market|venue/i.test(label)) sheet.event.location = v;
    else if (v) sheet.facts.push({ label, value: v });
  }
  sheet.title = sheet.event.name;

  // ─── The table ──────────────────────────────────────────────────────────────────────────────────────────────
  if (h >= 0) {
    const header = rows[h];
    sheet.columns = header.flatMap((c, i): Column[] => (c.text.trim() ? [{ index: i, header: c.text.trim(), ...roleOf(c.text) }] : []));
    const col = (role: ColumnRole) => sheet.columns.filter((c) => c.role === role);
    const copyNums = [...new Set([...col("headline"), ...col("primary"), ...col("description")].map((c) => c.n ?? 1))].sort((a, b) => a - b);
    let last: LaunchRow | null = null;
    for (let i = h + 1; i < rows.length; i++) {
      const r = rows[i];
      const all = r.map((c) => c.text.trim()).filter(Boolean);
      if (!all.length && !r.some((c) => c.links.length)) continue;
      // Footnotes: "[1] …", and the lines that continue one
      const lead = r[0]?.text.trim() ?? "";
      const only = all.length === 1 && lead === all[0];
      if (/^\[\d{1,2}\]/.test(all[0] ?? "") && only) {
        sheet.footnotes.push({ n: Number(all[0].match(/^\[(\d+)\]/)![1]), text: all[0].replace(/^\[\d+\]\s*/, "") });
        continue;
      }
      if (only && sheet.footnotes.length && !r.some((c) => c.color)) {
        sheet.footnotes[sheet.footnotes.length - 1].text += ` ${lead}`;
        continue;
      }
      const get = (role: ColumnRole, n?: number) => {
        const c = sheet.columns.find((x) => x.role === role && (n == null || (x.n ?? 1) === n));
        return c ? r[c.index] : undefined;
      };
      const text = (role: ColumnRole, n?: number) => get(role, n)?.text.trim() ?? "";
      let dateText = text("date");
      let page = text("page");
      // A date that ran into the next column's text when the file was made ("8/10/26 Mad City Bar" + "Fest")
      const spill = dateText.match(/^(\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?|\d{4}-\d{2}-\d{2})\s+(.+)$/);
      if (spill && col("page").length) {
        dateText = spill[1];
        page = `${spill[2]} ${page}`.trim();
      }
      const creativeCell = get("creative");
      const creativeText = creativeCell?.text.trim() ?? "";
      const links = [...new Set([...(creativeCell?.links ?? []), ...(creativeText.match(URL_RE) ?? [])])];
      const post = links.find(isPostUrl) ?? null;
      const copy = copyNums
        .map((n) => ({ headline: stripRefs(text("headline", n)), primary: text("primary", n), description: text("description", n) }))
        .filter((c) => c.headline || c.primary || c.description);
      const known = new Set(sheet.columns.filter((c) => c.role !== "other").map((c) => c.index));
      const extra = Object.fromEntries(sheet.columns.filter((c) => !known.has(c.index) && r[c.index]?.text.trim()).map((c) => [c.header, r[c.index].text.trim()]));
      for (const c of col("notes").concat(col("status"), col("budget"), col("placement"), col("campaign"), col("adset"), col("ad_name"))) if (r[c.index]?.text.trim()) extra[c.header] = r[c.index].text.trim();
      const hex = r.find((c) => c.color)?.color ?? null;
      const row: LaunchRow = {
        index: sheet.rows.length,
        dateText,
        date: parseDate(dateText, year),
        endDate: text("end_date") ? parseDate(text("end_date"), year) : null,
        page,
        access: text("access"),
        geo: text("geo"),
        creative: { name: stripRefs(creativeText.replace(URL_RE, "").trim()) || (post ? "Existing post" : ""), links },
        existingPost: post,
        copy,
        link: get("link")?.links[0] ?? text("link").match(URL_RE)?.[0] ?? null,
        cta: text("cta"),
        audience: text("audience"),
        color: colorName(hex),
        colorHex: hex,
        notes: [...new Set(r.flatMap((c) => footRefs(c.text)))],
        extra,
      };
      // A row with no date, Page, creative or copy is a note line inside the table: kept as a fact
      if (!row.dateText && !row.page && !row.creative.name && !links.length && !copy.length) {
        sheet.facts.push({ label: "Note in the table", value: all.join(" · ") });
        continue;
      }
      sheet.rows.push(row);
      last = row;
    }
    void last;
  }

  // ─── What the footnotes and the header add ──────────────────────────────────────────────────────────────────
  for (const f of sheet.footnotes) {
    const spent = f.text.match(/spent(?:\s+through\s+([a-z]+\s+\d{1,2}(?:,\s*\d{4})?))?[^$]{0,40}\$\s?([\d,]+(?:\.\d+)?)/i);
    if (spent && sheet.spentToDate == null) {
      sheet.spentToDate = money(spent[2]);
      sheet.spentThrough = spent[1] ? parseDate(spent[1], year) : null;
    }
  }
  if (!sheet.event.link) sheet.event.link = sheet.rows.find((r) => r.link)?.link ?? null;
  if (sheet.rows.length && !sheet.rows.some((r) => r.copy.length)) warnings.push("No copy columns were found (Headline, Primary Text).");
  if (sheet.rows.some((r) => r.dateText && !r.date)) warnings.push("Some dates couldn't be read.");
  return sheet;
}

/** Does this grid look like a launch sheet (a table of ads with copy or creative)? Quick, for deciding what a shared file is. */
export function looksLikeLaunchSheet(grid: Grid) {
  const h = findHeader(grid.rows);
  if (h < 0) return false;
  const roles = new Set(grid.rows[h].map((c) => roleOf(c.text).role));
  return (roles.has("headline") || roles.has("primary") || roles.has("creative")) && grid.rows.length > h + 1;
}
