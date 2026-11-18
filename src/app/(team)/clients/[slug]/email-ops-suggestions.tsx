"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setSuggestionOutcome, setSuggestionStatus, writeEmailSuggestions } from "../../kpis/email-ops-actions";
import { pushParams, useParam } from "@/lib/url-state";

// Campaign suggestions for an email client, tracked like creative ideas: where each came from (with the words and a
// link), where it stands (new, in motion, done, dismissed) and whether it worked once it ran. Used on the client page
// and on the email Overview. In-app tracking only: nothing is built, sent or scheduled from here.

export type SuggestionView = {
  id: string;
  clientId: string;
  clientName?: string;
  origin: "performance" | "calendar" | "slack" | "email" | "call";
  title: string;
  idea: string;
  why: string | null;
  evidence: string[];
  subjects: string[];
  sendOn: string | null;
  sourceQuote: string | null;
  sourceUrl: string | null;
  sourceAt: string | null;
  status: "new" | "in_motion" | "done" | "dismissed";
  outcome: "worked" | "not_worked" | null;
  outcomeNote: string | null;
};

const ORIGIN: Record<SuggestionView["origin"], string> = { performance: "From past sends", calendar: "On the calendar", slack: "From Slack", email: "From an email", call: "From a call" };
const FILTERS: { value: string; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "done", label: "Done" },
  { value: "dismissed", label: "Dismissed" },
  { value: "all", label: "All" },
];
const day = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });

