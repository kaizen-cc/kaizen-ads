import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hasLine } from "@/lib/service-gate";
import { servicesOf } from "@/lib/services";
import { matchActor, shortDay, isAutomated, isKaizenEmail } from "@/lib/account-watch/core";
import { applyFindings, type Finding } from "@/lib/account-watch/run";
import { LINE_HEAD, LINE_SEATS, isBudgetOrTargeting, isHumanAuthor, isPauseChange, needsSignoff, reviewLinesFor, soundsApproved, type ReviewLine } from "@/lib/line-review/core";
import {
  accountStatusIssue,
  bigDatesAhead,
  daysBetween,
  isAccessError,
  isAccessRemoval,
  isAuthError,
  isDogKind,
  leadsOf,
  missingSpecialCategory,
  pageProblems,
  pastEvent,
  quietFor,
  resultsOf,
  siteDown,
  stuckDays,
  zeroOutcome,
  trackingProblems,
  conversionGap,
  cvrDrop,
  TRACKING_KINDS,
  type SiteResult,
} from "./core";

// The daily watchdogs: same-day checks that tell the account owner and that line's head in Kaizen OS (the bell and an
// item on Today), once per issue: each one is an account watch flag (src/lib/account-watch) that stays open, without
// repeating, until it's no longer found, then clears itself. Never a Slack DM. Read only everywhere: Meta, Klaviyo and
// the websites are only looked at.
//
// runWatchdogs (twice a day): the client pausing or editing campaigns, access removed, our budget or targeting moves
// without the client's sign-off, spend with no landing page views or no results, ads running past their event,
// housing / employment / credit without the special ad category, new lead sources with no CRM sync, lost access,
// integrations losing authorization, payment and delivery problems, no human update in the client channels for 5
// days, creative stuck 7 days, and big dates coming with nothing built. (Spend 20% over budget is the account watch's
// overspend check.)
// runSiteChecks (hourly): web design clients' sites, up or down; on Mondays the weekly page check.

const DAY = 86_400_000;
const LIVE = ["active", "onboarding"];
const nyDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const accountKey = (platform: string, id: string) => (platform === "google" ? id.replace(/\D/g, "") : id.replace(/^act_/, "").trim());
const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => Boolean(x)))];
const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

type Profile = { id: string; full_name: string; display_name: string | null; email: string | null; role: string; is_active: boolean; platform_aliases: string[] | null };
type Client = { id: string; name: string; slug: string; status: string; created_at: string; website: string | null; services: string[] | null; services_extra: string[] | null; services_removed: string[] | null; strategy_only: string[] | null; billed_services: null; slack_channel_id: string | null };
type Target = { id: string; client_id: string; platform: string; ad_account_id: string; owner_id: string | null; monthly_budget: number | null };

/** Every row, a page of 1000 at a time (the API returns at most 1000 per request) */
async function pages<T>(make: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, max = 60_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < max; from += 1000) {
    const { data, error } = await make(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]);
    }
  }));
  return out;
}

async function base(admin: SupabaseClient) {
  const [{ data: clients }, { data: seats }, { data: people }, { data: targets }] = await Promise.all([
    admin.from("clients").select("id, name, slug, status, created_at, website, services, services_extra, services_removed, strategy_only, slack_channel_id").is("archived_at", null).in("status", LIVE),
    admin.from("client_assignments").select("client_id, profile_id, role, is_primary"),
    admin.from("profiles").select("id, full_name, display_name, email, role, is_active, platform_aliases"),
    admin.from("kpi_targets").select("id, client_id, platform, ad_account_id, owner_id, monthly_budget").eq("active", true).not("ad_account_id", "is", null),
  ]);
  const team = (people ?? []) as Profile[];
  const active = new Set(team.filter((p) => p.is_active).map((p) => p.id));
  const headsOf = (role: string) => team.filter((p) => p.is_active && p.role === role).map((p) => p.id);
  const seatsOf = (clientId: string, roles: string[]) =>
    (seats ?? [])
      .filter((s) => s.client_id === clientId && roles.includes(s.role as string) && active.has(s.profile_id as string))
      .sort((a, b) => Number(b.is_primary) - Number(a.is_primary))
      .map((s) => s.profile_id as string);
  /** The account owner (the seat holders, active only) and that line's head: never anyone who left */
  const ownerAndHead = (clientId: string, line: ReviewLine, extra: (string | null)[] = []) => uniq([...extra.filter((x) => x && active.has(x)), ...seatsOf(clientId, LINE_SEATS[line]), ...headsOf(LINE_HEAD[line])]);
  return { clients: (clients ?? []) as Client[], team, active, headsOf, seatsOf, ownerAndHead, targets: (targets ?? []) as Target[] };
}

