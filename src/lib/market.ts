import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { INDUSTRIES } from "@/lib/industries";
import { MotionNotConnected, openSession } from "@/lib/motion";
import { LIVE } from "@/lib/live";

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
  // Motion's Inspo shape: { _id, page: { name }, creativeFile: { fileUrl, thumbnailUrl }, creativeAssetFormat, creativeDetails: {...} }
  const d = isObj(ad.creativeDetails) ? (ad.creativeDetails as Obj) : ad;
  const id = str(ad._id) ?? str(pick(ad, "id", "creativeId", "adId"));
  if (!id) return null;
  const launched = str(d.launchDate) ?? str(pick(ad, "launchDate", "launchedAt", "startDate"));
  const launchedAt = launched && !Number.isNaN(Date.parse(launched)) ? new Date(launched).toISOString() : null;
  const status = d.status ?? pick(ad, "status", "isActive", "active");
  const active = typeof status === "boolean" ? status : typeof status === "string" ? /active|running|live/i.test(status) && !/inactive/i.test(status) : null;
  const days = num(d.daysActive) ?? (launchedAt ? Math.max(0, Math.round((Date.now() - Date.parse(launchedAt)) / 86_400_000)) : null);
  const file = isObj(ad.creativeFile) ? (ad.creativeFile as Obj) : null;
  const assetFormat = str(ad.creativeAssetFormat)?.toLowerCase() ?? str(pick(ad, "format", "type"))?.toLowerCase() ?? null;
  const files = itemsOf(ad.creativeFiles);
  const media = (files.length ? files : file ? [file] : [])
    .map((f) => {
      const url = str(f.fileUrl) ?? str(f.url);
      if (!url) return null;
      return { type: (assetFormat === "video" || /\.(mp4|mov|webm|m3u8)(\?|$)/i.test(url) ? "video" : "image") as "image" | "video", url, thumb: str(f.thumbnailUrl) };
    })
    .filter((m): m is NonNullable<typeof m> => Boolean(m));
  const platformId = str(d.platformId);
  const page = isObj(ad.page) ? (ad.page as Obj) : null;
  return {
    motion_id: id,
    brand_id: brandId,
    industry,
    format: files.length > 1 || assetFormat?.includes("carousel") ? "carousel" : assetFormat?.includes("video") ? "video" : media.length ? (media[0].type === "video" ? "video" : "image") : assetFormat,
    headline: str(d.headline) ?? str(pick(ad, "headline", "title")),
    body: str(d.primaryCopy) ?? str(pick(ad, "copy", "body", "primaryText")),
    cta: str(d.CTA) ?? str(pick(ad, "cta", "callToAction")),
    landing_url: str(d.landingPageUrl) ?? str(pick(ad, "landingPageUrl", "landingUrl")),
    launched_at: launchedAt,
    active,
    days_active: days,
    rank: num(d.impressionRank),
    media: media.length ? media : mediaOf(ad),
    page_name: page ? str(page.name) : null,
    library_url: platformId ? `https://www.facebook.com/ads/library/?id=${platformId}` : null,
    motion_url: urls(ad).find((u) => /motionapp\.com/i.test(u)) ?? null,
    raw: ad,
    last_seen_at: new Date().toISOString(),
  };
}

type Session = Awaited<ReturnType<typeof openSession>>;
type Workspace = { id: string; name: string };

/** Kaizen's Motion workspaces (one per client), from the sign-in's auth context. */
function workspacesOf(auth: unknown): Workspace[] {
  const orgs = itemsOf(isObj(auth) && isObj(auth.data) ? (auth.data as Obj).organizations : isObj(auth) ? auth.organizations : null);
  return orgs.flatMap((o) => itemsOf(o.workspaces)).map((w) => ({ id: String(w.id), name: String(w.name ?? "") })).filter((w) => w.id);
}

