import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import type { TodayDraft, TopicKey } from "@/lib/today";
import { execHears, groupEscalated, sortCards, sortNeeds, type ExecCard, type ExecTab, type FireRow, type Rung3Row } from "@/lib/exec-overview-core";

// The executive Overview and morning recap (owner, Nov 23 2026; the rules in ./exec-overview-core.ts). One model, built
// with the recap: Needs me (what's on the exec personally), Escalated (rung 3 of the ladder and fires), Accounts (their
// focus lines, off target with nothing in motion), Pulse (read only) and, for the owner, System. Everything else leaves
// the exec's day: it's on client pages, the boards and a question to the assistant away.

const DAY = 86_400_000;
const nyDay = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const short = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
const first = (name: string) => name.trim().split(/\s+/)[0] || name;
const s = (n: number, one: string, many: string) => (n === 1 ? one : many);

async function adminOr(db: SupabaseClient): Promise<SupabaseClient> {
  const { adminConfigured, createAdminClient } = await import("@/lib/supabase/admin");
  return adminConfigured() ? createAdminClient() : db;
}

// ─── Needs me ────────────────────────────────────────────────────────────────

async function needsMe(db: SupabaseClient, admin: SupabaseClient, me: Staff, drafts: readonly TodayDraft[]): Promise<ExecCard[]> {
  const today = nyDay();
  const [{ loadOwedReplies }, { loadSaidPromises }] = await Promise.all([import("@/lib/owed-replies"), import("@/lib/message-promises")]);
  const [owed, said, { data: safety }, { data: conflicts }] = await Promise.all([
    loadOwedReplies(db, me, false).catch(() => []),
    loadSaidPromises(db, me).catch(() => []),
    admin.from("call_safety_reviews").select("call_id, severity, distress, categories, reviewed_at").eq("flagged", true).is("resolved_at", null).order("reviewed_at", { ascending: false }).limit(20),
    admin.from("agent_learnings").select("id, agent_key, lesson, updated_at").eq("status", "conflict").limit(20),
  ]);
  const cards: ExecCard[] = [];
  // Replies they owe
  for (const o of owed.filter((x) => x.targetId === me.id))
    cards.push({
      key: `owed:${o.id}`,
      tab: "needs",
      kind: "owed",
      client: o.client,
      clientId: o.clientId,
      clientSlug: o.clientSlug,
      title: `Reply to ${o.from}${o.client ? ` (${o.client})` : ""}`,
      detail: `${o.gist || o.body}`.replace(/\s+/g, " ").slice(0, 140),
      severity: o.status === "escalated" ? "critical" : "high",
      due: o.askedAt,
      action: { label: "Reply", href: o.url },
    });
  // What they said yes to
  for (const p of said.filter((x) => x.ownerId === me.id))
    cards.push({
      key: `said:${p.id}`,
      tab: "needs",
      kind: "said",
      client: p.client,
      clientId: p.clientId,
      clientSlug: p.clientSlug,
      title: `You said: ${p.what}`,
      detail: `${p.client ? `${p.client} · ` : ""}due ${short(p.dueAt)}${p.askedBy ? ` · asked by ${p.askedBy}` : ""}`,
      severity: p.status === "escalated" ? "critical" : "high",
      due: p.dueAt,
      action: { label: "Open it", href: p.url },
    });
  // Approvals only an exec gives: call safety reviews, agent learnings in conflict
  const flagged = (safety ?? []) as { call_id: string; severity: string | null; distress: boolean | null; categories: string[] | null; reviewed_at: string | null }[];
  if (flagged.length)
    cards.push({
      key: `approve:safety:${today}`,
      tab: "needs",
      kind: "approval",
      client: null,
      clientId: null,
      title: `${flagged.length} call ${s(flagged.length, "safety review", "safety reviews")} to look at`,
      // Role-based, never the caller's name: what was flagged, newest first (each review opens on its own page)
      detail: `Flagged on assistant calls${[...new Set(flagged.flatMap((f) => f.categories ?? []))].length ? `: ${[...new Set(flagged.flatMap((f) => f.categories ?? []))].slice(0, 4).join(", ").replace(/_/g, " ")}` : ""} · the newest opens first`,
      severity: flagged.some((f) => f.distress || f.severity === "high") ? "critical" : "high",
      due: flagged[flagged.length - 1].reviewed_at,
      action: { label: "Review", href: `/safety/${flagged[0].call_id}` },
    });
  // Only the agents on lines this exec oversees (by the agent's role, never a name); unassigned and cross-line ones
  // are the owner's (src/lib/youtube-core.ts decidesScoped)
  const allConflicts = (conflicts ?? []) as { id: string; agent_key: string; lesson: string; updated_at: string }[];
  const [{ decideScope }, { AGENT_LINES }] = await Promise.all([import("@/lib/youtube"), import("@/lib/youtube-core")]);
  const [inScope, { data: agentRoles }] = await Promise.all([decideScope(db, me), allConflicts.length ? admin.from("ai_agents").select("key, role_key").in("key", [...new Set(allConflicts.map((c) => c.agent_key))]) : Promise.resolve({ data: [] as { key: string; role_key: string | null }[] })]);
  const roleOf = new Map(((agentRoles ?? []) as { key: string; role_key: string | null }[]).map((a) => [a.key, a.role_key ?? a.key]));
  const conflict = allConflicts.filter((c) => inScope(AGENT_LINES[roleOf.get(c.agent_key) ?? c.agent_key] ?? []));
  if (conflict.length)
    cards.push({
      key: `approve:learnings:${today}`,
      tab: "needs",
      kind: "approval",
      client: null,
      clientId: null,
      title: `${conflict.length} agent ${s(conflict.length, "learning contradicts", "learnings contradict")} another: your call`,
      detail: String(conflict[0].lesson ?? "").slice(0, 140),
      severity: "normal",
      due: null,
      // The agent whose learnings contradict: its page lists them, the conflict marked, to keep one or merge
      action: { label: "Decide", href: `/settings?tab=agents&agent=${encodeURIComponent(conflict[0].agent_key)}` },
    });
  // Their own tickets and tasks from the recap (what they transferred away leaves), and what was transferred to them,
  // including stuck work they took over from Escalated (src/lib/item-owners.ts)
  const { ownDay, transferredTo } = await import("@/lib/item-owners");
  const mineDrafts = drafts.filter((x) => x.topic === "mine" && !/^mine:asana:/.test(x.key));
  const own = await ownDay(admin, me.id, mineDrafts).catch(() => mineDrafts);
  const { stableKeyOf } = await import("@/lib/today-counts");
  const moved = await transferredTo(admin, me.id, new Set([...cards.map((c) => stableKeyOf(c.key)), ...own.map((d) => stableKeyOf(d.key))]), "needs").catch(() => []);
  for (const d of [...own, ...moved])
    cards.push({ key: d.key, tab: "needs", kind: d.topic === "mine" ? "mine" : "taken", client: d.client === "Team" ? null : d.client, clientId: d.clientId, clientSlug: d.clientSlug || null, title: d.title, detail: d.story.slice(0, 160), severity: d.score >= 80 ? "critical" : d.score >= 60 ? "high" : "normal", due: d.due ?? null, action: { label: d.action.label, href: d.action.href ?? null } });
  return sortNeeds(cards);
}