export async function runWatchdogs(admin: SupabaseClient, now = new Date()) {
  const today = nyDay(now);
  const b = await base(admin);
  const byId = new Map(b.clients.map((c) => [c.id, c]));
  const findings: Finding[] = [];
  const push = (f: Omit<Finding, "line" | "account"> & { line?: string | null; account?: string | null }) => {
    if (!f.to.length) return;
    findings.push({ line: null, account: null, ...f });
  };
  // The tracking specialists hear every tracking signal (spend with no results or landing page views, leads with no CRM
  // sync, the audits, platform vs store, conversion rate drops)
  const trackers = b.headsOf("tracking_specialist");
  const metaTargets = b.targets.filter((t) => t.platform === "meta" && byId.has(t.client_id) && hasLine(byId.get(t.client_id)!, "meta"));
  const adTargets = b.targets.filter((t) => (t.platform === "meta" || t.platform === "google") && byId.has(t.client_id) && hasLine(byId.get(t.client_id)!, t.platform === "google" ? "google" : "meta"));
  const accountClient = new Map(adTargets.map((t) => [accountKey(t.platform, t.ad_account_id), t]));
  const metaAccounts = uniq(metaTargets.map((t) => accountKey("meta", t.ad_account_id)));
  const since3 = addDays(today, -3);
  const sinceIso2 = new Date(now.getTime() - 2 * DAY).toISOString();

  const since7 = addDays(today, -7);
  const googleAccounts = uniq(adTargets.filter((t) => t.platform === "google").map((t) => accountKey("google", t.ad_account_id)));
  type DailyRow = { ad_account_id: string; campaign_id: string; campaign_name: string; date: string; spend: number; link_clicks: number | null; actions: Record<string, number> | null };
  const [daily, prior, changes, { data: activity }, { data: social }, { data: klaviyo }, { data: integrations }, { data: contacts }, memory, chatter, { data: stuck }, { data: emailStuck }, googleDaily, storeDays, audits] = await Promise.all([
    metaAccounts.length ? pages<DailyRow>((a, z) => admin.from("meta_campaign_daily").select("ad_account_id, campaign_id, campaign_name, date, spend, link_clicks, actions").in("ad_account_id", metaAccounts).gte("date", since7).lt("date", today).order("date").range(a, z)) : Promise.resolve([] as DailyRow[]),
    metaAccounts.length ? pages<DailyRow>((a, z) => admin.from("meta_campaign_daily").select("ad_account_id, campaign_id, campaign_name, date, spend, link_clicks, actions").in("ad_account_id", metaAccounts).gte("date", addDays(today, -31)).lt("date", since3).order("date").range(a, z)) : Promise.resolve([] as DailyRow[]),
    pages<{ ad_account_id: string; platform: string; at: string; who: string | null; what: string; object: string | null }>((a, z) => admin.from("ad_account_changes").select("ad_account_id, platform, at, who, what, object").gte("at", sinceIso2).order("at", { ascending: false }).range(a, z), 10_000),
    admin.from("ad_account_activity").select("ad_account_id, error, checked_at"),
    admin.from("social_accounts").select("client_id, page_name, ig_username, status, last_error, missing_permissions"),
    admin.from("klaviyo_connections").select("client_id, status, last_error, last_synced_at"),
    admin.from("client_integrations").select("client_id, kind, label, status, last_error, last_synced_at"),
    admin.from("contact_clients").select("client_id, contacts(full_name, email)").is("removed_at", null).limit(5000),
    pages<{ client_id: string; body: string }>((a, z) => admin.from("client_memory").select("client_id, body").or("body.ilike.%approv%,body.ilike.%sign off%,body.ilike.%sign-off%,body.ilike.%signoff%,body.ilike.%run it by%,body.ilike.%check with%").order("id").range(a, z), 10_000),
    pages<{ client_id: string; source: string; author: string | null; occurred_at: string; body: string | null }>((a, z) => admin.from("context_items").select("client_id, source, author, occurred_at, body").in("source", ["slack_external", "gmail", "slack_internal"]).gte("occurred_at", new Date(now.getTime() - 8 * DAY).toISOString()).order("occurred_at", { ascending: false }).range(a, z), 30_000),
    admin.from("requests").select("number, title, client_id, stage, stage_entered_at, assignee_id").is("deleted_at", null).not("stage", "in", "(launched)").lte("stage_entered_at", new Date(now.getTime() - 7 * DAY).toISOString()).limit(1000),
    admin.from("email_tickets").select("number, title, client_id, stage, stage_entered_at, assignee_id").is("deleted_at", null).not("stage", "in", "(live,done,sent,archived)").lte("stage_entered_at", new Date(now.getTime() - 7 * DAY).toISOString()).limit(1000),
    googleAccounts.length ? pages<{ ad_account_id: string; actions: Record<string, number> | null }>((a, z) => admin.from("google_campaign_daily").select("ad_account_id, actions").in("ad_account_id", googleAccounts).gte("date", since7).lt("date", today).order("date").range(a, z)) : Promise.resolve([] as { ad_account_id: string; actions: Record<string, number> | null }[]),
    pages<{ client_id: string; store_orders: number | null }>((a, z) => admin.from("klaviyo_daily").select("client_id, store_orders").gte("date", since7).lt("date", today).gt("store_orders", 0).order("date").range(a, z)),
    pages<{ id: string; target_id: string; client_id: string; created_at: string; tracking: unknown }>((a, z) => admin.from("account_audits").select("id, target_id, client_id, created_at, tracking:result->tracking").eq("status", "ready").gte("created_at", new Date(now.getTime() - 30 * DAY).toISOString()).order("created_at", { ascending: false }).range(a, z), 5000),
  ]);

  // Who's who in change history: our team, the client's people
  const contactNames = new Map<string, Set<string>>();
  for (const r of contacts ?? []) {
    const ct = (r as unknown as { contacts: { full_name: string | null; email: string | null } | null }).contacts;
    const set = contactNames.get(r.client_id as string) ?? new Set<string>();
    if (ct?.full_name) set.add(ct.full_name.toLowerCase().trim());
    if (ct?.email) set.add(ct.email.toLowerCase().trim());
    contactNames.set(r.client_id as string, set);
  }
  const ours = (who: string | null) => Boolean(who) && (isKaizenEmail(who) || Boolean(matchActor(who, b.team)));
  const theirs = (who: string | null, clientId: string) => {
    const w = String(who ?? "").toLowerCase().trim();
    if (!w || isAutomated(who) || ours(who)) return false;
    const set = contactNames.get(clientId);
    if (set?.has(w)) return true;
    const domains = [...(set ?? [])].filter((x) => x.includes("@")).map((x) => x.split("@")[1]).filter((d) => d && !/gmail|yahoo|hotmail|outlook|icloud|aol/.test(d));
    return w.includes("@") && domains.includes(w.split("@")[1]);
  };
  const signoffClients = new Set<string>();
  const notesBy = new Map<string, string[]>();
  for (const m of memory) notesBy.set(m.client_id as string, [...(notesBy.get(m.client_id as string) ?? []), String(m.body ?? "")]);
  for (const [id, notes] of notesBy) if (needsSignoff(notes)) signoffClients.add(id);
  const items = chatter as { client_id: string; source: string; author: string | null; occurred_at: string; body: string | null }[];
  const isTeamAuthor = (a: string | null) => Boolean(a) && (/@kaizenmarketing\.agency/i.test(a!) || Boolean(matchActor(a!.replace(/<[^>]*>/g, "").trim(), b.team)));
  for (const m of items) if (m.source === "slack_internal" && needsSignoff([m.body])) signoffClients.add(m.client_id);

  // ─── 1. Change history: the client pausing or editing, access removed, our moves without sign-off ─────
  const byAccChanges = new Map<string, { at: string; who: string | null; what: string; object: string | null; platform: string }[]>();
  for (const x of changes as { ad_account_id: string; platform: string; at: string; who: string | null; what: string; object: string | null }[]) byAccChanges.set(x.ad_account_id, [...(byAccChanges.get(x.ad_account_id) ?? []), x]);
  for (const [acc, list] of byAccChanges) {
    const t = accountClient.get(acc);
    if (!t) continue;
    const c = byId.get(t.client_id)!;
    const line: ReviewLine = t.platform === "google" ? "google" : "meta";
    const label = t.platform === "google" ? "Google" : "Meta";
    const to = b.ownerAndHead(c.id, line, [t.owner_id]);
    const base = { client_id: c.id, line: line === "google" ? "google-ads" : "facebook-ads", account: acc, href: `/kpis?target=${t.id}` };
    const client = list.filter((x) => theirs(x.who, c.id));
    const pauses = client.filter((x) => isPauseChange(x.what));
    const edits = client.filter((x) => !isPauseChange(x.what));
    if (pauses.length || edits.length) {
      const day = pauses[0]?.at ?? edits[0].at;
      push({
        ...base,
        key: `client_changed:${acc}:${nyDay(new Date(day))}`,
        kind: "client_changed",
        title: pauses.length ? `The client paused ${pauses.length === 1 ? (pauses[0].object ? `"${clip(pauses[0].object, 50)}"` : "a campaign") : `${pauses.length} things`} in ${label}` : `The client edited their ${label} account (${edits.length} change${edits.length === 1 ? "" : "s"})`,
        body: `${[...pauses, ...edits].slice(0, 4).map((x) => `${clip(x.who, 30)}: ${clip(x.what, 70)}${x.object ? ` on ${clip(x.object, 40)}` : ""} (${shortDay(nyDay(new Date(x.at)))})`).join("; ")}. Ask them why today and agree what happens next.`,
        detail: { changes: [...pauses, ...edits].slice(0, 20) },
        severity: pauses.length ? "critical" : "warn",
        to,
      });
    }
    const removal = list.filter((x) => isAccessRemoval(x.what));
    if (removal.length)
      push({
        ...base,
        key: `admin_removal:${acc}:${nyDay(new Date(removal[0].at))}`,
        kind: "admin_removal",
        title: `Access removed on the ${label} account by ${clip(removal[0].who, 40) || "someone"}`,
        body: `${removal.slice(0, 3).map((x) => `${clip(x.what, 80)} (${shortDay(nyDay(new Date(x.at)))})`).join("; ")}. Check we still have what we need, and ask the client if it wasn't agreed.`,
        detail: { changes: removal.slice(0, 10) },
        severity: "critical",
        to: uniq([...to, ...b.headsOf("executive")]),
      });
    if (signoffClients.has(c.id)) {
      const yeses = items.filter((m) => m.client_id === c.id && m.source !== "slack_internal" && isHumanAuthor(m.author) && !isTeamAuthor(m.author) && soundsApproved(m.body)).map((m) => Date.parse(m.occurred_at));
      const moves = list.filter((x) => ours(x.who) && isBudgetOrTargeting(x.what) && !yeses.some((y) => y <= Date.parse(x.at) && Date.parse(x.at) - y <= 3 * DAY));
      if (moves.length)
        push({
          ...base,
          key: `unapproved_change:${acc}:${nyDay(new Date(moves[0].at))}`,
          kind: "unapproved_change",
          title: `${moves.length} budget or targeting change${moves.length === 1 ? "" : "s"} without the client's sign-off`,
          body: `${moves.slice(0, 3).map((x) => `${clip(x.who, 30)}: ${clip(x.what, 70)}${x.object ? ` on ${clip(x.object, 40)}` : ""}`).join("; ")}. This client's notes say budget and targeting changes need their OK first. Get it today, or roll it back.`,
          detail: { changes: moves.slice(0, 10), confidence: "likely" },
          severity: "warn",
          to,
        });
    }
  }

  // ─── 2. Spend with nothing to show, and new lead sources ────────────────────
  type Row = { ad_account_id: string; campaign_id: string; campaign_name: string; date: string; spend: number; link_clicks: number | null; actions: Record<string, number> | null };
  const byCampaign = new Map<string, { acc: string; name: string; spend: number; clicks: number; lpv: number; results: number; leads: number }>();
  for (const r of (daily as Row[]).filter((x) => x.date >= since3)) {
    const k = `${r.ad_account_id}:${r.campaign_id}`;
    const cur = byCampaign.get(k) ?? { acc: r.ad_account_id, name: r.campaign_name, spend: 0, clicks: 0, lpv: 0, results: 0, leads: 0 };
    cur.spend += Number(r.spend) || 0;
    cur.clicks += Number(r.link_clicks ?? r.actions?.link_click ?? 0);
    cur.lpv += Number(r.actions?.landing_page_view ?? r.actions?.omni_landing_page_view ?? 0);
    cur.results += resultsOf(r.actions);
    cur.leads += leadsOf(r.actions);
    byCampaign.set(k, cur);
  }
  const zero = new Map<string, { names: string[]; spend: number; text: string }>();
  const leadsNow = new Map<string, number>();
  for (const v of byCampaign.values()) {
    leadsNow.set(v.acc, (leadsNow.get(v.acc) ?? 0) + v.leads);
    // Awareness, reach and engagement campaigns don't owe results; boosts send nobody to a site
    if (/reach|awareness|engagement|boost|brand|video views?|\bvv\b|followers?|page likes/i.test(v.name)) continue;
    const z = zeroOutcome({ spend: v.spend, linkClicks: v.clicks, landingPageViews: v.lpv, results: v.results }, { expectsSite: !/lead ?form|instant form|messag|call/i.test(v.name) });
    if (!z) continue;
    const k = `${v.acc}:${z.kind}`;
    const cur = zero.get(k) ?? { names: [], spend: 0, text: z.text };
    cur.names.push(v.name);
    cur.spend += v.spend;
    zero.set(k, cur);
  }
  for (const [k, z] of zero) {
    const [acc, kind] = k.split(":");
    const t = accountClient.get(acc);
    if (!t) continue;
    push({
      client_id: t.client_id,
      line: "facebook-ads",
      account: acc,
      key: `zero_results:${acc}:${kind}`,
      kind: "zero_results",
      title: kind === "no_lpv" ? `Meta spend with zero landing page views ($${Math.round(z.spend).toLocaleString("en-US")} in 3 days)` : `Meta spend with zero results ($${Math.round(z.spend).toLocaleString("en-US")} in 3 days)`,
      body: `${z.names.slice(0, 3).map((n) => `"${clip(n, 50)}"`).join(", ")}: ${z.text}. Check the pixel, the landing page and the conversion event today.`,
      detail: { campaigns: z.names.slice(0, 10), spend: z.spend, kind },
      severity: "critical",
      href: `/kpis?target=${t.id}`,
      to: uniq([...b.ownerAndHead(t.client_id, "meta", [t.owner_id]), ...trackers]),
    });
  }
  const leadsBefore = new Map<string, number>();
  for (const r of prior.filter((x) => x.date >= addDays(today, -17))) leadsBefore.set(r.ad_account_id, (leadsBefore.get(r.ad_account_id) ?? 0) + leadsOf(r.actions));
  const crmSynced = new Set(((integrations ?? []) as { client_id: string; kind: string; last_synced_at: string | null; status: string | null }[]).filter((i) => /crm|gohighlevel|ghl|hubspot|salesforce|zoho|pipedrive|keap/i.test(i.kind) && i.last_synced_at && Date.parse(i.last_synced_at) > now.getTime() - 3 * DAY).map((i) => i.client_id));
  for (const acc of metaAccounts) {
    const t = accountClient.get(acc);
    if (!t || crmSynced.has(t.client_id)) continue;
    const newForm = (byAccChanges.get(acc) ?? []).find((x) => /lead ?form|instant form|leadgen/i.test(`${x.what} ${x.object ?? ""}`) && /creat|add|publish|new/i.test(x.what));
    const newSource = (leadsNow.get(acc) ?? 0) > 0 && (leadsBefore.get(acc) ?? 0) === 0;
    if (!newForm && !newSource) continue;
    push({
      client_id: t.client_id,
      line: "facebook-ads",
      account: acc,
      key: `lead_no_crm:${acc}`,
      kind: "lead_no_crm",
      title: newForm ? "New lead form, and no CRM sync on record" : `New leads coming in (${leadsNow.get(acc)} in 3 days) with no CRM sync on record`,
      body: `${newForm ? `${clip(newForm.what, 70)}${newForm.object ? ` (${clip(newForm.object, 40)})` : ""}. ` : ""}No CRM connected in Kaizen OS has synced in 3 days, so nobody can see these leads land. Confirm where they go and that someone follows up.`,
      detail: { newForm: newForm ?? null, leads: leadsNow.get(acc) ?? 0 },
      severity: "warn",
      href: `/kpis?target=${t.id}`,
      to: uniq([...b.ownerAndHead(t.client_id, "meta", [t.owner_id]), ...trackers]),
    });
  }

  // ─── 3. Meta account health: payment, delivery, special categories, ads past their event ─────
  const spending = new Set([...byCampaign.values()].filter((v) => v.spend > 0).map((v) => v.acc));
  const { accountHealth } = await import("@/lib/context/meta");
  const health = await pool(metaAccounts, 4, async (acc) => ({ acc, h: await accountHealth(acc).catch(() => null) }));
  for (const { acc, h } of health) {
    const t = accountClient.get(acc);
    if (!t || !h) continue;
    const to = b.ownerAndHead(t.client_id, "meta", [t.owner_id]);
    const base = { client_id: t.client_id, line: "facebook-ads", account: acc, href: `/kpis?target=${t.id}` };
    const st = accountStatusIssue(h.account, spending.has(acc));
    if (st) push({ ...base, key: `${st.kind}:${acc}`, kind: st.kind, title: st.title, body: "Meta will stop (or has stopped) delivering. Fix it in Business Settings today, or get the client to.", detail: { account_status: h.account?.account_status ?? null, disable_reason: h.account?.disable_reason ?? null }, severity: st.critical ? "critical" : "warn", to });
    const issues = (h.campaigns ?? []).filter((c) => c.effective_status === "WITH_ISSUES" || (c.issues_info ?? []).length);
    const rejected = (h.ads ?? []).filter((a) => a.effective_status === "DISAPPROVED");
    if (issues.length || rejected.length)
      push({
        ...base,
        key: `delivery_issue:${acc}:campaigns`,
        kind: "delivery_issue",
        title: `${issues.length ? `${issues.length} campaign${issues.length === 1 ? "" : "s"} with delivery issues` : ""}${issues.length && rejected.length ? ", " : ""}${rejected.length ? `${rejected.length} ad${rejected.length === 1 ? "" : "s"} disapproved` : ""} on Meta`,
        body: `${[...issues.map((c) => `"${clip(c.name, 50)}": ${clip(c.issues_info?.[0]?.error_summary ?? c.issues_info?.[0]?.error_message ?? "with issues", 80)}`), ...rejected.slice(0, 3).map((a) => `"${clip(a.name, 50)}" disapproved`)].slice(0, 4).join("; ")}.`,
        detail: { campaigns: issues.map((c) => c.name).slice(0, 10), ads: rejected.map((a) => a.name).slice(0, 10) },
        severity: "warn",
        to,
      });
    const campaignName = new Map((h.campaigns ?? []).map((c) => [c.id, c.name]));
    // Special ad categories: a live campaign that reads as housing, employment or credit without the category
    for (const c of (h.campaigns ?? []).filter((x) => x.effective_status === "ACTIVE")) {
      const text = [c.name, ...(h.ads ?? []).filter((a) => a.campaign_id === c.id).map((a) => `${a.name} ${a.creative?.title ?? ""} ${a.creative?.body ?? ""}`)].join(" \n ");
      const miss = missingSpecialCategory(text, c.special_ad_categories);
      if (miss)
        push({
          ...base,
          key: `special_category:${acc}:${c.id}`,
          kind: "special_category",
          title: `"${clip(c.name, 50)}" reads as a ${miss.label} offer without Meta's special ad category`,
          body: `Housing, employment and credit offers must run in their special ad category, or Meta can reject the ads and restrict the account. Check the offer and move it to a campaign with the ${miss.label} category if it is one.`,
          detail: { campaign: c.name, category: miss.category, confidence: "likely" },
          severity: "warn",
          to,
        });
    }
    // Ads still running past their event (Halloween ads in November)
    const past = new Map<string, { event: string; date: string; ads: string[] }>();
    for (const a of (h.ads ?? []).filter((x) => x.effective_status === "ACTIVE")) {
      const p = pastEvent(`${a.name} ${campaignName.get(a.campaign_id ?? "") ?? ""} ${a.creative?.title ?? ""} ${a.creative?.body ?? ""}`, today);
      if (!p) continue;
      const cur = past.get(p.event) ?? { ...p, ads: [] };
      cur.ads.push(a.name);
      past.set(p.event, cur);
    }
    for (const p of past.values())
      push({
        ...base,
        key: `past_event:${acc}:${p.event}:${p.date}`,
        kind: "past_event",
        title: `${p.ads.length} ad${p.ads.length === 1 ? "" : "s"} still running after ${p.event}`,
        body: `${p.ads.slice(0, 4).map((n) => `"${clip(n, 50)}"`).join(", ")} still live, and ${p.event} was ${shortDay(p.date)}. Turn them off or swap the creative today.`,
        detail: { event: p.event, date: p.date, ads: p.ads.slice(0, 20) },
        severity: "warn",
        to,
      });
  }

  // ─── 4. Lost access and integrations losing authorization ──────────────────
  for (const a of (activity ?? []) as { ad_account_id: string; error: string | null }[]) {
    const t = accountClient.get(a.ad_account_id);
    if (!t || !isAccessError(a.error)) continue;
    const line: ReviewLine = t.platform === "google" ? "google" : "meta";
    push({ client_id: t.client_id, line: line === "google" ? "google-ads" : "facebook-ads", account: a.ad_account_id, key: `access_lost:${a.ad_account_id}`, kind: "access_lost", title: `Lost access to the ${t.platform === "google" ? "Google" : "Meta"} ad account`, body: `Kaizen OS can't read it: ${clip(a.error, 160)}. Ask the client to restore our access today.`, detail: { error: a.error }, severity: "critical", href: `/kpis?target=${t.id}`, to: b.ownerAndHead(t.client_id, line, [t.owner_id]) });
  }
  for (const s of (social ?? []) as { client_id: string; page_name: string | null; ig_username: string | null; status: string | null; last_error: string | null; missing_permissions: unknown }[]) {
    const c = byId.get(s.client_id);
    if (!c || !hasLine(c, "social") || !(isAccessError(s.last_error) || (Array.isArray(s.missing_permissions) && s.missing_permissions.length) || /revoked|lost|error|disconnected/i.test(String(s.status ?? "")))) continue;
    push({ client_id: c.id, line: "social-media", key: `access_lost:social:${c.id}`, kind: "access_lost", title: `Lost access to ${clip(s.page_name ?? s.ig_username ?? "the social account", 40)}`, body: `${clip(s.last_error ?? (Array.isArray(s.missing_permissions) ? `Missing permissions: ${s.missing_permissions.join(", ")}` : s.status), 160)}. Get the Page access back so posts and numbers keep flowing.`, detail: { status: s.status, error: s.last_error }, severity: "warn", href: `/clients/${c.slug}?service=social`, to: b.ownerAndHead(c.id, "social") });
  }
  for (const k of (klaviyo ?? []) as { client_id: string; status: string | null; last_error: string | null }[]) {
    const c = byId.get(k.client_id);
    if (!c || !hasLine(c, "email") || !(isAuthError(k.last_error) || /revoked|invalid|disconnected|error/i.test(String(k.status ?? "")))) continue;
    push({ client_id: c.id, line: "email-marketing", key: `integration_auth:klaviyo:${c.id}`, kind: "integration_auth", title: "Klaviyo lost its authorization", body: `${clip(k.last_error ?? k.status, 160)}. Reconnect Klaviyo, and check Klaviyo's own Meta and Shopify integrations while you're there.`, detail: { status: k.status, error: k.last_error }, severity: "critical", href: `/clients/${c.slug}?service=email`, to: b.ownerAndHead(c.id, "email") });
  }
  for (const i of (integrations ?? []) as { client_id: string; kind: string; label: string | null; last_error: string | null }[]) {
    const c = byId.get(i.client_id);
    if (!c || !isAuthError(i.last_error)) continue;
    const line = reviewLinesFor(c)[0]?.line ?? "meta";
    push({ client_id: c.id, line: null, key: `integration_auth:${i.kind}:${c.id}`, kind: "integration_auth", title: `${clip(i.label ?? i.kind, 30)} lost its authorization`, body: `${clip(i.last_error, 160)}. Reconnect it so orders and leads keep syncing.`, detail: { kind: i.kind, error: i.last_error }, severity: "warn", href: `/clients/${c.slug}`, to: b.ownerAndHead(c.id, line) });
  }

  // ─── 5. No human update in the client channels for 5 days ──────────────────
  const lastTouch = new Map<string, string>();
  for (const m of items) if (m.source !== "slack_internal" && isHumanAuthor(m.author) && isTeamAuthor(m.author) && !lastTouch.has(m.client_id)) lastTouch.set(m.client_id, m.occurred_at);
  for (const c of b.clients) {
    const lines = reviewLinesFor(c);
    if (!lines.length || daysBetween(c.created_at.slice(0, 10), today) < 5) continue;
    const last = lastTouch.get(c.id) ?? null;
    const days = last ? daysBetween(nyDay(new Date(last)), today) : null;
    if (!quietFor(days)) continue;
    const line = lines[0].line;
    push({
      client_id: c.id,
      key: `quiet_channel:${c.id}`,
      kind: "quiet_channel",
      title: days == null ? "No update from us to the client in over a week" : `No update from us to the client in ${days} days`,
      body: `Nobody on our team has posted in their channel or emailed them${last ? ` since ${shortDay(nyDay(new Date(last)))}` : " in the last 8 days"}. Post a real update today: what we did, what's next.`,
      detail: { last, days },
      severity: days == null || days >= 8 ? "critical" : "warn",
      href: `/clients/${c.slug}`,
      to: b.ownerAndHead(c.id, line),
    });
  }

  // ─── 6. Creative stuck 7 days on a board or with one person ────────────────
  for (const r of (stuck ?? []) as { number: number; title: string; client_id: string; stage: string; stage_entered_at: string; assignee_id: string | null }[]) {
    const c = byId.get(r.client_id);
    const d = stuckDays(r.stage, r.stage_entered_at, today);
    if (!c || d == null) continue;
    push({ client_id: c.id, line: "creative", key: `creative_stuck:req:${r.number}:${r.stage}`, kind: "creative_stuck", title: `#${r.number} stuck ${d} days in ${r.stage.replace(/_/g, " ")}`, body: `"${clip(r.title, 80)}" hasn't moved in ${d} days. Unblock it or say what it's waiting on.`, detail: { number: r.number, stage: r.stage, days: d }, severity: d >= 14 ? "critical" : "warn", href: `/board?t=${r.number}`, to: uniq([r.assignee_id && b.active.has(r.assignee_id) ? r.assignee_id : null, ...b.headsOf("head_of_creative")]) });
  }
  for (const r of (emailStuck ?? []) as { number: number; title: string; client_id: string; stage: string; stage_entered_at: string; assignee_id: string | null }[]) {
    const c = byId.get(r.client_id);
    const d = stuckDays(r.stage, r.stage_entered_at, today);
    if (!c || d == null || !hasLine(c, "email")) continue;
    push({ client_id: c.id, line: "email-marketing", key: `creative_stuck:email:${r.number}:${r.stage}`, kind: "creative_stuck", title: `Email #${r.number} stuck ${d} days in ${r.stage.replace(/_/g, " ")}`, body: `"${clip(r.title, 80)}" hasn't moved in ${d} days. Unblock it or say what it's waiting on.`, detail: { number: r.number, stage: r.stage, days: d }, severity: d >= 14 ? "critical" : "warn", href: `/board/email?t=${r.number}`, to: uniq([r.assignee_id && b.active.has(r.assignee_id) ? r.assignee_id : null, ...b.headsOf("head_of_email")]) });
  }

  // ─── 7. Big dates coming with nothing built (BFCM emails about 10 days out) ─────
  const ahead = bigDatesAhead(today, 10);
  if (ahead.length) {
    const emailClients = b.clients.filter((c) => hasLine(c, "email") && !(c.strategy_only ?? []).includes("email-marketing"));
    const ids = emailClients.map((c) => c.id);
    const last = ahead.map((a) => a.date).sort().pop()!;
    const [{ data: camps }, { data: tickets }] = ids.length
      ? await Promise.all([
          admin.from("klaviyo_campaigns").select("client_id, name, subject, send_time").in("client_id", ids).gte("send_time", new Date(now.getTime() - 3 * DAY).toISOString()).lte("send_time", `${addDays(last, 2)}T23:59:59Z`).limit(5000),
          admin.from("email_tickets").select("client_id, title, brief").in("client_id", ids).is("deleted_at", null).gte("created_at", new Date(now.getTime() - 60 * DAY).toISOString()).limit(5000),
        ])
      : [{ data: [] }, { data: [] }];
    for (const c of emailClients) {
      for (const a of ahead) {
        const built = (camps ?? []).some((x) => x.client_id === c.id && a.match.test(`${x.name ?? ""} ${x.subject ?? ""}`)) || (tickets ?? []).some((x) => x.client_id === c.id && a.match.test(`${x.title ?? ""} ${typeof x.brief === "string" ? x.brief : JSON.stringify(x.brief ?? "")}`));
        if (built) continue;
        push({ client_id: c.id, line: "email-marketing", key: `big_date:${c.id}:${a.key}:${a.date}`, kind: "big_date", title: `${a.name} is ${a.days === 0 ? "today" : `${a.days} day${a.days === 1 ? "" : "s"} out`} and no ${a.name} email is built`, body: `Nothing scheduled in Klaviyo and no ticket on the Email Board for ${a.name} (${shortDay(a.date)}). Get it briefed and built now.`, detail: { event: a.name, date: a.date, days: a.days }, severity: a.days <= 5 ? "critical" : "warn", href: `/clients/${c.slug}?service=email`, to: b.ownerAndHead(c.id, "email") });
      }
    }
  }

  // ─── 8. Tracking: audits that found tracking problems, platforms vs the store, conversion rate dropping ─────
  // The tracking specialists hear every one of these too (their Today reads TRACKING_KINDS)
  const targetById = new Map(b.targets.map((t) => [t.id, t]));
  const seenAudit = new Set<string>();
  for (const a of audits) {
    if (seenAudit.has(a.target_id)) continue;
    seenAudit.add(a.target_id);
    const t = targetById.get(a.target_id);
    const c = byId.get(a.client_id);
    if (!t || !c) continue;
    const line: ReviewLine = t.platform === "google" ? "google" : "meta";
    if (!hasLine(c, line)) continue;
    const problems = trackingProblems(a.tracking);
    if (!problems.length) continue;
    push({ client_id: c.id, line: line === "google" ? "google-ads" : "facebook-ads", account: accountKey(t.platform, t.ad_account_id), key: `tracking_audit:${a.target_id}`, kind: "tracking_audit", title: `The ${line === "google" ? "Google" : "Meta"} audit found ${problems.length} tracking problem${problems.length === 1 ? "" : "s"}`, body: `${problems.slice(0, 2).map((x) => clip(x, 200)).join(" ")} (audit of ${shortDay(nyDay(new Date(a.created_at)))}).`, detail: { audit: a.id, problems: problems.slice(0, 8) }, severity: "warn", href: `/kpis/audit/${a.id}`, to: uniq([...b.ownerAndHead(c.id, line, [t.owner_id]), ...trackers]) });
  }
  // Platforms vs the store (7 days): Meta purchases, Google purchase conversions, the store's orders through Klaviyo
  const purchases = (x: Record<string, number> | null) => Math.max(Number(x?.purchase ?? 0), Number(x?.omni_purchase ?? 0), Number(x?.["offsite_conversion.fb_pixel_purchase"] ?? 0));
  const metaBuy = new Map<string, number>();
  for (const r of daily as Row[]) {
    const t = accountClient.get(r.ad_account_id);
    if (t) metaBuy.set(t.client_id, (metaBuy.get(t.client_id) ?? 0) + purchases(r.actions));
  }
  const googleBuy = new Map<string, number>();
  for (const r of googleDaily) {
    const t = accountClient.get(r.ad_account_id);
    if (!t) continue;
    const n = Object.entries(r.actions ?? {}).filter(([k]) => /^action:.*purchase/i.test(k)).reduce((x, [, v]) => x + Number(v || 0), 0);
    googleBuy.set(t.client_id, (googleBuy.get(t.client_id) ?? 0) + n);
  }
  const store = new Map<string, number>();
  for (const r of storeDays) store.set(r.client_id, (store.get(r.client_id) ?? 0) + Number(r.store_orders ?? 0));
  for (const [clientId, orders] of store) {
    const c = byId.get(clientId);
    if (!c || !(hasLine(c, "meta") || hasLine(c, "google"))) continue;
    const gap = conversionGap({ meta: hasLine(c, "meta") ? (metaBuy.get(clientId) ?? 0) : 0, google: hasLine(c, "google") ? (googleBuy.get(clientId) ?? 0) : 0, store: orders });
    if (!gap) continue;
    const line: ReviewLine = gap.text.startsWith("Google") ? "google" : "meta";
    push({ client_id: c.id, line: line === "google" ? "google-ads" : "facebook-ads", key: `tracking_mismatch:${c.id}:${gap.kind}`, kind: "tracking_mismatch", title: gap.kind === "double" ? "Meta and Google are counting the same orders" : gap.kind === "under" ? "The ad platforms are missing most of the store's orders" : `${line === "google" ? "Google" : "Meta"} claims more purchases than the store saw`, body: `${gap.text} in the last 7 days. Check the pixel, Conversions API, deduplication and the conversion settings, and never add the platforms' numbers together for this client.`, detail: { meta: metaBuy.get(clientId) ?? 0, google: googleBuy.get(clientId) ?? 0, store: orders, kind: gap.kind }, severity: "warn", href: `/clients/${c.slug}`, to: uniq([...b.ownerAndHead(c.id, line), ...trackers]) });
  }
  // Conversion rate dropping abnormally: the last 3 days against the 28 before, per Meta account
  const cvr = new Map<string, { rc: number; rr: number; bc: number; br: number }>();
  const skipName = /reach|awareness|engagement|boost|brand|video views?|followers?|page likes/i;
  for (const r of [...(daily as Row[]).filter((x) => x.date >= since3), ...prior]) {
    if (skipName.test(r.campaign_name ?? "")) continue;
    const cur = cvr.get(r.ad_account_id) ?? { rc: 0, rr: 0, bc: 0, br: 0 };
    const clicks = Number(r.link_clicks ?? r.actions?.link_click ?? 0);
    if (r.date >= since3) {
      cur.rc += clicks;
      cur.rr += resultsOf(r.actions);
    } else {
      cur.bc += clicks;
      cur.br += resultsOf(r.actions);
    }
    cvr.set(r.ad_account_id, cur);
  }
  for (const [acc, v] of cvr) {
    const t = accountClient.get(acc);
    const drop = cvrDrop({ recentClicks: v.rc, recentResults: v.rr, baseClicks: v.bc, baseResults: v.br });
    if (!t || !drop) continue;
    push({ client_id: t.client_id, line: "facebook-ads", account: acc, key: `cvr_drop:${acc}`, kind: "cvr_drop", title: `Meta conversion rate fell to ${(drop.recent * 100).toFixed(1)}% from ${(drop.base * 100).toFixed(1)}%`, body: `The last 3 days convert at under half the 28 days before (${Math.round(v.rr)} results on ${Math.round(v.rc)} link clicks). Check the site, the checkout or form, the pixel and any offer change before blaming the ads.`, detail: { recent: drop.recent, base: drop.base, clicks: v.rc, results: v.rr }, severity: "warn", href: `/kpis?target=${t.id}`, to: uniq([...b.ownerAndHead(t.client_id, "meta", [t.owner_id]), ...trackers]) });
  }

  const applied = await applyFindings(admin, findings, b.clients.map((c) => ({ ...c, billed_services: null })), new Map(), now, { owns: (k) => isDogKind(k) && k !== "site_down" && k !== "site_check" && k !== "precall_sync", noticeSuffix: ":dog" });
  return { today, findings: findings.length, accounts: metaAccounts.length, tracking: findings.filter((f) => (TRACKING_KINDS as readonly string[]).includes(f.kind)).length, ...applied };
}