// "Crust Pizza Co - bmco", "Infamous Ad Account - Active" → the business name
const bare = (s: string) =>
  s
    .toLowerCase()
    .replace(/\b(ad account|ads account|ad acct|account|active|act|llc|inc|co|the)\b/g, " ")
    .replace(/[-–|(].*$/, "")
    .replace(/[^a-z0-9]/g, "");

/** Each client's Motion workspace, matched by name the first time (a set one is kept). */
async function matchWorkspaces(admin: SupabaseClient, workspaces: Workspace[]) {
  const { data: clients } = await admin.from("clients").select("id, name, motion_workspace_id").is("archived_at", null).neq("status", "offboarded");
  let matched = 0;
  for (const c of clients ?? []) {
    if (c.motion_workspace_id) continue;
    const name = bare(c.name);
    if (name.length < 3) continue;
    const hit = workspaces.find((w) => bare(w.name) === name) ?? workspaces.find((w) => bare(w.name).startsWith(name) || (bare(w.name).length >= 4 && name.startsWith(bare(w.name))));
    if (hit) {
      await admin.from("clients").update({ motion_workspace_id: hit.id }).eq("id", c.id);
      matched++;
    }
  }
  return matched;
}

/** A brand in Motion: by its website first (exact), else by name. */
async function resolveBrand(s: Session, workspaceId: string, q: { name?: string | null; domain?: string | null }): Promise<Obj | null> {
  if (q.domain) {
    const r = await s.call("get_brand_by_domain", { brandUrl: `https://${q.domain.replace(/^https?:\/\//, "").split("/")[0]}`, workspaceId }).catch(() => null);
    const id = isObj(r) ? str(pick(r, "brandId", "id")) : null;
    if (id) return { id, name: str(pick(r as Obj, "name", "brandName")) ?? q.name ?? q.domain, domain: q.domain, logo: isObj(r) ? pick(r, "logo") : null };
  }
  if (q.name) {
    const list = itemsOf(await s.call("search_brands", { query: q.name, workspaceId }).catch(() => null));
    const exact = list.find((b) => str(pick(b, "name"))?.toLowerCase() === q.name!.toLowerCase());
    return exact ?? list[0] ?? null;
  }
  return null;
}

async function upsertBrand(admin: SupabaseClient, b: Obj, meta: { source: string; industry?: string | null; detail?: string | null; clientId?: string | null; query?: string }) {
  const motionId = str(pick(b, "brandId", "id"));
  const name = str(pick(b, "name", "brandName"));
  if (!motionId || !name) return null;
  const { data: prev } = await admin.from("market_brands").select("id, sources, client_ids, industry").eq("motion_brand_id", motionId).maybeSingle();
  const row = {
    motion_brand_id: motionId,
    name,
    domain: str(pick(b, "domain", "website", "url")),
    logo: str(pick(b, "logo", "logoUrl", "image")),
    active_ads: num(pick(b, "activeAds", "activeAdCount", "activeAdsCount", "adsCount")),
    sources: [...new Set([...((prev?.sources as string[]) ?? []), meta.source])],
    client_ids: [...new Set([...((prev?.client_ids as string[]) ?? []), ...(meta.clientId ? [meta.clientId] : [])])],
    // The industry from a client who tracks or named them wins; else what the AI sorts them into
    industry: meta.industry ?? prev?.industry ?? null,
    ...(meta.detail ? { industry_detail: meta.detail.slice(0, 80) } : {}),
    ...(meta.query ? { matched_query: meta.query.slice(0, 200) } : {}),
    // Found only by a name a client wrote: checked before it counts. Motion's tracked competitors and the AI's picks are trusted
    ...(meta.source !== "intake" ? { checked_at: new Date().toISOString(), rejected: false } : {}),
  };
  const { data } = await admin.from("market_brands").upsert(row, { onConflict: "motion_brand_id" }).select("id").single();
  return data?.id as string | undefined;
}

/**
 * Which brands to watch: each client's tracked competitors in their own Motion workspace, the competitors they named
 * in their intake form, and strong Meta advertisers the AI picks for each niche we serve.
 */
async function discoverBrands(admin: SupabaseClient, s: Session, workspaces: Workspace[], deadline: number) {
  let found = 0;
  const { data: clients } = await admin.from("clients").select("id, industry, industry_detail, motion_workspace_id").is("archived_at", null).in("status", LIVE);
  const anyWorkspace = workspaces[0]?.id;
  if (!anyWorkspace) return 0;

  // 1. Each client's tracked competitors, from their Motion workspace
  for (const c of clients ?? []) {
    if (!c.motion_workspace_id) continue;
    if (Date.now() > deadline) return found;
    for (const comp of itemsOf(await s.call("get_workspace_competitors", { workspaceId: c.motion_workspace_id }).catch(() => null))) {
      const b = pick(comp, "brandId", "id") ? comp : await resolveBrand(s, c.motion_workspace_id, { name: str(pick(comp, "name")), domain: str(pick(comp, "domain")) });
      if (b && (await upsertBrand(admin, b, { source: "motion", industry: c.industry, detail: c.industry_detail, clientId: c.id }))) found++;
    }
  }

  // 2. Competitors each client named in their intake form
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
      const b = await resolveBrand(s, c.motion_workspace_id ?? anyWorkspace, { name: name.replace(/\(.*?\)|https?:\/\/\S+/g, "").trim(), domain });
      if (b && (await upsertBrand(admin, b, { source: "intake", industry: c.industry, detail: c.industry_detail, clientId: c.id, query: name }))) found++;
    }
  }

  // 3. Strong Meta advertisers in the niches we serve (the AI's picks, checked against Motion)
  const niches = new Map<string, Set<string>>();
  for (const c of clients ?? []) if (c.industry && c.industry !== "other") niches.set(c.industry, (niches.get(c.industry) ?? new Set()).add(c.industry_detail ?? ""));
  if (niches.size && Date.now() < deadline) {
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
        const b = await resolveBrand(s, anyWorkspace, { name: br.name, domain: br.domain });
        if (b && (await upsertBrand(admin, b, { source: "search", industry: ind.industry }))) found++;
      }
    }
  }
  return found;
}

