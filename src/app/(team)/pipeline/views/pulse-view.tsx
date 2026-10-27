import type { WatchRow } from "@/lib/fatigue";
import type { Production } from "@/lib/production";
import type { CallPromise, OnboardingState, SuggestionsState } from "@/lib/suggestions";
import { buildThemes } from "./overview-topics";
import { FlowStrip, PageHeader, Stats, TeamLoad, type Alert, type ClientPulse, type KpiPulseData, type Load, type PhaseKey, type PhaseStat } from "./shared";
import { Themes } from "./themes";
import { Topic } from "./topics";

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
  kpis?: KpiPulseData[] | null;
  production?: Production | null;
  fatigue?: WatchRow[] | null;
  onboarding?: OnboardingState | null;
  callPromises?: CallPromise[] | null;
  owed?: { items: import("@/lib/owed-replies").OwedReply[]; said: import("@/lib/message-promises").SaidPromise[]; me: string } | null;
  clientOptions?: { id: string; name: string }[];
  suggestions?: SuggestionsState | null;
  handoffs?: React.ReactNode;
  recap?: React.ReactNode;
};

/**
 * Executives: today's recap up top, then four themes (clients at risk, creative and growth, new clients, delivery),
 * each one number and a line. Opening a theme shows only its detail, so the page stays short.
 */
export function PulseView(d: PulseData) {
  const v = d.vitals;
  const pct = (x: number | null) => (x == null ? "—" : `${Math.round(x)}%`);
  const working = v.inMotion > 0;
  const themes = buildThemes(d, {
    production: d.production,
    delivery: {
      count: 0,
      points: working ? [`${v.inMotion} pieces in motion`, v.turnaroundDays == null ? "" : `${v.turnaroundDays.toFixed(1)}d turnaround`].filter(Boolean) : [],
      content: working ? (
        <Topic id="work" title="Work in motion" summary={`${v.inMotion} pieces · turnaround ${v.turnaroundDays == null ? "—" : `${v.turnaroundDays.toFixed(1)}d`} · first-pass ${pct(v.firstPassRate)} · on time ${pct(v.onTimeRate)}`} count={v.inMotion} tone="quiet">
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
            {d.team.length > 0 && <TeamLoad people={d.team} />}
          </div>
        </Topic>
      ) : (
        <p className="px-1 text-xs text-faint">Turnaround, first-pass approval, flow and team load fill in here once requests move through Kaizen Ads instead of Asana.</p>
      ),
    },
  });
  const urgent = themes.filter((t) => t.count && (t.tone === "bad" || t.tone === "brand" || t.tone === "warn")).length;

  return (
    <div className="mx-auto grid max-w-6xl gap-8">
      <PageHeader today={d.today} title={`${d.greeting}, ${d.firstName}`} subtitle={urgent ? `${urgent} of ${themes.length} areas need you today · open one to act on it` : "All steady today"} />
      {d.recap}
      {d.handoffs}
      <Themes themes={themes} />
    </div>
  );
}
