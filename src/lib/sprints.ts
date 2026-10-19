import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import type { AuditResult } from "@/lib/audit";
import { accountSetup, metaConfigured, type AccountSetup } from "@/lib/context/meta";
import { conversionFor, conversionLabel } from "@/lib/kpi/conversions";

// Optimization sprints: an audit's plan, followed through with the buyer. The audit opens one on its account, assigned
// to the KPI's buyer and watched by whoever ran it. Every day (or on the follow-up date it set) the check re-reads the
// account: what changed in Meta since last time, which actions were ticked, and how the KPI moved since the start. It
// then tells the buyer what it sees, and sets when it looks again: tomorrow when nothing's moving or a change looks
// wrong, a few days out when the right changes are in and need time to read.

const DAY = 86_400_000;
type Kpi = { value: number | null; target: number | null; spend: number; results: number; status: string | null; d3: number | null; d7: number | null; roas: boolean; label: string };

/** The next check: `days` from now, at about 9am New York. */
const checkAt = (days: number) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(13, 0, 0, 0);
  if (d.getTime() < Date.now() + 2 * 3_600_000) d.setTime(d.getTime() + DAY);
  return d.toISOString();
};

async function kpiNow(admin: SupabaseClient, targetId: string): Promise<Kpi> {
  const [{ data: t }, { data: s }] = await Promise.all([
    admin.from("kpi_targets").select("conversion, custom_action, target").eq("id", targetId).single(),
    admin.from("kpi_snapshots").select("windows, status").eq("target_id", targetId).maybeSingle(),
  ]);
  const w = (s?.windows ?? {}) as Record<string, { value: number | null; spend: number; results: number } | undefined>;
  return {
    value: w.d14?.value ?? null,
    target: t?.target == null ? null : Number(t.target),
    spend: w.d14?.spend ?? 0,
    results: w.d14?.results ?? 0,
    status: s?.status ?? null,
    d3: w.d3?.value ?? null,
    d7: w.d7?.value ?? null,
    roas: Boolean(conversionFor(t?.conversion ?? "purchases").roas),
    label: conversionLabel(t?.conversion ?? "purchases", t?.custom_action),
  };
}

/**
 * Opens (or extends) the sprint for an audit's account. The plan's "today" and "this week" moves go straight onto the
 * action list; "next" ones can be added from the audit. Called when an audit finishes.
 */
