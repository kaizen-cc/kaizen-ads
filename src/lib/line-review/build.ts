import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { servicesOf } from "@/lib/services";
import { isRiskNote, RISK_DAYS } from "@/lib/client-risk";
import { matchActor, normName, shortDay } from "@/lib/account-watch/core";
import {
  LINE_HEAD,
  LINE_PLATFORMS,
  LINE_SEATS,
  LINE_SERVICES,
  REVIEW_LINE_LABEL,
  actorOf,
  addDays,
  budgetPace,
  combineConversions,
  composeMessage,
  daysBetween,
  isHumanAuthor,
  isPauseChange,
  mention,
  needsSignoff,
  reviewLinesFor,
  riskScore,
  routeTo,
  silentDays,
  todosFor,
  unapprovedChanges,
  usdFmt,
  weekStartOf,
  type Actor,
  type Review,
  type ReviewItem,
  type ReviewLine,
  type Teammate,
} from "./core";

// Builds the weekly account reviews from the database (admin client: the cron and the server actions, after the
// caller's rights are checked). Shared reads (team, seats, ad accounts, KPI snapshots, spend) happen once per run; each
// client's own reads (changes, messages, promises, deliveries) once per client, shared by its lines.

const DAY = 86_400_000;
export const nyDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const accountKey = (platform: string, id: string) => (platform === "google" ? id.replace(/\D/g, "") : id.replace(/^act_/, "").trim());
const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const uniq = <T,>(xs: T[]) => [...new Set(xs)];

type Profile = Teammate & { role: string; is_exec: boolean | null; platform_aliases: string[] | null; email: string | null };
type ClientRow = {
  id: string;
  name: string;
  slug: string;
  status: string;
  archived_at: string | null;
  services: string[] | null;
  services_extra: string[] | null;
  services_removed: string[] | null;
  strategy_only: string[] | null;
  creative_package: boolean | null;
  creative_package_key: string | null;
  email_package_key: string | null;
  social_package_key: string | null;
  internal_slack_channel_id: string | null;
  slack_channel_id: string | null;
  created_at: string;
};
type Target = { id: string; client_id: string; platform: string; ad_account_id: string | null; owner_id: string | null; monthly_budget: number | null; conversion: string | null; target: number | null; label: string | null };
type Snap = { target_id: string; status: string | null; deviation: number | null; windows: Record<string, { spend?: number; value?: number | null; results?: number }> | null };

export const CLIENT_FIELDS =
  "id, name, slug, status, archived_at, services, services_extra, services_removed, strategy_only, creative_package, creative_package_key, email_package_key, social_package_key, internal_slack_channel_id, slack_channel_id, created_at";

export type Shared = {
  today: string;
  team: Profile[];
  seats: { client_id: string; profile_id: string; role: string; is_primary: boolean | null }[];
  targets: Target[];
  snaps: Map<string, Snap>;
  spend: Map<string, { date: string; spend: number }[]>;
  tiers: Map<string, string[]>;
};

