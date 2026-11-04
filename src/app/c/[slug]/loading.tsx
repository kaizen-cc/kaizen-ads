// Shown the instant a client moves between their portal's pages, while the next one loads
export default function Loading() {
  const pulse = "animate-pulse rounded-[20px] bg-surface";
  return (
    <div className="grid gap-5" aria-busy="true" aria-label="Loading">
      <div className={`${pulse} h-40 border border-line md:h-48`} />
      <div className="grid gap-3 md:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={`${pulse} h-24 border border-line`} style={{ animationDelay: `${i * 80}ms` }} />
        ))}
      </div>
    </div>
  );
}