export async function openSprint(admin: SupabaseClient, auditId: string) {
  const { data: a } = await admin.from("account_audits").select("target_id, client_id, created_by, result").eq("id", auditId).single();
  if (!a?.result) return null;
  const r = a.result as AuditResult;
  const { data: t } = await admin.from("kpi_targets").select("owner_id, ad_account_id").eq("id", a.target_id).single();
  const buyer = t?.owner_id ?? a.created_by;
  const watchers = a.created_by && a.created_by !== buyer ? [a.created_by] : [];
  const kpi = await kpiNow(admin, a.target_id);

  const { data: open } = await admin.from("optimization_sprints").select("id, watcher_ids").eq("target_id", a.target_id).eq("status", "active").maybeSingle();
  let sprintId = open?.id as string | undefined;
  if (sprintId) {
    await admin
      .from("optimization_sprints")
      .update({ audit_id: auditId, next_check_at: checkAt(1), watcher_ids: [...new Set([...((open!.watcher_ids ?? []) as string[]), ...watchers])] })
      .eq("id", sprintId);
  } else {
    const setup = metaConfigured() && t?.ad_account_id ? await accountSetup(t.ad_account_id).catch(() => null) : null;
    const { data, error } = await admin
      .from("optimization_sprints")
      .insert({ target_id: a.target_id, client_id: a.client_id, audit_id: auditId, buyer_id: buyer, watcher_ids: watchers, created_by: a.created_by, baseline: kpi, latest: kpi, setup, next_check_at: checkAt(1) })
      .select("id")
      .single();
    if (error || !data) throw new Error(error?.message ?? "Couldn't open the sprint");
    sprintId = data.id as string;
  }

  // A new audit replaces the plan: moves still to do from the last one go, so there's never two plans at once.
  // Moves already done stay as the record of what was done.
  let replaced = 0;
  if (open) {
    const { data: gone } = await admin.from("sprint_actions").delete().eq("sprint_id", sprintId).in("status", ["todo", "doing"]).select("id");
    replaced = gone?.length ?? 0;
  }
  const { data: have } = await admin.from("sprint_actions").select("title, sort_order").eq("sprint_id", sprintId);
  const titles = new Set((have ?? []).map((x) => x.title));
  let order = Math.max(0, ...(have ?? []).map((x) => x.sort_order as number)) + 1;
  const fresh = r.actions
    .map((x, i) => ({ x, i }))
    .filter(({ x }) => (x.when === "now" || x.when === "this_week") && !titles.has(x.title))
    .map(({ x, i }) => ({ sprint_id: sprintId, audit_index: i, title: x.title, area: x.area, owner: x.owner, when: x.when, steps: x.steps, why: x.why, impact: x.impact, sort_order: order++ }));
  if (fresh.length) await admin.from("sprint_actions").insert(fresh);
  await admin.from("sprint_checks").insert({
    sprint_id: sprintId,
    verdict: "started",
    message: open
      ? `A new audit replaced the plan: ${replaced} open ${replaced === 1 ? "move" : "moves"} from the last one came off and ${fresh.length} new ${fresh.length === 1 ? "one is" : "ones are"} on the list (moves already done stay). ${r.verdict.headline} I'll check the account tomorrow morning.`
      : `Sprint started from the audit with ${fresh.length} ${fresh.length === 1 ? "move" : "moves"} on the action list. ${r.verdict.headline} I'll check the account tomorrow morning and every day after until it's back on target.`,
    kpi,
    next_check_at: checkAt(1),
  });
  return sprintId;
}

/** Adds one of an audit's actions (usually a "next" one) to the account's sprint, opening it if needed. */
export async function addAuditAction(admin: SupabaseClient, auditId: string, index: number) {
  const { data: a } = await admin.from("account_audits").select("target_id, result").eq("id", auditId).single();
  const x = (a?.result as AuditResult | null)?.actions[index];
  if (!a || !x) throw new Error("That action isn't in the audit");
  let { data: s } = await admin.from("optimization_sprints").select("id, audit_id").eq("target_id", a.target_id).eq("status", "active").maybeSingle();
  // An older audit's plan was replaced: its moves can't come back alongside the new plan
  if (s && s.audit_id && s.audit_id !== auditId) throw new Error("A newer audit replaced this plan. Add moves from the latest audit instead.");
  if (!s) {
    const id = await openSprint(admin, auditId);
    s = id ? { id, audit_id: auditId } : null;
  }
  if (!s) throw new Error("Couldn't open the sprint");
  const { data: dup } = await admin.from("sprint_actions").select("id").eq("sprint_id", s.id).eq("title", x.title).maybeSingle();
  if (!dup) await admin.from("sprint_actions").insert({ sprint_id: s.id, audit_index: index, title: x.title, area: x.area, owner: x.owner, when: x.when, steps: x.steps, why: x.why, impact: x.impact, sort_order: 999 });
  return s.id as string;
}

// ─── What changed in Meta ───────────────────────────────────────────────────

