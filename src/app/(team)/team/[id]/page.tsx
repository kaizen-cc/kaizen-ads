import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PersonAvatar } from "@/components/person-avatar";
import { roleLabel, type TeamRole } from "@/lib/roles";
import { activityLog, duration, usageOf, type ActivityEntry } from "@/lib/activity";

// One person's activity, for execs: when they were last on, how much they use Kaizen Ads, their minutes day by day
// for the last four weeks, and everything they did, a week at a time (sign-ins, pages opened, ticket moves, reviews,
// copy, uploads, reports sent).

const DAY = 86_400_000;
/** Where the log page starts: the end of the week asked for (?before=YYYY-MM-DD), else now */
const endOf = (before?: string) => (before && /^\d{4}-\d{2}-\d{2}$/.test(before) ? new Date(`${before}T04:00:00Z`) : new Date());
const nyDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const lastDays = (n: number) => Array.from({ length: n }, (_, i) => nyDay(new Date(Date.now() - (n - 1 - i) * DAY)));
const weekBefore = (d: Date) => nyDay(new Date(d.getTime() - 7 * DAY));

const KIND: Record<ActivityEntry["kind"], { dot: string; label: string }> = {
  sign_in: { dot: "bg-ok", label: "Sign-in" },
  page: { dot: "bg-faint/60", label: "Opened" },
  ticket: { dot: "bg-brand", label: "Ticket" },
  report: { dot: "bg-[#9aa8ff]", label: "Report" },
};

