import type { WatchRow } from "@/lib/fatigue";
import type { CallPromise, OnboardingState, SuggestionsState } from "@/lib/suggestions";
import { accountTopics, actTopics, AllClear } from "./overview-topics";
import { FlowStrip, PageHeader, PrimaryAction, Queue, Stats, TeamLoad, type Alert, type KpiPulseData, type Load, type PhaseKey, type PhaseStat, type QueueItem } from "./shared";
import { Compartment, Topic, TopicDeck } from "./topics";

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

/** Leaders (Head of Creative / Meta / Google): their decisions first, then their accounts and their team, as topics. */
export function LeaderView(d: LeaderData & { handoffs?: React.ReactNode; recap?: React.ReactNode }) {
  const act = actTopics(d);
  const accounts = accountTopics(d);
  const reviewTile = d.review.length ? { id: "review", label: "Your review", value: d.review.length, sub: d.reviewLabel.toLowerCase(), tone: "brand" as const } : null;
  const working = d.stats.teamActive > 0;
  const tiles = [reviewTile, ...[...act, ...accounts].map((b) => b.tile)].filter((t): t is NonNullable<typeof t> => Boolean(t));
  if (working) tiles.push({ id: "team", label: `${d.department} team`, value: d.stats.teamActive, sub: d.stats.teamOverdue ? `${d.stats.teamOverdue} overdue` : "active pieces, all on time", tone: d.stats.teamOverdue ? "bad" : "ok" });
  const clear = [...act, ...accounts].map((b) => b.clear).filter((c): c is string => Boolean(c));

  return (
    <div className="mx-auto grid max-w-6xl gap-9">
      <PageHeader
        today={d.today}
        title={`${d.greeting}, ${d.firstName}`}
        subtitle={`Head of ${d.department} · ${d.stats.waitingOnYou ? `${d.stats.waitingOnYou} waiting on you` : "nothing waiting on you"}`}
        action={<PrimaryAction label="New request" disabled={!d.canRequest} href="/requests/new" />}
      />
      {d.recap}
      {d.handoffs}

      <TopicDeck tiles={tiles} />

      <Compartment title="Act on today" note="Your decisions first">
        {d.review.length > 0 && (
          <Topic id="review" title={d.reviewLabel} summary={`${d.review.length} waiting, oldest first`} count={d.review.length} tone="brand" defaultOpen>
            <Queue items={d.review} empty={{ title: "All reviewed", body: "" }} />
          </Topic>
        )}
        {act.map((b) => b.panel)}
      </Compartment>

      {accounts.some((b) => b.panel) && (
        <Compartment title="Your accounts" note="Results, ads and creative this month">
          {accounts.map((b) => b.panel)}
        </Compartment>
      )}

      <Compartment title="Your team" note={`${d.department} only`}>
        {working ? (
          <Topic
            id="team"
            title={`${d.department} team`}
            summary={`${d.stats.teamActive} active · ${d.stats.teamOverdue} overdue · on time ${d.stats.onTimeRate == null ? "—" : `${Math.round(d.stats.onTimeRate)}%`}`}
            count={d.stats.teamOverdue || undefined}
            tone={d.stats.teamOverdue ? "bad" : "ok"}
          >
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
        )}
      </Compartment>

      <AllClear items={clear} />
    </div>
  );
}