// ─── Next for me in Asana ─────────────────────────────────────────────────────

/** Every open Asana task assigned to this person, overdue first, then today, then soon, then undated */
export async function asanaCards(db: SupabaseClient, email: string | null): Promise<ExecCard[]> {
  const { myAsanaTasks } = await import("@/lib/asana-live");
  const today = nyDay();
  const tasks = await myAsanaTasks(email, db).catch(() => []);
  return tasks.map((t) => {
    const late = Boolean(t.due && t.due < today);
    return {
      key: `asana:${t.gid}`,
      tab: "asana" as const,
      kind: "asana" as const,
      client: t.client,
      clientId: null,
      clientSlug: t.clientSlug,
      title: t.name,
      detail: [t.client ?? t.project, t.section, t.due ? (late ? `overdue since ${short(`${t.due}T12:00:00Z`)}` : t.due === today ? "due today" : `due ${short(`${t.due}T12:00:00Z`)}`) : "no date"].filter(Boolean).join(" · "),
      severity: late ? ("high" as const) : t.due === today ? ("normal" as const) : ("normal" as const),
      due: t.due ? `${t.due}T21:00:00Z` : null,
      action: { label: "Open", href: `/pipeline?block=asana&task=${t.gid}` },
      stat: t.url,
    };
  });
}

