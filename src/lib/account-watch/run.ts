import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { servicesOf, type ServiceSlug } from "@/lib/services";
import { hasLine } from "@/lib/service-gate";
import { cycleElapsed } from "@/lib/allotment";
import { lineOf } from "@/lib/exec-focus/core";
import { fireSweep, raiseFire } from "@/lib/exec-focus/server";
import { isDogKind } from "@/lib/watchdogs/core";
import {
  LINE_LABEL,
  LINE_SERVICE,
  SERVICE_LINE,
  WATCHED_LINES,
  beatingWide,
  creativeBehind,
  daysBetween,
  idleState,
  idleTitle,
  isAutomated,
  isKaizenEmail,
  matchActor,
  neglectState,
  normName,
  overspend,
  overtouched,
  shortDay,
  spendAnomaly,
  type Billed,
  type Person,
  type WatchLine,
} from "./core";

// The daily account watch. For every live client and every service they're billed for (Stripe, via Track) or listed
// on, the last real activity: spend, creative delivered, a campaign sent, a post. Seven quiet days on a billed line is a
// critical alert to the line's seat owner, its head and the execs (bell, email, Slack DM when connected), open until
// activity resumes, the service is removed, or a lead or exec marks it paused until a day. Then each spending ad
// account: no change by our team in its window (sooner for bigger accounts; its head three days later), too many
// learning-reset edits, spend that jumps, drops or stops, and a month heading over budget. The creative line: behind
// pace with a week left, or nothing delivered in two weeks; an account far beating its KPI is offered a creative sprint.
// Change-history names nobody on the team or the client's side answers to go to the execs.

const LIVE = ["active", "onboarding"];
const DAY = 86_400_000;
const nyDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const accountKey = (platform: string, id: string) => (platform === "google" ? id.replace(/\D/g, "") : id.replace(/^act_/, "").trim());

/** The seats that own a line on a client, and the head of that line */
const SEATS: Record<WatchLine, string[]> = { meta: ["meta_buyer"], google: ["google_buyer"], tiktok: ["tiktok_buyer", "meta_buyer"], creative: ["graphic_designer", "video_editor"], email: ["email_strategist"], social: ["social_manager"], web: [], crm: [] };
const HEAD: Record<WatchLine, string | null> = { meta: "head_of_meta", google: "head_of_google", tiktok: "head_of_meta", creative: "head_of_creative", email: "head_of_email", social: "head_of_social", web: null, crm: null };

type Profile = Person & { role: string; is_exec: boolean | null; is_active: boolean; slack_user_id: string | null; joined_at: string | null };
type Client = { id: string; name: string; slug: string; created_at: string; status: string; services: string[] | null; services_extra: string[] | null; services_removed: string[] | null; billed_services: Billed | null; billed_synced_at: string | null; creative_package: boolean; creative_package_until: string | null; strategy_only?: string[] | null };
type Target = { id: string; client_id: string; platform: string; ad_account_id: string; owner_id: string | null; monthly_budget: number | null };

export type Finding = {
  key: string;
  kind: string;
  client_id: string;
  line: string | null;
  account: string | null;
  title: string;
  body: string;
  detail: Record<string, unknown>;
  severity: "critical" | "warn" | "info";
  href: string;
  to: string[];
  escalate?: { to: string[]; title: string } | null;
};

/** Kinds an exec closes by hand (the run doesn't clear them on its own) */
const MANUAL = new Set(["unrecognized"]);

async function pages<T>(make: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, max = 30_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < max; from += 1000) {
    const { data, error } = await make(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => Boolean(x)))];