async function pages<T>(make: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, max = 40_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < max; from += 1000) {
    const { data, error } = await make(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export async function loadShared(admin: SupabaseClient, now = new Date()): Promise<Shared> {
  const today = nyDay(now);
  const monthStart = `${today.slice(0, 8)}01`;
  const since = addDays(today, -8) < monthStart ? addDays(today, -8) : monthStart;
  const [{ data: people }, { data: seats }, { data: targets }, { data: snaps }, spendRows, { data: picks }, { data: tiers }] = await Promise.all([
    admin.from("profiles").select("id, full_name, display_name, email, role, is_exec, is_active, slack_user_id, platform_aliases"),
    admin.from("client_assignments").select("client_id, profile_id, role, is_primary"),
    admin.from("kpi_targets").select("id, client_id, platform, ad_account_id, owner_id, monthly_budget, conversion, target, label").eq("active", true),
    admin.from("kpi_snapshots").select("target_id, status, deviation, windows"),
    pages<{ platform: string; ad_account_id: string; date: string; spend: number }>((a, b) => admin.rpc("watch_spend_days", { p_since: since }).range(a, b)),
    // The tier picked per service: its name only (a tier's price never leaves the Services panel)
    admin.from("client_service_tiers").select("client_id, service, tier_id"),
    admin.from("service_tiers").select("id, service, label"),
  ]);
  const spend = new Map<string, { date: string; spend: number }[]>();
  for (const r of spendRows) {
    const k = `${r.platform}:${accountKey(r.platform, r.ad_account_id)}`;
    spend.set(k, [...(spend.get(k) ?? []), { date: r.date, spend: Number(r.spend) || 0 }]);
  }
  const tierName = new Map((tiers ?? []).map((t) => [t.id as string, `${t.service}: ${t.label}`]));
  const tierBy = new Map<string, string[]>();
  for (const p of picks ?? []) if (p.tier_id && tierName.has(p.tier_id as string)) tierBy.set(p.client_id as string, [...(tierBy.get(p.client_id as string) ?? []), tierName.get(p.tier_id as string)!]);
  return {
    today,
    team: (people ?? []) as Profile[],
    seats: (seats ?? []) as Shared["seats"],
    targets: (targets ?? []) as Target[],
    snaps: new Map(((snaps ?? []) as Snap[]).map((s) => [s.target_id, s])),
    spend,
    tiers: tierBy,
  };
}

const PLATFORM_NAME: Record<string, string> = { meta: "Meta", google: "Google", tiktok: "TikTok" };

/** Every review for one client (one per line it buys), built from the database. Nothing is saved here. */
export async function buildClientReviews(admin: SupabaseClient, c: ClientRow, s: Shared, onlyLine?: ReviewLine | null): Promise<Review[]> {
  const lines = reviewLinesFor(c).filter((l) => !onlyLine || l.line === onlyLine);
  if (!lines.length) return [];
  const today = s.today;
  const weekFrom = addDays(today, -7);
  const sinceIso = new Date(Date.parse(`${weekFrom}T05:00:00Z`)).toISOString();
  const nowIso = new Date().toISOString();
  const targets = s.targets.filter((t) => t.client_id === c.id && t.ad_account_id);
  const accountKeys = uniq(targets.filter((t) => t.platform === "meta" || t.platform === "google").map((t) => accountKey(t.platform, t.ad_account_id!)));

  const [changes, { data: activity }, { data: contacts }, { data: memory }, { data: chatter }, { data: promises }, { data: owed }, { data: calls }, { data: launches }, { data: done }, { data: sends }, { data: posts }, { data: intake }, { data: onboarding }] = await Promise.all([
    accountKeys.length
      ? admin.from("ad_account_changes").select("ad_account_id, platform, at, who, what, object").in("ad_account_id", accountKeys).gte("at", sinceIso).order("at", { ascending: false }).limit(500).then((r) => r.data ?? [])
      : Promise.resolve([] as { ad_account_id: string; platform: string; at: string; who: string | null; what: string; object: string | null }[]),
    accountKeys.length ? admin.from("ad_account_activity").select("ad_account_id, error, checked_at").in("ad_account_id", accountKeys) : Promise.resolve({ data: [] as { ad_account_id: string; error: string | null; checked_at: string | null }[] }),
    admin.from("contact_clients").select("contacts(full_name, email)").eq("client_id", c.id).is("removed_at", null),
    admin.from("client_memory").select("body, created_at").eq("client_id", c.id).order("created_at", { ascending: false }).limit(300),
    admin.from("context_items").select("source, author, occurred_at, body").eq("client_id", c.id).in("source", ["slack_internal", "slack_external", "gmail"]).gte("occurred_at", new Date(Date.now() - 45 * DAY).toISOString()).order("occurred_at", { ascending: false }).limit(600),
    admin.from("message_promises").select("id, owner_id, what, due_at, status, said_at").eq("client_id", c.id).in("status", ["open", "overdue", "escalated"]).limit(60),
    admin.from("owed_replies").select("id, target_id, from_name, gist, subject, asked_at, status").eq("client_id", c.id).in("status", ["watching", "nudged", "escalated"]).lte("asked_at", new Date(Date.now() - DAY).toISOString()).limit(40),
    admin.from("call_commitments").select("id, kind, what, due_at, routed_to").eq("client_id", c.id).eq("status", "open").lt("due_at", nowIso).gte("due_at", new Date(Date.now() - 30 * DAY).toISOString()).is("merged_into", null).limit(40),
    admin.from("launches").select("id, launched_at").eq("client_id", c.id).not("launched_at", "is", null).gte("launched_at", sinceIso),
    admin.from("requests").select("number").eq("client_id", c.id).is("deleted_at", null).gte("completed_at", sinceIso),
    admin.from("klaviyo_campaigns").select("campaign_id").eq("client_id", c.id).gte("send_time", sinceIso).lte("send_time", nowIso).gt("recipients", 0),
    admin.from("social_posts").select("post_id").eq("client_id", c.id).gte("posted_at", sinceIso),
    admin.from("client_intake_forms").select("status, submitted_at").eq("client_id", c.id).maybeSingle(),
    admin.from("client_onboarding").select("assets").eq("client_id", c.id).maybeSingle(),
  ]);

  const team = s.team;
  const byId = new Map(team.map((p) => [p.id, p]));
  const contactNames = new Set<string>();
  const contactDomains = new Set<string>();
  for (const r of contacts ?? []) {
    const ct = (r as unknown as { contacts: { full_name: string | null; email: string | null } | null }).contacts;
    if (ct?.full_name) contactNames.add(normName(ct.full_name));
    if (ct?.email) {
      contactNames.add(normName(ct.email));
      const d = ct.email.split("@")[1]?.toLowerCase();
      if (d && !/gmail|yahoo|hotmail|outlook|icloud|aol/.test(d)) contactDomains.add(d);
    }
  }
  const actorCtx = { team, contactNames, contactDomains, clientName: c.name };
  const isTeam = (author: string | null) => Boolean(author) && (/@kaizenmarketing\.agency/i.test(author!) || Boolean(matchActor(author!.replace(/<[^>]*>/g, "").trim(), team)));

  // Health: the last real update from our team in each channel (a human, not a bot); email counts for the client side
  const items = (chatter ?? []) as { source: string; author: string | null; occurred_at: string; body: string | null }[];
  const lastTeam = (src: string[]) => items.find((m) => src.includes(m.source) && isHumanAuthor(m.author) && isTeam(m.author))?.occurred_at ?? null;
  const internalSilent = silentDays(lastTeam(["slack_internal"]), today);
  const clientSilent = silentDays(lastTeam(["slack_external", "gmail"]), today);
  const clientMessages = items.filter((m) => m.source !== "slack_internal" && isHumanAuthor(m.author) && !isTeam(m.author)).map((m) => ({ at: m.occurred_at, text: m.body ?? "" }));

  // At risk: verified from the OS (a dated risk note in the client's memory), never guessed
  const notes = ((memory ?? []) as { body: string; created_at: string }[]).map((m) => ({ ...m, body: String(m.body ?? "") }));
  const risk = notes.find((n) => isRiskNote(n.body) && Date.parse(n.created_at) >= Date.now() - RISK_DAYS * DAY);
  const signoff = needsSignoff([...notes.map((n) => n.body), ...items.filter((m) => m.source === "slack_internal").slice(0, 200).map((m) => m.body)]);

  // Onboarding blockers: no delivery dates until the intake form is in
  const blockers: string[] = [];
  if (c.status === "onboarding") {
    const form = intake as { status: string | null; submitted_at: string | null } | null;
    if (!form?.submitted_at) blockers.push(`no intake form yet, ${daysBetween(c.created_at, today)} days in (no delivery dates until it's in)`);
    const assets = (onboarding as { assets: unknown } | null)?.assets;
    if (!assets || (typeof assets === "object" && !Object.keys(assets as object).length)) blockers.push("no brand assets received");
  }

  const readable = new Map(((activity ?? []) as { ad_account_id: string; error: string | null; checked_at: string | null }[]).map((a) => [a.ad_account_id, !a.error && Boolean(a.checked_at) && Date.parse(a.checked_at!) > Date.now() - 3 * DAY]));
  const tagged = (changes as { ad_account_id: string; platform: string; at: string; who: string | null; what: string; object: string | null }[]).map((x) => ({ ...x, actor: actorOf(x.who, actorCtx) as Actor }));

  const dayOfMonth = Number(today.slice(8, 10));
  const daysInMonth = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0).getDate();
  const monthStart = `${today.slice(0, 8)}01`;
  const yesterday = addDays(today, -1);
  const spendOf = (platform: string, acc: string, from: string) => (s.spend.get(`${platform}:${acc}`) ?? []).filter((d) => d.date >= from && d.date <= yesterday).reduce((n, d) => n + d.spend, 0);

  const allAdResults = targets
    .filter((t) => t.platform === "meta" || t.platform === "google" || t.platform === "tiktok")
    .map((t) => ({ platform: t.platform, conversion: t.conversion, results: Number(s.snaps.get(t.id)?.windows?.d7?.results ?? 0) }));

  const out: Review[] = [];
  for (const { line, strategyOnly } of lines) {
    const seatRoles = LINE_SEATS[line];
    const seatHolders = s.seats
      .filter((x) => x.client_id === c.id && seatRoles.includes(x.role))
      .sort((a, b) => Number(b.is_primary) - Number(a.is_primary))
      .map((x) => byId.get(x.profile_id))
      .filter((p): p is Profile => Boolean(p));
    const owner = routeTo(null, seatHolders);
    const linePeople = new Set([...seatHolders.map((p) => p.id), ...team.filter((p) => p.role === LINE_HEAD[line]).map((p) => p.id)]);
    const lineTeamRole = (p: Profile | undefined) => Boolean(p && (p.role === LINE_HEAD[line] || (line === "meta" && p.role === "media_buyer") || (line === "google" && p.role === "google_buyer") || (line === "email" && /^email_/.test(p.role)) || (line === "social" && p.role === "social_media_manager")));
    /** An item is this line's when its person sits on the line (or works on its team); a departed person's goes to the seat holder */
    const forLine = (pid: string | null | undefined) => {
      const p = pid ? byId.get(pid) : undefined;
      if (!p) return null;
      if (!linePeople.has(p.id) && !lineTeamRole(p)) return null;
      const to = routeTo(p, seatHolders);
      return { to, mention: mention(to) };
    };
    const platforms = LINE_PLATFORMS[line];
    const lineTargets = targets.filter((t) => platforms.includes(t.platform) && servicesOf(c).includes(t.platform === "google" ? "google-ads" : t.platform === "tiktok" ? "tiktok-ads" : "facebook-ads"));

    // ─── Scope vs delivered ─────────────────────────────────────────────
    const services = LINE_SERVICES[line].filter((sv) => servicesOf(c).includes(sv));
    const tiers = (s.tiers.get(c.id) ?? []).filter((t) => services.some((sv) => t.startsWith(`${sv}:`)));
    if (line === "email" && c.email_package_key) tiers.push(`Email package: ${c.email_package_key}`);
    if (line === "social" && c.social_package_key) tiers.push(`Social package: ${c.social_package_key}`);
    if (line === "meta" && c.creative_package) tiers.push(`Creative package${c.creative_package_key ? `: ${c.creative_package_key}` : ""}`);
    const delivered: ReviewItem[] = [];
    if (line === "meta" || line === "google") {
      for (const t of uniq(lineTargets.map((x) => `${x.platform}:${accountKey(x.platform, x.ad_account_id!)}`))) {
        const [pl, acc] = t.split(":");
        const wk = spendOf(pl, acc, weekFrom);
        delivered.push({ text: `${PLATFORM_NAME[pl] ?? pl} spend this week: ${usdFmt(wk)}`, confidence: "certain" });
      }
      if (line === "meta") {
        if ((launches ?? []).length) delivered.push({ text: `${(launches ?? []).length} launch${(launches ?? []).length === 1 ? "" : "es"} from Kaizen OS`, confidence: "certain" });
        if (c.creative_package) delivered.push({ text: `${(done ?? []).length} creative piece${(done ?? []).length === 1 ? "" : "s"} delivered`, confidence: "certain" });
      }
      const ours = tagged.filter((x) => (line === "google" ? x.platform === "google" : x.platform !== "google") && x.actor === "us").length;
      delivered.push({ text: `${ours} change${ours === 1 ? "" : "s"} by our team in the account`, confidence: "certain" });
      if (!lineTargets.length) delivered.push({ text: `No ${line === "google" ? "Google" : "Meta"} ad account linked in Kaizen OS, so spend can't be seen`, confidence: "certain" });
    }
    if (line === "email") delivered.push({ text: `${(sends ?? []).length} campaign${(sends ?? []).length === 1 ? "" : "s"} sent (Klaviyo)`, confidence: (sends ?? []).length ? "certain" : "likely" });
    if (line === "social") delivered.push({ text: `${(posts ?? []).length} post${(posts ?? []).length === 1 ? "" : "s"} published`, confidence: (posts ?? []).length ? "certain" : "likely" });

    const promisedItems: ReviewItem[] = [];
    const commitments: ReviewItem[] = [];
    for (const p of (promises ?? []) as { id: string; owner_id: string | null; what: string; due_at: string | null; status: string }[]) {
      const r = forLine(p.owner_id);
      if (!r) continue;
      const item = { text: clip(p.what, 140), confidence: "certain" as const, who: r.mention, due: p.due_at ? shortDay(nyDay(new Date(p.due_at))) : null };
      if (p.status === "open" && (!p.due_at || Date.parse(p.due_at) > Date.now())) promisedItems.push(item);
      else commitments.push(item);
    }
    for (const o of (owed ?? []) as { target_id: string | null; from_name: string | null; gist: string | null; subject: string | null; asked_at: string }[]) {
      const r = forLine(o.target_id);
      if (!r) continue;
      commitments.push({ text: `Reply owed to ${clip(o.from_name ?? "the client", 40)}: ${clip(o.gist || o.subject, 110)} (asked ${shortDay(nyDay(new Date(o.asked_at)))})`, confidence: "certain", who: r.mention });
    }
    const primaryLine = lines[0].line === line;
    for (const k of (calls ?? []) as { kind: string; what: string; due_at: string; routed_to: string[] | null }[]) {
      const routed = (k.routed_to ?? []).map((id) => forLine(id)).find(Boolean);
      if (!routed && !(primaryLine && !(k.routed_to ?? []).length)) continue;
      commitments.push({ text: `From a call: ${clip(k.what, 130)}`, confidence: "certain", who: routed?.mention ?? null, due: shortDay(nyDay(new Date(k.due_at))) });
    }

    // ─── Budget pace ────────────────────────────────────────────────────
    const budget: Review["budget"] = [];
    const seenAcc = new Set<string>();
    for (const t of lineTargets) {
      const acc = accountKey(t.platform, t.ad_account_id!);
      if (seenAcc.has(`${t.platform}:${acc}`)) continue;
      seenAcc.add(`${t.platform}:${acc}`);
      const b = budgetPace({ spent: spendOf(t.platform, acc, monthStart), budget: t.monthly_budget, day: Math.max(1, dayOfMonth - 1), daysInMonth });
      if (b) budget.push({ ...b, account: acc, platform: t.platform, confidence: "certain" });
    }

    // ─── Change history ─────────────────────────────────────────────────
    const lineChanges = tagged.filter((x) => (line === "google" ? x.platform === "google" : line === "meta" ? x.platform !== "google" : false));
    const anyReadable = lineTargets.some((t) => readable.get(accountKey(t.platform, t.ad_account_id!)));
    const clientPauses = lineChanges.filter((x) => x.actor === "client" && isPauseChange(x.what)).map((x) => ({ text: `Client: ${clip(x.what, 90)}${x.object ? ` on ${clip(x.object, 50)}` : ""} (${shortDay(nyDay(new Date(x.at)))}, ${clip(x.who, 30)})`, confidence: "certain" as const }));
    const unapproved = unapprovedChanges(lineChanges, { needsSignoff: signoff, clientMessages }).map((x) => ({ text: `Us: ${clip(x.what, 90)}${x.object ? ` on ${clip(x.object, 50)}` : ""} (${shortDay(nyDay(new Date(x.at)))})`, confidence: "likely" as const }));
    const changesBlock = {
      total: lineChanges.length,
      ours: lineChanges.filter((x) => x.actor === "us").length,
      client: lineChanges.filter((x) => x.actor === "client").length,
      unknown: lineChanges.filter((x) => x.actor === "unknown").length,
      clientPauses,
      unapproved,
      notable: lineChanges.filter((x) => x.actor !== "automated").slice(0, 8).map((x) => ({ text: `${x.actor === "us" ? "Us" : x.actor === "client" ? "Client" : "Unknown"}: ${clip(x.what, 90)}${x.object ? ` on ${clip(x.object, 50)}` : ""} (${shortDay(nyDay(new Date(x.at)))})`, confidence: "certain" as const })),
      readable: anyReadable,
    };

    // ─── Results vs target ──────────────────────────────────────────────
    const results: ReviewItem[] = [];
    for (const t of lineTargets) {
      const sn = s.snaps.get(t.id);
      if (!sn || !sn.windows) continue;
      const w = sn.windows.d14 ?? sn.windows.d7;
      if (!w) continue;
      const dev = sn.deviation == null ? null : Number(sn.deviation);
      const where = dev == null || t.target == null ? "no target set" : dev > 0.15 ? `behind target by ${Math.round(dev * 100)}%` : dev < -0.15 ? `beating target by ${Math.round(-dev * 100)}%` : "on target";
      results.push({ text: `${PLATFORM_NAME[t.platform] ?? t.platform}${t.label ? ` (${clip(t.label, 30)})` : ""}: ${Math.round(Number(w.results ?? 0))} results in 14 days${w.value != null ? `, ${Number(w.value).toFixed(2)} per result` : ""}${t.target != null ? ` vs target ${Number(t.target).toFixed(2)}` : ""}, ${where}`, confidence: "likely" });
    }
    const conversions = line === "meta" || line === "google" ? combineConversions(allAdResults, null) : null;

    const base: Omit<Review, "todos" | "risk"> = {
      v: 1,
      client: { id: c.id, name: c.name, slug: c.slug, status: c.status },
      line,
      strategyOnly,
      period: { from: weekFrom, to: addDays(today, -1) },
      owner: owner ? { id: owner.id, name: owner.full_name, slackMention: mention(owner) } : null,
      scope: { services: services.map((sv) => sv), tiers, delivered: strategyOnly ? [{ text: "Strategy only: no deliveries expected on this line", confidence: "certain" }, ...delivered] : delivered, promised: promisedItems.slice(0, 6) },
      budget,
      changes: changesBlock,
      commitments: commitments.slice(0, 8),
      results,
      conversions,
      health: { internalSilent, clientSilent, atRisk: risk ? clip(risk.body, 160) : null, blockers, hasInternalChannel: Boolean(c.internal_slack_channel_id) },
    };
    const review: Review = { ...base, todos: todosFor(base), risk: 0 };
    review.risk = riskScore(review);
    out.push(review);
  }
  return out;
}

/** Draft (or refresh) this week's reviews. A review already sent or skipped is left alone; a draft is rewritten. */
export async function saveReviews(admin: SupabaseClient, reviews: Review[], weekStart: string) {
  let saved = 0;
  for (const r of reviews) {
    const { data: cur } = await admin.from("line_reviews").select("id, status, edited_at").eq("client_id", r.client.id).eq("line", r.line).eq("week_start", weekStart).maybeSingle();
    if (cur && cur.status !== "draft") continue;
    const row = { client_id: r.client.id, line: r.line, week_start: weekStart, head_role: LINE_HEAD[r.line], review: r, risk: r.risk, drafted_at: new Date().toISOString(), error: null as string | null };
    // A head's edits to the message are kept when the numbers refresh
    const message = composeMessage(r);
    if (cur) await admin.from("line_reviews").update(cur.edited_at ? row : { ...row, message }).eq("id", cur.id);
    else await admin.from("line_reviews").insert({ ...row, message });
    saved++;
  }
  return saved;
}

/**
 * The Monday run (New York): every live client's reviews for this week, a batch at a time (the run comes back hourly
 * until every client has its drafts; a client already drafted this week is skipped unless force).
 */
export async function runWeeklyReviews(admin: SupabaseClient, opts: { now?: Date; batch?: number; force?: boolean } = {}) {
  const now = opts.now ?? new Date();
  const s = await loadShared(admin, now);
  const week = weekStartOf(s.today);
  const [{ data: clients }, { data: have }] = await Promise.all([
    admin.from("clients").select(CLIENT_FIELDS).is("archived_at", null).in("status", ["active", "onboarding"]).order("name"),
    admin.from("line_reviews").select("client_id").eq("week_start", week),
  ]);
  const done = new Set((have ?? []).map((h) => h.client_id as string));
  const todo = ((clients ?? []) as ClientRow[]).filter((c) => (opts.force || !done.has(c.id)) && reviewLinesFor(c).length);
  const batch = todo.slice(0, opts.batch ?? 40);
  let saved = 0;
  const errors: string[] = [];
  for (const c of batch) {
    try {
      saved += await saveReviews(admin, await buildClientReviews(admin, c, s), week);
    } catch (e) {
      errors.push(`${c.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { week, clients: batch.length, left: todo.length - batch.length, saved, errors: errors.slice(0, 10) };
}

/** One client's review now (for a head, an exec, or the assistant: "run the review for X") */
export async function runOneReview(admin: SupabaseClient, clientId: string, line?: ReviewLine | null) {
  const s = await loadShared(admin);
  const { data: c } = await admin.from("clients").select(CLIENT_FIELDS).eq("id", clientId).maybeSingle();
  if (!c) return { ok: false as const, error: "No such client." };
  const row = c as ClientRow;
  if (row.archived_at || !["active", "onboarding"].includes(row.status)) return { ok: false as const, error: `${row.name} is ${row.archived_at ? "archived" : row.status} in Kaizen OS, so there's no review.` };
  const reviews = await buildClientReviews(admin, row, s, line ?? null);
  if (!reviews.length) return { ok: false as const, error: line ? `${row.name} doesn't buy ${REVIEW_LINE_LABEL[line]} (Services panel), so there's no ${REVIEW_LINE_LABEL[line]} review.` : `${row.name} buys none of the reviewed lines.` };
  const week = weekStartOf(s.today);
  await saveReviews(admin, reviews, week);
  return { ok: true as const, week, lines: reviews.map((r) => r.line) };
}
