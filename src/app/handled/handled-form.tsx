"use client";

import { useState, useTransition } from "react";
import { Combobox, type ComboOption } from "@/components/combobox";
import type { NoticeView } from "@/lib/notice-resolve";
import { pushParams, useParam } from "@/lib/url-state";
import { submitHandled } from "./actions";
import type { Ref } from "./who";

// One item, two ways to close it: it's handled (a tap), or what's missing, typed, with the client when it wasn't
// known. The context is checked at once; it closes if it shows the thing is taken care of.

export function HandledForm({ refx, mode: first, view, clients }: { refx: Ref; mode: "done" | "context"; view: NoticeView; clients: ComboOption[] }) {
  const mode = (useParam("do") ?? first) === "context" ? "context" : "done";
  const [text, setText] = useState("");
  const [client, setClient] = useState<string | null>(view.clientId);
  const [result, setResult] = useState<{ closed: boolean; message: string } | null>(view.open ? null : { closed: true, message: view.closedAs ?? "It's closed." });
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const send = (how: "done" | "context") =>
    start(async () => {
      setError(null);
      const r = await submitHandled(refx, how, text, client !== view.clientId ? client : null);
      if (!r.ok) setError(r.error);
      else {
        setResult({ closed: r.closed, message: r.message });
        if (!r.closed) setText("");
      }
    });

  if (result?.closed)
    return (
      <div className="grid gap-3" aria-live="polite">
        <span className="grid h-11 w-11 place-items-center rounded-full bg-ok-soft text-ok" aria-hidden>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 13l4 4L19 7" />
          </svg>
        </span>
        <h1 className="font-heading text-[22px] leading-tight">{view.open ? "Closed" : "Already closed"}</h1>
        <p className="text-[15px] leading-snug text-muted">{view.title}</p>
        <p className="text-sm leading-relaxed text-fg">{result.message}</p>
      </div>
    );

  return (
    <div className="grid gap-5">
      <header className="grid gap-1.5">
        <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-faint">{view.kind === "said" ? "A promise" : "A message waiting on a reply"}{view.client ? ` · ${view.client}` : ""}</p>
        <h1 className="font-heading text-[21px] leading-tight [overflow-wrap:anywhere]">{view.title}</h1>
        <p className="text-sm leading-relaxed text-muted [overflow-wrap:anywhere]">{view.detail}</p>
      </header>

      <div role="tablist" aria-label="What happened" className="grid grid-cols-2 gap-1 rounded-full border border-line bg-bg p-1">
        {(
          [
            ["done", "It's handled"],
            ["context", "Add context"],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={mode === k} onClick={() => pushParams({ do: k })} className={`h-11 rounded-full text-sm transition-colors md:h-9 ${mode === k ? "bg-fg font-medium text-bg" : "text-muted hover:text-fg"}`}>
            {label}
          </button>
        ))}
      </div>

      {mode === "done" ? (
        <div className="grid gap-3">
          <p className="text-sm leading-relaxed text-muted">It closes now, comes off everyone&apos;s notices{view.kind === "said" ? ", and anyone it went up to hears it's handled" : ", and anyone it went up to hears it's taken care of"}.</p>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="How, if you'd like to say (optional)" className="w-full resize-none rounded-[12px] border border-line bg-bg px-3.5 py-3 text-[15px] placeholder:text-faint focus:border-fg/40 focus:outline-none" />
          <button type="button" disabled={busy} onClick={() => send("done")} className="h-12 w-full rounded-brand bg-brand px-4 text-[15px] font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-60">
            {busy ? "Closing…" : "It's handled"}
          </button>
        </div>
      ) : (
        <div className="grid gap-3">
          <label className="grid gap-1.5 text-xs font-medium text-muted">
            What&apos;s missing
            <textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={4}
              placeholder={view.kind === "said" ? "Onboarding started Nov 2, the client is Crust Pizza Gleannloch" : "Answered on a call this morning"}
              className="w-full resize-none rounded-[12px] border border-line bg-bg px-3.5 py-3 text-[15px] font-normal text-fg placeholder:text-faint focus:border-fg/40 focus:outline-none"
            />
          </label>
          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-muted">Client{view.clientId ? "" : " (we couldn't tell which)"}</span>
            <Combobox label="Client" options={clients} value={client} onChange={setClient} placeholder="Pick the client" />
          </div>
          {view.notes.length > 0 && (
            <ul className="grid gap-1.5 border-t border-line pt-3">
              {view.notes.slice(-3).map((n, i) => (
                <li key={i} className="text-xs leading-relaxed text-faint">
                  <span className="text-muted">{n.by}:</span> {n.text}
                </li>
              ))}
            </ul>
          )}
          <button type="button" disabled={busy || (!text.trim() && client === view.clientId)} onClick={() => send("context")} className="h-12 w-full rounded-brand bg-fg px-4 text-[15px] font-medium text-bg transition-opacity disabled:opacity-50">
            {busy ? "Checking…" : "Save and check"}
          </button>
          <p className="text-xs text-faint">It&apos;s read with everything else we can see. If that shows it&apos;s handled, it closes.</p>
        </div>
      )}

      {result && !result.closed && <p className="rounded-[12px] bg-warn-soft px-3.5 py-3 text-sm leading-relaxed text-warn" aria-live="polite">{result.message}</p>}
      {error && <p className="rounded-[12px] bg-bad-soft px-3.5 py-3 text-sm text-bad">{error}</p>}
    </div>
  );
}