/**
 * Brands found only by a name from a client's intake form: the AI checks each is the competitor the client meant
 * (a local "Sweat" sauna studio isn't sweat.com). Rejected ones are hidden and not synced; Motion-tracked
 * competitors and the AI's own picks don't need it.
 */
async function checkBrands(admin: SupabaseClient, max = 60) {
  const { data: brands } = await admin.from("market_brands").select("id, name, domain, client_ids, matched_query, sources").is("checked_at", null).limit(max);
  if (!brands?.length) return 0;
  const ids = [...new Set(brands.flatMap((b) => (b.client_ids as string[]) ?? []))];
  const [{ data: clients }, { data: intakes }] = await Promise.all([
    admin.from("clients").select("id, name, industry_detail, website").in("id", ids),
    admin.from("client_intakes").select("client_id, summary").in("client_id", ids).not("summary", "is", null),
  ]);
  const named = new Map((intakes ?? []).map((i) => [i.client_id as string, ((i.summary as { competitors?: string[]; locations?: string }).competitors ?? []).join("; ")]));
  const where = new Map((intakes ?? []).map((i) => [i.client_id as string, String((i.summary as { locations?: string }).locations ?? "")]));
  const out = await askJson<{ brands: { n: number; same: boolean; why: string }[] }>({
    agent: "market",
    label: "check market brands",
    system:
      "You check matches between the competitors a client named and brands found by searching Meta's ad library by name. A match is right only if the brand is plausibly that competitor (same kind of business, sensible location); a local business's name often matches an unrelated national or foreign brand. When unsure, it's not a match.",
    schema: {
      type: "object",
      properties: { brands: { type: "array", items: { type: "object", properties: { n: { type: "integer" }, same: { type: "boolean" }, why: { type: "string" } }, required: ["n", "same", "why"], additionalProperties: false } } },
      required: ["brands"],
      additionalProperties: false,
    },
    prompt: brands
      .map((b, i) => {
        const c = (clients ?? []).find((x) => ((b.client_ids as string[]) ?? []).includes(x.id));
        return `${i + 1}. Found: "${b.name}"${b.domain ? ` (${b.domain})` : ""}
   For client: ${c?.name ?? "?"} (${c?.industry_detail ?? "?"}${c?.website ? `, ${c.website}` : ""}${c && where.get(c.id) ? `, ${where.get(c.id)}` : ""})
   The client named as competitors: ${b.matched_query ?? (c ? named.get(c.id) : null) ?? "(unknown)"}`;
      })
      .join("\n\n"),
  });
  const now = new Date().toISOString();
  for (const r of out.brands) {
    const b = brands[r.n - 1];
    if (b) await admin.from("market_brands").update({ checked_at: now, rejected: !r.same, reject_reason: r.same ? null : r.why.slice(0, 200) }).eq("id", b.id);
  }
  // Anything the model skipped counts as not checked yet; it comes round again next run
  return out.brands.length;
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

const READ_SCHEMA = {
  type: "object",
  properties: {
    observation: { type: "string" },
    why: { type: "string" },
    hook: { type: "string" },
    angle: { type: "string" },
    takeaways: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["observation", "why", "hook", "angle", "takeaways", "tags"],
  additionalProperties: false,
};

const READ_SYSTEM = `You are the senior strategist at Kaizen, a paid social agency, reading a live Meta ad from another brand (from the Meta Ad Library, via Motion) for the team. There are no performance numbers for other brands' ads; the signals are how long it has run (brands rarely keep paying for a loser), its impression rank among the brand's ads (1 = the one Meta shows most), and how much the brand is testing.
observation: what those signals say, 1 to 2 sentences (e.g. "Live 515 days and the brand's most-shown ad: this is a proven evergreen winner."). Only the signals given; never invent numbers.
why: why this creative is most likely working, 2 to 4 sentences: the hook (first line, on-image text, first seconds), the angle, the offer or proof, the format and visual choices, how copy and image work together. Specific to this ad.
hook and angle: a few words each.
takeaways: 2 or 3 concrete things our clients' creative could borrow (the structure and idea, never the brand's words or offer).
tags: 2 to 4 from: offer, social proof, ugc, founder, before-after, comparison, urgency, seasonal, education, lifestyle, product demo, testimonial, humor, problem-solution.
Plain, direct, no hype.`;

async function imageFor(url: string | null) {
  if (!url) return [];
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !/image\/(jpeg|png|webp|gif)/.test(type)) return [];
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 4_500_000) return [];
    return [{ mediaType: type.split(";")[0] as "image/jpeg" | "image/png" | "image/webp" | "image/gif", data: buf.toString("base64") }];
  } catch {
    return [];
  }
}