export async function runAccountWatch(admin: SupabaseClient, now = new Date()) {
  const today = nyDay(now);
  const yesterday = addDays(today, -1);
  const since14 = new Date(now.getTime() - 14 * DAY).toISOString();

  const [{ data: clientRows }, { data: pauseRows }, { data: seatRows }, { data: people }, { data: targetRows }, { data: snapRows }, { data: usageRows }, lastRows, spendRows, changeRows, { data: activityRows }, { data: contactRows }, { data: decided }, { data: klaviyo }, { data: socialAcc }] = await Promise.all([
    admin.from("clients").select("id, name, slug, created_at, status, services, services_extra, services_removed, billed_services, billed_synced_at, creative_package, creative_package_until, strategy_only").is("archived_at", null).in("status", LIVE),
    admin.from("watch_pauses").select("client_id, service, until, reason").is("cleared_at", null).gte("until", today),
    admin.from("client_assignments").select("client_id, profile_id, role, is_primary"),
    // Everyone who's been on the team (a past buyer's name is still ours); alerts only reach active, joined people
    admin.from("profiles").select("id, full_name, display_name, email, role, is_exec, is_active, platform_aliases, slack_user_id, joined_at"),
    admin.from("kpi_targets").select("id, client_id, platform, ad_account_id, owner_id, monthly_budget").eq("active", true).not("ad_account_id", "is", null),
    admin.from("kpi_snapshots").select("target_id, status, deviation"),
    admin.from("client_allotment_usage").select("client_id, images_per_month, videos_per_month, images_used, videos_used, period_start, period_end"),
    pages<{ line: string; ref: string; last_on: string }>((a, b) => admin.rpc("watch_last_activity").range(a, b)),
    pages<{ platform: string; ad_account_id: string; date: string; spend: number }>((a, b) => admin.rpc("watch_spend_days", { p_since: addDays(today, -45) }).range(a, b)),
    pages<{ ad_account_id: string; platform: string; at: string; who: string | null; what: string; object: string | null }>((a, b) => admin.from("ad_account_changes").select("ad_account_id, platform, at, who, what, object").gte("at", since14).order("at", { ascending: false }).range(a, b)),
    admin.from("ad_account_activity").select("ad_account_id, error, checked_at"),
    admin.from("contact_clients").select("client_id, contacts(full_name, email)").is("removed_at", null),
    admin.from("watch_actors").select("name_key, status, client_id"),
    admin.from("klaviyo_connections").select("client_id"),
    admin.from("social_accounts").select("client_id"),
  ]);
  const clients = (clientRows ?? []) as Client[];
  const team = (people ?? []) as Profile[];
  const active = team.filter((p) => p.is_active);
  const targets = (targetRows ?? []) as Target[];
  const execs = active.filter((p) => p.is_exec || p.role === "executive").map((p) => p.id);
  const heads = (line: WatchLine) => (HEAD[line] ? active.filter((p) => p.role === HEAD[line]).map((p) => p.id) : []);
  const seatsOf = (clientId: string, roles: string[]) => (seatRows ?? []).filter((s) => s.client_id === clientId && roles.includes(s.role as string)).sort((a, b) => Number(b.is_primary) - Number(a.is_primary)).map((s) => s.profile_id as string);

  const last = new Map<string, string>();
  for (const r of lastRows) {
    const k = `${r.line}:${r.ref}`;
    if (!last.has(k) || last.get(k)! < r.last_on) last.set(k, r.last_on);
  }
  const pauses = new Map<string, { until: string; reason: string }>();
  for (const p of pauseRows ?? []) pauses.set(`${p.client_id}:${p.service}`, { until: p.until as string, reason: p.reason as string });
  const accountsOf = (clientId: string, platform: string) => uniq(targets.filter((t) => t.client_id === clientId && t.platform === platform).map((t) => accountKey(platform, t.ad_account_id)));

  const findings: Finding[] = [];

  // ─── 1. Billed (or listed) but idle ───────────────────────────────────────
  const hasKlaviyo = new Set((klaviyo ?? []).map((k) => k.client_id as string));
  const hasSocial = new Set((socialAcc ?? []).map((k) => k.client_id as string));
  const idleLines = new Set<string>();
  for (const c of clients) {
    const listed = new Set<ServiceSlug>(servicesOf(c));
    const removed = new Set(c.services_removed ?? []);
    const billed = (c.billed_services ?? {}) as Billed;
    const lines = new Set<WatchLine>();
    for (const s of [...listed, ...(Object.keys(billed) as ServiceSlug[])]) {
      const l = SERVICE_LINE[s];
      // Strategy only (no copy or design for that line): nothing is ever delivered, so it's never idle
      if (l && WATCHED_LINES.includes(l) && !removed.has(s) && !(c.strategy_only ?? []).includes(s)) lines.add(l);
    }
    for (const line of lines) {
      const slug = LINE_SERVICE[line];
      const ad = line === "meta" || line === "google" || line === "tiktok";
      const accounts = ad ? accountsOf(c.id, line) : [];
      const dates = ad ? accounts.map((a) => last.get(`${line}:${a}`)) : [last.get(`${line}:${c.id}`)];
      const lastActivity = dates.filter((d): d is string => Boolean(d)).sort().pop() ?? null;
      const pause = pauses.get(`${c.id}:${slug}`);
      const st = idleState({ line, lastActivity, today, startedAt: c.created_at, pausedUntil: pause?.until ?? null });
      if (!st.idle) continue;
      const isBilled = Boolean(billed[slug]);
      idleLines.add(`${c.id}:${line}`);
      const why = ad && !accounts.length ? `No ${LINE_LABEL[line]} ad account is linked in Kaizen OS.` : line === "email" && !hasKlaviyo.has(c.id) ? "Klaviyo isn't connected, so no sends can be seen." : line === "social" && !hasSocial.has(c.id) ? "No social account is connected, so no posts can be seen." : "";
      const billedLine = isBilled ? `Stripe billed ${LINE_LABEL[line]} on ${shortDay(billed[slug]!.last)}${billed[slug]!.amount ? ` ($${Math.round(billed[slug]!.amount).toLocaleString("en-US")})` : ""}.` : `${LINE_LABEL[line]} is listed as one of their services.`;
      findings.push({
        key: `idle:${c.id}:${line}`,
        kind: "idle",
        client_id: c.id,
        line: slug,
        account: accounts[0] ?? null,
        title: idleTitle(line, isBilled, lastActivity),
        body: [billedLine, `${st.daysIdle == null ? "Nothing on record" : `${st.daysIdle} days with no ${line === "creative" ? "creative delivered" : line === "email" ? "campaign sent" : line === "social" ? "post" : "spend"}`}.`, why, "Get it running, take the service off, or mark it paused until a date with the reason (a seasonal pause)."].filter(Boolean).join(" "),
        detail: { billed: isBilled, billedAt: billed[slug]?.last ?? null, amount: billed[slug]?.amount ?? null, lastActivity, daysIdle: st.daysIdle, accounts },
        severity: isBilled ? "critical" : "warn",
        href: `/watch?tab=idle&client=${c.slug}`,
        to: uniq([...seatsOf(c.id, SEATS[line]), ...(ad ? targets.filter((t) => t.client_id === c.id && t.platform === line).map((t) => t.owner_id) : []), ...heads(line), ...execs]),
      });
    }
  }

  // ─── 2. Ad accounts: neglected, overtouched, spend ────────────────────────
  const byClient = new Map(clients.map((c) => [c.id, c]));
  const spendBy = new Map<string, { date: string; spend: number }[]>();
  for (const r of spendRows) {
    const k = `${r.platform}:${r.ad_account_id}`;
    spendBy.set(k, [...(spendBy.get(k) ?? []), { date: r.date, spend: Number(r.spend) || 0 }]);
  }
  const changesBy = new Map<string, typeof changeRows>();
  for (const r of changeRows) changesBy.set(r.ad_account_id, [...(changesBy.get(r.ad_account_id) ?? []), r]);
  const readable = new Map((activityRows ?? []).map((a) => [a.ad_account_id as string, !a.error && a.checked_at && Date.parse(a.checked_at as string) > now.getTime() - 3 * DAY]));
  const ours = (who: string | null) => Boolean(who) && !isAutomated(who) && (isKaizenEmail(who) || Boolean(matchActor(who, team)));
  const snapBy = new Map((snapRows ?? []).map((s) => [s.target_id as string, s]));
  const monthStart = `${today.slice(0, 8)}01`;
  const dayOfMonth = Number(today.slice(8, 10));
  const daysInMonth = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0).getDate();
  const seenAccount = new Set<string>();
  for (const t of targets) {
    const c = byClient.get(t.client_id);
    if (!c || !(t.platform === "meta" || t.platform === "google" || t.platform === "tiktok")) continue;
    const line = t.platform as WatchLine;
    if (!servicesOf(c).includes(LINE_SERVICE[line])) continue;
    const acc = accountKey(t.platform, t.ad_account_id);
    const days = spendBy.get(`${t.platform}:${acc}`) ?? [];
    const sum = (from: string) => days.filter((d) => d.date >= from && d.date <= yesterday).reduce((n, d) => n + d.spend, 0);
    const spend7 = sum(addDays(today, -7));
    const spend30 = sum(addDays(today, -30));
    const buyers = uniq([t.owner_id, ...seatsOf(c.id, SEATS[line])]);
    const base = { client_id: c.id, line: LINE_SERVICE[line], account: acc };
    const label = `${LINE_LABEL[line]} account`;
    const dup = seenAccount.has(`${t.platform}:${acc}`);
    seenAccount.add(`${t.platform}:${acc}`);

    if (!dup && t.platform !== "tiktok" && readable.get(acc)) {
      const changes = changesBy.get(acc) ?? [];
      const teamChanges = changes.filter((x) => ours(x.who));
      const n = neglectState({ lastTeamChange: teamChanges[0]?.at ?? null, spend7, spend30, today, since: since14 });
      if (n.neglected)
        findings.push({
          ...base,
          key: `neglected:${t.platform}:${acc}`,
          kind: "neglected",
          title: `No change by our team in ${teamChanges.length ? `${n.days} days` : "14+ days"} on the ${label}`,
          body: `Spending $${Math.round(spend7).toLocaleString("en-US")} in the last 7 days and nobody on our team has touched it${teamChanges[0] ? ` since ${shortDay(teamChanges[0].at)}` : ""}. Accounts spending $${Math.round(spend30).toLocaleString("en-US")} a month get a look at least every ${n.threshold} days.`,
          detail: { days: n.days, threshold: n.threshold, spend7, spend30, lastChange: teamChanges[0] ?? null },
          severity: "warn",
          href: `/kpis?target=${t.id}`,
          to: buyers,
          escalate: n.escalate ? { to: heads(line), title: `${c.name}: ${label} untouched ${teamChanges.length ? `${n.days} days` : "14+ days"}, the buyer was told ${n.days != null ? n.days - n.threshold : 3} days ago` } : null,
        });
      const o = overtouched(changes.filter((x) => !isAutomated(x.who)), now);
      if (o.hit)
        findings.push({
          ...base,
          key: `overtouched:${t.platform}:${acc}`,
          kind: "overtouched",
          title: `${o.count} learning-reset edits in 3 days on the ${label}`,
          body: `${o.object ? `${o.objectCount} on ${o.object}. ` : ""}Budget, bid, targeting and goal changes send it back into learning. Let it settle before the next edit.`,
          detail: o,
          severity: "warn",
          href: `/kpis?target=${t.id}`,
          to: uniq([...buyers, ...heads(line)]),
        });
    }
    if (dup) continue;
    const a = spendAnomaly(days, yesterday);
    if (a)
      findings.push({
        ...base,
        key: `spend_${a.kind}:${t.platform}:${acc}`,
        kind: `spend_${a.kind}`,
        title: a.kind === "stopped" ? `${LINE_LABEL[line]} spend stopped on ${shortDay(a.day)}` : a.kind === "spike" ? `${LINE_LABEL[line]} spend jumped to $${Math.round(a.spend).toLocaleString("en-US")} on ${shortDay(a.day)}` : `${LINE_LABEL[line]} spend fell to $${Math.round(a.spend).toLocaleString("en-US")} on ${shortDay(a.day)}`,
        body: `The 14 days before averaged $${Math.round(a.average).toLocaleString("en-US")} a day. Check budgets, billing, delivery and anything paused.`,
        detail: a,
        severity: a.kind === "stopped" ? "critical" : "warn",
        href: `/kpis?target=${t.id}`,
        to: buyers,
      });
    const mtd = sum(monthStart);
    const ov = overspend({ mtd, budget: t.monthly_budget, dayOfMonth: Math.max(1, dayOfMonth - 1), daysInMonth });
    if (ov.over)
      findings.push({
        ...base,
        key: `overspend:${t.platform}:${acc}:${today.slice(0, 7)}`,
        kind: "overspend",
        title: `${LINE_LABEL[line]} on course to overspend: $${Math.round(ov.projected).toLocaleString("en-US")} against $${Math.round(t.monthly_budget ?? 0).toLocaleString("en-US")}`,
        body: `$${Math.round(mtd).toLocaleString("en-US")} spent this month so far. Bring daily budgets in line, or agree the higher spend with the client.`,
        detail: { mtd, budget: t.monthly_budget, projected: ov.projected },
        severity: "warn",
        href: `/kpis?target=${t.id}`,
        to: uniq([...buyers, ...heads(line)]),
      });

    // Far beating the KPI: two extra creatives would ride it (offered to the head of creative and the buyer)
    const snap = snapBy.get(t.id);
    if (beatingWide(snap?.deviation as number | null) && (c.creative_package || servicesOf(c).includes("creative")))
      findings.push({
        ...base,
        key: `creative_sprint:${t.platform}:${acc}:${today.slice(0, 7)}`,
        kind: "creative_sprint",
        title: `Beating its ${LINE_LABEL[line]} KPI by ${Math.round(-Number(snap!.deviation) * 100)}%: worth a creative sprint`,
        body: "Two extra creatives this cycle while the account is winning. One tap asks the creative team.",
        detail: { deviation: snap?.deviation, targetId: t.id },
        severity: "info",
        href: `/watch?tab=creative&client=${c.slug}`,
        to: uniq([...heads("creative"), ...buyers]),
      });
  }

  // ─── 3. Creative behind pace, or quiet ────────────────────────────────────
  for (const u of usageRows ?? []) {
    const c = byClient.get(u.client_id as string);
    // The creative line only for clients that buy it (src/lib/service-gate.ts)
    if (!c || !c.creative_package || (c.creative_package_until && c.creative_package_until < today) || !hasLine(c, "creative")) continue;
    // Creative paused until a date (a seasonal pause): neither behind nor quiet
    if (pauses.has(`${c.id}:creative`)) continue;
    const to = uniq([...heads("creative"), ...seatsOf(c.id, SEATS.creative)]);
    const cap = Number(u.images_per_month ?? 0) + Number(u.videos_per_month ?? 0);
    const used = Number(u.images_used ?? 0) + Number(u.videos_used ?? 0);
    const cycle = u.period_start && u.period_end ? { start: String(u.period_start), end: String(u.period_end) } : null;
    const elapsed = cycleElapsed(cycle, now);
    const daysLeft = cycle ? daysBetween(today, cycle.end) : daysInMonth - dayOfMonth;
    if (creativeBehind({ cap, used, elapsed, daysLeft }))
      findings.push({
        key: `creative_behind:${c.id}:${cycle?.start ?? today.slice(0, 7)}`,
        kind: "creative_behind",
        client_id: c.id,
        line: "creative",
        account: null,
        title: `Creative behind: ${used} of ${cap} with ${daysLeft} day${daysLeft === 1 ? "" : "s"} left`,
        body: `${Math.round(elapsed * 100)}% through their cycle and ${Math.round((used / cap) * 100)}% of the allotment used. Get the rest briefed and into production now.`,
        detail: { cap, used, elapsed, daysLeft, cycle },
        severity: "warn",
        href: `/clients/${c.slug}?service=creative`,
        to,
      });
    const lastCreative = last.get(`creative:${c.id}`) ?? null;
    const quiet = lastCreative ? daysBetween(lastCreative, today) : daysBetween(c.created_at, today);
    if (quiet >= 14 && !idleLines.has(`${c.id}:creative`))
      findings.push({
        key: `creative_quiet:${c.id}`,
        kind: "creative_quiet",
        client_id: c.id,
        line: "creative",
        account: null,
        title: `No creative delivered ${lastCreative ? `since ${shortDay(lastCreative)}` : "on record"}`,
        body: `${quiet} days on an active creative package with nothing delivered.`,
        detail: { lastCreative, days: quiet },
        severity: "warn",
        href: `/clients/${c.slug}?service=creative`,
        to,
      });
  }

  // ─── 4. Unrecognized people in an account ─────────────────────────────────
  const contactsOf = new Map<string, { names: Set<string>; domains: Set<string> }>();
  for (const r of contactRows ?? []) {
    const ct = r.contacts as unknown as { full_name: string | null; email: string | null } | null;
    const cur = contactsOf.get(r.client_id as string) ?? { names: new Set<string>(), domains: new Set<string>() };
    if (ct?.full_name) cur.names.add(normName(ct.full_name));
    if (ct?.email) {
      cur.names.add(normName(ct.email));
      const d = ct.email.split("@")[1]?.toLowerCase();
      if (d && !/gmail|yahoo|hotmail|outlook|icloud|aol/.test(d)) cur.domains.add(d);
    }
    contactsOf.set(r.client_id as string, cur);
  }
  const placed = new Map((decided ?? []).map((d) => [d.name_key as string, d]));
  const clientOfAccount = new Map(targets.map((t) => [accountKey(t.platform, t.ad_account_id), t.client_id]));
  const strangers = new Map<string, { acc: string; platform: string; who: string; changes: { at: string; what: string; object: string | null }[] }>();
  for (const x of changeRows) {
    if (!x.who || isAutomated(x.who) || ours(x.who)) continue;
    const clientId = clientOfAccount.get(x.ad_account_id);
    const c = clientId ? byClient.get(clientId) : undefined;
    // Only accounts on a line the client buys (src/lib/service-gate.ts)
    if (!c || !hasLine(c, x.platform === "google" ? "google" : x.platform === "tiktok" ? "tiktok" : "meta")) continue;
    const key = normName(x.who);
    const p = placed.get(key);
    if (p && (p.status === "partner" || p.client_id === c.id)) continue;
    const mine = contactsOf.get(c.id);
    if (mine?.names.has(key) || (x.who.includes("@") && mine?.domains.has(x.who.split("@")[1].toLowerCase()))) continue;
    // The business itself (a page acting on its own account)
    if (normName(c.name) === key) continue;
    const k = `${x.ad_account_id}|${key}`;
    const cur = strangers.get(k) ?? { acc: x.ad_account_id, platform: x.platform, who: x.who.trim(), changes: [] };
    cur.changes.push({ at: x.at, what: x.what, object: x.object });
    strangers.set(k, cur);
  }
  for (const s of strangers.values()) {
    const c = byClient.get(clientOfAccount.get(s.acc)!)!;
    findings.push({
      key: `unrecognized:${s.acc}:${normName(s.who)}`,
      kind: "unrecognized",
      client_id: c.id,
      line: LINE_SERVICE[s.platform === "google" ? "google" : "meta"],
      account: s.acc,
      title: `Unrecognized person changed ${c.name}'s ${s.platform === "google" ? "Google" : "Meta"} account: ${s.who}`,
      body: `${s.changes.length} change${s.changes.length === 1 ? "" : "s"} in the last 14 days, latest ${shortDay(s.changes[0].at)}: ${s.changes
        .slice(0, 3)
        .map((x) => x.what)
        .join("; ")}. Not on our team (no alias matches) and not one of the client's contacts.`,
      detail: { who: s.who, changes: s.changes.slice(0, 25) },
      severity: "critical",
      href: `/watch?tab=people`,
      to: execs,
    });
  }

  const seeded = await seedAliases(admin, active).catch((e) => ({ error: String(e) }));
  const applied = await applyFindings(admin, findings, clients, pauses, now);
  // The fire rules that need numbers: the main KPI far off for a week on a top-spend or at-risk client, tracking broken
  const fire = await fireSweep(admin).catch((e) => ({ error: String(e) }));
  return { today, findings: findings.length, ...applied, seeded, fire };
}

