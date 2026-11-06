import { Suspense } from "react";
import { TodayHero, TodayHeroSkeleton } from "./views/today-hero";
import { requireStaff, type Staff } from "@/lib/auth";
import { greetingFor, todayLabel } from "@/lib/dates";
import { loadHome, loadKpiPulse, type KpiPulse } from "@/lib/home";
import { loadProduction } from "@/lib/production";
import { roleLabel } from "@/lib/roles";
import { servicesOf } from "@/lib/services";
import { type Stage } from "@/lib/stages";
import { createClient } from "@/lib/supabase/server";
import { loadOwedReplies } from "@/lib/owed-replies";
import { HiddenLog } from "./views/hidden-log";
import { loadSaidPromises } from "@/lib/message-promises";
import { loadCallPromises, loadOnboarding, loadSuggestions } from "@/lib/suggestions";
import { formatsFor } from "@/lib/creative-formats";
import { loadWatchList } from "@/lib/fatigue";
import { HandoffCallout } from "@/components/handoff-callout";
import { LeaderView } from "./views/leader-view";
import { PulseView } from "./views/pulse-view";
import { PageHeader } from "./views/shared";
import { NextSection } from "./views/next-section";
import { loadNextForMe } from "@/lib/next-for-me";
import type { SupabaseClient } from "@supabase/supabase-js";
import { topicsFor } from "@/lib/today";
import { todaySnapshot } from "@/lib/today-snapshot";

const department = (me: Staff) => (me.role === "head_of_creative" ? "Creative" : me.role === "head_of_google" ? "Google" : "Meta");

// The strategist runs in the background after "Look again" (and a brief from Next for me is written), within this
// page's time
export const maxDuration = 300;

type HiddenRow = { key: string; how: string; label: string | null; href: string | null; hidden_at: string };

/** The daily recap's way in, streamed in after the rest of the page, and under it what this person cleared off their board (kept, so anything can be put back) */
function Recap({ db, me, hidden }: { db: SupabaseClient; me: Staff; hidden: HiddenRow[] }) {
  return (
    <>
      <Suspense fallback={<TodayHeroSkeleton />}>
        <TodayHero db={db} me={me} />
      </Suspense>
      <HiddenLog items={hidden.map((r) => ({ key: r.key, how: r.how as "done" | "dismissed", label: r.label, href: r.href, at: r.hidden_at }))} />
    </>
  );
}

/** The Google team: ideas taken to their clients from Ideas › Google, waiting on a decision or to be applied */
async function googleDeploys(db: SupabaseClient, me: Staff, clientIds: string[]) {
  if (!(me.role === "google_buyer" || me.role === "head_of_google") || !clientIds.length) return [];
  const { loadDeploys } = await import("@/lib/google-deploy");
  return (await loadDeploys(db, clientIds, { open: true }).catch(() => [])).filter((d) => d.status === "open" || d.status === "approved");
}

/**
 * Everyone's home: the daily recap first, then (execs and leads) the few themes of the agency, and under it all Next
 * for me, everything on the person signed in. Team members get their recap and their Next for me.
 */
