import { redirect } from "next/navigation";
import { Suspense } from "react";
import { TodayHero, TodayHeroSkeleton } from "./views/today-hero";
import { requireStaff, type Staff } from "@/lib/auth";
import { greetingFor, todayLabel } from "@/lib/dates";
import { loadHome, loadKpiPulse, type KpiPulse } from "@/lib/home";
import { loadProduction } from "@/lib/production";
import { roleLabel } from "@/lib/roles";
import { businessDuration, health, stageInfo, type Stage } from "@/lib/stages";
import { createClient } from "@/lib/supabase/server";
import { loadOwedReplies } from "@/lib/owed-replies";
import { HiddenLog } from "./views/hidden-log";
import { loadSaidPromises } from "@/lib/message-promises";
import { loadCallPromises, loadOnboarding, loadSuggestions } from "@/lib/suggestions";
import { loadWatchList } from "@/lib/fatigue";
import { HandoffCallout } from "@/components/handoff-callout";
import { LeaderView } from "./views/leader-view";
import { PulseView } from "./views/pulse-view";
import type { Tone } from "./views/shared";
import { WorkView, type WorkVariant } from "./views/work-view";

const variantFor = (me: Staff): WorkVariant => (me.isCreative ? "creative" : me.isCopywriter ? "copy" : me.isCoordinator ? "cs" : "buyer");
const department = (me: Staff) => (me.role === "head_of_creative" ? "Creative" : me.role === "head_of_google" ? "Google" : "Meta");

// The strategist runs in the background after "Look again", within this page's time
export const maxDuration = 300;

