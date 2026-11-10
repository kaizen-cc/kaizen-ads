import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { googleDeepLink } from "@/lib/chat-change-core";
import { cachedRead, forgetCached, step } from "@/lib/launch-cache";
import { canIdOn } from "@/lib/chat-permissions-server";
import { googleAdsConfigured, googleBulkMutate, googleQuery, googleWritableSetup, suggestGeo } from "@/lib/context/google-ads";
import { applyAnswers, mergeQuestions } from "@/lib/launch-sheet/questions";
import { unanswered } from "@/lib/launch-sheet/plan";
import { gridText } from "@/lib/launch-sheet/grid";
import type { SheetSource } from "@/lib/launch-sheet/intake";
import type { CheckItem, ItemStatus, LaunchItem, LaunchQuestion, RunStatus } from "@/lib/launch-sheet/types";
import type { SetupFacts } from "@/lib/setup-check";
import {
  campaignChoice,
  campaignRefusal,
  campaignsNamed,
  KEEP_PAUSED,
  checkGooglePlan,
  kaizenScopeIssues,
  draftSummary,
  editPlan,
  errorsByLine,
  G,
  googleItems,
  googleOperations,
  followCampaign,
  googleQuestions,
  kwKey,
  kwText,
  parseKeyword,
  parsePinned,
  plainGoogleError,
  tidyPlan,
  uniqKeywords,
  type AccountAdGroup,
  type AccountCampaign,
  type Bidding,
  type CampaignType,
  type DraftAdGroup,
  type GAdGroup,
  type GCampaign,
  type GoogleDraft,
  type GooglePlan,
  type Kw,
  type PlanEdit,
  type Rsa,
} from "./core";
import { applyMatchAnswer, tabsToDraft } from "./sheet";
import { campaignPlaces, resolvePlaces } from "./places";
import { compareReadBack, missingPlan, type Found, type QaLine } from "./readback";
import { frustrated, wantsEverything } from "@/lib/launch-intent";
import { SHORT_YES } from "@/lib/kaizen-scope";
import { ASKS_FOR_LINK, followLanding, landingRule, pagesText, urlIn, type LandingSet } from "@/lib/landing-pages-core";
import { askedKey, childrenNamedKaizen, isKaizenName, NOT_ASKED, scrubPaused, withKaizen, yesOnlyAnswersAsked, type Comeback, type LaunchContext } from "@/lib/kaizen-scope";
import { contextText } from "@/lib/launch-context";

// A Google launch from the client chat (the client page, or a Google card on the KPI board), start to finish:
//   read     the buyer's words, or the sheet they shared (any layout: see sheet.ts), and the live account (campaigns
//            with their type, status and spend, ad groups and their ads' strength, asset groups, what's set up, the
//            searches that convert and the ones that waste, the Copy library's winners and tired lines)
//   ask      only what's missing, in the format Google needs, with the live campaigns that fit as the options, and
//            what the Google Ads Buyer suggests from the account today (never what's already in place)
//   plan     every object as a line, checked against Google's limits and dry-run by Google (validate only)
//   deploy   on the buyer's confirm: one batch, all or nothing, everything PAUSED, read back with links into Google Ads
// Nothing is written unless an exec switched live changes in Google Ads on for the client (googleBulkMutate's gate).

const now = () => new Date().toISOString();
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const digits = (s: string | null | undefined) => String(s ?? "").replace(/\D/g, "");
const S = { type: "string" };
const N = { type: "number" };
const I = { type: "integer" };
const B = { type: "boolean" };
const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const arr = (items: unknown) => ({ type: "array", items });

export type Suggestion = { key: string; title: string; why: string; accepted: boolean | null };
export type AssetGroupRef = { id: string; name: string; campaignId: string; campaign: string; strength: string | null };

/** What the launch knows about the account and the request (launch_runs.resolution for a Google run) */
export type GoogleResolution = {
  account: string;
  request: string;
  scopeType: CampaignType | null;
  campaigns: AccountCampaign[];
  adGroups: AccountAdGroup[];
  assetGroups: AssetGroupRef[];
  setup: string;
  facts: SetupFacts | null;
  converting: { term: string; campaign: string; conversions: number; spend: number }[];
  waste: { term: string; campaign: string; spend: number; clicks: number }[];
  winners: string[];
  tired: string[];
  inAccount: string[];
  suggestions: Suggestion[];
  checks: CheckItem[];
  at: string;
  /** The client's pages the ads can land on (src/lib/landing-pages.ts) */
  landing?: LandingSet | null;
  /** What a master buyer knows walking in (client, account history, related accounts), built once (launch-context.ts) */
  context?: LaunchContext | null;
  /** The paused Kaizen campaign worth bringing back for this launch, when no live Kaizen campaign fits */
  comeback?: Comeback | null;
  /** Campaigns Kaizen Ads launched for this client (ids): built into as they are, paused or not */
  own?: string[];
  /** Answers settled before the launch was read (adding to a campaign that was just launched: its name) */
  preset?: Record<string, string> | null;
};

/** What the read-back found after a deploy (launch_runs.qa for a Google run) */
export type GoogleQa = { at: string; lines: QaLine[]; summary?: string; missing?: string[]; ids?: Record<string, string>; added?: string | null };

/**
 * The campaigns Kaizen Ads launched for this client (from the launch lines it created): a paused one of these is built
 * into as it is ("it's paused, so nothing runs until you turn it on", said once), never refused.
 */
export async function ownGoogleCampaigns(admin: SupabaseClient, clientId: string): Promise<string[]> {
  const { data: runs } = await admin.from("launch_runs").select("id").eq("client_id", clientId).eq("platform", "google").in("status", ["applied", "partial"]).order("created_at", { ascending: false }).limit(40);
  const ids = (runs ?? []).map((r) => r.id as string);
  if (!ids.length) return [];
  const { data: items } = await admin.from("launch_items").select("meta_id").in("run_id", ids).eq("kind", "campaign").eq("status", "created").not("meta_id", "is", null);
  return [...new Set((items ?? []).map((i) => String(i.meta_id ?? "").match(/campaigns\/(\d+)/)?.[1]).filter((x): x is string => Boolean(x)))];
}

/** asks: the question an assistant turn asked (its key), so a short "yes" answers only that one */
export type Turn = { role: "user" | "assistant"; text: string; at: string; asks?: string | null };
type Run = {
  id: string;
  client_id: string;
  account: string | null;
  status: RunStatus;
  progress: string | null;
  source: SheetSource | { kind: "words"; text: string };
  sheet: GoogleDraft | null;
  summary: string | null;
  resolution: GoogleResolution | null;
  questions: LaunchQuestion[];
  turns: Turn[];
  plan: GooglePlan | null;
  created_by: string | null;
};

async function load(admin: SupabaseClient, id: string): Promise<Run | null> {
  const { data } = await admin.from("launch_runs").select("id, client_id, account, status, progress, source, sheet, summary, resolution, questions, turns, plan, created_by").eq("id", id).eq("platform", "google").maybeSingle();
  return (data as Run | null) ?? null;
}
const patch = (admin: SupabaseClient, id: string, p: Record<string, unknown>) => admin.from("launch_runs").update({ ...p, updated_at: now() }).eq("id", id);

const RULES = `Kaizen's Google launch rules: Kaizen only touches what Kaizen set up. A launch goes into a live campaign with "Kaizen" in its name (and only ad groups inside one), a paused Kaizen campaign brought back when its record says so, or a new campaign whose name has Kaizen in it the way the account names its Kaizen campaigns ("Search | Non Brand | Kaizen"). Campaigns without Kaizen in the name are context only (what converts, what runs): never propose, plan or add to them; if the buyer names one, say in one sentence Kaizen didn't set it up so you won't touch it, and offer the Kaizen one or a new Kaizen campaign. Never propose or plan launching into a paused campaign or ad group (nothing added there runs) unless it's the paused Kaizen campaign offered back, a campaign Kaizen Ads launched itself (marked [launched by Kaizen Ads]) or a paused Kaizen campaign the buyer names and insists on: then build into it as it is, say at most once that it's paused so nothing runs until they turn it on, and never refuse or repeat that. Everything new is created PAUSED: that's Kaizen's rule, not a question, so never ask or confirm it ("Taking that as paused" is never said). A plainly written keyword goes in as phrase match, Kaizen's default: never ask for a match type unless the buyer raises it. Never ask what the account, the history or the client context already answers; decide like a senior buyer and say your pick. Respect Google's limits exactly: RSA headlines up to 30 characters (3 to 15 of them), descriptions up to 90 (2 to 4), display paths up to 15 each, keywords up to 80 characters and 10 words, sitelink text 25, callouts 25. No exclamation marks in headlines, no repeated punctuation, no emojis, no phone numbers in ad text, no all-caps words except brand names and acronyms. Match types: [exact], "phrase", broad as plain text. Profitability first: the searches that convert and the copy that won lead; what wastes spend becomes a negative. Refer to people by role (the buyer, the client, the head of Google), never by name. Plain text, no markdown, no emojis, no em dashes.`;

// ─── Starting one ───────────────────────────────────────────────────────────────────────────────────────────────

/** The client's Google Ads account for this launch: the KPI card's own, else the client's first */
async function accountFor(admin: SupabaseClient, clientId: string, targetId: string | null) {
  const { data: ts } = await admin.from("kpi_targets").select("id, ad_account_id").eq("client_id", clientId).eq("platform", "google").eq("active", true).not("ad_account_id", "is", null).order("created_at");
  const t = (ts ?? []).find((x) => x.id === targetId) ?? (ts ?? [])[0];
  return t?.ad_account_id ? digits(t.ad_account_id as string) : null;
}

/** A new Google launch from the chat (the buyer's words, and a sheet when one was shared); read in the background */
export async function startGoogleRun(
  admin: SupabaseClient,
  clientId: string,
  profileId: string,
  o: { request: string; source?: SheetSource | null; targetId?: string | null; scopeType?: CampaignType | null; opener?: string | null; preset?: Record<string, string> | null },
): Promise<{ id: string } | { error: string }> {
  // Only someone who may launch in this client's Google Ads account starts one (every surface comes here)
  const allowed = await canIdOn(admin, profileId, "ads.launch", { platform: "google", clientId });
  if (!allowed.ok) return { error: allowed.reason };
  const account = await accountFor(admin, clientId, o.targetId ?? null);
  if (!account) return { error: "There's no Google Ads account linked to this client on the KPI board, so I can't launch into it yet." };
  const source = o.source ?? { kind: "words", text: o.request.slice(0, 3000) };
  const { data, error } = await admin
    .from("launch_runs")
    .insert({
      client_id: clientId,
      platform: "google",
      account,
      created_by: profileId,
      source,
      surface: "client_chat",
      status: "reading",
      progress: o.source ? "Reading the sheet and the account" : "Reading the account",
      resolution: { request: o.request.slice(0, 3000), scopeType: o.scopeType ?? null, preset: o.preset ?? null },
      // The chat's first answer is the launch's first turn: it proposes the whole launch and asks "Build it?", so a
      // "yes" to it takes every proposal ("all")
      turns: [...(o.request.trim() ? [{ role: "user", text: o.request.slice(0, 3000), at: now() }] : []), ...(o.opener?.trim() ? [{ role: "assistant", text: o.opener.slice(0, 1500), at: now(), asks: "all" }] : [])],
    })
    .select("id")
    .single();
  if (error || !data) return { error: error?.message ?? "Couldn't start it." };
  return { id: data.id as string };
}

// ─── Reading the account ────────────────────────────────────────────────────────────────────────────────────────

type Row = Record<string, Record<string, unknown>>;
const n = (v: unknown) => Number(v) || 0;