// ─── Flags, notifications and Slack ─────────────────────────────────────────

/**
 * Save findings as flags and tell people once. owns: the flag kinds this run answers for (only those clear themselves
 * when no longer found); the daily watch owns its own kinds, the watchdogs (src/lib/watchdogs) theirs.
 */
export async function applyFindings(admin: SupabaseClient, findings: Finding[], clients: Pick<Client, "id" | "name" | "services" | "services_extra" | "services_removed" | "billed_services">[], pauses: Map<string, { until: string; reason: string }>, now: Date, opts: { owns?: (kind: string) => boolean; noticeSuffix?: string } = {}) {
  const owns = opts.owns ?? ((k: string) => !isDogKind(k));
  const at = now.toISOString();
  const { data: open } = await admin.from("watch_flags").select("id, key, kind, client_id, line, notified_at, escalated_at").is("resolved_at", null);
  const openBy = new Map((open ?? []).map((f) => [f.key as string, f]));
  const name = new Map(clients.map((c) => [c.id, c]));
  let opened = 0;
  let notified = 0;
  for (const f of findings) {
    const row = { kind: f.kind, client_id: f.client_id, line: f.line, account: f.account, title: f.title, body: f.body, detail: f.detail, severity: f.severity, seen_at: at };
    let flag = openBy.get(f.key);
    if (flag) await admin.from("watch_flags").update(row).eq("id", flag.id);
    else {
      const { data, error } = await admin.from("watch_flags").insert({ ...row, key: f.key }).select("id, key, kind, client_id, line, notified_at, escalated_at").single();
      if (error || !data) continue;
      flag = data;
      opened++;
    }
    const c = name.get(f.client_id);
    if (!flag.notified_at && f.to.length) {
      await notify(admin, f.to, { key: `watch:${flag.id}${opts.noticeSuffix ?? ""}`, title: `${c?.name ?? "A client"}: ${f.title}`, body: f.body, href: f.href, clientId: f.client_id, kind: f.line === "creative" ? "client" : "kpi", critical: f.severity === "critical" });
      await admin.from("watch_flags").update({ notified_at: at }).eq("id", flag.id);
      notified++;
      // Billed for a line that's gone idle, spend stopped on a big account: every exec hears the client is on fire
      const avg = Number((f.detail as { average?: number }).average ?? 0);
      await raiseFire(admin, { clientId: f.client_id, client: c?.name ?? null, href: f.href, body: f.body, line: lineOf(f.line), signal: { kind: "watch", watchKind: f.kind, severity: f.severity, billed: Boolean((f.detail as { billed?: boolean }).billed), spend30: avg * 30, line: f.line } }).catch(() => false);
    } else if (flag.notified_at && f.to.length) {
      // Someone the flag reaches now who wasn't told when it opened (a new seat holder, a new tracking specialist): they
      // hear it once too. The notice is keyed per flag, so everyone told before is skipped (never a repeat)
      await notify(admin, f.to, { key: `watch:${flag.id}${opts.noticeSuffix ?? ""}`, title: `${c?.name ?? "A client"}: ${f.title}`, body: f.body, href: f.href, clientId: f.client_id, kind: f.line === "creative" ? "client" : "kpi", critical: f.severity === "critical" });
    }
    if (f.escalate && f.escalate.to.length && !flag.escalated_at) {
      await notify(admin, f.escalate.to, { key: `watch:${flag.id}:head`, title: f.escalate.title, body: f.body, href: f.href, clientId: f.client_id, kind: "kpi", critical: true });
      await admin.from("watch_flags").update({ escalated_at: at }).eq("id", flag.id);
    }
  }
  // What's no longer found clears itself, saying why
  const found = new Set(findings.map((f) => f.key));
  let resolved = 0;
  for (const f of open ?? []) {
    if (found.has(f.key as string) || MANUAL.has(f.kind as string) || !owns(f.kind as string)) continue;
    const c = name.get(f.client_id as string);
    const pause = f.line ? pauses.get(`${f.client_id}:${f.line}`) : undefined;
    const gone = !c || (f.line && f.kind === "idle" && !servicesOf(c).includes(f.line as ServiceSlug) && !(c.billed_services ?? {})[f.line as ServiceSlug]);
    const resolution = !c ? "Client archived or paused" : pause && f.kind === "idle" ? `Paused until ${pause.until}: ${pause.reason}` : gone ? "Service removed" : f.kind === "idle" ? "Activity resumed" : "Cleared";
    await admin.from("watch_flags").update({ resolved_at: at, resolution }).eq("id", f.id);
    // Their bell no longer carries it
    await admin.from("notifications").update({ cleared_at: at }).like("key", `watch:${f.id}%`).is("cleared_at", null);
    resolved++;
  }
  return { opened, notified, resolved };
}

