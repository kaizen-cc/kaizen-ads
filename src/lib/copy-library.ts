import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { conversionFor, conversionLabel } from "@/lib/kpi/conversions";
import { aggregateCopy, aggregateGoogleCopy, buildCopyContext, COPY_LIMITS, filterCopy, lineForAi, rankCopy, type ClientKpi, type CopyFilter, type CopyKind, type CopyLine, type CopyPlatform, type GoogleAssetRow, type LedgerAd } from "@/lib/copy-library-core";

// The Copy library from the database: each client's Meta playbook rows (one per ad) and Google copy assets (synced with
// Google's ratings) added up into lines and judged against that client's own KPI on each platform, plus the team's stars. One client (the client page, Kaizen AI, the copywriters) or every
// client the person can see (the cross-client library on Ideas, filtered by industry and sub-vertical).

export type LibraryLine = CopyLine & { client: string; slug: string; industry: string | null; industryKey: string | null; vertical: string | null; starred: boolean; roasKpi: boolean };
export type CopyLibrary = { lines: LibraryLine[]; angles: string[]; avatars: string[]; industries: { key: string; label: string }[]; verticals: string[] };

const LEDGER_COLS = "key, client_id, detail, spend, results, revenue, impressions, clicks, first_seen, last_seen, live";

/** Each client's KPI for judging copy on a platform: its main active target (the oldest), with its campaign scope */
async function kpisOf(db: SupabaseClient, clientIds: string[], platform: CopyPlatform = "meta") {
  const { data } = await db.from("kpi_targets").select("client_id, conversion, custom_action, target, campaign_match, excluded_campaigns, created_at").in("client_id", clientIds).eq("platform", platform).eq("active", true).order("created_at", { ascending: false });
  const out = new Map<string, ClientKpi>();
  for (const t of data ?? []) {
    const conv = conversionFor(String(t.conversion));
    out.set(t.client_id as string, {
      roas: Boolean(conv.roas),
      target: t.target == null ? null : Number(t.target),
      label: conversionLabel(String(t.conversion), t.custom_action as string | null).toLowerCase() || "results",
      scope: { campaign_match: t.campaign_match as string | null, excluded_campaigns: (t.excluded_campaigns ?? []) as string[] },
    });
  }
  return out;
}

const toAd = (r: Record<string, unknown>): LedgerAd => ({
  key: r.key as string,
  clientId: r.client_id as string,
  detail: (r.detail ?? {}) as LedgerAd["detail"],
  spend: Number(r.spend) || 0,
  results: Number(r.results) || 0,
  revenue: Number(r.revenue) || 0,
  impressions: Number(r.impressions) || 0,
  clicks: Number(r.clicks) || 0,
  first_seen: (r.first_seen as string | null) ?? null,
  last_seen: (r.last_seen as string | null) ?? null,
  live: Boolean(r.live),
});

/**
 * The library for some clients (read through the given client: the person's own session keeps it to clients they can
 * see). clientIds null = every client the session can see, only ads with some spend, the last year.
 */
