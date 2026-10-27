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

// ─── Health: the account's color, day by day ────────────────────────────────

export type Health = "ok" | "warn" | "bad" | "none";
/** An account's overall color, from its status */
export const healthOf = (status: string): Health => (status === "excellent" || status === "good" ? "ok" : status === "close" ? "warn" : status === "off" ? "bad" : "none");
const HEX: Record<Health, string> = { ok: "#3fb27f", warn: "#e0a63a", bad: "#e0505c", none: "#8a8a93" };
export const healthHex = (h: Health) => HEX[h];

type Day = { d: string; spend: number; results: number };

/** Cost per result over the 3 days to this one, so one quiet day doesn't paint the chart red */
const rolling = (daily: Day[], i: number) => {
  const win = daily.slice(Math.max(0, i - 2), i + 1);
  const spend = win.reduce((n, d) => n + d.spend, 0);
  const results = win.reduce((n, d) => n + d.results, 0);
  return { spend, results, cpr: results ? spend / results : null };
};

/** How one day did against target (3-day rolling) */
function dayHealth(daily: Day[], i: number, target: number | null, roas: boolean): Health {
  if (!target || roas) return "none";
  const r = rolling(daily, i);
  if (!r.spend) return "none";
  if (r.cpr == null) return r.spend > target ? "bad" : "none";
  const off = (r.cpr - target) / target;
  return off <= 0 ? "ok" : off <= 0.15 ? "warn" : "bad";
}

const dateLabel = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/**
 * The last 30 days in the account's color: cost per result (3-day rolling) as a line that takes each day's own color
 * (green beating target, amber close, red over), over spend bars, with the target line; the whole chart is washed in
 * the account's overall color. ROAS accounts (no daily revenue) show results per day in the account's color.
 */