type Notice = { key: string; title: string; body: string; href: string; clientId: string; kind: string; critical: boolean };

/** The bell, and email by each person's settings. Never Slack: the team works in Kaizen OS */
export async function notify(admin: SupabaseClient, to: string[], n: Notice) {
  if (!to.length) return;
  await admin.from("notifications").upsert(
    to.map((id) => ({ profile_id: id, kind: n.kind, title: n.title.slice(0, 200), body: n.body.slice(0, 1000), href: n.href, client_id: n.clientId, key: n.key, priority: n.critical ? "critical" : "normal" })),
    { onConflict: "profile_id,key", ignoreDuplicates: true },
  );
  // Team alerts stay in Kaizen OS (bell, Overview, email): no Slack DMs from the app
}

/**
 * Change-history names that are clearly a team member under another spelling ("Kyle J Barry", an email that's theirs)
 * become aliases on their profile, once, so the match is visible and editable there.
 */
export async function seedAliases(admin: SupabaseClient, team: Profile[]) {
  const { data } = await admin.rpc("watch_actor_names", { p_since: new Date(Date.now() - 120 * DAY).toISOString() });
  const add = new Map<string, Set<string>>();
  for (const r of (data ?? []) as { who: string }[]) {
    const who = r.who?.trim();
    if (!who || isAutomated(who)) continue;
    const p = matchActor(who, team);
    if (!p) continue;
    const known = [p.full_name, p.display_name, ...(p.platform_aliases ?? [])].map(normName);
    if (known.includes(normName(who))) continue;
    add.set(p.id, (add.get(p.id) ?? new Set()).add(who));
  }
  for (const [id, names] of add) {
    const p = team.find((x) => x.id === id)!;
    await admin.from("profiles").update({ platform_aliases: [...new Set([...(p.platform_aliases ?? []), ...names])] }).eq("id", id);
  }
  return add.size;
}
