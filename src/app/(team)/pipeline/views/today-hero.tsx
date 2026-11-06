import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { TOPICS, type TodayItem } from "@/lib/today";
import { rowStat, TIER_ORDER, topicGroups, type Bucket } from "@/lib/today-counts";
import { todaySnapshot } from "@/lib/today-snapshot";
import { TodayLive } from "./today-live";
import { TodayLoading } from "./today-loading";
import { HoverCard } from "@/components/hover-card";

// The way into the daily recap, at the top of the Overview: today in three numbers, a start button, a jump into any
// topic, and the person's list (what they saved for later). Built once a day (with its loading moment), then shown
// from the saved version at once and kept current in the background (src/lib/today-snapshot.ts). Every number here is
// counted the way the recap counts (src/lib/today-counts.ts): everything about one client in a topic is one look.

const TIER_DOT: Record<string, string> = { critical: "bg-[#ff4d5e]", high: "bg-[#f2b14c]", normal: "bg-[#9aa8ff]" };
const TIER_COLOR = { critical: "#ff4d5e", high: "#f2b14c", normal: "#9aa8ff" } as const;

/** Where an item goes when it's clicked: its own place (the KPI card, the ticket, the client), else the recap at its topic. */
const hrefOf = (i: TodayItem) => i.action.href ?? (i.clientSlug ? `/clients/${i.clientSlug}` : `/today?topic=${i.topic}`);

/** One client in a hover summary: what's most urgent for them (and how many more), its number, and a link straight to it. */
function Line({ b }: { b: Bucket }) {
  const i = b.items[0];
  return (
    <Link href={hrefOf(i)} className="grid grid-cols-[8px_minmax(0,1fr)_auto] items-start gap-2 rounded-[10px] px-2 py-1.5 hover:bg-ink/[0.06]">
      <span className={`mt-1.5 h-1.5 w-1.5 rounded-full ${TIER_DOT[b.tier]}`} />
      <span className="grid min-w-0">
        <span className="truncate text-[12.5px] text-ink/90">{i.title}</span>
        <span className="truncate text-[11px] text-ink/45">
          {b.client}
          {b.items.length > 1 ? ` · ${b.items.length} open` : ""}
        </span>
      </span>
      {/* Several open: the number is how many (the recap's row shows the same); one: the item's own number */}
      <span className="tabular pt-0.5 text-[11px] text-ink/60">{rowStat(b.items, i).value}</span>
    </Link>
  );
}

/** A short summary of one item: what's going on, why it matters, and where to go. */
function Summary({ i }: { i: TodayItem }) {
  return (
    <>
      <p className="flex items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-ink/45">
        <span className={`h-1.5 w-1.5 rounded-full ${TIER_DOT[i.tier]}`} />
        {TOPICS[i.topic].label} · {i.client}
      </p>
      <p className="text-[13.5px] font-medium leading-snug">{i.title}</p>
      <p className="text-[12.5px] leading-relaxed text-ink/70">{i.story}</p>
      <p className="text-[11.5px] text-ink/50">
        <span className="tabular text-ink/80">{i.stat.value}</span> {i.stat.label} · {i.why}
      </p>
      <span className="flex flex-wrap gap-1.5 pt-1">
        <Link href={hrefOf(i)} className="rounded-full bg-fg px-3 py-1 text-[11.5px] font-medium text-bg">
          {i.action.href ? i.action.label : i.clientSlug ? "Open the client" : "Open in the recap"} →
        </Link>
        {i.alt && (
          <Link href={i.alt.href} className="rounded-full border border-ink/15 px-3 py-1 text-[11.5px] text-ink/75 hover:text-fg">
            {i.alt.label}
          </Link>
        )}
        <Link href={`/today?topic=${i.topic}`} className="rounded-full border border-ink/15 px-3 py-1 text-[11.5px] text-ink/75 hover:text-fg">
          In the recap
        </Link>
      </span>
    </>
  );
}

