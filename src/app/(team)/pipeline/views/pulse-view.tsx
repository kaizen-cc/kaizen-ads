import type { WatchRow } from "@/lib/fatigue";
import type { CallPromise, OnboardingState, SuggestionsState } from "@/lib/suggestions";
import { accountTopics, actTopics, AllClear } from "./overview-topics";
import { FlowStrip, PageHeader, Stats, TeamLoad, type Alert, type ClientPulse, type KpiPulseData, type Load, type PhaseKey, type PhaseStat } from "./shared";
import { Compartment, Topic, TopicDeck } from "./topics";

export type PulseData = {
  greeting: string;
  firstName: string;
  today: string;
  vitals: {
    inMotion: number;
    turnaroundDays: number | null; // request → client approval, business days
    turnaroundTarget: number;
    firstPassRate: number | null; // % approved by the client with no revisions
    onTimeRate: number | null; // % of stages finished within turnaround
  };
  attention: Alert[];
  phases: Record<PhaseKey, PhaseStat>;
  clients: ClientPulse[];
  team: Load[];
  monthElapsed: number; // 0–1, business days of the month gone
  kpis?: KpiPulseData | null;
  fatigue?: WatchRow[] | null;
  onboarding?: OnboardingState | null;
  callPromises?: CallPromise[] | null;
  clientOptions?: { id: string; name: string }[];
  suggestions?: SuggestionsState | null;
  handoffs?: React.ReactNode;
};

/**
 * Executives: today at a glance (one tile per topic with something in it), then the topics to act on, the accounts,
 * and the work, each a panel that opens to its detail. Empty topics aren't shown; what's all clear is one line.
 */
export function PulseView(d: PulseData) {
  const act = actTopics(d);
  const accounts = accountTopics(d);
  const v = d.vitals;
  const pct = (x: number | null) => (x == null ? "—" : `${Math.round(x)}%`);
  const working = v.inMotion > 0;
  const workTile = working
    ? { id: "work", label: "In motion", value: v.inMotion, sub: v.turnaroundDays == null ? "pieces in Kaizen Ads" : `${v.turnaroundDays.toFixed(1)}d turnaround · target ${v.turnaroundTarget}d`, tone: v.turnaroundDays != null && v.turnaroundDays > v.turnaroundTarget ? ("warn" as const) : ("ok" as const) }
    : null;
  const tiles = [...act, ...accounts].map((b) => b.tile).filter((t): t is NonNullable<typeof t> => Boolean(t));
  if (workTile) tiles.push(workTile);
  const clear = [...act, ...accounts].map((b) => b.clear).filter((c): c is string => Boolean(c));
  const urgent = tiles.filter((t) => t.tone === "bad" || t.tone === "warn").length;

  return (
    <div className="mx-auto grid max-w-6xl gap-9">
      <PageHeader
        today={d.today}
        title={`${d.greeting}, ${d.firstName}`}
        subtitle={tiles.length ? `${urgent ? `${urgent} ${urgent === 1 ? "topic needs" : "topics need"} you today` : "All steady today"} · open any topic to act on it` : "All clear. Nothing needs you today."}
      />
      {d.handoffs}

      <TopicDeck tiles={tiles} />

      {act.some((b) => b.panel) && (
        <Compartment title="Act on today" note="Promises, decisions and anything stuck">
          {act.map((b) => b.panel)}
        </Compartment>
      )}

      {accounts.some((b) => b.panel) && (
        <Compartment title="Your accounts" note="Results, ads and creative this month">
          {accounts.map((b) => b.panel)}
        </Compartment>
      )}

      <Compartment title="The work" note={working ? "Requests moving through Kaizen Ads" : undefined}>
        {working ? (
          <Topic id="work" title="Work in motion" summary={`${v.inMotion} pieces · turnaround ${v.turnaroundDays == null ? "—" : `${v.turnaroundDays.toFixed(1)}d`} · first-pass ${pct(v.firstPassRate)} · on time ${pct(v.onTimeRate)}`} count={v.inMotion} tone={workTile?.tone}>
            <div className="grid gap-6">
              <Stats
                items={[
                  { label: "In motion", value: v.inMotion, hint: "Requested → launched" },
                  {
                    label: "Turnaround",
                    value: v.turnaroundDays == null ? "—" : `${v.turnaroundDays.toFixed(1)}d`,
                    hint: `Request → client approval · target ${v.turnaroundTarget}d`,
                    tone: v.turnaroundDays == null ? undefined : v.turnaroundDays > v.turnaroundTarget ? "warn" : "ok",
                  },
                  { label: "First-pass approval", value: pct(v.firstPassRate), hint: "Approved by clients with no changes", tone: v.firstPassRate == null ? undefined : v.firstPassRate < 60 ? "warn" : "ok" },
                  { label: "On time", value: pct(v.onTimeRate), hint: "Stages finished within turnaround", tone: v.onTimeRate == null ? undefined : v.onTimeRate < 80 ? "warn" : "ok" },
                ]}
              />
              <FlowStrip phases={d.phases} showTiming />
              {d.team.length > 0 && (
                <div className="grid gap-3">
                  <p className="text-xs uppercase tracking-[0.14em] text-faint">Team load</p>
                  <TeamLoad people={d.team} />
                </div>
              )}
            </div>
          </Topic>
        ) : (
          <p className="px-1 text-xs text-faint">Turnaround, first-pass approval, flow and team load fill in here once requests move through Kaizen Ads instead of Asana.</p>
        )}
      </Compartment>

      <AllClear items={clear} />
    </div>
  );
}
