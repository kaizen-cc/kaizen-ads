import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { googleDeepLink } from "@/lib/chat-change-core";
import { googleAdsConfigured, googleBulkMutate, googleQuery, googleWritableSetup, suggestGeo } from "@/lib/context/google-ads";
import { applyAnswers, mergeQuestions } from "@/lib/launch-sheet/questions";
import { unanswered } from "@/lib/launch-sheet/plan";
import { gridText } from "@/lib/launch-sheet/grid";
import type { SheetSource } from "@/lib/launch-sheet/intake";
import type { CheckItem, ItemStatus, LaunchItem, LaunchQuestion, RunStatus } from "@/lib/launch-sheet/types";
import { SETUP_RULE, checkAgainstSetup, type SetupFacts } from "@/lib/setup-check";
import {
  campaignChoice,
  checkGooglePlan,
  draftSummary,
  editPlan,
  errorsByLine,
  G,
  googleItems,
  googleOperations,
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
};

export type Turn = { role: "user" | "assistant"; text: string; at: string };
type Run = {
  id: string;
  client_id: string;
  account: string | null;
  status: RunStatus;
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
  const { data } = await admin.from("launch_runs").select("id, client_id, account, status, source, sheet, summary, resolution, questions, turns, plan, created_by").eq("id", id).eq("platform", "google").maybeSingle();
  return (data as Run | null) ?? null;
}
const patch = (admin: SupabaseClient, id: string, p: Record<string, unknown>) => admin.from("launch_runs").update({ ...p, updated_at: now() }).eq("id", id);

const RULES = `Kaizen's Google launch rules: everything is created PAUSED for the buyer to turn on in Google Ads. Respect Google's limits exactly: RSA headlines up to 30 characters (3 to 15 of them), descriptions up to 90 (2 to 4), display paths up to 15 each, keywords up to 80 characters and 10 words, sitelink text 25, callouts 25. No exclamation marks in headlines, no repeated punctuation, no emojis, no phone numbers in ad text, no all-caps words except brand names and acronyms. Match types: [exact], "phrase", broad as plain text. Profitability first: the searches that convert and the copy that won lead; what wastes spend becomes a negative. Refer to people by role (the buyer, the client, the head of Google), never by name. Plain text, no markdown, no emojis, no em dashes.`;

// ─── Starting one ───────────────────────────────────────────────────────────────────────────────────────────────

/** The client's Google Ads account for this launch: the KPI card's own, else the client's first */
async function accountFor(admin: SupabaseClient, clientId: string, targetId: string | null) {
  const { data: ts } = await admin.from("kpi_targets").select("id, ad_account_id").eq("client_id", clientId).eq("platform", "google").eq("active", true).not("ad_account_id", "is", null).order("created_at");
  const t = (ts ?? []).find((x) => x.id === targetId) ?? (ts ?? [])[0];
  return t?.ad_account_id ? digits(t.ad_account_id as string) : null;
}