async function readAccount(admin: SupabaseClient, clientId: string, account: string) {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const safe = <T,>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
  // Every part timed, so the slow one shows in the logs ("[launch] google 123 · setup snapshot 4100ms")
  const t = <T,>(label: string, p: Promise<T>) => step(`google ${account}`, label, p);
  const [setup, { data: days }, ads, groups, kws, snapshot, converting, lines] = await Promise.all([
    t("campaigns, ad groups, wasted searches", googleWritableSetup(account)),
    admin.from("google_campaign_daily").select("campaign_id, spend, actions").eq("ad_account_id", account).gte("date", since),
    safe(t("ad strength", googleQuery(account, "SELECT ad_group.id, ad_group_ad.ad_strength FROM ad_group_ad WHERE ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD' AND ad_group_ad.status != 'REMOVED' AND campaign.status != 'REMOVED'") as Promise<Row[]>), [] as Row[]),
    safe(t("asset groups", googleQuery(account, "SELECT asset_group.id, asset_group.name, asset_group.ad_strength, campaign.id, campaign.name FROM asset_group WHERE asset_group.status != 'REMOVED' AND campaign.status != 'REMOVED'") as Promise<Row[]>), [] as Row[]),
    safe(t("keywords", googleQuery(account, "SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM ad_group_criterion WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED' AND ad_group_criterion.negative = FALSE AND campaign.status != 'REMOVED'") as Promise<Row[]>), [] as Row[]),
    safe(t("setup snapshot", import("@/lib/google-setup").then((m) => m.googleSetupSnapshot(account))), null),
    safe(t("converting searches", import("@/lib/context/google-ads").then((m) => m.googleConvertingTerms(account, 90))), [] as { term: string; campaignName: string; conversions: number; spend: number }[]),
    safe(t("copy library", import("@/lib/copy-library").then((m) => m.clientCopyLines(admin, clientId))), []),
  ]);
  const spend = new Map<string, { spend: number; conv: number }>();
  for (const d of days ?? []) {
    const s = spend.get(String(d.campaign_id)) ?? { spend: 0, conv: 0 };
    s.spend += n(d.spend);
    s.conv += n((d.actions as Record<string, number> | null)?.conversions);
    spend.set(String(d.campaign_id), s);
  }
  const strength = new Map<string, { count: number; best: string | null }>();
  const rank = ["EXCELLENT", "GOOD", "AVERAGE", "POOR", "PENDING", "UNKNOWN", "UNSPECIFIED"];
  for (const r of ads) {
    const id = String(r.adGroup?.id ?? "");
    const s = strength.get(id) ?? { count: 0, best: null };
    const st = String((r.adGroupAd as { adStrength?: string } | undefined)?.adStrength ?? "");
    s.count++;
    if (st && (!s.best || rank.indexOf(st) < rank.indexOf(s.best))) s.best = st;
    strength.set(id, s);
  }
  const google = lines.filter((l) => l.platform === "google");
  return {
    campaigns: setup.campaigns.map((c): AccountCampaign => ({ id: c.id, name: c.name, status: c.status, type: c.type, bidding: c.bidding, budget: c.budget, spend30: Math.round((spend.get(c.id)?.spend ?? 0) * 100) / 100, conversions30: Math.round((spend.get(c.id)?.conv ?? 0) * 10) / 10 })),
    adGroups: setup.adGroups.map((g): AccountAdGroup => ({ id: g.id, name: g.name, status: g.status, campaignId: g.campaignId, campaign: g.campaign, rsas: strength.get(g.id)?.count ?? 0, strength: strength.get(g.id)?.best ?? null })),
    assetGroups: groups.map((r): AssetGroupRef => ({ id: String(r.assetGroup?.id ?? ""), name: String(r.assetGroup?.name ?? ""), campaignId: String(r.campaign?.id ?? ""), campaign: String(r.campaign?.name ?? ""), strength: (r.assetGroup?.adStrength as string | undefined) ?? null })),
    setup: snapshot?.text ?? "",
    facts: snapshot?.facts ?? null,
    converting: converting.slice(0, 40).map((t) => ({ term: t.term, campaign: t.campaignName, conversions: Math.round(t.conversions * 10) / 10, spend: t.spend })),
    waste: setup.wasteTerms.slice(0, 25).map((t) => ({ term: t.term, campaign: t.campaign, spend: t.spend, clicks: t.clicks })),
    winners: google.filter((l) => l.badge === "winner" || l.badge === "solid").slice(0, 20).map((l) => `${l.kind}: ${l.text}`),
    tired: google.filter((l) => l.badge === "tired").slice(0, 10).map((l) => `${l.kind}: ${l.text}`),
    inAccount: kws.map((r) => {
      const k = (r.adGroupCriterion as { keyword?: { text?: string; matchType?: string } } | undefined)?.keyword;
      return kwKey({ text: String(k?.text ?? "").toLowerCase(), match: (k?.matchType ?? "BROAD") as Kw["match"] });
    }),
  };
}

type AccountRead = Awaited<ReturnType<typeof readAccount>>;

/**
 * The live account for a launch, kept ten minutes (src/lib/launch-cache.ts): the warm-up started while the chat is
 * still answering, a second launch, a retry and the suggestions after a deploy read it instantly.
 */
export async function readGoogleAccount(admin: SupabaseClient, clientId: string, account: string, fresh = false) {
  return cachedRead<AccountRead>(admin, `google:${clientId}:${account}`, () => readAccount(admin, clientId, account), { clientId, fresh });
}

/** Starts reading the account a Google launch will need, before the launch itself is set up (never throws) */
export async function warmGoogleLaunch(admin: SupabaseClient, clientId: string, targetId: string | null) {
  if (!googleAdsConfigured()) return;
  const account = await accountFor(admin, clientId, targetId).catch(() => null);
  if (!account) return;
  await Promise.all([
    step(`google ${account}`, "warm-up read", readGoogleAccount(admin, clientId, account)).catch(() => undefined),
    step(`google ${account}`, "warm-up landing pages", import("@/lib/landing-pages").then((m) => m.findLandingPages(admin, clientId, { google: account }))).catch(() => undefined),
  ]);
}

/** What the launch is about, for ranking the landing pages: the request, the ad groups and keywords, the answers so far */
export function googleTheme(request: string, draft: GoogleDraft | null, questions: LaunchQuestion[]) {
  const d = draft ?? { adGroups: [], campaignNegatives: [], notes: [] };
  const answered = questions.filter((q) => ["ad_group", "keywords", "campaign"].includes(q.key) && q.answer).map((q) => q.answer);
  return [request, ...d.adGroups.flatMap((g) => [g.name, g.campaign, ...g.keywords.slice(0, 30).map((k) => k.text)]), ...answered].join(" ").slice(0, 4000);
}

/** The client's landing pages for a Google launch (kept a day), or null when they can't be read */
async function landingFor(admin: SupabaseClient, clientId: string, account: string): Promise<LandingSet | null> {
  const m = await import("@/lib/landing-pages");
  return m
    .findLandingPages(admin, clientId, { google: account })
    .then((s) => m.keepOnRun(s))
    .catch(() => null);
}

/** The account in a compact form for the Google Ads Buyer (a step that needs less gets less: lean for the questions) */
function accountText(r: GoogleResolution, o: { groups?: number; terms?: number; waste?: number; copy?: boolean } = {}) {
  const money = (x: number | null) => (x == null ? "?" : `$${Math.round(x)}`);
  const { groups = 120, terms = 25, waste = 15, copy = true } = o;
  // Kaizen's campaigns (and their ad groups) first: only those can be written to; the rest is context
  const camps = [...r.campaigns].sort((a, b) => Number(isKaizenName(b.name)) - Number(isKaizenName(a.name)));
  const kaizenIds = new Set(r.campaigns.filter((c) => isKaizenName(c.name)).map((c) => c.id));
  const adGroups = [...r.adGroups].sort((a, b) => Number(kaizenIds.has(b.campaignId)) - Number(kaizenIds.has(a.campaignId)));
  return [
    "CAMPAIGNS (id, type, status, bidding, daily budget, last 30 days; [Kaizen] ones can be launched into, the rest are context only)",
    ...camps.map((c) => `- ${c.id} "${c.name}" ${isKaizenName(c.name) ? "[Kaizen]" : "[not Kaizen's]"}${r.own?.includes(c.id) ? " [launched by Kaizen Ads]" : ""} ${c.type} ${c.status} ${c.bidding.toLowerCase()} ${money(c.budget)}/day · ${money(c.spend30)} spent, ${c.conversions30} conv${c.conversions30 ? ` ($${Math.round(c.spend30 / c.conversions30)}/conv)` : ""}`),
    "AD GROUPS (id, campaign, ads and their best ad strength)",
    ...adGroups.slice(0, groups).map((g) => `- ${g.id} "${g.name}" in "${g.campaign}"${kaizenIds.has(g.campaignId) ? "" : " [not Kaizen's]"} ${g.status}${g.rsas ? `, ${g.rsas} RSA${g.rsas === 1 ? "" : "s"}${g.strength ? ` (${g.strength.toLowerCase()})` : ""}` : ", no RSA"}`),
    ...(r.adGroups.length > groups ? [`(${r.adGroups.length - groups} more ad groups)`] : []),
    ...(r.assetGroups.length ? ["PERFORMANCE MAX ASSET GROUPS", ...r.assetGroups.slice(0, groups).map((a) => `- ${a.id} "${a.name}" in "${a.campaign}"${a.strength ? ` (${a.strength.toLowerCase()})` : ""}`)] : []),
    ...(terms ? ["SEARCHES THAT CONVERTED (90 days)", ...r.converting.slice(0, terms).map((t) => `- "${t.term}" (${t.campaign}): ${t.conversions} conv, $${t.spend}`)] : []),
    ...(waste ? ["SEARCHES SPENDING WITH NO CONVERSIONS (30 days)", ...r.waste.slice(0, waste).map((t) => `- "${t.term}" (${t.campaign}): $${t.spend}, ${t.clicks} clicks`)] : []),
    ...(copy ? ["COPY LIBRARY (this client's Google lines)", ...r.winners.map((l) => `- winner ${l}`), ...r.tired.map((l) => `- tired ${l}`)] : []),
  ].join("\n");
}

/** The paused campaigns built into as they are: the ones Kaizen Ads launched for this client */
const keepOf = (r: Pick<GoogleResolution, "own"> | null | undefined): ReadonlySet<string> => new Set(r?.own ?? []);

/** Answers settled before the launch was read (the campaign that was just launched), taken as given */
export function withPreset(questions: LaunchQuestion[], preset: Record<string, string> | null | undefined): LaunchQuestion[] {
  if (!preset) return questions;
  return questions.map((q) => (preset[q.key] ? { ...q, answer: preset[q.key] } : q));
}

/** The campaign types a launch can go into, for the comeback (keywords need Search; Performance Max only when asked) */
const launchTypes = (scopeType: CampaignType | null) => (scopeType === "PERFORMANCE_MAX" ? ["PERFORMANCE_MAX"] : ["SEARCH"]);

/** The launch's context (client, account history, related accounts), built once and kept on the run; null if it can't be */
async function launchContext(admin: SupabaseClient, clientId: string, account: string, res: Pick<GoogleResolution, "campaigns" | "scopeType">, theme: string, wait = 8000): Promise<LaunchContext | null> {
  const { buildLaunchContext } = await import("@/lib/launch-context");
  const built = step(`google ${account}`, "launch context", buildLaunchContext(admin, clientId, "google", account, { live: res.campaigns.map((c) => ({ id: c.id, name: c.name, status: c.status, type: c.type })), theme, types: launchTypes(res.scopeType) })).catch((e) => {
    console.error("[launch] google context:", msg(e));
    return null;
  });
  return Promise.race([built, new Promise<null>((r) => setTimeout(() => r(null), wait))]);
}

/** The run's context, built now (and kept) for a run from before it was kept */
async function ensureContext(admin: SupabaseClient, run: Run): Promise<LaunchContext | null> {
  if (!run.resolution || !run.account) return null;
  if (run.resolution.context) return run.resolution.context;
  const ctx = await launchContext(admin, run.client_id, run.account, run.resolution, googleTheme(run.resolution.request, run.sheet, run.questions));
  if (ctx) {
    run.resolution = { ...run.resolution, context: ctx, comeback: run.resolution.comeback ?? ctx.comeback };
    await patch(admin, run.id, { resolution: run.resolution });
  }
  return ctx;
}

/** The account as the "suggest more" step after a deploy reads it: the full picture and what's already in place */
export async function googleAccountForSuggestions(admin: SupabaseClient, clientId: string, account: string) {
  const { value } = await readGoogleAccount(admin, clientId, account);
  const res = { account, request: "", scopeType: null, ...value, suggestions: [], checks: [], at: now() } as GoogleResolution;
  return { text: accountText(res, { groups: 60, terms: 20, waste: 20 }), setup: value.setup.slice(0, 5000), facts: value.facts };
}