function setupChanges(before: AccountSetup | null, now: AccountSetup | null) {
  if (!before || !now) return [];
  const out: string[] = [];
  const money = (v: number | null) => (v == null ? "none" : `$${v}`);
  const bc = new Map(before.campaigns.map((c) => [c.id, c]));
  for (const c of now.campaigns) {
    const b = bc.get(c.id);
    if (!b) {
      out.push(`New campaign "${c.name}" (${c.objective}, ${c.status})`);
      continue;
    }
    if (b.status !== c.status) out.push(`Campaign "${c.name}" went from ${b.status} to ${c.status}`);
    if (b.dailyBudget !== c.dailyBudget) out.push(`Campaign "${c.name}" daily budget ${money(b.dailyBudget)} → ${money(c.dailyBudget)}`);
    if (b.bidStrategy !== c.bidStrategy) out.push(`Campaign "${c.name}" bidding ${b.bidStrategy ?? "none"} → ${c.bidStrategy ?? "none"}`);
  }
  for (const b of before.campaigns) if (!now.campaigns.some((c) => c.id === b.id)) out.push(`Campaign "${b.name}" is gone (deleted or archived)`);
  const ba = new Map(before.adsets.map((x) => [x.id, x]));
  for (const x of now.adsets) {
    const b = ba.get(x.id);
    if (!b) {
      out.push(`New ad set "${x.name}" optimizing for ${x.optimization}${x.dailyBudget ? `, $${x.dailyBudget}/day` : ""}`);
      continue;
    }
    if (b.status !== x.status) out.push(`Ad set "${x.name}" went from ${b.status} to ${x.status}`);
    if (b.dailyBudget !== x.dailyBudget) out.push(`Ad set "${x.name}" daily budget ${money(b.dailyBudget)} → ${money(x.dailyBudget)}`);
    if (b.optimization !== x.optimization || b.event !== x.event) out.push(`Ad set "${x.name}" now optimizes for ${x.optimization}${x.event ? ` (${x.event})` : ""}`);
    if (b.bidStrategy !== x.bidStrategy || b.bidAmount !== x.bidAmount) out.push(`Ad set "${x.name}" bidding changed to ${x.bidStrategy ?? "none"}${x.bidAmount ? ` $${x.bidAmount}` : ""}`);
    if (JSON.stringify(b.audience) !== JSON.stringify(x.audience)) out.push(`Ad set "${x.name}" audience changed (now ${x.audience?.ages} ${x.audience?.genders}, ${x.audience?.geo}${x.audience?.advantage ? ", Advantage+" : ""})`);
  }
  return out;
}

/** Ads that started or stopped spending since the last check. */
async function adChanges(admin: SupabaseClient, clientId: string, account: string, since: string) {
  const from = new Date(Date.parse(since) - 7 * DAY).toISOString().slice(0, 10);
  const { data } = await admin.from("meta_ad_daily").select("date, ad_id, ad_name, metrics").eq("client_id", clientId).eq("ad_account_id", account).gte("date", from).limit(5000);
  const cut = since.slice(0, 10);
  const spentBefore = new Set<string>();
  const spentAfter = new Map<string, string>();
  const firstEver = new Map<string, string>();
  for (const r of data ?? []) {
    if (!(Number((r.metrics as { spend?: string }).spend) > 0)) continue;
    if (r.date < cut) spentBefore.add(r.ad_id);
    else spentAfter.set(r.ad_id, r.ad_name ?? r.ad_id);
    if (!firstEver.has(r.ad_id) || r.date < firstEver.get(r.ad_id)!) firstEver.set(r.ad_id, r.date);
  }
  const out: string[] = [];
  for (const [id, name] of spentAfter) if (!spentBefore.has(id) && (firstEver.get(id) ?? "") >= cut) out.push(`New ad live: "${name}"`);
  const stopped = [...spentBefore].filter((id) => !spentAfter.has(id));
  if (stopped.length) {
    const names = (data ?? []).filter((r) => stopped.includes(r.ad_id)).map((r) => r.ad_name);
    out.push(`${stopped.length} ${stopped.length === 1 ? "ad" : "ads"} stopped spending: ${[...new Set(names)].slice(0, 5).map((n) => `"${n}"`).join(", ")}`);
  }
  return out;
}

// ─── The check ──────────────────────────────────────────────────────────────

const CHECK_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["no_action", "wrong_move", "on_track", "improving", "worse", "done"] },
    message: { type: "string" },
    next_check_days: { type: "integer" },
    actions: { type: "array", items: { type: "object", properties: { n: { type: "integer" }, status: { type: "string", enum: ["looks_done", "partly", "not_done"] }, note: { type: "string" } }, required: ["n", "status", "note"], additionalProperties: false } },
    learning: {
      type: "object",
      properties: { kind: { type: "string", enum: ["none", "prefer", "avoid"] }, body: { type: "string" }, from: { type: "array", items: { type: "integer" } } },
      required: ["kind", "body", "from"],
      additionalProperties: false,
    },
  },
  required: ["verdict", "message", "next_check_days", "actions", "learning"],
  additionalProperties: false,
};

