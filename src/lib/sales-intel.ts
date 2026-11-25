import "server-only";
import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

// The real market data a prospect's go-to-market strategy is written from (read at writing time, src/lib/sales-gtm.ts):
//   censusProfile  the trade area's people and businesses from the Census Bureau's free API: population, households,
//                  median household income and age, households over $100k/$150k/$200k, home value and ownership,
//                  degrees (ACS 5-year) for the zip, the city and the county, and the county's businesses by sector and
//                  by size (County Business Patterns). The avatar and the serviceable market are built from it.
//   metaAdIntel    the prospect's and its competitors' live Meta ads, read through Kaizen's Motion connection (Motion
//                  indexes Meta's Ad Library; Meta's own API returns only political and EU ads for US advertisers):
//                  active ad count, formats, how long the oldest has run, hooks, offers, CTAs and landing pages.
// Each returns a text block for the model, or a plain line saying what couldn't be read (never silence).

type Admin = SupabaseClient;

const STATES: Record<string, string> = { AL: "01", AK: "02", AZ: "04", AR: "05", CA: "06", CO: "08", CT: "09", DE: "10", DC: "11", FL: "12", GA: "13", HI: "15", ID: "16", IL: "17", IN: "18", IA: "19", KS: "20", KY: "21", LA: "22", ME: "23", MD: "24", MA: "25", MI: "26", MN: "27", MS: "28", MO: "29", MT: "30", NE: "31", NV: "32", NH: "33", NJ: "34", NM: "35", NY: "36", NC: "37", ND: "38", OH: "39", OK: "40", OR: "41", PA: "42", RI: "44", SC: "45", SD: "46", TN: "47", TX: "48", UT: "49", VT: "50", VA: "51", WA: "53", WV: "54", WI: "55", WY: "56" };

const ACS = "https://api.census.gov/data/2023/acs/acs5";
const CBP = "https://api.census.gov/data/2022/cbp";
const ACS_VARS = ["B01003_001E", "B11001_001E", "B19013_001E", "B01002_001E", "B25077_001E", "B25003_001E", "B25003_002E", "B19001_014E", "B19001_015E", "B19001_016E", "B19001_017E", "B15003_001E", "B15003_022E", "B15003_023E", "B15003_024E", "B15003_025E"];
const key = () => (process.env.CENSUS_API_KEY ? `&key=${process.env.CENSUS_API_KEY}` : "");

async function census(url: string): Promise<string[][] | null> {
  try {
    const res = await fetch(`${url}${key()}`, { signal: AbortSignal.timeout(15_000), cache: "no-store" });
    // Without a key the API redirects to its "missing key" page
    if (res.redirected && /missing_key/.test(res.url)) throw new Error("missing_key");
    if (!res.ok) return null;
    return (await res.json()) as string[][];
  } catch (e) {
    if (e instanceof Error && e.message === "missing_key") throw e;
    return null;
  }
}

const n = (v: string | undefined) => (v == null || Number(v) < 0 ? null : Number(v));
const fmt = (v: number | null) => (v == null ? "n/a" : v.toLocaleString("en-US"));
const pct = (a: number | null, b: number | null) => (a == null || !b ? "n/a" : `${Math.round((a / b) * 100)}%`);

/** One ACS row (header + values) as plain lines */
function acsLines(label: string, row: string[] | undefined, head: string[]): string | null {
  if (!row) return null;
  const g = (k: string) => n(row[head.indexOf(k)]);
  const pop = g("B01003_001E");
  const hh = g("B11001_001E");
  const over100 = [g("B19001_014E"), g("B19001_015E"), g("B19001_016E"), g("B19001_017E")].reduce<number>((a, b) => a + (b ?? 0), 0);
  const over150 = (g("B19001_016E") ?? 0) + (g("B19001_017E") ?? 0);
  const degree = [g("B15003_022E"), g("B15003_023E"), g("B15003_024E"), g("B15003_025E")].reduce<number>((a, b) => a + (b ?? 0), 0);
  return `${label}: population ${fmt(pop)}; households ${fmt(hh)}; median household income $${fmt(g("B19013_001E"))}; median age ${g("B01002_001E") ?? "n/a"}; households earning $100k+ ${fmt(over100)} (${pct(over100, hh)}), $150k+ ${fmt(over150)} (${pct(over150, hh)}), $200k+ ${fmt(g("B19001_017E"))} (${pct(g("B19001_017E"), hh)}); median home value $${fmt(g("B25077_001E"))}; owner-occupied ${pct(g("B25003_002E"), g("B25003_001E"))}; adults 25+ with a bachelor's or higher ${pct(degree, g("B15003_001E"))}`;
}

