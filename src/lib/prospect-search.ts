import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson, researchWeb } from "@/lib/ai";
import { cleanSite, clampScore } from "@/lib/sales-core";
import { doneTitle, searchHref, type SearchResult, type SearchStage } from "@/lib/prospect-search-core";

// Prospect searches as background jobs (owner, Nov 24 2026). Starting one (the Sales page, the assistant, the Sales
// agent) queues a row; the server runs it right after answering (next/server after()), and the cron's five-minute step
// picks up anything a cut-off server left behind, so it never depends on the page staying open. Stages, each written
// to the row as it goes (the page polls it): searching sources (the open web) → checking sites (each business's own
// site answers) → scoring fit → saving new ones to the pipeline. Cancel is checked between stages and items. Done: a
// bell notice (and a toast wherever they are) that opens the results, and a Needs me item until they're reviewed
// (src/lib/today.ts). Dedupe: one open search per person and wording; found businesses already in the pipeline aren't
// added twice.

type Admin = SupabaseClient;
const STR = { type: "string" };

export async function queueProspectSearch(admin: Admin, o: { profileId: string; profile: string; want?: number | null; via: "page" | "assistant" | "agent" | "chat" }): Promise<{ id: string; existing: boolean }> {
  const profile = o.profile.trim().slice(0, 500);
  const want = Math.max(3, Math.min(25, Math.round(Number(o.want) || 10)));
  const { data: open } = await admin.from("prospect_searches").select("id").eq("profile_id", o.profileId).ilike("profile", profile.replace(/[%_]/g, "")).in("status", ["queued", "running"]).limit(1).maybeSingle();
  if (open) return { id: open.id as string, existing: true };
  const { data, error } = await admin.from("prospect_searches").insert({ profile_id: o.profileId, profile, want, started_via: o.via }).select("id").single();
  if (error || !data) throw new Error(error?.message ?? "The search couldn't be started.");
  return { id: data.id as string, existing: false };
}

class Cancelled extends Error {}

