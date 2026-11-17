import { nyToday } from "@/lib/dates";

/** A due date (YYYY-MM-DD, or a moment) as Kaizen's day in New York */
const dayOf = (due: string) => (/^\d{4}-\d{2}-\d{2}$/.test(due) ? due : nyToday(new Date(due)));
const label = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** When it's due, read at a glance: green ahead of time, amber on the day, red once it's past */
export function dueTone(due: string, today = nyToday()): "ahead" | "today" | "late" {
  const d = dayOf(due);
  return d < today ? "late" : d === today ? "today" : "ahead";
}

const TONE = {
  ahead: "bg-ok-soft text-ok",
  today: "bg-warn-soft text-warn",
  late: "bg-bad-soft text-bad",
} as const;

/**
 * The due date on a card, big enough to read on the go (the first thing a designer looks for): "Due Nov 18" in green,
 * "Due today" in amber, "Overdue · Nov 12" in red. Nothing when there's no date.
 */
export function DuePill({ due, className = "" }: { due: string | null | undefined; className?: string }) {
  if (!due) return null;
  const tone = dueTone(due);
  const day = dayOf(due);
  return (
    <span className={`tabular inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] font-semibold leading-none ${TONE[tone]} ${className}`} title={`Due ${label(day)}`}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="3.5" y="5" width="17" height="15" rx="2" />
        <path d="M3.5 10h17M8 3v4M16 3v4" />
      </svg>
      {tone === "late" ? `Overdue · ${label(day)}` : tone === "today" ? "Due today" : `Due ${label(day)}`}
    </span>
  );
}
