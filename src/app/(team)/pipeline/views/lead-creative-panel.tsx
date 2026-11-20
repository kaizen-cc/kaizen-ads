import Link from "next/link";
import type { Staff } from "@/lib/auth";
import { HeadlineCard } from "@/app/(team)/board/creative-kpis";
import { leadPools, MOVED_TO_IDEAS, poolTotals, type CreativePool } from "@/lib/lead-creative-core";

// The creative leads' primary Overview (the Head of Creative, the lead graphic designer, the lead video editor): only
// the allotments (up front), the team's KPIs and video production. Nothing about ad accounts, winners or the copy
// library: those live under Ideas. Read from the Board's KPI numbers (shared and cached, src/lib/board-kpis-cache.ts).

const POOL_NAME: Record<CreativePool, string> = { images: "Design allotment", videos: "Video allotment" };

export async function LeadCreativePanel({ me }: { me: Staff }) {
  const { cachedCreativeKpis } = await import("@/lib/board-kpis-cache");
  const k = await cachedCreativeKpis("cycle").catch(() => null);
  if (!k) return null;
  const pools = leadPools(me.role);
  const live = k.allotments.filter((a) => !a.dismissed);
  const editors = k.makers.filter((m) => m.roleKey === "video_editor" || m.roleKey === "lead_video_editor");
  const videoLate = editors.flatMap((m) => m.plate.filter((p) => p.late).map((p) => ({ ...p, who: m.name })));
  const videoOpen = editors.reduce((n, m) => n + m.open, 0);
  const showVideo = pools.includes("videos");
  return (
    <section className="grid gap-5" aria-label="Allotments, KPIs and video production">
      {/* Allotments up front */}
      <div className="grid gap-3 sm:grid-cols-2">
        {pools.map((p) => {
          const t = poolTotals(live, p);
          const fill = t.cap ? Math.min(1, t.used / t.cap) : 0;
          return (
            <Link key={p} href="/board?view=kpis#allotments" className="group grid gap-3 rounded-[22px] border border-line bg-deep p-5 hover:border-ink/25">
              <span className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.18em] text-ink/50">
                {POOL_NAME[p]}
                <span className="text-ink/40 group-hover:text-fg">→</span>
              </span>
              <span className="flex items-end gap-2">
                <span className="tabular font-display text-[34px] leading-none text-fg">{t.used}</span>
                <span className="pb-1 text-[14px] text-ink/55">of {t.cap} this cycle</span>
              </span>
              <span className="h-1.5 overflow-hidden rounded-full bg-ink/10">
                <span className="block h-full rounded-full bg-fg/80" style={{ width: `${Math.round(fill * 100)}%` }} />
              </span>
              <span className={`text-[12.5px] ${t.behind ? "text-[#f2b14c]" : "text-ink/55"}`}>{t.clients ? (t.behind ? `${t.behind} of ${t.clients} clients behind where they should be by today` : `All ${t.clients} clients on pace`) : "No client has this pool"}</span>
            </Link>
          );
        })}
      </div>

      {/* The team's KPIs */}
      <div className="grid gap-3">
        <p className="flex items-center justify-between px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-ink/50">
          Team KPIs · last {k.days} days
          <Link href="/board?view=kpis" className="text-[12px] font-normal normal-case tracking-normal text-ink/55 hover:text-fg">
            All KPIs →
          </Link>
        </p>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          {k.headlines.map((h) => (
            <HeadlineCard key={h.key} h={h} />
          ))}
        </div>
      </div>

      {/* Video production */}
      {showVideo && (
        <div className="grid gap-3 rounded-[22px] border border-line bg-deep p-5">
          <p className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-ink/50">
            Video production
            <span className="text-[12px] font-normal normal-case tracking-normal text-ink/60">
              {videoOpen} in production · <span className={videoLate.length ? "text-[#ff4d5e]" : ""}>{videoLate.length} late</span>
            </span>
          </p>
          {editors.length ? (
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {editors.map((m) => (
                <li key={m.profileId ?? m.name} className="flex min-h-11 items-center justify-between gap-3 rounded-[14px] bg-ink/[0.04] px-3 py-2 text-[13px]">
                  <span className="truncate text-fg">{m.name}</span>
                  <span className="tabular shrink-0 text-ink/60">
                    {m.open} open{m.late ? <span className="text-[#ff4d5e]"> · {m.late} late</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-ink/55">No video editor is on the team yet.</p>
          )}
          {videoLate.length > 0 && (
            <ul className="grid gap-1">
              {videoLate.slice(0, 6).map((t) => (
                <li key={t.key}>
                  <Link href={t.href} target={t.external ? "_blank" : undefined} className="flex min-h-11 items-center gap-2 rounded-[12px] px-2 py-1.5 text-[13px] hover:bg-ink/[0.05]">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#ff4d5e]" />
                    <span className="min-w-0 flex-1 truncate text-fg">
                      {t.client ? `${t.client}: ` : ""}
                      {t.title}
                    </span>
                    <span className="shrink-0 text-[11.5px] text-ink/50">{t.who}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <p className="flex flex-wrap items-center gap-2 px-1 text-[12px] text-ink/50">
        Winners, tiring ads and the copy library live under Ideas:
        {MOVED_TO_IDEAS.map((l) => (
          <Link key={l.href} href={l.href} className="rounded-full border border-ink/12 px-3 py-1 text-ink/70 hover:text-fg">
            {l.label}
          </Link>
        ))}
      </p>
    </section>
  );
}
