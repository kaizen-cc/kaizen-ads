import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { businessDuration, stageInfo, type Stage } from "@/lib/stages";
import { loadHome, loadKpiPulse } from "@/lib/home";
import { loadWatchList } from "@/lib/fatigue";
import { loadCallPromises, loadOnboarding, loadSuggestions, type OpenSuggestion } from "@/lib/suggestions";

// Everything that's on one person, in one list: what to do now, what to decide, what to keep an eye on, and what's
// coming. Pulled from the tickets, the briefs the AI wrote, the KPI tracker, the fatigue watcher and onboarding, and
// narrowed to that person's own work and their own clients.

export type NextItem = {
  id: string;
  kind: "ticket" | "review" | "launch" | "brief" | "promise" | "first_round" | "refresh" | "kpi" | "fatigue" | "intake" | "client";
  tone: "bad" | "warn" | "brand" | "ok";
  client: string;
  title: string;
  why: string;
  when: string | null; // due, late by, or how long it's waited
  href?: string;
  action: string; // the button
  suggestion?: OpenSuggestion; // briefs open right here
};

export type NextForMe = {
  now: NextItem[];
  decide: NextItem[];
  watch: NextItem[];
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

export async function loadNextForMe(db: SupabaseClient, me: Staff): Promise<NextForMe> {
  const buyerish = me.isBuyer || me.isLead || me.isExec;
  // My clients: the ones I'm assigned to and the ad accounts I own in the KPI tracker
  const [{ data: assigned }, { data: owned }] = await Promise.all([
    db.from("client_assignments").select("client_id").eq("profile_id", me.id),
    db.from("kpi_targets").select("client_id").eq("owner_id", me.id).eq("active", true),
  ]);
  const myClients = new Set([...(assigned ?? []), ...(owned ?? [])].map((r) => r.client_id as string));

  const [h, kpis, fatigue, onboarding, promises, suggestions] = await Promise.all([
    loadHome(db, me),
    buyerish ? loadKpiPulse(db, me.id) : Promise.resolve(null),
    buyerish ? loadWatchList(db, { buyerId: me.id, limit: 30 }) : Promise.resolve([]),
    buyerish ? loadOnboarding(db) : Promise.resolve(null),
    buyerish ? loadCallPromises(db) : Promise.resolve([]),
    me.isLead || me.isExec ? loadSuggestions(db) : Promise.resolve(null),
  ]);

  const now: NextItem[] = [];
  const decide: NextItem[] = [];
  const watch: NextItem[] = [];
  const coming: NextItem[] = [];
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
    for (const r of h.rows.filter((x) => x.buyer_id === me.id && x.assignee_id !== me.id)) {
      if (r.stage === "ready_for_launch")
        now.push({ id: `l-${r.id}`, kind: "launch", tone: "warn", client: r.client_name, title: r.title, why: "Approved and ready to launch", when: `Waiting ${businessDuration(r.minutes_in_stage)}`, href: `/board?t=${r.number}`, action: "Launch it" });
      else if (r.stage === "client_review" && r.minutes_over > 0)
        watch.push({ id: `c-${r.id}`, kind: "client", tone: "warn", client: r.client_name, title: r.title, why: "The client hasn't responded", when: `${businessDuration(r.minutes_in_stage)} in review`, href: `/board?t=${r.number}`, action: "Chase them" });
    }
  }

  // ─── Briefs waiting on a decision (my clients; leads and execs also the strategist's suggestions) ───
  for (const c of onboarding?.clients ?? []) {
    if (!myClients.has(c.clientId) && !me.isLead) continue;
    if (c.firstRound)
      decide.push({ id: `o-${c.clientId}`, kind: "first_round", tone: "brand", client: c.name, title: c.firstRound.draft.title, why: "Their first round is written and waiting for you", when: `Waiting ${ago(c.firstRound.createdAt)}`, action: "Review it", suggestion: c.firstRound });
    else if (!c.intake && c.creative) {
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

  // ─── Watch: my accounts off target and ads wearing out ───
  for (const k of kpis?.off ?? []) watch.push({ id: `k-${k.id}`, kind: "kpi", tone: "bad", client: k.client, title: `${k.label} off target`, why: k.deviation != null ? `${Math.round(Math.abs(k.deviation) * 100)}% off the target` : "Off the target", when: null, href: `/clients/${k.slug}`, action: "Open client" });
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
    coming,
    stats: { onMe: h.mine.length, late: h.mine.filter((r) => r.minutes_over > 0).length, dueToday: h.dueToday, toDecide: decide.length },
  };
}