export default async function Home() {
  const [me, db] = await Promise.all([requireStaff(), createClient()]);
  const now = new Date();
  const base = { greeting: greetingFor(now), firstName: me.fullName.split(" ")[0], today: todayLabel(now) };
  const hiddenQuery = () => db.from("hidden_items").select("key, how, label, href, hidden_at").eq("profile_id", me.id).order("hidden_at", { ascending: false }).limit(200);
  const assignedQuery = () => db.from("client_assignments").select("client_id").eq("profile_id", me.id);

  // Team members (designers, editors, buyers, the copywriter, customer success): their recap and their Next for me.
  // What the themes hold for execs and leads (promises, messages, ads wearing out, new clients) reaches them in the
  // recap and in Next for me already, so there's nothing else to tab through.
  if (!me.isExec && !me.isLead) {
    const [next, { data: mine }, { data: hiddenRows }] = await Promise.all([loadNextForMe(db, me), assignedQuery(), hiddenQuery()]);
    const ids = [...new Set((mine ?? []).map((m) => m.client_id as string))];
    // What works across businesses like the ones they work on: the same patterns the audits and refresh briefs build on
    const [patterns, deploys] = await Promise.all([ids.length ? import("@/lib/patterns").then(({ loadPatterns }) => loadPatterns(db, ids)).catch(() => null) : Promise.resolve(null), googleDeploys(db, me, ids)]);
    const n = next.now.length + next.decide.length;
    return (
      <div className="mx-auto grid max-w-6xl gap-8">
        <PageHeader today={base.today} title={`${base.greeting}, ${base.firstName}`} subtitle={`${roleLabel(me.role)} · ${n ? `${n} ${n === 1 ? "thing needs" : "things need"} you` : "nothing needs you right now"}`} />
        <Recap db={db} me={me} hidden={(hiddenRows ?? []) as HiddenRow[]} />
        <HandoffCallout db={db} me={me.id} />
        <NextSection data={next} me={me.id} deploys={deploys} patterns={patterns} />
      </div>
    );
  }

  // Ad accounts against target, each service line on its own: execs see Meta and Google, the Head of Meta only Meta,
  // the Head of Google only Google, the Head of Creative neither
  const lines: ("meta" | "google")[] = me.isExec ? ["meta", "google"] : me.role === "head_of_meta" ? ["meta"] : me.role === "head_of_google" ? ["google"] : [];
  const [h, kpiLines, suggestions, fatigue, onboarding, clientOptions, callPromisesAll, owedItems, said, { data: hiddenRows }, patternState, production, next, { data: assigned }, snap] = await Promise.all([
    loadHome(db, me),
    Promise.all(lines.map((platform) => loadKpiPulse(db, { platform }))),
    // Briefs the strategist suggests (Meta creative): execs and the leads on it decide them, not the Head of Google
    me.role !== "head_of_google" ? loadSuggestions(db, formatsFor(me)) : Promise.resolve(null),
    // Ads wearing out: every client (Meta ads only, so not for the Head of Google)
    me.role === "head_of_google" ? Promise.resolve(null) : loadWatchList(db, { limit: 8 }),
    // New and returning clients: every client
    loadOnboarding(db),
    db.from("clients").select("id, name").is("archived_at", null).order("name").then(({ data }) => data ?? []),
    // What we promised on calls and haven't started: everyone's
    loadCallPromises(db),
    // Messages nobody answered: their own, and the ones escalated past a second notice on the people they lead
    loadOwedReplies(db, me).catch(() => []),
    // And what someone said yes to in Slack or email that's past due with nothing moving
    loadSaidPromises(db, me).catch(() => []),
    // What this person cleared off their own board (Done or Dismiss): gone for them, still there for everyone else
    hiddenQuery(),
    // What works across every client of a kind (execs and leads), and who isn't using it yet
    import("@/lib/patterns").then(({ loadPatterns }) => loadPatterns(db)).catch(() => null),
    // How creative production is going (speed, revisions, the team): execs and the Head of Creative
    me.isExec || me.role === "head_of_creative" ? loadProduction(db).catch(() => null) : Promise.resolve(null),
    // Next for me: everything on this person, under the themes
    loadNextForMe(db, me),
    assignedQuery(),
    // Today's recap, the same one the "Your day" card reads (built once per request): the themes count as it does
    todaySnapshot(db, me).catch(() => null),
  ]);
  // The recap's counts (clients, per topic) and which topics it covers for this person, for the theme cards
  const looks = snap ? { byTopic: snap.today.looks.byTopic, covered: [...topicsFor(me)] } : null;
  const hidden = new Set((hiddenRows ?? []).map((r) => r.key as string));
  h.attention = h.attention.filter((a) => !hidden.has(`alert:${a.id}`));
  // The Head of Creative: only the call promises with a brief to make; the rest are the buyers' and account managers'
  const creativeLead = me.role === "head_of_creative";
  const callPromises = callPromisesAll?.filter((p) => !hidden.has(`call:${p.commitmentId}`) && (!creativeLead || p.suggestion)) ?? null;
  // ...and only the new clients on a creative package, without the unmatched intake forms (the account manager's)
  if (onboarding && creativeLead) {
    onboarding.clients = onboarding.clients.filter((c) => c.creative || c.firstRound);
    onboarding.unmatched = [];
    // The intake form is the account manager's: the creative team hears when the Brand Bible is ready instead
    onboarding.creativeView = true;
  }
  const owed = { items: owedItems.filter((o) => o.targetId === me.id || !hidden.has(`owed:${o.id}`)), said: said.filter((p) => p.ownerId === me.id || !hidden.has(`said:${p.id}`)), me: me.id };
  // What they marked done or "not for me" in their recap leaves these lists for them too (a brief idea, an ad wearing
  // out): the item is still open for everyone else, so it's their mark, read the same way here (src/lib/item-state.ts)
  const { data: closedRows } = await db.from("daily_items").select("key").eq("profile_id", me.id).in("status", ["done", "dismissed"]);
  const closed = new Set((closedRows ?? []).map((r) => r.key as string));
  const suggestionsShown = suggestions ? { ...suggestions, open: suggestions.open.filter((sg) => !closed.has(`brief:${sg.id}`)) } : suggestions;
  const fatigueShown = fatigue ? fatigue.filter((r) => !closed.has(`fatigue:${r.clientId}:${r.adId}`)) : fatigue;

  const kpis = kpiLines.filter((k): k is KpiPulse => Boolean(k));
  // The heads of Meta and Google see the clients on their line being onboarded, not every new client
  if (onboarding && lines.length === 1) {
    const ids = onboarding.clients.map((c) => c.clientId);
    const [{ data: cs }, { data: ks }] = ids.length
      ? await Promise.all([db.from("clients").select("id, services, services_extra, services_removed, meta_ad_account_id").in("id", ids), db.from("kpi_targets").select("client_id").eq("platform", lines[0]).in("client_id", ids)])
      : [{ data: [] }, { data: [] }];
    const slug = lines[0] === "google" ? "google-ads" : "facebook-ads";
    const on = new Set([
      ...(ks ?? []).map((k) => k.client_id as string),
      ...(cs ?? []).filter((c) => servicesOf(c).includes(slug) || (lines[0] === "meta" && c.meta_ad_account_id && !(c.services_removed ?? []).includes(slug))).map((c) => c.id as string),
    ]);
    onboarding.clients = onboarding.clients.filter((c) => on.has(c.clientId));
  }
  const patterns = patternState ? { state: patternState, canBrief: true, canRefresh: me.isExec } : null;

  const recap = <Recap db={db} me={me} hidden={(hiddenRows ?? []) as HiddenRow[]} />;
  // Next for me, under the themes. The patterns for their clients are already in the themes (every client's)
  const deploys = await googleDeploys(db, me, [...new Set((assigned ?? []).map((m) => m.client_id as string))]);
  const nextSection = <NextSection data={next} me={me.id} deploys={deploys} />;

  if (me.isExec) {
    return <PulseView {...base} vitals={h.vitals} attention={h.attention} phases={h.phases} clients={h.clients} team={h.team} monthElapsed={h.monthElapsed} kpis={kpis} production={production} suggestions={suggestionsShown} fatigue={fatigueShown} onboarding={onboarding} clientOptions={clientOptions} callPromises={callPromises} owed={owed} patterns={patterns} looks={looks} handoffs={<HandoffCallout db={db} me={me.id} />} recap={recap} next={nextSection} />;
  }

  // Leaders (Head of Creative / Meta / Google)
  const dept = department(me);
  const creative = dept === "Creative";
  // The Head of Creative decides creative review; the heads of Meta and Google, launches
  const google = dept === "Google";
  // Ads launched from here are Meta ads: the Head of Google has none waiting on them
  const waiting = google ? [] : h.rows.filter((r) => (creative ? r.stage === "internal_review" : r.stage === "ready_for_launch")).sort((a, b) => b.minutes_over - a.minutes_over);
  const mine = new Set<Stage>(creative ? ["requested", "in_production", "client_revision", "internal_review"] : ["client_review", "ready_for_launch"]);
  const team = h.teamOf(creative ? ["graphic_designer", "video_editor"] : google ? ["google_buyer"] : ["media_buyer"]);
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
      attention={h.attention.filter((a) => a.kind === "Allotment" || h.rows.some((r) => a.href === `/board?t=${r.number}` && mine.has(r.stage)))}
      team={team}
      phases={h.phases}
      canRequest
      kpis={kpis}
      production={production}
      suggestions={suggestionsShown}
      fatigue={fatigueShown}
      onboarding={onboarding}
      clientOptions={clientOptions}
      callPromises={callPromises}
      owed={owed}
      patterns={patterns}
      looks={looks}
      handoffs={<HandoffCallout db={db} me={me.id} />}
      recap={recap}
      next={nextSection}
    />
  );
}