export default async function PersonActivity({ params, searchParams }: PageProps<"/team/[id]">) {
  const me = await requireStaff();
  if (!me.isExec) notFound();
  const { id } = await params;
  const { before, pages } = (await searchParams) as { before?: string; pages?: string };
  const db = await createClient();
  const { data: p } = await db.from("profiles").select("id, full_name, email, role, joined_at, last_active_at, last_sign_in_at").eq("id", id).maybeSingle();
  if (!p) notFound();

  const end = endOf(before);
  const [usage, { log, perDay }, month] = await Promise.all([usageOf(db, [p]), activityLog(db, p.id, end, 7), activityLog(db, p.id, new Date(), 28)]);
  const u = usage.get(p.id)!;
  const days = lastDays(28);
  const peak = Math.max(60, ...days.map((d) => month.perDay.get(d) ?? 0));
  const showPages = pages === "1";
  const shown = showPages ? log : log.filter((e) => e.kind !== "page");
  const byDay = new Map<string, ActivityEntry[]>();
  for (const e of shown) {
    const d = nyDay(new Date(e.at));
    byDay.set(d, [...(byDay.get(d) ?? []), e]);
  }
  const pagesOpened = log.filter((e) => e.kind === "page").length;
  const qs = (o: Record<string, string | undefined>) => {
    const q = new URLSearchParams(Object.entries({ before, pages, ...o }).filter((x): x is [string, string] => Boolean(x[1])));
    return q.size ? `?${q}` : "";
  };

  return (
    <div className="mx-auto grid max-w-4xl grid-cols-[minmax(0,1fr)] gap-6 md:gap-8">
      <Link href="/settings?tab=team" className="inline-flex min-h-11 items-center justify-self-start text-xs text-muted hover:text-fg md:min-h-0 md:justify-self-stretch">
        ← Team
      </Link>
      <header className="flex flex-wrap items-center gap-4">
        <PersonAvatar name={p.full_name} />
        <div className="grid min-w-0 flex-1 gap-0.5 md:flex-none">
          <h1 className="font-heading text-[24px] leading-tight [overflow-wrap:anywhere] md:text-[28px]">{p.full_name}</h1>
          <p className="text-sm text-muted [overflow-wrap:anywhere]">
            {roleLabel(p.role as TeamRole)} · {p.email}
          </p>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 sm:gap-3">
        {[
          ["Last active", u.lastActive ? (u.lastActive === "now" ? "Now" : u.lastActive) : "Not yet"],
          ["Last sign-in", u.lastSignIn ?? "Not yet"],
          ["A week, on average", u.perWeek ?? "–"],
          ["This week", u.thisWeek ?? "–"],
        ].map(([k, v]) => (
          <div key={k} className="grid min-w-0 gap-1 rounded-[16px] border border-line bg-surface p-3.5 sm:p-4">
            <p className="text-[10px] uppercase tracking-[0.12em] text-faint sm:text-[11px] sm:tracking-[0.14em]">{k}</p>
            <p className="font-heading text-lg capitalize [overflow-wrap:anywhere] sm:text-xl">{v}</p>
          </div>
        ))}
      </section>

      <section className="grid gap-3 rounded-[18px] border border-line bg-surface p-4 sm:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 className="font-heading text-lg">Time in Kaizen Ads</h2>
          <p className="text-xs text-faint">Minutes actually in use, each day for four weeks</p>
        </div>
        <div className="flex h-28 items-end gap-1">
          {days.map((d, i) => {
            const m = month.perDay.get(d) ?? 0;
            const weekend = [0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay());
            const label = `${new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })}: ${m ? duration(m) : "none"}`;
            return (
              // Phones: tap a day to see its minutes (the title shows on hover elsewhere)
              <span key={d} tabIndex={0} aria-label={label} className="group relative flex h-full flex-1 items-end outline-none" title={label}>
                <span className={`w-full rounded-t-[3px] transition-colors ${m ? "bg-brand/70 group-hover:bg-brand group-focus:bg-brand" : weekend ? "bg-ink/[0.03]" : "bg-ink/[0.06]"}`} style={{ height: `${Math.max(m ? 6 : 3, (m / peak) * 100)}%` }} />
                <span
                  className={`pointer-events-none absolute bottom-full z-10 mb-1.5 hidden whitespace-nowrap rounded-[8px] border border-line bg-surface-2 px-2 py-1 text-[11px] text-fg shadow-lg group-focus:block md:!hidden ${i < 5 ? "left-0" : i > 22 ? "right-0" : "left-1/2 -translate-x-1/2"}`}
                >
                  {label}
                </span>
              </span>
            );
          })}
        </div>
        <p className="text-[11px] text-faint">Counted while a tab is open, in view and in use (idle for three minutes stops the clock). The record began Oct 26, 2026.</p>
      </section>

      <section className="grid gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-heading text-lg">
            Activity <span className="text-sm font-normal text-faint">{before ? `the week to ${new Date(end.getTime() - DAY).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "the last 7 days"}</span>
          </h2>
          <Link href={`/team/${p.id}${qs({ pages: showPages ? undefined : "1" })}`} className="inline-flex min-h-11 items-center text-xs text-muted hover:text-fg md:min-h-0">
            {showPages ? "Hide pages opened" : `Show pages opened (${pagesOpened})`}
          </Link>
        </div>
        {byDay.size === 0 ? (
          <p className="rounded-[14px] border border-dashed border-line px-4 py-8 text-center text-sm text-faint">Nothing recorded in this week.</p>
        ) : (
          [...byDay].map(([d, list]) => (
            <div key={d} className="grid gap-2">
              <p className="flex items-center justify-between text-[11px] uppercase tracking-[0.14em] text-faint">
                {new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" })}
                {perDay.get(d) ? <span className="normal-case tracking-normal">{duration(perDay.get(d)!)} in use</span> : null}
              </p>
              <ol className="grid divide-y divide-line rounded-[14px] border border-line bg-surface">
                {list.map((e, i) => (
                  <li key={i} className="grid grid-cols-[56px_minmax(0,1fr)] gap-3 px-4 py-2.5 text-sm">
                    <span className="tabular pt-px text-xs text-faint">{new Date(e.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}</span>
                    <span className="grid min-w-0 gap-0.5">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${KIND[e.kind].dot}`} title={KIND[e.kind].label} />
                        {e.href ? (
                          <Link href={e.href} className="truncate hover:underline">
                            {e.what}
                          </Link>
                        ) : (
                          <span className="truncate">{e.what}</span>
                        )}
                      </span>
                      {e.detail && e.kind !== "page" && <span className="line-clamp-2 pl-3.5 text-xs text-muted">{e.detail}</span>}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ))
        )}
        <div className="flex items-center justify-between gap-3 text-sm">
          <Link href={`/team/${p.id}${qs({ before: weekBefore(end) })}`} className="inline-flex min-h-11 items-center text-muted hover:text-fg md:min-h-0">
            ← The week before
          </Link>
          {before && (
            <Link href={`/team/${p.id}${qs({ before: undefined })}`} className="inline-flex min-h-11 items-center text-muted hover:text-fg md:min-h-0">
              Back to this week →
            </Link>
          )}
        </div>
      </section>
    </div>
  );
}