function Card({ s, showClient, onChange }: { s: SuggestionView; showClient: boolean; onChange?: () => Promise<unknown> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [reasoning, setReasoning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (work: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      setError(null);
      const r = await work();
      if (!r.ok) setError(r.error ?? "That didn't save.");
      else {
        await onChange?.();
        router.refresh();
      }
    });
  return (
    <article className={`grid min-w-0 gap-3 rounded-[16px] border border-line bg-surface p-4 md:p-5 ${s.status === "dismissed" ? "opacity-70" : ""} ${pending ? "opacity-80" : ""}`}>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="rounded-full bg-bg px-2 py-0.5 text-fg">{ORIGIN[s.origin]}</span>
        {showClient && s.clientName && <span className="rounded-full border border-line px-2 py-0.5 text-muted">{s.clientName}</span>}
        {s.sendOn && <span className="rounded-full border border-line px-2 py-0.5 text-muted">Send by {day(s.sendOn)}</span>}
        {s.status === "in_motion" && <span className="rounded-full bg-ok-soft px-2 py-0.5 text-ok">In motion</span>}
        {s.outcome === "worked" && <span className="rounded-full bg-ok-soft px-2 py-0.5 text-ok">It worked</span>}
        {s.outcome === "not_worked" && <span className="rounded-full bg-bad-soft px-2 py-0.5 text-bad">It didn&apos;t work</span>}
      </div>
      <h3 className="font-heading text-[17px] leading-snug">{s.title}</h3>
      <p className="text-[13.5px] leading-relaxed text-muted">{s.idea}</p>
      {s.subjects.length > 0 && (
        <ul className="grid gap-1 text-[13px]">
          {s.subjects.map((x, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-faint" aria-hidden>
                {i + 1}
              </span>
              <span>{x}</span>
            </li>
          ))}
        </ul>
      )}
      {s.sourceQuote && (
        <blockquote className="grid gap-1 border-l-2 border-line pl-3 text-[12.5px] leading-relaxed text-muted">
          <span>&ldquo;{s.sourceQuote}&rdquo;</span>
          <span className="text-[11px] text-faint">
            {s.sourceAt ? `${new Date(s.sourceAt).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })} · ` : ""}
            {s.sourceUrl ? (
              <a href={s.sourceUrl} target="_blank" rel="noreferrer" className="underline-offset-2 hover:text-fg hover:underline">
                Open the source
              </a>
            ) : (
              ORIGIN[s.origin]
            )}
          </span>
        </blockquote>
      )}
      {(s.why || s.evidence.length > 0) && (
        <>
          <button type="button" onClick={() => setReasoning(!reasoning)} className="min-h-11 justify-self-start text-[11.5px] text-faint hover:text-fg md:min-h-0">
            {reasoning ? "Hide the reasoning" : "The reasoning"}
          </button>
          {reasoning && (
            <div className="grid gap-2 text-[12.5px] leading-relaxed text-muted">
              {s.why && <p>{s.why}</p>}
              <ul className="grid gap-1">
                {s.evidence.map((e, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-faint" />
                    {e}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      {s.outcomeNote && <p className="text-[12.5px] text-muted">{s.outcomeNote}</p>}
      {error && <p className="text-[12px] text-bad">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {s.status === "new" && (
          <>
            <button type="button" disabled={pending} onClick={() => run(() => setSuggestionStatus(s.id, "in_motion"))} className="min-h-11 rounded-full bg-fg px-4 text-[13px] font-medium text-bg disabled:opacity-60 md:min-h-9">
              We&apos;re on it
            </button>
            <button type="button" disabled={pending} onClick={() => run(() => setSuggestionStatus(s.id, "dismissed"))} className="min-h-11 rounded-full border border-line px-4 text-[13px] text-muted hover:text-fg disabled:opacity-60 md:min-h-9">
              Dismiss
            </button>
          </>
        )}
        {s.status === "in_motion" && (
          <>
            <button type="button" disabled={pending} onClick={() => run(() => setSuggestionStatus(s.id, "done"))} className="min-h-11 rounded-full bg-fg px-4 text-[13px] font-medium text-bg disabled:opacity-60 md:min-h-9">
              Sent
            </button>
            <button type="button" disabled={pending} onClick={() => run(() => setSuggestionStatus(s.id, "new"))} className="min-h-11 rounded-full border border-line px-4 text-[13px] text-muted hover:text-fg disabled:opacity-60 md:min-h-9">
              Not yet
            </button>
          </>
        )}
        {s.status === "done" && !s.outcome && (
          <>
            <span className="text-[12px] text-faint">Did it work?</span>
            <button type="button" disabled={pending} onClick={() => run(() => setSuggestionOutcome(s.id, "worked"))} className="min-h-11 rounded-full border border-ok/40 px-4 text-[13px] text-ok disabled:opacity-60 md:min-h-9">
              It worked
            </button>
            <button type="button" disabled={pending} onClick={() => run(() => setSuggestionOutcome(s.id, "not_worked"))} className="min-h-11 rounded-full border border-bad/40 px-4 text-[13px] text-bad disabled:opacity-60 md:min-h-9">
              It didn&apos;t
            </button>
          </>
        )}
        {s.outcome && (
          <button type="button" disabled={pending} onClick={() => run(() => setSuggestionOutcome(s.id, null))} className="min-h-11 text-[11.5px] text-faint hover:text-fg md:min-h-0">
            Change the result
          </button>
        )}
        {s.status === "dismissed" && (
          <button type="button" disabled={pending} onClick={() => run(() => setSuggestionStatus(s.id, "new"))} className="min-h-11 rounded-full border border-line px-4 text-[13px] text-muted hover:text-fg disabled:opacity-60 md:min-h-9">
            Bring it back
          </button>
        )}
      </div>
    </article>
  );
}

/** The suggestion list with its filter in the address (?sug=), and (when allowed) a button to write new ones for one client */
export function EmailOpsSuggestions({ suggestions, clientId = null, showClient = false, title = "Campaign ideas", onChange }: { suggestions: SuggestionView[]; clientId?: string | null; showClient?: boolean; title?: string; /** Called after a change, so a view that loaded the list itself (the KPI sheet) reads it again */ onChange?: () => Promise<unknown> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const filter = useParam("sug") ?? "open";
  const shown = suggestions.filter((s) => (filter === "all" ? true : filter === "open" ? s.status === "new" || s.status === "in_motion" : s.status === filter));
  const fresh = suggestions.filter((s) => s.status === "new").length;
  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-0.5">
          <h2 className="font-heading text-xl">{title}</h2>
          <p className="text-[13px] text-muted">
            From what worked in past sends, the calendar and what the client has mentioned.{fresh ? ` ${fresh} new.` : ""}
          </p>
        </div>
        {clientId && (
          <span className="flex flex-wrap items-center gap-2">
            {note && <span className="text-[11.5px] text-muted">{note}</span>}
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  setNote("Reading the sends and the calendar…");
                  const r = await writeEmailSuggestions(clientId);
                  setNote(r.ok ? (r.note ?? (r.added ? `${r.added} new idea${r.added === 1 ? "" : "s"}.` : "Nothing new this time.")) : r.error);
                  await onChange?.();
                  router.refresh();
                })
              }
              className="min-h-11 rounded-full border border-line px-4 text-[13px] text-muted hover:text-fg disabled:opacity-60 md:min-h-9"
            >
              {pending ? "Writing…" : "Suggest more"}
            </button>
          </span>
        )}
      </div>
      <div role="tablist" aria-label="Show" className="flex gap-1 overflow-x-auto">
        {FILTERS.map((f) => (
          <button key={f.value} type="button" role="tab" aria-selected={filter === f.value} onClick={() => pushParams({ sug: f.value === "open" ? null : f.value })} className={`min-h-11 shrink-0 rounded-full px-4 text-[13px] md:min-h-9 ${filter === f.value ? "bg-fg text-bg" : "border border-line text-muted hover:text-fg"}`}>
            {f.label}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="rounded-[16px] border border-dashed border-line px-5 py-8 text-center text-sm text-muted">{suggestions.length ? "Nothing in this view." : "No ideas yet. They are written weekly, or press Suggest more."}</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {shown.map((s) => (
            <Card key={s.id} s={s} showClient={showClient} onChange={onChange} />
          ))}
        </div>
      )}
    </section>
  );
}