const CHECK_SYSTEM = `You are Kaizen's Media Buyer agent, following an optimization sprint on one ad account with the buyer who runs it. An audit found why the account is off its KPI target and wrote a plan; the buyer's action list comes from it. Each check you see what changed in Meta since the last check, what the buyer ticked off, and how the KPI has moved since the sprint started. Talk to the buyer directly, first person, short and specific (3 to 6 sentences).

verdict and message:
- no_action: nothing changed in the account and nothing was ticked since the last check. Remind them plainly what's still undone (name the top one or two moves), and what waiting costs (spend at the current cost per result vs the target). Firm, not rude: "You still haven't made the changes on this account and it's going to keep missing target." next_check_days 1.
- wrong_move: changes were made, but they don't match the plan or go against Kaizen's playbooks and Meta best practice (resetting learning on a winner, starving the best ad set, splitting budget thinner, changing several things at once, chasing a 1-day swing). Say what you saw, why it likely won't get the outcome we want, and what to do instead. next_check_days 1.
- on_track: the right changes are in. Say what you saw and that you'll check back in N days to see how it's reading (usually 3, enough for learning and data to settle). next_check_days that N.
- improving or worse: enough time has passed since the changes to read results. Say what moved, with numbers, and what's next on the list. Don't call a result on 1 to 2 days of data or a handful of results.
- done: the plan's key moves are done and the KPI is at or better than target. Say so and suggest closing the sprint.
actions: for each action on the list (by its number), whether the Meta changes show it done (looks_done, partly, not_done) with a short note. Only judge what the changes or ticks show.
learning: the lesson for the client page, only when it's earned. kind prefer when a completed move clearly improved results with enough data to trust it (a week or more, real volume); kind avoid when a change clearly made it worse. body: one sentence written as a rule for next time ("Consolidating to one broad ad set brought cost per purchase down for this account; keep it consolidated"). from: the numbers of the actions it came from. Otherwise kind none and body empty. Never repeat a lesson already learned from the same actions.
Never invent changes or numbers. Refer to people by role, never by name. No em dashes.`;

const fmt = (k: Kpi, v: number | null) => (v == null ? "no results" : k.roas ? `${v}x ROAS` : `$${v} per ${k.label.toLowerCase().replace(/s$/, "")}`);