export async function loadCopyLibrary(db: SupabaseClient, clientIds: string[] | null): Promise<CopyLibrary> {
  let q = db.from("clients").select("id, name, slug, industry, industry_detail, verticals(name)").is("archived_at", null);
  if (clientIds) q = q.in("id", clientIds);
  const { data: clients } = await q.limit(1000);
  const ids = (clients ?? []).map((c) => c.id as string);
  if (!ids.length) return { lines: [], angles: [], avatars: [], industries: [], verticals: [] };
  const since = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
  const ads: LedgerAd[] = [];
  for (let page = 0; page < 20; page++) {
    let lq = db.from("client_ledger").select(LEDGER_COLS).eq("kind", "creative").in("client_id", ids.slice(0, 500)).gt("spend", 0).order("spend", { ascending: false }).range(page * 1000, page * 1000 + 999);
    if (!clientIds || clientIds.length > 1) lq = lq.gte("last_seen", since);
    const { data } = await lq;
    ads.push(...(data ?? []).map((r) => toAd(r as Record<string, unknown>)));
    if (!data || data.length < 1000) break;
  }
  const [kpis, gkpis, { data: gRows }, { data: fatigue }, { data: stars }] = await Promise.all([
    kpisOf(db, ids),
    kpisOf(db, ids, "google"),
    db.from("google_copy_assets").select("client_id, kind, text, label, pinned, campaign_id, campaign_name, ad_group, impressions, clicks, conversions, value, spend, synced_at").in("client_id", ids.slice(0, 500)).limit(20_000),
    db.from("ad_fatigue").select("ad_id").in("client_id", ids.slice(0, 500)).in("state", ["open", "refreshing"]).limit(2000),
    db.from("copy_library_stars").select("client_id, line_key").in("client_id", ids.slice(0, 500)).limit(5000),
  ]);
  const fatigued = new Set((fatigue ?? []).map((f) => f.ad_id as string));
  const starred = new Set((stars ?? []).map((s) => `${s.client_id}|${s.line_key}`));
  const byClient = new Map<string, LedgerAd[]>();
  for (const a of ads) byClient.set(a.clientId, [...(byClient.get(a.clientId) ?? []), a]);
  const info = new Map((clients ?? []).map((c) => [c.id as string, c]));
  const lines: LibraryLine[] = [];
  const dress = (cid: string, l: CopyLine, roas: boolean): LibraryLine | null => {
    const c = info.get(cid);
    if (!c) return null;
    return { ...l, client: c.name as string, slug: c.slug as string, industry: (c.industry_detail as string | null) ?? (c.industry as string | null) ?? null, industryKey: (c.industry as string | null) ?? null, vertical: (c.verticals as unknown as { name: string } | null)?.name ?? null, starred: starred.has(`${cid}|${l.key}`), roasKpi: roas };
  };
  for (const [cid, list] of byClient) {
    const kpi = kpis.get(cid) ?? { roas: false, target: null, label: "results", scope: null };
    for (const l of aggregateCopy(list, kpi, fatigued)) {
      const x = dress(cid, l, kpi.roas);
      if (x) lines.push(x);
    }
  }
  // Google copy, judged on the client's Google KPI (its campaigns only)
  const gBy = new Map<string, GoogleAssetRow[]>();
  for (const r of gRows ?? [])
    (gBy.get(r.client_id as string) ?? gBy.set(r.client_id as string, []).get(r.client_id as string)!).push({
      clientId: r.client_id as string,
      kind: r.kind as CopyKind,
      text: r.text as string,
      label: (r.label as string | null) ?? null,
      pinned: (r.pinned as string | null) ?? null,
      campaignId: (r.campaign_id as string | null) ?? null,
      campaignName: (r.campaign_name as string | null) ?? null,
      adGroup: (r.ad_group as string | null) ?? null,
      impressions: Number(r.impressions) || 0,
      clicks: Number(r.clicks) || 0,
      conversions: Number(r.conversions) || 0,
      value: Number(r.value) || 0,
      spend: Number(r.spend) || 0,
      syncedAt: (r.synced_at as string | null) ?? null,
    });
  for (const [cid, rows] of gBy) {
    const kpi = gkpis.get(cid) ?? { roas: false, target: null, label: "conversions", scope: null };
    for (const l of aggregateGoogleCopy(rows, kpi)) {
      const x = dress(cid, l, kpi.roas);
      if (x) lines.push(x);
    }
  }
  const ranked = rankCopy(lines) as LibraryLine[];
  // Starred lines first (stable: the ranking holds within them and the rest)
  ranked.sort((a, b) => Number(b.starred) - Number(a.starred));
  const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => Boolean(x)))].sort((a, b) => a.localeCompare(b));
  const industries = new Map<string, string>();
  for (const c of clients ?? []) if (c.industry) industries.set(c.industry as string, (c.industry as string).replace(/_/g, " "));
  return {
    lines: ranked,
    angles: uniq(ranked.map((l) => l.angle)),
    avatars: uniq(ranked.map((l) => l.avatar)),
    industries: [...industries].map(([key, label]) => ({ key, label })),
    verticals: uniq(ranked.map((l) => l.vertical)),
  };
}

/** One client's library, filtered */
export async function clientCopyLines(db: SupabaseClient, clientId: string, f: CopyFilter = {}) {
  const lib = await loadCopyLibrary(db, [clientId]);
  return filterCopy(lib.lines, f) as LibraryLine[];
}

/** One line of a client's library by its key */
export async function findCopyLine(db: SupabaseClient, clientId: string, key: string) {
  const lib = await loadCopyLibrary(db, [clientId]);
  return lib.lines.find((l) => l.key === key) ?? null;
}

