import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson, researchWeb } from "@/lib/ai";
import { LIVE } from "@/lib/live";

// Verticals and sub-verticals, worked out from what our clients actually are (intake, briefs, Brand Bibles,
// go-to-market strategies), not a fixed list. Every live client sits in one sub-vertical; market brands too. Each
// sub-vertical carries researched Meta benchmarks: what a good and a great result costs there, with sources.

export type Benchmark = { metric: string; good: number | null; great: number | null; unit: string; note: string; source: string; year: string };
export type SubVertical = { id: string; slug: string; name: string; description: string | null; conversion: string | null; benchmarks: Benchmark[]; benchmarksAt: string | null };
export type Vertical = { id: string; slug: string; name: string; description: string | null; subs: SubVertical[] };

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);

/** What we know about each live paid ads client, short: enough to place them. Verticals are the paid ads team's. */
async function clientFacts(admin: SupabaseClient, ids?: string[]) {
  let q = admin.from("clients").select("id, name, website, industry, industry_detail").is("archived_at", null).in("status", LIVE).eq("paid_ads", true);
  if (ids?.length) q = q.in("id", ids);
  const { data: clients } = await q;
  const list = clients ?? [];
  if (!list.length) return [];
  const cid = list.map((c) => c.id);
  const [{ data: intakes }, { data: gtm }, { data: bibles }] = await Promise.all([
    admin.from("client_intakes").select("client_id, summary").in("client_id", cid).not("summary", "is", null),
    admin.from("client_gtm_strategies").select("client_id, read_this_first").in("client_id", cid),
    admin.from("client_brand_bibles").select("client_id, read_this_first").in("client_id", cid),
  ]);
  return list.map((c) => {
    const s = ((intakes ?? []).find((i) => i.client_id === c.id)?.summary ?? {}) as { business?: string; offer?: string; audience?: string };
    const g = (gtm ?? []).find((x) => x.client_id === c.id)?.read_this_first ?? "";
    const b = (bibles ?? []).find((x) => x.client_id === c.id)?.read_this_first ?? "";
    return {
      id: c.id as string,
      name: c.name as string,
      line: [c.industry_detail, s.business, s.offer && `offer: ${s.offer}`, s.audience && `audience: ${s.audience}`, g && `strategy: ${g.slice(0, 260)}`, b && `brand: ${b.slice(0, 160)}`, c.website]
        .filter(Boolean)
        .join(" · ")
        .slice(0, 700),
    };
  });
}

async function currentTaxonomy(admin: SupabaseClient) {
  const { data } = await admin.from("verticals").select("id, slug, name, parent_id, description, conversion").eq("active", true).order("sort_order");
  const rows = data ?? [];
  return rows
    .filter((v) => !v.parent_id)
    .map((v) => ({ ...v, subs: rows.filter((s) => s.parent_id === v.id) }));
}

const TAXONOMY_SCHEMA = {
  type: "object",
  properties: {
    verticals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          subs: {
            type: "array",
            items: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, conversion: { type: "string" } }, required: ["name", "description", "conversion"], additionalProperties: false },
          },
        },
        required: ["name", "description", "subs"],
        additionalProperties: false,
      },
    },
    clients: { type: "array", items: { type: "object", properties: { n: { type: "integer" }, sub: { type: "string" }, why: { type: "string" } }, required: ["n", "sub", "why"], additionalProperties: false } },
  },
  required: ["verticals", "clients"],
  additionalProperties: false,
};

const TAXONOMY_SYSTEM = `You organise a paid social agency's clients into verticals and sub-verticals, so the agency can build a playbook per sub-vertical: what's working in that market, its benchmarks, its customers and the angles that land.
Go by how each business sells and to whom, not its label: what they sell, the customer, the buying model (online purchase, lead form, booking, reservation, walk-in, call), and the price point. "E-commerce" alone is too broad: split by what's sold (food and drink delivered, apparel, supplements, home goods…). Home improvement splits by trade where buyers and lead costs differ (roofing, fencing, pools, remodeling…). A paintball park is not a restaurant.
A sub-vertical needs to be specific enough that its benchmarks and creative transfer between its clients, and broad enough that several businesses fit. A single client can have its own sub-vertical when nothing else is close. 4 to 12 verticals; each with 1 to 8 sub-verticals.
conversion: what counts as a result for that sub-vertical on Meta ("purchase", "lead form", "booking", "reservation", "call", "store visit", "app install").
Keep names that already exist when they still fit (stability matters); rename or split only when it's clearly better.
clients: every client by number, placed in exactly one sub-vertical (sub: its exact name), with why in a few words.`;