/** A few clients under a heading, each a link, with the way into the rest. */
function List({ title, buckets, more }: { title: string; buckets: (Bucket & { topic: string })[]; more: { label: string; href: string } }) {
  return (
    <>
      <p className="px-2 text-[10px] uppercase tracking-[0.16em] text-ink/45">{title}</p>
      <div className="grid">
        {buckets.slice(0, 5).map((b) => (
          <Line key={`${b.topic}:${b.key}`} b={b} />
        ))}
      </div>
      <Link href={more.href} className="px-2 text-[11.5px] text-ink/60 hover:text-fg">
        {more.label} →
      </Link>
    </>
  );
}

export async function TodayHero({ db, me }: { db: SupabaseClient; me: Staff }) {
  const snap = await todaySnapshot(db, me);
  const t = snap.today;
  const looks = t.looks;
  const delta = snap.delta;
  const saved = t.items.filter((i) => i.state === "saved");
  // The recap's topics in its order (most critical first), each client one row: the same rows its screens show
  const groups = topicGroups(t.items);
  const rows = groups.flatMap((g) => g.buckets.map((b) => ({ ...b, topic: g.topic })));
  const first = rows.reduce<(typeof rows)[number] | null>((a, b) => (!a || b.items[0].score > a.items[0].score ? b : a), null);
  const top = first?.items[0];
  return (
    <section className="relative grid gap-5 overflow-hidden rounded-[24px] border border-line bg-deep p-5 md:p-7">
      <div aria-hidden className="pointer-events-none absolute -left-24 -top-32 h-[340px] w-[340px] rounded-full blur-[110px]" style={{ background: looks.byTier.critical ? "rgba(200,16,46,0.45)" : "rgba(90,110,255,0.3)" }} />
      <div aria-hidden className="pointer-events-none absolute -bottom-40 right-0 h-[300px] w-[300px] rounded-full bg-[rgba(224,150,40,0.18)] blur-[120px]" />
      <div className="relative flex flex-wrap items-end justify-between gap-5">
        <div className="grid min-w-0 gap-2">
          <p className="flex flex-wrap items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-ink/50">
            Your day
            {delta && (delta.handled > 0 || delta.added > 0) && (
              <span className="rounded-full bg-ink/[0.07] px-2 py-0.5 text-[10.5px] font-medium normal-case tracking-normal text-ink/65">
                Updated {new Date(delta.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}
                {delta.handled > 0 && <span className="text-[#5be3a5]"> · {delta.handled} handled</span>}
                {delta.added > 0 && <span className="text-[#f2b14c]"> · {delta.added} new</span>}
              </span>
            )}
            <TodayLive shown={snap.computedAt} />
          </p>
          <p className="font-display text-3xl leading-tight tracking-tight text-fg md:text-4xl">
            {looks.total ? (
              <>
                {looks.total} {looks.total === 1 ? "thing" : "things"}
                {looks.byTier.critical ? (
                  <>
                    , <span className="text-[#ff4d5e]">{looks.byTier.critical} critical</span>
                  </>
                ) : null}
              </>
            ) : (
              "All clear today"
            )}
          </p>
          {top && first && (
            <HoverCard content={<Summary i={top} />} className="max-w-xl">
              <Link href={hrefOf(top)} className="text-sm text-ink/60 hover:text-fg">
                First up: <span className="text-ink/85 underline decoration-ink/20 underline-offset-4">{top.title}</span> · {first.client}
                {first.items.length > 1 ? ` and ${first.items.length - 1} more for them` : ""}
              </Link>
            </HoverCard>
          )}
          {t.resolved.length > 0 && (
            <HoverCard
              content={
                <>
                  <p className="px-2 text-[10px] uppercase tracking-[0.16em] text-[#5be3a5]">Taken care of since you last looked</p>
                  {t.resolved.slice(0, 6).map((r) => (
                    <Link key={r.key} href="/today" className="grid gap-0.5 rounded-[10px] px-2 py-1.5 hover:bg-ink/[0.06]">
                      <span className="truncate text-[12.5px] text-ink/90">
                        {r.client}: {r.title}
                      </span>
                      <span className="text-[11px] text-ink/55">{r.by ? `${r.by} ${r.what}` : r.what}</span>
                    </Link>
                  ))}
                  <Link href="/today" className="px-2 text-[11.5px] text-ink/60 hover:text-fg">
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
            {TIER_ORDER.map((k) => {
              const c = TIER_COLOR[k];
              const these = rows.filter((b) => b.tier === k);
              const name = k === "high" ? "important" : k === "normal" ? "worth a look" : k;
              const body = (
                <Link href={these[0] ? `/today?topic=${these[0].topic}` : "/today"} className="grid rounded-[10px] px-1 hover:bg-ink/[0.05]">
                  <span className="font-display text-2xl tabular" style={{ color: c }}>
                    {looks.byTier[k]}
                  </span>
                  <span className="text-[10px] uppercase tracking-[0.14em] text-ink/40">{name}</span>
                </Link>
              );
              return these.length ? (
                <HoverCard key={k} content={<List title={`${these.length} ${name}`} buckets={these} more={{ label: `All ${these.length} in your recap`, href: `/today?topic=${these[0].topic}` }} />}>
                  {body}
                </HoverCard>
              ) : (
                <span key={k}>{body}</span>
              );
            })}
          </div>
          <Link href="/today" className="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-full bg-fg px-6 md:flex-none md:justify-start text-[15px] font-semibold text-bg shadow-[0_10px_40px_-10px_rgba(255,255,255,0.4)] hover:bg-ink/90">
            {looks.total || t.resolved.length ? "Start your day" : "Open"} <span aria-hidden>→</span>
          </Link>
        </div>
      </div>

      {groups.length > 0 && (
        <div className="relative flex flex-wrap gap-2">
          <span className="w-full pr-1 text-[11px] uppercase tracking-[0.16em] text-ink/40 md:w-auto md:self-center">Jump to</span>
          {groups.map(({ topic: k }) => {
            const these = rows.filter((b) => b.topic === k);
            const n = looks.byTopic[k];
            return (
              <HoverCard key={k} content={<List title={`${TOPICS[k].label} · ${TOPICS[k].blurb}`} buckets={these} more={{ label: `Go through all ${n.n}`, href: `/today?topic=${k}` }} />}>
                <Link href={`/today?topic=${k}`} className="flex min-h-11 items-center gap-1.5 rounded-full border border-ink/15 bg-ink/[0.04] px-4 py-1.5 text-sm md:min-h-0 md:px-3 md:text-xs text-ink/80 hover:border-ink/40 hover:text-fg">
                  {n.critical > 0 && <span className="h-1.5 w-1.5 rounded-full bg-[#ff4d5e]" />}
                  {TOPICS[k].label}
                  <span className="tabular text-ink/45">{n.n}</span>
                </Link>
              </HoverCard>
            );
          })}
        </div>
      )}

      {saved.length > 0 && (
        <div className="relative grid gap-2 border-t border-ink/10 pt-4">
          <p className="text-[11px] uppercase tracking-[0.16em] text-ink/45">Your list · saved for later</p>
          <ul className="grid gap-1.5 md:grid-cols-2">
            {saved.slice(0, 6).map((s) => (
              <li key={s.key}>
                <HoverCard content={<Summary i={s} />} className="block">
                  <Link href={hrefOf(s)} className="flex min-h-11 items-center gap-2.5 rounded-[12px] bg-ink/[0.04] px-3 py-2 text-sm md:min-h-0 text-ink/85 hover:bg-ink/[0.08]">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TIER_DOT[s.tier]}`} />
                    <span className="min-w-0 flex-1 truncate">{s.title}</span>
                    {s.carried && <span className="shrink-0 text-[10px] text-ink/45">from before</span>}
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