/** "City, ST" → its county (name and FIPS), through OpenStreetMap's geocoder and the Census county list */
async function countyOf(city: string, st: string): Promise<{ state: string; county: string; name: string } | null> {
  const state = STATES[st];
  if (!state) return null;
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&countrycodes=us&limit=1&q=${encodeURIComponent(`${city}, ${st}`)}`, { headers: { "user-agent": "KaizenOS-sales-research/1.0" }, signal: AbortSignal.timeout(10_000), cache: "no-store" });
    const hit = ((await res.json()) as { address?: { county?: string; city?: string } }[])[0];
    const countyName = hit?.address?.county;
    if (!countyName) return null;
    const list = await census(`${ACS}?get=NAME&for=county:*&in=state:${state}`);
    const row = (list ?? []).slice(1).find((r) => r[0].toLowerCase().startsWith(countyName.toLowerCase()));
    return row ? { state, county: row[2], name: row[0] } : null;
  } catch {
    return null;
  }
}

/**
 * The trade area in numbers: the prospect's zip (when its address has one), its city and its county (ACS 5-year 2023),
 * and the county's businesses by sector and size (County Business Patterns 2022).
 */
export async function censusProfile(o: { location: string | null; places: string[] }): Promise<string> {
  try {
    return await readCensus(o);
  } catch (e) {
    if (e instanceof Error && e.message === "missing_key") return `<census unavailable="true">The Census API needs a key (CENSUS_API_KEY isn't set), so demographics and business counts weren't read for this draft.</census>`;
    return `<census unavailable="true">The Census API couldn't be read: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}</census>`;
  }
}

