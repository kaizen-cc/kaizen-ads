import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// The pages the Brand Bible sends people to, kept live: every page on the client's own site that the Bible links
// (where ads send people, product and offer pages), plus every landing page a creative request points at. Each is
// checked every 90 days, and again right before new creative is briefed; a page that's gone, or that changed in a way
// that matters for ads (a new offer, a price, shipping, sold out), is flagged to the buyers and the head of creative.

const RECHECK_DAYS = 90;
/** Before a brief: pages read in the last day are trusted as they are */
const FRESH_HOURS = 24;

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
};
const clean = (u: string) => u.replace(/[)\].,;]+$/, "").replace(/#.*$/, "");

/** The client's own pages the Bible links to (their site's domain, and any landing page domain already tracked) */
export function bibleLinks(markdown: string, website: string | null) {
  const home = website ? hostOf(/^https?:/i.test(website) ? website : `https://${website}`) : null;
  const out = new Map<string, string>();
  for (const m of markdown.matchAll(/\[([^\]]{1,120})\]\((https?:\/\/[^\s)]+)\)/g)) {
    const url = clean(m[2]);
    const host = hostOf(url);
    if (host && home && (host === home || host.endsWith(`.${home}`))) out.set(url, m[1]);
  }
  for (const m of markdown.matchAll(/(?<!\()https?:\/\/[^\s)|>\]]+/g)) {
    const url = clean(m[0]);
    const host = hostOf(url);
    if (host && home && (host === home || host.endsWith(`.${home}`)) && !out.has(url)) out.set(url, "");
  }
  return [...out].map(([url, label]) => ({ url, label: label || null }));
}

async function digest(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Buffer.from(buf).toString("hex").slice(0, 32);
}

/** One page, read: whether it's live, its title and the visible text that matters (prices, offers, stock) */
async function readPage(url: string) {
  const { pageText, isPublicHost } = await import("@/lib/references");
  if (!isPublicHost(url)) return { status: 0, ok: false, title: null, text: "" };
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(12_000), headers: { "User-Agent": "Mozilla/5.0 (compatible; KaizenAds/1.0; link check)" } });
    if (!res.ok) return { status: res.status, ok: false, title: null, text: "" };
    const html = (await res.text()).slice(0, 600_000);
    const page = pageText(html);
    return { status: res.status, ok: true, title: (page.ogTitle || page.title || "").slice(0, 200) || null, text: `${page.description}\n${page.body}`.replace(/\s+/g, " ").trim().slice(0, 6000) };
  } catch {
    return { status: 0, ok: false, title: null, text: "" };
  }
}

/** The Bible's pages, in the table (new ones added, so the checks know them) */
export async function syncLinks(admin: SupabaseClient, clientId: string) {
  const [{ data: b }, { data: c }] = await Promise.all([
    admin.from("client_brand_bibles").select("markdown").eq("client_id", clientId).maybeSingle(),
    admin.from("clients").select("website").eq("id", clientId).maybeSingle(),
  ]);
  if (!b?.markdown) return 0;
  const links = bibleLinks(b.markdown as string, (c?.website as string | null) ?? null).slice(0, 40);
  if (links.length) await admin.from("bible_links").upsert(links.map((l) => ({ client_id: clientId, url: l.url, label: l.label, source: "bible" })), { onConflict: "client_id,url", ignoreDuplicates: true });
  return links.length;
}

type Change = { matters: boolean; note: string };

/** What changed on a page that matters for ads, in a line (or nothing that matters) */
async function whatChanged(clientName: string, url: string, before: string, after: string): Promise<Change> {
  const { askJson } = await import("@/lib/ai");
  return askJson<Change>({
    agent: "brandbible",
    label: `bible link check ${clientName}`,
    override: { model: "haiku", effort: "low" },
    bare: true,
    system: `You compare two reads of the same page on a client's website. Say whether anything changed that matters for their ads: an offer or promotion, a price, shipping terms, a product added, removed or sold out, a claim, the page's main promise. Layout, dates, counters, reviews rotating and menus don't matter. note: one plain line naming the change (e.g. "New: 20% off your first box with code FRESH20"), or "" when nothing matters.`,
    prompt: `<page url="${url}">\n<before>\n${before.slice(0, 3000)}\n</before>\n<now>\n${after.slice(0, 3000)}\n</now>\n</page>`,
    schema: { type: "object", properties: { matters: { type: "boolean" }, note: { type: "string" } }, required: ["matters", "note"], additionalProperties: false },
    maxTokens: 600,
  });
}

/** The buyers on the client and the head of creative, told when a page they send people to is gone or changed */
async function tell(admin: SupabaseClient, clientId: string, lines: string[], key: string) {
  const [{ data: c }, { data: buyers }, { data: heads }] = await Promise.all([
    admin.from("clients").select("name, slug").eq("id", clientId).single(),
    admin.from("client_assignments").select("profile_id").eq("client_id", clientId).in("role", ["meta_buyer", "google_buyer", "tiktok_buyer"]),
    admin.from("profiles").select("id").eq("is_active", true).eq("role", "head_of_creative"),
  ]);
  if (!c) return;
  const ids = [...new Set([...(buyers ?? []).map((b) => b.profile_id as string), ...(heads ?? []).map((h) => h.id as string)])];
  if (!ids.length) return;
  await admin.from("notifications").upsert(
    ids.map((id) => ({
      profile_id: id,
      kind: "client",
      title: `${c.name}: their website changed`.slice(0, 200),
      body: lines.join(" · ").slice(0, 1000),
      href: `/clients/${c.slug}/brand-bible`,
      client_id: clientId,
      key,
      priority: lines.some((l) => /gone|broken|not found/i.test(l)) ? "critical" : "normal",
    })),
    { onConflict: "profile_id,key", ignoreDuplicates: true },
  );
}

