// Reading the Email and Organic Social tabs of the Account Overview sheet (pure, so it's tested): the header row, the
// rows under it, and which columns name which seat.

export type ChannelTab = "email" | "social";
export type ChannelSeatRole = "email_strategist" | "email_designer" | "email_builder" | "social_manager" | "social_creative";

/** Rows as { header: cell }, from the first row (within the first five) that has a "Client Name" column */
export function sheetRows(values: string[][]): Record<string, string>[] {
  const at = values.slice(0, 5).findIndex((row) => row.some((c) => /^\s*client\s*name\s*$/i.test(c ?? "")));
  if (at < 0) return [];
  const headers = values[at].map((h) => (h ?? "").trim());
  return values.slice(at + 1).map((row) => Object.fromEntries(headers.map((h, i) => [h, (row[i] ?? "").trim()]).filter(([h]) => h)));
}

/** A cell that names nobody */
export const isBlankName = (s: string) => !s.trim() || /^(n\/?a|#n\/a|tbd|none|-+|—)$/i.test(s.trim());

/** "Ana / Luis", "Ana & Luis", "Ana, Luis" as people */
export const splitNames = (s: string) =>
  s
    .split(/[/,&+]| and /i)
    .map((x) => x.trim())
    .filter((x) => x.length > 1 && !/\d/.test(x));

/** The header a row has for one of several spellings */
const cell = (r: Record<string, string>, ...names: RegExp[]) => {
  for (const re of names) {
    const k = Object.keys(r).find((h) => re.test(h));
    if (k) return { column: k, value: r[k] ?? "" };
  }
  return null;
};

/**
 * The seats a row names. Email: Strategist, Designer, Builder. Organic Social: the Strategist (Assigned) is the social
 * media manager; the Graphic Designer holds the social creative seat and the Video Editor sits on it beside them.
 */
export function channelSeatsOf(line: ChannelTab, r: Record<string, string>): { role: ChannelSeatRole; column: string; value: string; primary: boolean }[] {
  const out: { role: ChannelSeatRole; column: string; value: string; primary: boolean }[] = [];
  const add = (role: ChannelSeatRole, c: { column: string; value: string } | null, primary = true) => {
    if (c && c.value.trim()) out.push({ role, ...c, primary });
  };
  if (line === "email") {
    add("email_strategist", cell(r, /^strategist/i));
    add("email_designer", cell(r, /^designer$/i, /email\s*designer/i));
    add("email_builder", cell(r, /^builder/i));
  } else {
    add("social_manager", cell(r, /^strategist/i, /social\s*media\s*manager/i));
    add("social_creative", cell(r, /graphic\s*designer/i, /^designer$/i));
    add("social_creative", cell(r, /video\s*editor/i), false);
  }
  return out;
}