export function HealthChart({ id, daily, target, roas, status, height = 200, compact = false, unit = "result" }: { id: string; daily: Day[]; target: number | null; roas: boolean; status: string; height?: number; compact?: boolean; unit?: string }) {
  const h = healthOf(status);
  const color = HEX[h];
  if (!daily.length) return compact ? <span className="text-[11px] text-faint">No daily data</span> : <p className="text-sm text-faint">No daily numbers yet.</p>;
  const width = compact ? 180 : 640;
  const padB = compact ? 4 : 22;
  const padT = compact ? 4 : 16;
  const inner = height - padB - padT;
  const byCost = Boolean(target) && !roas;
  const vals = daily.map((_, i) => (byCost ? rolling(daily, i).cpr : daily[i].results));
  const finite = vals.filter((v): v is number => v != null);
  const top = Math.max(...finite, byCost && target ? target * 1.6 : 1, 1);
  const y = (v: number) => padT + inner - (Math.min(v, top) / top) * inner;
  const x = (i: number) => (daily.length === 1 ? width / 2 : (i * width) / (daily.length - 1));
  const maxSpend = Math.max(...daily.map((d) => d.spend), 1);
  const known = vals.map((v, i) => (v == null ? null : { x: x(i), y: y(v), i })).filter((p): p is { x: number; y: number; i: number } => p !== null);
  const path = known.map((p, k) => `${k ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const area = known.length > 1 ? `${path} L${known[known.length - 1].x},${padT + inner} L${known[0].x},${padT + inner} Z` : "";
  const ty = byCost && target ? y(target) : null;
  const gid = `hc-${id}-${compact ? "s" : "l"}`;
  const last = known[known.length - 1];
  const lastHealth = last ? (byCost ? dayHealth(daily, last.i, target, roas) : h) : h;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="block h-auto w-full overflow-visible" preserveAspectRatio="none" aria-label={byCost ? `Cost per ${unit}, last 30 days` : "Results per day, last 30 days"}>
      <defs>
        {/* The line takes each day's color; the area the account's */}
        <linearGradient id={`${gid}-line`} x1="0" x2={width} y1="0" y2="0" gradientUnits="userSpaceOnUse">
          {daily.map((_, i) => {
            const dh = byCost ? dayHealth(daily, i, target, roas) : h;
            return <stop key={i} offset={`${(x(i) / width) * 100}%`} stopColor={HEX[dh === "none" ? h : dh]} />;
          })}
        </linearGradient>
        <linearGradient id={`${gid}-area`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={compact ? 0.34 : 0.3} />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* Lower cost is better: under the target line is the good side */}
      {ty != null && !compact && (
        <>
          <rect x="0" y={padT} width={width} height={Math.max(0, ty - padT)} fill="#e0505c" opacity="0.05" />
          <rect x="0" y={ty} width={width} height={Math.max(0, padT + inner - ty)} fill="#3fb27f" opacity="0.05" />
        </>
      )}
      {!compact &&
        daily.map((d, i) => {
          const bh = (d.spend / maxSpend) * inner * 0.5;
          const bw = Math.max(2, width / daily.length - 5);
          return <rect key={d.d} x={x(i) - bw / 2} y={padT + inner - bh} width={bw} height={bh} rx="2" fill={color} opacity="0.12" />;
        })}
      {area && <path d={area} fill={`url(#${gid}-area)`} />}
      {ty != null && (
        <>
          <line x1="0" x2={width} y1={ty} y2={ty} stroke="var(--fg-faint)" strokeDasharray="4 4" strokeWidth={compact ? 0.8 : 1} opacity="0.85" />
          {!compact && (
            <text x={width - 4} y={ty - 6} textAnchor="end" fontSize="10.5" fill="var(--fg-muted)">
              Target {money(target)}
            </text>
          )}
        </>
      )}
      {path && <path d={path} fill="none" stroke={`url(#${gid}-line)`} strokeWidth={compact ? 2 : 2.75} strokeLinejoin="round" strokeLinecap="round" />}
      {/* The latest point, glowing in its own color */}
      {last && (
        <g>
          <circle cx={last.x} cy={last.y} r={compact ? 5.5 : 8} fill={HEX[lastHealth === "none" ? h : lastHealth]} opacity="0.25" />
          <circle cx={last.x} cy={last.y} r={compact ? 2.8 : 4} fill={HEX[lastHealth === "none" ? h : lastHealth]} stroke="var(--surface)" strokeWidth="1.5" />
        </g>
      )}
      {!compact &&
        known.map((p) => (
          <rect key={p.i} x={p.x - width / daily.length / 2} y={padT} width={width / daily.length} height={inner} fill="transparent">
            <title>{`${dateLabel(daily[p.i].d)}: ${byCost ? `${money(vals[p.i])} per ${unit} (3-day)` : `${daily[p.i].results} results`} · ${money(daily[p.i].spend)} spent that day`}</title>
          </rect>
        ))}
      {!compact &&
        daily.map((d, i) =>
          (i % 6 === 0 && daily.length - 1 - i >= 3) || i === daily.length - 1 ? (
            <text key={d.d} x={x(i)} y={height - 5} textAnchor={i === 0 ? "start" : i === daily.length - 1 ? "end" : "middle"} fontSize="10.5" fill="var(--fg-faint)">
              {dateLabel(d.d)}
            </text>
          ) : null,
        )}
    </svg>
  );
}

/** How far from target, as a gauge: the dot sits left of the target mark (better) or right (worse). */
export function TargetGauge({ value, target, roas }: { value: number | null | undefined; target: number | null; roas: boolean }) {
  if (value == null || !target) return null;
  const off = roas ? (target - value) / target : (value - target) / target; // positive = worse
  const pos = 50 + Math.max(-1, Math.min(1, off / 0.6)) * 50;
  const h: Health = off <= 0 ? "ok" : off <= 0.15 ? "warn" : "bad";
  return (
    <div className="relative h-1.5 w-full max-w-[160px] rounded-full" style={{ background: "linear-gradient(90deg, rgba(63,178,127,0.45), rgba(63,178,127,0.15) 46%, rgba(224,166,58,0.3) 56%, rgba(224,80,92,0.45))" }} title={`${Math.abs(Math.round(off * 100))}% ${off <= 0 ? "better" : "worse"} than target`}>
      <span className="absolute -top-1 bottom-[-4px] w-px bg-fg/70" style={{ left: "50%" }} />
      <span className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface" style={{ left: `${pos}%`, background: HEX[h], boxShadow: `0 0 12px ${HEX[h]}` }} />
    </div>
  );
}
