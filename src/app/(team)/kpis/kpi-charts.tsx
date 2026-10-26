import { worseBy, type Agg, type Pacing } from "@/lib/kpi/calc";
import { kpiValue, money } from "@/lib/kpi/format";

const WINDOWS = [
  ["d90", "90"],
  ["d60", "60"],
  ["d30", "30"],
  ["d14", "14"],
  ["d7", "7"],
  ["d3", "3"],
] as const;

const band = (x: number | null) => (x == null ? "var(--fg-faint)" : x <= -0.2 ? "var(--ok)" : x <= 0 ? "var(--ok)" : x <= 0.15 ? "var(--warn)" : "var(--bad)");

/**
 * The moving averages against the target, oldest to newest (90 → 3 days).
 * Above the dashed target line is better than target, below is worse, so the line's direction reads as momentum.
 */
export function Ladder({ windows, target, roas, width = 172, height = 46 }: { windows: Partial<Record<string, Agg>>; target: number | null; roas: boolean; width?: number; height?: number }) {
  const padX = 8;
  const mid = height / 2 - 4;
  const range = mid - 4;
  const pts = WINDOWS.map(([key, label], i) => {
    const v = windows[key]?.value ?? null;
    const bad = target ? worseBy(v, target, roas) : null;
    const clamped = bad == null ? 0 : Math.max(-0.6, Math.min(0.6, bad));
    return { key, label, v, bad, x: padX + (i * (width - padX * 2)) / (WINDOWS.length - 1), y: mid + (clamped / 0.6) * range };
  });
  const known = pts.filter((p) => p.v != null && target);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block overflow-visible" aria-label="Moving averages against target">
      <rect x="0" y="0" width={width} height={mid} fill="var(--ok)" opacity="0.045" rx="4" />
      <rect x="0" y={mid} width={width} height={mid} fill="var(--bad)" opacity="0.045" rx="4" />
      <line x1="0" x2={width} y1={mid} y2={mid} stroke="var(--fg-faint)" strokeDasharray="2 3" opacity="0.7" />
      {known.length > 1 && (
        <polyline points={known.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="var(--fg-muted)" strokeWidth="1.25" opacity="0.55" strokeLinejoin="round" />
      )}
      {pts.map((p) => (
        <g key={p.key}>
          <title>{`${p.label} days: ${kpiValue(p.v, roas)}`}</title>
          {p.v != null && target ? (
            <circle cx={p.x} cy={p.y} r={p.key === "d14" ? 4.2 : 3} fill={band(p.bad)} stroke="var(--surface)" strokeWidth="1.5" />
          ) : (
            <circle cx={p.x} cy={mid} r="2.5" fill="none" stroke="var(--fg-faint)" opacity="0.6" />
          )}
          <text x={p.x} y={height - 1} textAnchor="middle" fontSize="8.5" fill={p.key === "d14" ? "var(--fg-muted)" : "var(--fg-faint)"} fontWeight={p.key === "d14" ? 600 : 400}>
            {p.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

const PACE = {
  over: { label: "Overspending", fill: "bg-bad", text: "text-bad", chip: "bg-bad-soft text-bad" },
  under: { label: "Underspending", fill: "bg-warn", text: "text-warn", chip: "bg-warn-soft text-warn" },
  on: { label: "On pace", fill: "bg-ok", text: "text-ok", chip: "bg-ok-soft text-ok" },
  early: { label: "Too early to tell", fill: "bg-fg/40", text: "text-muted", chip: "bg-surface-2 text-muted" },
} as const;

export const paceMeta = (p: Pacing) => PACE[p.status];

/** Month-to-date spend against the budget: the tick is where an even spend would be now, the ghost is where the month lands. */
export function PaceBar({ pace, note, compact = false }: { pace: Pacing | null; note?: string | null; compact?: boolean }) {
  if (!pace)
    return (
      <div className="grid gap-1">
        <span className="text-xs text-faint">No monthly budget</span>
        {note && !compact && <span className="line-clamp-2 text-[11px] leading-snug text-faint/80">{note}</span>}
      </div>
    );
  const m = PACE[pace.status];
  const scale = Math.max(pace.budget, pace.projected, 1) * 1.04;
  const w = (x: number) => `${Math.min(100, (x / scale) * 100)}%`;
  return (
    <div className="grid min-w-0 gap-1.5">
      {compact ? (
        <span className={`text-[11px] font-medium ${m.text}`}>
          {m.label}
          <span className="tabular font-normal text-faint"> · {Math.round(pace.pace * 100)}%</span>
        </span>
      ) : (
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className="tabular truncate">
            {money(pace.spent)} <span className="text-faint">of {money(pace.budget)}</span>
          </span>
          <span className={`shrink-0 text-[11px] font-medium ${m.text}`}>{m.label}</span>
        </div>
      )}
      <div className="relative h-2 rounded-full bg-surface-2">
        <span className={`absolute inset-y-0 left-0 rounded-full opacity-25 ${m.fill}`} style={{ width: w(pace.projected) }} />
        <span className={`absolute inset-y-0 left-0 rounded-full ${m.fill}`} style={{ width: w(pace.spent) }} />
        <span className="absolute -inset-y-1 w-px bg-fg" style={{ left: w(pace.expected) }} title={`Even pace today: ${money(pace.expected)}`} />
        <span className="absolute -inset-y-0.5 w-0.5 rounded-full bg-faint" style={{ left: w(pace.budget) }} title={`Budget: ${money(pace.budget)}`} />
      </div>
      {compact ? (
        <span className="tabular truncate text-[11px] text-muted">
          {money(pace.spent)} <span className="text-faint">of {money(pace.budget)}</span>
        </span>
      ) : (
        <span className="text-[11px] text-faint">
          Lands at <span className="tabular text-muted">{money(pace.projected)}</span> ({Math.round(pace.pace * 100)}%)
        </span>
      )}
    </div>
  );
}

/** Last 30 days: spend as bars, results as a line on top. */
export function DailyChart({ daily, height = 120 }: { daily: { d: string; spend: number; results: number }[]; height?: number }) {
  if (!daily.length) return <p className="text-sm text-faint">No daily numbers yet.</p>;
  // Phones draw it at their own width (a 600-wide drawing squeezed to a phone shrinks the dates past reading)
  return (
    <>
      <div className="md:hidden">
        <DailySvg daily={daily} height={140} width={340} every={7} />
      </div>
      <div className="hidden md:block">
        <DailySvg daily={daily} height={height} width={600} every={5} />
      </div>
    </>
  );
}

function DailySvg({ daily, height, width, every }: { daily: { d: string; spend: number; results: number }[]; height: number; width: number; every: number }) {
  const maxSpend = Math.max(...daily.map((d) => d.spend), 1);
  const maxRes = Math.max(...daily.map((d) => d.results), 1);
  const bw = width / daily.length;
  const y = (r: number) => height - 18 - (r / maxRes) * (height - 30);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" preserveAspectRatio="none" aria-label="Daily spend and results">
      {daily.map((d, i) => {
        const h = (d.spend / maxSpend) * (height - 30);
        return (
          <g key={d.d}>
            <title>{`${d.d}: ${money(d.spend)} · ${d.results} results`}</title>
            <rect x={i * bw + 1.5} y={height - 18 - h} width={bw - 3} height={h} rx="2" fill="var(--brand)" opacity="0.28" />
          </g>
        );
      })}
      <polyline points={daily.map((d, i) => `${i * bw + bw / 2},${y(d.results)}`).join(" ")} fill="none" stroke="var(--fg)" strokeWidth="1.5" strokeLinejoin="round" opacity="0.8" />
      {/* Every few days, and always the last day; a date too close to the last one is left out so they never overlap */}
      {daily.map((d, i) => ((i % every === 0 && daily.length - 1 - i >= every / 2) || i === daily.length - 1 ? (
        <text key={d.d} x={i * bw + bw / 2} y={height - 3} textAnchor={i === 0 ? "start" : i === daily.length - 1 ? "end" : "middle"} fontSize="10" fill="var(--fg-faint)">
          {new Date(`${d.d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
        </text>
      ) : null))}
    </svg>
  );
}
