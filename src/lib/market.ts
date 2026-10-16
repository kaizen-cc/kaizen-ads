import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { INDUSTRIES } from "@/lib/industries";
import { argsFor, MotionNotConnected, openSession, type MotionTool } from "@/lib/motion";

// The market: live ads from brands in every industry we serve, pulled from Motion's Inspo (public ad libraries, Meta).
// Brands come from three places: the competitors tracked in Kaizen's Motion workspace, the competitors each client
// named in their intake form, and the brands the AI picks out as strong Meta advertisers in each of our niches. Motion
// has no performance numbers for other brands' ads, so "proven" means still running after 30 days (brands rarely
// keep paying for a loser), and "being tested" means a brand launching several new ads at once.

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => Boolean(x) && typeof x === "object" && !Array.isArray(x);

/** The list inside a tool's answer, wherever Motion put it. */
function itemsOf(x: unknown): Obj[] {
  if (Array.isArray(x)) return x.filter(isObj);
  if (!isObj(x)) return [];
  for (const v of Object.values(x)) if (Array.isArray(v) && v.some(isObj)) return v.filter(isObj);
  for (const v of Object.values(x)) if (isObj(v)) for (const w of Object.values(v)) if (Array.isArray(w) && w.some(isObj)) return w.filter(isObj);
  return [];
}

