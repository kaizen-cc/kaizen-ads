import { Fragment } from "react";
import { allotmentPools, POOL_TONE, type PoolCounts } from "@/lib/allotment";

/**
 * A client's allotment the one way every screen shows it: per pool ("Images 86/50 · 36 over", "Videos 7/10"), the
 * overage in red, never images and videos summed and never an overage hidden. Renders nothing when no pool is set,
 * unless `empty` says what to show instead.
 */
export function AllotmentPools({ allotment, className = "", empty = null, suffix }: { allotment: PoolCounts | null | undefined; className?: string; empty?: React.ReactNode; suffix?: string }) {
  const pools = allotmentPools(allotment);
  if (!pools.length) return <>{empty}</>;
  return (
    <span className={`tabular ${className}`}>
      {pools.map((p, i) => (
        <Fragment key={p.key}>
          {i > 0 && <span aria-hidden className="opacity-60"> · </span>}
          <span className={POOL_TONE[p.state]}>{p.text}</span>
        </Fragment>
      ))}
      {suffix && <span> {suffix}</span>}
    </span>
  );
}
