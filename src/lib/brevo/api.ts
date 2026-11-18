import "server-only";
import { ProviderError } from "../email-providers/core";
import { providerGet } from "../email-providers/http";
import { attributionQuery, BREVO_ACCOUNT, BREVO_ATTRIBUTION, BREVO_BASE, BREVO_EMAIL_CAMPAIGN, BREVO_EMAIL_CAMPAIGNS, BREVO_LISTS, BREVO_PAGE, BREVO_SEGMENTS, BREVO_SMS_CAMPAIGNS, BREVO_CONTACTS, brevoCount, parseBrevoClickTotals, parseBrevoLinkStats, brevoErrorText, brevoRange, parseAttribution, parseBrevoAccount, parseBrevoAudiences, parseBrevoCampaignContent, parseBrevoCampaigns, type Attribution, type BrevoAccount, type BrevoCampaign } from "./core";

// Brevo's REST API v3, read only (GET calls). The key travels in the `api-key` header. Calls wait and retry on 429 and
// 5xx; the key never reaches an error, a log or the database in plain text.

const get = (key: string, path: string) => providerGet({ base: BREVO_BASE, path, headers: { "api-key": key }, key, name: "Brevo", errorText: brevoErrorText, gapMs: 350 });

export async function getBrevoAccount(key: string): Promise<BrevoAccount> {
  const acc = parseBrevoAccount(await get(key, BREVO_ACCOUNT));
  if (!acc) throw new ProviderError("Brevo didn't say which account this key belongs to.", null);
  return acc;
}

/** Campaigns of one channel sent since `since` (ISO), newest first; pages follow the answer's own count */
export async function listBrevoCampaigns(key: string, channel: "email" | "sms", since: string, pages = 8, clickTotals?: Map<string, number>): Promise<BrevoCampaign[]> {
  const out: BrevoCampaign[] = [];
  const range = brevoRange(since);
  const size = channel === "email" ? BREVO_PAGE : 100;
  for (let i = 0; i < pages; i++) {
    const q = new URLSearchParams({ limit: String(size), offset: String(i * size), sort: "desc", startDate: range.startDate, endDate: range.endDate });
    if (channel === "email") {
      q.set("statistics", "globalStats");
      q.set("excludeHtmlContent", "true");
    }
    const json = await get(key, `${channel === "email" ? BREVO_EMAIL_CAMPAIGNS : BREVO_SMS_CAMPAIGNS}?${q}`);
    const rows = parseBrevoCampaigns(json, channel);
    out.push(...rows);
    // Every click (not only each person once), from the same answer
    if (clickTotals && channel === "email") for (const [id, x] of parseBrevoClickTotals(json)) clickTotals.set(id, x);
    if (!rows.length || (i + 1) * size >= brevoCount(json)) break;
  }
  return out;
}

/** Clicks per link for the email campaigns sent since `since` (statistics=linksStats), newest first, a page or a few */
export async function brevoLinkStats(key: string, since: string, pages = 1): Promise<Map<string, Record<string, number>>> {
  const out = new Map<string, Record<string, number>>();
  const range = brevoRange(since);
  for (let i = 0; i < pages; i++) {
    const q = new URLSearchParams({ limit: String(BREVO_PAGE), offset: String(i * BREVO_PAGE), sort: "desc", startDate: range.startDate, endDate: range.endDate, statistics: "linksStats", excludeHtmlContent: "true", status: "sent" });
    const json = await get(key, `${BREVO_EMAIL_CAMPAIGNS}?${q}`);
    for (const [id, links] of parseBrevoLinkStats(json)) out.set(id, links);
    if ((i + 1) * BREVO_PAGE >= brevoCount(json)) break;
  }
  return out;
}

/** How many contacts were created since this moment (ISO): one light call on the contacts endpoint (its own, higher limit) */
export async function brevoContactsSince(key: string, iso: string): Promise<number> {
  const q = new URLSearchParams({ limit: "1", offset: "0", createdSince: iso });
  return brevoCount(await get(key, `${BREVO_CONTACTS}?${q}`));
}

/** Lists (with their subscriber counts) or segments, every page */
export async function listBrevoAudiences(key: string, kind: "list" | "segment") {
  const out: ReturnType<typeof parseBrevoAudiences> = [];
  for (let i = 0; i < 10; i++) {
    const json = await get(key, `${kind === "list" ? BREVO_LISTS : BREVO_SEGMENTS}?limit=${BREVO_PAGE}&offset=${i * BREVO_PAGE}&sort=desc`);
    const rows = parseBrevoAudiences(json, kind);
    out.push(...rows);
    if (!rows.length || (i + 1) * BREVO_PAGE >= brevoCount(json)) break;
  }
  return out;
}

/** Orders and revenue Brevo attributes to these campaigns (lifetime of each), in batches of ids */
export async function brevoAttribution(key: string, email: string[], sms: string[], batch: number): Promise<Map<string, Attribution>> {
  const out = new Map<string, Attribution>();
  const jobs: { email: string[]; sms: string[] }[] = [];
  let cur = { email: [] as string[], sms: [] as string[] };
  const push = (kind: "email" | "sms", id: string) => {
    cur[kind].push(id);
    if (cur.email.length + cur.sms.length >= batch) {
      jobs.push(cur);
      cur = { email: [], sms: [] };
    }
  };
  for (const id of email) push("email", id);
  for (const id of sms) push("sms", id);
  if (cur.email.length || cur.sms.length) jobs.push(cur);
  for (const j of jobs) for (const [k, v] of parseAttribution(await get(key, `${BREVO_ATTRIBUTION}?${attributionQuery(j.email, j.sms)}`))) out.set(k, v);
  return out;
}

/** One campaign's page: the email's HTML, subject and preview text (excludeHtmlContent left off) */
export async function brevoCampaignContent(key: string, id: string) {
  return parseBrevoCampaignContent(await get(key, BREVO_EMAIL_CAMPAIGN(id)));
}