type ActionForCheck = { status: string; done_at: string | null; source: string | null; learned: boolean | null; title: string; watch: string | null; note: string | null; answers: unknown };
/** One action as the check reads it: status, who added it, how to judge it, and the buyer's notes and answers. */
function actionLine(x: ActionForCheck, i: number) {
  const qa = (x.answers ?? []) as { q: string; a: string }[];
  const tags = [x.status, x.done_at ? `ticked ${x.done_at.slice(0, 10)}` : "", x.source === "buyer" ? "added by the buyer" : "", x.learned ? "lesson already learned" : ""].filter(Boolean).join(", ");
  return `${i + 1}. [${tags}] ${x.title}${x.watch ? ` · judge it by: ${x.watch}` : ""}${x.note ? ` (buyer's note: ${x.note})` : ""}${qa.length ? ` (context: ${qa.map((y) => `${y.q} ${y.a}`).join("; ")})` : ""}`;
}

/** One check on one sprint: what changed, what the buyer did, and what to tell them. */
export async function checkSprint(admin: SupabaseClient, sprintId: string) {
  const { data: s } = await admin.from("optimization_sprints").select("*, kpi_targets(ad_account_id), clients(name)").eq("id", sprintId).single();
  if (!s || s.status !== "active") return null;
  const account = (s.kpi_targets as unknown as { ad_account_id: string | null } | null)?.ad_account_id?.replace(/^act_/, "") ?? null;
  const since = (s.last_check_at ?? s.started_at) as string;
  const [kpi, setupNow, { data: actions }, { data: audit }] = await Promise.all([
    kpiNow(admin, s.target_id),
    metaConfigured() && account ? accountSetup(account).catch(() => null) : Promise.resolve(null),
    admin.from("sprint_actions").select("id, title, why, status, note, done_at, \"when\", watch, answers, source, learned").eq("sprint_id", sprintId).order("sort_order"),
    s.audit_id ? admin.from("account_audits").select("result").eq("id", s.audit_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const changes = [...setupChanges(s.setup as AccountSetup | null, setupNow), ...(account ? await adChanges(admin, s.client_id, account, since) : [])];
  const ticked = (actions ?? []).filter((x) => x.done_at && x.done_at > since);
  const base = s.baseline as Kpi;
  const r = audit?.result as AuditResult | null;
  const days = Math.max(1, Math.round((Date.now() - Date.parse(s.started_at)) / DAY));

  const out = await askJson<{
    verdict: "no_action" | "wrong_move" | "on_track" | "improving" | "worse" | "done";
    message: string;
    next_check_days: number;
    actions: { n: number; status: string; note: string }[];
    learning: { kind: "none" | "prefer" | "avoid"; body: string; from: number[] };
  }>({
    agent: "auditor",
    label: `sprint check ${(s.clients as unknown as { name: string } | null)?.name ?? ""}`,
    system: CHECK_SYSTEM,
    schema: CHECK_SCHEMA,
    prompt: `<sprint client="${(s.clients as unknown as { name: string } | null)?.name ?? ""}" day="${days}">
KPI: ${base.label}. Target: ${fmt(base, base.target)}.
At the start: ${fmt(base, base.value)} over 14 days ($${Math.round(base.spend)} spend, ${base.results} results).
Now: ${fmt(kpi, kpi.value)} over 14 days ($${Math.round(kpi.spend)} spend, ${kpi.results} results); last 7 days ${fmt(kpi, kpi.d7)}; last 3 days ${fmt(kpi, kpi.d3)}.
Last check: ${s.last_check_at ? new Date(s.last_check_at).toISOString().slice(0, 10) : "none yet (sprint just started)"}.
</sprint>

<what_the_audit_found>
${r ? `${r.verdict.headline}\n${r.diagnosis}\nRoot causes: ${r.causes.map((c) => c.title).join("; ")}` : "(audit not available)"}
</what_the_audit_found>

<action_list>
${(actions ?? []).map((x, i) => actionLine(x, i)).join("\n") || "(empty)"}
</action_list>

<changes_in_meta_since_last_check>
${changes.length ? changes.map((c) => `- ${c}`).join("\n") : setupNow ? "(none: nothing changed in campaigns, ad sets, budgets, bidding or audiences, and no ads started or stopped)" : "(couldn't read the live setup from Meta; only ad starts and stops are known)"}
</changes_in_meta_since_last_check>

<ticked_since_last_check>
${ticked.map((x) => `- ${x.title}`).join("\n") || "(nothing)"}
</ticked_since_last_check>`,
  });

  const next = checkAt(Math.max(1, Math.min(7, out.next_check_days || 1)));
  await admin.from("sprint_checks").insert({ sprint_id: sprintId, verdict: out.verdict, message: out.message.replace(/\s*—\s*/g, ", "), changes, kpi, next_check_at: next });
  for (const u of out.actions) {
    const x = (actions ?? [])[u.n - 1];
    if (x) await admin.from("sprint_actions").update({ ai_note: `${u.status === "looks_done" ? "Looks done in Meta" : u.status === "partly" ? "Partly done" : "Not seen in Meta yet"}: ${u.note}`.slice(0, 400) }).eq("id", x.id);
  }
  // The learning loop: what worked (or backfired) goes to the client page, once per move
  if (out.learning?.kind && out.learning.kind !== "none" && out.learning.body.trim()) {
    await admin.from("client_memory").insert({ client_id: s.client_id, kind: out.learning.kind, source: "sprint", created_by: s.buyer_id, body: out.learning.body.replace(/\s*—\s*/g, ", ").slice(0, 1000) });
    const ids = out.learning.from.map((n) => (actions ?? [])[n - 1]?.id).filter(Boolean) as string[];
    if (ids.length) await admin.from("sprint_actions").update({ learned: true }).in("id", ids);
  }
  await admin.from("optimization_sprints").update({ latest: kpi, setup: setupNow ?? s.setup, last_check_at: new Date().toISOString(), next_check_at: next }).eq("id", sprintId);
  return out.verdict;
}

/** The scheduled step: every active sprint whose check is due, a few at a time. */
export async function checkDueSprints(admin: SupabaseClient, deadline = Date.now() + 600_000) {
  const { data } = await admin.from("optimization_sprints").select("id").eq("status", "active").lte("next_check_at", new Date().toISOString()).order("next_check_at").limit(25);
  let checked = 0;
  const errors: string[] = [];
  for (const s of data ?? []) {
    if (Date.now() > deadline) break;
    try {
      await checkSprint(admin, s.id);
      checked++;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      // Don't hammer a broken one: look again in a few hours
      await admin.from("optimization_sprints").update({ next_check_at: new Date(Date.now() + 4 * 3_600_000).toISOString() }).eq("id", s.id);
    }
  }
  return { due: data?.length ?? 0, checked, errors };
}

export type SprintSummary = { id: string; buyer: string | null; buyerId: string | null; done: number; total: number; verdict: string | null; message: string | null; lastCheckAt: string | null; nextCheckAt: string; startedAt: string; watcherIds: string[] };

/** Active sprints by KPI, for the board and Next for me. */
export async function loadSprints(db: SupabaseClient, opts: { targetIds?: string[]; personId?: string } = {}) {
  let q = db.from("optimization_sprints").select("id, target_id, client_id, buyer_id, watcher_ids, started_at, last_check_at, next_check_at, profiles!optimization_sprints_buyer_id_fkey(full_name), clients(name, slug), kpi_targets(label)").eq("status", "active");
  if (opts.targetIds) q = q.in("target_id", opts.targetIds);
  if (opts.personId) q = q.or(`buyer_id.eq.${opts.personId},watcher_ids.cs.{${opts.personId}}`);
  const { data: sprints } = await q;
  const ids = (sprints ?? []).map((s) => s.id);
  const [{ data: actions }, { data: checks }] = await Promise.all([
    ids.length ? db.from("sprint_actions").select("sprint_id, status").in("sprint_id", ids) : Promise.resolve({ data: [] }),
    ids.length ? db.from("sprint_checks").select("sprint_id, verdict, message, created_at").in("sprint_id", ids).order("created_at", { ascending: false }).limit(500) : Promise.resolve({ data: [] }),
  ]);
  return (sprints ?? []).map((s) => {
    const mine = (actions ?? []).filter((a) => a.sprint_id === s.id && a.status !== "skipped");
    const last = (checks ?? []).find((c) => c.sprint_id === s.id);
    return {
      targetId: s.target_id as string,
      client: (s.clients as unknown as { name: string; slug: string } | null)?.name ?? "",
      clientSlug: (s.clients as unknown as { name: string; slug: string } | null)?.slug ?? "",
      label: (s.kpi_targets as unknown as { label: string | null } | null)?.label ?? null,
      sprint: {
        id: s.id,
        buyer: (s.profiles as unknown as { full_name: string } | null)?.full_name ?? null,
        buyerId: s.buyer_id,
        done: mine.filter((a) => a.status === "done").length,
        total: mine.length,
        verdict: last?.verdict ?? null,
        message: last?.message ?? null,
        lastCheckAt: s.last_check_at,
        nextCheckAt: s.next_check_at,
        startedAt: s.started_at,
        watcherIds: (s.watcher_ids ?? []) as string[],
      } satisfies SprintSummary,
    };
  });
}

// ─── The client's version ───────────────────────────────────────────────────

export type ClientReport = { headline: string; summary: string; found: { title: string; detail: string }[]; doing: { title: string; detail: string; when: string }[]; watching: { title: string; detail: string }[]; nextUpdate: string };

const CLIENT_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string" },
    summary: { type: "string" },
    found: { type: "array", items: { type: "object", properties: { title: { type: "string" }, detail: { type: "string" } }, required: ["title", "detail"], additionalProperties: false } },
    doing: { type: "array", items: { type: "object", properties: { title: { type: "string" }, detail: { type: "string" }, when: { type: "string" } }, required: ["title", "detail", "when"], additionalProperties: false } },
    watching: { type: "array", items: { type: "object", properties: { title: { type: "string" }, detail: { type: "string" } }, required: ["title", "detail"], additionalProperties: false } },
    nextUpdate: { type: "string" },
  },
  required: ["headline", "summary", "found", "doing", "watching", "nextUpdate"],
  additionalProperties: false,
};

const CLIENT_SYSTEM = `You turn Kaizen Marketing's internal ad account audit into the version the client reads: a short, confident, professional report from the agency, in Kaizen's voice ("we", "your account").
headline: one line on where the account stands. summary: 2 or 3 sentences, honest about the gap to target and clear that we have a plan.
found: 3 to 5 findings in plain language a business owner understands, with the key numbers (no jargon like "CPM" without saying what it means).
doing: 4 to 7 things we're doing about it ("We're consolidating your campaigns so Meta's learning isn't split…"), each with when (this week, over the next two weeks…). Only the moves Kaizen does or that need the client; drop internal housekeeping. If something needs the client (the offer, the website, tracking access, stock), say clearly what we need from them.
watching: 2 to 4 things we're watching and what good looks like.
nextUpdate: when and how we'll update them.
Never mention internal tools, agents, other clients, the Hall of Fame, the team's names, or anything that blames a person at Kaizen. Don't promise results; promise the work. No em dashes.`;

/** The client-facing version of an audit, written once and kept. */
export async function writeClientReport(admin: SupabaseClient, auditId: string): Promise<ClientReport> {
  const { data: a } = await admin.from("account_audits").select("result, client_report, clients(name), kpi_targets(conversion, custom_action, target)").eq("id", auditId).single();
  if (!a?.result) throw new Error("The audit isn't finished");
  if (a.client_report) return a.client_report as ClientReport;
  const r = a.result as AuditResult;
  const c = (a.clients as unknown as { name: string } | null)?.name ?? "the client";
  const out = await askJson<ClientReport>({
    agent: "auditor",
    label: `audit client report ${c}`,
    system: CLIENT_SYSTEM,
    schema: CLIENT_SCHEMA,
    maxTokens: 12000,
    prompt: `Client: ${c}.\n\n<internal_audit>\n${JSON.stringify({ verdict: r.verdict, diagnosis: r.diagnosis, causes: r.causes, actions: r.actions, budget: r.budget, watch: r.watch, questions: r.questions })}\n</internal_audit>`,
  });
  const clean = JSON.parse(JSON.stringify(out).replace(/\s*—\s*/g, ", ")) as ClientReport;
  await admin.from("account_audits").update({ client_report: clean }).eq("id", auditId);
  return clean;
}

// ─── Moves someone adds ─────────────────────────────────────────────────────

const MOVE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    steps: { type: "array", items: { type: "string" } },
    why: { type: "string" },
    impact: { type: "string" },
    watch: { type: "string" },
    questions: { type: "array", items: { type: "string" } },
  },
  required: ["title", "steps", "why", "impact", "watch", "questions"],
  additionalProperties: false,
};

