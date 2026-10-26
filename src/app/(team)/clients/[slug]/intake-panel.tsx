"use client";

import { useState } from "react";
import { Section } from "@/components/ui";
import type { IntakeSummary } from "@/lib/intake-format";

export type IntakeRecord = { receivedAt: string; status: string; summary: IntakeSummary | null; answers: { q: string; a: string }[]; error: string | null };

// The client's marketing intake form: the AI's read of it up top, every answer exactly as they gave it below.
// Every agent reads it as a layer of context for this client.

const given = (x: string | undefined) => Boolean(x && x.trim() && !/^not given\.?$/i.test(x.trim()));

export function IntakePanel({ intake }: { intake: IntakeRecord | null }) {
  const [all, setAll] = useState(false);
  if (!intake)
    return (
      <Section title="Marketing intake" description="What the client tells us in the marketing intake form. It arrives through Zapier and every agent reads it.">
        <p className="text-sm text-faint">No intake form yet.</p>
      </Section>
    );
  const s = intake.summary;
  const received = new Date(intake.receivedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
  const fields: [string, string | undefined][] = s
    ? [
        ["What they are", s.business],
        ["Offer", s.offer],
        ["Audience", s.audience],
        ["Where", s.locations],
        ["Goals", s.goals],
        ["Voice", s.voice],
      ]
    : [];
  const lists: [string, string[], string][] = s
    ? [
        ["Avoid", s.avoid, "text-bad"],
        ["Proof", s.proof, "text-ok"],
        ["Competitors", s.competitors, "text-muted"],
        ["Assets they have", s.assets, "text-muted"],
      ]
    : [];
  return (
    <Section
      title="Marketing intake"
      description={`What they told us in their intake form (received ${received}). Every agent reads it, and treats the offer, voice and what to avoid as rules.`}
    >
      {!s ? (
        <p className="text-sm text-muted">
          {intake.status === "failed" ? `The AI couldn't read it${intake.error ? `: ${intake.error}` : ""}. Their answers are below.` : "The AI is reading it…"}
        </p>
      ) : (
        <div className="grid gap-4">
          <dl className="grid gap-3 sm:grid-cols-2">
            {fields
              .filter(([, v]) => given(v))
              .map(([k, v]) => (
                <div key={k} className={`grid gap-0.5 ${k === "What they are" || k === "Offer" ? "sm:col-span-2" : ""}`}>
                  <dt className="text-[11px] uppercase tracking-[0.12em] text-faint">{k}</dt>
                  <dd className="text-sm leading-relaxed">{v}</dd>
                </div>
              ))}
          </dl>
          {lists.some(([, items]) => items.length) && (
            <div className="grid gap-3 sm:grid-cols-2">
              {lists
                .filter(([, items]) => items.length)
                .map(([k, items, tone]) => (
                  <div key={k} className="grid content-start gap-1 rounded-[10px] bg-bg/50 p-3">
                    <p className={`text-[11px] uppercase tracking-[0.12em] ${tone}`}>{k}</p>
                    <ul className="grid gap-0.5 text-sm">
                      {items.map((x, i) => (
                        <li key={i}>{x}</li>
                      ))}
                    </ul>
                  </div>
                ))}
            </div>
          )}
          {s.questions.length > 0 && (
            <div className="rounded-[10px] border border-warn/30 bg-warn-soft/30 p-3">
              <p className="text-[11px] uppercase tracking-[0.12em] text-warn">Still to ask them</p>
              <ul className="mt-1 grid gap-0.5 text-sm">
                {s.questions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="grid gap-2 border-t border-line pt-4">
        <button onClick={() => setAll(!all)} className="flex min-h-11 w-fit items-center gap-2 text-sm text-muted hover:text-fg md:min-h-0">
          <span className={`transition-transform ${all ? "rotate-90" : ""}`}>›</span>
          Their answers, as given <span className="text-faint">{intake.answers.length}</span>
        </button>
        {all && (
          <dl className="grid gap-3">
            {intake.answers.map((x, i) => (
              <div key={i} className="grid gap-0.5">
                <dt className="text-xs text-faint">{x.q}</dt>
                <dd className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{x.a}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </Section>
  );
}
