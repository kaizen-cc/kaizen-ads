import type { ScoreSnapshot } from "@/lib/email-ops/sprint-core";
import { socialCheckText, type SocialUnit } from "@/lib/social-score";

// The checks of the email score (and the social score's) as a small, quiet grid: each value against its bar, met or not. Server-rendered,
// shared by the audit page and the sprint page (the score board has its own, richer one).

// A social snapshot's checks carry their unit (pct, change, ratio): those read the social way
type Check = ScoreSnapshot["checks"][number] & { unit?: string };
const social = (c: Check): c is Check & { unit: SocialUnit } => c.unit === "change" || c.unit === "ratio" || c.unit === "pct";

const show = (c: Check) => {
  if (c.value == null) return "n/a";
  if (social(c)) return socialCheckText(c.unit, c.value);
  if (c.key === "deliverability") return String(Math.round(c.value));
  if (c.key === "rpr") return `$${c.value.toFixed(3)}`;
  return `${(c.value * 100).toFixed(c.bar < 0.02 ? 2 : 1)}%`;
};
const bar = (c: Check) => (social(c) ? socialCheckText(c.unit, c.bar) : c.key === "deliverability" ? String(c.bar) : c.key === "rpr" ? `$${c.bar.toFixed(2)}` : `${(c.bar * 100).toFixed(c.bar < 0.02 ? 1 : 0)}%`);

export function EmailChecks({ checks }: { checks: Check[] }) {
  return (
    <ul className="grid grid-cols-1 gap-px overflow-hidden rounded-[16px] border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
      {checks.map((c) => (
        <li key={c.key} className="flex min-w-0 items-center justify-between gap-3 bg-surface/90 px-4 py-3">
          <span className="min-w-0 truncate text-[12.5px] text-muted">{c.label}</span>
          <span className="flex shrink-0 items-baseline gap-1.5">
            <span className={`font-display text-base tabular ${c.value == null ? "text-faint" : c.met ? "text-ok" : "text-bad"}`}>{show(c)}</span>
            <span className="text-[10.5px] text-faint">bar {bar(c)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