const MOVE_SYSTEM = `You are Kaizen's Media Buyer agent. A buyer is adding their own move to an account's optimization sprint, in their own words. Turn it into a move the daily check can follow:
title: short and imperative, specific to the account. steps: 2 to 5 short imperative lines (what exactly to change, where). why: how it should help, tied to what the audit found. impact: what it should move and roughly how much. watch: what the daily check should look for to judge it (which campaign or ad set, which number, after how long).
questions: 0 to 3 short questions only where the answer changes how to judge it (which campaign, what budget, what it replaces, when it goes live). Ask nothing you can work out from the context. If the move goes against the audit or Kaizen's playbooks, keep it but say so in why, plainly.
Use the buyer's intent; never invent numbers. Refer to people by role. No em dashes.`;

type Move = { title: string; steps: string[]; why: string; impact: string; watch: string; questions: string[] };
const noDash = (x: string) => x.replace(/\s*—\s*/g, ", ");

async function sprintContext(admin: SupabaseClient, sprintId: string) {
  const { data: s } = await admin.from("optimization_sprints").select("audit_id, baseline, latest, clients(name)").eq("id", sprintId).single();
  const { data: audit } = s?.audit_id ? await admin.from("account_audits").select("result").eq("id", s.audit_id).maybeSingle() : { data: null };
  const { data: actions } = await admin.from("sprint_actions").select("title, status").eq("sprint_id", sprintId).order("sort_order");
  const r = audit?.result as AuditResult | null;
  const k = s?.latest as Kpi | undefined;
  return [
    `<sprint client="${(s?.clients as unknown as { name: string } | null)?.name ?? ""}">`,
    `KPI now: ${k ? fmt(k, k.value) : "?"} over 14 days; target ${k ? fmt(k, k.target) : "?"}.`,
    r ? `What the audit found: ${r.verdict.headline} ${r.causes.map((c) => c.title).join("; ")}` : "",
    `On the list already: ${(actions ?? []).map((x) => `${x.title} [${x.status}]`).join("; ") || "nothing"}`,
    "</sprint>",
  ].join("\n");
}

