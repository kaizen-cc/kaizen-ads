// Many social accounts per client (Head of Social, Nov 19 2026): a client can have several Facebook Pages and Instagram
// accounts, one per location. Pure parts, shared by the sync, the readers, the client page and the tests
// (tests/social-links.test.ts): which Pages are clearly a client's, the location in a Page's name, and the daily rows of
// several accounts added up per platform and day.

export type LinkPlatform = "facebook" | "instagram";
export type LinkedAccount = {
  id: string;
  platform: LinkPlatform;
  accountId: string;
  name: string | null;
  location: string | null;
  pageId: string | null;
  source: "primary" | "auto" | "manual";
  /** The last day its numbers were read, and why the last read failed (null when it worked) */
  lastReadAt?: string | null;
  lastError?: string | null;
};

/** Where an account stands: reading, waiting for its first read, or needing access (with Meta's reason) */
export function accountStatus(a: Pick<LinkedAccount, "lastReadAt" | "lastError">, now = Date.now()): { state: "reading" | "pending" | "access"; text: string } {
  if (a.lastError) return { state: "access", text: a.lastError };
  if (a.lastReadAt && now - Date.parse(a.lastReadAt) < 3 * 86_400_000) return { state: "reading", text: "Linked and reading" };
  if (a.lastReadAt) return { state: "access", text: "Not read in the last 3 days" };
  return { state: "pending", text: "Waiting for its first read" };
}

export type LocationGroup = { key: string; label: string; accounts: LinkedAccount[] };

/**
 * The client's locations: accounts sharing a location label are one location (its Facebook Page and its Instagram
 * paired); an account with no label stands alone under its own name. Ordered by label.
 */
export function locationGroups(accounts: readonly LinkedAccount[]): LocationGroup[] {
  const by = new Map<string, LocationGroup>();
  for (const a of accounts) {
    const label = a.location?.trim() || (a.platform === "instagram" && a.name ? `@${a.name.replace(/^@/, "")}` : (a.name ?? a.accountId));
    const key = a.location?.trim() ? `loc:${a.location.trim().toLowerCase()}` : `acct:${a.platform}:${a.accountId}`;
    const g = by.get(key) ?? { key, label, accounts: [] };
    g.accounts.push(a);
    by.set(key, g);
  }
  return [...by.values()].sort((x, y) => x.label.localeCompare(y.label));
}

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

/** The brand a Page's name gives, without the location after a dash or a bar or in brackets ("Mama Betty's Tex-Mex - Parmer Ln" → "Mama Betty's Tex-Mex") */
export function pageBrand(pageName: string): string {
  const s = pageName.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return s.split(/\s+[-–—|·]\s+|\s*\|\s*/)[0]?.trim() || s;
}

/**
 * Whether the Pages carrying the client's name are different brands ("Giant Texas" and "Giant Texas Distillers" for the
 * client Giant Texas): a name can't tell which is theirs, so it's a person's pick. One brand's locations ("Mama Betty's
 * Tex-Mex - Parmer Ln", "… - Burnett Rd") are one brand.
 */
export function brandsDiffer(pages: readonly { name: string }[], clientName: string): boolean {
  const mine = nameWords(clientName);
  if (!mine.length) return false;
  return new Set(pages.filter((p) => fits(p.name, mine)).map((p) => nameWords(pageBrand(p.name)).join(" "))).size > 1;
}

/**
 * The Pages that are clearly this client's: every word of its name is in the Page's name, and no other client's name
 * fits the Page as well or better (a Page that could be either "Tejas Beer" or "Tejas Brewery" is a person's pick, not a
 * guess), and they're all one brand (Pages of two brands carrying the name, none is linked). Each with the location its
 * name carries.
 */
export function clientPages<T extends { id: string; name: string }>(pages: readonly T[], clientName: string, otherClients: readonly string[] = []): { page: T; location: string | null }[] {
  const mine = nameWords(clientName);
  if (!mine.length) return [];
  const others = otherClients.map(nameWords).filter((w) => w.length && w.join(" ") !== mine.join(" "));
  const fit = pages.filter((p) => fits(p.name, mine)).filter((p) => !others.some((o) => o.length >= mine.length && fits(p.name, o)));
  if (brandsDiffer(fit, clientName)) return [];
  return fit.map((page) => ({ page, location: locationOf(page.name, clientName) }));
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

/** Who changes a client's social connections: Team & setup's rule (src/lib/setup-access.ts), executives, leads and the line heads */
export const canConnectSocial = (me: { isExec?: boolean; isLead?: boolean; role?: string | null }) => Boolean(me.isExec || me.isLead || String(me.role ?? "").startsWith("head_of_"));
