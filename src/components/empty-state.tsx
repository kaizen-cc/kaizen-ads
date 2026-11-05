import Link from "next/link";

// The one empty state for a section with nothing in it: a soft tinted card with a small mark and a confident line, never
// a dashed "something's missing" outline. Optionally one helpful action (a link or a button).

type Tone = "ok" | "brand" | "neutral";
const TONES: Record<Tone, { card: string; mark: string }> = {
  ok: { card: "border-ok/15 bg-ok-soft", mark: "bg-ok text-white" },
  brand: { card: "border-brand/15 bg-brand-soft/60", mark: "bg-brand text-white" },
  neutral: { card: "border-line bg-surface", mark: "bg-surface-2 text-muted" },
};

const ICONS = {
  check: <path d="m5 12.5 4.2 4.2L19 7" />,
  star: <path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />,
  spark: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.5 2.5M15.2 15.2l2.5 2.5M6.3 17.7l2.5-2.5M15.2 8.8l2.5-2.5" />,
  calm: <path d="M4 15c2.5-3 5.5-3 8 0s5.5 3 8 0M4 9c2.5-3 5.5-3 8 0s5.5 3 8 0" />,
} as const;

export function EmptyState({
  title,
  line,
  icon = "check",
  tone = "ok",
  action,
  className = "",
}: {
  /** The confident part, e.g. "All clear" */
  title: string;
  /** What it means, e.g. "nothing tiring or off for them right now" */
  line?: React.ReactNode;
  icon?: keyof typeof ICONS;
  tone?: Tone;
  /** One helpful next step */
  action?: { label: string; href?: string; onClick?: () => void; external?: boolean } | null;
  className?: string;
}) {
  const t = TONES[tone];
  const btn = "inline-flex min-h-11 shrink-0 items-center justify-center rounded-full border border-line bg-surface px-4 text-[13px] font-medium text-fg transition-colors hover:border-faint md:min-h-9";
  return (
    <div className={`flex flex-wrap items-center gap-3 rounded-[18px] border px-4 py-3.5 sm:flex-nowrap ${t.card} ${className}`}>
      <span aria-hidden className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${t.mark}`}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          {ICONS[icon]}
        </svg>
      </span>
      <p className="min-w-0 flex-1 text-[14px] leading-snug">
        <span className="font-medium text-fg">{title}</span>
        {line ? <span className="text-muted">: {line}</span> : null}
      </p>
      {action &&
        (action.href ? (
          action.external ? (
            <a href={action.href} target="_blank" rel="noreferrer" className={btn}>
              {action.label} ↗
            </a>
          ) : (
            <Link href={action.href} className={btn}>
              {action.label} →
            </Link>
          )
        ) : (
          <button type="button" onClick={action.onClick} className={btn}>
            {action.label}
          </button>
        ))}
    </div>
  );
}
