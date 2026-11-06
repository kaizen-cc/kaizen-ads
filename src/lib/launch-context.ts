import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { step } from "@/lib/launch-cache";
import { MAIN_RESULTS, conversionFor } from "@/lib/kpi/conversions";
import { pickType, toDays } from "@/lib/kpi/calc";
import type { AuditResult } from "@/lib/audit";
import { comebackPick, historyOf, isKaizenName, type CampaignDay, type CampaignHistory, type LaunchContext } from "@/lib/kaizen-scope";

// What a master media buyer knows walking into a launch, built once per launch run and kept on it (resolution.context),
// so the intake, every chat turn and the plan read the same thing without working it out again:
//   client    the KPI targets and pacing, the Brand Bible's essentials (read-this-first, what their ads proved), the
//             client's standing rules (memory)
//   history   this account's campaigns over 30 and 90 days against the target (Kaizen's own marked, the rest for
//             context only), what was paused and when (the change log), the latest audit's verdict and actions, the
//             sprint's open actions (never contradicted)
//   related   the client's other platform: what converts there, its best copy (offers and angles that work)
// Lean on purpose (about 6k characters in all): each part is capped, numbers first.

export type { LaunchContext };

const money = (x: number | null | undefined) => (x == null ? "n/a" : `$${Math.round(x).toLocaleString("en-US")}`);
const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const bare = (a: string, platform: "meta" | "google") => (platform === "google" ? a.replace(/\D/g, "") : a.replace(/^act_/, ""));

type Target = { id: string; platform: string; label: string | null; ad_account_id: string | null; conversion: string; custom_action: string | null; target: number | string | null; monthly_budget: number | string | null };

/** Every campaign's days in this account over 180 days, each reduced to the KPI's result */
async function campaignDays(admin: SupabaseClient, platform: "meta" | "google", account: string, t: Target | null): Promise<{ days: CampaignDay[]; roas: boolean }> {
  const table = platform === "google" ? "google_campaign_daily" : "meta_campaign_daily";
  const since = new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10);
  const rows: { date: string; campaign_id: string; campaign_name: string | null; spend: number | string; actions: Record<string, number>; action_values: Record<string, number> }[] = [];
  for (let from = 0; from < 20_000; from += 1000) {
    const { data } = await admin.from(table).select("date, campaign_id, campaign_name, spend, actions, action_values").eq("ad_account_id", bare(account, platform)).gte("date", since).order("date").range(from, from + 999);
    rows.push(...((data ?? []) as typeof rows));
    if (!data || data.length < 1000) break;
  }
  const conv = conversionFor(t?.conversion ?? (platform === "google" ? "conversions" : "purchases"));
  const roas = Boolean(conv.roas);
  if (platform === "google")
    return { roas, days: rows.map((r) => ({ id: String(r.campaign_id), name: r.campaign_name ?? "", date: r.date, spend: Number(r.spend) || 0, results: Number(r.actions?.conversions) || 0, revenue: Number(r.action_values?.conversions) || 0 })) };
  // Meta: the KPI's own result, chosen once per campaign from what it reports
  const by = new Map<string, typeof rows>();
  for (const r of rows) by.set(String(r.campaign_id), [...(by.get(String(r.campaign_id)) ?? []), r]);
  const days: CampaignDay[] = [];
  for (const [id, list] of by) {
    const picked = pickType(toDays(list), conv, t?.custom_action ?? null);
    // "Each campaign's own goal" (or a type it never reports): its strongest main result
    const type = picked && picked !== "campaign_goal" && list.some((r) => r.actions?.[picked] != null) ? picked : (MAIN_RESULTS.find((x) => list.some((r) => Number(r.actions?.[x]) > 0)) ?? picked);
    for (const r of list) days.push({ id, name: r.campaign_name ?? "", date: r.date, spend: Number(r.spend) || 0, results: type ? Number(r.actions?.[type]) || 0 : 0, revenue: type ? Number(r.action_values?.[type]) || 0 : 0 });
  }
  return { roas, days };
}