/** The AI's read of one market ad, from its image (or the video's first frame), its copy and how long it has run. */
export async function analyzeMarketAd(admin: SupabaseClient, id: string) {
  const { data: a } = await admin.from("market_ads").select("id, brand_id, format, headline, body, cta, days_active, rank, launched_at, media, page_name, market_brands(name, industry_detail)").eq("id", id).single();
  if (!a) return null;
  const b = a.market_brands as unknown as { name: string; industry_detail: string | null } | null;
  const media = (a.media ?? []) as { type: string; url: string; thumb: string | null }[];
  const still = media.find((m) => m.type === "image")?.url ?? media[0]?.thumb ?? null;
  const { count: recent } = await admin
    .from("market_ads")
    .select("id", { count: "exact", head: true })
    .eq("brand_id", a.brand_id)
    .gte("launched_at", new Date(Date.now() - 14 * 86_400_000).toISOString());
  const out = await askJson<{ observation: string; why: string; hook: string; angle: string; takeaways: string[]; tags: string[] }>({
    agent: "market",
    label: "read a market ad",
    system: READ_SYSTEM,
    schema: READ_SCHEMA,
    images: await imageFor(still),
    prompt: `${a.page_name ?? b?.name ?? "A brand"}${b?.industry_detail ? ` (${b.industry_detail})` : ""} · ${a.format ?? "ad"}${media.length > 1 ? ` (${media.length} cards)` : ""}
${a.days_active != null ? `Live ${a.days_active} days` : "Run time unknown"}${a.launched_at ? ` (since ${String(a.launched_at).slice(0, 10)})` : ""}${a.rank ? ` · impression rank ${a.rank} among the brand's ads` : ""} · the brand launched ${recent ?? 0} ads in the last two weeks
Headline: ${a.headline ?? "(none)"}
Primary text: ${a.body ?? "(none)"}
Button: ${a.cta ?? "(none)"}
${still ? `The ${a.format === "video" ? "video's first frame" : "image"} is attached.` : "No image available."}`,
  });
  const row = {
    observation: out.observation,
    why: out.why.slice(0, 1200),
    hook: out.hook.slice(0, 300) || null,
    angle: out.angle.slice(0, 120) || null,
    takeaways: out.takeaways.slice(0, 3),
    tags: out.tags.slice(0, 4),
    read_at: new Date().toISOString(),
  };
  await admin.from("market_ads").update(row).eq("id", id);
  return { observation: row.observation, why: row.why, hook: row.hook, angle: row.angle, takeaways: row.takeaways };
}

/** New ads get their read, most telling first: proven ones, then the brand's most-shown, then the newest. */
async function readAds(admin: SupabaseClient, deadline: number) {
  let read = 0;
  while (Date.now() < deadline) {
    const { data: ads } = await admin
      .from("market_ads")
      .select("id")
      .is("read_at", null)
      .neq("active", false)
      .order("days_active", { ascending: false, nullsFirst: false })
      .order("rank", { ascending: true, nullsFirst: false })
      .limit(6);
    if (!ads?.length) break;
    await Promise.all(
      ads.map((x) =>
        analyzeMarketAd(admin, x.id).catch(async () => {
          // Can't be read (no image, the AI refused): don't try again every run
          await admin.from("market_ads").update({ read_at: new Date().toISOString() }).eq("id", x.id);
        }),
      ),
    );
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
  const { data: conn } = await admin.from("motion_connection").select("workspace, last_result").eq("id", 1).maybeSingle();
  try {
    const session = await openSession(admin);
    // The first answer from each Motion tool, kept with the result so the reading can be checked against it
    const samples: Record<string, string> = {};
    const s = {
      ...session,
      call: async (name: string, args: Record<string, unknown>) => {
        const r = await session.call(name, args);
        if (!samples[name] && r) samples[name] = JSON.stringify(r).slice(0, 3000);
        return r;
      },
    };
    let workspaces = workspacesOf(conn?.workspace);
    if (!workspaces.length) {
      const auth = await s.call("get_auth_context", {});
      await admin.from("motion_connection").update({ workspace: auth }).eq("id", 1);
      workspaces = workspacesOf(auth);
    }
    const matched = await matchWorkspaces(admin, workspaces);
    const last = (conn?.last_result ?? {}) as { discoveredAt?: string };
    const { count: watched } = await admin.from("market_brands").select("id", { count: "exact", head: true });
    const discover = !watched || !last.discoveredAt || Date.now() - Date.parse(last.discoveredAt) > 7 * 86_400_000;
    const brandsFound = discover ? await discoverBrands(admin, s, workspaces, started + budgetMs * 0.4) : 0;
    const checked = await checkBrands(admin).catch(() => 0);
    const sorted = await sortBrands(admin).catch(() => 0);

    // Live ads, ten brands a call, stalest brands first
    let pulled = 0;
    let brands = 0;
    const errors: string[] = [];
    const { data: list } = await admin.from("market_brands").select("id, motion_brand_id, industry").eq("rejected", false).not("checked_at", "is", null).order("last_synced_at", { ascending: true, nullsFirst: true }).limit(300);
    for (let i = 0; i < (list ?? []).length; i += 10) {
      if (Date.now() > started + budgetMs * 0.75) break;
      const batch = list!.slice(i, i + 10);
      try {
        const r = await s.call("get_inspo_creatives", { brandIds: batch.map((b) => b.motion_brand_id), status: "ACTIVE", sort: "NEWEST", limit: 400 });
        const entries = itemsOf(r);
        for (const b of batch) {
          const entry = entries.find((e) => str(pick(e, "id", "brandId")) === b.motion_brand_id);
          const creatives = entry ? itemsOf(entry.creatives ?? entry) : [];
          const rows = creatives
            .slice(0, 60)
            .map((ad) => adRow(ad, b.id, b.industry))
            .filter((x): x is NonNullable<typeof x> => Boolean(x));
          if (rows.length) await admin.from("market_ads").upsert(rows, { onConflict: "motion_id" });
          // Not in the brand's live ads any more: no longer running
          const live = rows.map((x) => x.motion_id);
          await admin.from("market_ads").update({ active: false }).eq("brand_id", b.id).not("motion_id", "in", `(${live.map((x) => `"${x}"`).join(",") || '""'})`);
          const details = entry && isObj(entry.brandDetails) ? (entry.brandDetails as Obj) : null;
          await admin
            .from("market_brands")
            .update({ last_synced_at: new Date().toISOString(), active_ads: rows.length, ...(details && str(pick(details, "logo")) ? { logo: str(pick(details, "logo")) } : {}) })
            .eq("id", b.id);
          pulled += rows.length;
          brands++;
        }
      } catch (e) {
        errors.push(e instanceof Error ? e.message.slice(0, 160) : String(e));
        if (e instanceof MotionNotConnected) throw e;
      }
    }
    const read = await readAds(admin, deadline).catch((e) => {
      errors.push(`reading: ${e instanceof Error ? e.message : e}`);
      return 0;
    });
    const result = { workspaces: workspaces.length, matched, brandsFound, checked, sorted, brands, pulled, read, errors: errors.slice(0, 8), discoveredAt: discover && brandsFound ? new Date().toISOString() : last.discoveredAt, samples };
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
  libraryUrl: string | null; // the ad in Meta's Ad Library
  pageName: string | null;
  rank: number | null; // impression rank within the brand (1 = most shown)
  observation: string | null; // the AI's read of its run
  takeaways: string[];
  read: boolean;
  angle: string | null;
  hook: string | null;
  why: string | null;
  tags: string[];
  competitorOf: string[]; // client ids who named this brand
  proven: boolean; // still running after 30 days
  fresh: boolean; // launched in the last 7 days
  testing: boolean; // the brand launched 3+ ads in the last 14 days
};

const COLS = "id, format, headline, body, cta, landing_url, launched_at, active, days_active, media, motion_url, library_url, page_name, rank, observation, takeaways, read_at, angle, hook, why, tags, industry, market_brands!inner(name, logo, domain, industry, industry_detail, client_ids, rejected, checked_at)";

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
    libraryUrl: r.library_url as string | null,
    pageName: r.page_name as string | null,
    rank: r.rank as number | null,
    observation: r.observation as string | null,
    takeaways: (r.takeaways ?? []) as string[],
    read: Boolean(r.read_at),
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
  // Half the longest-running (proven), half the newest (what brands are launching and testing now)
  const half = Math.ceil((opts.limit ?? 900) / 2);
  const base = () => {
    let q = db.from("market_ads").select(COLS).neq("active", false).eq("market_brands.rejected", false).not("market_brands.checked_at", "is", null);
    if (opts.industry) q = q.eq("industry", opts.industry);
    return q;
  };
  const [{ data: longest }, { data: newest }] = await Promise.all([
    base().order("days_active", { ascending: false, nullsFirst: false }).limit(half),
    base().order("launched_at", { ascending: false, nullsFirst: false }).limit(half),
  ]);
  const rows = [...new Map([...(longest ?? []), ...(newest ?? [])].map((r) => [(r as Obj).id as string, r as Obj])).values()];
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
   Link: ${a.motionUrl ?? a.libraryUrl ?? a.media[0]?.url ?? a.landingUrl ?? "(none)"}`,
  )
  .join("\n")}
</in_the_market>`;
}
