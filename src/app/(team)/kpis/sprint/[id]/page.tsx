import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { ActionRow, AddMove, CheckNow, CloseSprint, WatchToggle, type SprintAction } from "./sprint-parts";

export const metadata: Metadata = { title: "Optimization sprint" };
export const maxDuration = 300;

type Kpi = { value: number | null; target: number | null; spend: number; results: number; roas: boolean; label: string };
const VERDICT: Record<string, { label: string; tone: string }> = {
  started: { label: "Started", tone: "bg-surface-2 text-muted" },
  no_action: { label: "Nothing changed yet", tone: "bg-bad-soft text-bad" },
  wrong_move: { label: "Change won't help", tone: "bg-warn-soft text-warn" },
  on_track: { label: "On track", tone: "bg-ok-soft text-ok" },
  improving: { label: "Improving", tone: "bg-ok-soft text-ok" },
  worse: { label: "Getting worse", tone: "bg-bad-soft text-bad" },
  done: { label: "Back on target", tone: "bg-ok-soft text-ok" },
};
const val = (k: Kpi | null | undefined, v: number | null | undefined) => (v == null ? "—" : k?.roas ? `${Number(v).toFixed(2)}x` : `$${Number(v).toLocaleString("en-US", { maximumFractionDigits: v < 100 ? 2 : 0 })}`);
const dayOf = (iso: string) => Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 86_400_000) + 1);
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** One optimization sprint: the buyer's action list from the audit, and every check-in the system has made since. */
export default async function SprintPage({ params }: PageProps<"/kpis/sprint/[id]">) {
  const { id } = await params;
  const me = await requireStaff();
  const supabase = await createClient();
  const { data: s } = await supabase
    .from("optimization_sprints")
    .select("*, clients(name, slug), kpi_targets(label), buyer:profiles!optimization_sprints_buyer_id_fkey(full_name), starter:profiles!optimization_sprints_created_by_fkey(full_name)")
    .eq("id", id)
    .maybeSingle();
  if (!s) notFound();
  const [{ data: actions }, { data: checks }, { data: watchers }] = await Promise.all([
    supabase.from("sprint_actions").select("id, title, area, owner, \"when\", steps, why, impact, status, note, ai_note, done_at, source, watch, questions, learned, profiles!sprint_actions_done_by_fkey(full_name), adder:profiles!sprint_actions_added_by_fkey(full_name)").eq("sprint_id", id).order("sort_order"),
    supabase.from("sprint_checks").select("id, verdict, message, changes, kpi, next_check_at, created_at").eq("sprint_id", id).order("created_at", { ascending: false }).limit(60),
    (s.watcher_ids as string[]).length ? supabase.from("profiles").select("full_name").in("id", s.watcher_ids as string[]) : Promise.resolve({ data: [] }),
  ]);
  const client = s.clients as unknown as { name: string; slug: string };
  const base = s.baseline as Kpi;
  const latest = s.latest as Kpi;
  const list: SprintAction[] = (actions ?? []).map((a) => ({
    id: a.id,
    title: a.title,
    area: a.area,
    owner: a.owner,
    when: a.when,
    steps: (a.steps ?? []) as string[],
    why: a.why,
    impact: a.impact,
    status: a.status,
    note: a.note,
    aiNote: a.ai_note,
    doneAt: a.done_at,
    doneBy: (a.profiles as unknown as { full_name: string } | null)?.full_name ?? null,
    source: (a.source ?? "audit") as SprintAction["source"],
    addedBy: (a.adder as unknown as { full_name: string } | null)?.full_name ?? null,
    watch: a.watch,
    questions: (a.questions ?? []) as string[],
    learned: Boolean(a.learned),
  }));
  const counted = list.filter((a) => a.status !== "skipped");
  const done = counted.filter((a) => a.status === "done").length;
  const day = dayOf(s.started_at);
  const moved = base?.value != null && latest?.value != null && base.value ? Math.round(((latest.value - base.value) / base.value) * 100) * (base.roas ? 1 : -1) : null;
  const active = s.status === "active";
  const watching = (s.watcher_ids as string[]).includes(me.id);

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-8 pb-16">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/kpis" className="text-sm text-muted hover:text-fg">
          ← KPIs
        </Link>
        {s.audit_id && (
          <Link href={`/kpis/audit/${s.audit_id}`} className="text-sm text-muted hover:text-fg">
            The audit it came from →
          </Link>
        )}
      </div>

      <header className="grid gap-6 rounded-[24px] border border-line bg-surface p-6 md:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="grid gap-1">
            <p className="text-xs uppercase tracking-[0.18em] text-faint">
              Optimization sprint · day {day}
              {!active && ` · ${s.status === "done" ? "done" : "closed"}`}
            </p>
            <h1 className="font-display text-3xl tracking-tight md:text-4xl">
              {client.name}
              {(s.kpi_targets as unknown as { label: string | null } | null)?.label && <span className="text-muted"> · {(s.kpi_targets as unknown as { label: string }).label}</span>}
            </h1>
            <p className="text-sm text-muted">
              Owned by {(s.buyer as unknown as { full_name: string } | null)?.full_name ?? "no buyer yet"}
              {(s.starter as unknown as { full_name: string } | null)?.full_name ? ` · started by ${(s.starter as unknown as { full_name: string }).full_name}` : ""}
              {(watchers ?? []).length ? ` · watched by ${(watchers ?? []).map((w) => w.full_name).join(", ")}` : ""}
            </p>
          </div>
          {active && (
            <div className="flex flex-wrap items-center gap-2">
              <WatchToggle sprintId={id} watching={watching} />
              <CheckNow sprintId={id} next={s.next_check_at} />
            </div>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[14px] border border-line bg-line md:grid-cols-5">
          {[
            [val(base, base?.target), `Target · ${base?.label ?? ""}`],
            [val(base, base?.value), "At the start · 14 days"],
            [val(latest, latest?.value), "Now · 14 days"],
            [moved == null ? "—" : `${moved > 0 ? "+" : ""}${moved}%`, "Moved since the start"],
            [`${done}/${counted.length}`, "Actions done"],
          ].map(([v, l], i) => (
            <div key={l} className="grid gap-0.5 bg-surface px-5 py-4">
              <dd className={`font-display text-2xl tabular tracking-tight ${i === 3 && moved != null ? (moved > 0 ? "text-ok" : moved < 0 ? "text-bad" : "") : ""}`}>{v}</dd>
              <dt className="text-xs text-muted">{l}</dt>
            </div>
          ))}
        </dl>
        <div className="h-1.5 overflow-hidden rounded-full bg-line">
          <div className="h-full rounded-full bg-ok transition-[width]" style={{ width: `${counted.length ? (done / counted.length) * 100 : 0}%` }} />
        </div>
      </header>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <section className="grid content-start gap-3">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="font-heading text-xl">Action list</h2>
            <p className="text-xs text-faint">Tick moves off as you make them; the next check reads your notes</p>
          </div>
          {active && <AddMove sprintId={id} />}
          {list.length ? (
            <>
              {/* Open moves first (in progress, then to do); finished ones drop to the bottom */}
              {[...list.filter((a) => a.status === "doing"), ...list.filter((a) => a.status === "todo")].map((a) => (
                <ActionRow key={a.id} a={a} readOnly={!active} />
              ))}
              {!list.some((a) => a.status === "todo" || a.status === "doing") && <p className="rounded-[14px] border border-dashed border-line px-4 py-6 text-center text-sm text-muted">Every move is done or skipped.</p>}
              {list.some((a) => a.status === "done" || a.status === "skipped") && (
                <p className="mt-3 text-[11px] uppercase tracking-[0.16em] text-faint">
                  Done · {list.filter((a) => a.status === "done").length}
                  {list.some((a) => a.status === "skipped") ? ` · skipped ${list.filter((a) => a.status === "skipped").length}` : ""}
                </p>
              )}
              {[...list.filter((a) => a.status === "done").sort((x, y) => (y.doneAt ?? "").localeCompare(x.doneAt ?? "")), ...list.filter((a) => a.status === "skipped")].map((a) => (
                <ActionRow key={a.id} a={a} readOnly={!active} />
              ))}
            </>
          ) : (
            <p className="text-sm text-faint">Nothing on the list yet. Add moves from the audit.</p>
          )}
        </section>

        <section className="grid content-start gap-3">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="font-heading text-xl">Check-ins</h2>
            {active && <p className="text-xs text-faint">Next: {when(s.next_check_at)}</p>}
          </div>
          <ol className="grid gap-3">
            {(checks ?? []).map((c) => {
              const v = VERDICT[c.verdict] ?? VERDICT.started;
              const changes = (c.changes ?? []) as string[];
              return (
                <li key={c.id} className="grid gap-2 rounded-[16px] border border-line bg-surface p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${v.tone}`}>{v.label}</span>
                    <span className="text-[11px] text-faint">{when(c.created_at)}</span>
                  </div>
                  <p className="text-sm leading-relaxed">{c.message}</p>
                  {changes.length > 0 && (
                    <details className="text-xs text-muted">
                      <summary className="cursor-pointer text-faint hover:text-fg">
                        {changes.length} {changes.length === 1 ? "change" : "changes"} seen in the ad account
                      </summary>
                      <ul className="mt-2 grid gap-1">
                        {changes.map((x, i) => (
                          <li key={i}>· {x}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {c.next_check_at && c.verdict !== "started" && <p className="text-[11px] text-faint">Checking again {when(c.next_check_at)}</p>}
                </li>
              );
            })}
          </ol>
        </section>
      </div>

      {active ? (
        <CloseSprint sprintId={id} />
      ) : (
        <p className="text-sm text-muted">
          This sprint {s.status === "done" ? "is done" : "was closed"}
          {s.closed_at ? ` on ${when(s.closed_at)}` : ""}
          {s.close_note ? `: ${s.close_note}` : "."}
        </p>
      )}
    </div>
  );
}
