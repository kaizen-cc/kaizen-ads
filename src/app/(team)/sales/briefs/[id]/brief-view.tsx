"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { CallButton } from "@/components/call-button";
import type { CallBrief } from "@/lib/sales-briefs-core";
import { refreshBriefAction } from "../actions";

// A sales call brief, read in two minutes before the call: who they are and what they want, the booking's answers,
// fit and the Kaizen services that match, likely objections, the questions to ask, proof, the next step. Execs and
// leads get "Talk to the Sales agent" (a call or chat already loaded with this prospect) and the prospect's page.

type Row = { id: string; title: string; startsAt: string; endsAt: string | null; status: string; link: string | null; guests: { email: string; name: string | null }[]; error: string | null; madeAt: string | null };

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid min-w-0 gap-3 rounded-[20px] border border-line bg-surface p-4 md:p-6">
      <h2 className="text-[11px] font-medium uppercase tracking-[0.16em] text-faint">{title}</h2>
      {children}
    </section>
  );
}

const Bullets = ({ items, numbered = false }: { items: string[]; numbered?: boolean }) => (
  <ol className="grid gap-2">
    {items.map((x, i) => (
      <li key={i} className="flex min-w-0 gap-2.5 text-[14.5px] leading-relaxed">
        <span className={`mt-0.5 shrink-0 ${numbered ? "w-5 text-right font-medium tabular-nums text-brand-text" : "mt-[9px] h-1.5 w-1.5 rounded-full bg-brand"}`} aria-hidden>
          {numbered ? `${i + 1}.` : ""}
        </span>
        <span className="min-w-0 break-words">{x}</span>
      </li>
    ))}
  </ol>
);