// ─── Websites: uptime hourly, the page check weekly ────────────────────────

async function fetchSite(url: string): Promise<SiteResult & { html: string }> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { redirect: "follow", cache: "no-store", signal: AbortSignal.timeout(15_000), headers: { "user-agent": "Mozilla/5.0 (compatible; KaizenOS-uptime/1.0)" } });
    const html = res.headers.get("content-type")?.includes("html") ? (await res.text()).slice(0, 400_000) : "";
    return { ok: res.status < 500, status: res.status, ms: Date.now() - t0, html };
  } catch (e) {
    return { ok: false, status: null, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e), html: "" };
  }
}

const siteUrl = (w: string | null) => {
  const s = String(w ?? "").trim();
  if (!s) return null;
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
};

/** The web design clients' sites: up or down every hour (two misses in a row alert), the page check on Mondays */
export async function runSiteChecks(admin: SupabaseClient, now = new Date()) {
  const b = await base(admin);
  const weekly = now.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short" }) === "Mon";
  const web = b.clients.filter((c) => servicesOf(c).includes("web-design") && siteUrl(c.website));
  const { data: lastWeekly } = await admin.from("site_checks").select("client_id, checked_at").eq("kind", "page").gte("checked_at", new Date(now.getTime() - 6 * DAY).toISOString());
  const pageDone = new Set((lastWeekly ?? []).map((r) => r.client_id as string));
  const findings: Finding[] = [];
  const results = await pool(web, 4, async (c) => ({ c, r: await fetchSite(siteUrl(c.website)!) }));
  for (const { c, r } of results) {
    const page = weekly && !pageDone.has(c.id) && r.ok ? pageProblems(r.html, r.status ?? 0) : null;
    await admin.from("site_checks").insert({ client_id: c.id, url: siteUrl(c.website), kind: "uptime", ok: r.ok, status: r.status, ms: r.ms, error: r.error ?? null });
    if (page) await admin.from("site_checks").insert({ client_id: c.id, url: siteUrl(c.website), kind: "page", ok: !page.length, status: r.status, ms: r.ms, error: page.join("; ") || null });
    const { data: recent } = await admin.from("site_checks").select("ok, status, ms, error").eq("client_id", c.id).eq("kind", "uptime").order("checked_at", { ascending: false }).limit(2);
    const owners = uniq([...b.seatsOf(c.id, ["meta_buyer", "google_buyer", "email_strategist", "social_manager"]).slice(0, 2), ...b.headsOf("executive")]);
    if (siteDown((recent ?? []) as SiteResult[]))
      findings.push({ client_id: c.id, line: "web-design", account: null, key: `site_down:${c.id}`, kind: "site_down", title: `${clip(c.website, 50)} is down`, body: `Two checks in a row failed (${r.status ? `it answers ${r.status}` : clip(r.error ?? "no answer", 80)}). Any ads sending people there are wasting spend: check it now.`, detail: { status: r.status, error: r.error ?? null }, severity: "critical", href: `/clients/${c.slug}`, to: owners });
    // The weekly page check stays open until the next one passes
    const lastPage = page ?? null;
    if (lastPage && lastPage.length)
      findings.push({ client_id: c.id, line: "web-design", account: null, key: `site_check:${c.id}`, kind: "site_check", title: `Weekly check: ${clip(c.website, 40)} ${lastPage[0]}`, body: `The homepage ${lastPage.join(", ")}. Take a look and fix it.`, detail: { problems: lastPage }, severity: "warn", href: `/clients/${c.slug}`, to: owners });
  }
  // Keep a page-check flag open between weekly checks (only a passing check or a removed service closes it)
  if (!weekly) {
    const { data: open } = await admin.from("watch_flags").select("key, kind, client_id, line, title, body, detail, severity").eq("kind", "site_check").is("resolved_at", null);
    for (const f of open ?? []) if (web.some((c) => c.id === f.client_id)) findings.push({ client_id: f.client_id as string, line: f.line as string, account: null, key: f.key as string, kind: "site_check", title: f.title as string, body: f.body as string, detail: f.detail as Record<string, unknown>, severity: f.severity as "warn", href: "/watch?tab=dogs", to: [] });
  }
  // Old uptime rows: a month is plenty
  await admin.from("site_checks").delete().lt("checked_at", new Date(now.getTime() - 30 * DAY).toISOString());
  const applied = await applyFindings(admin, findings, b.clients.map((c) => ({ ...c, billed_services: null })), new Map(), now, { owns: (k) => k === "site_down" || k === "site_check", noticeSuffix: ":dog" });
  return { sites: web.length, weekly, ...applied };
}