// ─── Escalated ───────────────────────────────────────────────────────────────

type NudgeRow = { id: string; item_key: string; client_id: string | null; client_name: string | null; owner_id: string; lead_id: string; what: string; href: string | null; since: string; created_at: string; line: string | null; owner: { full_name: string } | null; lead: { full_name: string; role: string } | null; client: { slug: string | null } | null };

async function rung3Rows(admin: SupabaseClient, focus: readonly string[]): Promise<Rung3Row[]> {
  const { data } = await admin
    .from("ladder_nudges")
    .select("id, item_key, client_id, client_name, owner_id, lead_id, what, href, since, created_at, line, owner:profiles!ladder_nudges_owner_id_fkey(full_name), lead:profiles!ladder_nudges_lead_id_fkey(full_name, role), client:clients(slug)")
    .not("exec_at", "is", null)
    .is("taken_by", null)
    .in("status", ["open", "sent"])
    .limit(500);
  const { roleLabel } = await import("@/lib/roles");
  return ((data ?? []) as unknown as NudgeRow[])
    .filter((r) => execHears(r.line, focus))
    .map((r) => ({
      id: r.id,
      itemKey: r.item_key,
      clientId: r.client_id,
      client: r.client_name,
      clientSlug: r.client?.slug ?? null,
      ownerId: r.owner_id,
      owner: r.owner?.full_name ?? "A teammate",
      leadId: r.lead_id,
      lead: r.lead?.full_name ?? "the lead",
      leadRole: r.lead?.role ?? "",
      leadLabel: r.lead?.role ? roleLabel(r.lead.role as Parameters<typeof roleLabel>[0]) : "Lead",
      what: r.what,
      since: r.since,
      reachedLead: r.created_at,
      line: r.line,
      href: r.href,
    }));
}

// ─── Accounts ────────────────────────────────────────────────────────────────

/** Which of the recap's account items belong to which focus line */
function accountLine(d: TodayDraft, creativeSide = false): string | null {
  if (creativeSide) return d.key.startsWith("allot-behind:") || d.key.startsWith("fatigue:") ? "creative" : null;
  if (d.key.startsWith("kpi:")) return / Google/.test(d.title) ? "google" : / TikTok/.test(d.title) ? "tiktok" : "meta";
  if (d.key.startsWith("email-score:") || d.key.startsWith("email-pace:")) return "email";
  if (/^social-(drop|score|target|quiet):/.test(d.key)) return "social";
  if (d.key.startsWith("allot-behind:")) return "creative";
  return null;
}