export function BriefView({ row, brief, prospect, runner, mine, sells }: { row: Row; brief: (CallBrief & { business: string; site: string | null }) | null; prospect: { id: string; name: string; website: string | null; status: string } | null; runner: string | null; mine: boolean; sells: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const business = brief?.business ?? row.title;
  const refresh = () =>
    start(async () => {
      setError(null);
      const r = await refreshBriefAction(row.id);
      if (!r.ok) setError(r.error);
      else router.refresh();
    });
  return (
    <div className="mx-auto grid w-full min-w-0 max-w-[900px] gap-5 pb-12">
      {prospect && (
        <Link href={`/sales/${prospect.id}`} className="inline-flex min-h-11 w-fit items-center gap-1.5 text-[13px] text-muted hover:text-fg md:min-h-0">
          <span aria-hidden>←</span> {prospect.name}
        </Link>
      )}
      <header className="grid min-w-0 gap-2">
        <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-faint">Sales call brief{row.status === "cancelled" ? " · cancelled" : row.status === "done" ? " · call over" : ""}</p>
        <h1 className="break-words font-heading text-[28px] leading-tight md:text-[34px]">{business}</h1>
        <p className="break-words text-[14px] text-muted">
          {when(row.startsAt)}
          {runner ? ` · ${mine ? "you run it" : `${runner} runs it`}` : ""}
          {row.guests.length ? ` · with ${row.guests.map((g) => g.name || g.email).join(", ")}` : ""}
        </p>
        <div className="grid grid-cols-1 gap-2 pt-1 sm:flex sm:flex-wrap sm:items-center">
          {sells && prospect && <CallButton roleKey="sales" context={{ screen: "a sales call brief", client: prospect.name, prospectId: prospect.id }} label="Talk to the Sales agent" className="justify-center border-brand/40 text-fg" />}
          {row.link && (
            <a href={row.link} target="_blank" rel="noopener noreferrer" className="inline-flex h-11 items-center justify-center rounded-full border border-line px-4 text-[14px] text-fg hover:bg-surface-2 md:h-9 md:text-[13px]">
              Calendar event ↗
            </a>
          )}
          {brief?.site && (
            <a href={brief.site} target="_blank" rel="noopener noreferrer" className="inline-flex h-11 items-center justify-center rounded-full border border-line px-4 text-[14px] text-fg hover:bg-surface-2 md:h-9 md:text-[13px]">
              Their site ↗
            </a>
          )}
          <button type="button" onClick={refresh} disabled={pending} className="inline-flex h-11 items-center justify-center gap-2 rounded-full border border-line px-4 text-[14px] text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-60 md:h-9 md:text-[13px]">
            {pending && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current/30 border-t-current" aria-hidden />}
            {pending ? "Rewriting… (a minute or two)" : brief ? "Refresh the brief" : "Write it now"}
          </button>
        </div>
        {sells && prospect && <p className="text-[12.5px] text-faint">Talk to the Sales agent: it already has this brief, the research and the pipeline record. Ask what else it can find, how to open, the offer it would make, or role-play the call.</p>}
        {error && <p className="text-[13px] text-bad">{error}</p>}
      </header>

      {!brief ? (
        <Block title="Brief">
          <p className="text-[14px] leading-relaxed text-muted">{row.status === "failed" ? `It couldn't be written: ${row.error ?? "unknown error"}.` : "It's written 18 hours before the call (or as soon as a later booking comes in)."}</p>
        </Block>
      ) : (
        <>
          <Block title="Who they are">
            <p className="break-words text-[15.5px] leading-relaxed">{brief.who}</p>
            {brief.they_want && (
              <div className="grid gap-1 rounded-[14px] bg-brand-soft p-4">
                <p className="text-[12px] font-medium text-brand-text">What they said they want</p>
                <p className="break-words text-[15px] leading-relaxed">{brief.they_want}</p>
              </div>
            )}
            {brief.prior_contact && <p className="break-words text-[13.5px] leading-relaxed text-muted">Earlier contact: {brief.prior_contact}</p>}
            {brief.in_motion && <p className="break-words text-[13px] text-warn">Already in motion: {brief.in_motion}</p>}
          </Block>

          {brief.booking.length > 0 && (
            <Block title="Their booking answers">
              <dl className="grid min-w-0 gap-2">
                {brief.booking.map((b, i) => (
                  <div key={i} className="grid min-w-0 gap-0.5 rounded-[14px] bg-bg p-3">
                    <dt className="break-words text-[12px] font-medium text-faint">{b.q}</dt>
                    <dd className="break-words text-[14px]">{b.a}</dd>
                  </div>
                ))}
              </dl>
            </Block>
          )}

          <div className="grid min-w-0 gap-5 md:grid-cols-2">
            <Block title={`Fit${brief.fit.score != null ? ` · ${brief.fit.score}/100` : ""}`}>
              <p className="break-words text-[14px] leading-relaxed">{brief.fit.why || "Not enough known yet."}</p>
            </Block>
            <Block title="Next step to offer">
              <p className="break-words text-[14px] leading-relaxed">{brief.next_step || "Decide on the call."}</p>
            </Block>
          </div>

          {brief.services.length > 0 && (
            <Block title="Kaizen services that match">
              <ul className="grid gap-2">
                {brief.services.map((s, i) => (
                  <li key={i} className="grid min-w-0 gap-1 rounded-[14px] border border-line p-3">
                    <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
                      <span className="break-words text-[14px] font-medium">{s.service}</span>
                      {s.price && <span className="text-[13px] tabular-nums text-muted">{s.price}</span>}
                    </div>
                    <p className="break-words text-[13.5px] leading-relaxed text-muted">{s.why}</p>
                  </li>
                ))}
              </ul>
            </Block>
          )}

          {brief.discovery_questions.length > 0 && (
            <Block title="Questions to ask">
              <Bullets items={brief.discovery_questions} numbered />
            </Block>
          )}

          {brief.objections.length > 0 && (
            <Block title="Likely objections">
              {brief.objections.map((o, i) => (
                <div key={i} className="grid min-w-0 gap-1 rounded-[14px] bg-bg p-3 text-[14px] leading-relaxed">
                  <p className="break-words font-medium">&ldquo;{o.objection}&rdquo;</p>
                  <p className="break-words text-muted">{o.answer}</p>
                </div>
              ))}
            </Block>
          )}

          {brief.pitch_ideas.length > 0 && (
            <Block title="Ways to open">
              <Bullets items={brief.pitch_ideas} />
            </Block>
          )}

          {brief.proof.length > 0 && (
            <Block title="Proof (internal: by industry, never by client name)">
              <Bullets items={brief.proof} />
            </Block>
          )}

          {brief.watch_outs.length > 0 && (
            <Block title="Watch outs">
              <Bullets items={brief.watch_outs} />
            </Block>
          )}
        </>
      )}
    </div>
  );
}
