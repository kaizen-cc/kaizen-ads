import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { businessDuration, stageInfo, type Stage } from "@/lib/stages";
import { loadHome, loadKpiPulse } from "@/lib/home";
import { loadWatchList } from "@/lib/fatigue";
import { loadCallPromises, loadOnboarding, loadSuggestions, type OpenSuggestion } from "@/lib/suggestions";
import { formatsFor } from "@/lib/creative-formats";
import { isCreativeRole } from "@/lib/roles";
import { seatKeys, type SeatRow } from "@/lib/buyer-seats";
import { loadBiblesToReview } from "@/lib/bible-review";

// Everything that's on one person, in one list: what to do now, what to decide, what to keep an eye on, and what's
// coming. Pulled from the tickets, the briefs the AI wrote, the KPI tracker, the fatigue watcher and onboarding, and
// narrowed to that person's own work and their own clients.

export type NextItem = {
  id: string;
  kind: "ticket" | "review" | "launch" | "brief" | "promise" | "first_round" | "refresh" | "kpi" | "fatigue" | "intake" | "client" | "sprint" | "task" | "bible";
  tone: "bad" | "warn" | "brand" | "ok";
  client: string;
  title: string;
  why: string;
  when: string | null; // due, late by, or how long it's waited
  href?: string;
  action: string; // the button
  suggestion?: OpenSuggestion; // briefs open right here
  /** A short tag beside the title (a Brand Bible: whether it was built from the intake form) */
  chip?: { label: string; tone: "ok" | "quiet" };
  /** A Brand Bible version this person can mark reviewed from the list */
  bible?: { clientId: string; version: string };
};

export type NextForMe = {
  now: NextItem[];
  decide: NextItem[];
  watch: NextItem[];
  /** The creative team: Brand Bibles ready for their review, each tagged with whether it was built from the intake form */
  bibles: NextItem[];
  /** Customer success (the execs when nobody holds the seat): tickets 48 business hours with the client and no decision */
  waiting: NextItem[];
  coming: NextItem[];
  stats: { onMe: number; late: number; dueToday: number; toDecide: number };
};

const ACTION: Partial<Record<Stage, string>> = {
  requested: "Start it",
  in_production: "Keep making",
  internal_review: "Review",
  copy: "Write the copy",
  copy_review: "Review the copy",
  ready_for_client: "Send to the client",
  client_review: "Chase the client",
  client_revision: "Make the changes",
  ready_for_launch: "Launch it",
};

const ago = (iso: string) => {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "1 day" : `${days} days`;
};

/**
 * Who chases a new client's marketing intake form: their account manager (the customer success person on the client),
 * or, when nobody is on it as account manager yet, the customer success team and the client's own buyers. Never the
 * creative team, and not a lead just for being a lead.
 */
export function chasesIntake(me: { id: string; isCoordinator: boolean; role: string }, seats: { profileId: string; role: string }[]) {
  if (isCreativeRole(me.role)) return false;
  const managers = seats.filter((s) => s.role === "coordinator");
  if (managers.length) return managers.some((s) => s.profileId === me.id);
  return me.isCoordinator || seats.some((s) => s.profileId === me.id && (s.role === "meta_buyer" || s.role === "google_buyer"));
}

