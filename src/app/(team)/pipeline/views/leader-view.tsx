import { KpiPulse, type KpiPulseData, AttentionList, FlowStrip, PageHeader, PrimaryAction, Queue, SectionTitle, Stats, TeamLoad, type Alert, type Load, type PhaseKey, type PhaseStat, type QueueItem } from "./shared";
import type { WatchRow } from "@/lib/fatigue";
import { FatigueWatch } from "@/components/fatigue-watch";
import type { CallPromise, OnboardingState } from "@/lib/suggestions";
import { CallPromises } from "./call-promises";
import { OnboardingCallout } from "./onboarding-callout";
import type { SuggestionsState } from "@/lib/suggestions";
import { SuggestedBriefs } from "./suggested-briefs";

export type LeaderData = {
  greeting: string;
  firstName: string;
  today: string;
  department: string; // "Creative", "Meta", "Google"
  reviewLabel: string; // "Waiting for your review" / "Ready for launch"
  stats: { waitingOnYou: number; teamActive: number; teamOverdue: number; onTimeRate: number | null };
  review: QueueItem[];
  attention: Alert[];
  team: Load[];
  phases: Record<PhaseKey, PhaseStat>;
  canRequest: boolean;
  kpis?: KpiPulseData | null;
  fatigue?: WatchRow[] | null;
  onboarding?: OnboardingState | null;
  callPromises?: CallPromise[] | null;
  clientOptions?: { id: string; name: string }[];
  suggestions?: SuggestionsState | null;
};

/** Leaders (Head of Creative / Meta / Google): their decisions first, then their team and its problems. */
export function LeaderView(d: LeaderData & { handoffs?: React.ReactNode }) {
  return (
    <div className="mx-auto grid max-w-6xl gap-10">
      <PageHeader
        today={d.today}
        title={`${d.greeting}, ${d.firstName}`}
        subtitle={`Head of ${d.department} · ${d.stats.waitingOnYou ? `${d.stats.waitingOnYou} waiting on you` : "nothing waiting on you"}`}
        action={<PrimaryAction label="New request" disabled={!d.canRequest} href="/requests/new" />}
      />
      {d.handoffs}

      {d.onboarding && <OnboardingCallout state={d.onboarding} clients={d.clientOptions ?? []} />}

      {d.callPromises && <CallPromises promises={d.callPromises} />}

      <Stats
        items={[
          { label: "Waiting on you", value: d.stats.waitingOnYou, hint: d.reviewLabel, tone: "brand" },
          { label: `${d.department} team`, value: d.stats.teamActive, hint: "Active pieces across the team" },
          { label: "Overdue", value: d.stats.teamOverdue, hint: "Past turnaround in your area", tone: d.stats.teamOverdue ? "bad" : "ok" },
          {
            label: "On time",
            value: d.stats.onTimeRate == null ? "—" : `${Math.round(d.stats.onTimeRate)}%`,
            hint: "Your area, last 30 days",
            tone: d.stats.onTimeRate == null ? undefined : d.stats.onTimeRate < 80 ? "warn" : "ok",
          },
        ]}
      />

      <div className="grid gap-8 lg:grid-cols-[1fr_300px]">
        <section className="grid content-start gap-3">
          <SectionTitle aside="Oldest first">{d.reviewLabel}</SectionTitle>
          <Queue items={d.review} empty={{ title: "All reviewed", body: "New work for your review shows up here the moment it's uploaded." }} />
        </section>
        <aside className="grid content-start gap-3">
          <SectionTitle>Your team</SectionTitle>
          <TeamLoad people={d.team} />
        </aside>
      </div>

      {d.suggestions && <SuggestedBriefs state={d.suggestions} />}

      {d.kpis && <KpiPulse k={d.kpis} />}

      {d.fatigue && <FatigueWatch rows={d.fatigue} />}

      <section className="grid gap-3">
        <SectionTitle aside={`${d.department} only`}>Needs attention</SectionTitle>
        <AttentionList alerts={d.attention} empty="Nothing stuck in your area." />
      </section>

      <section className="grid gap-4">
        <SectionTitle aside="Average business days per phase">Flow</SectionTitle>
        <FlowStrip phases={d.phases} showTiming />
      </section>
    </div>
  );
}
