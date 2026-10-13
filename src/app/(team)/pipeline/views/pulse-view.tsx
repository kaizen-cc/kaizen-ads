import Link from "next/link";
import {
  AttentionList,
  ClientHealth,
  FlowStrip,
  PageHeader,
  SectionTitle,
  Stats,
  TeamLoad,
  type Alert,
  type ClientPulse,
  type Load,
  type PhaseKey,
  type PhaseStat,
} from "./shared";

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
};

/** Executives: a read-only pulse on the creative team, the work and the clients. */
export function PulseView(d: PulseData) {
  const urgent = d.attention.filter((a) => a.tone === "bad").length;
  const summary = d.vitals.inMotion
    ? urgent
      ? `${urgent} ${urgent === 1 ? "thing needs" : "things need"} attention · ${d.vitals.inMotion} pieces in motion`
      : `All steady · ${d.vitals.inMotion} pieces in motion`
    : "Nothing in motion yet. This fills in as requests flow.";
  const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v)}%`);

  return (
    <div className="mx-auto grid max-w-6xl gap-10">
      <PageHeader today={d.today} title={`${d.greeting}, ${d.firstName}`} subtitle={summary} />

      <Stats
        items={[
          { label: "In motion", value: d.vitals.inMotion, hint: "Requested → launched" },
          {
            label: "Turnaround",
            value: d.vitals.turnaroundDays == null ? "—" : `${d.vitals.turnaroundDays.toFixed(1)}d`,
            hint: `Request → client approval · target ${d.vitals.turnaroundTarget}d`,
            tone: d.vitals.turnaroundDays == null ? undefined : d.vitals.turnaroundDays > d.vitals.turnaroundTarget ? "warn" : "ok",
          },
          {
            label: "First-pass approval",
            value: pct(d.vitals.firstPassRate),
            hint: "Approved by clients with no changes",
            tone: d.vitals.firstPassRate == null ? undefined : d.vitals.firstPassRate < 60 ? "warn" : "ok",
          },
          {
            label: "On time",
            value: pct(d.vitals.onTimeRate),
            hint: "Stages finished within turnaround",
            tone: d.vitals.onTimeRate == null ? undefined : d.vitals.onTimeRate < 80 ? "warn" : "ok",
          },
        ]}
      />

      <section className="grid gap-4">
        <SectionTitle aside="Average business days in each phase vs its turnaround">Flow</SectionTitle>
        <FlowStrip phases={d.phases} showTiming />
      </section>

      <div className="grid gap-8 lg:grid-cols-[1fr_300px]">
        <section className="grid content-start gap-3">
          <SectionTitle aside="Worst first">Needs attention</SectionTitle>
          <AttentionList alerts={d.attention} empty="Nothing is stuck, no client is unhappy, every allotment is on pace." />
        </section>
        <aside className="grid content-start gap-3">
          <SectionTitle>Team load</SectionTitle>
          <TeamLoad people={d.team} />
        </aside>
      </div>

      <section className="grid gap-3">
        <SectionTitle
          aside={
            <span className="inline-flex items-center gap-2">
              <span className="inline-block h-3 w-px bg-fg/60" /> where they should be by today
            </span>
          }
        >
          Client health
        </SectionTitle>
        <ClientHealth clients={d.clients} monthElapsed={d.monthElapsed} />
        <Link href="/clients" className="justify-self-start text-xs text-muted hover:text-fg">
          All clients →
        </Link>
      </section>
    </div>
  );
}
