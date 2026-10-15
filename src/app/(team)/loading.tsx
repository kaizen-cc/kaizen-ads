// Shown the moment a tab is clicked, while the page's data loads. With it, Next.js also prefetches each
// tab's shell ahead of time, so the switch itself is instant.
export default function Loading() {
  const block = "animate-pulse rounded-[14px] bg-surface";
  return (
    <div className="grid gap-7" aria-busy="true" aria-label="Loading">
      <div className="grid gap-2.5">
        <div className="h-9 w-48 animate-pulse rounded-[8px] bg-surface" />
        <div className="h-4 w-80 max-w-full animate-pulse rounded-[6px] bg-surface/70" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={`${block} h-28 border border-line`} style={{ animationDelay: `${i * 80}ms` }} />
        ))}
      </div>
      <div className="grid gap-2.5">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className={`${block} h-20 border border-line`} style={{ animationDelay: `${i * 80 + 200}ms` }} />
        ))}
      </div>
    </div>
  );
}