/** A new Google launch from the chat (the buyer's words, and a sheet when one was shared); read in the background */
export async function startGoogleRun(admin: SupabaseClient, clientId: string, profileId: string, o: { request: string; source?: SheetSource | null; targetId?: string | null; scopeType?: CampaignType | null }): Promise<{ id: string } | { error: string }> {
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
      resolution: { request: o.request.slice(0, 3000), scopeType: o.scopeType ?? null },
      turns: o.request.trim() ? [{ role: "user", text: o.request.slice(0, 3000), at: now() }] : [],
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
  const [setup, { data: days }, ads, groups, kws, snapshot, converting, lines] = await Promise.all([
    googleWritableSetup(account),
    admin.from("google_campaign_daily").select("campaign_id, spend, actions").eq("ad_account_id", account).gte("date", since),
    safe(googleQuery(account, "SELECT ad_group.id, ad_group_ad.ad_strength FROM ad_group_ad WHERE ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD' AND ad_group_ad.status != 'REMOVED' AND campaign.status != 'REMOVED'") as Promise<Row[]>, [] as Row[]),
    safe(googleQuery(account, "SELECT asset_group.id, asset_group.name, asset_group.ad_strength, campaign.id, campaign.name FROM asset_group WHERE asset_group.status != 'REMOVED' AND campaign.status != 'REMOVED'") as Promise<Row[]>, [] as Row[]),
    safe(googleQuery(account, "SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM ad_group_criterion WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED' AND ad_group_criterion.negative = FALSE AND campaign.status != 'REMOVED'") as Promise<Row[]>, [] as Row[]),
    safe(import("@/lib/google-setup").then((m) => m.googleSetupSnapshot(account)), null),
    safe(import("@/lib/context/google-ads").then((m) => m.googleConvertingTerms(account, 90)), [] as { term: string; campaignName: string; conversions: number; spend: number }[]),
    safe(import("@/lib/copy-library").then((m) => m.clientCopyLines(admin, clientId)), []),
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

/** The account in a compact form for the Google Ads Buyer */
function accountText(r: GoogleResolution) {
  const money = (x: number | null) => (x == null ? "?" : `$${Math.round(x)}`);
  return [
    "CAMPAIGNS (id, type, status, bidding, daily budget, last 30 days)",
    ...r.campaigns.map((c) => `- ${c.id} "${c.name}" ${c.type} ${c.status} ${c.bidding.toLowerCase()} ${money(c.budget)}/day · ${money(c.spend30)} spent, ${c.conversions30} conv${c.conversions30 ? ` ($${Math.round(c.spend30 / c.conversions30)}/conv)` : ""}`),
    "AD GROUPS (id, campaign, ads and their best ad strength)",
    ...r.adGroups.slice(0, 120).map((g) => `- ${g.id} "${g.name}" in "${g.campaign}" ${g.status}${g.rsas ? `, ${g.rsas} RSA${g.rsas === 1 ? "" : "s"}${g.strength ? ` (${g.strength.toLowerCase()})` : ""}` : ", no RSA"}`),
    ...(r.assetGroups.length ? ["PERFORMANCE MAX ASSET GROUPS", ...r.assetGroups.map((a) => `- ${a.id} "${a.name}" in "${a.campaign}"${a.strength ? ` (${a.strength.toLowerCase()})` : ""}`)] : []),
    "SEARCHES THAT CONVERTED (90 days)",
    ...r.converting.slice(0, 25).map((t) => `- "${t.term}" (${t.campaign}): ${t.conversions} conv, $${t.spend}`),
    "SEARCHES SPENDING WITH NO CONVERSIONS (30 days)",
    ...r.waste.slice(0, 15).map((t) => `- "${t.term}" (${t.campaign}): $${t.spend}, ${t.clicks} clicks`),
    "COPY LIBRARY (this client's Google lines)",
    ...r.winners.map((l) => `- winner ${l}`),
    ...r.tired.map((l) => `- tired ${l}`),
  ].join("\n");
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
    system: `You read a Google Ads launch sheet a buyer shared: the keywords and ad copy to launch, in whatever layout they use. Read every ad group with its campaign (as the sheet names it, "" when it doesn't), its keywords and negatives exactly as written (keep [brackets] and "quotes": they're the match type; never add notation that isn't there), its RSA headlines and descriptions word for word (keep any pin written next to one, like "(pin 1)"), display paths and the final URL. Copy text exactly, even when it's over Google's limits: the checks flag it. campaignNegatives: negatives for the whole campaign. notes: anything ambiguous (copy you couldn't place, two ad groups with the same name, a column you couldn't read), one sentence each, at most 6.
${RULES}`,
    schema: obj({ adGroups: arr(DRAFT_GROUP), campaignNegatives: arr(S), notes: arr(S) }),
    maxTokens: 24000,
    prompt: `<sheet name="${name.replace(/"/g, "'")}">\n${text}\n</sheet>`,
  });
  const d = draftFrom(out.adGroups, out.campaignNegatives);
  return { ...d, notes: out.notes.slice(0, 6) };
}

const INTAKE = obj({ summary: S, wordsDraft: arr(DRAFT_GROUP), questions: arr(obj({ key: S, question: S, why: S, proposal: S, options: arr(S), required: B })), suggestions: arr(obj({ key: S, title: S, why: S })) });

/** Reads what was shared and the account, then asks only what's missing and suggests from the account. Background. */
export async function prepareGoogleRun(admin: SupabaseClient, id: string) {
  const run = await load(admin, id);
  if (!run || !run.account) return;
  const base = run.resolution as Partial<GoogleResolution> | null;
  const request = base?.request ?? "";
  try {
    if (!googleAdsConfigured()) throw new Error("Google Ads isn't connected yet (Settings, Sync health).");
    let draft: GoogleDraft = { adGroups: [], campaignNegatives: [], notes: [] };
    let read = "";
    if (run.source.kind !== "words") {
      const { openTabs } = await import("@/lib/launch-sheet/intake");
      const t = await openTabs(admin, run.source);
      if (!t.tabs.length) throw new Error(t.note ?? "The sheet couldn't be read.");
      const parsed = tabsToDraft(t.tabs);
      if (parsed.recognized && parsed.draft.adGroups.length) draft = parsed.draft;
      else draft = await readSheetWithModel(run.client_id, t.name, t.tabs.map((x) => `[tab "${x.title}"]\n${gridText(x.grid, 40_000)}`).join("\n\n").slice(0, 120_000));
      read = draftSummary(draft);
      await patch(admin, id, { sheet: draft, progress: "Checking it against the account" });
    }
    const acct = await readAccount(admin, run.client_id, run.account);
    const res: GoogleResolution = { account: run.account, request, scopeType: base?.scopeType ?? null, ...acct, suggestions: [], checks: [], at: now() };
    await patch(admin, id, { progress: "Writing the questions and suggestions" });
    const [brief, copy] = await Promise.all([
      import("@/lib/handoff").then((m) => m.accountBrief(admin, run.client_id, null)).then((b) => b.text).catch(() => ""),
      import("@/lib/copy-library").then((m) => m.copyContext(admin, run.client_id, 6000, "google")).catch(() => ""),
    ]);
    const must = googleQuestions(draft, res.campaigns, res.adGroups, `${request} ${run.source.kind !== "words" ? run.source.name : ""}`, res.scopeType);
    const out = await askJson<{ summary: string; wordsDraft: DraftOut[]; questions: Omit<LaunchQuestion, "answer">[]; suggestions: { key: string; title: string; why: string }[] }>({
      agent: "google_launcher",
      label: "google launch intake",
      clientId: run.client_id,
      system: `You're the Google Ads buyer about to launch new ads into a client's live Google Ads account, from a buyer's request in chat${run.source.kind !== "words" ? " and the sheet they shared (already read: below)" : ""}. Nothing is planned or written yet.
summary: 2 to 4 sentences: what they want launched, what you read${read ? ` (say it as read: "${read}")` : ""}, and what in the account matters for it.
wordsDraft: ${run.source.kind !== "words" ? "[] (the sheet was read)." : "what the buyer wrote in their message, as ad groups: keywords exactly as written (keep [ ] and quotes, never add notation), headlines and descriptions word for word, final URL. [] when they only described what they want."}
questions: start from the required questions given (keep each key; rewrite the question, why and proposal for this client and request, short; keep the options, and make the campaign options the live campaigns that fit best by name, type, status, spend and theme). Add a question only when something the plan needs is still open and only the buyer can decide it (a new campaign's daily budget and bidding, Search or Performance Max, the places to show, which ad groups the copy is for, pins). Never ask what the request, the sheet or the account already answers. At most 8.
suggestions: up to 6 improvements grounded in the account today and your skills: negatives from searches that waste spend, keywords from searches that convert and aren't covered, copy built on the winners and away from the tired lines, missing assets (sitelinks, callouts, snippets) only where the setup snapshot shows they're missing, ad strength, match type mix, landing page fit. Each with a key, a short title (what you'd add or change) and why, with the numbers. ${SETUP_RULE}
${RULES}`,
      schema: INTAKE,
      maxTokens: 12000,
      prompt: `<request>${request || "(shared a sheet to launch)"}</request>\n\n${draft.adGroups.length ? `<read>\n${draftText(draft)}\n</read>\n\n` : ""}<account id="${run.account}">\n${accountText(res)}\n</account>\n\n<live_setup>\n${res.setup.slice(0, 9000) || "(couldn't be read)"}\n</live_setup>\n\n<client_context>\n${brief.slice(0, 9000)}\n</client_context>\n\n${copy ? `<copy_context>\n${copy}\n</copy_context>\n\n` : ""}<required_questions>\n${must.map((q) => `- ${q.key}: ${q.question} Proposal: ${q.proposal}. Options: ${q.options.join(" | ")}`).join("\n")}\n</required_questions>`,
    });
    if (run.source.kind === "words" && out.wordsDraft.length) {
      draft = draftFrom(out.wordsDraft);
      read = draft.adGroups.length ? draftSummary(draft) : "";
    }
    // The questions again from what's now read (the words may have answered some), the model's version of each kept
    const required = googleQuestions(draft, res.campaigns, res.adGroups, request, res.scopeType);
    const keys = new Set(required.map((q) => q.key));
    const fromModel = out.questions.filter((q) => keys.has(q.key) || !["campaign", "ad_group", "final_url", "keywords", "match_types", "ads", "go_live"].includes(q.key));
    const questions = mergeQuestions(
      fromModel.map((q) => {
        const must1 = required.find((m) => m.key === q.key);
        // The campaign options always include the live ones that fit and a new one, whatever the model kept
        return { ...q, options: must1 ? [...new Set([...q.options, ...must1.options])].slice(0, 7) : q.options, answer: null };
      }),
      required,
    );
    // Suggestions that add what's already in place are dropped (the setup check)
    const checked = checkAgainstSetup(
      out.suggestions.map((s) => ({ ...s, why: s.why })),
      res.facts,
    ).actions;
    res.suggestions = checked.slice(0, 6).map((s, i) => ({ key: s.key || `s${i + 1}`, title: s.title, why: s.why, accepted: null }));
    res.checks = intakeChecks(draft, res);
    const summary = [read ? `${read}.` : "", out.summary, ...draft.notes.map((x) => `Note: ${x}`)].filter(Boolean).join("\n\n");
    await patch(admin, id, { sheet: draft, resolution: res, summary, questions, status: "asking", progress: null, error: null });
  } catch (e) {
    await patch(admin, id, { status: "failed", progress: null, error: msg(e).slice(0, 500) });
  }
}

/** What the read already shows: the account, the copy against Google's limits, duplicates */
function intakeChecks(d: GoogleDraft, r: GoogleResolution): CheckItem[] {
  const out: CheckItem[] = [];
  out.push({ key: "account", label: "The account", level: "ok", detail: `${r.campaigns.filter((c) => c.status === "ENABLED").length} live campaigns, ${r.adGroups.length} ad groups${r.assetGroups.length ? `, ${r.assetGroups.length} asset groups` : ""}.` });
  if (!d.adGroups.length) return out;
  const rsas = d.adGroups.flatMap((g) => g.rsas);
  const long = rsas.flatMap((x) => [...x.headlines.filter((h) => [...h.text].length > G.headline).map((h) => `"${h.text}" (${[...h.text].length}/30)`), ...x.descriptions.filter((h) => [...h.text].length > G.description).map((h) => `a ${[...h.text].length}-character description`)]);
  out.push(long.length ? { key: "limits", label: "Copy limits", level: "warn", detail: `${long.length} line${long.length === 1 ? " is" : "s are"} over Google's limits: ${long.slice(0, 4).join(", ")}${long.length > 4 ? "…" : ""}.`, fix: "Fix them on the plan card (Fix what I can), or send shorter ones." } : { key: "limits", label: "Copy limits", level: "ok", detail: "Every headline and description fits Google's limits." });
  const inAcc = new Set(r.inAccount);
  const dup = d.adGroups.flatMap((g) => g.keywords).filter((k) => inAcc.has(kwKey(k)));
  if (dup.length) out.push({ key: "dupes", label: "Already in the account", level: "warn", detail: `${dup.length} keyword${dup.length === 1 ? " already runs" : "s already run"}: ${dup.slice(0, 5).map(kwText).join(", ")}${dup.length > 5 ? "…" : ""}.`, fix: "Leave them out, or keep them only if this ad group should take those searches over." });
  const few = rsas.filter((x) => x.headlines.length < G.headlinesMin || x.descriptions.length < G.descriptionsMin).length;
  if (few) out.push({ key: "rsa_counts", label: "Ads", level: "warn", detail: `${few} RSA${few === 1 ? " has" : "s have"} fewer than 3 headlines or 2 descriptions.` });
  return out;
}

// ─── The conversation ───────────────────────────────────────────────────────────────────────────────────────────

const REPLY = obj({ answer: S, answers: arr(obj({ key: S, answer: S })), newQuestions: arr(obj({ key: S, question: S, why: S, proposal: S, options: arr(S), required: B })), accept: arr(S), skip: arr(S), build: B, offTopic: B, setAside: B });

/** The buyer's message about the launch: answers taken in, suggestions taken or skipped, the plan built when asked */
export async function googleLaunchReply(admin: SupabaseClient, id: string, message: string): Promise<{ answer: string; offTopic: boolean; building: boolean }> {
  const run = await load(admin, id);
  if (!run?.resolution) return { answer: "", offTopic: true, building: false };
  const res = run.resolution;
  const out = await askJson<{ answer: string; answers: { key: string; answer: string }[]; newQuestions: Omit<LaunchQuestion, "answer">[]; accept: string[]; skip: string[]; build: boolean; offTopic: boolean; setAside: boolean }>({
    agent: "google_launcher",
    label: "google launch chat",
    clientId: run.client_id,
    system: `You're the Google Ads buyer in a conversation with the buyer about launching new ads into the client's Google Ads account. What was read, your questions (with what's answered), your suggestions and the conversation are below. Stage: ${run.status}.
answers: the questions the buyer's message answers, by key, in their words made exact and in the format Google needs (keywords with their notation, a daily budget in dollars, the full final URL). When they accept your proposal ("yes", "go with that"), the answer is your proposal written out. When they give keywords or copy, the answer holds them word for word. Only what they actually said or accepted.
newQuestions: only when their answer opens something the plan needs.
accept / skip: keys of your suggestions they took or turned down.
build: true when they ask to build, see or redo the plan, or say go ahead, or (stage ready) ask for a change to the plan. The plan is only built once every required question is answered; if some aren't, say which.
answer: 1 to 6 sentences: confirm what you took, push back with the reason when something works against the client's results or Google's rules (over a limit, a duplicate, a keyword already running), and ask what's still open. When the stage is "ready" and they say go ahead, tell them to press Deploy on the launch card (it checks the client's Google switch and who may deploy, and creates everything paused); build stays false.
offTopic: true when the message isn't about this launch (answer ""). setAside: true when they say to stop or park it.
${RULES}`,
    schema: REPLY,
    maxTokens: 6000,
    prompt: `<read>\n${run.sheet ? draftText(run.sheet, 25) : "(nothing yet)"}\n</read>\n\n<questions>\n${run.questions.map((q) => `- ${q.key}${q.required ? " (required)" : ""}: ${q.question} Proposal: ${q.proposal}. ${q.answer ? `ANSWERED: ${q.answer}` : "Not answered yet."}`).join("\n")}\n</questions>\n\n<suggestions>\n${res.suggestions.map((s) => `- ${s.key}: ${s.title}. ${s.accepted === true ? "TAKEN" : s.accepted === false ? "SKIPPED" : "open"}`).join("\n") || "(none)"}\n</suggestions>\n\n${run.plan ? `<plan>\n${planText(run.plan)}\n</plan>\n\n` : ""}<conversation>\n${run.turns
      .slice(-16)
      .map((t) => `${t.role === "user" ? "Buyer" : "You"}: ${t.text}`)
      .join("\n")}\n</conversation>\n\nThe buyer says: ${message.slice(0, 3000)}`,
  });
  if (out.offTopic) return { answer: "", offTopic: true, building: false };
  let questions = applyAnswers(run.questions, out.answers);
  if (out.newQuestions.length) questions = mergeQuestions(out.newQuestions.map((q) => ({ ...q, answer: null })), [], questions);
  const suggestions = res.suggestions.map((s) => (out.accept.includes(s.key) ? { ...s, accepted: true } : out.skip.includes(s.key) ? { ...s, accepted: false } : s));
  const turns = [...run.turns, { role: "user" as const, text: message.slice(0, 3000), at: now() }, { role: "assistant" as const, text: out.answer, at: now() }].slice(-40);
  if (out.setAside) {
    await patch(admin, id, { questions, turns, status: "set_aside", resolution: { ...res, suggestions } });
    return { answer: out.answer || "Set aside. Nothing was created.", offTopic: false, building: false };
  }
  const open = unanswered(questions);
  const building = out.build && !open.length && (run.status === "asking" || out.answers.length > 0 || out.accept.length > 0);
  const answer = out.build && open.length ? `${out.answer}\n\nBefore I can plan it I still need: ${open.map((q) => q.question).join(" ")}` : out.answer;
  const changed = (out.answers.length > 0 || out.accept.length > 0) && ["ready", "failed"].includes(run.status);
  await patch(admin, id, { questions, turns, resolution: { ...res, suggestions }, ...(building ? { status: "planning", progress: "Laying out the plan" } : changed ? { status: "asking" } : {}) });
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
  await patch(admin, id, { questions });
}

/** A suggestion taken or skipped on the card */
export async function setGoogleSuggestion(admin: SupabaseClient, id: string, key: string, accepted: boolean | null) {
  const run = await load(admin, id);
  if (!run?.resolution) return;
  await patch(admin, id, { resolution: { ...run.resolution, suggestions: run.resolution.suggestions.map((s) => (s.key === key ? { ...s, accepted } : s)) } });
}

// ─── The plan ───────────────────────────────────────────────────────────────────────────────────────────────────

const LINE = obj({ text: S, pin: I });
const PLAN = obj({
  note: S,
  campaigns: arr(
    obj({
      key: S,
      mode: { type: "string", enum: ["new", "existing"] },
      existingId: S,
      name: S,
      type: { type: "string", enum: ["SEARCH", "PERFORMANCE_MAX"] },
      budget: N,
      bidding: { type: "string", enum: ["MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE", "MAXIMIZE_CLICKS", "MANUAL_CPC"] },
      targetCpa: N,
      targetRoas: N,
      locations: arr(S),
      negatives: arr(S),
      sitelinks: arr(obj({ text: S, line1: S, line2: S, url: S })),
      callouts: arr(S),
      snippets: arr(obj({ header: S, values: arr(S) })),
    }),
  ),
  adGroups: arr(obj({ key: S, campaignKey: S, mode: { type: "string", enum: ["new", "existing"] }, existingId: S, name: S, fromRead: I, finalUrl: S, keywords: arr(S), negatives: arr(S), rsas: arr(obj({ headlines: arr(LINE), descriptions: arr(LINE), path1: S, path2: S, finalUrl: S })) })),
  assetGroups: arr(obj({ key: S, campaignKey: S, existingId: S, name: S, finalUrl: S, headlines: arr(S), longHeadlines: arr(S), descriptions: arr(S), searchThemes: arr(S), byHand: arr(S) })),
});
type ProposalCampaign = { key: string; mode: "new" | "existing"; existingId: string; name: string; type: CampaignType; budget: number; bidding: Bidding; targetCpa: number; targetRoas: number; locations: string[]; negatives: string[]; sitelinks: GCampaign["sitelinks"]; callouts: string[]; snippets: GCampaign["snippets"] };
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
export function buildGooglePlan(p: GoogleProposal, ctx: { account: string; draft: GoogleDraft; res: Pick<GoogleResolution, "campaigns" | "adGroups" | "assetGroups">; finalUrl: string | null; locations: Map<string, { geo: string; name: string }> }): { plan: GooglePlan; warnings: string[] } {
  const warnings: string[] = [];
  const campaigns: GCampaign[] = p.campaigns.map((c) => {
    const live = c.mode === "existing" ? ctx.res.campaigns.find((x) => x.id === digits(c.existingId)) : null;
    if (c.mode === "existing" && !live) warnings.push(`"${c.name}" isn't a campaign in the account, so it's planned as a new one.`);
    const type: CampaignType = live ? (live.type === "PERFORMANCE_MAX" ? "PERFORMANCE_MAX" : "SEARCH") : c.type;
    return {
      key: c.key,
      mode: live ? "existing" : "new",
      existingId: live?.id ?? null,
      name: live?.name ?? c.name.trim(),
      type,
      budget: live ? live.budget : c.budget > 0 ? Math.round(c.budget * 100) / 100 : null,
      bidding: c.bidding,
      targetCpa: c.targetCpa > 0 ? c.targetCpa : null,
      targetRoas: c.targetRoas > 0 ? c.targetRoas : null,
      locations: live ? [] : c.locations.map((l) => ctx.locations.get(l.toLowerCase().trim())).filter((x): x is { geo: string; name: string } => Boolean(x)),
      negatives: kws(c.negatives),
      sitelinks: c.sitelinks.filter((s) => s.text.trim()),
      callouts: c.callouts.map((x) => x.trim()).filter(Boolean),
      snippets: c.snippets.filter((s) => s.header.trim() && s.values.length),
    };
  });
  for (const c of p.campaigns) {
    const missing = c.locations.filter((l) => !ctx.locations.get(l.toLowerCase().trim()));
    if (c.mode === "new" && missing.length) warnings.push(`Google didn't recognize ${missing.map((m) => `"${m}"`).join(", ")} as a place.`);
  }
  const adGroups: GAdGroup[] = [];
  for (const g of p.adGroups) {
    const live = g.mode === "existing" ? ctx.res.adGroups.find((x) => x.id === digits(g.existingId)) : null;
    if (g.mode === "existing" && !live) warnings.push(`"${g.name}" isn't an ad group in the account, so it's planned as a new one.`);
    let campaignKey = g.campaignKey;
    if (live) {
      // An existing ad group sits in its own campaign, whatever the model said
      const c = campaigns.find((x) => x.existingId === live.campaignId);
      if (c) campaignKey = c.key;
      else {
        const lc = ctx.res.campaigns.find((x) => x.id === live.campaignId);
        campaignKey = `c${campaigns.length + 1}`;
        campaigns.push({ key: campaignKey, mode: "existing", existingId: live.campaignId, name: lc?.name ?? live.campaign, type: "SEARCH", budget: lc?.budget ?? null, bidding: "MAXIMIZE_CONVERSIONS", targetCpa: null, targetRoas: null, locations: [], negatives: [], sitelinks: [], callouts: [], snippets: [] });
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
      name: live?.name ?? (g.name.trim() || read?.name || "New ad group"),
      keywords: uniqKeywords([...(read?.keywords ?? []), ...kws(g.keywords)]),
      negatives: uniqKeywords([...(read?.negatives ?? []), ...kws(g.negatives)]),
      rsas,
    });
  }
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
    const choice = campaignChoice(run.questions.find((q) => q.key === "campaign")?.answer, res.campaigns);
    const urlAnswer = run.questions.find((q) => q.key === "final_url")?.answer?.match(/https?:\/\/\S+/)?.[0]?.replace(/[).,]+$/, "") ?? null;
    const taken = res.suggestions.filter((s) => s.accepted === true);
    const proposal = await askJson<GoogleProposal>({
      agent: "google_launcher",
      label: "google launch plan",
      clientId: run.client_id,
      system: `You lay out the Google launch the buyer agreed to, exactly as answered, as campaigns, ad groups and asset groups. Code copies what was read (keywords, negatives and copy of an ad group in <read>) straight from it: point at it with fromRead (its # number) and leave keywords and rsas for that ad group empty unless the buyer added more in the conversation. fromRead -1 for an ad group not in <read>.
- campaigns: key ("c1"…). mode "existing" with existingId (an id from <account>) when the buyer chose a live campaign; else "new" with existingId "", a name in the account's naming pattern, type SEARCH unless they chose Performance Max, budget (daily dollars, as agreed), bidding (MAXIMIZE_CONVERSIONS unless agreed otherwise; MAXIMIZE_CONVERSION_VALUE for a ROAS goal), targetCpa / targetRoas only when agreed (else 0), locations as place names Google knows ("Houston, Texas"). For an existing campaign budget 0 and locations []. negatives: campaign negatives with notation ("free", [diy]). sitelinks, callouts, snippets: only when the buyer asked for them or took a suggestion that adds them, and only where <live_setup> shows they're missing.
- adGroups: key ("g1"…), campaignKey, mode "existing" with existingId (an ad group id from <account>) only when the buyer chose to add into it, else "new" with a name in the account's pattern. finalUrl: the landing page for its ads. keywords and negatives with notation ([exact], "phrase", broad plain) when they come from the conversation or a suggestion taken. rsas: only ads the buyer wrote in the conversation, or that they asked you to write (then up to 15 headlines of at most 30 characters and 4 descriptions of at most 90, built on the client's winning lines and away from the tired ones, pin 0 unless asked; pin 1 to 3 for headlines, 1 to 2 for descriptions).
- assetGroups: only for Performance Max: an existing asset group (existingId from <account>) gets the text agreed (headlines 30, long headlines 90, descriptions 90); searchThemes and byHand (images, videos, audience signals the buyer described) are listed for doing by hand.
Include the suggestions the buyer took; leave out the ones they skipped. note: 1 to 3 sentences on how the plan follows what was agreed.
${RULES}`,
      schema: PLAN,
      maxTokens: 20000,
      prompt: `<request>${res.request}</request>\n\n<read>\n${draft.adGroups.length || draft.campaignNegatives.length ? draftText(draft, 200) : "(nothing read: the plan comes from the answers and the conversation)"}\n</read>\n\n<answers>\n${run.questions.map((q) => `- ${q.key}: ${q.answer ?? "(not answered)"}`).join("\n")}\n</answers>\n\n<suggestions_taken>\n${taken.map((s) => `- ${s.title}: ${s.why}`).join("\n") || "(none)"}\n</suggestions_taken>\n\n<conversation>\n${run.turns
        .slice(-20)
        .map((t) => `${t.role === "user" ? "Buyer" : "You"}: ${t.text}`)
        .join("\n")}\n</conversation>\n\n<account id="${run.account}">\n${accountText(res)}\n</account>\n\n<live_setup>\n${res.setup.slice(0, 6000)}\n</live_setup>${choice?.mode === "existing" ? `\n\nThe buyer chose the live campaign ${choice.id}.` : choice?.mode === "new" ? `\n\nThe buyer chose a new ${choice.type === "PERFORMANCE_MAX" ? "Performance Max" : "Search"} campaign.` : ""}`,
    });
    // Google's own places for the new campaigns' locations
    const names = [...new Set(proposal.campaigns.filter((c) => c.mode === "new").flatMap((c) => c.locations))];
    const geos = names.length ? await suggestGeo(names).catch(() => [] as { geo: string; name: string }[]) : [];
    const locations = new Map<string, { geo: string; name: string }>();
    names.forEach((nm, i) => {
      const hit = geos.find((g) => g.name.toLowerCase().startsWith(nm.toLowerCase().split(",")[0].trim())) ?? geos[i];
      if (hit) locations.set(nm.toLowerCase().trim(), hit);
    });
    const { plan, warnings } = buildGooglePlan(proposal, { account: run.account, draft, res, finalUrl: urlAnswer, locations });
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
  const kept = ((was?.plan_warnings ?? []) as string[]).filter((w) => !w.startsWith("Google ") && !w.startsWith("By hand: "));
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
    if (r.ok) await qaGoogleRun(admin, id).catch(() => undefined);
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

/** Everything created, read back from Google (status, name, the ad's copy) with its place in Google Ads */
export async function qaGoogleRun(admin: SupabaseClient, id: string) {
  const run = await load(admin, id);
  if (!run?.plan) return;
  const plan = run.plan;
  const { data: rows } = await admin.from("launch_items").select("key, kind, status, meta_id").eq("run_id", id);
  const made = (rows ?? []).filter((r) => r.status === "created" && r.meta_id) as { key: string; kind: string; meta_id: string }[];
  const campaignId = (ck: string) => {
    const c = plan.campaigns.find((x) => x.key === ck);
    return c?.existingId ?? idOf(made.find((r) => r.key === `campaign:${ck}`)?.meta_id, "campaigns");
  };
  const groupId = (gk: string) => {
    const g = plan.adGroups.find((x) => x.key === gk);
    return g?.existingId ?? idOf(made.find((r) => r.key === `adgroup:${gk}`)?.meta_id, "adGroups");
  };
  const list = (kind: string) => made.filter((r) => r.kind === kind).map((r) => `'${r.meta_id}'`);
  const q = async (sql: string) => ((await googleQuery(plan.account, sql).catch(() => [])) as Row[]);
  const [camps, groups, ads, crits] = await Promise.all([
    list("campaign").length ? q(`SELECT campaign.resource_name, campaign.name, campaign.status FROM campaign WHERE campaign.resource_name IN (${list("campaign").join(", ")})`) : [],
    list("ad_group").length ? q(`SELECT ad_group.resource_name, ad_group.name, ad_group.status FROM ad_group WHERE ad_group.resource_name IN (${list("ad_group").join(", ")})`) : [],
    list("rsa").length ? q(`SELECT ad_group_ad.resource_name, ad_group_ad.status, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions FROM ad_group_ad WHERE ad_group_ad.resource_name IN (${list("rsa").join(", ")})`) : [],
    list("keyword").length ? q(`SELECT ad_group_criterion.resource_name, ad_group_criterion.status FROM ad_group_criterion WHERE ad_group_criterion.resource_name IN (${list("keyword").slice(0, 400).join(", ")})`) : [],
  ]);
  const lines: { key: string; ok: boolean; diffs: string[]; link: string | null }[] = [];
  for (const r of made) {
    const [kind, a, b] = r.key.split(":");
    const diffs: string[] = [];
    let link: string | null = null;
    if (kind === "campaign") {
      const m = camps.find((x) => x.campaign?.resourceName === r.meta_id);
      if (!m) diffs.push("couldn't be read back");
      else if (m.campaign?.status !== "PAUSED") diffs.push(`status is ${String(m.campaign?.status).toLowerCase()}`);
      link = googleDeepLink(plan.account, "campaign", { campaignId: campaignId(a) });
    } else if (kind === "adgroup") {
      const m = groups.find((x) => x.adGroup?.resourceName === r.meta_id);
      if (!m) diffs.push("couldn't be read back");
      else if (m.adGroup?.status !== "PAUSED") diffs.push(`status is ${String(m.adGroup?.status).toLowerCase()}`);
      const g = plan.adGroups.find((x) => x.key === a);
      link = googleDeepLink(plan.account, "ad_group", { campaignId: g ? campaignId(g.campaignKey) : null, adGroupId: groupId(a) });
    } else if (kind === "rsa") {
      const m = ads.find((x) => x.adGroupAd?.resourceName === r.meta_id);
      const ad = plan.adGroups.find((x) => x.key === a)?.rsas.find((x) => x.key === b);
      const got = (m?.adGroupAd as { ad?: { responsiveSearchAd?: { headlines?: unknown[]; descriptions?: unknown[] } } } | undefined)?.ad?.responsiveSearchAd;
      if (!m) diffs.push("couldn't be read back");
      else {
        if (m.adGroupAd?.status !== "PAUSED") diffs.push(`status is ${String(m.adGroupAd?.status).toLowerCase()}`);
        if (ad && (got?.headlines?.length ?? 0) !== ad.headlines.length) diffs.push(`${got?.headlines?.length ?? 0} headlines instead of ${ad.headlines.length}`);
        if (ad && (got?.descriptions?.length ?? 0) !== ad.descriptions.length) diffs.push(`${got?.descriptions?.length ?? 0} descriptions instead of ${ad.descriptions.length}`);
      }
      const g = plan.adGroups.find((x) => x.key === a);
      link = googleDeepLink(plan.account, "ad", { campaignId: g ? campaignId(g.campaignKey) : null, adGroupId: groupId(a) });
    } else if (kind === "kw") {
      const m = crits.find((x) => x.adGroupCriterion?.resourceName === r.meta_id);
      if (m && m.adGroupCriterion?.status !== "PAUSED") diffs.push(`status is ${String(m.adGroupCriterion?.status).toLowerCase()}`);
      const g = plan.adGroups.find((x) => x.key === a);
      link = googleDeepLink(plan.account, "keyword", { campaignId: g ? campaignId(g.campaignKey) : null, adGroupId: groupId(a) });
    } else if (kind === "budget" || kind === "targeting" || kind === "cneg" || kind === "sitelink" || kind === "callout" || kind === "snippet") {
      link = googleDeepLink(plan.account, "campaign", { campaignId: campaignId(a) });
    } else if (kind === "aneg") {
      link = googleDeepLink(plan.account, "keyword", { adGroupId: groupId(a) });
    }
    lines.push({ key: r.key, ok: !diffs.length, diffs, link });
  }
  await patch(admin, id, { qa: { at: now(), lines }, progress: null });
}
