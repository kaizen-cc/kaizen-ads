import { Suspense } from "react";
import { AutoClosed } from "@/components/auto-closed";
import { TodayHero, TodayHeroSkeleton } from "./views/today-hero";
import { requireStaff, type Staff } from "@/lib/auth";
import { greetingFor, todayLabel } from "@/lib/dates";
import { loadHome } from "@/lib/home";
import { lineOfTeam, roleLabel } from "@/lib/roles";
import { channelTabs } from "./views/channel-home";
import { createClient } from "@/lib/supabase/server";
import { HandoffCallout } from "@/components/handoff-callout";
import { ReviewsCallout } from "@/components/reviews-callout";
import { SupportDashboard } from "@/components/support-dashboard";
import { StepinsSection } from "@/components/stepins/section";
import { PageHeader } from "./views/shared";
import { adsDesk, creativeDesk } from "./views/ads-desk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { todaySnapshot } from "@/lib/today-snapshot";
import type { TopicKey } from "@/lib/today";
import { MyDesk } from "./views/my-desk";
import { RoleOverview } from "./views/role-overview";
import { UnfinishedCallout } from "./views/unfinished-callout";
import { isCustomerSuccess, isMaker } from "@/lib/maker-day-core";
import { ReadyCallout } from "./views/ready-callout";
import { NudgeCallout } from "@/components/nudge-callout";
import { isCreativeLead } from "@/lib/lead-creative-core";


// The strategist runs in the background after "Look again" (and a brief from Next for me is written), within this
// page's time
export const maxDuration = 300;

type HiddenRow = { key: string; how: string; label: string | null; href: string | null; hidden_at: string };

/** An exec's Overview: the recap's cards in their tabs, opening on the most critical */
async function ExecOverview({ db, me, base }: { db: SupabaseClient; me: Staff; base: { greeting: string; firstName: string; today: string } }) {
  const [{ ExecBlocks }, core, snap] = await Promise.all([import("./views/exec-home"), import("@/lib/exec-overview-core"), todaySnapshot(db, me)]);
  const tabs = Object.fromEntries(core.EXEC_TABS.map((t) => [t, [] as import("@/lib/exec-overview-core").ExecCard[]])) as Record<import("@/lib/exec-overview-core").ExecTab, import("@/lib/exec-overview-core").ExecCard[]>;
  for (const i of snap.today.items) if (i.exec && i.exec.tab in tabs) tabs[i.exec.tab].push(i.exec);
  tabs.needs = core.sortNeeds(tabs.needs);
  for (const t of ["escalated", "accounts", "system"] as const) tabs[t] = core.sortCards(tabs[t]);
  const owner = Boolean(me.canViewAs);
  if (!owner) tabs.system = [];
  const fires = tabs.escalated.filter((c) => c.severity === "fire").length;
  const header = core.headerParts({ needs: tabs.needs.length, fires, stuck: tabs.escalated.length - fires, accounts: tabs.accounts.length });
  const line = header.map((h) => h.text).join(" · ") || "All clear: nothing needs you, nothing is stuck, every account is handled";
  // The Wrapped hero (its counts are only the exec's own items), then the designed blocks, each opening in place
  return (
    <div className="mx-auto grid max-w-6xl gap-6 md:gap-8">
      <PageHeader today={base.today} title={`${base.greeting}, ${base.firstName}`} subtitle={line} />
      <Suspense fallback={<TodayHeroSkeleton />}>
        <TodayHero db={db} me={me} />
      </Suspense>
      {/* This week's step-ins: the accounts where an exec steps in (src/lib/stepins) */}
      <Suspense fallback={null}>
        <StepinsSection db={db} me={me} />
      </Suspense>
      <ExecBlocks tabs={tabs} owner={owner} />
    </div>
  );
}