/**
 * Reads the client's pages: those due (never read, or older than 90 days), or with `before` set, every page not read
 * in the last day (right before a brief). Flags pages that went dead or changed in a way that matters.
 */
export async function checkLinks(admin: SupabaseClient, clientId: string, o: { before?: boolean; max?: number } = {}) {
  await syncLinks(admin, clientId);
  const { data: c } = await admin.from("clients").select("name").eq("id", clientId).single();
  const cutoff = new Date(Date.now() - (o.before ? FRESH_HOURS * 3_600_000 : RECHECK_DAYS * 86_400_000)).toISOString();
  const { data: due } = await admin.from("bible_links").select("*").eq("client_id", clientId).or(`checked_at.is.null,checked_at.lt.${cutoff}`).order("checked_at", { ascending: true, nullsFirst: true }).limit(o.max ?? 15);
  const flagged: string[] = [];
  const now = new Date().toISOString();
  for (const l of due ?? []) {
    const page = await readPage(l.url as string);
    const hash = page.text ? await digest(page.text) : null;
    let change: Change = { matters: false, note: "" };
    if (!page.ok && l.ok !== false) change = { matters: true, note: `Gone or broken (${page.status || "no answer"}): ${l.label ?? l.url}` };
    else if (page.ok && hash && l.digest && hash !== l.digest && l.summary && c) change = await whatChanged(c.name as string, l.url as string, l.summary as string, page.text).catch(() => ({ matters: false, note: "" }));
    if (change.matters && change.note) flagged.push(`${change.note} (${l.url})`);
    await admin
      .from("bible_links")
      .update({
        status: page.status,
        ok: page.ok,
        title: page.title ?? l.title,
        ...(page.ok ? { digest: hash, summary: page.text } : {}),
        checked_at: now,
        ...(change.matters ? { changed_at: now, change_note: change.note } : {}),
      })
      .eq("id", l.id);
  }
  if (flagged.length) await tell(admin, clientId, flagged, `bible-links:${clientId}:${now.slice(0, 10)}`);
  return { checked: (due ?? []).length, flagged };
}

/**
 * A creative request's landing page: tracked with the Bible's pages and written into the Bible where it lists the
 * pages ads send people to (or its change log), then the client's pages are refreshed before the creative is made.
 */
export async function landingFromRequest(admin: SupabaseClient, clientId: string, url: string, title: string | null) {
  const clean = url.trim().slice(0, 500);
  if (!/^https?:\/\/\S+\.\S+/i.test(clean)) return;
  const { data: had } = await admin.from("bible_links").select("id").eq("client_id", clientId).eq("url", clean).maybeSingle();
  if (!had) {
    await admin.from("bible_links").upsert({ client_id: clientId, url: clean, label: title, source: "request" }, { onConflict: "client_id,url", ignoreDuplicates: true });
    const { data: b } = await admin.from("client_brand_bibles").select("markdown").eq("client_id", clientId).maybeSingle();
    if (b?.markdown && !(b.markdown as string).includes(clean)) {
      const { splitBible, applyEdits, logChange } = await import("@/lib/bible-sections");
      const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }).format(new Date());
      let markdown = b.markdown as string;
      const sec = splitBible(markdown).find((s) => /where (ads|people)|send people|landing|pages|links/i.test(s.title));
      const line = `- [${title?.trim() || "Landing page"}](${clean}): a landing page from a creative request [Kaizen request, ${day}]`;
      if (sec) markdown = applyEdits(markdown, [{ section: sec.heading, markdown: `${sec.body.trimEnd()}\n${line}` }]).markdown;
      markdown = logChange(markdown, `${day}: New landing page from a creative request: ${clean}`);
      await admin.from("client_brand_bibles").update({ markdown }).eq("client_id", clientId);
    }
  }
  await checkLinks(admin, clientId, { before: true, max: 8 });
}

/** Hourly: a few clients whose pages are due for their 90-day check */
export async function keepLinks(admin: SupabaseClient, max = 3) {
  const { data: bibles } = await admin.from("client_brand_bibles").select("client_id, clients!inner(archived_at)").not("markdown", "is", null).is("clients.archived_at", null);
  const ids = (bibles ?? []).map((b) => b.client_id as string);
  if (!ids.length) return {};
  const cutoff = new Date(Date.now() - RECHECK_DAYS * 86_400_000).toISOString();
  const { data: recent } = await admin.from("bible_links").select("client_id, checked_at").in("client_id", ids).gte("checked_at", cutoff);
  const seen = new Set((recent ?? []).map((r) => r.client_id as string));
  const out: Record<string, unknown> = {};
  for (const id of ids.filter((x) => !seen.has(x)).slice(0, max)) out[id] = await checkLinks(admin, id).catch((e) => (e instanceof Error ? e.message : "failed"));
  return out;
}
