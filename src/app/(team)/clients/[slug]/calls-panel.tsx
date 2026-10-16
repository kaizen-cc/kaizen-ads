"use client";

import Link from "next/link";
import { useState } from "react";
import { Section } from "@/components/ui";

export type ClientCall = {
  id: string;
  source: "gemini" | "fireflies";
  title: string;
  at: string;
  url: string | null;
  status: string;
  summary: { summary: string; clientSaid: string[]; decisions: string[] } | null;
  commitments: { id: string; kind: string; what: string; status: string; requestNumbers: number[] }[];
};

// The client's calls, from Gemini and Fireflies notes: what was said, what was decided, and what we promised (with
// where each promise stands). The briefing and every agent read them too.

const STATUS: Record<string, { label: string; tone: string }> = {
  open: { label: "Watching", tone: "bg-surface-2 text-muted" },
  in_motion: { label: "In motion", tone: "bg-ok-soft text-ok" },
  done: { label: "Done", tone: "bg-ok-soft text-ok" },
  briefed: { label: "Brief waiting on Home", tone: "bg-warn-soft text-warn" },
  dismissed: { label: "Not needed", tone: "bg-surface-2 text-faint" },
};

export function CallsPanel({ calls }: { calls: ClientCall[] }) {
  const [open, setOpen] = useState<string | null>(calls[0]?.id ?? null);
  return (
    <Section title="Calls" description="From Gemini and Fireflies notes. Promises made on a call are watched: if nothing's in motion two business days later, a brief from the call goes to Home.">
      {calls.length === 0 ? (
        <p className="text-sm text-faint">No calls yet. They appear here when Gemini or Fireflies notes come in for this client.</p>
      ) : (
        <div className="grid gap-2">
          {calls.map((c) => {
            const isOpen = open === c.id;
            const waiting = c.commitments.filter((x) => x.status === "briefed").length;
            return (
              <div key={c.id} className="rounded-[12px] border border-line bg-bg/40">
                <button onClick={() => setOpen(isOpen ? null : c.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{c.title}</span>
                    <span className="block text-[11px] text-faint">
                      {new Date(c.at).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" })} · {c.source === "gemini" ? "Gemini notes" : "Fireflies"}
                      {c.commitments.length ? ` · ${c.commitments.length} ${c.commitments.length === 1 ? "promise" : "promises"}` : ""}
                    </span>
                  </span>
                  {waiting > 0 && <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[11px] text-warn">{waiting} waiting</span>}
                  <span className={`text-faint transition-transform ${isOpen ? "rotate-90" : ""}`}>›</span>
                </button>
                {isOpen && (
                  <div className="grid gap-3 border-t border-line px-4 py-3">
                    {c.summary ? (
                      <>
                        <p className="text-sm leading-relaxed">{c.summary.summary}</p>
                        {c.summary.clientSaid.length > 0 && (
                          <div>
                            <p className="text-[11px] uppercase tracking-[0.12em] text-faint">The client said</p>
                            <ul className="mt-1 grid gap-0.5 text-sm text-muted">
                              {c.summary.clientSaid.map((x, i) => (
                                <li key={i}>{x}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {c.summary.decisions.length > 0 && (
                          <div>
                            <p className="text-[11px] uppercase tracking-[0.12em] text-faint">Decided</p>
                            <ul className="mt-1 grid gap-0.5 text-sm text-muted">
                              {c.summary.decisions.map((x, i) => (
                                <li key={i}>{x}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </>
                    ) : (
                      <p className="text-sm text-faint">{c.status === "failed" ? "Couldn't read these notes." : "Reading the notes…"}</p>
                    )}
                    {c.commitments.length > 0 && (
                      <div className="grid gap-1.5">
                        <p className="text-[11px] uppercase tracking-[0.12em] text-faint">We promised</p>
                        {c.commitments.map((x) => {
                          const st = STATUS[x.status] ?? STATUS.open;
                          return (
                            <div key={x.id} className="flex flex-wrap items-start gap-2 text-sm">
                              <span className="min-w-0 flex-1">{x.what}</span>
                              {x.requestNumbers.map((n) => (
                                <Link key={n} href={`/board?t=${n}`} className="rounded-full border border-line px-2 py-0.5 text-[11px] hover:border-faint">
                                  #{n}
                                </Link>
                              ))}
                              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${st.tone}`}>{st.label}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {c.url && (
                      <a href={c.url} target="_blank" rel="noreferrer" className="w-fit text-xs text-muted hover:text-fg">
                        Open the full notes ↗
                      </a>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}