export async function loadNextForMe(db: SupabaseClient, me: Staff): Promise<NextForMe> {
  // The creative team (the Head of Creative too) has no ad accounts, sprints or onboarding paperwork: their list is
  // their tickets, reviews, first rounds and briefs to decide, and ads wearing out on their clients
  const creative = isCreativeRole(me.role);
  const buyerish = !creative && (me.isBuyer || me.isLead || me.isExec || me.role === "google_buyer");
  // Meta ads wearing out are for the Meta side, not Google's
  const metaSide = me.role !== "google_buyer" && me.role !== "head_of_google";
  // My clients: the ones I'm assigned to and the ad accounts I own in the KPI tracker
  const [{ data: assigned }, { data: owned }] = await Promise.all([
    db.from("client_assignments").select("client_id, profile_id, role, is_primary").eq("profile_id", me.id),
    db.from("kpi_targets").select("client_id").eq("owner_id", me.id).eq("active", true),
  ]);
  const myClients = new Set([...(assigned ?? []), ...(owned ?? [])].map((r) => r.client_id as string));
  // The accounts I'm a secondary buyer on: their launches and sprints are mine to follow too
  const coSeats = seatKeys(((assigned ?? []) as SeatRow[]).filter((a) => a.is_primary === false), me.id);

  const [h, kpis, fatigue, onboarding, promises, suggestions, bibleList, waitingList] = await Promise.all([
    loadHome(db, me),
    buyerish ? loadKpiPulse(db, me.id) : Promise.resolve(null),
    // Ads wearing out: a buyer's own; the creative team's, on the clients they make for (the Head of Creative every client)
    buyerish && metaSide
      ? loadWatchList(db, { buyerId: me.id, limit: 30 })
      : creative
        ? loadWatchList(db, { limit: 30 }).then((ws) => (me.isLead ? ws : ws.filter((w) => myClients.has(w.clientId))))
        : Promise.resolve([]),
    // New clients: first rounds for the buyers and the Head of Creative, intake chasing for account managers (the
    // creative team never sees the intake form itself: they hear when the client's Brand Bible is ready instead)
    buyerish || me.isCoordinator || me.role === "head_of_creative" ? loadOnboarding(db) : Promise.resolve(null),
    buyerish || me.role === "head_of_creative" ? loadCallPromises(db) : Promise.resolve([]),
    me.isLead || me.isExec ? loadSuggestions(db, formatsFor(me)) : Promise.resolve(null),
    creative ? loadBiblesToReview(db, me).catch(() => []) : Promise.resolve([]),
    creative ? Promise.resolve([]) : import("@/lib/approval-notices").then(({ loadWaitingOnClient }) => loadWaitingOnClient(db, me)).catch(() => []),
  ]);

  const now: NextItem[] = [];
  const decide: NextItem[] = [];
  const watch: NextItem[] = [];
  const coming: NextItem[] = [];

  // ─── Brand Bibles ready for my review (the creative team) ───
  const bibles: NextItem[] = bibleList.map((b) => ({
    id: `bb-${b.clientId}-${b.version}`,
    kind: "bible",
    tone: "brand",
    client: b.client,
    title: `Brand Bible ready for your review · v${b.version.replace(/^v/i, "")}`,
    why: b.fromIntake ? "Built from the intake form" : "Built without the intake form: from calls, emails and research",
    when: ago(b.readyAt) === "today" ? "Ready today" : `Ready ${ago(b.readyAt)} ago`,
    href: `/clients/${b.slug}/brand-bible`,
    action: "Read it",
    chip: b.fromIntake ? { label: "From the intake form", tone: "ok" } : { label: "Without the intake form", tone: "quiet" },
    bible: { clientId: b.clientId, version: b.version },
  }));
  // ─── Waiting on the client: 48 business hours with them and no decision, mine to chase ───
  const waiting: NextItem[] = waitingList.map((w) => ({
    id: `wc-${w.requestId}`,
    kind: "client",
    tone: "warn",
    client: w.client,
    title: w.title,
    why: `#${w.number} · no decision after 48 business hours: a call or a nudge`,
    when: `With them since ${new Date(w.since).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })}`,
    href: `/board?t=${w.number}`,
    action: "Chase them",
  }));
  const today = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });
  const dueToday = (iso: string | null) => Boolean(iso && new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York" }) === today);

  // ─── Tickets on me ───
  for (const r of h.mine) {
    const q = h.toQueue(r);
    const item: NextItem = {
      id: `t-${r.id}`,
      kind: "ticket",
      tone: r.minutes_over > 0 ? "bad" : dueToday(r.stage_due_at) ? "warn" : "ok",
      client: r.client_name,
      title: r.title,
      why: `${stageInfo(r.stage)?.label ?? r.stage}${r.stage === "client_revision" ? ` · client round ${r.client_rounds}` : ""}${q.priority ? ` · ${q.priority}` : ""}`,
      when: q.due,
      href: q.href,
      action: ACTION[r.stage] ?? "Open",
    };
    (r.minutes_over > 0 || dueToday(r.stage_due_at) || r.stage === "client_revision" ? now : coming).push(item);
  }

  // ─── Plan tasks on me: what I'm holding up, and what I'm waiting on ───
  const { myTasks } = await import("@/lib/execution-plan");
  for (const t of await myTasks(db, me.id).catch(() => [])) {
    const late = Boolean(t.dueOn && t.dueOn < new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }));
    const due = t.dueOn ? new Date(`${t.dueOn}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" }) : null;
    const href = `/clients/${t.clientSlug}?tab=plan`;
    if (t.status === "blocked") {
      watch.push({ id: `pt-${t.id}`, kind: "task", tone: "ok", client: t.client, title: t.title, why: `Waiting on: ${t.waitingOn.map((w) => `${w.title} (${w.who})`).join(", ")}`, when: due ? `Due ${due}` : null, href, action: "See the plan" });
      continue;
    }
    const holding = t.holdingUp.length > 0;
    const item: NextItem = {
      id: `pt-${t.id}`,
      kind: "task",
      tone: late ? "bad" : holding ? "warn" : "brand",
      client: t.client,
      title: t.title,
      why: holding ? `Holding up: ${t.holdingUp.map((h) => `${h.title} (${h.who})`).join(", ")}` : t.status === "in_progress" ? "In progress" : "Ready for you",
      when: due ? (late ? `Was due ${due}` : `Due ${due}`) : null,
      href,
      action: t.status === "in_progress" ? "Finish it" : "Start it",
    };
    (late || holding || dueToday(t.dueOn ? `${t.dueOn}T12:00:00` : null) ? now : coming).push(item);
  }

  // ─── Leads: what waits on their decision ───
  if (me.isLead) {
    const creative = me.role === "head_of_creative";
    for (const r of h.rows.filter((x) => (creative ? x.stage === "internal_review" : x.stage === "ready_for_launch") && x.assignee_id !== me.id)) {
      now.push({
        id: `r-${r.id}`,
        kind: creative ? "review" : "launch",
        tone: r.minutes_over > 0 ? "bad" : "warn",
        client: r.client_name,
        title: r.title,
        why: creative ? `Waiting for your review${r.assignee_name ? ` · from ${r.assignee_name}` : ""}` : "Approved and ready to launch",
        when: `Waiting ${businessDuration(r.minutes_in_stage)}`,
        href: `/board?t=${r.number}`,
        action: creative ? "Review" : "Launch it",
      });
    }
  }

  // ─── A buyer's own launches and clients who owe a response ───
  if (me.isBuyer) {
    for (const r of h.rows.filter((x) => (x.buyer_id === me.id || (x.buyer_id && coSeats.has(`${x.client_id}:meta`))) && x.assignee_id !== me.id)) {
      if (r.stage === "ready_for_launch")
        now.push({ id: `l-${r.id}`, kind: "launch", tone: "warn", client: r.client_name, title: r.title, why: "Approved and ready to launch", when: `Waiting ${businessDuration(r.minutes_in_stage)}`, href: `/board?t=${r.number}`, action: "Launch it" });
      else if (r.stage === "client_review" && r.minutes_over > 0)
        watch.push({ id: `c-${r.id}`, kind: "client", tone: "warn", client: r.client_name, title: r.title, why: "The client hasn't responded", when: `${businessDuration(r.minutes_in_stage)} in review`, href: `/board?t=${r.number}`, action: "Chase them" });
    }
  }

  // ─── Briefs waiting on a decision (my clients; leads and execs also the strategist's suggestions) ───
  // Who is on each new client, so an intake form still missing goes to the person who chases it
  const fresh = (onboarding?.clients ?? []).filter((c) => !c.firstRound && !c.intake && c.creative).map((c) => c.clientId);
  const { data: seatRows } = fresh.length ? await db.from("client_assignments").select("client_id, profile_id, role").in("client_id", fresh) : { data: [] };
  const seatsOf = (id: string) => (seatRows ?? []).filter((s) => s.client_id === id).map((s) => ({ profileId: s.profile_id as string, role: s.role as string }));
  for (const c of onboarding?.clients ?? []) {
    if (c.firstRound) {
      // A first round is a creative decision: the client's buyer, and the leads (not the account manager)
      if ((!myClients.has(c.clientId) && !me.isLead) || !(buyerish || me.role === "head_of_creative")) continue;
      decide.push({ id: `o-${c.clientId}`, kind: "first_round", tone: "brand", client: c.name, title: c.firstRound.draft.title, why: c.round.length > 1 ? `Their first round is written: ${c.round.length} concepts, one ticket each` : "Their first round is written and waiting for you", when: `Waiting ${ago(c.firstRound.createdAt)}`, action: "Review it", suggestion: c.firstRound });
    } else if (!c.intake && c.creative && chasesIntake(me, seatsOf(c.clientId))) {
      // The account manager's to chase. Never the creative team's: they're told when the Brand Bible is ready instead
      const days = Math.floor((Date.now() - Date.parse(c.since)) / 86_400_000);
      if (days >= 2) watch.push({ id: `i-${c.clientId}`, kind: "intake", tone: days > 4 ? "bad" : "warn", client: c.name, title: "Marketing intake form not in yet", why: "Their first round waits on it (or write it without)", when: `${days} days since enrolling`, href: `/clients/${c.slug}`, action: "Open client" });
    }
  }
  for (const p of promises ?? []) {
    if (!p.suggestion) continue;
    if (!myClients.has(p.suggestion.clientId) && !me.isLead) continue;
    decide.push({ id: `p-${p.commitmentId}`, kind: "promise", tone: "warn", client: p.client, title: p.what, why: `Promised on "${p.callTitle}" and not started`, when: `Due ${new Date(p.dueAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })}`, action: "Open the brief", suggestion: p.suggestion });
  }
  for (const s of suggestions?.open ?? []) {
    if (!myClients.has(s.clientId)) continue;
    decide.push({ id: `s-${s.id}`, kind: "brief", tone: "brand", client: s.client, title: s.draft.title, why: s.signal, when: `Suggested ${ago(s.createdAt)} ago`.replace("today ago", "today"), action: "Open the brief", suggestion: s });
  }

  // ─── Optimization sprints: mine to work, or ones I started or watch ───
  const { loadSprints } = await import("@/lib/sprints");
  // (and the sprints on accounts I'm a secondary buyer on)
  const coClients = [...new Set([...coSeats].map((k) => k.split(":")[0]))];
  const { data: coTargets } = buyerish && coClients.length ? await db.from("kpi_targets").select("id, client_id, platform").in("client_id", coClients).eq("active", true) : { data: [] };
  const coTargetIds = new Set((coTargets ?? []).filter((t) => coSeats.has(`${t.client_id}:${t.platform === "google" ? "google" : "meta"}`)).map((t) => t.id as string));
  const sprints = buyerish
    ? await Promise.all([loadSprints(db, { personId: me.id }), coTargetIds.size ? loadSprints(db, { targetIds: [...coTargetIds] }) : Promise.resolve([])]).then(([a, b]) => [...a, ...b.filter((x) => !a.some((y) => y.sprint.id === x.sprint.id))])
    : [];
  const sprinting = new Set(sprints.map((x) => x.targetId));
  for (const x of sprints) {
    const s = x.sprint;
    const mine = s.buyerId === me.id || coTargetIds.has(x.targetId);
    const urgent = s.verdict === "no_action" || s.verdict === "wrong_move" || s.verdict === "worse";
    const item: NextItem = {
      id: `sp-${s.id}`,
      kind: "sprint",
      tone: s.verdict === "no_action" || s.verdict === "worse" ? "bad" : s.verdict === "wrong_move" ? "warn" : mine ? "brand" : "ok",
      client: x.client,
      title: mine ? `Optimization sprint: ${s.done} of ${s.total} actions done` : `Sprint in motion with ${s.buyer ?? "no buyer"}: ${s.done} of ${s.total} done`,
      why: s.message ?? "The account is being followed every day",
      when: s.lastCheckAt ? `Checked ${ago(s.lastCheckAt)}`.replace("Checked today", "Checked today") : "Started today",
      href: `/kpis/sprint/${s.id}`,
      action: mine ? "Open my actions" : "See progress",
    };
    (mine && (urgent || s.done < s.total) ? now : watch).push(item);
  }

  // ─── Watch: my accounts off target and ads wearing out ───
  for (const k of (kpis?.off ?? []).filter((k) => !sprinting.has(k.id))) watch.push({ id: `k-${k.id}`, kind: "kpi", tone: "bad", client: k.client, title: `${k.label} off target`, why: k.deviation != null ? `${Math.round(Math.abs(k.deviation) * 100)}% off the target` : "Off the target", when: null, href: `/clients/${k.slug}`, action: "Open client" });
  for (const w of fatigue ?? []) {
    if (w.state !== "open") continue;
    const item: NextItem = {
      id: `f-${w.clientId}-${w.adId}`,
      kind: w.briefId ? "refresh" : "fatigue",
      tone: w.severity === "tired" ? "bad" : "warn",
      client: w.client,
      title: w.headline ?? w.adName,
      why: w.severity === "tired" ? "Tired: replace it" : "Wearing out",
      when: `Flagged ${ago(w.firstFlaggedAt)}`.replace("Flagged today", "Flagged today"),
      href: `/clients/${w.clientSlug}`,
      action: w.briefId ? "Refresh brief ready" : "Open client",
    };
    (w.severity === "tired" && w.briefId ? decide : watch).push(item);
  }

  const rank = { bad: 0, warn: 1, brand: 2, ok: 3 } as const;
  const sort = (xs: NextItem[]) => xs.sort((a, b) => rank[a.tone] - rank[b.tone]);
  return {
    now: sort(now),
    decide: sort(decide),
    watch: sort(watch),
    bibles,
    waiting,
    coming,
    stats: { onMe: h.mine.length, late: h.mine.filter((r) => r.minutes_over > 0).length, dueToday: h.dueToday, toDecide: decide.length },
  };
}