// Each tier gets its own home, from the live tickets.
export default async function Home() {
  const me = await requireStaff();
  // Team members' home is Next for me; execs and leads keep the overview
  if (!me.isExec && !me.isLead) redirect("/next");
  const now = new Date();
  const base = { greeting: greetingFor(now), firstName: me.fullName.split(" ")[0], today: todayLabel(now) };
  const db = await createClient();
  const variantNow = variantFor(me);
  // Ad accounts against target, each service line on its own: execs see Meta and Google, the Head of Meta only Meta,
  // the Head of Google only Google, the Head of Creative neither; a buyer only the accounts they own
  const lines: ("meta" | "google")[] = me.isExec ? ["meta", "google"] : me.role === "head_of_meta" ? ["meta"] : me.role === "head_of_google" ? ["google"] : [];
  const [h, kpiLines, buyerKpis, suggestions, fatigue, onboarding, clientOptions, callPromisesAll, owedItems, said] = await Promise.all([
    loadHome(db, me),
    Promise.all(lines.map((platform) => loadKpiPulse(db, { platform }))),
    !me.isLead && !me.isExec && variantNow === "buyer" ? loadKpiPulse(db, me.id) : Promise.resolve(null),
    // Briefs the strategist suggests: execs and leads decide them
    me.isExec || me.isLead ? loadSuggestions(db) : Promise.resolve(null),
    // Ads wearing out: every client for execs and leads, a buyer's own clients for a buyer
    // (Meta ads only, so not for the Head of Google)
    me.role === "head_of_google" ? Promise.resolve(null) : me.isExec || me.isLead ? loadWatchList(db, { limit: 8 }) : variantFor(me) === "buyer" ? loadWatchList(db, { buyerId: me.id, limit: 12 }) : Promise.resolve(null),
    // New and returning clients, first thing on the page for execs and leads
    // Execs and leads: every client. A buyer: their own clients (the access rules narrow it)
    me.isExec || me.isLead || variantFor(me) === "buyer" ? loadOnboarding(db) : Promise.resolve(null),
    me.isExec || me.isLead ? db.from("clients").select("id, name").is("archived_at", null).order("name").then(({ data }) => data ?? []) : Promise.resolve([]),
    // What we promised on calls and haven't started: everyone's for execs and leads, a buyer's own clients for a buyer
    me.isExec || me.isLead || variantFor(me) === "buyer" ? loadCallPromises(db) : Promise.resolve(null),
    // Messages nobody answered: their own, and the ones escalated past a second notice on the people they lead
    loadOwedReplies(db, me).catch(() => []),
    // And what someone said yes to in Slack or email that's past due with nothing moving
    loadSaidPromises(db, me).catch(() => []),
  ]);
  // What this person cleared off their own board (Done or Dismiss): gone for them, still there for everyone else
  const { data: hiddenRows } = await db.from("hidden_items").select("key, how, label, href, hidden_at").eq("profile_id", me.id).order("hidden_at", { ascending: false }).limit(200);
  const hidden = new Set((hiddenRows ?? []).map((r) => r.key as string));
  h.attention = h.attention.filter((a) => !hidden.has(`alert:${a.id}`));
  const callPromises = callPromisesAll?.filter((p) => !hidden.has(`call:${p.commitmentId}`)) ?? null;
  const owed = { items: owedItems.filter((o) => o.targetId === me.id || !hidden.has(`owed:${o.id}`)), said: said.filter((p) => p.ownerId === me.id || !hidden.has(`said:${p.id}`)), me: me.id };

  const kpis = kpiLines.filter((k): k is KpiPulse => Boolean(k));
  // How creative production is going (speed, revisions, the team): execs and the Head of Creative
  const production = me.isExec || me.role === "head_of_creative" ? await loadProduction(db).catch(() => null) : null;

  // The daily recap's way in, streamed in after the rest of the page, and under it what this person cleared off their
  // board (kept, so anything can be put back)
  const recap = (
    <>
      <Suspense fallback={<TodayHeroSkeleton />}>
        <TodayHero db={db} me={me} />
      </Suspense>
      <HiddenLog items={(hiddenRows ?? []).map((r) => ({ key: r.key as string, how: r.how as "done" | "dismissed", label: r.label as string | null, href: r.href as string | null, at: r.hidden_at as string }))} />
    </>
  );

  if (me.isExec) {
    return <PulseView {...base} vitals={h.vitals} attention={h.attention} phases={h.phases} clients={h.clients} team={h.team} monthElapsed={h.monthElapsed} kpis={kpis} production={production} suggestions={suggestions} fatigue={fatigue} onboarding={onboarding} clientOptions={clientOptions} callPromises={callPromises} owed={owed} handoffs={<HandoffCallout db={db} me={me.id} />} recap={recap} />;
  }

  if (me.isLead) {
    const dept = department(me);
    const creative = dept === "Creative";
    // The Head of Creative decides creative review; the heads of Meta and Google, launches
    const waiting = h.rows.filter((r) => (creative ? r.stage === "internal_review" : r.stage === "ready_for_launch")).sort((a, b) => b.minutes_over - a.minutes_over);
    const mine = new Set<Stage>(creative ? ["requested", "in_production", "client_revision", "internal_review"] : ["client_review", "ready_for_launch"]);
    const team = h.teamOf(creative ? ["graphic_designer", "video_editor"] : ["media_buyer"]);
    return (
      <LeaderView
        {...base}
        department={dept}
        reviewLabel={creative ? "Waiting for your review" : "Ready to launch"}
        stats={{
          waitingOnYou: waiting.length,
          teamActive: team.reduce((n, l) => n + l.active, 0),
          teamOverdue: team.reduce((n, l) => n + l.overdue, 0),
          onTimeRate: h.vitals.onTimeRate,
        }}
        review={waiting.map((r) => h.toQueue(r))}
        attention={h.attention.filter((a) => a.kind === "Allotment" || h.rows.some((r) => a.href === `/board?t=${r.number}` && mine.has(r.stage)))}
        team={team}
        phases={h.phases}
        canRequest
        kpis={kpis}
        production={production}
        suggestions={suggestions}
        fatigue={fatigue}
        onboarding={onboarding}
        clientOptions={clientOptions}
        callPromises={callPromises}
        owed={owed}
        handoffs={<HandoffCallout db={db} me={me.id} />}
        recap={recap}
      />
    );
  }

  const variant = variantFor(me);
  const sideRow = (r: (typeof h.rows)[number]) => ({
    label: `${r.client_name} · ${r.title}`,
    detail: stageInfo(r.stage)?.label ?? r.stage,
    value: businessDuration(r.minutes_in_stage),
    tone: health(r.minutes_over, r.stage) as Tone,
  });
  const titleOf = (id: string) => h.rows.find((r) => r.id === id);

  const fourth =
    variant === "buyer"
      ? h.rows.filter((r) => r.stage === "ready_for_launch" && r.buyer_id === me.id).length
      : variant === "creative"
        ? h.mine.filter((r) => r.stage === "client_revision" || (r.stage === "in_production" && r.internal_rounds > 0)).length
        : variant === "copy"
          ? h.copyDone.filter((c) => c.approved_by === me.id).length
          : h.rows.filter((r) => r.stage === "client_review").length;

  const side =
    variant === "buyer"
      ? { title: "Waiting on your clients", items: h.rows.filter((r) => r.stage === "client_review" && r.buyer_id === me.id).map(sideRow), empty: "Approvals your clients owe show here." }
      : variant === "creative"
        ? { title: "Coming up", items: h.rows.filter((r) => r.stage === "requested" && r.creative_id === me.id).map(sideRow), empty: "Briefs assigned to you appear here before they're due." }
        : variant === "copy"
          ? {
              title: "Recently passed on",
              items: h.copyDone
                .filter((c) => c.approved_by === me.id)
                .map((c) => {
                  const r = titleOf(c.request_id);
                  return { label: r ? `${r.client_name} · ${r.title}` : "A ticket", detail: r ? (stageInfo(r.stage)?.label ?? r.stage) : "Approved", value: new Date(c.approved_at).toLocaleDateString("en-US", { weekday: "short", timeZone: "America/New_York" }), tone: "ok" as Tone };
                }),
              empty: "Copy you've approved this week.",
            }
          : { title: "Waiting on clients", items: h.rows.filter((r) => r.stage === "client_review").sort((a, b) => b.minutes_in_stage - a.minutes_in_stage).map(sideRow), empty: "Approvals in progress, with their business-hours clock." };

  // For designers and editors: what they sent to review this week, and how much passed first time
  let delivered: { week: number; firstPass: number | null } | undefined;
  if (variant === "creative") {
    const week = h.evs.filter((e) => e.actor_id === me.id && e.to_stage === "internal_review" && e.created_at >= h.since7).length;
    const myTickets = new Set(h.rows.filter((r) => r.creative_id === me.id).map((r) => r.id));
    const decisions = h.evs.filter((e) => e.kind === "review" && myTickets.has(e.request_id) && (e.data?.decision === "approve" || e.data?.decision === "changes"));
    delivered = { week, firstPass: decisions.length ? Math.round((decisions.filter((e) => e.data?.decision === "approve").length / decisions.length) * 100) : null };
  }

  return (
    <WorkView
      {...base}
      variant={variant}
      role={roleLabel(me.role)}
      stats={{ mine: h.mine.length, dueToday: h.dueToday, overdue: h.mine.filter((r) => r.minutes_over > 0).length, fourth }}
      queue={h.mine.map((r) => h.toQueue(r))}
      side={side}
      delivered={delivered}
      canAct={variant === "buyer"}
      kpis={buyerKpis}
      fatigue={fatigue}
      onboarding={onboarding}
      callPromises={callPromises}
    />
  );
}
