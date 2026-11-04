// Small pieces shared by Google in the market and keyword research: volumes, the 12-month line, competition chips.

export const big = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}K` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
export const COMP: Record<string, string> = { high: "bg-bad-soft text-bad", medium: "bg-warn-soft text-warn", low: "bg-ok-soft text-ok" };
export const bid = (low: number, high: number) => (high ? `$${low.toFixed(2)}–$${high.toFixed(2)}` : "–");

/** The last 12 months as a small line, and how the last three compare with the three before. */
export function Trend({ months }: { months: number[] }) {
  const m = months.slice(-12);
  if (m.length < 4) return <span className="text-xs text-faint">–</span>;
  const max = Math.max(...m, 1);
  const pts = m.map((v, i) => `${(i / (m.length - 1)) * 100},${28 - (v / max) * 26}`).join(" ");
  const recent = m.slice(-3).reduce((a, b) => a + b, 0);
  const before = m.slice(-6, -3).reduce((a, b) => a + b, 0);
  const change = before ? (recent - before) / before : null;
  const up = (change ?? 0) >= 0;
  return (
    <span className="flex items-center gap-2">
      <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-7 w-20" aria-hidden>
        <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" className={up ? "text-ok" : "text-bad"} strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      {change != null && <span className={`tabular w-12 text-xs ${up ? "text-ok" : "text-bad"}`}>{`${up ? "+" : ""}${Math.round(change * 100)}%`}</span>}
    </span>
  );
}

export function Competition({ value }: { value: string }) {
  return <span className={`rounded-full px-2 py-0.5 text-[11px] capitalize ${COMP[value] ?? "bg-surface-2 text-muted"}`}>{value === "unspecified" ? "unknown" : value}</span>;
}