/** The campaigns the latest audit or sprint says to cut or pause (named in its actions): never offered back */
function flaggedIn(hist: CampaignHistory[], texts: string[]) {
  const out = new Set<string>();
  for (const h of hist) {
    const n = h.name.toLowerCase();
    if (n.length > 3 && texts.some((t) => t.toLowerCase().includes(n) && /\b(pause|cut|kill|turn off|stop|shut)\b/i.test(t))) out.add(h.id);
  }
  return out;
}

/**
 * The launch's context, built once. `live`: the account's campaigns as read now (id, name, status, type), so the
 * history says which are live, paused or Kaizen's. `theme`: what's launched (for the comeback's fit). `types`: the
 * campaign types this launch can go into (Google Search for keywords), for the comeback.
 */
export async function buildLaunchContext(
  admin: SupabaseClient,
  clientId: string,
  platform: "meta" | "google",
  account: string,
  o: { live: { id: string; name: string; status: string; type?: string | null }[]; theme: string; types?: string[] | null; pausedStatuses?: string[] },
): Promise<LaunchContext> {
  const scope = `${platform} ${account} context`;
  const other = platform === "google" ? "meta" : "google";
  const [{ data: targets }, { data: bible }, { data: memory }] = await Promise.all([
    admin.from("kpi_targets").select("id, platform, label, ad_account_id, conversion, custom_action, target, monthly_budget").eq("client_id", clientId).eq("active", true),
    admin.from("client_brand_bibles").select("status, read_this_first, learnings").eq("client_id", clientId).in("status", ["draft", "reviewed"]).maybeSingle(),
    admin.from("client_memory").select("kind, body, dated").eq("client_id", clientId).eq("status", "active").is("dated", null).order("created_at", { ascending: false }).limit(30),
  ]);
  const ts = (targets ?? []) as Target[];
  const mine = ts.find((t) => t.platform === platform && t.ad_account_id && bare(t.ad_account_id, platform) === bare(account, platform)) ?? ts.find((t) => t.platform === platform) ?? null;
  const theirs = ts.filter((t) => t.platform === other && t.ad_account_id);

  const [kpis, own, audit, sprint, changes, otherDays, otherCopy, otherTerms] = await Promise.all([
    step(scope, "kpis", import("@/lib/kpi/client").then((m) => m.loadClientKpis(admin, clientId).then(m.describeKpis))).catch(() => ""),
    step(scope, "180-day history", campaignDays(admin, platform, account, mine)).catch(() => ({ days: [] as CampaignDay[], roas: false })),
    mine ? admin.from("account_audits").select("created_at, result").eq("target_id", mine.id).eq("status", "ready").order("created_at", { ascending: false }).limit(1).maybeSingle().then((r) => r.data) : Promise.resolve(null),
    mine ? admin.from("optimization_sprints").select("started_at, sprint_actions(title, status, when, why)").eq("target_id", mine.id).eq("status", "active").maybeSingle().then((r) => r.data) : Promise.resolve(null),
    admin.from("ad_account_changes").select("at, what, object, object_type").eq("ad_account_id", bare(account, platform)).gte("at", new Date(Date.now() - 180 * 86_400_000).toISOString()).order("at", { ascending: false }).limit(300).then((r) => r.data ?? []),
    theirs[0]?.ad_account_id ? step(scope, "other platform history", campaignDays(admin, other, theirs[0].ad_account_id, theirs[0])).catch(() => null) : Promise.resolve(null),
    import("@/lib/copy-library").then((m) => m.clientCopyLines(admin, clientId)).catch(() => []),
    // Google's converting searches, for a Meta launch: what people actually search for is a strong angle
    platform === "meta" && theirs[0]?.ad_account_id ? import("@/lib/context/google-ads").then((m) => (m.googleAdsConfigured() ? m.googleConvertingTerms(theirs[0].ad_account_id!, 90) : [])).catch(() => []) : Promise.resolve([]),
  ]);
  const day = today();

  // ─── Client ───────────────────────────────────────────────────────────────────────────────────────────
  const learned = ((bible?.learnings ?? []) as { at: string; kind: string; text: string }[]).slice(-10).reverse();
  const mem = (memory ?? []) as { kind: string; body: string }[];
  const client = [
    "KPI targets and pacing:",
    cap(kpis || "No KPI targets set.", 1400),
    ...(bible?.read_this_first ? ["Brand Bible, read this first:", cap(String(bible.read_this_first).replace(/\n{2,}/g, "\n"), 900)] : []),
    ...(learned.length ? ["What their ads proved (Brand Bible learnings, newest first):", ...learned.map((l) => `- ${l.kind === "avoid" ? "AVOID" : "WORKS"}: ${cap(l.text, 160)}`)] : []),
    ...(mem.length ? ["Standing rules from the team (client memory):", ...[...mem.filter((m) => m.kind !== "note"), ...mem.filter((m) => m.kind === "note")].slice(0, 14).map((m) => `- [${m.kind}] ${cap(m.body, 170)}`)] : []),
  ].join("\n");

  // ─── This account's history ───────────────────────────────────────────────────────────────────────────
  const status = new Map(o.live.map((c) => [c.id, { status: c.status, type: c.type ?? null }]));
  const hist = historyOf(own.days, status, { today: day, roas: own.roas });
  // Campaigns with no spend in 180 days are still known (a paused one may have run longer ago): listed by name only
  for (const c of o.live) if (!hist.some((h) => h.id === c.id)) hist.push({ id: c.id, name: c.name, status: c.status, type: c.type ?? null, spend30: 0, results30: 0, spend90: 0, results90: 0, spend180: 0, results180: 0, revenue180: 0, value180: null, firstSpent: null, lastSpent: null, pausedAt: null });
  // When each paused one was paused: the change log's latest status change on it
  for (const h of hist) {
    if (h.status === "ENABLED" || h.status === "ACTIVE") continue;
    const hit = changes.find((c) => (c.object ?? "").toLowerCase() === h.name.toLowerCase() && /status|paus/i.test(String(c.what)));
    if (hit) h.pausedAt = String(hit.at).slice(0, 10);
  }
  const target = mine?.target == null ? null : Number(mine.target);
  const r = audit?.result as AuditResult | null | undefined;
  const sprintActions = ((sprint?.sprint_actions ?? []) as unknown as { title: string; status: string; when: string; why: string }[]).filter((a) => a.status === "todo" || a.status === "doing");
  const auditTexts = [...(r?.actions ?? []).map((a) => `${a.title}. ${a.why}`), ...sprintActions.map((a) => `${a.title}. ${a.why}`)];
  const comeback = comebackPick(hist, { today: day, roas: own.roas, target, theme: o.theme, types: o.types ?? null, flagged: flaggedIn(hist, auditTexts), pausedStatuses: o.pausedStatuses });
  const val = (spend: number, results: number, revenue?: number) => (own.roas ? (spend ? `${Math.round(((revenue ?? 0) / spend) * 100) / 100}x ROAS` : "no spend") : results ? `${money(spend / results)} CPA` : "no results");
  const kaizenFirst = [...hist].sort((a, b) => Number(isKaizenName(b.name)) - Number(isKaizenName(a.name)) || b.spend90 - a.spend90);
  const line = (h: CampaignHistory) => {
    const live = h.status === "ENABLED" || h.status === "ACTIVE";
    const tag = isKaizenName(h.name) ? "Kaizen" : "not Kaizen's: context only, never written to";
    return `- "${h.name}" ${live ? "live" : h.status.toLowerCase().replace(/_/g, " ")}${h.type ? ` ${h.type.toLowerCase()}` : ""} [${tag}] · 30d ${money(h.spend30)}, ${h.results30} results${h.spend30 ? `, ${val(h.spend30, h.results30, (h.revenue180 * h.spend30) / (h.spend180 || 1))}` : ""} · 90d ${money(h.spend90)}, ${h.results90} results${h.spend90 ? `, ${val(h.spend90, h.results90, (h.revenue180 * h.spend90) / (h.spend180 || 1))}` : ""}${h.lastSpent ? ` · last spent ${h.lastSpent}` : " · no spend in 180 days"}${h.pausedAt ? ` · paused ${h.pausedAt}` : ""}`;
  };
  const shown = kaizenFirst.filter((h) => isKaizenName(h.name) || h.spend90 > 0).slice(0, 16);
  const statusChanges = changes.filter((c) => /status|paus|enabl|budget|bid/i.test(String(c.what))).slice(0, 10);
  const history = [
    `Target: ${target == null ? "none set (judge against the account's own numbers)" : own.roas ? `${target}x ROAS` : `${money(target)} per result`}${mine?.monthly_budget ? ` · monthly budget ${money(Number(mine.monthly_budget))}` : ""}`,
    "Campaigns (Kaizen's first; 30 and 90 days):",
    ...shown.map(line),
    ...(hist.length > shown.length ? [`(${hist.length - shown.length} more campaigns with no spend in 90 days)`] : []),
    ...(statusChanges.length ? ["Recent status and budget changes (newest first):", ...statusChanges.map((c) => `- ${String(c.at).slice(0, 10)} ${cap(String(c.what), 80)}${c.object ? ` on "${cap(String(c.object), 60)}"` : ""}`)] : []),
    ...(r?.verdict ? [`Latest audit (${String(audit?.created_at).slice(0, 10)}): ${cap(`${r.verdict.headline}. ${r.verdict.summary}`, 320)}`, ...(r.actions ?? []).slice(0, 5).map((a) => `- Audit action (${a.when}): ${cap(a.title, 140)}`), ...(r.watchouts ?? []).slice(0, 2).map((w) => `- Watch out: ${cap(w.title, 120)}`)] : []),
    ...(sprintActions.length ? ["Open sprint actions (don't contradict them):", ...sprintActions.slice(0, 6).map((a) => `- [${a.status}] ${cap(a.title, 140)} (${a.when})`)] : []),
    ...(comeback ? [`Paused Kaizen campaign worth bringing back: ${comeback.why}`] : []),
  ].join("\n");

  // ─── Related: the client's other platform ─────────────────────────────────────────────────────────────
  const otherHist = otherDays ? historyOf(otherDays.days, new Map(), { today: day, roas: otherDays.roas }) : [];
  const copy = (otherCopy as { platform: string; kind: string; text: string; badge: string }[]).filter((l) => l.platform === other && (l.badge === "winner" || l.badge === "solid")).slice(0, 6);
  const terms = (otherTerms as { term: string; conversions: number }[]).slice(0, 10);
  const otherKpi = theirs.map((t) => `${other === "google" ? "Google" : "Meta"}${t.label ? ` · ${t.label}` : ""}: counts ${conversionFor(t.conversion).key}, target ${t.target ?? "none"}${t.monthly_budget ? `, ${money(Number(t.monthly_budget))}/month` : ""}`);
  const related = otherKpi.length || otherHist.length || copy.length || terms.length
    ? [
        ...otherKpi,
        ...(otherHist.length ? [`${other === "google" ? "Google" : "Meta"} campaigns converting most (90 days):`, ...otherHist.filter((h) => h.results90 > 0).sort((a, b) => b.results90 - a.results90).slice(0, 5).map((h) => `- "${cap(h.name, 70)}": ${money(h.spend90)}, ${h.results90} results${h.results90 && !otherDays?.roas ? `, ${money(h.spend90 / h.results90)} each` : ""}`)] : []),
        ...(terms.length ? ["Searches that convert on Google (90 days):", terms.map((t) => `"${t.term}" (${Math.round(t.conversions)})`).join(", ")] : []),
        ...(copy.length ? [`Proven ${other === "google" ? "Google" : "Meta"} copy (offers and angles that work):`, ...copy.map((l) => `- ${l.kind}: ${cap(l.text, 140)}`)] : []),
      ].join("\n")
    : "Nothing on the client's other platform.";

  const kaizenLive = hist.filter((h) => isKaizenName(h.name) && (h.status === "ENABLED" || h.status === "ACTIVE")).length;
  const kaizenPaused = hist.filter((h) => isKaizenName(h.name) && (o.pausedStatuses ?? ["PAUSED"]).includes(h.status)).length;
  return { client: cap(client, 3200), history: cap(history, 4200), related: cap(related, 1600), comeback, kaizen: { live: kaizenLive, paused: kaizenPaused, outside: hist.filter((h) => !isKaizenName(h.name)).length }, at: new Date().toISOString() };
}

/** The context as the prompt reads it */
export function contextText(c: LaunchContext | null | undefined) {
  if (!c) return "";
  return `<client_context>\n${c.client}\n</client_context>\n\n<account_history>\n${c.history}\n</account_history>\n\n<related_accounts>\n${c.related}\n</related_accounts>`;
}
