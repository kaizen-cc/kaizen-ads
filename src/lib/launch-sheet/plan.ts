import { budgetSpec, daysBetween, mapBudget, specSpend, type BudgetMode } from "./budget";
import { copyWarnings, ctaType } from "./payloads";
import type { BudgetSpec, LaunchItem, LaunchPlan, LaunchQuestion, LaunchSheet, PlanAd, PlanAdset, PlanCampaign, PlanMedia, Resolution, Targeting } from "./types";

// The launch plan: the Media Buyer proposes the STRUCTURE from the conversation (which campaigns and ad sets, which
// sheet rows go where, names, identities, budgets, dates, targeting), and this file fills in everything that must be
// exact and never retyped by a model: the copy straight from the sheet's rows, the files and posts the resolution
// found, the pixel, the geo keys, the UTMs. Then it lists the lines in the order they're created, and says which can
// run next (so a failed line is retried alone and nothing is created twice).

export type ProposalBudget = { type: "daily" | "lifetime" | "none"; amount: number; schedules: { start: string; end: string; amount: number }[] };
export type Proposal = {
  note: string;
  goLive: "paused" | "scheduled";
  campaigns: { key: string; mode: "new" | "existing"; existingId: string; name: string; objective: string; budget: ProposalBudget; start: string; end: string }[];
  adsets: {
    key: string;
    campaignKey: string;
    mode: "new" | "existing";
    existingId: string;
    name: string;
    budget: ProposalBudget;
    start: string;
    end: string;
    geos: { text: string; radius: number }[];
    countries: string[];
    zips: string[];
    ageMin: number;
    ageMax: number;
    advantageAudience: boolean;
    event: string;
    /** The existing ad set a new one is copied from ("" when it isn't a copy) */
    cloneFrom?: string;
  }[];
  ads: { key: string; adsetKey: string; rows: number[]; name: string; identity: "page" | "partnership"; page: string; partner: string; cta: string; link: string }[];
};

export type PlanContext = { sheet: LaunchSheet; resolution: Resolution; account: string; urlTags: string | null; today: string; specialAdCategories: string[] };

const budgetOf = (b: ProposalBudget | undefined): BudgetSpec | null =>
  !b || b.type === "none" || !(b.amount > 0) ? null : { type: b.type, amount: Math.round(b.amount * 100) / 100, ...(b.schedules?.length ? { schedules: b.schedules.filter((s) => s.amount > 0 && s.start && s.end) } : {}) };
const day = (s: string | null | undefined) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
const uniq = <T,>(xs: T[]) => [...new Set(xs)];

/** The copy of the rows an ad runs: every distinct primary text, headline and description, in the sheet's order */
export function copyOf(sheet: LaunchSheet, rows: number[]) {
  const opts = rows.flatMap((i) => sheet.rows[i]?.copy ?? []);
  return {
    bodies: uniq(opts.map((o) => o.primary.trim()).filter(Boolean)),
    titles: uniq(opts.map((o) => o.headline.trim()).filter(Boolean)),
    descriptions: uniq(opts.map((o) => o.description.trim()).filter(Boolean)),
  };
}

