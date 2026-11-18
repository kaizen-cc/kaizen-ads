import Link from "next/link";
import type { BoardSwitch } from "./channel-board";

// The KPI board's switch as links (Meta, Google Ads, TikTok, Email, Social and, for execs, Account review): each tab is
// its own page, prefetched, so the browser's back returns to the board before. Scrolls sideways on a phone.

export function KpiSwitch({ tabs }: { tabs: BoardSwitch[] }) {
  return (
    <nav aria-label="KPI board" className="no-scrollbar flex min-w-0 flex-1 overflow-x-auto md:flex-none">
      <div className="flex min-w-full shrink-0 rounded-full border border-line bg-surface p-1 md:min-w-0">
        {tabs.map((s) => (
          <Link key={s.id} href={s.href} prefetch aria-current={s.active ? "page" : undefined} className={`inline-flex h-10 flex-1 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full px-3 text-sm transition-colors md:h-8 md:flex-none md:px-4 ${s.active ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
            {s.id === "review" ? (
              <>
                <span className="md:hidden">Review</span>
                <span className="hidden md:inline">{s.label}</span>
              </>
            ) : (
              s.label
            )}
            {s.count != null && <span className="tabular opacity-60">{s.count}</span>}
          </Link>
        ))}
      </div>
    </nav>
  );
}