export async function accounts(admin: SupabaseClient, focus: readonly string[], drafts: readonly TodayDraft[], opts: { execRule?: boolean; creativeSide?: boolean } = { execRule: true }): Promise<ExecCard[]> {
  const mine = drafts
    .map((d) => ({ d, line: accountLine(d, opts.creativeSide) }))
    // Off target only (not "close to"), on a line in their focus
    .filter((x): x is { d: TodayDraft; line: string } => Boolean(x.line && (!focus.length || focus.includes(x.line)) && !(x.d.key.startsWith("kpi:") && / close to target/.test(x.d.title))));
  if (!mine.length) return [];
  const now = new Date();
  const day14 = new Date(now.getTime() - 14 * DAY).toISOString();
  const day7 = now.getTime() - 7 * DAY;
  const clientIds = [...new Set(mine.map((x) => x.d.clientId).filter((x): x is string => Boolean(x)))];
  const targets = mine.filter((x) => x.d.key.startsWith("kpi:")).map((x) => ({ id: x.d.key.slice(4), clientId: x.d.clientId ?? "" }));
  const { motionByTarget, accountsForExecs } = await import("@/lib/exec-focus/server");
  // Ad accounts reach an exec only at 50%+ off for over 7 days with nothing in motion; before that they're the lead's
  const reach = targets.length && opts.execRule !== false ? await accountsForExecs(admin, now).catch(() => new Map<string, { worse: number; days: number }>()) : new Map<string, { worse: number; days: number }>();
  const week = new Date(day7).toISOString();
  const [ads, { data: es }, { data: ss }, { data: ea }, { data: sa }, { data: eActs }, { data: sActs }] = await Promise.all([
    motionByTarget(admin, targets, now).catch(() => new Map<string, string | null>()),
    admin.from("email_sprints").select("id, client_id, started_at").eq("status", "active").in("client_id", clientIds),
    admin.from("social_sprints").select("id, client_id, started_at").eq("status", "active").in("client_id", clientIds),
    admin.from("email_audits").select("client_id, created_at, auto").in("client_id", clientIds).gte("created_at", day14),
    admin.from("social_audits").select("client_id, created_at, auto").in("client_id", clientIds).gte("created_at", day14),
    // Sprint actions a person ticked off this week (the sprints' automatic checks aren't the team moving)
    admin.from("email_sprint_actions").select("sprint_id").not("done_by", "is", null).gte("done_at", week).limit(1000),
    admin.from("social_sprint_actions").select("sprint_id").not("done_by", "is", null).gte("done_at", week).limit(1000),
  ]);
  const acted = new Set([...(eActs ?? []), ...(sActs ?? [])].map((a) => a.sprint_id as string));
  const moving = (rows: { id: string; client_id: string; started_at?: string | null }[] | null) => new Set((rows ?? []).filter((r) => acted.has(r.id) || (r.started_at && Date.parse(r.started_at) >= day7)).map((r) => r.client_id));
  const audited = (rows: { client_id: string; auto?: boolean | null }[] | null) => new Set((rows ?? []).filter((r) => !r.auto).map((r) => r.client_id));
  const email = new Set([...moving(es as never), ...audited(ea as never)]);
  const social = new Set([...moving(ss as never), ...audited(sa as never)]);
  // An account in trouble shows once: in the step-in deck (owner, Nov 23 2026). For execs, the Accounts block leaves out
  // ad accounts (every one that reaches an exec is a step-in card) and any client with an open step-in
  const stepped = new Set<string>();
  if (opts.execRule !== false) {
    const { data: open } = await admin.from("exec_stepins").select("client_id").eq("status", "open").limit(1000);
    for (const r of open ?? []) stepped.add(r.client_id as string);
  }
  const seen = new Set<string>();
  const cards: ExecCard[] = [];
  for (const { d, line } of [...mine].sort((a, b) => b.d.score - a.d.score)) {
    if (opts.execRule !== false && (d.key.startsWith("kpi:") || (d.clientId && stepped.has(d.clientId)))) continue;
    const motion = d.key.startsWith("kpi:") ? (ads.get(d.key.slice(4)) ?? null) : line === "email" ? (d.clientId && email.has(d.clientId) ? "A sprint or audit is moving" : null) : line === "social" ? (d.clientId && social.has(d.clientId) ? "A sprint or audit is moving" : null) : null;
    // The team is handling it: off the exec's screen
    if (motion) continue;
    if (opts.execRule !== false && d.key.startsWith("kpi:") && !reach.has(d.key.slice(4))) continue;
    const k = `${d.clientId ?? d.client}:${line}`;
    if (seen.has(k)) continue;
    seen.add(k);
    cards.push({
      // The exec's own item, linked to the buyer's ("kpi:<target>"), never the buyer's item itself
      key: `step:${d.key}`,
      tab: "accounts",
      kind: "account",
      client: d.client,
      clientId: d.clientId,
      clientSlug: d.clientSlug,
      title: d.title,
      detail: `${d.story} · Nothing in motion`.slice(0, 220),
      severity: d.score >= 80 ? "critical" : "high",
      line,
      stat: `${d.stat.value} ${d.stat.label}`.trim(),
      action: { label: "Step in", href: d.action.href ?? (d.clientSlug ? `/clients/${d.clientSlug}` : null) },
    });
  }
  return cards;
}

// ─── Pulse (read only) ───────────────────────────────────────────────────────