/** A move someone adds in their own words: fleshed out, with questions where the check needs more to follow it. */
export async function addOwnMove(admin: SupabaseClient, sprintId: string, text: string, by: string) {
  const out = await askJson<Move>({
    agent: "auditor",
    label: "sprint add move",
    system: MOVE_SYSTEM,
    schema: MOVE_SCHEMA,
    maxTokens: 6000,
    prompt: `${await sprintContext(admin, sprintId)}\n\n<the_buyer_adds>\n${text.trim().slice(0, 2000)}\n</the_buyer_adds>`,
  });
  const { data, error } = await admin
    .from("sprint_actions")
    .insert({
      sprint_id: sprintId,
      source: "buyer",
      added_by: by,
      title: noDash(out.title),
      steps: out.steps.map(noDash),
      why: noDash(out.why),
      impact: noDash(out.impact),
      watch: noDash(out.watch),
      questions: out.questions.slice(0, 3),
      note: text.trim().slice(0, 1000),
      when: "now",
      owner: "media_buyer",
      sort_order: 500,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Couldn't add it");
  return data.id as string;
}

/** The answers to a move's questions: the move is sharpened with them, and the daily check reads them. */
export async function answerMove(admin: SupabaseClient, actionId: string, answers: string[]) {
  const { data: a } = await admin.from("sprint_actions").select("sprint_id, title, steps, why, impact, watch, questions, answers, note").eq("id", actionId).single();
  if (!a) throw new Error("Move not found");
  const qs = (a.questions ?? []) as string[];
  const qa = [...((a.answers ?? []) as { q: string; a: string }[]), ...qs.map((q, i) => ({ q, a: (answers[i] ?? "").trim() })).filter((x) => x.a)];
  const out = await askJson<Move>({
    agent: "auditor",
    label: "sprint add move",
    system: MOVE_SYSTEM,
    schema: MOVE_SCHEMA,
    maxTokens: 6000,
    prompt: [
      await sprintContext(admin, a.sprint_id),
      "",
      "<the_move>",
      a.title,
      `Steps: ${((a.steps ?? []) as string[]).join(" / ")}`,
      `Why: ${a.why ?? ""} · Watch: ${a.watch ?? ""}`,
      `In the buyer's words: ${a.note ?? ""}`,
      "</the_move>",
      "",
      "<the_buyer_answered>",
      qa.map((x) => `Q: ${x.q}\nA: ${x.a}`).join("\n"),
      "</the_buyer_answered>",
      "",
      "Sharpen the move with these answers. Ask again only if something essential is still missing.",
    ].join("\n"),
  });
  await admin
    .from("sprint_actions")
    .update({ title: noDash(out.title), steps: out.steps.map(noDash), why: noDash(out.why), impact: noDash(out.impact), watch: noDash(out.watch), questions: out.questions.slice(0, 2), answers: qa })
    .eq("id", actionId);
}