async function readCensus(o: { location: string | null; places: string[] }): Promise<string> {
  const text = [o.location ?? "", ...o.places].join(" ; ");
  const zip = /\b(\d{5})(?:-\d{4})?\b/.exec(text)?.[1] ?? null;
  const cityHit = /([A-Z][A-Za-z .'-]{2,40}),\s*([A-Z]{2})\b/.exec(text);
  const city = cityHit ? cityHit[1].replace(/^.*\d\s*/, "").replace(/^(suite|ste)\b.*?,\s*/i, "").trim() : null;
  const st = cityHit?.[2] ?? null;
  const vars = ACS_VARS.join(",");
  const lines: string[] = [];
  if (zip) {
    const r = await census(`${ACS}?get=NAME,${vars}&for=zip%20code%20tabulation%20area:${zip}`);
    const l = r ? acsLines(`ZIP ${zip}`, r[1], r[0]) : null;
    if (l) lines.push(l);
  }
  let county: Awaited<ReturnType<typeof countyOf>> = null;
  if (city && st && STATES[st]) {
    const places = await census(`${ACS}?get=NAME,${vars}&for=place:*&in=state:${STATES[st]}`);
    const row = (places ?? []).slice(1).find((r) => r[0].toLowerCase().startsWith(`${city.toLowerCase()} city,`) || r[0].toLowerCase().startsWith(`${city.toLowerCase()} town,`) || r[0].toLowerCase().startsWith(`${city.toLowerCase()} cdp,`) || r[0].toLowerCase().startsWith(`${city.toLowerCase()} village,`));
    const l = row && places ? acsLines(row[0], row, places[0]) : null;
    if (l) lines.push(l);
    county = await countyOf(city, st);
    if (county) {
      const c = await census(`${ACS}?get=NAME,${vars}&for=county:${county.county}&in=state:${county.state}`);
      const lc = c ? acsLines(county.name, c[1], c[0]) : null;
      if (lc) lines.push(lc);
      const sectors = await census(`${CBP}?get=NAICS2017,NAICS2017_LABEL,ESTAB,EMP&for=county:${county.county}&in=state:${county.state}&NAICS2017=*`);
      const two = (sectors ?? []).slice(1).filter((r) => /^(00|\d{2}|\d{2}-\d{2})$/.test(r[0]));
      if (two.length) lines.push(`${county.name} businesses with employees (County Business Patterns 2022): ${two.map((r) => `${r[1]} ${fmt(n(r[2]))} establishments`).join("; ")}`);
      const sizes = await census(`${CBP}?get=EMPSZES,EMPSZES_LABEL,ESTAB&for=county:${county.county}&in=state:${county.state}&NAICS2017=00&EMPSZES=*`);
      const sz = (sizes ?? []).slice(1).filter((r) => r[0] !== "001");
      if (sz.length) lines.push(`${county.name} establishments by employee size (CBP 2022): ${sz.map((r) => `${r[1]}: ${fmt(n(r[2]))}`).join("; ")}`);
    }
  }
  if (!lines.length) return `<census unavailable="true">The Census API returned nothing for "${text.slice(0, 120)}" (no zip, city or county matched).</census>`;
  return `<census source="U.S. Census Bureau API: ACS 5-year 2023 estimates; County Business Patterns 2022" read="${new Date().toISOString().slice(0, 10)}">\n${lines.join("\n")}\n</census>`;
}

/**
 * Meta's own Ad Library API (graph ads_archive), asked first for every brand by name. For US advertisers it returns
 * only social-issue, election and political ads (all ad types are open only for ads delivered in the EU), so a
 * commercial advertiser usually comes back empty or refused: the exact answer is kept and shown, never hidden.
 */
async function adsArchive(term: string): Promise<{ ok: true; ads: { page: string; start: string | null; stop: string | null; body: string; title: string }[] } | { ok: false; error: string }> {
  const token = process.env.META_SYSTEM_USER_TOKEN;
  if (!token) return { ok: false, error: "no Meta token configured" };
  const v = process.env.META_API_VERSION || "v24.0";
  const proof: Record<string, string> = process.env.META_APP_SECRET ? { appsecret_proof: createHmac("sha256", process.env.META_APP_SECRET).update(token).digest("hex") } : {};
  const params = new URLSearchParams({ search_terms: term, ad_reached_countries: '["US"]', ad_active_status: "ALL", ad_type: "ALL", fields: "page_name,ad_delivery_start_time,ad_delivery_stop_time,ad_creative_bodies,ad_creative_link_titles", limit: "50", ...proof, access_token: token });
  try {
    const r = (await (await fetch(`https://graph.facebook.com/${v}/ads_archive?${params}`, { cache: "no-store", signal: AbortSignal.timeout(20_000) })).json()) as { data?: { page_name?: string; ad_delivery_start_time?: string; ad_delivery_stop_time?: string; ad_creative_bodies?: string[]; ad_creative_link_titles?: string[] }[]; error?: { message?: string; code?: number } };
    if (r.error) return { ok: false, error: `${r.error.message ?? "refused"}${r.error.code ? ` (code ${r.error.code})` : ""}` };
    return { ok: true, ads: (r.data ?? []).map((a) => ({ page: a.page_name ?? "", start: a.ad_delivery_start_time ?? null, stop: a.ad_delivery_stop_time ?? null, body: a.ad_creative_bodies?.[0] ?? "", title: a.ad_creative_link_titles?.[0] ?? "" })) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 160) : String(e) };
  }
}

const month = (iso: string | null | undefined) => (iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }) : null);

const domainOf = (site: string | null | undefined) => (site ? site.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0].toLowerCase() : null);

/**
 * Live Meta ads for the prospect and up to five competitors, through Motion (Meta's Ad Library). A brand is matched by
 * its website, or by an exact name, never a guess; one Motion doesn't know is reported as "no Meta advertiser found".
 */