async function pulse(admin: SupabaseClient, fires: readonly FireRow[]): Promise<ExecCard[]> {
  const week = new Date(Date.now() - 7 * DAY).toISOString();
  const [{ data: open }, { data: climbed }, { count: closed }, { roleLabel }] = await Promise.all([
    admin.from("ladder_nudges").select("lead_id, lead:profiles!ladder_nudges_lead_id_fkey(full_name, role)").in("status", ["open", "sent"]).limit(2000),
    admin.from("ladder_nudges").select("lead_id").gte("exec_at", week).limit(2000),
    admin.from("done_checks").select("key", { count: "exact", head: true }).gte("closed_at", week).is("reopened_at", null),
    import("@/lib/roles"),
  ]);
  const cards: ExecCard[] = [];
  // Clients at risk of leaving, company-wide
  for (const f of fires) cards.push({ key: `pulse:fire:${f.clientId}`, tab: "pulse", kind: "pulse", client: f.client, clientId: f.clientId, clientSlug: f.clientSlug ?? null, title: `${f.client}: ${f.why}`, detail: "On fire: every exec sees it in Escalated", severity: "fire", action: { label: "Open it", href: f.href } });
  // Team health: each lead's backlog, and how much climbed past them this week
  const lead = new Map<string, { name: string; role: string; open: number; climbed: number }>();
  for (const r of (open ?? []) as unknown as { lead_id: string; lead: { full_name: string; role: string } | null }[]) {
    const l = lead.get(r.lead_id) ?? { name: r.lead?.full_name ?? "A lead", role: r.lead?.role ?? "", open: 0, climbed: 0 };
    l.open++;
    lead.set(r.lead_id, l);
  }
  for (const r of climbed ?? []) {
    const l = lead.get(r.lead_id as string);
    if (l) l.climbed++;
  }
  for (const [id, l] of [...lead.entries()].sort((a, b) => b[1].climbed - a[1].climbed || b[1].open - a[1].open))
    cards.push({
      key: `pulse:team:${id}`,
      tab: "pulse",
      kind: "pulse",
      client: null,
      clientId: null,
      title: `${l.role ? roleLabel(l.role as Parameters<typeof roleLabel>[0]) : "Lead"} (${first(l.name)}): ${l.open} behind on their team`,
      detail: l.climbed ? `${l.climbed} climbed past them to the execs this week` : "Nothing climbed past them this week",
      severity: l.climbed >= 5 ? "high" : "normal",
      action: { label: "See the team", href: null },
    });
  const climbedN = (climbed ?? []).length;
  cards.push({
    key: `pulse:week:${nyDay()}`,
    tab: "pulse",
    kind: "pulse",
    client: null,
    clientId: null,
    title: `This week: ${fires.length} ${s(fires.length, "client", "clients")} on fire, ${climbedN} ${s(climbedN, "item", "items")} escalated to execs`,
    detail: `${closed ?? 0} ${s(closed ?? 0, "item", "items")} closed themselves from Slack, email or call notes`,
    severity: "normal",
    action: { label: "Open the KPI board", href: "/kpis" },
  });
  return cards;
}

// ─── System (owner only) ─────────────────────────────────────────────────────

