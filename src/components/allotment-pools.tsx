import { Fragment } from "react";
import { allotmentPools, inProgress, POOL_TONE, type Allotment, type PoolCounts } from "@/lib/allotment";

/**
 * A client's allotment the one way every screen shows it: per pool ("Images 86/50 · 36 over", "Videos 7/10"), the
 * overage in red, never images and videos summed and never an overage hidden. Renders nothing when no pool is set,
 * unless `empty` says what to show instead.
 */
export function AllotmentPools({
  allotment,
  className = "",
  empty = null,
  suffix,
  progress = false,
  stacked = false,
}: {
  allotment: (PoolCounts & Pick<Allotment, "progress">) | null | undefined;
  className?: string;
  empty?: React.ReactNode;
  suffix?: string;
  /** Beside each pool, what's on the board or in Asana and not delivered yet ("Images 0/25 used · 14 in progress") */
  progress?: boolean;
  /** One line per pool (a client with images and videos reads both in full, at a readable size, never cut off) */
  stacked?: boolean;
}) {
  const pools = allotmentPools(allotment);
  if (!pools.length) return <>{empty}</>;
  if (stacked)
    return (
      <span className={`tabular grid gap-0.5 ${className}`}>
        {pools.map((p) => {
          const moving = progress ? inProgress(allotment, p.key) : 0;
          return (
            <span key={p.key} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
              <span className="w-[3.4rem] shrink-0 text-faint">{p.label}</span>
              <span className={`font-medium ${POOL_TONE[p.state] || "text-muted"}`}>
                {p.used}/{p.cap}
              </span>
              {p.over > 0 && <span className="text-bad">· {p.over} over</span>}
              {moving > 0 && <span className="text-warn">· {moving} in progress</span>}
            </span>
          );
        })}
        {suffix && <span>{suffix}</span>}
      </span>
    );
  return (
    <span className={`tabular ${className}`}>
      {pools.map((p, i) => (
        <Fragment key={p.key}>
          {i > 0 && <span aria-hidden className="opacity-60"> · </span>}
          <span className={POOL_TONE[p.state]}>{progress ? `${p.label} ${p.used}/${p.cap} used${p.over ? ` · ${p.over} over` : ""}` : p.text}</span>
          {progress && inProgress(allotment, p.key) > 0 && <span className="text-warn"> · {inProgress(allotment, p.key)} in progress</span>}
        </Fragment>
      ))}
      {suffix && <span> {suffix}</span>}
    </span>
  );
}