/** Runs one queued search (claimed first, so two runners never run the same one) */
export async function runProspectSearch(admin: Admin, id: string): Promise<{ ran: boolean; ok?: boolean }> {
  const { data: job } = await admin.from("prospect_searches").update({ status: "running", started_at: new Date().toISOString() }).eq("id", id).eq("status", "queued").select("id, profile_id, profile, want, attempts").maybeSingle();
  if (!job) return { ran: false };
  await admin.from("prospect_searches").update({ attempts: (job.attempts as number) + 1 }).eq("id", id);
  const profile = job.profile as string;
  const want = job.want as number;
  const owner = job.profile_id as string;
  const set = (patch: Record<string, unknown>) => admin.from("prospect_searches").update(patch).eq("id", id);
  const stage = async (s: SearchStage, progress: number) => {
    const { data } = await admin.from("prospect_searches").select("cancel").eq("id", id).maybeSingle();
    if (data?.cancel) throw new Cancelled();
    await set({ stage: s, progress, stage_at: new Date().toISOString() });
  };
  const cancelled = async () => Boolean((await admin.from("prospect_searches").select("cancel").eq("id", id).maybeSingle()).data?.cancel);
  try {
    const { rateCardText } = await import("@/lib/sales-agent");
    // 1. Searching sources
    await stage("searching", 3);
    const notes = await researchWeb({
      agent: "sales_list",
      label: "prospect list",
      model: "sonnet",
      maxSearches: 12,
      maxFetches: 14,
      system: "You build prospect lists for Kaizen, a paid-ads and creative agency. Find real, independent businesses (not directories, franchise corporate pages or listicles) that match the profile, each with its own website. Public sources only: Google, review sites, the business's own site, its public social profiles, the Meta Ad Library and the Google Ads Transparency Center. LinkedIn only as a public search result; never log in or browse it.",
      prompt: `Find about ${Math.ceil(want * 1.4)} businesses matching: ${profile}.\nFor each: name, website, location, what they sell, and the signals behind fit: price point or ticket size, number of locations, review count and rating, social activity, whether they run Meta ads (Meta Ad Library) or Google ads (Ads Transparency Center), email capture on their site. When the profile names a condition ("running no ads"), check it for each and keep only those that meet it, or say it couldn't be checked. Plain notes with URLs.`,
    });

    // 2. Checking sites: the businesses in the notes, each one's own site answering
    await stage("checking", 55);
    const listed = await askJson<{ businesses: { name: string; website: string; location: string; industry: string; signals: string }[] }>({
      agent: "sales_list",
      label: "prospect list scoring",
      maxTokens: 5000,
      schema: { type: "object", additionalProperties: false, required: ["businesses"], properties: { businesses: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "website", "location", "industry", "signals"], properties: { name: STR, website: STR, location: STR, industry: STR, signals: STR } } } } },
      system: "List the businesses in the notes that match the profile: name, its own website (https://domain), location, industry (a short sub-vertical), and the signals seen in one line. Only businesses in the notes; never invent one; no directories or listicles.",
      prompt: `<profile>${profile}</profile>\n\n<notes>\n${notes.slice(0, 40_000)}\n</notes>`,
    });
    const candidates = (listed.businesses ?? []).slice(0, Math.ceil(want * 1.5));
    const live: (typeof candidates)[number][] = [];
    for (let i = 0; i < candidates.length; i++) {
      if (await cancelled()) throw new Cancelled();
      const c = candidates[i];
      const site = cleanSite(c.website);
      if (site && (await answers(site))) {
        live.push({ ...c, website: site });
        await set({ found: live.length, progress: Math.round(55 + (20 * (i + 1)) / Math.max(1, candidates.length)) });
      }
      if (live.length >= want) break;
    }

    // 3. Scoring fit
    await stage("scoring", 75);
    const rates = await rateCardText(admin);
    const scored = live.length
      ? await askJson<{ scores: { website: string; fit_score: number; fit_reason: string }[] }>({
          agent: "sales_list",
          label: "prospect list scoring",
          maxTokens: 4000,
          schema: { type: "object", additionalProperties: false, required: ["scores"], properties: { scores: { type: "array", items: { type: "object", additionalProperties: false, required: ["website", "fit_score", "fit_reason"], properties: { website: STR, fit_score: { type: "integer" }, fit_reason: STR } } } } },
          system: "You are Kaizen's Sales agent. Score each business 0-100 on fit: a real offer with enough ticket size or margin for paid ads to pay back, demand in their area, visible gaps Kaizen fixes (services on the rate card), and signs they can pay (locations, reviews, an established site). fit_reason: why, in one line. Keep each website exactly as given.",
          prompt: `<profile>${profile}</profile>\n\n<businesses>\n${live.map((b) => `- ${b.name} | ${b.website} | ${b.location} | ${b.industry} | ${b.signals}`).join("\n")}\n</businesses>\n\n<rate_card>\n${rates}\n</rate_card>`,
        })
      : { scores: [] };
    const scoreOf = new Map((scored.scores ?? []).map((s) => [cleanSite(s.website) ?? s.website, s]));

    // 4. Saving: new ones into the pipeline as "new"; ones already there are listed, never added twice
    await stage("saving", 88);
    const { findProspect } = await import("@/lib/sales-agent");
    const results: SearchResult[] = [];
    let added = 0;
    const ranked = [...live].sort((a, b) => (scoreOf.get(b.website)?.fit_score ?? 0) - (scoreOf.get(a.website)?.fit_score ?? 0));
    for (let i = 0; i < ranked.length; i++) {
      if (await cancelled()) throw new Cancelled();
      const b = ranked[i];
      const sc = scoreOf.get(b.website);
      const base = { name: b.name.slice(0, 160), website: b.website, location: String(b.location ?? "").slice(0, 200), industry: String(b.industry ?? "").slice(0, 120), signals: String(b.signals ?? "").slice(0, 600), fit_score: clampScore(sc?.fit_score), fit_reason: String(sc?.fit_reason ?? "").slice(0, 600) };
      const have = await findProspect(admin, b.website);
      if (have) results.push({ ...base, id: have.id, already: true });
      else {
        const { data } = await admin
          .from("prospects")
          .insert({ name: base.name, website: base.website, location: base.location || null, industry: base.industry || null, fit_score: base.fit_score, fit_reason: [base.fit_reason, base.signals && `Signals: ${base.signals}`].filter(Boolean).join(" · ") || null, status: "new", owner_id: owner, created_by: owner, source: `search: ${profile.slice(0, 120)}` })
          .select("id")
          .maybeSingle();
        if (data) added++;
        results.push({ ...base, id: (data?.id as string | undefined) ?? null, already: false });
      }
      await set({ added, results, progress: Math.round(88 + (11 * (i + 1)) / Math.max(1, ranked.length)) });
    }
    await set({ status: "done", progress: 100, found: results.length, added, results, finished_at: new Date().toISOString() });
    await deliver(admin, { id, owner, profile, found: results.length });
    return { ran: true, ok: true };
  } catch (e) {
    if (e instanceof Cancelled) {
      await set({ status: "cancelled", finished_at: new Date().toISOString() });
      return { ran: true, ok: false };
    }
    const message = e instanceof Error ? e.message.slice(0, 300) : "The search didn't finish.";
    console.error("[prospect search]", id, message);
    await set({ status: "failed", error: message, finished_at: new Date().toISOString() });
    const { data: me } = await admin.from("profiles").select("is_exec").eq("id", owner).maybeSingle();
    await admin.from("notifications").upsert({ profile_id: owner, kind: "prospect_search", key: `prospect-search:${id}`, title: `Prospect search didn't finish: '${profile.slice(0, 60)}'`, body: `${message} Start it again from Sales or ask your assistant.`, href: me?.is_exec ? `/sales?search=${id}` : null, priority: "normal" }, { onConflict: "profile_id,key", ignoreDuplicates: true });
    return { ran: true, ok: false };
  }
}

