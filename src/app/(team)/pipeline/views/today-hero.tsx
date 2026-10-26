import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { TOPICS, type TodayItem, type TopicKey } from "@/lib/today";
import { buildSnapshot, readSnapshot } from "@/lib/today-snapshot";
import { TodayLive } from "./today-live";
import { TodayLoading } from "./today-loading";
import { HoverCard } from "@/components/hover-card";

// The way into the daily recap, at the top of the Overview: today in three numbers, a start button, a jump into any
// topic, and the person's list (what they saved for later). Built once a day (with its loading moment), then shown
// from the saved version at once and kept current in the background (src/lib/today-snapshot.ts).

const TIER_DOT: Record<string, string> = { critical: "bg-[#ff4d5e]", high: "bg-[#f2b14c]", normal: "bg-[#9aa8ff]" };

/** Where an item goes when it's clicked: its own place (the KPI card, the ticket, the client), else the recap at its topic. */
const hrefOf = (i: TodayItem) => i.action.href ?? (i.clientSlug ? `/clients/${i.clientSlug}` : `/today?topic=${i.topic}`);

/** One item in a hover summary: the client and what's up, its number, and a link straight to it. */
function Line({ i }: { i: TodayItem }) {
  return (
    <Link href={hrefOf(i)} className="grid grid-cols-[8px_minmax(0,1fr)_auto] items-start gap-2 rounded-[10px] px-2 py-1.5 hover:bg-white/[0.06]">
      <span className={`mt-1.5 h-1.5 w-1.5 rounded-full ${TIER_DOT[i.tier]}`} />
      <span className="grid min-w-0">
        <span className="truncate text-[12.5px] text-white/90">{i.title}</span>
        <span className="truncate text-[11px] text-white/45">{i.client}</span>
      </span>
      <span className="tabular pt-0.5 text-[11px] text-white/60">{i.stat.value}</span>
    </Link>
  );
}

/** A short summary of one item: what's going on, why it matters, and where to go. */
function Summary({ i }: { i: TodayItem }) {
  return (
    <>
      <p className="flex items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-white/45">
        <span className={`h-1.5 w-1.5 rounded-full ${TIER_DOT[i.tier]}`} />
        {TOPICS[i.topic].label} · {i.client}
      </p>
      <p className="text-[13.5px] font-medium leading-snug">{i.title}</p>
      <p className="text-[12.5px] leading-relaxed text-white/70">{i.story}</p>
      <p className="text-[11.5px] text-white/50">
        <span className="tabular text-white/80">{i.stat.value}</span> {i.stat.label} · {i.why}
      </p>
      <span className="flex flex-wrap gap-1.5 pt-1">
        <Link href={hrefOf(i)} className="rounded-full bg-white px-3 py-1 text-[11.5px] font-medium text-black">
          {i.action.href ? i.action.label : i.clientSlug ? "Open the client" : "Open in the recap"} →
        </Link>
        {i.alt && (
          <Link href={i.alt.href} className="rounded-full border border-white/15 px-3 py-1 text-[11.5px] text-white/75 hover:text-white">
            {i.alt.label}
          </Link>
        )}
        <Link href={`/today?topic=${i.topic}`} className="rounded-full border border-white/15 px-3 py-1 text-[11.5px] text-white/75 hover:text-white">
          In the recap
        </Link>
      </span>
    </>
  );
}

/** A few items under a heading, each a link, with the way into the rest. */
function List({ title, items, more }: { title: string; items: TodayItem[]; more: { label: string; href: string } }) {
  return (
    <>
      <p className="px-2 text-[10px] uppercase tracking-[0.16em] text-white/45">{title}</p>
      <div className="grid">
        {items.slice(0, 5).map((i) => (
          <Line key={i.key} i={i} />
        ))}
      </div>
      <Link href={more.href} className="px-2 text-[11.5px] text-white/60 hover:text-white">
        {more.label} →
      </Link>
    </>
  );
}

