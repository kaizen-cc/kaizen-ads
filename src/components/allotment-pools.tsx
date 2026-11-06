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
}: {
  allotment: (PoolCounts & Pick<Allotment, "progress">) | null | undefined;
  className?: string;
  empty?: React.ReactNode;
  suffix?: string;
  /** Beside each pool, what's on the board or in Asana and not delivered yet ("Images 0/25 used · 14 in progress") */
  progress?: boolean;
}) {
  const pools = allotmentPools(allotment);
  if (!pools.length) return <>{empty}</>;
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