async function system(admin: SupabaseClient): Promise<ExecCard[]> {
  const [{ data: checks }, { data: fixes }, { data: untriaged }] = await Promise.all([
    admin.from("system_checks").select("key, ok, ran_at, result").order("ran_at", { ascending: false }).limit(200),
    admin.from("app_feedback_groups").select("id, title, status, fix_state, fix_pr_url, updated_at").or("fix_state.in.(pr_open,checks_failed),and(fix_state.eq.no_change,status.eq.in_progress)").order("updated_at", { ascending: false }).limit(20),
    admin.from("app_feedback").select("id, created_at, triage_tries").is("triaged_at", null).lte("created_at", new Date(Date.now() - 2 * 3_600_000).toISOString()).limit(200),
  ]);
  const cards: ExecCard[] = [];
  const latest = new Map<string, { key: string; ok: boolean; ran_at: string; result: unknown }>();
  for (const c of (checks ?? []) as { key: string; ok: boolean; ran_at: string; result: unknown }[]) if (!latest.has(c.key)) latest.set(c.key, c);
  for (const c of latest.values())
    if (!c.ok) cards.push({ key: `system:check:${c.key}`, tab: "system", kind: "system", client: null, clientId: null, title: `System check failing: ${c.key}`, detail: `Last ran ${short(c.ran_at)} · ${JSON.stringify(c.result ?? {}).slice(0, 120)}`, severity: "critical", action: { label: "Open errors", href: "/settings?tab=errors" } });
  for (const f of (fixes ?? []) as { id: string; title: string; status: string; fix_state: string; fix_pr_url: string | null; updated_at: string }[])
    cards.push({
      key: `system:fix:${f.id}`,
      tab: "system",
      kind: "system",
      client: null,
      clientId: null,
      title: f.fix_state === "checks_failed" ? `A Claude fix failed its checks: ${f.title}` : f.fix_state === "pr_open" ? `A Claude fix is waiting for a look: ${f.title}` : `Claude found nothing to change: ${f.title}`,
      detail: `Updated ${short(f.updated_at)}`,
      severity: f.fix_state === "checks_failed" ? "critical" : "high",
      action: { label: f.fix_pr_url ? "Open the fix" : "Open feedback", href: f.fix_pr_url ?? "/feedback" },
    });
  // Teammates Asana doesn't know by their work email: their "Next for me in Asana" would be empty
  const { asanaUnmapped } = await import("@/lib/asana-live");
  const unmapped = await asanaUnmapped(admin).catch(() => []);
  if (unmapped.length)
    cards.push({ key: `system:asana:${nyDay()}`, tab: "system", kind: "system", client: null, clientId: null, title: `${unmapped.length} ${s(unmapped.length, "teammate isn't", "teammates aren't")} matched to Asana`, detail: `${unmapped.slice(0, 6).map((u) => `${u.name} (${u.email})`).join(", ")}${unmapped.length > 6 ? ` and ${unmapped.length - 6} more` : ""}: invite their work email to Asana, or change it in Settings`, severity: "high", action: { label: "Open the team", href: "/settings?tab=team" } });
  const stuck = (untriaged ?? []).length;
  if (stuck)
    cards.push({ key: `system:triage:${nyDay()}`, tab: "system", kind: "system", client: null, clientId: null, title: `${stuck} feedback ${s(stuck, "report hasn't", "reports haven't")} been triaged`, detail: `Oldest from ${short(String((untriaged ?? [])[(untriaged ?? []).length - 1]?.created_at ?? new Date().toISOString()))}: the feedback pipeline may be stuck`, severity: stuck >= 5 ? "critical" : "high", action: { label: "Open feedback", href: "/feedback" } });
  return cards;
}

// ─── The model ───────────────────────────────────────────────────────────────

export type ExecModel = Record<ExecTab, ExecCard[]>;

/** Everything on an exec's Overview and recap, from the recap's own gathered items (for Accounts) and live reads */
export async function loadExecModel(db: SupabaseClient, me: Staff, drafts: readonly TodayDraft[]): Promise<ExecModel> {
  const admin = await adminOr(db);
  const [{ loadExecFocus, liveFires }] = await Promise.all([import("@/lib/exec-focus/server")]);
  const focus = await loadExecFocus(db, me.id);
  const [needs, rows, fires] = await Promise.all([needsMe(db, admin, me, drafts).catch(() => []), rung3Rows(admin, focus).catch(() => []), liveFires(admin).catch(() => [])]);
  const fireRows: FireRow[] = fires.map((f) => ({ clientId: f.clientId, client: f.client, clientSlug: f.clientSlug, why: f.why, href: f.href, line: f.line, at: f.at }));
  const [acc, pul, sys, asana] = await Promise.all([accounts(admin, focus, drafts).catch(() => []), pulse(admin, fireRows).catch(() => []), me.canViewAs ? system(admin).catch(() => []) : Promise.resolve([]), asanaCards(db, me.email).catch(() => [])]);
  return { needs, escalated: groupEscalated(rows, fireRows), accounts: acc, asana, pulse: pul, system: sortCards(sys) };
}

const TAB_TOPIC: Record<ExecTab, TopicKey> = { needs: "needs", escalated: "escalated", accounts: "accounts", asana: "asana", pulse: "pulse", system: "system" };