/** Turns the Media Buyer's proposal into the full plan, and lists what doesn't add up */
export function buildPlan(p: Proposal, ctx: PlanContext): { plan: LaunchPlan; warnings: string[] } {
  const { sheet, resolution: res } = ctx;
  const warnings: string[] = [];
  const pageBy = (name: string) => {
    const n = name.trim().toLowerCase();
    return res.pages.find((x) => x.name.toLowerCase() === n || (x.pageName ?? "").toLowerCase() === n) ?? null;
  };
  const campaigns: PlanCampaign[] = p.campaigns.map((c) => ({
    key: c.key,
    mode: c.mode === "existing" && c.existingId ? "existing" : "new",
    existingId: c.mode === "existing" && c.existingId ? c.existingId : null,
    name: c.name.trim(),
    objective: c.objective || "OUTCOME_SALES",
    specialAdCategories: ctx.specialAdCategories,
    budget: budgetOf(c.budget),
    start: day(c.start),
    end: day(c.end),
  }));
  const geoKey = (text: string) => res.geos.find((g) => g.text.toLowerCase() === text.trim().toLowerCase()) ?? null;
  const adsets: PlanAdset[] = p.adsets.map((s) => {
    const cities: Targeting["cities"] = [];
    const regions: Targeting["regions"] = [];
    const countries = [...s.countries];
    for (const g of s.geos) {
      const r = geoKey(g.text);
      if (!r?.key) {
        warnings.push(`Ad set "${s.name}": "${g.text}" isn't a place Meta knows yet.`);
        continue;
      }
      if (r.type === "city") cities.push({ key: r.key, name: r.name ?? g.text, radius: Math.min(50, Math.max(10, Math.round(g.radius || 15))), unit: "mile" });
      else if (r.type === "region") regions.push({ key: r.key, name: r.name ?? g.text });
      else if (r.type === "country" && r.country) countries.push(r.country);
    }
    // A copy of an existing ad set keeps that ad set's places (read when the plan is laid out)
    const cloneFrom = s.mode !== "existing" && s.cloneFrom?.trim() ? s.cloneFrom.trim() : null;
    if (!cloneFrom && g0(cities, regions, countries, s.zips)) warnings.push(`Ad set "${s.name}" has no location.`);
    return {
      cloneFrom,
      cloned: null,
      key: s.key,
      campaignKey: s.campaignKey,
      mode: s.mode === "existing" && s.existingId ? "existing" : "new",
      existingId: s.mode === "existing" && s.existingId ? s.existingId : null,
      name: s.name.trim(),
      optimizationGoal: "OFFSITE_CONVERSIONS",
      pixelId: res.pixel?.id ?? null,
      event: s.event || "PURCHASE",
      budget: budgetOf(s.budget),
      start: day(s.start),
      end: day(s.end),
      targeting: { countries: uniq(countries), cities, regions, zips: s.zips, ageMin: Math.max(13, Math.min(65, s.ageMin || 18)), ageMax: Math.max(18, Math.min(65, s.ageMax || 65)), advantageAudience: Boolean(s.advantageAudience) },
      placements: "advantage",
    };
  });
  const ads: PlanAd[] = p.ads.flatMap((a): PlanAd[] => {
    const rows = a.rows.filter((i) => sheet.rows[i]);
    if (!rows.length) {
      warnings.push(`Ad "${a.name}" points at no sheet row.`);
      return [];
    }
    const row = sheet.rows[rows[0]];
    const page = pageBy(a.page) ?? pageBy(row.page);
    const partner = a.identity === "partnership" ? pageBy(a.partner) : null;
    if (!page?.pageId) {
      warnings.push(`Ad "${a.name}": the Page "${a.page || row.page}" isn't one Kaizen can advertise as.`);
      return [];
    }
    const post = row.existingPost ? res.posts.find((x) => x.row === row.index) : null;
    const creative = res.creatives.find((c) => c.row === row.index);
    const mediaOf = (id: string | null): PlanMedia | null => {
      const f = id ? creative?.files.find((x) => x.id === id) : null;
      return f ? { fileId: f.id, name: f.name, aspect: f.aspect, kind: f.kind, thumb: f.thumb } : null;
    };
    const source: PlanAd["source"] = post
      ? { kind: "existing_post", platform: post.platform, url: post.url, mediaId: post.mediaId, storyId: post.storyId }
      : { kind: "files", feed: mediaOf(creative?.picked.feed ?? null), vertical: mediaOf(creative?.picked.vertical ?? null) };
    if (source.kind === "files" && !source.feed && !source.vertical) warnings.push(`Ad "${a.name}": no 4:5 or 9:16 file was found for "${row.creative.name}".`);
    if (source.kind === "existing_post" && !source.mediaId && !source.storyId) warnings.push(`Ad "${a.name}": the post ${source.url} couldn't be found as a post Kaizen can run.`);
    const link = (/^https?:\/\//.test(a.link) ? a.link : null) ?? row.link ?? sheet.event.link ?? "";
    if (!link) warnings.push(`Ad "${a.name}" has no link.`);
    const ad: PlanAd = {
      key: a.key,
      adsetKey: a.adsetKey,
      name: a.name.trim(),
      rows,
      identity: {
        mode: partner ? "partnership" : "page",
        pageId: post?.pageId ?? page.pageId,
        pageName: page.pageName ?? page.name,
        // An existing Instagram post runs as the account that posted it
        igId: post?.igId ?? page.igId,
        partnerPageId: partner?.pageId ?? null,
        partnerIgId: partner?.igId ?? null,
        partnerName: partner ? (partner.pageName ?? partner.name) : null,
      },
      source,
      copy: copyOf(sheet, rows),
      cta: ctaType(a.cta || row.cta, "BUY_TICKETS"),
      link,
      urlTags: ctx.urlTags,
    };
    warnings.push(...copyWarnings(ad).map((w) => `Ad "${ad.name}": ${w}`));
    return [ad];
  });

  // Every ad set and ad belongs to something in the plan (or an existing object)
  for (const s of adsets) if (!campaigns.some((c) => c.key === s.campaignKey)) warnings.push(`Ad set "${s.name}" belongs to no campaign in the plan.`);
  for (const a of ads) if (!adsets.some((s) => s.key === a.adsetKey)) warnings.push(`Ad "${a.name}" belongs to no ad set in the plan.`);
  // Dates: nothing starting in the past, ends after starts, a lifetime budget needs an end
  for (const s of adsets) {
    if (s.start && s.start < ctx.today && s.mode === "new") warnings.push(`Ad set "${s.name}" starts ${s.start}, which is in the past: it will start when it's turned on.`);
    if (s.start && s.end && s.end < s.start) warnings.push(`Ad set "${s.name}" ends before it starts.`);
    if (s.budget?.type === "lifetime" && !s.end) warnings.push(`Ad set "${s.name}" has a lifetime budget but no end date.`);
  }
  for (const c of campaigns) if (c.budget && adsets.some((s) => s.campaignKey === c.key && s.budget)) warnings.push(`Campaign "${c.name}" holds the budget, so its ad sets' own budgets are ignored.`);
  if (p.goLive === "scheduled" && adsets.some((s) => !s.start || s.start <= ctx.today)) warnings.push("A scheduled start needs every new ad set to start after today; the ones that don't will be created paused.");
  // The money against the sheet
  const sheetLeft = sheet.totalBudget != null && sheet.spentToDate != null ? sheet.totalBudget - sheet.spentToDate : null;
  const planned = plannedSpend({ campaigns, adsets, ads, account: ctx.account, goLive: p.goLive, note: "" });
  if (sheetLeft != null && planned != null && planned > sheetLeft + 1) warnings.push(`The plan spends up to $${planned.toFixed(2)}, more than the $${sheetLeft.toFixed(2)} the sheet has left.`);

  return { plan: { account: ctx.account, goLive: p.goLive === "scheduled" ? "scheduled" : "paused", campaigns, adsets, ads, note: p.note }, warnings: uniq(warnings) };
}

const g0 = (a: unknown[], b: unknown[], c: unknown[], d: unknown[]) => !a.length && !b.length && !c.length && !d.length;

/** What the plan spends at most over its dates (null when a budget has no dates to count over) */
export function plannedSpend(plan: LaunchPlan): number | null {
  let total = 0;
  for (const c of plan.campaigns) {
    const own = plan.adsets.filter((s) => s.campaignKey === c.key);
    if (c.budget) {
      const start = c.start ?? own.map((s) => s.start).filter(Boolean).sort()[0] ?? null;
      const end = c.end ?? own.map((s) => s.end).filter(Boolean).sort().at(-1) ?? null;
      if (c.budget.type === "lifetime") total += c.budget.amount;
      else if (start && end) total += specSpend(c.budget, start, end);
      else return null;
    } else
      for (const s of own) {
        if (!s.budget) continue;
        if (s.budget.type === "lifetime") total += s.budget.amount;
        else if (s.start && s.end) total += specSpend(s.budget, s.start, s.end);
        else return null;
      }
  }
  return Math.round(total * 100) / 100;
}

/** The budget options worked out for the buyer from the sheet's periods (shown to the Media Buyer as exact numbers) */
export function budgetOptions(sheet: LaunchSheet, today: string) {
  const tier = sheet.budgets.find((b) => /meta|facebook|instagram/i.test(b.platform)) ?? sheet.budgets[0];
  if (!tier) return null;
  const modes: BudgetMode[] = ["per_period_daily", "lifetime_per_period", "single_lifetime"];
  return {
    platform: tier.platform,
    options: modes.map((m) => {
      const map = mapBudget(tier.periods, m, today);
      return { mode: m, map, spec: budgetSpec(map), days: map.lines.length ? daysBetween(map.lines[0].start, map.lines.at(-1)!.end) : 0 };
    }),
  };
}

// ─── Questions: the plan waits for the answers ──────────────────────────────────────────────────────────────────

/** Can the plan be written? Every required question answered (checked here, not left to the model) */
export const unanswered = (qs: LaunchQuestion[]) => qs.filter((q) => q.required && !q.answer?.trim());

// ─── Lines and the order they're created in ─────────────────────────────────────────────────────────────────────

export function planItems(plan: LaunchPlan): LaunchItem[] {
  const items: LaunchItem[] = [];
  const base = { metaId: null, error: null, help: null, checked: null };
  for (const c of plan.campaigns)
    items.push({ ...base, key: `campaign:${c.key}`, kind: "campaign", position: 0, parentKey: null, label: c.name, status: c.mode === "existing" ? "existing" : "planned", metaId: c.existingId });
  for (const s of plan.adsets)
    items.push({ ...base, key: `adset:${s.key}`, kind: "adset", position: 0, parentKey: `campaign:${s.campaignKey}`, label: s.name, status: s.mode === "existing" ? "existing" : "planned", metaId: s.existingId });
  const media = new Map<string, PlanMedia>();
  for (const a of plan.ads) if (a.source.kind === "files") for (const m of [a.source.feed, a.source.vertical]) if (m) media.set(m.fileId, m);
  for (const m of media.values()) items.push({ ...base, key: `media:${m.fileId}`, kind: "media", position: 0, parentKey: null, label: `${m.name} (${m.aspect.replace("x", ":")})`, status: "planned" });
  for (const a of plan.ads) {
    items.push({ ...base, key: `creative:${a.key}`, kind: "creative", position: 0, parentKey: `adset:${a.adsetKey}`, label: a.name, status: "planned" });
    items.push({ ...base, key: `ad:${a.key}`, kind: "ad", position: 0, parentKey: `creative:${a.key}`, label: a.name, status: "planned" });
  }
  const order: Record<string, number> = { campaign: 0, adset: 1, media: 2, creative: 3, ad: 4 };
  return items.sort((a, b) => order[a.kind] - order[b.kind]).map((x, i) => ({ ...x, position: i }));
}

/** The media a creative needs (its keys) */
export function mediaKeys(plan: LaunchPlan, adKey: string) {
  const a = plan.ads.find((x) => x.key === adKey);
  if (!a || a.source.kind !== "files") return [];
  return [a.source.feed, a.source.vertical].filter((m): m is PlanMedia => Boolean(m)).map((m) => `media:${m.fileId}`);
}

const DONE = new Set(["created", "existing"]);

/**
 * The lines that can be created now, in order: not done yet, and everything they depend on already done. A line that
 * failed is only tried again when `retry` (the buyer's Retry), so one bad line never loops.
 */
export function runnable(items: LaunchItem[], plan: LaunchPlan, retry = false): LaunchItem[] {
  const by = new Map(items.map((i) => [i.key, i]));
  const done = (k: string | null) => !k || DONE.has(by.get(k)?.status ?? "");
  return items
    .filter((i) => !DONE.has(i.status) && i.status !== "skipped" && (retry || i.status !== "failed"))
    .filter((i) => done(i.parentKey) && (i.kind !== "creative" || mediaKeys(plan, i.key.slice("creative:".length)).every(done)))
    .sort((a, b) => a.position - b.position);
}

/** Lines that can't run because something they need failed (shown as waiting on it) */
export function blockedBy(items: LaunchItem[], plan: LaunchPlan, key: string): string | null {
  const by = new Map(items.map((i) => [i.key, i]));
  const item = by.get(key);
  if (!item) return null;
  const needs = [item.parentKey, ...(item.kind === "creative" ? mediaKeys(plan, key.slice("creative:".length)) : [])].filter((k): k is string => Boolean(k));
  for (const k of needs) {
    const n = by.get(k);
    if (n && n.status === "failed") return n.label;
    if (n && !DONE.has(n.status)) {
      const deeper = blockedBy(items, plan, k);
      if (deeper) return deeper;
    }
  }
  return null;
}

/** How the run stands, from its lines */
export function runOutcome(items: LaunchItem[]): "applied" | "partial" | "failed" {
  const todo = items.filter((i) => i.status !== "existing" && i.status !== "skipped");
  const made = todo.filter((i) => i.status === "created").length;
  if (made === todo.length) return "applied";
  return made > 0 ? "partial" : "failed";
}
