import type { EmailBand } from "@/lib/email-score";
import { checkText, pointsLost, type EmailScoreResult } from "@/lib/email-score-calc";

export { checkText, pointsLost };

// How the email account score looks everywhere (board, Overview, client Email panel): the colour per band, the seven
// checks and what is weighing the score down. Server-safe (no hooks), theme tokens only.

export const BAND_TONE: Record<EmailBand, { text: string; bar: string; pill: string; css: string; label: string; word: string }> = {
  good: { text: "text-ok", bar: "bg-ok", pill: "bg-ok-soft text-ok", css: "var(--ok)", label: "Green", word: "Healthy" },
  watch: { text: "text-warn", bar: "bg-warn", pill: "bg-warn-soft text-warn", css: "var(--warn)", label: "Yellow", word: "Watch" },
  bad: { text: "text-bad", bar: "bg-bad", pill: "bg-bad-soft text-bad", css: "var(--bad)", label: "Red", word: "At risk" },
};


export function ScoreBadge({ r, size = "md" }: { r: Pick<EmailScoreResult, "score" | "band">; size?: "md" | "lg" }) {
  const t = BAND_TONE[r.band];
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className={`tabular font-display leading-none tracking-tight ${t.text} ${size === "lg" ? "text-[44px]" : "text-[30px]"}`}>{r.score}</span>
      <span className="text-xs text-faint">/ 100</span>
    </span>
  );
}

export function BandPill({ band }: { band: EmailBand }) {
  const t = BAND_TONE[band];
  return <span className={`inline-flex h-6 items-center whitespace-nowrap rounded-full px-2.5 text-[11px] font-medium ${t.pill}`}>{t.word}</span>;
}

/** The top missed checks, worst first, each with the points it costs: "Weighing it down" */
export function WeighingDown({ score, limit = 3, currency = "USD" }: { score: Pick<EmailScoreResult, "weighingDown">; limit?: number; currency?: string | null }) {
  const list = score.weighingDown.slice(0, limit);
  if (!list.length) return <p className="text-[12.5px] text-ok">Every check is at or over its bar.</p>;
  return (
    <div className="grid gap-1.5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Weighing it down</p>
      <ul className="grid gap-1">
        {list.map((c) => (
          <li key={c.key} className="flex items-baseline justify-between gap-3 text-[12.5px]">
            <span className="min-w-0 truncate text-fg">
              {c.label} <span className="tabular text-faint">{checkText(c.unit, c.value, currency, c.bar)} vs {checkText(c.unit, c.bar, currency)}</span>
            </span>
            <span className="tabular shrink-0 text-bad">-{pointsLost(c)} pts</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The seven checks, compact: met or not, the value against the bar, and the points earned */
export function ScoreChecks({ score, currency = "USD" }: { score: Pick<EmailScoreResult, "checks">; currency?: string | null }) {
  return (
    <ul className="grid gap-1.5">
      {score.checks.map((c) => {
        const measured = c.value != null;
        const tone = !measured ? "text-faint" : c.met ? "text-ok" : "text-bad";
        return (
          <li key={c.key} className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-baseline gap-x-2 text-[12.5px]">
            <span className={`${tone} text-[13px]`} aria-label={!measured ? "No data" : c.met ? "Met" : "Under the bar"}>
              {!measured ? "-" : c.met ? "✓" : "✗"}
            </span>
            <span className="min-w-0 truncate text-fg">{c.label}</span>
            <span className="tabular text-right">
              <span className={tone}>{checkText(c.unit, c.value, currency, c.bar)}</span>
              <span className="text-faint"> / bar {checkText(c.unit, c.bar, currency)}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
