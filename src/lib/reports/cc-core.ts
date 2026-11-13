// Who a report email goes to and who is copied: plain functions (no server code), shared by every sender, the studio's
// preview and the tests. The client's contacts are all in To (one email); the team is in Cc: the media buyers on the
// account (the report's owner and the client's buyers on that platform) and the always-copied staff set in Settings.

export type Contact = { email: string; name?: string | null };

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i;

/** Each valid address once (lowercased), in order */
export function cleanEmails(list: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const e = String(raw ?? "").trim().toLowerCase();
    if (!e || e.length > 254 || !EMAIL.test(e) || seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

/**
 * The Cc line: the account's buyers first, then the always-copied staff; each address once, valid ones only, and never
 * an address that is already in To (a staff member who is also a client contact is not copied again).
 */
export function assembleCc(p: { to: readonly string[]; buyers: readonly (string | null | undefined)[]; always: readonly (string | null | undefined)[] }): string[] {
  const inTo = new Set(cleanEmails(p.to));
  return cleanEmails([...p.buyers, ...p.always]).filter((e) => !inTo.has(e));
}

/** The people to copy as profile ids: the report's owner and the buyers on the platforms, then the always-copied; each once */
export function ccProfileIds(p: { owners: readonly (string | null | undefined)[]; buyers: readonly (string | null | undefined)[]; always: readonly (string | null | undefined)[] }): { buyers: string[]; always: string[] } {
  const uniq = (xs: readonly (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => Boolean(x)))];
  const buyers = uniq([...p.owners, ...p.buyers]);
  return { buyers, always: uniq(p.always).filter((id) => !buyers.includes(id)) };
}

/** Everyone the email goes to by default: every contact the client has, primary first, each address once */
export function defaultRecipients<T extends Contact & { primary?: boolean }>(contacts: readonly T[]): T[] {
  const seen = new Set<string>();
  return [...contacts]
    .sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)))
    .filter((c) => {
      const e = c.email.trim().toLowerCase();
      if (!EMAIL.test(e) || seen.has(e)) return false;
      seen.add(e);
      return true;
    });
}

/**
 * A choice remembered earlier, plus the contacts the client has gained since (a contact added after the buyer last chose
 * is in by default: only ones the buyer saw and unticked stay out).
 */
export function recipientsToUse<T extends Contact & { addedAt?: string | null }>(contacts: readonly T[], saved: readonly Contact[] | null | undefined, savedAt: string | null | undefined): Contact[] {
  if (!saved?.length) return defaultRecipients(contacts).map((c) => ({ email: c.email, name: c.name ?? null }));
  const have = new Set(saved.map((r) => r.email.toLowerCase()));
  const added = contacts.filter((c) => !have.has(c.email.toLowerCase()) && savedAt && c.addedAt && c.addedAt > savedAt);
  return [...saved, ...added.map((c) => ({ email: c.email, name: c.name ?? null }))];
}

/** The first name the email opens with: one contact's, else null (the email then says "Hi team,") */
export const firstNameFor = (to: readonly Contact[]): string | null => (to.length === 1 ? to[0].name?.trim().split(/\s+/)[0] || null : null);

/** "Hi Sam," when the email goes to one contact (by their first name), else "Hi team," */
export const greetingFor = (to: readonly Contact[]): string => {
  const first = firstNameFor(to);
  return first ? `Hi ${first},` : "Hi team,";
};

/**
 * The button on a client's report email: their live dashboard, only when their portal is open to them and they aren't a
 * white label client. Otherwise there is no button (the PDF attached is the report).
 */
export function reportCtaUrl(c: { slug?: string | null; portal_live?: boolean | null; client_type?: string | null }, siteUrl: string): string | null {
  const t = String(c.client_type ?? "").toLowerCase().replace(/[\s_-]/g, "");
  return c.portal_live && c.slug && t !== "whitelabel" ? `${siteUrl}/c/${c.slug}/dashboard` : null;
}