/**
 * The taxonomy, from scratch or refreshed: verticals and sub-verticals from what our live clients are, every live
 * client placed in one. Weekly, or when there's none yet.
 */
export async function buildTaxonomy(admin: SupabaseClient) {
  const facts = await clientFacts(admin);
  if (!facts.length) return { verticals: 0, clients: 0 };
  const current = await currentTaxonomy(admin);
  const out = await askJson<{ verticals: { name: string; description: string; subs: { name: string; description: string; conversion: string }[] }[]; clients: { n: number; sub: string; why: string }[] }>({
    agent: "verticals",
    label: "build verticals",
    system: TAXONOMY_SYSTEM,
    schema: TAXONOMY_SCHEMA,
    prompt: `${current.length ? `The verticals today (keep what still fits):\n${current.map((v) => `${v.name}: ${v.subs.map((s) => s.name).join(", ")}`).join("\n")}\n\n` : ""}Our clients (number. name: what we know):
${facts.map((c, i) => `${i + 1}. ${c.name}: ${c.line || "(little known yet)"}`).join("\n")}`,
  });

  // Save: verticals and sub-verticals by slug (kept stable), anything no longer used set aside
  const keep = new Set<string>();
  const subIdByName = new Map<string, string>();
  let order = 0;
  for (const v of out.verticals) {
    const vslug = slugify(v.name);
    keep.add(vslug);
    const { data: vrow } = await admin
      .from("verticals")
      .upsert({ slug: vslug, name: v.name, description: v.description, parent_id: null, active: true, sort_order: order++ }, { onConflict: "slug" })
      .select("id")
      .single();
    if (!vrow) continue;
    for (const s of v.subs) {
      const sslug = `${vslug}--${slugify(s.name)}`;
      keep.add(sslug);
      const { data: srow } = await admin
        .from("verticals")
        .upsert({ slug: sslug, name: s.name, description: s.description, conversion: s.conversion, parent_id: vrow.id, active: true, sort_order: order++ }, { onConflict: "slug" })
        .select("id")
        .single();
      if (srow) subIdByName.set(s.name.toLowerCase(), srow.id as string);
    }
  }
  const { data: all } = await admin.from("verticals").select("id, slug");
  const stale = (all ?? []).filter((v) => !keep.has(v.slug)).map((v) => v.id as string);
  if (stale.length) await admin.from("verticals").update({ active: false }).in("id", stale);

  let placed = 0;
  const now = new Date().toISOString();
  for (const r of out.clients) {
    const c = facts[r.n - 1];
    const sub = subIdByName.get(r.sub.toLowerCase());
    if (!c || !sub) continue;
    await admin.from("clients").update({ vertical_id: sub, vertical_why: r.why.slice(0, 200), vertical_set_at: now }).eq("id", c.id);
    placed++;
  }
  await admin.from("sync_state").upsert({ source: "verticals", cursor_at: now, last_run_at: now, last_result: { verticals: out.verticals.length, clients: placed } });
  return { verticals: out.verticals.length, clients: placed };
}

const PLACE_SCHEMA = {
  type: "object",
  properties: { items: { type: "array", items: { type: "object", properties: { n: { type: "integer" }, sub: { type: "string" }, why: { type: "string" } }, required: ["n", "sub", "why"], additionalProperties: false } } },
  required: ["items"],
  additionalProperties: false,
};

/** New live clients (and any not placed yet) go into the existing sub-verticals. Hourly. */
export async function placeNewClients(admin: SupabaseClient) {
  const { data } = await admin.from("clients").select("id").is("archived_at", null).in("status", LIVE).eq("paid_ads", true).is("vertical_id", null).limit(30);
  if (!data?.length) return 0;
  const current = await currentTaxonomy(admin);
  if (!current.length) return (await buildTaxonomy(admin)).clients;
  const facts = await clientFacts(admin, data.map((c) => c.id as string));
  const subs = current.flatMap((v) => v.subs.map((s) => ({ ...s, vertical: v.name })));
  const out = await askJson<{ items: { n: number; sub: string; why: string }[] }>({
    agent: "verticals",
    label: "place clients in verticals",
    system: "You place businesses into a paid social agency's sub-verticals by how they sell and to whom. Pick the closest existing sub-vertical by its exact name.",
    schema: PLACE_SCHEMA,
    prompt: `Sub-verticals:\n${subs.map((s) => `${s.name} (${s.vertical}): ${s.description ?? ""}`).join("\n")}\n\nBusinesses:\n${facts.map((c, i) => `${i + 1}. ${c.name}: ${c.line || "(little known yet)"}`).join("\n")}`,
  });
  const byName = new Map(subs.map((s) => [s.name.toLowerCase(), s.id as string]));
  const now = new Date().toISOString();
  let placed = 0;
  for (const r of out.items) {
    const c = facts[r.n - 1];
    const sub = byName.get(r.sub.toLowerCase());
    if (c && sub) {
      await admin.from("clients").update({ vertical_id: sub, vertical_why: r.why.slice(0, 200), vertical_set_at: now }).eq("id", c.id);
      placed++;
    }
  }
  return placed;
}

