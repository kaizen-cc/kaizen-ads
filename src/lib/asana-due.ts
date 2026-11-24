// "Next for me in Asana" by when it's due (owner, Nov 24 2026: "67 · every open Asana task that's yours" was alarming).
// The big number is what's due today (overdue included, said so); tomorrow and the rest of the week are small chips; the
// whole list is a quiet "N open in all". The list reads in the same order: overdue, today, tomorrow, this week, then
// later and undated (folded). New York days. Pure: tests/asana-due.test.ts.

export type DueBucket = "overdue" | "today" | "tomorrow" | "week" | "later";
const ORDER: DueBucket[] = ["overdue", "today", "tomorrow", "week", "later"];

const nyDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The coming Friday (today when it's Friday; next week's from Saturday) */
function friday(today: string): string {
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  return addDays(today, (5 - dow + 7) % 7);
}

/** Which bucket a due date falls in ("2026-11-24" or an ISO time; none is later) */
export function dueBucket(due: string | null | undefined, now = new Date()): DueBucket {
  if (!due) return "later";
  const d = String(due).slice(0, 10);
  const today = nyDay(now);
  if (d < today) return "overdue";
  if (d === today) return "today";
  const tomorrow = addDays(today, 1);
  if (d === tomorrow) return "tomorrow";
  return d <= friday(today) ? "week" : "later";
}

/** Due by the end of today (overdue included): what counts as on someone's plate today */
export const dueByToday = (due: string | null | undefined, now = new Date()) => ["overdue", "today"].includes(dueBucket(due, now));

/** The block's numbers: the big one (due today, overdue included), its label, the chips, and how many in all */
export function asanaSummary(cards: readonly { due?: string | null }[], now = new Date()): { big: number; label: string; chips: string[]; all: number } {
  const n: Record<DueBucket, number> = { overdue: 0, today: 0, tomorrow: 0, week: 0, later: 0 };
  for (const c of cards) n[dueBucket(c.due, now)]++;
  const big = n.overdue + n.today;
  const label = n.overdue ? `due today, incl. ${n.overdue} overdue` : "due today";
  const chips = [n.tomorrow ? `${n.tomorrow} tomorrow` : null, n.week ? `${n.week} by Friday` : null].filter((x): x is string => Boolean(x));
  return { big, label, chips, all: cards.length };
}

/** The list in that order (by date inside each), and how many sit in "later" (folded until asked for) */
export function orderAsana<T extends { due?: string | null }>(cards: readonly T[], now = new Date()): { soon: T[]; later: T[] } {
  const rank = (c: T) => ORDER.indexOf(dueBucket(c.due, now));
  const sorted = [...cards].sort((a, b) => rank(a) - rank(b) || String(a.due ?? "9999").localeCompare(String(b.due ?? "9999")));
  return { soon: sorted.filter((c) => dueBucket(c.due, now) !== "later"), later: sorted.filter((c) => dueBucket(c.due, now) === "later") };
}

/** A link in a task's description, as a short label instead of the raw address */
export function linkLabel(url: string): string {
  const u = url.toLowerCase();
  if (u.includes("loom.com")) return "Loom video";
  if (u.includes("asana.com") && (u.includes("get_asset") || u.includes("/attachments") || u.includes("asset_id"))) return "Attachment";
  if (u.includes("asana.com")) return "Asana link";
  if (u.includes("docs.google.com/spreadsheets")) return "Google Sheet";
  if (u.includes("docs.google.com/presentation")) return "Google Slides";
  if (u.includes("docs.google.com")) return "Google Doc";
  if (u.includes("drive.google.com")) return "Drive file";
  if (u.includes("figma.com")) return "Figma";
  if (u.includes("canva.com")) return "Canva";
  if (u.includes("slack.com")) return "Slack link";
  if (/(youtube\.com|youtu\.be)/.test(u)) return "YouTube video";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Link";
  }
}

/** A description cut into text and links (links shown as short labels), for about two lines */
export function describe(notes: string, max = 200): { text: string; href?: string }[] {
  const flat = String(notes ?? "").replace(/\s+/g, " ").trim();
  const parts: { text: string; href?: string }[] = [];
  let used = 0;
  let last = 0;
  for (const m of flat.matchAll(/https?:\/\/[^\s<>()"']+/g)) {
    const before = flat.slice(last, m.index);
    if (before) parts.push({ text: before });
    // A full stop or comma after a link is the sentence's, not the link's
    const url = m[0].replace(/[.,;:!?]+$/, "");
    parts.push({ text: linkLabel(url), href: url });
    last = (m.index ?? 0) + url.length;
  }
  if (last < flat.length) parts.push({ text: flat.slice(last) });
  // About two lines: words stop at the limit, links always whole
  const out: { text: string; href?: string }[] = [];
  for (const p of parts) {
    if (used >= max) break;
    if (p.href) {
      out.push(p);
      used += p.text.length;
      continue;
    }
    const room = max - used;
    out.push({ text: p.text.length > room ? `${p.text.slice(0, room).replace(/\s+\S*$/, "")}…` : p.text });
    used += Math.min(room, p.text.length);
  }
  return out;
}