/** A card as a recap item (the story plays the same cards, tab by tab) */
export function cardToDraft(c: ExecCard): TodayDraft {
  const overdue = c.due && Date.parse(c.due) < Date.now();
  const score =
    c.tab === "escalated"
      ? c.severity === "fire"
        ? 99
        : 84
      : c.tab === "needs"
        ? Math.min(95, (overdue ? 86 : c.due ? 72 : 64) + (c.severity === "critical" ? 6 : 0))
        : c.tab === "asana"
          ? overdue ? 74 : c.due ? 58 : 45
        : c.tab === "accounts"
          ? c.severity === "critical"
            ? 82
            : 70
          : c.tab === "system"
            ? c.severity === "critical"
              ? 80
              : 55
            : c.severity === "fire"
              ? 60
              : 30;
  const stat =
    c.tab === "accounts" && c.stat
      ? { value: c.stat.split(" ")[0], label: c.stat.split(" ").slice(1).join(" ") }
      : c.tab === "escalated"
        ? { value: c.severity === "fire" ? "On fire" : `${c.nudgeIds?.length ?? 1}`, label: c.severity === "fire" ? "skipped the ladder" : "stuck past the lead" }
        : c.due
          ? { value: short(c.due), label: overdue ? "overdue" : "due" }
          : { value: "", label: "" };
  return {
    key: c.key,
    topic: TAB_TOPIC[c.tab],
    score,
    client: c.client ?? (c.tab === "system" ? "Kaizen OS" : c.tab === "pulse" ? "The agency" : "Team"),
    clientSlug: c.clientSlug ?? "",
    clientId: c.clientId,
    stat,
    title: c.title,
    story: c.detail,
    why: c.tab === "asana" ? "Yours in Asana" : c.tab === "escalated" ? (c.severity === "fire" ? "A fire: every exec sees it at once" : "48 hours with the lead and nothing moving") : c.tab === "accounts" ? "Off target with nothing in motion" : c.tab === "needs" ? "On you" : c.tab === "system" ? "Kaizen OS itself" : "For the picture",
    evidence: [],
    // A card with no link of its own (Nudge the lead) opens on the Overview, where its composer is
    action: { label: c.action.label, href: c.action.href ?? `/pipeline?block=${c.tab}` },
    due: c.due ?? null,
    exec: c,
  };
}

/** An exec's day: the model's cards, tab by tab (the recap plays Needs me, Escalated, Accounts, Pulse, System) */
export async function execDrafts(db: SupabaseClient, me: Staff, drafts: readonly TodayDraft[]): Promise<TodayDraft[]> {
  const m = await loadExecModel(db, me, drafts);
  return [...m.needs, ...m.escalated, ...m.accounts, ...m.asana, ...m.pulse, ...m.system].map(cardToDraft);
}

/**
 * A lead's Pulse, read only: their team's backlog (their own linked items, stuck with a teammate 48 hours) and what
 * climbed past them to the execs this week
 */
export async function leadPulse(admin: SupabaseClient, leadId: string): Promise<ExecCard[]> {
  const week = new Date(Date.now() - 7 * DAY).toISOString();
  const [{ data: open }, { count: climbed }] = await Promise.all([
    admin.from("ladder_nudges").select("owner_id, owner:profiles!ladder_nudges_owner_id_fkey(full_name)").eq("lead_id", leadId).in("status", ["open", "sent"]).limit(500),
    admin.from("ladder_nudges").select("id", { count: "exact", head: true }).eq("lead_id", leadId).gte("exec_at", week),
  ]);
  const by = new Map<string, number>();
  for (const r of (open ?? []) as unknown as { owner: { full_name: string } | null }[]) by.set(r.owner?.full_name ?? "A teammate", (by.get(r.owner?.full_name ?? "A teammate") ?? 0) + 1);
  const people = [...by.entries()].sort((a, b) => b[1] - a[1]);
  return [
    {
      key: `pulse:line:${leadId}:${nyDay()}`,
      tab: "pulse",
      kind: "pulse",
      client: null,
      clientId: null,
      title: `Your team: ${(open ?? []).length} ${s((open ?? []).length, "item", "items")} stuck 48 hours, ${climbed ?? 0} climbed past you to the execs this week`,
      detail: people.length ? people.slice(0, 5).map(([n, k]) => `${first(n)} ${k}`).join(" · ") : "Nothing stuck with your team",
      severity: (climbed ?? 0) >= 5 ? "high" : "normal",
      action: { label: "", href: null },
    },
  ];
}