/** Whether a site answers (a page, a redirect, or a bot wall all count; a dead domain doesn't) */
async function answers(url: string): Promise<boolean> {
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const r = await fetch(url, { method, redirect: "follow", signal: AbortSignal.timeout(6000), headers: { "user-agent": "Mozilla/5.0 (compatible; KaizenOS/1.0)" } });
      if (r.status < 500 && r.status !== 404 && r.status !== 410) return true;
      if (method === "GET") return false;
    } catch {
      if (method === "GET") return false;
    }
  }
  return false;
}

/** Done: the bell (and a toast wherever they are) opening the results */
async function deliver(admin: Admin, o: { id: string; owner: string; profile: string; found: number }) {
  const { data: me } = await admin.from("profiles").select("is_exec").eq("id", o.owner).maybeSingle();
  await admin.from("notifications").upsert(
    { profile_id: o.owner, kind: "prospect_search", key: `prospect-search:${o.id}`, title: doneTitle(o.found, o.profile), body: o.found ? "Open them to research the best fits and draft the outreach." : "Try a wider area or fewer conditions.", href: searchHref(o.id, Boolean(me?.is_exec)), priority: "normal" },
    { onConflict: "profile_id,key", ignoreDuplicates: true },
  );
}

/** The cron's pickup: searches a cut-off server never started, and runs that died part way (once more, then failed) */
export async function pickUpProspectSearches(admin: Admin) {
  const stale = new Date(Date.now() - 90_000).toISOString();
  const dead = new Date(Date.now() - 15 * 60_000).toISOString();
  const { data: stuck } = await admin.from("prospect_searches").select("id, attempts").eq("status", "running").lt("started_at", dead).limit(10);
  for (const s of stuck ?? []) {
    if ((s.attempts as number) >= 2) await admin.from("prospect_searches").update({ status: "failed", error: "It took too long. Try again.", finished_at: new Date().toISOString() }).eq("id", s.id);
    else await admin.from("prospect_searches").update({ status: "queued", stage: null }).eq("id", s.id).eq("status", "running");
  }
  const { data: queued } = await admin.from("prospect_searches").select("id").eq("status", "queued").lt("created_at", stale).eq("cancel", false).order("created_at").limit(1);
  let ran = 0;
  for (const q of queued ?? []) if ((await runProspectSearch(admin, q.id as string)).ran) ran++;
  return { requeued: stuck?.length ?? 0, ran };
}

export type SearchView = { id: string; profile: string; status: string; stage: SearchStage | null; stageAt: string | null; progress: number; found: number; added: number; want: number; results: SearchResult[]; error: string | null; createdAt: string; finishedAt: string | null; reviewedAt: string | null };
export const SEARCH_COLS = "id, profile, status, stage, stage_at, progress, found, added, want, results, error, created_at, finished_at, reviewed_at";
export const searchView = (r: Record<string, unknown>): SearchView => ({ id: r.id as string, profile: r.profile as string, status: r.status as string, stage: (r.stage as SearchStage | null) ?? null, stageAt: (r.stage_at as string | null) ?? null, progress: (r.progress as number) ?? 0, found: (r.found as number) ?? 0, added: (r.added as number) ?? 0, want: (r.want as number) ?? 10, results: (r.results as SearchResult[]) ?? [], error: (r.error as string | null) ?? null, createdAt: r.created_at as string, finishedAt: (r.finished_at as string | null) ?? null, reviewedAt: (r.reviewed_at as string | null) ?? null });
