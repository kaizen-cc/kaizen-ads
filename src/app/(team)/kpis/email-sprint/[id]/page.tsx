import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import type { ScoreSnapshot } from "@/lib/email-ops/sprint-core";
import { createClient } from "@/lib/supabase/server";
import { EmailChecks } from "../../email-checks";
import { SprintControls, SprintMove } from "../../email-ops-parts";

export const metadata: Metadata = { title: "Email sprint" };

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
const VERDICT: Record<string, { label: string; tone: string }> = {
  started: { label: "Started", tone: "text-muted" },
  no_action: { label: "Waiting on you", tone: "text-warn" },
  on_track: { label: "On track", tone: "text-muted" },
  improving: { label: "Improving", tone: "text-ok" },
  worse: { label: "Slipping", tone: "text-bad" },
  done: { label: "Back in the green", tone: "text-ok" },
};

/** One email sprint: the audit's moves with where each stands, the score now against the start, and every check */
export default async function EmailSprintPage({ params }: PageProps<"/kpis/email-sprint/[id]">) {
  const { id } = await params;
  await requireStaff();
  const supabase = await createClient();
  const { data: s } = await supabase.from("email_sprints").select("id, client_id, audit_id, status, baseline, latest, next_check_at, last_check_at, started_at, closed_at, close_note, clients(name, slug), profiles!email_sprints_owner_id_fkey(full_name)").eq("id", id).maybeSingle();
  if (!s) notFound();
  const client = s.clients as unknown as { name: string; slug: string };
  const owner = (s.profiles as unknown as { full_name: string } | null)?.full_name ?? null;
  const [{ data: actions }, { data: checks }] = await Promise.all([
    supabase.from("email_sprint_actions").select("id, title, owner, steps, why, impact, status, note, ai_note, when").eq("sprint_id", id).order("sort_order"),
    supabase.from("email_sprint_checks").select("id, verdict, message, score, created_at").eq("sprint_id", id).order("created_at", { ascending: false }).limit(12),
  ]);
  const base = s.baseline as ScoreSnapshot | Record<string, never>;
  const latest = s.latest as ScoreSnapshot | Record<string, never>;
  const hasBase = "score" in base;
  const hasLatest = "score" in latest;
  const delta = hasBase && hasLatest ? latest.score - base.score : null;
  const list = (actions ?? []) as { id: string; title: string; owner: string | null; steps: string[]; why: string | null; impact: string | null; status: "todo" | "doing" | "done" | "skipped"; note: string | null; ai_note: string | null; when: string | null }[];
  const doneCount = list.filter((x) => x.status === "done").length;
  const active = s.status === "active";

  return (
    <div className="mx-auto grid w-full min-w-0 max-w-5xl gap-8 pb-16">
      <Link href={`/clients/${client.slug}`} className="inline-flex min-h-11 w-fit items-center text-xs text-muted hover:text-fg md:min-h-0">
        ← {client.name}
      </Link>

      <header className="grid gap-5 rounded-[28px] border border-line bg-surface px-5 py-6 md:px-10 md:py-9">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs uppercase tracking-[0.2em] text-faint">
            Email sprint · {client.name} · since {day(s.started_at as string)}
            {owner ? ` · ${owner}` : ""}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {s.audit_id && (
              <Link href={`/kpis/email-audit/${s.audit_id}`} className="grid min-h-11 place-items-center rounded-full border border-line px-4 text-[13px] text-muted hover:text-fg md:min-h-9">
                The audit
              </Link>
            )}
            <SprintControls sprintId={s.id as string} active={active} />
          </div>
        </div>
        <div className="grid gap-1">
          <h1 className="font-heading text-[22px] leading-snug md:text-[28px]">{active ? "Following the plan to done" : s.status === "done" ? "This sprint is done" : "This sprint is closed"}</h1>
          <p className="text-[15px] leading-relaxed text-muted">
            {active ? `Next check ${day(s.next_check_at as string)}. ` : s.close_note ? `${s.close_note}. ` : ""}
            {doneCount} of {list.length} moves done.
          </p>
        </div>
        <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-[16px] border border-line bg-line">
          {[
            [hasBase ? String(base.score) : "?", "Score at the start"],
            [hasLatest ? String(latest.score) : "?", "Score now"],
            [delta == null ? "?" : `${delta > 0 ? "+" : ""}${delta}`, "Change"],
          ].map(([n, label]) => (
            <div key={label} className="flex min-w-0 flex-col gap-1 bg-surface/90 px-4 py-4 md:px-5">
              <dd className="font-display text-2xl tabular tracking-tight md:text-3xl">{n}</dd>
              <dt className="text-xs text-muted">{label}</dt>
            </div>
          ))}
        </dl>
        {hasLatest && <EmailChecks checks={latest.checks} />}
      </header>

      <section className="grid gap-3">
        <h2 className="font-heading text-xl">The moves</h2>
        {list.length === 0 && <p className="text-sm text-muted">No moves on this sprint yet.</p>}
        {list.map((x) => (
          <SprintMove key={x.id} id={x.id} title={x.title} owner={x.owner} steps={x.steps ?? []} why={x.why} impact={x.impact} status={x.status} note={x.note} aiNote={x.ai_note} />
        ))}
      </section>

      <section className="grid gap-3">
        <h2 className="font-heading text-xl">Checks</h2>
        <ol className="grid gap-3">
          {(checks ?? []).map((c) => {
            const v = VERDICT[c.verdict as string] ?? VERDICT.on_track;
            const sc = (c.score as ScoreSnapshot | Record<string, never>) ?? {};
            return (
              <li key={c.id as string} className="grid gap-1 rounded-[16px] border border-line bg-surface p-4">
                <p className="flex flex-wrap items-baseline gap-x-3 text-[12px] text-faint">
                  <span>{day(c.created_at as string)}</span>
                  <span className={v.tone}>{v.label}</span>
                  {"score" in sc && <span className="tabular">score {sc.score}</span>}
                </p>
                <p className="text-[14px] leading-relaxed">{c.message as string}</p>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
