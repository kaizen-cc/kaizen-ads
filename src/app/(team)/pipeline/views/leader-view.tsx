import type { WatchRow } from "@/lib/fatigue";
import type { Production } from "@/lib/production";
import type { CallPromise, OnboardingState, SuggestionsState } from "@/lib/suggestions";
import { buildThemes } from "./overview-topics";
import { FlowStrip, PageHeader, PrimaryAction, Queue, Stats, TeamLoad, type Alert, type KpiPulseData, type Load, type PhaseKey, type PhaseStat, type QueueItem } from "./shared";
import { Themes } from "./themes";
import { Topic } from "./topics";

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
  kpis?: KpiPulseData[] | null;
  production?: Production | null; // the Head of Creative's
  fatigue?: WatchRow[] | null;
  onboarding?: OnboardingState | null;
  callPromises?: CallPromise[] | null;
  clientOptions?: { id: string; name: string }[];
  suggestions?: SuggestionsState | null;
};

/** Leaders (Head of Creative / Meta / Google): their queue first, then the same themes as execs, their team in Delivery. */
export function LeaderView(d: LeaderData & { handoffs?: React.ReactNode; recap?: React.ReactNode }) {
  const working = d.stats.teamActive > 0;
  const themes = buildThemes(d, {
    production: d.production,
    first: {
      id: "queue",
      title: "Your queue",
      tone: d.review.length ? "brand" : "ok",
      count: d.review.length,
      headline: d.review.length ? d.reviewLabel : "Nothing waiting on you",
      points: d.review.length ? [`oldest first`] : [],
      content: (
        <Topic id="review" title={d.reviewLabel} summary={`${d.review.length} waiting, oldest first`} count={d.review.length} tone="brand" defaultOpen>
          <Queue items={d.review} empty={{ title: "All reviewed", body: "New work for your review shows up here the moment it's uploaded." }} />
        </Topic>
      ),
    },
    delivery: {
      count: d.stats.teamOverdue,
      points: working ? [`${d.stats.teamActive} active on your team`, d.stats.teamOverdue ? `${d.stats.teamOverdue} overdue` : ""].filter(Boolean) : [],
      content: working ? (
        <Topic id="team" title={`${d.department} team`} summary={`${d.stats.teamActive} active · ${d.stats.teamOverdue} overdue · on time ${d.stats.onTimeRate == null ? "—" : `${Math.round(d.stats.onTimeRate)}%`}`} count={d.stats.teamOverdue || undefined} tone={d.stats.teamOverdue ? "bad" : "ok"}>
          <div className="grid gap-6">
            <Stats
              items={[
                { label: "Waiting on you", value: d.stats.waitingOnYou, hint: d.reviewLabel, tone: "brand" },
                { label: `${d.department} team`, value: d.stats.teamActive, hint: "Active pieces across the team" },
                { label: "Overdue", value: d.stats.teamOverdue, hint: "Past turnaround in your area", tone: d.stats.teamOverdue ? "bad" : "ok" },
                { label: "On time", value: d.stats.onTimeRate == null ? "—" : `${Math.round(d.stats.onTimeRate)}%`, hint: "Your area, last 30 days", tone: d.stats.onTimeRate == null ? undefined : d.stats.onTimeRate < 80 ? "warn" : "ok" },
              ]}
            />
            <TeamLoad people={d.team} />
            <FlowStrip phases={d.phases} showTiming />
          </div>
        </Topic>
      ) : (
        <p className="px-1 text-xs text-faint">Your team&apos;s load, overdue work and flow fill in here once requests move through Kaizen Ads instead of Asana.</p>
      ),
    },
  });

  return (
    <div className="mx-auto grid max-w-6xl gap-8">
      <PageHeader
        today={d.today}
        title={`${d.greeting}, ${d.firstName}`}
        subtitle={`Head of ${d.department} · ${d.stats.waitingOnYou ? `${d.stats.waitingOnYou} waiting on you` : "nothing waiting on you"}`}
        action={<PrimaryAction label="New request" disabled={!d.canRequest} href="/requests/new" />}
      />
      {d.recap}
      {d.handoffs}
      <Themes themes={themes} />
    </div>
  );
}
