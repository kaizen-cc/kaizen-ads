// The client page's shape, shown the instant a client is clicked while its data loads (and what Next.js prefetches
// for each client link, so the switch itself is immediate)
export default function Loading() {
  const pulse = "animate-pulse rounded-[14px] bg-surface";
  return (
    <div className="grid gap-6" aria-busy="true" aria-label="Loading the client">
      <div className="grid gap-3">
        <div className="h-4 w-24 animate-pulse rounded-[6px] bg-surface/70" />
        <div className="h-10 w-72 max-w-full animate-pulse rounded-[10px] bg-surface" />
        <div className="flex flex-wrap gap-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-7 w-24 animate-pulse rounded-full bg-surface" style={{ animationDelay: `${i * 60}ms` }} />
          ))}
        </div>
      </div>
      <div className="flex gap-2 overflow-hidden">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-10 w-28 shrink-0 animate-pulse rounded-full bg-surface" style={{ animationDelay: `${i * 60}ms` }} />
        ))}
      </div>
      <div className={`${pulse} h-24 border border-line`} />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={`${pulse} h-32 border border-line`} style={{ animationDelay: `${i * 80}ms` }} />
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className={`${pulse} h-56 border border-line`} style={{ animationDelay: `${i * 80 + 200}ms` }} />
        ))}
      </div>
    </div>
  );
}