/** Market brands go into the same sub-verticals (by what they sell), so each playbook has its market. */
export async function placeBrands(admin: SupabaseClient, max = 160) {
  const { data: brands } = await admin.from("market_brands").select("id, name, domain, industry_detail").is("vertical_id", null).eq("rejected", false).not("described_at", "is", null).limit(max);
  if (!brands?.length) return 0;
  const current = await currentTaxonomy(admin);
  if (!current.length) return 0;
  const subs = current.flatMap((v) => v.subs.map((s) => ({ ...s, vertical: v.name })));
  const byName = new Map(subs.map((s) => [s.name.toLowerCase(), s.id as string]));
  let placed = 0;
  for (let i = 0; i < brands.length; i += 60) {
    const batch = brands.slice(i, i + 60);
    const out = await askJson<{ items: { n: number; sub: string; why: string }[] }>({
      agent: "verticals",
      label: "place market brands in verticals",
      system: 'You place brands into a paid social agency\'s sub-verticals by what they sell and to whom. Pick the closest sub-vertical by its exact name, or "none" when nothing is close: a brand only belongs where its ads would teach those clients something.',
      schema: PLACE_SCHEMA,
      prompt: `Sub-verticals:\n${subs.map((s) => `${s.name} (${s.vertical}): ${s.description ?? ""}`).join("\n")}\n\nBrands:\n${batch.map((b, j) => `${j + 1}. ${b.name}${b.domain ? ` (${b.domain})` : ""}: ${b.industry_detail ?? "?"}`).join("\n")}`,
    });
    for (const r of out.items) {
      const b = batch[r.n - 1];
      const sub = byName.get(r.sub.toLowerCase());
      if (b && sub) {
        await admin.from("market_brands").update({ vertical_id: sub }).eq("id", b.id);
        placed++;
      }
    }
  }
  return placed;
}

const BENCH_SCHEMA = {
  type: "object",
  properties: {
    benchmarks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          metric: { type: "string", enum: ["cost_per_result", "roas", "ctr", "cpm", "conversion_rate"] },
          good: { type: ["number", "null"] },
          great: { type: ["number", "null"] },
          unit: { type: "string" },
          note: { type: "string" },
          source: { type: "string" },
          year: { type: "string" },
        },
        required: ["metric", "good", "great", "unit", "note", "source", "year"],
        additionalProperties: false,
      },
    },
  },
  required: ["benchmarks"],
  additionalProperties: false,
};

/**
 * Industry benchmarks for a sub-vertical on Meta, from web research with sources: what a good and a great cost per
 * result is (per lead, purchase, booking…), ROAS for e-commerce, CTR and CPM. Sub-verticals without them, or with
 * ones over 90 days old, a few per run.
 */
export async function researchBenchmarks(admin: SupabaseClient, max = 2) {
  const stale = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const { data: subs } = await admin
    .from("verticals")
    .select("id, name, description, conversion, parent_id")
    .not("parent_id", "is", null)
    .eq("active", true)
    .or(`benchmarks_at.is.null,benchmarks_at.lt.${stale}`)
    .order("benchmarks_at", { ascending: true, nullsFirst: true })
    .limit(max);
  let done = 0;
  const parents = await parentNames(admin, (subs ?? []).map((s) => s.parent_id));
  for (const s of subs ?? []) {
    const parent = parents.get(s.parent_id) ?? "";
    const research = await researchWeb({
      agent: "verticals",
      // Gathering figures doesn't need the strategy model: Sonnet with a few searches and reads
      model: "sonnet",
      maxSearches: 6,
      maxFetches: 5,
      maxTurns: 3,
      label: `benchmarks ${s.name}`,
      system: "You research paid social benchmarks for a marketing agency. Report only figures you actually found, each with its source URL and year. Prefer recent (last 2 years), US, Meta (Facebook and Instagram) figures; say when a figure is for all paid social or a broader category.",
      prompt: `Meta (Facebook and Instagram) ad benchmarks for: ${s.name} (${parent}). ${s.description ?? ""} A result here is a ${s.conversion ?? "conversion"}.
Find: typical cost per ${s.conversion ?? "result"} (and what counts as strong), ROAS if it's e-commerce, link CTR, CPM, and conversion rate. Several sources if they differ.`,
    }).catch(() => "");
    if (!research) continue;
    const out = await askJson<{ benchmarks: Benchmark[] }>({
      agent: "verticals",
      label: `benchmarks table ${s.name}`,
      system: `You turn research into a benchmark table for a paid social agency. good: a solid result in this sub-vertical; great: a result that's clearly winning. For costs, lower is better (great < good); for ROAS, CTR and conversion rate, higher is better. Only figures from the research, with their source and year; null when the research doesn't support a number. unit: "$", "x" or "%".`,
      schema: BENCH_SCHEMA,
      prompt: `Sub-vertical: ${s.name} (${parent}); a result is a ${s.conversion ?? "conversion"}.\n\n<research>\n${research.slice(0, 20000)}\n</research>`,
    });
    await admin.from("verticals").update({ benchmarks: out.benchmarks, benchmarks_at: new Date().toISOString() }).eq("id", s.id);
    done++;
  }
  return done;
}

