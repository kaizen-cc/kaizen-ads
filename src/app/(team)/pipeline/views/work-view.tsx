import Link from "next/link";
import type { WatchRow } from "@/lib/fatigue";
import { FatigueWatch } from "@/components/fatigue-watch";
import type { OnboardingState } from "@/lib/suggestions";
import { OnboardingCallout } from "./onboarding-callout";
import { DOT, KpiPulse, PageHeader, PrimaryAction, Queue, SectionTitle, Stats, TXT, type KpiPulseData, type QueueItem, type Tone } from "./shared";

export type WorkVariant = "buyer" | "creative" | "copy" | "cs";

export type WorkData = {
  variant: WorkVariant;
  greeting: string;
  firstName: string;
  role: string;
  today: string;
  stats: { mine: number; dueToday: number; overdue: number; fourth: number };
  queue: QueueItem[];
  side: { title: string; items: { label: string; detail: string; value: string; tone: Tone }[]; empty: string };
  delivered?: { week: number; firstPass: number | null };
  canAct: boolean;
  kpis?: KpiPulseData | null; // a media buyer's own accounts
  fatigue?: WatchRow[] | null;
  onboarding?: OnboardingState | null;
};

const COPY: Record<WorkVariant, { action: string; fourth: string; fourthHint: string; queueTitle: string; empty: { title: string; body: string } }> = {
  buyer: {
    action: "Request creative",
    fourth: "Ready to launch",
    fourthHint: "Approved, set up in Meta",
    queueTitle: "Your queue",
    empty: { title: "You're clear", body: "Copy to fix, launches to confirm and paused ads to QA line up here, most urgent first." },
  },
  creative: {
    action: "Upload creative",
    fourth: "Revisions",
    fourthHint: "Changes asked in review or by clients",
    queueTitle: "Your queue",
    empty: { title: "You're clear", body: "New briefs and revisions land here with the client, the brief and when it's due." },
  },
  copy: {
    action: "Open copy review",
    fourth: "Edited this week",
    fourthHint: "Your edits teach the copy writer",
    queueTitle: "Copy to review",
    empty: { title: "No copy waiting", body: "AI drafts arrive here the moment a creative passes review. Edit and pass it on." },
  },
  cs: {
    action: "Open client queue",
    fourth: "Past 48h",
    fourthHint: "Clients to nudge",
    queueTitle: "Ready to send",
    empty: { title: "Nothing to send", body: "Batches cleared by creative and copy review line up here, grouped by client." },
  },
};

/** Team members: what's on my plate, in order. Nothing else. */
export function WorkView(d: WorkData) {
  const c = COPY[d.variant];
  return (
    <div className="mx-auto grid max-w-6xl gap-10">
      <PageHeader
        today={d.today}
        title={`${d.greeting}, ${d.firstName}`}
        subtitle={`${d.role} · ${d.stats.mine ? `${d.stats.mine} on your plate` : "your plate is clear"}`}
        action={<PrimaryAction label={c.action} disabled={!d.canAct} href={d.variant === "buyer" ? "/requests/new" : undefined} />}
      />

      {d.onboarding && <OnboardingCallout state={d.onboarding} clients={[]} />}

      <Stats
        items={[
          { label: "On your plate", value: d.stats.mine, hint: "Assigned to you", tone: "brand" },
          { label: "Due today", value: d.stats.dueToday, hint: "Business hours, ET", tone: "warn" },
          { label: "Overdue", value: d.stats.overdue, hint: "Past turnaround", tone: "bad" },
          { label: c.fourth, value: d.stats.fourth, hint: c.fourthHint, tone: "muted" },
        ]}
      />

      {d.kpis && <KpiPulse k={d.kpis} title="Your ad accounts" />}

      {d.fatigue && <FatigueWatch rows={d.fatigue} title="Your ads wearing out" empty="None of your clients' ads are wearing out right now." />}

      <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
        <section className="grid content-start gap-3">
          <SectionTitle aside="Most urgent first">{c.queueTitle}</SectionTitle>
          <Queue items={d.queue} empty={c.empty} />
        </section>

        <aside className="grid content-start gap-8">
          <section className="grid gap-3">
            <h2 className="text-sm font-medium">{d.side.title}</h2>
            {d.side.items.length ? (
              <ul className="grid gap-2">
                {d.side.items.map((s) => (
                  <li key={s.label + s.detail} className="flex items-center gap-3 rounded-brand border border-line bg-surface px-3 py-2.5">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[s.tone]}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{s.label}</span>
                      <span className="block truncate text-xs text-faint">{s.detail}</span>
                    </span>
                    <span className={`tabular shrink-0 text-xs ${TXT[s.tone]}`}>{s.value}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-faint">{d.side.empty}</p>
            )}
          </section>

          {d.delivered && (
            <section className="grid grid-cols-2 gap-px overflow-hidden rounded-brand border border-line bg-line">
              <div className="bg-surface p-4">
                <p className="text-xs text-muted">Delivered this week</p>
                <p className="tabular mt-1 font-heading text-2xl">{d.delivered.week}</p>
              </div>
              <div className="bg-surface p-4">
                <p className="text-xs text-muted">First-pass approvals</p>
                <p className="tabular mt-1 font-heading text-2xl">{d.delivered.firstPass == null ? "—" : `${d.delivered.firstPass}%`}</p>
              </div>
            </section>
          )}

          {d.variant === "buyer" && (
            <Link href="/clients?gaps=1" className="grid gap-1 rounded-brand border border-line bg-gradient-to-br from-surface to-surface-2 p-4 hover:border-faint">
              <span className="text-sm font-medium">Your clients</span>
              <span className="text-xs text-muted">Check each has a designer, editor and contact →</span>
            </Link>
          )}
        </aside>
      </div>
    </div>
  );
}
