import { GapActions } from "@/components/allotment-brief-actions";
import { nextBucket } from "@/lib/creative-allotments";
import { freshBriefIdea, gapBriefIdea } from "@/lib/creative-allotments-items";
import type { AllotmentDesk } from "@/lib/creative-allotments-load";

// The Overview's "Creative allotments" (Clients tab, the creative team): each person's slice of the gaps this billing
// cycle, most urgent first ("3 videos missing · resets in 2 days", "2 this week to stay on pace"), with Suggest briefs
// and Create brief on each; the head of creative also sees this week's load across clients against a typical week, so
// the work spreads through the cycle instead of piling up before each reset. Accounts off their KPI target on these
// clients follow as "Needs fresh creative".

const POOL_LABEL = { images: "Images", videos: "Videos" } as const;

export function AllotmentGapsPanel({ data }: { data: AllotmentDesk }) {
  const open = data.gaps.filter((g) => g.missing > 0);
  const covered = data.gaps.filter((g) => !g.missing && g.state !== "nothing");
  const over = covered.filter((g) => g.over > 0).length;
  if (!data.gaps.length && !data.fresh.length) return null;
  return (
    <section id="allotments" className="grid scroll-mt-24 gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading text-xl">
          Creative allotments <span className="tabular text-[15px] text-faint">{open.length}</span>
        </h2>
        <span className="text-xs text-faint">Most urgent first: the gap over the days to each reset</span>
      </div>

      {data.load && (
        <div className="grid gap-2 sm:grid-cols-2">
          {data.load.map((w) => {
            const heavy = w.capacity != null && w.due > w.capacity;
            const fill = w.capacity ? Math.min(1, w.due / Math.max(1, w.capacity)) : 0;
            return (
              <div key={w.pool} className="grid gap-2 rounded-[18px] border border-line bg-ink/[0.025] px-4 py-3.5">
                <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">This week · {POOL_LABEL[w.pool]}</span>
                <span className="flex items-baseline gap-2">
                  <span className={`tabular font-heading text-[26px] leading-none ${heavy ? "text-bad" : "text-fg"}`}>{w.due}</span>
                  <span className="text-[13px] text-muted">{w.capacity != null ? `due · a usual week makes ${w.capacity}` : "due · no finished work on record yet"}</span>
                </span>
                {w.capacity != null && (
                  <span className="h-1.5 overflow-hidden rounded-full bg-ink/10" aria-hidden>
                    <span className={`block h-full rounded-full ${heavy ? "bg-[var(--bad)]" : "bg-[var(--brand)]"}`} style={{ width: `${Math.max(3, fill * 100)}%` }} />
                  </span>
                )}
                <span className="text-[12.5px] text-muted">{w.line}</span>
              </div>
            );
          })}
        </div>
      )}

      {open.length > 0 ? (
        <ul className="divide-y divide-line overflow-hidden rounded-[20px] border border-line bg-bg/40">
          {open.map((g) => {
            const bucket = nextBucket(g);
            const tone = g.state === "nothing" ? "text-bad" : bucket === "now" ? "text-warn" : "text-fg";
            return (
              <li key={`${g.clientId}-${g.pool}`} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:gap-4 md:px-5">
                <div className="grid min-w-0 flex-1 gap-1">
                  <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="truncate text-[15px] font-semibold text-fg">{g.client}</span>
                    <span className="rounded-full bg-ink/[0.06] px-2 py-0.5 text-[11px] text-ink/60">{POOL_LABEL[g.pool]}</span>
                  </p>
                  <p className={`text-[14px] leading-snug ${tone}`}>{g.line}</p>
                  <span className="relative mt-0.5 h-1.5 w-full max-w-[280px] overflow-hidden rounded-full bg-ink/10" aria-label={`${g.requested} of ${g.cap} requested`}>
                    <span className="block h-full rounded-full bg-[var(--brand)]" style={{ width: `${Math.min(100, (g.requested / g.cap) * 100)}%` }} />
                    <span aria-hidden className="absolute inset-y-0 w-[2px] bg-fg/50" style={{ left: `${Math.min(100, g.elapsed * 100)}%` }} />
                  </span>
                  <p className="text-[12.5px] leading-relaxed text-ink/50">
                    {g.detail} · {g.pace}
                  </p>
                </div>
                <GapActions idea={gapBriefIdea(g)} strong={bucket === "now"} />
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rounded-[16px] border border-dashed border-line px-4 py-5 text-sm text-muted">Every allotment in your slice is briefed for this cycle.</p>
      )}
      {covered.length > 0 && (
        <p className="text-[12.5px] text-faint">
          {covered.length} {covered.length === 1 ? "allotment" : "allotments"} fully briefed this cycle{over ? ` · ${over} past the allotment` : ""}
        </p>
      )}

      {data.fresh.length > 0 && (
        <div className="grid gap-2 pt-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Needs fresh creative</h3>
          <ul className="divide-y divide-line overflow-hidden rounded-[20px] border border-line bg-bg/40">
            {data.fresh.map((f) => (
              <li key={f.targetId} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:gap-4 md:px-5">
                <div className="grid min-w-0 flex-1 gap-1">
                  <span className="truncate text-[15px] font-semibold text-fg">{f.client}</span>
                  <p className="text-[13px] text-ink/60">{f.why}: new hooks and visuals to bring it back</p>
                </div>
                <GapActions idea={freshBriefIdea(f)} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