/** The client's best lines for a copywriter's prompt: a few winners (or solid) of each kind */
export async function provenCopyBlock(db: SupabaseClient, clientId: string, perKind = 4) {
  const lines = await clientCopyLines(db, clientId).catch(() => [] as LibraryLine[]);
  const pick = (k: CopyKind, p: CopyPlatform = "meta") => lines.filter((l) => l.platform === p && l.kind === k && (l.badge === "winner" || l.badge === "solid")).slice(0, perKind);
  // Meta and Google share what works: the search headlines that convert carry the same promise into Meta copy
  const best = [...pick("primary"), ...pick("headline"), ...pick("description"), ...pick("headline", "google").slice(0, 3), ...pick("description", "google").slice(0, 2)];
  if (!best.length) return "";
  return `<proven_copy_for_this_client source="the Copy library: lines that ran in this client's Meta ads, judged on the KPI">\nModel the hooks, structure and claims on these (they made money); write new words, don't copy them.\n${best.map((l) => lineForAi(l, l.roasKpi)).join("\n")}\n</proven_copy_for_this_client>`;
}

// ─── The copy context for Kaizen AI and every copy writer it calls ────────────────────────────────────────────────

const ctxCache = new Map<string, { at: number; text: string }>();

/**
 * Everything about a client's copy, within a budget (cached a few minutes): Meta's limits, the client's rules and what
 * to avoid, the proven and tired lines from the library, the Brand Bible's voice, the copy checks the team settled and
 * what the client approved or sent back. admin: the server's rights, after the person's access to the client is checked.
 */
export async function copyContext(admin: SupabaseClient, clientId: string, budget = 14_000, platform: CopyPlatform = "meta") {
  const cacheKey = `${clientId}|${platform}`;
  const hit = ctxCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.text;
  const [{ data: client }, lines, { data: bible }, { data: rules }, { data: memory }, { data: overrides }, { data: sets }] = await Promise.all([
    admin.from("clients").select("name").eq("id", clientId).maybeSingle(),
    clientCopyLines(admin, clientId).catch(() => [] as LibraryLine[]),
    admin.from("client_brand_bibles").select("markdown").eq("client_id", clientId).maybeSingle(),
    admin.from("client_bible_rules").select("rule, polarity, status, count").eq("client_id", clientId).eq("status", "rule").order("count", { ascending: false }).limit(30),
    admin.from("client_memory").select("kind, body, created_at").eq("client_id", clientId).eq("status", "active").in("kind", ["avoid", "prefer"]).order("created_at", { ascending: false }).limit(60),
    admin.from("copy_rule_overrides").select("kind, rule, reason, created_at").eq("client_id", clientId).order("created_at", { ascending: false }).limit(15),
    admin.from("copy_sets").select("client_status, updated_at").eq("client_id", clientId).not("client_status", "is", null).order("updated_at", { ascending: false }).limit(12),
  ]);
  let voice: string | null = null;
  if (bible?.markdown) {
    const { splitBible } = await import("@/lib/bible-sections");
    const s = splitBible(bible.markdown as string).find((x) => /voice|messaging/i.test(x.title));
    voice = s ? s.body.slice(0, 3500) : null;
  }
  const reviews: { status: string; note: string }[] = [];
  for (const s of sets ?? [])
    for (const c of (Array.isArray(s.client_status) ? s.client_status : []) as { status?: string; note?: string; comment?: string }[]) {
      const note = (c?.note ?? c?.comment ?? "").trim();
      if (c?.status && note) reviews.push({ status: c.status, note: note.slice(0, 300) });
    }
  const text = buildCopyContext(
    {
      client: (client?.name as string | undefined) ?? "the client",
      roas: lines.find((l) => l.platform === platform)?.roasKpi ?? false,
      platform,
      // This platform's proven lines lead, a few from the other platform follow, then what's tired
      lines: [
        ...lines.filter((l) => l.platform === platform && (l.badge === "winner" || l.badge === "solid")).slice(0, 14),
        ...lines.filter((l) => l.platform !== platform && (l.badge === "winner" || l.badge === "solid")).slice(0, 5),
        ...lines.filter((l) => l.platform === platform && l.badge === "tired").slice(0, 6),
      ],
      voice,
      rules: (rules ?? []).map((r) => ({ rule: r.rule as string, polarity: r.polarity as "do" | "dont" })),
      avoid: (memory ?? []).filter((m) => m.kind === "avoid").map((m) => (m.body as string).slice(0, 300)),
      prefer: (memory ?? []).filter((m) => m.kind === "prefer").slice(0, 10).map((m) => (m.body as string).slice(0, 300)),
      overrides: (overrides ?? []).map((o) => ({ kind: o.kind as string, rule: o.rule as string, reason: (o.reason as string | null) ?? null })),
      reviews: reviews.slice(0, 12),
    },
    budget,
  );
  ctxCache.set(cacheKey, { at: Date.now(), text });
  return text;
}

export { COPY_LIMITS };
