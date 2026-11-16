/**
 * A small trend for an email or social card, drawn in the theme's colors (no hex: the line takes the status color
 * through currentColor). Email: a running total through the month with the straight line to the target at month end;
 * social: the 7 day engagement rate with the target as a flat line. `span` is how many days the x axis covers, so a
 * month in progress stops where today is.
 */
export function ChannelSpark({
  values,
  span,
  goal,
  tone = "text-fg",
  width = 220,
  height = 44,
  label,
  tall = false,
}: {
  values: (number | null)[];
  span: number;
  /** The target's line, from [day 0, y] to [span, y] */
  goal?: { from: number; to: number } | null;
  tone?: string;
  width?: number;
  height?: number;
  label?: string;
  tall?: boolean;
}) {
  const pts = values.map((v, i) => (v == null ? null : { i, v }));
  const real = pts.filter((p): p is { i: number; v: number } => p != null);
  if (real.length < 2) {
    return <div role="img" aria-label={label ?? "Not enough days yet"} className={`grid ${tall ? "h-28" : "h-11"} place-items-center rounded-[8px] border border-dashed border-line text-[11px] text-faint`}>Not enough days yet</div>;
  }
  const max = Math.max(...real.map((p) => p.v), goal?.from ?? 0, goal?.to ?? 0, 1e-9);
  const pad = 3;
  const x = (i: number) => pad + (i / Math.max(1, span - 1)) * (width - pad * 2);
  const y = (v: number) => height - pad - (v / max) * (height - pad * 2);
  // A gap (a day with no number) breaks the line instead of dropping to zero
  let d = "";
  let pen = false;
  for (const p of pts) {
    if (!p) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)} `;
    pen = true;
  }
  const last = real[real.length - 1];
  const area = `${d} L${x(last.i).toFixed(1)} ${height - pad} L${x(real[0].i).toFixed(1)} ${height - pad} Z`;
  return (
    <svg role="img" aria-label={label ?? "Trend"} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={`${tall ? "h-28" : "h-11"} w-full ${tone}`}>
      {goal && <line x1={x(0)} y1={y(goal.from)} x2={x(span - 1)} y2={y(goal.to)} className="text-faint" stroke="currentColor" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
      <path d={area} fill="currentColor" opacity="0.1" />
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