/** The first field present, by any of its likely names (case and separators ignored), one level deep too. */
function pick(o: Obj, ...keys: string[]): unknown {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const want = keys.map(norm);
  for (const [k, v] of Object.entries(o)) if (want.includes(norm(k)) && v !== null && v !== undefined && v !== "") return v;
  for (const v of Object.values(o)) if (isObj(v)) for (const [k, w] of Object.entries(v)) if (want.includes(norm(k)) && w !== null && w !== undefined && w !== "") return w;
  return undefined;
}
const str = (v: unknown) => (typeof v === "string" ? v.trim() || null : typeof v === "number" ? String(v) : null);
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : null);
const urls = (v: unknown): string[] => (typeof v === "string" && /^https?:\/\//.test(v) ? [v] : Array.isArray(v) ? v.flatMap(urls) : isObj(v) ? Object.values(v).flatMap(urls) : []);

function mediaOf(ad: Obj) {
  const files = pick(ad, "files", "media", "assets", "fileUrls", "creatives", "cards");
  const out: { type: "image" | "video"; url: string; thumb: string | null }[] = [];
  const add = (url: string, thumb: string | null = null) => {
    if (out.some((m) => m.url === url)) return;
    out.push({ type: /\.(mp4|mov|webm|m3u8)(\?|$)/i.test(url) || /video/i.test(url) ? "video" : "image", url, thumb });
  };
  for (const f of itemsOf(files)) {
    const url = str(pick(f, "url", "fileUrl", "src", "videoUrl", "imageUrl", "source"));
    if (url) add(url, str(pick(f, "thumbnail", "thumbnailUrl", "poster", "previewUrl")));
  }
  if (!out.length) for (const u of urls(files)) add(u);
  for (const k of ["videoUrl", "video", "imageUrl", "image"]) {
    const u = str(pick(ad, k));
    if (u && /^https?:\/\//.test(u)) add(u, str(pick(ad, "thumbnail", "thumbnailUrl", "poster")));
  }
  return out.slice(0, 10);
}

function adRow(ad: Obj, brandId: string, industry: string | null) {
  const id = str(pick(ad, "id", "creativeId", "adId", "libraryId", "adArchiveId"));
  if (!id) return null;
  const launched = str(pick(ad, "launchDate", "launchedAt", "startDate", "firstSeen", "startedAt", "createdAt"));
  const launchedAt = launched && !Number.isNaN(Date.parse(launched)) ? new Date(launched).toISOString() : null;
  const status = pick(ad, "status", "isActive", "active");
  const active = typeof status === "boolean" ? status : typeof status === "string" ? /active|running|live/i.test(status) && !/inactive/i.test(status) : null;
  const days = num(pick(ad, "daysActive", "activeDays", "daysRunning", "runningDays")) ?? (launchedAt ? Math.max(0, Math.round((Date.now() - Date.parse(launchedAt)) / 86_400_000)) : null);
  const motionUrl = urls(ad).find((u) => /motionapp\.com/i.test(u)) ?? null;
  const media = mediaOf(ad);
  const format = str(pick(ad, "format", "type", "mediaType", "creativeType"))?.toLowerCase() ?? null;
  return {
    motion_id: id,
    brand_id: brandId,
    industry,
    format: format?.includes("carousel") ? "carousel" : format?.includes("video") || media.some((m) => m.type === "video") ? "video" : format?.includes("image") || media.length ? "image" : format,
    headline: str(pick(ad, "headline", "title")),
    body: str(pick(ad, "copy", "body", "primaryText", "text", "adCopy")),
    cta: str(pick(ad, "cta", "callToAction", "ctaText")),
    landing_url: str(pick(ad, "landingPage", "landingPageUrl", "landingUrl", "link", "destinationUrl")),
    launched_at: launchedAt,
    active,
    days_active: days,
    media,
    motion_url: motionUrl,
    raw: ad,
    last_seen_at: new Date().toISOString(),
  };
}

type Session = Awaited<ReturnType<typeof openSession>>;

/** A brand in Motion, by domain first (exact), else by name. */
async function resolveBrand(s: Session, tools: MotionTool[], q: { name?: string | null; domain?: string | null }) {
  const byDomain = tools.find((t) => t.name === "get_brand_by_domain");
  const search = tools.find((t) => t.name === "search_brands");
  if (q.domain && byDomain) {
    const r = await s.call(byDomain.name, argsFor(byDomain, { "domain|url": q.domain })).catch(() => null);
    const b = isObj(r) && pick(r, "id", "brandId") ? r : itemsOf(r)[0];
    if (b && pick(b, "id", "brandId")) return b;
  }
  if (q.name && search) {
    const r = await s.call(search.name, argsFor(search, { "query|name|search|term": q.name, "limit": 3 })).catch(() => null);
    const list = itemsOf(r);
    const exact = list.find((b) => str(pick(b, "name"))?.toLowerCase() === q.name!.toLowerCase());
    return exact ?? list[0] ?? null;
  }
  return null;
}

async function upsertBrand(admin: SupabaseClient, b: Obj, meta: { source: string; industry?: string | null; detail?: string | null; clientId?: string | null }) {
  const motionId = str(pick(b, "id", "brandId"));
  const name = str(pick(b, "name", "brandName"));
  if (!motionId || !name) return null;
  const { data: prev } = await admin.from("market_brands").select("id, sources, client_ids, industry").eq("motion_brand_id", motionId).maybeSingle();
  const row = {
    motion_brand_id: motionId,
    name,
    domain: str(pick(b, "domain", "website", "url")),
    logo: str(pick(b, "logo", "logoUrl", "image")),
    active_ads: num(pick(b, "activeAds", "activeAdCount", "adsCount")),
    sources: [...new Set([...((prev?.sources as string[]) ?? []), meta.source])],
    client_ids: [...new Set([...((prev?.client_ids as string[]) ?? []), ...(meta.clientId ? [meta.clientId] : [])])],
    // The industry from a client who named them wins; else what the AI sorts them into
    industry: meta.industry ?? prev?.industry ?? null,
    ...(meta.detail ? { industry_detail: meta.detail } : {}),
  };
  const { data } = await admin.from("market_brands").upsert(row, { onConflict: "motion_brand_id" }).select("id").single();
  return data?.id as string | undefined;
}

/** Which brands to watch: Motion's tracked competitors, clients' named competitors, and the AI's picks per niche. */
async function discoverBrands(admin: SupabaseClient, s: Session, tools: MotionTool[], deadline: number) {
  let found = 0;
  // 1. Competitors tracked in Kaizen's Motion workspace
  const comp = tools.find((t) => t.name === "get_workspace_competitors");
  if (comp) {
    for (const c of itemsOf(await s.call(comp.name, {}).catch(() => null))) {
      if (Date.now() > deadline) return found;
      const b = pick(c, "id", "brandId") ? c : await resolveBrand(s, tools, { name: str(pick(c, "name")), domain: str(pick(c, "domain")) });
      if (b && (await upsertBrand(admin, b, { source: "motion", detail: str(pick(c, "category", "categories")) }))) found++;
    }
  }
  // 2. Competitors each client named in their intake form (filed under that client's industry)
  const { data: clients } = await admin.from("clients").select("id, industry, industry_detail").is("archived_at", null).neq("status", "offboarded");
  const { data: intakes } = await admin.from("client_intakes").select("client_id, summary").not("summary", "is", null).not("client_id", "is", null).order("received_at", { ascending: false });
  const seen = new Set<string>();
  for (const i of intakes ?? []) {
    if (seen.has(i.client_id)) continue;
    seen.add(i.client_id);
    const c = (clients ?? []).find((x) => x.id === i.client_id);
    if (!c) continue;
    for (const name of ((i.summary as { competitors?: string[] }).competitors ?? []).slice(0, 5)) {
      if (Date.now() > deadline) return found;
      const domain = name.match(/([a-z0-9-]+\.)+[a-z]{2,}/i)?.[0] ?? null;
      const b = await resolveBrand(s, tools, { name: name.replace(/\(.*?\)|https?:\/\/\S+/g, "").trim(), domain });
      if (b && (await upsertBrand(admin, b, { source: "intake", industry: c.industry, detail: c.industry_detail, clientId: c.id }))) found++;
    }
  }
  // 3. Strong Meta advertisers in the niches we serve (the AI's picks, checked against Motion)
  const niches = new Map<string, Set<string>>();
  for (const c of clients ?? []) if (c.industry && c.industry !== "other") niches.set(c.industry, (niches.get(c.industry) ?? new Set()).add(c.industry_detail ?? ""));
  if (niches.size) {
    const out = await askJson<{ industries: { industry: string; brands: { name: string; domain: string }[] }[] }>({
      agent: "market",
      label: "brands to watch",
      system: "You pick brands worth watching on Meta for a paid social agency's creative team: brands well known for running a lot of strong Facebook and Instagram ads in each niche, so the team can see what's working in the market. Real brands only, with their real website domain.",
      schema: {
        type: "object",
        properties: {
          industries: {
            type: "array",
            items: {
              type: "object",
              properties: { industry: { type: "string" }, brands: { type: "array", items: { type: "object", properties: { name: { type: "string" }, domain: { type: "string" } }, required: ["name", "domain"], additionalProperties: false } } },
              required: ["industry", "brands"],
              additionalProperties: false,
            },
          },
        },
        required: ["industries"],
        additionalProperties: false,
      },
      prompt: `The niches we serve, by industry key (with the kinds of clients in each):\n${[...niches].map(([k, d]) => `${k}: ${[...d].filter(Boolean).slice(0, 12).join("; ") || "(no detail)"}`).join("\n")}\n\nFor each industry key, up to 6 brands (US, or big on Meta in the US) whose Meta ads our clients in those niches can learn from. Mix national leaders with standout regional or challenger brands.`,
    }).catch(() => ({ industries: [] }));
    for (const ind of out.industries) {
      if (!niches.has(ind.industry)) continue;
      for (const br of ind.brands.slice(0, 6)) {
        if (Date.now() > deadline) return found;
        const b = await resolveBrand(s, tools, { name: br.name, domain: br.domain });
        if (b && (await upsertBrand(admin, b, { source: "search", industry: ind.industry }))) found++;
      }
    }
  }
  return found;
}

/** Brands without an industry (Motion's tracked competitors) get one. */
async function sortBrands(admin: SupabaseClient) {
  const { data: brands } = await admin.from("market_brands").select("id, name, domain, industry_detail").is("industry", null).limit(60);
  if (!brands?.length) return 0;
  const out = await askJson<{ brands: { n: number; industry: string; detail: string }[] }>({
    agent: "market",
    label: "sort market brands",
    system: "You sort brands into industries for a paid social agency.",
    schema: {
      type: "object",
      properties: {
        brands: {
          type: "array",
          items: { type: "object", properties: { n: { type: "integer" }, industry: { type: "string", enum: INDUSTRIES.map(([k]) => k) }, detail: { type: "string" } }, required: ["n", "industry", "detail"], additionalProperties: false },
        },
      },
      required: ["brands"],
      additionalProperties: false,
    },
    prompt: `${brands.map((b, i) => `${i + 1}. ${b.name}${b.domain ? ` (${b.domain})` : ""}${b.industry_detail ? ` · ${b.industry_detail}` : ""}`).join("\n")}\n\nindustry: the closest key; detail: what they are, in a few words.`,
  });
  for (const r of out.brands) {
    const b = brands[r.n - 1];
    if (b) await admin.from("market_brands").update({ industry: r.industry, industry_detail: b.industry_detail ?? r.detail.slice(0, 80) }).eq("id", b.id);
  }
  return out.brands.length;
}

/** What each new ad is doing: its angle, its hook and why it likely works, from the copy and the format. */
async function readAds(admin: SupabaseClient, deadline: number) {
  let read = 0;
  while (Date.now() < deadline) {
    const { data: ads } = await admin.from("market_ads").select("id, format, headline, body, cta, days_active, market_brands(name, industry_detail)").is("read_at", null).limit(25);
    if (!ads?.length) break;
    const out = await askJson<{ ads: { n: number; angle: string; hook: string; why: string; tags: string[] }[] }>({
      agent: "market",
      label: "read market ads",
      system: "You read live Meta ads from brands in the market for a paid social agency's creative team. From the copy and format only, say what each ad is doing. Short and concrete; no hype.",
      schema: {
        type: "object",
        properties: {
          ads: {
            type: "array",
            items: { type: "object", properties: { n: { type: "integer" }, angle: { type: "string" }, hook: { type: "string" }, why: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["n", "angle", "hook", "why", "tags"], additionalProperties: false },
          },
        },
        required: ["ads"],
        additionalProperties: false,
      },
      prompt: `${ads
        .map((a, i) => {
          const b = a.market_brands as unknown as { name: string; industry_detail: string | null } | null;
          return `${i + 1}. ${b?.name ?? "?"}${b?.industry_detail ? ` (${b.industry_detail})` : ""} · ${a.format ?? "?"}${a.days_active != null ? ` · running ${a.days_active} days` : ""}\nHeadline: ${a.headline ?? "-"}\nCopy: ${(a.body ?? "-").slice(0, 700)}\nCTA: ${a.cta ?? "-"}`;
        })
        .join("\n\n")}\n\nFor each: angle (the selling idea, a few words, e.g. "price anchoring against delivery apps"), hook (the opening line or idea that stops the scroll), why (one sentence on why it likely works), tags (2 to 4 from: offer, social proof, ugc, founder, before-after, comparison, urgency, seasonal, education, lifestyle, product demo, testimonial, humor, problem-solution).`,
    });
    const now = new Date().toISOString();
    for (const r of out.ads) {
      const a = ads[r.n - 1];
      if (a) await admin.from("market_ads").update({ angle: r.angle.slice(0, 120), hook: r.hook.slice(0, 300), why: r.why.slice(0, 400), tags: r.tags.slice(0, 4), read_at: now }).eq("id", a.id);
    }
    // Anything the model skipped is marked read so it doesn't loop
    await admin.from("market_ads").update({ read_at: now }).in("id", ads.map((a) => a.id)).is("read_at", null);
    read += ads.length;
  }
  return read;
}

/**
 * The daily market sync: find brands (weekly), pull each brand's live ads from Motion (stalest first), and read the
 * new ones. Stops at the time budget; the rest go first next run.
 */
export async function syncMarket(admin: SupabaseClient, budgetMs = 600_000) {
  const started = Date.now();
  const deadline = started + budgetMs;
  const { data: conn } = await admin.from("motion_connection").select("tools, last_result").eq("id", 1).maybeSingle();
  try {
    const s = await openSession(admin);
    const tools = ((conn?.tools as MotionTool[]) ?? []).length ? (conn!.tools as MotionTool[]) : await s.list();
    const last = (conn?.last_result ?? {}) as { discoveredAt?: string };
    const discover = !last.discoveredAt || Date.now() - Date.parse(last.discoveredAt) > 7 * 86_400_000;
    const brandsFound = discover ? await discoverBrands(admin, s, tools, started + budgetMs * 0.35) : 0;
    const sorted = await sortBrands(admin).catch(() => 0);

    const inspo = tools.find((t) => t.name === "get_inspo_creatives");
    let pulled = 0;
    let brands = 0;
    const errors: string[] = [];
    if (inspo) {
      const { data: list } = await admin.from("market_brands").select("id, motion_brand_id, industry").order("last_synced_at", { ascending: true, nullsFirst: true }).limit(200);
      for (const b of list ?? []) {
        if (Date.now() > started + budgetMs * 0.75) break;
        try {
          const r = await s.call(inspo.name, argsFor(inspo, { "brandId|brand_id|brand": b.motion_brand_id, "status": "active", "sort": "newest", "limit|pageSize|count": 40 }));
          const rows = itemsOf(r)
            .map((ad) => adRow(ad, b.id, b.industry))
            .filter((x): x is NonNullable<typeof x> => Boolean(x));
          if (rows.length) await admin.from("market_ads").upsert(rows, { onConflict: "motion_id" });
          // Not in the brand's live ads any more: no longer running
          const live = rows.map((x) => x.motion_id);
          await admin.from("market_ads").update({ active: false }).eq("brand_id", b.id).not("motion_id", "in", `(${live.map((x) => `"${x}"`).join(",") || '""'})`);
          await admin.from("market_brands").update({ last_synced_at: new Date().toISOString() }).eq("id", b.id);
          pulled += rows.length;
          brands++;
        } catch (e) {
          errors.push(e instanceof Error ? e.message.slice(0, 160) : String(e));
          if (e instanceof MotionNotConnected) throw e;
        }
      }
    }
    const read = await readAds(admin, deadline).catch((e) => {
      errors.push(`reading: ${e instanceof Error ? e.message : e}`);
      return 0;
    });
    const result = { brandsFound, sorted, brands, pulled, read, errors: errors.slice(0, 8), discoveredAt: discover ? new Date().toISOString() : last.discoveredAt };
    await admin.from("motion_connection").update({ last_sync_at: new Date().toISOString(), last_result: result, error: null }).eq("id", 1);
    return result;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await admin.from("motion_connection").update({ error, last_sync_at: new Date().toISOString() }).eq("id", 1);
    return { error };
  }
}

// ─── Reading the market (pages and the strategist) ──────────────────────────

export type MarketAd = {
  id: string;
  brand: string;
  brandLogo: string | null;
  brandDomain: string | null;
  industry: string | null;
  detail: string | null;
  format: string | null;
  headline: string | null;
  body: string | null;
  cta: string | null;
  landingUrl: string | null;
  launchedAt: string | null;
  active: boolean | null;
  daysActive: number | null;
  media: { type: "image" | "video"; url: string; thumb: string | null }[];
  motionUrl: string | null;
  angle: string | null;
  hook: string | null;
  why: string | null;
  tags: string[];
  competitorOf: string[]; // client ids who named this brand
  proven: boolean; // still running after 30 days
  fresh: boolean; // launched in the last 7 days
  testing: boolean; // the brand launched 3+ ads in the last 14 days
};

const COLS = "id, format, headline, body, cta, landing_url, launched_at, active, days_active, media, motion_url, angle, hook, why, tags, industry, market_brands!inner(name, logo, domain, industry, industry_detail, client_ids)";

function toAd(r: Obj, testingBrands: Set<string>): MarketAd {
  const b = r.market_brands as { name: string; logo: string | null; domain: string | null; industry: string | null; industry_detail: string | null; client_ids: string[] };
  const launched = r.launched_at as string | null;
  const days = r.days_active as number | null;
  return {
    id: r.id as string,
    brand: b.name,
    brandLogo: b.logo,
    brandDomain: b.domain,
    industry: (r.industry as string | null) ?? b.industry,
    detail: b.industry_detail,
    format: r.format as string | null,
    headline: r.headline as string | null,
    body: r.body as string | null,
    cta: r.cta as string | null,
    landingUrl: r.landing_url as string | null,
    launchedAt: launched,
    active: r.active as boolean | null,
    daysActive: days,
    media: (r.media ?? []) as MarketAd["media"],
    motionUrl: r.motion_url as string | null,
    angle: r.angle as string | null,
    hook: r.hook as string | null,
    why: r.why as string | null,
    tags: (r.tags ?? []) as string[],
    competitorOf: b.client_ids ?? [],
    proven: r.active !== false && (days ?? 0) >= 30,
    fresh: Boolean(launched && Date.now() - Date.parse(launched) < 7 * 86_400_000),
    testing: testingBrands.has(b.name),
  };
}

/** Live market ads, newest-proven first. industry / clientId narrow it (a client's named competitors come first). */
export async function loadMarket(db: SupabaseClient, opts: { industry?: string | null; clientId?: string; limit?: number } = {}) {
  let q = db.from("market_ads").select(COLS).neq("active", false).order("days_active", { ascending: false, nullsFirst: false }).limit(opts.limit ?? 600);
  if (opts.industry) q = q.eq("industry", opts.industry);
  const { data } = await q;
  const rows = (data ?? []) as Obj[];
  // Brands launching 3+ ads in two weeks are testing
  const recent = new Map<string, number>();
  for (const r of rows) {
    const l = r.launched_at as string | null;
    if (l && Date.now() - Date.parse(l) < 14 * 86_400_000) {
      const n = (r.market_brands as { name: string }).name;
      recent.set(n, (recent.get(n) ?? 0) + 1);
    }
  }
  const testing = new Set([...recent].filter(([, n]) => n >= 3).map(([k]) => k));
  const ads = rows.map((r) => toAd(r, testing));
  if (opts.clientId) ads.sort((a, b) => Number(b.competitorOf.includes(opts.clientId!)) - Number(a.competitorOf.includes(opts.clientId!)));
  return ads;
}

export async function loadMarketAd(db: SupabaseClient, id: string) {
  const { data } = await db.from("market_ads").select(COLS).eq("id", id).maybeSingle();
  return data ? toAd(data as Obj, new Set()) : null;
}

/** For the strategist: what's live in this client's market right now (their named competitors first), with links. */
export async function marketBlock(db: SupabaseClient, clientId: string, industry: string | null, max = 6) {
  if (!industry || industry === "other") return "";
  const ads = (await loadMarket(db, { industry, clientId, limit: 120 })).filter((a) => a.angle || a.headline || a.body);
  const picked = [...ads.filter((a) => a.competitorOf.includes(clientId)).slice(0, 3), ...ads.filter((a) => !a.competitorOf.includes(clientId) && (a.proven || a.testing))].slice(0, max);
  if (!picked.length) return "";
  return `<in_the_market>
Live Meta ads from brands in this client's market (from Motion). No performance numbers: "running N days" is the signal (brands rarely keep paying for an ad that loses). Use them as ideas, never copies, and never name another brand in the brief. When the request draws on one, put its link in draft.refs so the creative team can see it.
${picked
  .map(
    (a, i) =>
      `M${i + 1}. ${a.brand}${a.competitorOf.includes(clientId) ? " (a competitor this client named)" : ""} · ${a.format ?? "ad"}${a.daysActive != null ? ` · running ${a.daysActive} days` : ""}${a.testing ? " · brand is testing a lot right now" : ""}
   ${a.angle ? `Angle: ${a.angle}. ` : ""}${a.hook ? `Hook: ${a.hook}. ` : ""}${a.why ? `Why it works: ${a.why}` : ""}
   ${a.headline ? `Headline: ${a.headline}. ` : ""}${a.body ? `Copy: ${a.body.slice(0, 240)}` : ""}
   Link: ${a.motionUrl ?? a.media[0]?.url ?? a.landingUrl ?? "(none)"}`,
  )
  .join("\n")}
</in_the_market>`;
}