/** Hourly upkeep: a taxonomy when there's none (and weekly), new clients placed, benchmarks researched and playbooks written a few at a time. */
export async function keepVerticals(admin: SupabaseClient) {
  const { tracker } = await import("@/lib/progress");
  const t = await tracker(admin, "verticals", "steps");
  try {
    const out = await keepVerticalsRun(admin, t);
    await t.finish({ summary: `${out.placed} clients placed, ${out.benchmarks} benchmarks researched, ${out.playbooks} playbooks written` });
    return out;
  } catch (e) {
    await t.finish({ error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

async function keepVerticalsRun(admin: SupabaseClient, t: import("@/lib/progress").Tracker) {
  const start = Date.now();
  t.total(5);
  const { data: last } = await admin.from("sync_state").select("last_run_at").eq("source", "verticals").maybeSingle();
  const weekly = !last?.last_run_at || Date.now() - Date.parse(last.last_run_at) > 7 * 86_400_000;
  t.on(weekly ? "Working out the verticals from every paid client" : "Verticals are current");
  const built = weekly ? await buildTaxonomy(admin) : null;
  t.tick("Placing new clients");
  const placed = await placeNewClients(admin);
  t.tick("Researching benchmarks");
  const benchmarks = built ? 0 : await researchBenchmarks(admin, 2).catch(() => 0);
  // The Hall of Fame before the playbooks (they're built from it); the Meta sync updates it too
  t.tick("Updating the Hall of Fame");
  const { updateHallOfFame } = await import("@/lib/hall-of-fame");
  const fame = await updateHallOfFame(admin, Date.now() + 150_000).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
  t.tick("Writing playbooks");
  // Then a playbook or two, if there's time left in the run
  const { keepPlaybooks } = await import("@/lib/playbooks");
  const left = 640_000 - (Date.now() - start);
  // About a minute each: as many as the run has time for (up to 10)
  const playbooks = left > 90_000 ? await keepPlaybooks(admin, Math.min(10, Math.floor((left - 30_000) / 60_000))).catch(() => 0) : 0;
  t.tick(null);
  return { built, placed, benchmarks, fame, playbooks };
}

/** Parent vertical names by id (a self-join PostgREST can't embed by itself). */
export async function parentNames(db: SupabaseClient, ids: (string | null | undefined)[]) {
  const want = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!want.length) return new Map<string, string>();
  const { data } = await db.from("verticals").select("id, name").in("id", want);
  return new Map((data ?? []).map((v) => [v.id as string, v.name as string]));
}

/** The whole taxonomy with benchmarks, for pages. */
export async function loadVerticals(db: SupabaseClient): Promise<Vertical[]> {
  const { data } = await db.from("verticals").select("id, slug, name, parent_id, description, conversion, benchmarks, benchmarks_at").eq("active", true).order("sort_order");
  const rows = data ?? [];
  return rows
    .filter((v) => !v.parent_id)
    .map((v) => ({
      id: v.id,
      slug: v.slug,
      name: v.name,
      description: v.description,
      subs: rows
        .filter((s) => s.parent_id === v.id)
        .map((s) => ({ id: s.id, slug: s.slug, name: s.name, description: s.description, conversion: s.conversion, benchmarks: (s.benchmarks ?? []) as Benchmark[], benchmarksAt: s.benchmarks_at })),
    }));
}