export async function metaAdIntel(admin: Admin, brands: { name: string; website: string | null; role: "prospect" | "competitor" }[]): Promise<string> {
  const read = new Date().toISOString().slice(0, 10);
  try {
    const { openSession } = await import("@/lib/motion");
    const { itemsOf, pick, str, adRow, workspacesOf } = await import("@/lib/market");
    const s = await openSession(admin);
    const { data: conn } = await admin.from("motion_connection").select("workspace").eq("id", 1).maybeSingle();
    let ws = workspacesOf(conn?.workspace)[0]?.id ?? null;
    if (!ws) ws = workspacesOf(await s.call("get_auth_context", {}))[0]?.id ?? null;
    if (!ws) return `<meta_ads unavailable="true">Motion has no workspace to search through.</meta_ads>`;
    const out: string[] = [];
    for (const b of brands.slice(0, 6)) {
      const domain = domainOf(b.website);
      // Meta's own API first, its answer kept as it came
      const arch = await adsArchive(b.name);
      const archLine = arch.ok ? `Meta Ad Library API (ads_archive, US, all statuses): ${arch.ads.length} ads returned${arch.ads.length ? ` (pages: ${[...new Set(arch.ads.map((a) => a.page))].slice(0, 3).join(", ")}; first seen ${month(arch.ads.map((a) => a.start).filter(Boolean).sort()[0]) ?? "n/a"})` : " (for US advertisers the API covers only political and issue ads)"}` : `Meta Ad Library API (ads_archive) refused: ${arch.error}`;
      let brandId: string | null = null;
      let brandName = b.name;
      if (domain) {
        const r = await s.call("get_brand_by_domain", { brandUrl: `https://${domain}`, workspaceId: ws }).catch(() => null);
        brandId = r && typeof r === "object" ? str(pick(r as Record<string, unknown>, "brandId", "id")) : null;
        if (brandId) brandName = str(pick(r as Record<string, unknown>, "name", "brandName")) ?? b.name;
      }
      if (!brandId) {
        const list = itemsOf(await s.call("search_brands", { query: b.name, workspaceId: ws }).catch(() => null));
        const exact = list.find((x) => str(pick(x, "name"))?.toLowerCase() === b.name.toLowerCase());
        brandId = exact ? str(pick(exact, "id", "brandId")) : null;
      }
      const label = `${b.role === "prospect" ? "PROSPECT" : "COMPETITOR"} ${b.name}${domain ? ` (${domain})` : ""}`;
      if (!brandId) {
        out.push(`${label}: no Meta advertiser found for ${domain ? `the website ${domain} or the name "${b.name}"` : `the name "${b.name}"`} in the Ad Library index via Motion (read ${read}); treat as not running Meta ads now. ${archLine}.`);
        continue;
      }
      const r = await s.call("get_inspo_creatives", { brandIds: [brandId], status: "ACTIVE", sort: "NEWEST", limit: 60 }).catch((e) => e instanceof Error ? e.message : String(e));
      if (typeof r === "string") {
        out.push(`${label}: not checked: Motion couldn't read its ads (error: ${r.slice(0, 160)}). ${archLine}.`);
        continue;
      }
      const entry = itemsOf(r).find((e) => str(pick(e, "id", "brandId")) === brandId) ?? itemsOf(r)[0];
      const ads = (entry ? itemsOf((entry as Record<string, unknown>).creatives ?? entry) : []).map((ad) => adRow(ad, brandId!, null)).filter((x): x is NonNullable<typeof x> => Boolean(x));
      if (!ads.length) {
        out.push(`${label} [Meta advertiser "${brandName}"]: 0 active ads right now (read ${read}). ${archLine}.`);
        continue;
      }
      const formats = Object.entries(ads.reduce<Record<string, number>>((m, a) => ({ ...m, [a.format ?? "other"]: (m[a.format ?? "other"] ?? 0) + 1 }), {})).map(([k, v]) => `${v} ${k}`).join(", ");
      const longest = Math.max(...ads.map((a) => a.days_active ?? 0));
      const landings = [...new Set(ads.map((a) => domainOf(a.landing_url) && a.landing_url!.replace(/[?#].*$/, "")).filter(Boolean))].slice(0, 5);
      const samples = ads.slice(0, 6).map((a) => `  - ${a.format ?? "ad"}, ${a.days_active ?? "?"} days: "${(a.headline ?? "").slice(0, 120)}" / "${(a.body ?? "").replace(/\s+/g, " ").slice(0, 260)}" CTA ${a.cta ?? "n/a"}${a.landing_url ? ` → ${a.landing_url.replace(/[?#].*$/, "").slice(0, 120)}` : ""}`);
      const since = month(ads.map((a) => a.launched_at).filter((x): x is string => Boolean(x)).sort()[0]);
      const newest = month(ads.map((a) => a.launched_at).filter((x): x is string => Boolean(x)).sort().at(-1));
      out.push(`${label} [Meta advertiser "${brandName}"]: ${ads.length}${ads.length >= 60 ? "+" : ""} active ads${since ? ` running since ${since} (newest launched ${newest})` : ""} (${formats}); longest running ${longest} days; landing pages: ${landings.join(", ") || "n/a"}. ${archLine}.\n${samples.join("\n")}`);
    }
    return `<meta_ads source="Meta Ad Library via Motion" read="${read}">\n${out.join("\n")}\n</meta_ads>`;
  } catch (e) {
    const why = e instanceof Error ? e.message.slice(0, 200) : String(e);
    console.error("[gtm] meta ads", why);
    return `<meta_ads unavailable="true">The Meta Ad Library couldn't be read through Motion: ${why}</meta_ads>`;
  }
}