/** What was read, compact, for the model (ad groups by number, so the plan can point at one without retyping it) */
export function draftText(d: GoogleDraft, maxKw = 40) {
  return [
    ...d.adGroups.map((g, i) =>
      [
        `#${i} ad group "${g.name || "(no name)"}" in campaign "${g.campaign || "(not named)"}"${g.finalUrl ? ` · ${g.finalUrl}` : ""}`,
        `  keywords (${g.keywords.length}): ${g.keywords.slice(0, maxKw).map((k) => `${kwText(k)}${k.from === "default" ? "?" : ""}`).join(", ")}${g.keywords.length > maxKw ? " …" : ""}`,
        g.negatives.length ? `  negatives: ${g.negatives.map(kwText).join(", ")}` : "",
        ...g.rsas.map((r, j) => `  RSA ${j + 1}: ${r.headlines.length} headlines (${r.headlines.map((h) => `"${h.text}"${h.pin ? ` pin ${h.pin}` : ""}`).join(", ")}) · ${r.descriptions.length} descriptions (${r.descriptions.map((x) => `"${x.text}"`).join(", ")})${r.path1 ? ` · /${r.path1}${r.path2 ? `/${r.path2}` : ""}` : ""}`),
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    ...d.campaignNegatives.map((c) => `Campaign negatives for "${c.campaign || "every campaign"}": ${c.keywords.map(kwText).join(", ")}`),
    ...d.notes.map((x) => `Note: ${x}`),
  ].join("\n");
}

// ─── Reading and asking ─────────────────────────────────────────────────────────────────────────────────────────

const DRAFT_GROUP = obj({ campaign: S, name: S, finalUrl: S, keywords: arr(S), negatives: arr(S), headlines: arr(S), descriptions: arr(S), path1: S, path2: S });
type DraftOut = { campaign: string; name: string; finalUrl: string; keywords: string[]; negatives: string[]; headlines: string[]; descriptions: string[]; path1: string; path2: string };

/** The model's reading (of a sheet with an unusual layout, or the buyer's words) as a draft: keywords and pins parsed by code */
function draftFrom(out: DraftOut[], campaignNegatives: string[] = []): GoogleDraft {
  const groups: DraftAdGroup[] = out
    .map((g) => {
      const kws = g.keywords.map((k) => parseKeyword(k)).filter((k): k is NonNullable<typeof k> => Boolean(k));
      const heads = g.headlines.map((h) => parsePinned(h, 3)).filter((h) => h.text);
      const descs = g.descriptions.map((h) => parsePinned(h, 2)).filter((h) => h.text);
      return {
        campaign: g.campaign.trim(),
        name: g.name.trim(),
        finalUrl: /^https?:\/\//.test(g.finalUrl) ? g.finalUrl.trim() : "",
        keywords: uniqKeywords(kws.filter((k) => !k.negative).map((k) => ({ text: k.text, match: k.match, from: k.from }))),
        negatives: uniqKeywords([...kws.filter((k) => k.negative), ...g.negatives.map((k) => parseKeyword(k)).filter((k): k is NonNullable<typeof k> => Boolean(k))].map((k) => ({ text: k.text, match: k.match, from: k.from }))),
        rsas: heads.length || descs.length ? [{ headlines: heads, descriptions: descs, path1: g.path1.trim(), path2: g.path2.trim(), finalUrl: /^https?:\/\//.test(g.finalUrl) ? g.finalUrl.trim() : "" }] : [],
      };
    })
    .filter((g) => g.keywords.length || g.rsas.length || g.negatives.length);
  const negs = campaignNegatives.map((k) => parseKeyword(k)).filter((k): k is NonNullable<typeof k> => Boolean(k));
  return { adGroups: groups, campaignNegatives: negs.length ? [{ campaign: "", keywords: uniqKeywords(negs.map((k) => ({ text: k.text, match: k.match, from: k.from }))) }] : [], notes: [] };
}

/** A sheet whose columns weren't recognized: the Google Ads Buyer reads it, copying text exactly */
async function readSheetWithModel(clientId: string, name: string, text: string) {
  const out = await askJson<{ adGroups: DraftOut[]; campaignNegatives: string[]; notes: string[] }>({
    agent: "google_launcher",
    label: "google launch sheet read",
    clientId,
    // Copying text out of a table: the fast tier does it as well, in a fraction of the time
    override: { model: "sonnet", effort: "low" },
    system: `You read a Google Ads launch sheet a buyer shared: the keywords and ad copy to launch, in whatever layout they use. Read every ad group with its campaign (as the sheet names it, "" when it doesn't), its keywords and negatives exactly as written (keep [brackets] and "quotes": they're the match type; never add notation that isn't there), its RSA headlines and descriptions word for word (keep any pin written next to one, like "(pin 1)"), display paths and the final URL. Copy text exactly, even when it's over Google's limits: the checks flag it. campaignNegatives: negatives for the whole campaign. notes: anything ambiguous (copy you couldn't place, two ad groups with the same name, a column you couldn't read), one sentence each, at most 6.
${RULES}`,
    schema: obj({ adGroups: arr(DRAFT_GROUP), campaignNegatives: arr(S), notes: arr(S) }),
    maxTokens: 24000,
    prompt: `<sheet name="${name.replace(/"/g, "'")}">\n${text}\n</sheet>`,
  });
  const d = draftFrom(out.adGroups, out.campaignNegatives);
  return { ...d, notes: out.notes.slice(0, 6) };
}

const INTAKE = obj({ summary: S, wordsDraft: arr(DRAFT_GROUP), questions: arr(obj({ key: S, question: S, why: S, proposal: S, options: arr(S), required: B })) });

/** The fast tier for the steps someone is waiting on (the questions, each chat turn); the plan keeps the agent's own model */
const FAST = { model: "sonnet", effort: "low" } as const;

/** Short, plain lines for the card: what each piece of text the model writes must look like */
const SHORT = `Write for a narrow chat panel: short sentences, numbers first, no em dashes, no lists inside a sentence.`;

const count = (x: number) => x.toLocaleString("en-US");

/**
 * Reads what was shared and the account, then asks only what's missing. Background. The questions the launch needs
 * are worked out by code, so they're on the card (and answerable) as soon as the account is read; the Google Ads
 * Buyer then tailors them to the request and the account on the fast tier and they're merged in, keeping any answer
 * already given. Nothing account-wide is suggested here: that's offered after the launch is deployed (launch-more.ts).
 */
export async function prepareGoogleRun(admin: SupabaseClient, id: string) {
  const t0 = Date.now();
  const scope = `google run ${id.slice(0, 8)}`;
  const run = await load(admin, id);
  if (!run || !run.account) return;
  const account = run.account;
  const base = run.resolution as Partial<GoogleResolution> | null;
  const request = base?.request ?? "";
  let draft: GoogleDraft = { adGroups: [], campaignNegatives: [], notes: [] };
  let read = "";
  let res!: GoogleResolution;
  // The client's pages, for the landing-page question (usually warm: the chat started it with the account read)
  const pagesP = step(scope, "landing pages", landingFor(admin, run.client_id, account));
  try {
    if (!googleAdsConfigured()) throw new Error("Google Ads isn't connected yet (Settings, Sync health).");
    // The account read starts at once, alongside the sheet (and it's usually warm: the chat started it)
    const acctP = step(scope, "account read", readGoogleAccount(admin, run.client_id, account));
    acctP.catch(() => undefined);
    if (run.source.kind !== "words") {
      const source = run.source;
      await step(scope, "sheet read", async () => {
        const { openTabs } = await import("@/lib/launch-sheet/intake");
        const t = await openTabs(admin, source);
        if (!t.tabs.length) throw new Error(t.note ?? "The sheet couldn't be read.");
        const parsed = tabsToDraft(t.tabs);
        if (parsed.recognized && parsed.draft.adGroups.length) draft = parsed.draft;
        else {
          await patch(admin, id, { progress: "Reading the sheet's layout with the Google Ads Buyer" });
          draft = await readSheetWithModel(run.client_id, t.name, t.tabs.map((x) => `[tab "${x.title}"]\n${gridText(x.grid, 40_000)}`).join("\n\n").slice(0, 120_000));
        }
      });
      read = draftSummary(draft);
      await patch(admin, id, { sheet: draft, progress: `${read}. Reading the account` });
    }
    const { value: acct, cached } = await acctP;
    // The pages if they're already found; otherwise they join the questions once tailored, below
    const landing = await Promise.race([pagesP, new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
    const own = await ownGoogleCampaigns(admin, run.client_id).catch(() => [] as string[]);
    res = { account, request, scopeType: base?.scopeType ?? null, ...acct, suggestions: [], checks: [], at: now(), landing, own, preset: base?.preset ?? null };
    // What a master buyer knows walking in (the client, this account's history, the other platform), built once and
    // kept on the run: the comeback it finds decides the campaign question when no live Kaizen campaign fits
    const context = await launchContext(admin, run.client_id, account, res, googleTheme(request, draft, []));
    res.context = context;
    res.comeback = context?.comeback ?? null;
    const must = withPreset(googleQuestions(draft, res.campaigns, res.adGroups, `${request} ${run.source.kind !== "words" ? run.source.name : ""}`, res.scopeType, res.comeback, keepOf(res)), res.preset);
    res.checks = intakeChecks(draft, res);
    const live = res.campaigns.filter((c) => c.status === "ENABLED").length;
    const kaizenLive = res.campaigns.filter((c) => c.status === "ENABLED" && isKaizenName(c.name)).length;
    const facts = `${count(res.campaigns.length)} campaigns (${count(live)} live, ${count(kaizenLive)} of them Kaizen's), ${count(res.adGroups.length)} ad groups, ${count(res.inAccount.length)} keywords read${cached ? " (read in the last few minutes)" : ""}.`;
    const summary = [read ? `${read}.` : "", facts, ...draft.notes.map((x) => `Note: ${x}`)].filter(Boolean).join("\n\n");
    await patch(admin, id, { sheet: draft, resolution: res, summary, questions: followLanding(followCampaign(must, res.campaigns, res.adGroups, res.comeback, keepOf(res)), "final_url", landing, googleTheme(request, draft, must)), status: "asking", progress: "Tailoring the questions to the account", error: null });
    console.log(`[launch] ${scope} · questions on the card ${Date.now() - t0}ms`);
  } catch (e) {
    await patch(admin, id, { status: "failed", progress: null, error: msg(e).slice(0, 500) });
    return;
  }

  // ─── The Google Ads Buyer tailors the questions (fast tier, lean prompt), merged in without touching answers ───
  try {
    const must = withPreset(googleQuestions(draft, res.campaigns, res.adGroups, `${request} ${run.source.kind !== "words" ? run.source.name : ""}`, res.scopeType, res.comeback, keepOf(res)), res.preset);
    const out = await step(
      scope,
      "tailor questions (fast tier)",
      askJson<{ summary: string; wordsDraft: DraftOut[]; questions: Omit<LaunchQuestion, "answer">[] }>({
        agent: "google_launcher",
        label: "google launch intake",
        clientId: run.client_id,
        override: FAST,
        system: `You're the Google Ads buyer about to launch new ads into a client's live Google Ads account, from a buyer's request in chat${run.source.kind !== "words" ? " and the sheet they shared (already read: below)" : ""}. Nothing is planned or written yet. Stay on what they asked to launch: never bring up other campaigns' problems, tracking, conversion actions, sign-offs, Merchant Center or anything account-wide.
summary: 1 or 2 sentences, at most 35 words: what they want launched and the one fact in the account that matters most for it.
wordsDraft: ${run.source.kind !== "words" ? "[] (the sheet was read)." : "what the buyer wrote in their message, as ad groups: keywords exactly as written (keep [ ] and quotes, never add notation), headlines and descriptions word for word, final URL. [] when they only described what they want."}
questions: start from the required questions given (keep each key and its options; the campaign options are only live Kaizen campaigns that fit, the paused Kaizen one offered back when there is one, or a new Kaizen campaign). Rewrite each for this client and request: question at most 15 words, why one sentence of at most 15 words, proposal at most 12 words, every proposal the pick a senior buyer would make from <account_history>, <client_context> and <related_accounts> (a new campaign's budget from the monthly budget and its pacing, bidding from the target). Add a question only when something this launch needs is still open and only the buyer can decide it (a new campaign's daily budget, the places to show when the client context doesn't say, which ad groups the copy is for). Never ask what the request, the sheet, the account, its history or the client context already answers, never ask about paused creation or match types. At most 5.
${SHORT}
${RULES}`,
        schema: INTAKE,
        maxTokens: 4000,
        prompt: `<request>${request || "(shared a sheet to launch)"}</request>\n\n${draft.adGroups.length ? `<read>\n${draftText(draft, 25)}\n</read>\n\n` : ""}<account id="${account}">\n${accountText(res, { groups: 60, terms: 12, waste: 0, copy: false })}\n</account>\n\n${contextText(res.context)}\n\n<required_questions>\n${must.map((q) => `- ${q.key}: ${q.question} Proposal: ${q.proposal}. Options: ${q.options.join(" | ")}`).join("\n")}\n</required_questions>`,
      }),
    );
    if (run.source.kind === "words" && out.wordsDraft.length) {
      draft = draftFrom(out.wordsDraft);
      read = draft.adGroups.length ? draftSummary(draft) : "";
    }
    // The questions again from what's now read (the words may have answered some), the model's version of each kept
    const required = withPreset(googleQuestions(draft, res.campaigns, res.adGroups, request, res.scopeType, res.comeback, keepOf(res)), res.preset);
    const keys = new Set(required.map((q) => q.key));
    // Never a question about paused creation or match types (Kaizen's rules, not decisions), whatever the model wrote
    const fromModel = out.questions.filter((q) => !NOT_ASKED.test(`${q.key} ${q.question}`) && (keys.has(q.key) || !["campaign", "ad_group", "final_url", "keywords", "ads"].includes(q.key))).slice(0, 6);
    const latest = await load(admin, id);
    if (!latest) return;
    const summary = [read ? `${read}.` : "", out.summary, ...draft.notes.map((x) => `Note: ${x}`)].filter(Boolean).join("\n\n");
    // The buyer moved on (built the plan, set it aside) while this was writing: only the summary is updated
    if (latest.status !== "asking") {
      await patch(admin, id, { summary, progress: latest.progress === "Tailoring the questions to the account" ? null : latest.progress });
      return;
    }
    const questions = mergeQuestions(
      fromModel.map((q) => {
        const must1 = required.find((m) => m.key === q.key);
        // The campaign options always include the live ones that fit and a new one, whatever the model kept
        return { ...q, options: must1 ? [...new Set([...q.options, ...must1.options])].slice(0, 7) : q.options, answer: null };
      }),
      required,
      latest.questions,
    );
    const checks = intakeChecks(draft, res);
    const landing = (await pagesP) ?? latest.resolution?.landing ?? null;
    await patch(admin, id, {
      sheet: draft,
      resolution: { ...(latest.resolution ?? res), checks, landing },
      summary,
      questions: followLanding(followCampaign(questions, res.campaigns, res.adGroups, res.comeback, keepOf(res)), "final_url", landing, googleTheme(request, draft, questions)),
      progress: null,
    });
    console.log(`[launch] ${scope} · questions tailored ${Date.now() - t0}ms`);
  } catch (e) {
    // The questions from code are already on the card and answerable: only the tailoring is lost (the pages still join)
    console.error(`[launch] ${scope} · tailoring failed:`, msg(e));
    const landing = await pagesP;
    const latest = landing ? await load(admin, id) : null;
    if (latest?.resolution && latest.status === "asking") await patch(admin, id, { progress: null, resolution: { ...latest.resolution, landing }, questions: followLanding(latest.questions, "final_url", landing, googleTheme(request, draft, latest.questions)) });
    else await patch(admin, id, { progress: null });
  }
}

/**
 * What the read already shows about this launch, and only this launch (numbers first, one short line each): the
 * account in counts, copy against Google's limits, keywords that already run, ads short of lines, a missing landing
 * page, match types that weren't written.
 */
function intakeChecks(d: GoogleDraft, r: GoogleResolution): CheckItem[] {
  const out: CheckItem[] = [];
  const kaizen = r.campaigns.filter((c) => isKaizenName(c.name));
  out.push({ key: "account", label: "The account", level: "ok", detail: `${r.campaigns.filter((c) => c.status === "ENABLED").length} live campaigns (${kaizen.filter((c) => c.status === "ENABLED").length} Kaizen's) · ${r.adGroups.length} ad groups${r.assetGroups.length ? ` · ${r.assetGroups.length} asset groups` : ""}` });
  out.push({ key: "kaizen", label: "Kaizen's campaigns only", level: "info", detail: `Launches go into campaigns with Kaizen in the name, a paused Kaizen one brought back, or a new Kaizen campaign. The other ${r.campaigns.length - kaizen.length} are read for context only.` });
  if (r.comeback) out.push({ key: "comeback", label: "A paused Kaizen campaign to bring back", level: "info", detail: r.comeback.why });
  if (!d.adGroups.length) return out;
  const rsas = d.adGroups.flatMap((g) => g.rsas);
  const long = rsas.flatMap((x) => [...x.headlines.filter((h) => [...h.text].length > G.headline).map((h) => `"${h.text}" (${[...h.text].length}/30)`), ...x.descriptions.filter((h) => [...h.text].length > G.description).map((h) => `a ${[...h.text].length}/90 description`)]);
  out.push(long.length ? { key: "limits", label: `${long.length} over Google's limits`, level: "warn", detail: `${long.slice(0, 3).join(", ")}${long.length > 3 ? "…" : ""}`, fix: "Fix them on the plan card (Fix what I can), or send shorter ones." } : { key: "limits", label: "Copy limits", level: "ok", detail: "Every headline and description fits." });
  const inAcc = new Set(r.inAccount);
  const dup = d.adGroups.flatMap((g) => g.keywords).filter((k) => inAcc.has(kwKey(k)));
  if (dup.length) out.push({ key: "dupes", label: `${dup.length} keyword${dup.length === 1 ? " already runs" : "s already run"}`, level: "warn", detail: `${dup.slice(0, 4).map(kwText).join(", ")}${dup.length > 4 ? "…" : ""}`, fix: "Leave them out, or keep them only if this ad group should take those searches over." });
  const few = rsas.filter((x) => x.headlines.length < G.headlinesMin || x.descriptions.length < G.descriptionsMin).length;
  if (few) out.push({ key: "rsa_counts", label: `${few} ad${few === 1 ? "" : "s"} short of lines`, level: "warn", detail: "Google needs at least 3 headlines and 2 descriptions." });
  const noUrl = d.adGroups.filter((g) => !g.finalUrl && !g.rsas.some((x) => x.finalUrl)).length;
  if (noUrl) out.push({ key: "final_url", label: `${noUrl} ad group${noUrl === 1 ? "" : "s"} without a landing page`, level: "warn", detail: "I'll ask for the final URL." });
  const guessed = d.adGroups.flatMap((g) => g.keywords).filter((k) => k.from === "default").length;
  if (guessed) out.push({ key: "match", label: `${guessed} keyword${guessed === 1 ? "" : "s"} as phrase match`, level: "info", detail: "Written without [ ] or quotes, so they go in as phrase match (Kaizen's default). Change any on the preview." });
  return out;
}

// ─── The conversation ───────────────────────────────────────────────────────────────────────────────────────────

const REPLY = obj({ answer: S, asks: S, answers: arr(obj({ key: S, answer: S })), newQuestions: arr(obj({ key: S, question: S, why: S, proposal: S, options: arr(S), required: B })), build: B, offTopic: B, setAside: B });

/** How the launch chat treats a short "yes" and what it never asks (shared by Google and Meta) */
export const YES_RULE = `A short "yes" (or "sure", "sounds good", "go with that") answers ONLY the question your last message asked, with the proposal you made in it: never any other question. asks: the key of the ONE question your answer asks now ("" when it asks nothing).`;

/**
 * The launch as it really is, for every reply about it (so the chat never contradicts the card): its status, what's
 * planned, what was created and what the read-back found.
 */
export function launchStateText(run: { status: RunStatus; plan: GooglePlan | null; qa?: GoogleQa | null; account: string | null }) {
  const created = ["applied", "partial"].includes(run.status);
  const camp = run.plan?.campaigns[0] ?? null;
  const link = created && run.qa?.ids && camp ? googleDeepLink(run.account ?? "", "campaign", { campaignId: run.qa.ids[`campaign:${camp.key}`] ?? camp.existingId }) : null;
  return [
    `Status: ${run.status}${created ? " (created in Google Ads, paused: never say nothing is created)" : run.status === "ready" ? " (planned and checked, nothing created until Deploy is pressed on the card)" : " (nothing created yet)"}.`,
    run.plan ? `Plan: ${planText(run.plan).slice(0, 1500)}` : "",
    run.qa?.summary ? run.qa.summary : "",
    link ? `Open in Google Ads: ${link}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** "It's paused" said at most once in a conversation: later mentions are taken out of the reply */
export function pausedOnce(text: string, earlier: { role: string; text: string }[]) {
  const said = earlier.some((t) => t.role === "assistant" && /\bpaused\b/i.test(t.text) && /\b(nothing|won'?t|doesn'?t|isn'?t)\b[^.]*\b(run|spend|live)/i.test(t.text));
  if (!said) return text;
  const out = text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !(/\bpaused\b/i.test(s) && /\b(nothing|won'?t|doesn'?t|isn'?t)\b[^.]*\b(run|spend|live)/i.test(s)))
    .join(" ")
    .trim();
  return out || text;
}

/**
 * Every open question answered with its proposal (the campaign first, so the ad group follows it): "just build it",
 * a frustrated buyer, or a "yes" to the whole plan proposed.
 */
export function acceptAll(questions: LaunchQuestion[], follow: (q: LaunchQuestion[]) => LaunchQuestion[]): LaunchQuestion[] {
  let qs = questions;
  for (let pass = 0; pass < 3; pass++) {
    const open = qs.filter((q) => !q.answer && q.proposal.trim() && !/^pick the campaign first$/i.test(q.proposal.trim()));
    if (!open.length) break;
    // The campaign first: the ad group's options and proposal depend on it
    const first = open.find((q) => q.key === "campaign");
    qs = follow(applyAnswers(qs, (first ? [first] : open).map((q) => ({ key: q.key, answer: q.proposal }))));
  }
  return qs;
}

/** The buyer's message about the launch: answers taken in, the plan built when asked. Fast tier: someone is waiting. */
export async function googleLaunchReply(admin: SupabaseClient, id: string, message: string): Promise<{ answer: string; offTopic: boolean; building: boolean }> {
  const run = await load(admin, id);
  if (!run?.resolution) return { answer: "", offTopic: true, building: false };
  const context = await ensureContext(admin, run);
  const comeback = run.resolution.comeback ?? null;
  const lastSaid = [...run.turns].reverse().find((t) => t.role === "assistant") ?? null;
  // The campaigns Kaizen Ads launched here: built into as they are, paused or not (fresh: one may have just been)
  const own = await ownGoogleCampaigns(admin, run.client_id).catch(() => run.resolution?.own ?? []);
  run.resolution = { ...run.resolution, own };
  const keep = keepOf(run.resolution);
  // "Just build it", a frustrated or repeating buyer, or a "yes" to the whole plan proposed: every proposal taken
  const hurry = frustrated(
    message,
    run.turns.filter((t) => t.role === "user").map((t) => t.text),
  );
  const all = wantsEverything(message) || hurry || (lastSaid?.asks === "all" && SHORT_YES.test(message));
  // The client's pages, so a page named in words ("the homepage") is answered with its link (a run from before they
  // were found reads them now: kept a day, so usually at once)
  const landing = run.resolution.landing ?? (run.account ? await landingFor(admin, run.client_id, run.account) : null);
  const theme = googleTheme(run.resolution.request, run.sheet, run.questions);
  const asksUrl = run.questions.some((q) => q.key === "final_url");
  const { data: qaRow } = await admin.from("launch_runs").select("qa").eq("id", id).maybeSingle();
  const state = launchStateText({ status: run.status, plan: run.plan, qa: (qaRow?.qa as GoogleQa | null) ?? null, account: run.account });
  const out = await step(
    `google run ${id.slice(0, 8)}`,
    "chat turn (fast tier)",
    askJson<{ answer: string; asks: string; answers: { key: string; answer: string }[]; newQuestions: Omit<LaunchQuestion, "answer">[]; build: boolean; offTopic: boolean; setAside: boolean }>({
      agent: "google_launcher",
      label: "google launch chat",
      clientId: run.client_id,
      override: FAST,
      system: `You're the Google Ads buyer in a conversation with the buyer about launching new ads into the client's Google Ads account. What was read, your questions (with what's answered), the launch's real state and the conversation are below. Stage: ${run.status}. Stay on this launch: nothing account-wide (that's offered after it's deployed). Everything you say about whether something exists must match <launch_state>.
answers: the questions the buyer's message answers, by key, in their words made exact and in the format Google needs (keywords with their notation, a daily budget in dollars, the full final URL, places as the buyer said them: "United States excluding Hawaii and Alaska"). When they accept your proposal ("yes", "go with that"), the answer is the proposal your last message made, written out. When they give keywords or copy, the answer holds them word for word. Only what they actually said or accepted.
${YES_RULE} When your last message proposed the whole plan and asked "Build it?", asks was "all" and a "yes" takes every proposal.
newQuestions: only when their answer opens something the plan needs and only the buyer can decide it (question at most 15 words, why one short sentence). Never about paused creation or match types.
build: true when they ask to build, see or redo the plan, or say go ahead, or (stage ready) ask for a change to the plan. The plan is only built once every required question is answered; if some aren't, say which.
answer: ${
        all
          ? `the buyer wants it built now${hurry ? " and is out of patience" : ""}: ask nothing. One sentence, under 30 words, saying exactly what you're building (campaign, ad groups, keywords, ads, places), no apology, no caveats.`
          : `talk like a senior media buyer a colleague just walked up to: natural and brief, under 60 words. While decisions are open, propose ALL of them in one message with your pick for each (campaign, ad groups, the landing page per ad group, keywords per ad group, one ad per ad group from the winners and the Brand Bible, places from where the client ships or serves, the budget if given), then ask once "Build it?" (asks "all"). Ask about something on its own only when you genuinely have no pick (usually only a new campaign's budget), at most two such questions. Your picks come from <account_history>, <client_context> and <related_accounts>: what converts, the target, the budget pacing, what the audit and sprint said; never suggest what they show doesn't work. Only one campaign at a time, and only a Kaizen one, the paused Kaizen one offered back (say its number) or a new Kaizen campaign. No lists or bullets, no reasoning, rules or caveats unless they ask why or something would break. Push back in a sentence when something works against the client's results or the platform's rules. When the stage is "ready" and they say go ahead, tell them to press Deploy on the launch card (it checks the client's Google switch and who may deploy); build stays false.`
      }
offTopic: true when the message isn't about this launch (answer ""). setAside: true when they say to stop or park it.
${asksUrl ? `${landingRule("final_url")}\n` : ""}${SHORT}
${RULES}`,
      schema: REPLY,
      maxTokens: 3000,
      prompt: `<launch_state>\n${state}\n</launch_state>\n\n${contextText(context)}\n\n<read>\n${run.sheet ? draftText(run.sheet, 25) : "(nothing yet)"}\n</read>\n\n${asksUrl ? `<landing_pages site="${landing?.site ?? ""}">\n${pagesText(landing, theme, 15)}\n</landing_pages>\n\n` : ""}${comeback ? `<comeback>${comeback.why}</comeback>\n\n` : ""}${own.length ? `<launched_by_kaizen_ads>${run.resolution.campaigns.filter((c) => own.includes(c.id)).map((c) => `"${c.name}" (${c.status.toLowerCase()})`).join(", ") || own.join(", ")}: build into these as they are, paused or not</launched_by_kaizen_ads>\n\n` : ""}<last_question_asked>${lastSaid ? `${lastSaid.asks ? `${lastSaid.asks}: ` : ""}${lastSaid.text.slice(-400)}` : "(none yet)"}</last_question_asked>\n\n<questions>\n${run.questions.map((q) => `- ${q.key}${q.required ? " (required)" : ""}: ${q.question} Proposal: ${q.proposal}. ${q.answer ? `ANSWERED: ${q.answer}` : "Not answered yet."}`).join("\n")}\n</questions>\n\n${run.plan ? `<plan>\n${planText(run.plan)}\n</plan>\n\n` : ""}<conversation>\n${run.turns
        .slice(-12)
        .map((t) => `${t.role === "user" ? "Buyer" : "You"}: ${t.text}`)
        .join("\n")}\n</conversation>\n\nThe buyer says: ${message.slice(0, 3000)}`,
    }),
  );
  if (out.offTopic && !all) return { answer: "", offTopic: true, building: false };
  // A short "yes" answers only the question just asked (never paused creation, a match type or anything else), unless
  // the last message proposed the whole plan
  if (!all) out.answers = yesOnlyAnswersAsked(message, out.answers, run.questions, lastSaid);
  let questions = applyAnswers(run.questions, out.answers);
  if (out.newQuestions.length && !all) questions = mergeQuestions(out.newQuestions.filter((q) => !NOT_ASKED.test(`${q.key} ${q.question}`)).map((q) => ({ ...q, answer: null })), [], questions);
  // The buyer insisting on a paused Kaizen campaign (named in this message or the campaign answer) keeps it as it is
  const campaignGiven = out.answers.find((a) => a.key === "campaign")?.answer ?? null;
  const insisted = [...campaignsNamed(message, run.resolution.campaigns), ...(KEEP_PAUSED.test(campaignGiven ?? "") ? campaignsNamed(campaignGiven, run.resolution.campaigns) : [])].filter((c) => isKaizenName(c.name));
  const keepNow = new Set([...keep, ...insisted.map((c) => c.id)]);
  const follow = (qs: LaunchQuestion[]) => followCampaign(qs, run.resolution!.campaigns, run.resolution!.adGroups, comeback, keepNow);
  questions = follow(questions);
  // A campaign answer that wasn't taken (Kaizen didn't set it up, two named): that's what's said, never twice
  let refused = campaignGiven && !questions.find((q) => q.key === "campaign")?.answer ? campaignRefusal(campaignGiven, run.resolution.campaigns, comeback, keepNow) : null;
  if (refused && lastSaid?.text.trim() === refused.trim()) refused = null;
  // The landing page as a real link: a page named in words taken from the list, a typed link checked
  const { settleLanding } = await import("@/lib/landing-pages");
  const settled = await settleLanding(questions, "final_url", landing, message, out.answers.some((a) => a.key === "final_url"));
  questions = followLanding(settled.questions, "final_url", landing, googleTheme(run.resolution.request, run.sheet, settled.questions));
  if (all) questions = acceptAll(questions, follow);
  // Code took the page the chat asked a link for: its words would contradict the card, so the note replaces them
  const raw = refused ?? scrubPaused(settled.took && ASKS_FOR_LINK.test(out.answer) ? (settled.note ?? "") : [out.answer, settled.note].filter(Boolean).join(" "));
  const said = pausedOnce(raw, run.turns);
  const answers = out.answers.filter((a) => a.key !== "campaign" || !refused).length + (settled.took ? 1 : 0) + (all ? 1 : 0);
  const asks = refused ? "campaign" : out.asks === "all" ? "all" : out.asks && questions.some((q) => q.key === out.asks && !q.answer) ? out.asks : askedKey(questions, { text: said });
  const turns = [...run.turns, { role: "user" as const, text: message.slice(0, 3000), at: now() }, { role: "assistant" as const, text: said, at: now(), asks }].slice(-40);
  const resolution = { ...run.resolution, ...(landing && !run.resolution.landing ? { landing } : {}) };
  if (out.setAside) {
    await patch(admin, id, { questions, turns, status: "set_aside" });
    return { answer: out.answer || "Set aside. Nothing was created.", offTopic: false, building: false };
  }
  const open = unanswered(questions);
  // Chat first: once a reply leaves nothing required open, the preview is built (they don't have to say "build it")
  const building = !open.length && (out.build || answers > 0) && (run.status === "asking" || answers > 0);
  const answer = (out.build || all) && open.length ? `${said}\n\nBefore I can plan it I still need: ${open.map((q) => q.question).join(" ")}` : said;
  const changed = answers > 0 && ["ready", "failed"].includes(run.status);
  await patch(admin, id, { questions, turns, resolution, ...(building ? { status: "planning", progress: "Laying out the plan" } : changed ? { status: "asking" } : {}) });
  return { answer, offTopic: false, building };
}

/** The proposals taken (or the option the buyer clicked), from the card */
export async function acceptGoogleProposals(admin: SupabaseClient, id: string, keys: string[], chosen: Record<string, string> = {}) {
  const run = await load(admin, id);
  if (!run) return;
  const questions = applyAnswers(
    run.questions,
    run.questions.filter((q) => keys.includes(q.key) && !q.answer).map((q) => ({ key: q.key, answer: chosen[q.key] && q.options.includes(chosen[q.key]) ? chosen[q.key] : q.proposal })),
  );
  // The landing pages offered follow the ad group and keywords just chosen
  await patch(admin, id, { questions: run.resolution ? followLanding(followCampaign(questions, run.resolution.campaigns, run.resolution.adGroups, run.resolution.comeback ?? null, keepOf(run.resolution)), "final_url", run.resolution.landing, googleTheme(run.resolution.request, run.sheet, questions)) : questions });
}

/** A suggestion taken or skipped on the card */
export async function setGoogleSuggestion(admin: SupabaseClient, id: string, key: string, accepted: boolean | null) {
  const run = await load(admin, id);
  if (!run?.resolution) return;
  await patch(admin, id, { resolution: { ...run.resolution, suggestions: run.resolution.suggestions.map((s) => (s.key === key ? { ...s, accepted } : s)) } });
}

// ─── The plan ───────────────────────────────────────────────────────────────────────────────────────────────────

// Kept flat on purpose: nested objects, enums and per-line pins make the structured-output grammar too large for the
// API ("compiled grammar is too large"). Strings carry the detail (pins as "(pin 1)", sitelinks as "text | line 1 |
// line 2 | url", snippets as "Header: a, b") and code turns them back into the exact plan below.
const PLAN = obj({
  note: S,
  campaigns: arr(
    obj({ key: S, mode: S, existingId: S, name: S, type: S, budget: N, bidding: S, targetCpa: N, targetRoas: N, locations: arr(S), negatives: arr(S), sitelinks: arr(S), callouts: arr(S), snippets: arr(S) }),
  ),
  adGroups: arr(obj({ key: S, campaignKey: S, mode: S, existingId: S, name: S, fromRead: I, finalUrl: S, keywords: arr(S), negatives: arr(S), rsas: arr(obj({ headlines: arr(S), descriptions: arr(S), path1: S, path2: S, finalUrl: S })) })),
  assetGroups: arr(obj({ key: S, campaignKey: S, existingId: S, name: S, finalUrl: S, headlines: arr(S), longHeadlines: arr(S), descriptions: arr(S), searchThemes: arr(S), byHand: arr(S) })),
});
type RawPlan = {
  note: string;
  campaigns: { key: string; mode: string; existingId: string; name: string; type: string; budget: number; bidding: string; targetCpa: number; targetRoas: number; locations: string[]; excludedLocations: string[]; negatives: string[]; sitelinks: string[]; callouts: string[]; snippets: string[] }[];
  adGroups: { key: string; campaignKey: string; mode: string; existingId: string; name: string; fromRead: number; finalUrl: string; keywords: string[]; negatives: string[]; rsas: { headlines: string[]; descriptions: string[]; path1: string; path2: string; finalUrl: string }[] }[];
  assetGroups: GoogleProposal["assetGroups"];
};
const strs = (x: unknown) => (Array.isArray(x) ? x.filter((y) => typeof y === "string" || typeof y === "number").map(String) : []);
const str = (x: unknown) => (typeof x === "string" ? x : x == null ? "" : String(x));
const numOf = (x: unknown, d = 0) => (Number.isFinite(Number(x)) && x !== "" && x != null ? Number(x) : d);
const list = (x: unknown) => (Array.isArray(x) ? x.filter((y): y is Record<string, unknown> => Boolean(y) && typeof y === "object") : []);
/** Every key the plan needs, with an empty value where the answer left one out */
export function rawPlanOf(x: unknown): RawPlan {
  const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  return {
    note: str(o.note),
    campaigns: list(o.campaigns).map((c) => ({
      key: str(c.key), mode: str(c.mode), existingId: str(c.existingId), name: str(c.name), type: str(c.type), budget: numOf(c.budget), bidding: str(c.bidding),
      // Places left out come as "-Hawaii" in locations (kept out of the answer format to keep it small)
      targetCpa: numOf(c.targetCpa), targetRoas: numOf(c.targetRoas),
      locations: strs(c.locations).filter((l) => !/^\s*-/.test(l)).map((l) => l.trim()).filter(Boolean),
      excludedLocations: [...strs(c.excludedLocations), ...strs(c.locations).filter((l) => /^\s*-/.test(l)).map((l) => l.replace(/^\s*-\s*/, "").trim())].filter(Boolean),
      negatives: strs(c.negatives), sitelinks: strs(c.sitelinks), callouts: strs(c.callouts), snippets: strs(c.snippets),
    })),
    adGroups: list(o.adGroups).map((g) => ({
      key: str(g.key), campaignKey: str(g.campaignKey), mode: str(g.mode), existingId: str(g.existingId), name: str(g.name), fromRead: numOf(g.fromRead, -1),
      finalUrl: str(g.finalUrl), keywords: strs(g.keywords), negatives: strs(g.negatives),
      rsas: list(g.rsas).map((a) => ({ headlines: strs(a.headlines), descriptions: strs(a.descriptions), path1: str(a.path1), path2: str(a.path2), finalUrl: str(a.finalUrl) })),
    })),
    assetGroups: list(o.assetGroups).map((a) => ({
      key: str(a.key), campaignKey: str(a.campaignKey), existingId: str(a.existingId), name: str(a.name), finalUrl: str(a.finalUrl),
      headlines: strs(a.headlines), longHeadlines: strs(a.longHeadlines), descriptions: strs(a.descriptions), searchThemes: strs(a.searchThemes), byHand: strs(a.byHand),
    })) as RawPlan["assetGroups"],
  };
}
const BIDDINGS: Bidding[] = ["MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE", "MAXIMIZE_CLICKS", "MANUAL_CPC"];
/** The flat answer turned back into the plan's shape: modes, types and biddings checked, pins and assets parsed */
export function proposalFrom(given: RawPlan): GoogleProposal {
  const r = rawPlanOf(given);
  const mode = (m: string): "new" | "existing" => (/exist/i.test(m) ? "existing" : "new");
  const lines = (xs: string[], max: 2 | 3) =>
    xs.map((x) => {
      const l = parsePinned(x, max);
      return { text: l.text, pin: l.pin };
    });
  return {
    note: r.note,
    campaigns: r.campaigns.map((c) => {
      const b = String(c.bidding || "").toUpperCase().replace(/[\s-]+/g, "_");
      return {
        ...c,
        mode: mode(c.mode),
        type: /performance|pmax/i.test(c.type) ? "PERFORMANCE_MAX" : "SEARCH",
        bidding: (BIDDINGS.find((x) => x === b) ?? "MAXIMIZE_CONVERSIONS") as Bidding,
        sitelinks: c.sitelinks
          .map((x) => x.split("|").map((y) => y.trim()))
          .filter((p) => p[0])
          .map((p) => ({ text: p[0], line1: p[1] ?? "", line2: p[2] ?? "", url: p.find((y) => /^https?:\/\//i.test(y)) ?? "" })) as GCampaign["sitelinks"],
        snippets: c.snippets
          .map((x) => {
            const i = x.indexOf(":");
            return i > 0 ? { header: x.slice(0, i).trim(), values: x.slice(i + 1).split(",").map((v) => v.trim()).filter(Boolean) } : null;
          })
          .filter((x): x is { header: string; values: string[] } => Boolean(x && x.values.length)) as GCampaign["snippets"],
      };
    }),
    adGroups: r.adGroups.map((g) => ({ ...g, mode: mode(g.mode), rsas: g.rsas.map((a) => ({ ...a, headlines: lines(a.headlines, 3), descriptions: lines(a.descriptions, 2) })) })),
    assetGroups: r.assetGroups,
  };
}
type ProposalCampaign = { key: string; mode: "new" | "existing"; existingId: string; name: string; type: CampaignType; budget: number; bidding: Bidding; targetCpa: number; targetRoas: number; locations: string[]; excludedLocations?: string[]; negatives: string[]; sitelinks: GCampaign["sitelinks"]; callouts: string[]; snippets: GCampaign["snippets"] };
type ProposalAdGroup = { key: string; campaignKey: string; mode: "new" | "existing"; existingId: string; name: string; fromRead: number; finalUrl: string; keywords: string[]; negatives: string[]; rsas: { headlines: { text: string; pin: number }[]; descriptions: { text: string; pin: number }[]; path1: string; path2: string; finalUrl: string }[] };
export type GoogleProposal = { note: string; campaigns: ProposalCampaign[]; adGroups: ProposalAdGroup[]; assetGroups: (Omit<GooglePlan["assetGroups"][number], "mode" | "existingId"> & { existingId: string })[] };

const kws = (list: string[], fallback: Kw["match"] = "PHRASE"): Kw[] =>
  uniqKeywords(
    list
      .map((k) => parseKeyword(k, null, fallback))
      .filter((k): k is NonNullable<typeof k> => Boolean(k))
      .map((k) => ({ text: k.text, match: k.match, from: k.from })),
  );
const pin = (p: number, max: number) => (Number.isInteger(p) && p >= 1 && p <= max ? p : 0) as 0 | 1 | 2 | 3;

/**
 * The model's structure turned into the plan, with everything exact filled in by code: an ad group built from the read
 * takes its keywords, negatives and copy straight from it (never retyped by a model), ids are only ones the account
 * has, locations are Google's own. Returns what didn't add up.
 */
export function buildGooglePlan(
  p: GoogleProposal,
  ctx: {
    account: string;
    draft: GoogleDraft;
    res: Pick<GoogleResolution, "campaigns" | "adGroups" | "assetGroups">;
    finalUrl: string | null;
    /** Google's places for names the plan used (lower case), from suggestGeo */
    locations: Map<string, { geo: string; name: string }>;
    /** Where the buyer said to show it, in their words (the locations answer) */
    locationAsk?: string | null;
    revive?: string | null;
    /** A paused campaign built into as it is (launched by Kaizen Ads, or the buyer insisted) */
    keepPaused?: ReadonlySet<string>;
  },
): { plan: GooglePlan; warnings: string[] } {
  const warnings: string[] = [];
  const keepPaused = ctx.keepPaused ?? new Set<string>();
  // A new campaign's places: the buyer's words, else the plan's list; what doesn't resolve is kept so the deploy is
  // blocked (never shown in every country by accident)
  const placesFor = (c: ProposalCampaign | null): Pick<GCampaign, "locations" | "excludedLocations" | "locationAsk" | "unresolvedPlaces"> => {
    if (!c) return { locations: [] };
    const r = campaignPlaces(ctx.locationAsk ?? null, c.locations, c.excludedLocations ?? [], ctx.locations);
    return { locations: r.locations, excludedLocations: r.excluded, locationAsk: r.ask, unresolvedPlaces: r.unresolved };
  };
  // How the account names its Kaizen campaigns (and whether its ad groups carry Kaizen too), for every new name
  const kaizenCampaigns = ctx.res.campaigns.filter((c) => isKaizenName(c.name));
  const kaizenIds = new Set(kaizenCampaigns.map((c) => c.id));
  const examples = kaizenCampaigns.map((c) => c.name);
  const groupNames = ctx.res.adGroups.filter((g) => kaizenIds.has(g.campaignId)).map((g) => g.name);
  const groupsKaizen = childrenNamedKaizen(groupNames);
  const campaigns: GCampaign[] = p.campaigns.map((c) => {
    let live = c.mode === "existing" ? ctx.res.campaigns.find((x) => x.id === digits(c.existingId)) : null;
    if (c.mode === "existing" && !live) warnings.push(`"${c.name}" isn't a campaign in the account, so it's planned as a new one.`);
    // Kaizen never writes into a campaign it didn't set up: planned as a new Kaizen campaign instead
    if (live && !isKaizenName(live.name)) {
      warnings.push(`"${live.name}" wasn't set up by Kaizen, so it isn't touched: planned as a new Kaizen campaign instead (set its budget).`);
      live = null;
    }
    const revive = Boolean(live && live.status !== "ENABLED" && ctx.revive === live.id);
    if (live && live.status !== "ENABLED" && !revive) warnings.push(`"${live.name}" is paused${keepPaused.has(live.id) ? " (kept as it is)" : ""}: nothing added there runs until it's turned on.`);
    const type: CampaignType = live ? (live.type === "PERFORMANCE_MAX" ? "PERFORMANCE_MAX" : "SEARCH") : c.type;
    return {
      key: c.key,
      mode: live ? "existing" : "new",
      existingId: live?.id ?? null,
      ...(revive ? { revive: true } : {}),
      // A new campaign always has Kaizen in its name, the way the account writes it
      name: live?.name ?? withKaizen(c.name.trim() || "Search", examples),
      type,
      budget: live ? live.budget : c.budget > 0 ? Math.round(c.budget * 100) / 100 : null,
      bidding: c.bidding,
      targetCpa: c.targetCpa > 0 ? c.targetCpa : null,
      targetRoas: c.targetRoas > 0 ? c.targetRoas : null,
      ...placesFor(live ? null : c),
      negatives: kws(c.negatives),
      sitelinks: c.sitelinks.filter((s) => s.text.trim()),
      callouts: c.callouts.map((x) => x.trim()).filter(Boolean),
      snippets: c.snippets.filter((s) => s.header.trim() && s.values.length),
    };
  });
  for (const c of campaigns) if (c.mode === "new" && c.unresolvedPlaces?.length) warnings.push(`Couldn't resolve "${c.locationAsk}" as places Google knows (${c.unresolvedPlaces.map((m) => `"${m}"`).join(", ")}): it won't deploy until the places are fixed.`);
  const adGroups: GAdGroup[] = [];
  for (const g of p.adGroups) {
    let live = g.mode === "existing" ? ctx.res.adGroups.find((x) => x.id === digits(g.existingId)) : null;
    if (g.mode === "existing" && !live) warnings.push(`"${g.name}" isn't an ad group in the account, so it's planned as a new one.`);
    // An ad group in a campaign Kaizen didn't set up is never added to: a new ad group instead
    if (live && !kaizenIds.has(live.campaignId)) {
      warnings.push(`"${live.name}" is in "${live.campaign}", which Kaizen didn't set up, so it's planned as a new ad group.`);
      live = null;
    }
    let campaignKey = g.campaignKey;
    if (live) {
      // An existing ad group sits in its own campaign, whatever the model said
      const c = campaigns.find((x) => x.existingId === live.campaignId);
      if (c) campaignKey = c.key;
      else {
        const lc = ctx.res.campaigns.find((x) => x.id === live.campaignId);
        campaignKey = `c${campaigns.length + 1}`;
        campaigns.push({ key: campaignKey, mode: "existing", existingId: live.campaignId, ...(lc && lc.status !== "ENABLED" && ctx.revive === lc.id ? { revive: true } : {}), name: lc?.name ?? live.campaign, type: "SEARCH", budget: lc?.budget ?? null, bidding: "MAXIMIZE_CONVERSIONS", targetCpa: null, targetRoas: null, locations: [], negatives: [], sitelinks: [], callouts: [], snippets: [] });
      }
    }
    const read = g.fromRead >= 0 ? ctx.draft.adGroups[g.fromRead] : undefined;
    const fallbackUrl = g.finalUrl.trim() || read?.finalUrl || ctx.finalUrl || "";
    const rsas: Rsa[] = [
      ...(read?.rsas ?? []).map((r) => ({ ...r, headlines: r.headlines.map((h) => ({ ...h })), descriptions: r.descriptions.map((d) => ({ ...d })) })),
      ...g.rsas.map((r) => ({ headlines: r.headlines.map((h) => ({ text: h.text.trim(), pin: pin(h.pin, 3) })).filter((h) => h.text), descriptions: r.descriptions.map((h) => ({ text: h.text.trim(), pin: pin(h.pin, 2) })).filter((h) => h.text), path1: r.path1.trim(), path2: r.path2.trim(), finalUrl: r.finalUrl.trim() })),
    ]
      .filter((r) => r.headlines.length || r.descriptions.length)
      .map((r, i) => ({ ...r, key: `r${i + 1}`, finalUrl: r.finalUrl || fallbackUrl }));
    adGroups.push({
      key: g.key,
      campaignKey,
      mode: live ? "existing" : "new",
      existingId: live?.id ?? null,
      // New ad groups carry Kaizen too when the account's Kaizen ad groups do
      name: live?.name ?? (groupsKaizen ? withKaizen(g.name.trim() || read?.name || "New ad group", groupNames) : g.name.trim() || read?.name || "New ad group"),
      keywords: uniqKeywords([...(read?.keywords ?? []), ...kws(g.keywords)]),
      negatives: uniqKeywords([...(read?.negatives ?? []), ...kws(g.negatives)]),
      rsas,
    });
  }
  for (const c of campaigns) if (c.revive) warnings.push(`"${c.name}" is turned back on when you deploy, so its own ad groups run again. Everything new in it is created paused for you to switch on.`);
  // Campaign negatives from the sheet: onto the campaign it names, or the first one when it names none
  for (const cn of ctx.draft.campaignNegatives) {
    const c = campaigns.find((x) => cn.campaign && x.name.toLowerCase() === cn.campaign.toLowerCase()) ?? campaigns[0];
    if (c) c.negatives = uniqKeywords([...c.negatives, ...cn.keywords]);
  }
  const assetGroups = p.assetGroups.map((a) => {
    const live = ctx.res.assetGroups.find((x) => x.id === digits(a.existingId));
    const c = live ? campaigns.find((x) => x.existingId === live.campaignId) : campaigns.find((x) => x.key === a.campaignKey);
    return { ...a, campaignKey: c?.key ?? a.campaignKey, mode: live ? ("existing" as const) : ("new" as const), existingId: live?.id ?? null, name: live?.name ?? a.name };
  });
  // Every ad group reached from the read is in the plan, or the buyer is told it was left out
  const used = new Set(p.adGroups.map((g) => g.fromRead));
  ctx.draft.adGroups.forEach((g, i) => !used.has(i) && warnings.push(`"${g.name || `Ad group ${i + 1}`}" from what was read isn't in the plan.`));
  return { plan: { account: ctx.account, campaigns, adGroups, assetGroups, note: p.note }, warnings };
}

/** The plan in words, for the model and the log */
export function planText(p: GooglePlan) {
  return [
    ...p.campaigns.map((c) => `Campaign ${c.key} ${c.mode} "${c.name}" ${c.type}${c.mode === "new" ? ` $${c.budget ?? "?"}/day ${c.bidding.toLowerCase()} in ${c.locations.map((l) => l.name).join(", ") || "no locations"}` : ""}${c.negatives.length ? `, ${c.negatives.length} negatives` : ""}${c.sitelinks.length ? `, ${c.sitelinks.length} sitelinks` : ""}${c.callouts.length ? `, ${c.callouts.length} callouts` : ""}`),
    ...p.adGroups.map((g) => `Ad group ${g.key} ${g.mode} "${g.name}" in ${g.campaignKey}: ${g.keywords.length} keywords (${g.keywords.slice(0, 12).map(kwText).join(", ")}), ${g.rsas.length} RSA${g.rsas.length === 1 ? "" : "s"}${g.rsas.map((r) => ` [${r.headlines.map((h) => h.text).join(" | ")}]`).join("")}`),
    ...p.assetGroups.map((a) => `Asset group ${a.key} "${a.name}": ${a.headlines.length} headlines, ${a.longHeadlines.length} long, ${a.descriptions.length} descriptions`),
  ].join("\n");
}

/** Lays out the plan from the answers, then checks every line (refused while a required question is open) */
export async function planGoogleRun(admin: SupabaseClient, id: string) {
  const run = await load(admin, id);
  if (!run?.resolution || !run.account) return;
  const open = unanswered(run.questions);
  if (open.length) {
    await patch(admin, id, { status: "asking", progress: null, error: `Still to answer: ${open.map((q) => q.key).join(", ")}` });
    return;
  }
  try {
    const res = run.resolution;
    let draft = run.sheet ?? { adGroups: [], campaignNegatives: [], notes: [] };
    const matchAnswer = run.questions.find((q) => q.key === "match_types")?.answer;
    if (matchAnswer) draft = applyMatchAnswer(draft, matchAnswer);
    // The campaigns Kaizen Ads launched (and one the buyer insisted on by name) are built into as they are
    const campaignAnswer = run.questions.find((q) => q.key === "campaign")?.answer ?? null;
    const keep = new Set([...(await ownGoogleCampaigns(admin, run.client_id).catch(() => res.own ?? [])), ...(KEEP_PAUSED.test(campaignAnswer ?? "") ? campaignsNamed(campaignAnswer, res.campaigns).map((c) => c.id) : [])]);
    res.own = [...new Set([...(res.own ?? []), ...keep])];
    const choice = campaignChoice(campaignAnswer, res.campaigns, keep);
    const urlAnswer = urlIn(run.questions.find((q) => q.key === "final_url")?.answer);
    const taken = res.suggestions.filter((s) => s.accepted === true);
    const context = await ensureContext(admin, run);
    const chosen = choice?.mode === "existing" ? res.campaigns.find((c) => c.id === choice.id) : null;
    const kaizenNames = res.campaigns.filter((c) => isKaizenName(c.name)).map((c) => c.name);
    const raw = await step(`google run ${id.slice(0, 8)}`, "plan (agent's model)", askJson<RawPlan>({
      agent: "google_launcher",
      label: "google launch plan",
      clientId: run.client_id,
      system: `You lay out the Google launch the buyer agreed to, exactly as answered, as campaigns, ad groups and asset groups. Formats: mode "new" or "existing"; type "SEARCH" or "PERFORMANCE_MAX"; bidding one of MAXIMIZE_CONVERSIONS, MAXIMIZE_CONVERSION_VALUE, MAXIMIZE_CLICKS, MANUAL_CPC; each headline or description is a plain string, with " (pin 1)" at the end only when pinned; a sitelink is "link text | line 1 | line 2 | https://url"; a structured snippet is "Header: value, value, value". Code copies what was read (keywords, negatives and copy of an ad group in <read>) straight from it: point at it with fromRead (its # number) and leave keywords and rsas for that ad group empty unless the buyer added more in the conversation. fromRead -1 for an ad group not in <read>.
- campaigns: key ("c1"…). mode "existing" with existingId (an id from <account>, only a [Kaizen] one) when the buyer chose that campaign; else "new" with existingId "", a name in the account's naming pattern for its Kaizen campaigns, always with Kaizen in it (${kaizenNames.length ? `like ${kaizenNames.slice(0, 3).map((n) => `"${n}"`).join(", ")}` : `e.g. "Search | Non Brand | Kaizen"`}), type SEARCH unless they chose Performance Max, budget (daily dollars, as agreed), bidding (MAXIMIZE_CONVERSIONS unless agreed otherwise; MAXIMIZE_CONVERSION_VALUE for a ROAS goal), targetCpa / targetRoas only when agreed (else 0), locations as place names Google knows ("United States", "Texas", "Houston, Texas"), each place left out with a minus in front ("-Hawaii"; "the lower 48" is ["United States", "-Alaska", "-Hawaii"]). For an existing campaign budget 0 and locations []. negatives: campaign negatives with notation ("free", [diy]). sitelinks, callouts, snippets: only when the buyer asked for them or took a suggestion that adds them, and only where <live_setup> shows they're missing.
- adGroups: key ("g1"…), campaignKey, mode "existing" with existingId (an ad group id from <account>) only when the buyer chose to add into it, else "new" with a name in the account's pattern. finalUrl: the landing page for its ads. keywords and negatives with notation ([exact], "phrase", broad plain) when they come from the conversation or a suggestion taken. rsas: only ads the buyer wrote in the conversation, or that they asked you to write (then up to 15 headlines of at most 30 characters and 4 descriptions of at most 90, built on the client's winning lines and away from the tired ones, pin 0 unless asked; pin 1 to 3 for headlines, 1 to 2 for descriptions).
- assetGroups: only for Performance Max: an existing asset group (existingId from <account>) gets the text agreed (headlines 30, long headlines 90, descriptions 90); searchThemes and byHand (images, videos, audience signals the buyer described) are listed for doing by hand.
Include the suggestions the buyer took; leave out the ones they skipped. Bidding, targets and budgets follow <account_history> (the KPI target, what converts, the monthly budget's pacing) and never contradict the latest audit or the open sprint actions. note: 1 to 3 sentences on how the plan follows what was agreed${chosen && chosen.status !== "ENABLED" && choice?.mode === "existing" && choice.revive ? `, and that "${chosen.name}" is turned back on when it's deployed while everything new in it is created paused for the buyer to switch on` : ""}.
${RULES}`,
      schema: PLAN,
      maxTokens: 20000,
      prompt: `${contextText(context)}\n\n<request>${res.request}</request>\n\n<read>\n${draft.adGroups.length || draft.campaignNegatives.length ? draftText(draft, 200) : "(nothing read: the plan comes from the answers and the conversation)"}\n</read>\n\n<answers>\n${run.questions.map((q) => `- ${q.key}: ${q.answer ?? "(not answered)"}`).join("\n")}\n</answers>\n\n<suggestions_taken>\n${taken.map((s) => `- ${s.title}: ${s.why}`).join("\n") || "(none)"}\n</suggestions_taken>\n\n<conversation>\n${run.turns
        .slice(-20)
        .map((t) => `${t.role === "user" ? "Buyer" : "You"}: ${t.text}`)
        .join("\n")}\n</conversation>\n\n<account id="${run.account}">\n${accountText(res, { groups: 80, waste: 10 })}\n</account>\n\n<live_setup>\n${res.setup.slice(0, 3500)}\n</live_setup>${choice?.mode === "existing" ? (choice.revive ? `\n\nThe buyer chose to bring back the paused Kaizen campaign ${choice.id} with this in it (mode "existing").` : chosen && chosen.status !== "ENABLED" ? `\n\nThe buyer chose the paused campaign ${choice.id} ("${chosen.name}"), as it is: add the ad groups, keywords and ads into it (mode "existing"), it stays paused.` : `\n\nThe buyer chose the live campaign ${choice.id}.`) : choice?.mode === "new" ? `\n\nThe buyer chose a new ${choice.type === "PERFORMANCE_MAX" ? "Performance Max" : "Search"} campaign.` : ""}`,
    }));
    // Where to show it: the buyer's answer, in their words, first ("US excluding Hawaii and Alaska")
    const proposal = proposalFrom(raw);
    const locationAsk = run.questions.find((q) => /^(locations?|places|geo|targeting|where)$/i.test(q.key) && q.answer)?.answer ?? null;
    // Countries and US states are known; the rest goes to Google's own suggestion, matched by the name asked (never by
    // position: a name Google didn't place stays unresolved and blocks the deploy)
    const asked = [locationAsk, ...proposal.campaigns.filter((c) => c.mode === "new").flatMap((c) => [...c.locations, ...(c.excludedLocations ?? [])])].filter((x): x is string => Boolean(x));
    const unknown = [...new Set(asked.flatMap((t) => resolvePlaces(t).unresolved))];
    const geos = unknown.length ? await suggestGeo(unknown).catch(() => [] as { geo: string; name: string }[]) : [];
    const locations = new Map<string, { geo: string; name: string }>();
    for (const nm of unknown) {
      const hit = geos.find((g) => g.name.toLowerCase().startsWith(nm.toLowerCase().split(",")[0].trim()));
      if (hit) locations.set(nm.toLowerCase().trim(), hit);
    }
    const { plan, warnings } = buildGooglePlan(proposal, { account: run.account, draft, res, finalUrl: urlAnswer, locations, locationAsk, revive: choice?.mode === "existing" && choice.revive ? choice.id : null, keepPaused: keep });
    await patch(admin, id, { plan, plan_warnings: warnings, status: "checking", progress: "Checking every line with Google (nothing is created)", error: null });
    await checkGoogleRun(admin, id);
  } catch (e) {
    await patch(admin, id, { status: "asking", progress: null, error: `The plan couldn't be laid out: ${msg(e)}`.slice(0, 500) });
  }
}

type ItemRow = { key: string; kind: LaunchItem["kind"]; position: number; parent_key: string | null; label: string; status: ItemStatus; meta_id: string | null; error: string | null; help: string | null; checked_at: string | null };
const toRow = (runId: string, i: LaunchItem) => ({ run_id: runId, key: i.key, kind: i.kind, position: i.position, parent_key: i.parentKey, label: i.label.slice(0, 500), status: i.status, meta_id: i.metaId, error: i.error, help: i.help, checked_at: i.checked, updated_at: now() });

/** The plan's lines written fresh (nothing is created before deploy, so nothing is lost) */
async function writeItems(admin: SupabaseClient, runId: string, items: LaunchItem[]) {
  await admin.from("launch_items").delete().eq("run_id", runId);
  for (let i = 0; i < items.length; i += 500) {
    const { error } = await admin.from("launch_items").insert(items.slice(i, i + 500).map((x) => toRow(runId, x)));
    if (error) throw new Error(`Saving the plan's lines: ${error.message}`);
  }
}

/**
 * Every line checked: Google's limits and the account first (here), then Google's own dry run of the whole batch
 * (validate only: nothing is created), each refusal pinned to its line in plain words. The card's state comes from it.
 */
export async function checkGoogleRun(admin: SupabaseClient, id: string) {
  const run = await load(admin, id);
  if (!run?.plan) return;
  const plan = run.plan;
  const at = now();
  const local = checkGooglePlan(plan, new Set(run.resolution?.inAccount ?? []));
  const items = googleItems(plan);
  const { ops, keys, byHand } = googleOperations(plan, plan.account);
  let dry: Awaited<ReturnType<typeof googleBulkMutate>> | null = null;
  let dryNote = "";
  if (ops.length && googleAdsConfigured()) {
    try {
      dry = await googleBulkMutate(plan.account, ops, true);
    } catch (e) {
      dryNote = msg(e);
    }
  }
  const google: ReturnType<typeof errorsByLine> = dry && !dry.ok ? errorsByLine(dry.errors, keys) : { by: new Map(), loose: [] };
  const sent = new Set(keys);
  for (const i of items) {
    if (i.status === "existing") continue;
    const errs = local.filter((x) => x.key === i.key && x.level === "error");
    const warns = local.filter((x) => x.key === i.key && x.level === "warn");
    const g = (google.by.get(i.key) ?? []).map(plainGoogleError);
    const hand = byHand.find((b) => b.key === i.key);
    i.checked = at;
    if (errs.length || g.length) {
      i.status = "invalid";
      i.error = [...errs.map((x) => x.message), ...g.map((x) => x.plain)].join(" ").slice(0, 900);
      i.help = [...errs.map((x) => x.fix), ...g.map((x) => x.fix)].filter(Boolean)[0] ?? null;
    } else if (hand) {
      i.status = "unchecked";
      i.help = hand.why;
    } else if (!sent.has(i.key) && i.kind !== "pmax_asset") {
      i.status = "unchecked";
      i.help = "Not sent to Google: it hangs off a line that isn't created from here.";
    } else if (!dry) {
      i.status = "unchecked";
      i.help = dryNote ? `Google couldn't check it: ${dryNote}` : "Google couldn't check it (Google Ads isn't connected).";
    } else {
      // Google refused the batch for other lines: this one wasn't faulted, but the batch goes in whole
      i.status = "valid";
      i.help = warns.length ? warns.map((x) => x.message).join(" ").slice(0, 600) : null;
    }
  }
  await writeItems(admin, id, items);
  // The plan's own warnings stay; what Google and the by-hand list said last time is replaced
  const { data: was } = await admin.from("launch_runs").select("plan_warnings").eq("id", id).single();
  // Only what this check writes is replaced (the plan's own warnings, "Couldn't resolve…" among them, always stay)
  const kept = ((was?.plan_warnings ?? []) as string[]).filter((w) => !w.startsWith("Google refused the batch: ") && !w.startsWith("By hand: "));
  const loose = google.loose.map((x) => `Google refused the batch: ${plainGoogleError(x).plain}`);
  const warnings = [...new Set([...kept, ...loose, ...byHand.map((b) => `By hand: ${b.why}`)])];
  const bad = items.filter((x) => x.status === "invalid").length;
  await patch(admin, id, { status: "ready", progress: null, plan_warnings: warnings, error: bad ? `${bad} line${bad === 1 ? "" : "s"} won't go through as planned: fix or remove ${bad === 1 ? "it" : "them"} (see each line).` : null });
}

/** An edit from the card (remove a line, fix copy, a keyword, a budget, a name), then everything checked again */
export async function editGoogleRun(admin: SupabaseClient, id: string, edit: PlanEdit) {
  const run = await load(admin, id);
  if (!run?.plan || !["ready", "failed"].includes(run.status)) return;
  await patch(admin, id, { plan: editPlan(run.plan, edit), status: "checking", progress: "Checking the change with Google" });
  await checkGoogleRun(admin, id);
}

const FIX = obj({ lines: arr(obj({ key: S, field: { type: "string", enum: ["headline", "description"] }, index: I, text: S })) });

/** Fix what can be fixed: punctuation and duplicates by code, over-long and risky lines rewritten by the buyer agent */
export async function fixGoogleRun(admin: SupabaseClient, id: string) {
  const run = await load(admin, id);
  if (!run?.plan) return;
  let plan = tidyPlan(run.plan);
  const over = plan.adGroups.flatMap((g) => g.rsas.flatMap((r) => [...r.headlines.map((h, i) => ({ key: `rsa:${g.key}:${r.key}`, field: "headline" as const, index: i, text: h.text, max: G.headline })), ...r.descriptions.map((h, i) => ({ key: `rsa:${g.key}:${r.key}`, field: "description" as const, index: i, text: h.text, max: G.description }))])).filter((x) => [...x.text].length > x.max);
  if (over.length) {
    const out = await askJson<{ lines: { key: string; field: "headline" | "description"; index: number; text: string }[] }>({
      agent: "google_launcher",
      label: "google launch fix",
      clientId: run.client_id,
      system: `Shorten each Google ad line to fit its limit (headlines 30 characters, descriptions 90), keeping its meaning, the offer and the client's voice, with no new claims. Give back every line with its key, field and index unchanged. ${RULES}`,
      schema: FIX,
      maxTokens: 4000,
      prompt: over.map((x) => `${x.key} ${x.field} ${x.index} (max ${x.max}, now ${[...x.text].length}): ${x.text}`).join("\n"),
    });
    for (const l of out.lines) {
      const was = over.find((x) => x.key === l.key && x.field === l.field && x.index === l.index);
      if (was && [...l.text.trim()].length <= was.max && l.text.trim()) plan = editPlan(plan, { type: "line", key: l.key, field: l.field, index: l.index, text: l.text });
    }
  }
  await patch(admin, id, { plan, status: "checking", progress: "Checking the fixes with Google" });
  await checkGoogleRun(admin, id);
}

// ─── Deploying ──────────────────────────────────────────────────────────────────────────────────────────────────

async function lock(admin: SupabaseClient, id: string) {
  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data } = await admin.from("launch_runs").update({ locked_at: now() }).eq("id", id).or(`locked_at.is.null,locked_at.lt.${stale}`).select("id");
  return Boolean(data?.length);
}

/**
 * Creates the plan in Google Ads in one batch (all or nothing: a refusal creates nothing, so nothing is half-launched),
 * everything PAUSED, then reads it back and logs it in the client's change history. Refused with the switch off.
 */
export async function applyGoogleRun(admin: SupabaseClient, id: string, by: string) {
  // The person deploying must be allowed to launch in this client's Google Ads account (then the switch, below)
  const { data: owner } = await admin.from("launch_runs").select("client_id").eq("id", id).maybeSingle();
  const allowed = await canIdOn(admin, by, "ads.launch", { platform: "google", clientId: (owner?.client_id as string | undefined) ?? null });
  if (!allowed.ok) {
    await admin.from("launch_runs").update({ status: "ready", progress: null, error: allowed.reason, updated_at: now() }).eq("id", id).eq("status", "applying");
    return { blocked: allowed.reason };
  }
  if (!(await lock(admin, id))) return { busy: true };
  try {
    const run = await load(admin, id);
    if (!run?.plan) throw new Error("There's no plan to deploy.");
    const plan = run.plan;
    const { googleWritesOn, GOOGLE_OFF } = await import("@/lib/meta-write");
    if (!(await googleWritesOn(admin, plan.account))) {
      await patch(admin, id, { status: "ready", progress: null, error: GOOGLE_OFF });
      return { blocked: GOOGLE_OFF };
    }
    // Kaizen only writes into what it set up: anything aimed at another campaign (or a new one without Kaizen in its
    // name) refuses the whole deploy, whatever the card was sent
    const scope = kaizenScopeIssues(plan);
    if (scope.length) {
      const why = `Not deployed: ${scope[0].message}${scope.length > 1 ? ` (and ${scope.length - 1} more line${scope.length === 2 ? "" : "s"})` : ""}`;
      await patch(admin, id, { status: "ready", progress: null, error: why.slice(0, 500) });
      return { blocked: why };
    }
    await patch(admin, id, { status: "applying", progress: "Creating everything in Google Ads, paused" });
    const { ops, keys, byHand } = googleOperations(plan, plan.account);
    const r = await googleBulkMutate(plan.account, ops, false);
    const { data: rows } = await admin.from("launch_items").select("key, kind, position, parent_key, label, status, meta_id, error, help, checked_at").eq("run_id", id).order("position");
    const items: LaunchItem[] = ((rows ?? []) as ItemRow[]).map((x) => ({ key: x.key, kind: x.kind, position: x.position, parentKey: x.parent_key, label: x.label, status: x.status, metaId: x.meta_id, error: x.error, help: x.help, checked: x.checked_at }));
    const at = now();
    if (r.ok) {
      const made = new Map<string, string>();
      r.results.forEach((res, i) => {
        if (!res) return;
        const k = keys[i];
        // A line's main object: the campaign, ad group, keyword or ad itself (an asset's link to its campaign last)
        if (!made.has(k) || /campaignAssets|assetGroupAssets/.test(res)) made.set(k, res);
      });
      for (const i of items) {
        if (i.status === "existing") continue;
        if (made.has(i.key)) Object.assign(i, { status: "created", metaId: made.get(i.key)!, error: null, checked: at });
        else if (byHand.some((b) => b.key === i.key)) Object.assign(i, { status: "skipped", help: byHand.find((b) => b.key === i.key)!.why });
      }
    } else {
      const { by, loose } = errorsByLine(r.errors, keys);
      for (const i of items) {
        const g = (by.get(i.key) ?? []).map(plainGoogleError);
        if (g.length) Object.assign(i, { status: "failed", error: g.map((x) => x.plain).join(" "), help: g.find((x) => x.fix)?.fix ?? null });
      }
      if (loose.length && !by.size) Object.assign(items.find((i) => i.status !== "existing") ?? {}, { status: "failed", error: plainGoogleError(loose[0]).plain });
    }
    await writeItems(admin, id, items);
    // The account changed: what was kept of it goes (the read after the read-back below keeps the new one)
    if (r.ok) await forgetCached(admin, `google:${run.client_id}:${plan.account}`);
    const created = items.filter((i) => i.status === "created").length;
    const status: RunStatus = r.ok ? (byHand.length ? "partial" : "applied") : "failed";
    await patch(admin, id, {
      status,
      progress: r.ok ? "Reading back what was created" : null,
      applied_at: r.ok ? at : null,
      confirmed_by: by,
      confirmed_at: at,
      error: r.ok ? (byHand.length ? `Created ${created} line${created === 1 ? "" : "s"}, paused. ${byHand.length} part${byHand.length === 1 ? " is" : "s are"} for doing by hand in Google Ads (see the lines).` : null) : `Google refused the launch, so nothing was created: ${r.errors.slice(0, 2).map((e) => plainGoogleError(e).plain).join(" ")} Fix the lines marked and deploy again.`.slice(0, 600),
    });
    // The KPI it belongs to, so the launch shows with that account's work (reports, the KPI card)
    const { data: ts } = await admin.from("kpi_targets").select("id, ad_account_id").eq("client_id", run.client_id).eq("platform", "google");
    const targetId = ((ts ?? []).find((t) => digits(t.ad_account_id as string | null) === digits(plan.account))?.id as string | undefined) ?? null;
    await admin
      .from("ad_changes")
      .insert({
        target_id: targetId,
        client_id: run.client_id,
        platform: "google",
        account: plan.account,
        source: "launch",
        status: r.ok ? (byHand.length ? "partial" : "applied") : "failed",
        title: `Launch: ${launchTitle(plan)}`.slice(0, 200),
        request: run.resolution?.request?.slice(0, 2000) ?? null,
        note: r.ok ? `Created paused: ${created} line${created === 1 ? "" : "s"}.${byHand.length ? ` By hand: ${byHand.map((b) => b.why).join(" ")}` : ""}` : null,
        error: r.ok ? null : r.message.slice(0, 400),
        ops: items.filter((i) => i.status !== "existing").map((i) => ({ kind: `google_launch_${i.kind}`, key: i.key, label: i.label, status: i.status, resource: i.metaId })),
        asked_by: run.created_by,
        planned_by: run.created_by,
        applied_by: r.ok ? by : null,
        applied_at: r.ok ? at : null,
      })
      .then(
        () => null,
        () => null,
      );
    if (r.ok) {
      await qaGoogleRun(admin, id).catch(() => undefined);
      // Read again now, so "suggest more" on the card (and the next launch) starts from the account as it is
      await readGoogleAccount(admin, run.client_id, plan.account, true).catch(() => undefined);
    }
    return { status };
  } catch (e) {
    await patch(admin, id, { status: "failed", progress: null, error: msg(e).slice(0, 500) });
    return { error: msg(e) };
  } finally {
    await admin.from("launch_runs").update({ locked_at: null }).eq("id", id);
  }
}

/** "Search | Plumbing: 2 ad groups, 34 keywords, 2 RSAs" */
export function launchTitle(p: GooglePlan) {
  const k = p.adGroups.reduce((s, g) => s + g.keywords.length, 0);
  const r = p.adGroups.reduce((s, g) => s + g.rsas.length, 0);
  return `${p.campaigns.map((c) => c.name).slice(0, 2).join(", ")}: ${p.adGroups.length} ad group${p.adGroups.length === 1 ? "" : "s"}, ${k} keyword${k === 1 ? "" : "s"}, ${r} RSA${r === 1 ? "" : "s"}`;
}

const idOf = (res: string | null | undefined, kind: string) => res?.match(new RegExp(`/${kind}/(\\d+)`))?.[1] ?? null;

/**
 * What Google has under the launch's campaigns, by querying them (never the resource names the mutate returned): the
 * campaigns and their budgets, every ad group, keyword and negative, every ad with its copy, the locations, language
 * and campaign negatives, the extensions. Paused and enabled alike (only removed ones are left out).
 */
async function readCampaigns(account: string, campaignIds: string[]): Promise<Found> {
  const found: Found = { campaigns: [], adGroups: [], keywords: [], ads: [], criteria: [], assets: [] };
  const ids = [...new Set(campaignIds.map(digits).filter(Boolean))];
  if (!ids.length) return found;
  const inList = ids.join(", ");
  const q = (sql: string) => googleQuery(account, sql) as Promise<Row[]>;
  const [camps, groups, crits, ads, campCrits, assets] = await Promise.all([
    q(`SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros FROM campaign WHERE campaign.id IN (${inList})`),
    q(`SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id FROM ad_group WHERE campaign.id IN (${inList}) AND ad_group.status != 'REMOVED'`),
    q(`SELECT ad_group.id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.negative, ad_group_criterion.status FROM ad_group_criterion WHERE campaign.id IN (${inList}) AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED'`),
    q(`SELECT ad_group.id, ad_group_ad.status, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions FROM ad_group_ad WHERE campaign.id IN (${inList}) AND ad_group_ad.status != 'REMOVED'`),
    q(`SELECT campaign.id, campaign_criterion.type, campaign_criterion.negative, campaign_criterion.location.geo_target_constant, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion WHERE campaign.id IN (${inList}) AND campaign_criterion.status != 'REMOVED'`),
    q(`SELECT campaign.id, campaign_asset.field_type FROM campaign_asset WHERE campaign.id IN (${inList}) AND campaign_asset.status != 'REMOVED'`).catch(() => [] as Row[]),
  ]);
  const text = (xs: unknown) => ((xs ?? []) as { text?: string }[]).map((x) => String(x.text ?? ""));
  found.campaigns = camps.map((r) => ({ id: String(r.campaign?.id ?? ""), name: String(r.campaign?.name ?? ""), status: String(r.campaign?.status ?? ""), budget: r.campaignBudget?.amountMicros == null ? null : Math.round(Number(r.campaignBudget.amountMicros) / 10_000) / 100 }));
  found.adGroups = groups.map((r) => ({ id: String(r.adGroup?.id ?? ""), campaignId: String(r.campaign?.id ?? ""), name: String(r.adGroup?.name ?? ""), status: String(r.adGroup?.status ?? "") }));
  found.keywords = crits.map((r) => {
    const c = r.adGroupCriterion as { keyword?: { text?: string; matchType?: string }; negative?: boolean; status?: string } | undefined;
    return { adGroupId: String(r.adGroup?.id ?? ""), text: String(c?.keyword?.text ?? "").toLowerCase(), match: String(c?.keyword?.matchType ?? ""), negative: Boolean(c?.negative), status: String(c?.status ?? "") };
  });
  found.ads = ads.map((r) => {
    const a = r.adGroupAd as { status?: string; ad?: { responsiveSearchAd?: { headlines?: unknown; descriptions?: unknown } } } | undefined;
    return { adGroupId: String(r.adGroup?.id ?? ""), status: String(a?.status ?? ""), headlines: text(a?.ad?.responsiveSearchAd?.headlines), descriptions: text(a?.ad?.responsiveSearchAd?.descriptions) };
  });
  found.criteria = campCrits.map((r) => {
    const c = r.campaignCriterion as { type?: string; negative?: boolean; location?: { geoTargetConstant?: string }; keyword?: { text?: string; matchType?: string } } | undefined;
    return { campaignId: String(r.campaign?.id ?? ""), kind: String(c?.type ?? ""), negative: Boolean(c?.negative), geo: c?.location?.geoTargetConstant ?? null, text: c?.keyword?.text ?? null, match: c?.keyword?.matchType ?? null };
  });
  found.assets = assets.map((r) => ({ campaignId: String(r.campaign?.id ?? ""), fieldType: String((r.campaignAsset as { fieldType?: string } | undefined)?.fieldType ?? "") }));
  return found;
}

/**
 * Everything the launch made, read back by querying its campaigns in Google and compared line by line with the plan:
 * a line is ok only when it's found. The lines Google doesn't have are marked on the card ("not found in Google
 * Ads") and said in one sentence, ready for "Add what's missing".
 */
export async function qaGoogleRun(admin: SupabaseClient, id: string) {
  const run = await load(admin, id);
  if (!run?.plan) return null;
  const plan = run.plan;
  const { data: rows } = await admin.from("launch_items").select("key, kind, position, parent_key, label, status, meta_id, error, help, checked_at").eq("run_id", id).order("position");
  const all = (rows ?? []) as ItemRow[];
  const made = new Map(all.filter((r) => r.meta_id).map((r) => [r.key, r.meta_id as string]));
  const campaignIds = plan.campaigns.map((c) => c.existingId ?? idOf(made.get(`campaign:${c.key}`), "campaigns")).filter((x): x is string => Boolean(x));
  let found: Found;
  try {
    found = await readCampaigns(plan.account, campaignIds);
  } catch (e) {
    // Google couldn't be read: nothing is claimed either way
    const qa: GoogleQa = { at: now(), lines: [], summary: `Couldn't read it back from Google yet (${msg(e).slice(0, 160)}). Check it in Google Ads, or ask me again in a minute.`, missing: [] };
    await patch(admin, id, { qa, progress: null });
    return qa;
  }
  const rb = compareReadBack(plan, made, found);
  const camp = (ck: string) => rb.ids[`campaign:${ck}`] ?? plan.campaigns.find((c) => c.key === ck)?.existingId ?? null;
  const grp = (gk: string) => rb.ids[`adgroup:${gk}`] ?? plan.adGroups.find((g) => g.key === gk)?.existingId ?? null;
  const lines = rb.lines.map((l) => {
    const [kind, a] = l.key.split(":");
    const g = plan.adGroups.find((x) => x.key === a);
    const link =
      kind === "adgroup"
        ? googleDeepLink(plan.account, "ad_group", { campaignId: g ? camp(g.campaignKey) : null, adGroupId: grp(a) })
        : kind === "rsa"
          ? googleDeepLink(plan.account, "ad", { campaignId: g ? camp(g.campaignKey) : null, adGroupId: grp(a) })
          : kind === "kw" || kind === "aneg"
            ? googleDeepLink(plan.account, "keyword", { campaignId: g ? camp(g.campaignKey) : null, adGroupId: grp(a) })
            : googleDeepLink(plan.account, "campaign", { campaignId: camp(a) });
    return { ...l, link };
  });
  // The card's lines follow what Google has: a line it doesn't have is marked, one found again is created
  const at = now();
  const missing = new Set(rb.missing);
  const fixed = all.map((r) => {
    if (r.status === "existing" || r.status === "skipped") return r;
    if (missing.has(r.key)) return { ...r, status: "failed" as ItemStatus, error: "Not found in Google Ads after the deploy.", help: "Add what's missing puts it into the same campaign.", checked_at: at };
    if (lines.some((l) => l.key === r.key) && r.status === "failed") return { ...r, status: "created" as ItemStatus, error: null, help: null, checked_at: at };
    return r;
  });
  await writeItems(
    admin,
    id,
    fixed.map((x) => ({ key: x.key, kind: x.kind, position: x.position, parentKey: x.parent_key, label: x.label, status: x.status, metaId: x.meta_id, error: x.error, help: x.help, checked: x.checked_at })),
  );
  const qa: GoogleQa = { at, lines, summary: rb.summary, missing: rb.missing, ids: rb.ids };
  await patch(admin, id, { qa, progress: null });
  return qa;
}

/**
 * "Add what's missing": only what the read-back didn't find, created into the same campaign (and ad groups) in one
 * batch, paused, then read back again. The same gates as Deploy (who may launch, the client's Google switch, Kaizen's
 * campaigns only).
 */
export async function addMissingGoogleRun(admin: SupabaseClient, id: string, by: string): Promise<{ added: number } | { blocked: string } | { busy: true } | { error: string }> {
  const { data: owner } = await admin.from("launch_runs").select("client_id").eq("id", id).maybeSingle();
  const allowed = await canIdOn(admin, by, "ads.launch", { platform: "google", clientId: (owner?.client_id as string | undefined) ?? null });
  if (!allowed.ok) return { blocked: allowed.reason };
  if (!(await lock(admin, id))) return { busy: true };
  try {
    const run = await load(admin, id);
    if (!run?.plan || !["applied", "partial"].includes(run.status)) return { blocked: "Only a launch that's been created can have what's missing added." };
    const { googleWritesOn, GOOGLE_OFF } = await import("@/lib/meta-write");
    if (!(await googleWritesOn(admin, run.plan.account))) return { blocked: GOOGLE_OFF };
    // A fresh read first: only what Google still doesn't have goes in
    const qa = await qaGoogleRun(admin, id);
    const extra = qa?.missing?.length ? missingPlan(run.plan, { missing: qa.missing, ids: qa.ids ?? {} }) : null;
    if (!extra) return { added: 0 };
    const scope = kaizenScopeIssues(extra);
    if (scope.length) return { blocked: `Not added: ${scope[0].message}` };
    const { ops } = googleOperations(extra, extra.account);
    if (!ops.length) return { added: 0 };
    await patch(admin, id, { progress: "Adding what's missing in Google Ads, paused" });
    const r = await googleBulkMutate(extra.account, ops, false);
    if (!r.ok) {
      const why = `Google refused adding what's missing: ${r.errors.slice(0, 2).map((e) => plainGoogleError(e).plain).join(" ")}`.slice(0, 500);
      await patch(admin, id, { progress: null, error: why });
      return { error: why };
    }
    await forgetCached(admin, `google:${run.client_id}:${extra.account}`);
    await admin
      .from("ad_changes")
      .insert({ client_id: run.client_id, platform: "google", account: extra.account, source: "launch", status: "applied", title: `Launch, what was missing: ${launchTitle(extra)}`.slice(0, 200), note: `Added paused into the same campaign: ${ops.length} operation${ops.length === 1 ? "" : "s"}.`, ops: [], asked_by: by, planned_by: by, applied_by: by, applied_at: now() })
      .then(
        () => null,
        () => null,
      );
    const after = await qaGoogleRun(admin, id);
    await patch(admin, id, { progress: null, error: null, qa: { ...(after ?? { at: now(), lines: [] }), added: `Added ${ops.length} missing piece${ops.length === 1 ? "" : "s"} at ${now()}.` } });
    return { added: ops.length };
  } catch (e) {
    await patch(admin, id, { progress: null, error: msg(e).slice(0, 500) });
    return { error: msg(e) };
  } finally {
    await admin.from("launch_runs").update({ locked_at: null }).eq("id", id);
  }
}

/** The launch's place in Google Ads (its first campaign), from the read-back or what was made */
export async function googleLaunchWhere(admin: SupabaseClient, id: string) {
  const run = await load(admin, id);
  if (!run?.plan) return null;
  const { data } = await admin.from("launch_runs").select("qa").eq("id", id).maybeSingle();
  let qa = (data?.qa as GoogleQa | null) ?? null;
  // The read-back is what's true now: read again when it's older than a minute
  if (!qa || Date.now() - Date.parse(qa.at) > 60_000) qa = (await qaGoogleRun(admin, id).catch(() => null)) ?? qa;
  const c = run.plan.campaigns[0];
  const campaignId = c ? (qa?.ids?.[`campaign:${c.key}`] ?? c.existingId) : null;
  return { name: c?.name ?? "the campaign", link: campaignId ? googleDeepLink(run.plan.account, "campaign", { campaignId }) : null, summary: qa?.summary ?? null, missing: qa?.missing ?? [], status: run.status };
}
