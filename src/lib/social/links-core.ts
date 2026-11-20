// Many social accounts per client (Head of Social, Nov 19 2026): a client can have several Facebook Pages and Instagram
// accounts, one per location. Pure parts, shared by the sync, the readers, the client page and the tests
// (tests/social-links.test.ts): which Pages are clearly a client's, the location in a Page's name, and the daily rows of
// several accounts added up per platform and day.

export type LinkPlatform = "facebook" | "instagram";
export type LinkedAccount = { id: string; platform: LinkPlatform; accountId: string; name: string | null; location: string | null; pageId: string | null; source: "primary" | "auto" | "manual" };

/** "platform:account" for a set of linked accounts */
export const linkKey = (platform: string, accountId: string | null | undefined) => `${platform}:${accountId ?? ""}`;

/** Letters only, accents folded ("Café" is "cafe"), so a name with an accent still matches its Page */
export const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

const STOP = new Set(["the", "and", "of", "llc", "inc", "co", "company", "group", "official", "page", "usa", "us"]);

/** A name's words that identify it ("Mama Betty's" → mama, betty), plural s dropped, so "Film" and "Films" agree */
export function nameWords(s: string): string[] {
  const words = fold(s)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOP.has(w))
    .map((w) => (w.length > 3 ? w.replace(/s$/, "") : w));
  return [...new Set(words)];
}

/** Every word of the client's name is in the Page's name */
const fits = (page: string, client: readonly string[]) => {
  if (!client.length) return false;
  const have = new Set(nameWords(page));
  return client.every((w) => have.has(w));
};

/**
 * The location a Page's name carries beyond the client's name: what follows a dash, a bar or sits in brackets
 * ("Mama Betty's Tex-Mex - Parmer Ln" → "Parmer Ln", "McIntyre's (Ocala)" → "Ocala"), else the words left over. Null when
 * the Page is just the client's name.
 */
export function locationOf(pageName: string, clientName: string): string | null {
  const bracket = pageName.match(/\(([^)]+)\)\s*$/)?.[1]?.trim();
  if (bracket) return bracket;
  const parts = pageName.split(/\s+[-–—|·]\s+|\s*\|\s*/).map((x) => x.trim()).filter(Boolean);
  const client = nameWords(clientName);
  if (parts.length > 1) {
    const last = parts.at(-1)!;
    if (!fits(last, client)) return last;
  }
  const rest = pageName
    .split(/\s+/)
    .filter((w) => {
      const n = nameWords(w);
      return n.length && !n.every((x) => client.includes(x));
    })
    .join(" ")
    .replace(/^[-|–—·\s]+|[-|–—·\s]+$/g, "")
    .trim();
  return rest || null;
}

/**
 * The Pages that are clearly this client's: every word of its name is in the Page's name, and no other client's name
 * fits the Page as well or better (a Page that could be either "Tejas Beer" or "Tejas Brewery" is a person's pick, not a
 * guess). Each with the location its name carries.
 */
export function clientPages<T extends { id: string; name: string }>(pages: readonly T[], clientName: string, otherClients: readonly string[] = []): { page: T; location: string | null }[] {
  const mine = nameWords(clientName);
  if (!mine.length) return [];
  const others = otherClients.map(nameWords).filter((w) => w.length && w.join(" ") !== mine.join(" "));
  return pages
    .filter((p) => fits(p.name, mine))
    .filter((p) => !others.some((o) => o.length >= mine.length && fits(p.name, o)))
    .map((page) => ({ page, location: locationOf(page.name, clientName) }));
}

export type DayRow = { platform: string; date: string; account_id?: string | null } & Record<string, unknown>;

/**
 * Several accounts' daily rows added up per platform and day (two locations' Pages are one Facebook for the client):
 * each number summed where any account has it, left null where none does.
 */
export function mergeAccountDays<R extends DayRow>(rows: readonly R[], fields: readonly string[]): R[] {
  const by = new Map<string, R>();
  for (const r of rows) {
    const k = `${r.platform}|${r.date}`;
    const had = by.get(k);
    if (!had) {
      by.set(k, { ...r });
      continue;
    }
    const next: Record<string, unknown> = { ...had };
    for (const f of fields) {
      const a = had[f];
      const b = r[f];
      next[f] = a == null && b == null ? null : (Number(a) || 0) + (Number(b) || 0);
    }
    by.set(k, next as R);
  }
  return [...by.values()].sort((a, b) => (a.platform === b.platform ? a.date.localeCompare(b.date) : a.platform.localeCompare(b.platform)));
}

/** A linked account in words: "Facebook · Parmer Ln (Mama Betty's Tex-Mex - Parmer Ln)" */
export function accountLabel(a: Pick<LinkedAccount, "platform" | "name" | "location">): string {
  const p = a.platform === "instagram" ? "Instagram" : "Facebook";
  const n = a.platform === "instagram" && a.name ? `@${a.name.replace(/^@/, "")}` : a.name;
  return `${p}${a.location ? ` · ${a.location}` : ""}${n ? ` (${n})` : ""}`;
}
