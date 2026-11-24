import type { Metadata } from "next";
import Link from "next/link";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { mayUseRoutines, routineOf, type RoutineReport } from "@/lib/routines-core";
import { routinesOf } from "@/lib/routines";
import { RoutineToggles } from "./routine-toggles";
import { AgentDesk, type DeskDraft, type DeskStaged } from "./agent-desk";

export const metadata: Metadata = { title: "Routines" };
export const maxDuration = 120;

// Your routines (owner, Nov 24 2026): the recaps, sweeps and the nightly agent Kaizen OS runs for you at your times,
// and what each one found. Execs and leads. Spec: docs/kyle-scheduled-runs.md.

type Run = { id: string; kind: string; status: string; headline: string | null; report: RoutineReport; error: string | null; started_at: string };

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });
const TAG: Record<string, string> = { certain: "", likely: "likely", guessing: "guessing" };

export default async function RoutinesPage({ searchParams }: PageProps<"/routines">) {
  const me = await requireStaff();
  const sp = await searchParams;
  if (!mayUseRoutines(me))
    return (
      <div className="mx-auto grid max-w-xl gap-2 py-16 text-center">
        <h1 className="font-heading text-[24px]">Routines</h1>
        <p className="text-[14px] text-muted">Routines are for the executives and leads for now.</p>
      </div>
    );
  const db = await createClient();
  const runId = typeof sp.run === "string" ? sp.run : null;
  const [routines, { data: runs }, { data: desk }, { data: people }] = await Promise.all([
    routinesOf(db, me.id),
    db.from("routine_runs").select("id, kind, status, headline, report, error, started_at").eq("profile_id", me.id).order("started_at", { ascending: false }).limit(40),
    // What the nightly agent left: drafts on open items, and tasks staged for release
    db.from("agent_asks").select("id, title, detail, status, draft, staged_for").eq("owner_id", me.id).in("status", ["open", "staged"]).order("created_at", { ascending: false }).limit(200),
    db.from("profiles").select("id, full_name").eq("is_active", true),
  ]);
  const nameOf = new Map((people ?? []).map((p) => [p.id as string, p.full_name as string]));
  type D = { kind?: string; text?: string; channelId?: string | null; channelName?: string | null; to?: string | null; subject?: string | null; pdf?: string | null; sentAt?: string | null };
  const drafts: DeskDraft[] = (desk ?? [])
    .filter((i) => i.status === "open" && i.draft && ["slack", "email"].includes(String((i.draft as D).kind)) && (i.draft as D).text && !(i.draft as D).sentAt)
    .map((i) => {
      const d = i.draft as D;
      return { id: i.id as string, title: i.title as string, kind: d.kind as "slack" | "email", text: d.text ?? "", where: d.channelName ?? null, to: d.to ?? null, subject: d.subject ?? null, pdf: d.pdf ?? null, canSend: d.kind === "slack" && Boolean(d.channelId) };
    });
  const staged: DeskStaged[] = (desk ?? []).filter((i) => i.status === "staged").map((i) => ({ id: i.id as string, title: i.title as string, detail: String(i.detail ?? ""), forName: i.staged_for ? (nameOf.get(i.staged_for as string) ?? null) : null }));
  const list = (runs ?? []) as Run[];
  const open = runId ? (list.find((r) => r.id === runId) ?? null) : null;

  return (
    <div className="mx-auto grid max-w-5xl gap-7">
      <header className="grid gap-1">
        <h1 className="font-heading text-[32px] leading-tight max-md:text-[28px]">Routines</h1>
        <p className="max-w-2xl text-sm text-muted">Your recaps and sweeps, run by Kaizen OS at your times. Each one lands here and in the bell; its first line is the one thing to do first. Nothing is ever sent for you.</p>
      </header>

      {open ? (
        <article className="relative isolate grid gap-5 overflow-hidden rounded-[24px] border border-line bg-surface p-5 md:p-7">
          <span aria-hidden className="pointer-events-none absolute -left-24 -top-28 -z-10 h-72 w-72 rounded-full bg-brand/15 blur-[100px]" />
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">{routineOf(open.kind)?.label ?? open.kind} · {when(open.started_at)}</p>
            <Link href="/routines" scroll={false} className="text-xs text-muted hover:text-fg">
              All routines
            </Link>
          </div>
          {open.status === "running" ? (
            <p className="text-sm text-muted">Still running… it lands here in a minute or two.</p>
          ) : open.status === "failed" ? (
            <p className="text-sm text-bad">It didn&apos;t finish: {open.error}</p>
          ) : (
            <>
              <h2 className="font-heading text-[22px] leading-snug md:text-[26px]">{open.report.headline}</h2>
              {open.report.sections.map((s) => (
                <section key={s.title} className="grid gap-2">
                  <h3 className="text-[12px] font-semibold uppercase tracking-[0.14em] text-faint">{s.title}</h3>
                  <ul className="grid gap-1.5">
                    {s.lines.map((l, i) => (
                      <li key={i} className="flex gap-2.5 text-[14px] leading-relaxed">
                        <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                        <span className="min-w-0">
                          {l.text}
                          {l.tag && TAG[l.tag] ? <span className="ml-1.5 rounded-full bg-surface-2 px-1.5 py-px text-[10.5px] text-faint">{TAG[l.tag]}</span> : null}
                          {l.href ? (
                            <a href={l.href} target={l.href.startsWith("/") ? undefined : "_blank"} rel="noreferrer" className="ml-1.5 text-[12.5px] text-brand-text hover:underline">
                              Open ↗
                            </a>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              {open.report.failedSources?.length ? <p className="text-[12px] text-faint">Couldn&apos;t read: {open.report.failedSources.join("; ")}</p> : null}
            </>
          )}
        </article>
      ) : null}

      <AgentDesk drafts={drafts} staged={staged} />

      <RoutineToggles routines={routines} />

      <section className="grid gap-3">
        <h2 className="font-heading text-[20px]">Latest</h2>
        {list.length ? (
          <ul className="grid gap-2">
            {list.map((r) => (
              <li key={r.id}>
                <Link href={`/routines?run=${r.id}`} scroll={false} className={`grid min-h-11 gap-0.5 rounded-[16px] border px-4 py-3 transition-colors hover:border-faint ${r.id === runId ? "border-brand/40 bg-brand/5" : "border-line bg-surface"}`}>
                  <span className="flex flex-wrap items-baseline gap-x-2 text-[12px] text-faint">
                    <span className="font-medium text-muted">{routineOf(r.kind)?.label ?? r.kind}</span>
                    {when(r.started_at)}
                    {r.status !== "done" ? <span className={r.status === "failed" ? "text-bad" : ""}>· {r.status === "failed" ? "didn't finish" : "running"}</span> : null}
                  </span>
                  <span className="line-clamp-2 text-[14px]">{r.headline ?? "…"}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-[16px] border border-dashed border-line px-4 py-6 text-center text-sm text-faint">Nothing has run yet. Turn a routine on above, or run one now.</p>
        )}
      </section>
    </div>
  );
}
