import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { loadToday, TOPICS, type TopicKey } from "@/lib/today";

// The way into the daily recap, at the top of the Overview: today in three numbers, a start button, a jump into any
// topic, and the person's list (what they saved for later). Streams in after the rest of the page.

export async function TodayHero({ db, me }: { db: SupabaseClient; me: Staff }) {
  const t = await loadToday(db, me);
  const saved = t.items.filter((i) => i.state === "saved");
  const topics = [...new Set(t.items.map((i) => i.topic))] as TopicKey[];
  const criticalBy = (k: TopicKey) => t.items.filter((i) => i.topic === k && i.tier === "critical").length;
  const top = t.items[0];
  return (
    <section className="relative grid gap-5 overflow-hidden rounded-[24px] border border-line bg-[#0b0a0e] p-5 md:p-7">
      <div aria-hidden className="pointer-events-none absolute -left-24 -top-32 h-[340px] w-[340px] rounded-full blur-[110px]" style={{ background: t.counts.critical ? "rgba(200,16,46,0.45)" : "rgba(90,110,255,0.3)" }} />
      <div aria-hidden className="pointer-events-none absolute -bottom-40 right-0 h-[300px] w-[300px] rounded-full bg-[rgba(224,150,40,0.18)] blur-[120px]" />
      <div className="relative flex flex-wrap items-end justify-between gap-5">
        <div className="grid gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/50">Your day</p>
          <p className="font-display text-3xl leading-tight tracking-tight text-white md:text-4xl">
            {t.items.length ? (
              <>
                {t.items.length} things{t.counts.critical ? (
                  <>
                    , <span className="text-[#ff4d5e]">{t.counts.critical} critical</span>
                  </>
                ) : null}
              </>
            ) : (
              "All clear today"
            )}
          </p>
          {top && (
            <p className="max-w-xl text-sm text-white/60">
              First up: <span className="text-white/85">{top.title}</span> · {top.client}
            </p>
          )}
          {t.resolved.length > 0 && <p className="text-xs text-[#5be3a5]">{t.resolved.length} taken care of by teammates since you last looked</p>}
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden gap-4 text-right sm:flex">
            {(
              [
                ["critical", "#ff4d5e"],
                ["high", "#f2b14c"],
                ["normal", "#9aa8ff"],
              ] as const
            ).map(([k, c]) => (
              <span key={k} className="grid">
                <span className="font-display text-2xl tabular" style={{ color: c }}>
                  {t.counts[k]}
                </span>
                <span className="text-[10px] uppercase tracking-[0.14em] text-white/40">{k === "high" ? "important" : k === "normal" ? "worth a look" : k}</span>
              </span>
            ))}
          </div>
          <Link href="/today" className="inline-flex h-12 items-center gap-2 rounded-full bg-white px-6 text-[15px] font-semibold text-black shadow-[0_10px_40px_-10px_rgba(255,255,255,0.4)] hover:bg-white/90">
            {t.items.length || t.resolved.length ? "Start your day" : "Open"} <span aria-hidden>→</span>
          </Link>
        </div>
      </div>

      {topics.length > 0 && (
        <div className="relative flex flex-wrap gap-2">
          <span className="self-center pr-1 text-[11px] uppercase tracking-[0.16em] text-white/40">Jump to</span>
          {topics.map((k) => (
            <Link key={k} href={`/today?topic=${k}`} className="flex items-center gap-1.5 rounded-full border border-white/15 bg-white/[0.04] px-3 py-1.5 text-xs text-white/80 hover:border-white/40 hover:text-white">
              {criticalBy(k) > 0 && <span className="h-1.5 w-1.5 rounded-full bg-[#ff4d5e]" />}
              {TOPICS[k].label}
              <span className="tabular text-white/45">{t.items.filter((i) => i.topic === k).length}</span>
            </Link>
          ))}
        </div>
      )}

      {saved.length > 0 && (
        <div className="relative grid gap-2 border-t border-white/10 pt-4">
          <p className="text-[11px] uppercase tracking-[0.16em] text-white/45">Your list · saved for later</p>
          <ul className="grid gap-1.5 md:grid-cols-2">
            {saved.slice(0, 6).map((s) => (
              <li key={s.key}>
                <Link href={`/today?topic=${s.topic}`} className="flex items-center gap-2.5 rounded-[12px] bg-white/[0.04] px-3 py-2 text-sm text-white/85 hover:bg-white/[0.08]">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.tier === "critical" ? "bg-[#ff4d5e]" : s.tier === "high" ? "bg-[#f2b14c]" : "bg-[#9aa8ff]"}`} />
                  <span className="min-w-0 flex-1 truncate">{s.title}</span>
                  {s.carried && <span className="shrink-0 text-[10px] text-white/45">from before</span>}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function TodayHeroSkeleton() {
  return <div className="h-[170px] animate-pulse rounded-[24px] border border-line bg-[#0b0a0e]" />;
}