export async function TodayHero({ db, me }: { db: SupabaseClient; me: Staff }) {
  const snap = (await readSnapshot(db, me)) ?? (await buildSnapshot(db, me, null));
  const t = snap.today;
  const delta = snap.delta;
  const saved = t.items.filter((i) => i.state === "saved");
  const topics = [...new Set(t.items.map((i) => i.topic))] as TopicKey[];
  const criticalBy = (k: TopicKey) => t.items.filter((i) => i.topic === k && i.tier === "critical").length;
  const top = t.items[0];
  return (
    <section className="relative grid gap-5 overflow-hidden rounded-[24px] border border-line bg-[#0b0a0e] p-5 md:p-7">
      <div aria-hidden className="pointer-events-none absolute -left-24 -top-32 h-[340px] w-[340px] rounded-full blur-[110px]" style={{ background: t.counts.critical ? "rgba(200,16,46,0.45)" : "rgba(90,110,255,0.3)" }} />
      <div aria-hidden className="pointer-events-none absolute -bottom-40 right-0 h-[300px] w-[300px] rounded-full bg-[rgba(224,150,40,0.18)] blur-[120px]" />
      <div className="relative flex flex-wrap items-end justify-between gap-5">
        <div className="grid min-w-0 gap-2">
          <p className="flex flex-wrap items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-white/50">
            Your day
            {delta && (delta.handled > 0 || delta.added > 0) && (
              <span className="rounded-full bg-white/[0.07] px-2 py-0.5 text-[10.5px] font-medium normal-case tracking-normal text-white/65">
                Updated {new Date(delta.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}
                {delta.handled > 0 && <span className="text-[#5be3a5]"> · {delta.handled} handled</span>}
                {delta.added > 0 && <span className="text-[#f2b14c]"> · {delta.added} new</span>}
              </span>
            )}
            <TodayLive shown={snap.computedAt} />
          </p>
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
            <HoverCard content={<Summary i={top} />} className="max-w-xl">
              <Link href={hrefOf(top)} className="text-sm text-white/60 hover:text-white">
                First up: <span className="text-white/85 underline decoration-white/20 underline-offset-4">{top.title}</span> · {top.client}
              </Link>
            </HoverCard>
          )}
          {t.resolved.length > 0 && (
            <HoverCard
              content={
                <>
                  <p className="px-2 text-[10px] uppercase tracking-[0.16em] text-[#5be3a5]">Taken care of since you last looked</p>
                  {t.resolved.slice(0, 6).map((r) => (
                    <Link key={r.key} href="/today" className="grid gap-0.5 rounded-[10px] px-2 py-1.5 hover:bg-white/[0.06]">
                      <span className="truncate text-[12.5px] text-white/90">
                        {r.client}: {r.title}
                      </span>
                      <span className="text-[11px] text-white/55">{r.by ? `${r.by} ${r.what}` : r.what}</span>
                    </Link>
                  ))}
                  <Link href="/today" className="px-2 text-[11.5px] text-white/60 hover:text-white">
                    See them in your recap →
                  </Link>
                </>
              }
            >
              <Link href="/today" className="text-xs text-[#5be3a5] underline decoration-[#5be3a5]/30 underline-offset-4 hover:decoration-[#5be3a5]">
                {t.resolved.length} taken care of by teammates since you last looked
              </Link>
            </HoverCard>
          )}
        </div>
        <div className="flex w-full items-center gap-3 md:w-auto">
          <div className="hidden gap-4 text-right sm:flex">
            {(
              [
                ["critical", "#ff4d5e"],
                ["high", "#f2b14c"],
                ["normal", "#9aa8ff"],
              ] as const
            ).map(([k, c]) => {
              const these = t.items.filter((i) => i.tier === k);
              const name = k === "high" ? "important" : k === "normal" ? "worth a look" : k;
              const body = (
                <Link href={these[0] ? `/today?topic=${these[0].topic}` : "/today"} className="grid rounded-[10px] px-1 hover:bg-white/[0.05]">
                  <span className="font-display text-2xl tabular" style={{ color: c }}>
                    {t.counts[k]}
                  </span>
                  <span className="text-[10px] uppercase tracking-[0.14em] text-white/40">{name}</span>
                </Link>
              );
              return these.length ? (
                <HoverCard key={k} content={<List title={`${these.length} ${name}`} items={these} more={{ label: `All ${these.length} in your recap`, href: `/today?topic=${these[0].topic}` }} />}>
                  {body}
                </HoverCard>
              ) : (
                <span key={k}>{body}</span>
              );
            })}
          </div>
          <Link href="/today" className="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-full bg-white px-6 md:flex-none md:justify-start text-[15px] font-semibold text-black shadow-[0_10px_40px_-10px_rgba(255,255,255,0.4)] hover:bg-white/90">
            {t.items.length || t.resolved.length ? "Start your day" : "Open"} <span aria-hidden>→</span>
          </Link>
        </div>
      </div>

      {topics.length > 0 && (
        <div className="relative flex flex-wrap gap-2">
          <span className="w-full pr-1 text-[11px] uppercase tracking-[0.16em] text-white/40 md:w-auto md:self-center">Jump to</span>
          {topics.map((k) => {
            const these = t.items.filter((i) => i.topic === k);
            return (
              <HoverCard key={k} content={<List title={`${TOPICS[k].label} · ${TOPICS[k].blurb}`} items={these} more={{ label: `Go through all ${these.length}`, href: `/today?topic=${k}` }} />}>
                <Link href={`/today?topic=${k}`} className="flex min-h-11 items-center gap-1.5 rounded-full border border-white/15 bg-white/[0.04] px-4 py-1.5 text-sm md:min-h-0 md:px-3 md:text-xs text-white/80 hover:border-white/40 hover:text-white">
                  {criticalBy(k) > 0 && <span className="h-1.5 w-1.5 rounded-full bg-[#ff4d5e]" />}
                  {TOPICS[k].label}
                  <span className="tabular text-white/45">{these.length}</span>
                </Link>
              </HoverCard>
            );
          })}
        </div>
      )}

      {saved.length > 0 && (
        <div className="relative grid gap-2 border-t border-white/10 pt-4">
          <p className="text-[11px] uppercase tracking-[0.16em] text-white/45">Your list · saved for later</p>
          <ul className="grid gap-1.5 md:grid-cols-2">
            {saved.slice(0, 6).map((s) => (
              <li key={s.key}>
                <HoverCard content={<Summary i={s} />} className="block">
                  <Link href={hrefOf(s)} className="flex min-h-11 items-center gap-2.5 rounded-[12px] bg-white/[0.04] px-3 py-2 text-sm md:min-h-0 text-white/85 hover:bg-white/[0.08]">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TIER_DOT[s.tier]}`} />
                    <span className="min-w-0 flex-1 truncate">{s.title}</span>
                    {s.carried && <span className="shrink-0 text-[10px] text-white/45">from before</span>}
                  </Link>
                </HoverCard>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function TodayHeroSkeleton() {
  return <TodayLoading />;
}