/** A team member's line desk: a Meta or Google buyer's ad accounts, the creative team's clients; none for the rest */
async function memberDesk(db: SupabaseClient, me: Staff) {
  try {
    const { worksAs } = await import("@/lib/roles");
    if (worksAs(me.role, "media_buyer")) return await adsDesk(db, me, "meta");
    if (worksAs(me.role, "google_buyer")) return await adsDesk(db, me, "google");
    if (worksAs(me.role, "graphic_designer", "video_editor", "copywriter")) {
      const h = await loadHome(db, me);
      return await creativeDesk(db, me, h.allClients, h.monthElapsed);
    }
  } catch (e) {
    console.error("[overview] member desk:", e instanceof Error ? e.message : e);
  }
  return null;
}

/**
 * Everyone's home (owner, Nov 23 2026): the same design for every role, the Wrapped hero and designed blocks that open
 * in place. Execs: Needs me, Escalated, Accounts, Asana, Pulse (the owner also System). Everyone else: their own
 * blocks by role (src/app/(team)/pipeline/views/role-overview.tsx), then the panels their role already had (Clients,
 * Ideas, Audits and sprints, Setup, Tracking, their board) as blocks too.
 */
export default async function Home({ searchParams }: PageProps<"/pipeline">) {
  const [me, db, sp] = await Promise.all([requireStaff(), createClient(), searchParams]);
  const now = new Date();
  const base = { greeting: greetingFor(now), firstName: me.fullName.split(" ")[0], today: todayLabel(now) };
  if (me.isExec) return <ExecOverview db={db} me={me} base={base} />;

  const { isLadderLead } = await import("@/lib/escalation-ladder-core");
  const lead = isLadderLead(me.role) || me.isLead;
  const kind = lead ? "lead" : isCustomerSuccess(me.role) ? "support" : isMaker(me.role) ? "maker" : "member";
  const { data: hiddenRows } = await db.from("hidden_items").select("key, how, label, href, hidden_at").eq("profile_id", me.id).order("hidden_at", { ascending: false }).limit(200);
  // What every Overview keeps under the hero: a nudge being opened (a lead, from a notice: ?nudge=), a brief they
  // started and didn't send, emails drafted for them to send, work handed to them
  // Nothing sits outside the blocks (owner, Nov 23 2026): every part of the old Overview folds into the block it
  // belongs to. Emails drafted for them and their account-review to-dos are items in Needs me (src/lib/today.ts
  // withDesk); a nudge being opened (?nudge=) sits in My team; work handed to them and a brief they started in My work
  // (or Needs me); briefs drafted for their approval in Ideas (a lead's in My accounts); the account review's watch
  // strip in My accounts; what closed itself in Needs me.
  const { SETS } = await import("./views/role-overview");
  const has = (t: TopicKey) => SETS[kind].includes(t);
  const into: Partial<Record<TopicKey, React.ReactNode[]>> = {};
  const put = (t: TopicKey, node: React.ReactNode) => (into[t] ??= []).push(node);
  const work: TopicKey = has("work") ? "work" : "needs";
  const ideas: TopicKey = has("briefs") ? "briefs" : has("accounts") ? "accounts" : work;
  const accountsBlock: TopicKey = has("accounts") ? "accounts" : "needs";
  if (lead && sp?.nudge)
    put(
      "team",
      <Suspense key="nudge" fallback={null}>
        <NudgeCallout me={me.id} />
      </Suspense>,
    );
  put(
    work,
    <Suspense key="handoff" fallback={null}>
      <HandoffCallout db={db} me={me.id} />
    </Suspense>,
  );
  put(
    ideas,
    <Suspense key="unfinished" fallback={null}>
      <UnfinishedCallout db={db} me={me} />
    </Suspense>,
  );
  put(
    accountsBlock,
    <Suspense key="reviews" fallback={null}>
      <ReviewsCallout db={db} me={me} />
    </Suspense>,
  );
  put(
    "needs",
    <Suspense key="closed" fallback={null}>
      <AutoClosed db={db} me={me} />
    </Suspense>,
  );
  // Clients, audits and setup in My accounts; ideas in Ideas (a lead's in My accounts)
  let ownList = false;
  const fold = (tabs: { id: string }[], panels: Record<string, React.ReactNode>) => {
    for (const t of tabs) {
      const node = panels[t.id];
      const block: TopicKey | null = ["clients", "accounts", "audits", "setup"].includes(t.id) ? accountsBlock : t.id === "ideas" ? ideas : null;
      if (node == null || !block) continue;
      if (block === "accounts" && (t.id === "clients" || t.id === "accounts")) ownList = true;
      put(block, <div key={t.id}>{node}</div>);
    }
  };
  const view = (o: { own?: { id: string; label: string; blurb: string; node: React.ReactNode; count?: number }[] } = {}) => (
    <>
      {/* Once a day the person's clients are read again for emails to draft (shown as items in Needs me) */}
      <Suspense fallback={null}>
        <MyDesk db={db} me={me} />
      </Suspense>
      <RoleOverview
        db={db}
        me={me}
        kind={kind}
        base={base}
        subtitle={roleLabel(me.role)}
        folded={Object.fromEntries(Object.entries(into).map(([k, v]) => [k, <div key={k} className="grid gap-6">{v}</div>])) as Partial<Record<TopicKey, React.ReactNode>>}
        ownList={ownList}
        own={o.own}
        hidden={(hiddenRows ?? []) as HiddenRow[]}
      />
    </>
  );

  // The support positions: their board as a block of its own (the Tracking Specialist's: Tracking)
  if (kind === "support" || (isCustomerSuccess(me.role) && !lead)) {
    if (me.role === "tracking_specialist") {
      const [{ trackingHealth }, { createAdminClient }, { TrackingHealth }] = await Promise.all([import("@/lib/tracking-health"), import("@/lib/supabase/admin"), import("./views/tracking-health")]);
      const health = await trackingHealth(createAdminClient()).catch(() => []);
      const need = health.filter((r) => r.health.tier === "critical" || r.health.tier === "high").length;
      return view({ own: [{ id: "tracking", label: "Tracking", blurb: "Every paid-ads client's tracking health", node: <TrackingHealth rows={health} />, count: need }] });
    }
    return view({ own: [{ id: "desk", label: "Your board", blurb: "Reports, channels and onboardings waiting on you", node: <SupportDashboard role={me.role} /> }] });
  }

  // The email and organic social teams: their line's clients, ideas, audits and setup, folded into their blocks
  const channel = lineOfTeam(me.role);
  if (channel) {
    const { tabs, panels } = await channelTabs({ me, line: channel, today: base.today, greeting: base.greeting, firstName: base.firstName });
    fold(tabs, panels);
    return view();
  }

  // The makers: their blocks, nothing else
  if (kind === "maker") return view();

  // Buyers, the copywriter, the leads and the heads: their line's desk folded into their blocks. A creative lead's
  // Overview has no account watch and no production roster: what's stuck is one item each in My team
  const creativeLead = isCreativeLead(me.role) || String(me.role) === "head_of_creative";
  const desk = me.isLead && (me.role === "head_of_creative" || me.role === "head_of_meta" || me.role === "head_of_google") ? await leadDesk(db, me) : await memberDesk(db, me);
  fold(desk?.tabs ?? [], desk?.panels ?? {});
  put(
    ideas,
    <Suspense key="ready" fallback={null}>
      <ReadyCallout db={db} me={me} />
    </Suspense>,
  );
  if (!creativeLead && desk?.today) put(accountsBlock, <div key="watch">{desk.today}</div>);
  return view();
}

/** The heads of Meta, Google and Creative: their line's desk (ad accounts, or the creative clients' allotments) */
async function leadDesk(db: SupabaseClient, me: Staff) {
  const google = me.role === "head_of_google";
  try {
    if (me.role === "head_of_creative") {
      const h = await loadHome(db, me);
      return await creativeDesk(db, me, h.allClients, h.monthElapsed);
    }
    return await adsDesk(db, me, google ? "google" : "meta");
  } catch (e) {
    console.error("[overview] desk:", e instanceof Error ? e.message : e);
    return null;
  }
}
