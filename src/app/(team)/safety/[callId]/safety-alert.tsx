"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { commentOnSafetyAlert, dismissSafetyAlert, reopenSafetyAlert } from "./actions";

// The alert, shared by the executives: dismiss it once for all of them (with a note on how it was resolved), open it
// again, and the comment thread at the bottom that every exec sees on this same page.

export type SafetyComment = { id: string; who: string; body: string; at: string };
export type SafetyResolution = { at: string; who: string; note: string | null } | null;

const field = "w-full resize-none rounded-[12px] border border-line bg-bg px-3.5 py-2.5 text-[15px] outline-none placeholder:text-faint focus:border-brand-text/70 md:text-sm";
const when = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

export function SafetyResolutionPanel({ callId, resolution }: { callId: string; resolution: SafetyResolution }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>) =>
    start(async () => {
      const r = await fn();
      setError(r.ok ? null : r.error);
      if (r.ok) {
        setNote("");
        router.refresh();
      }
    });
  return (
    <section className="grid gap-2.5 rounded-[18px] border border-line bg-surface p-4">
      <h2 className="text-[11px] uppercase tracking-[0.16em] text-faint">Resolution</h2>
      {resolution ? (
        <>
          <p className="text-[14px] leading-relaxed">
            <span className="text-ok">Dismissed for all executives</span> by {resolution.who}, {when(resolution.at)}.
          </p>
          {resolution.note && <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-muted">{resolution.note}</p>}
          <div>
            <button type="button" disabled={pending} onClick={() => run(() => reopenSafetyAlert(callId))} className="min-h-11 rounded-full border border-line px-4 py-2 text-sm text-muted hover:text-fg disabled:opacity-50 md:min-h-0">
              Open it again
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="text-[13.5px] text-muted">Open. Dismissing it clears the alert for every executive, so nobody else needs to worry about it.</p>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="How it was resolved (optional)" className={field} />
          <div>
            <button type="button" disabled={pending} onClick={() => run(() => dismissSafetyAlert(callId, note))} className="min-h-11 rounded-full bg-fg px-4 py-2 text-sm text-bg disabled:opacity-50 md:min-h-0">
              Dismiss alert for all execs
            </button>
          </div>
        </>
      )}
      {error && <p className="text-[12px] text-bad">{error}</p>}
    </section>
  );
}

export function SafetyComments({ callId, comments }: { callId: string; comments: SafetyComment[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const send = () =>
    start(async () => {
      const r = await commentOnSafetyAlert(callId, text);
      setError(r.ok ? null : r.error);
      if (r.ok) {
        setText("");
        router.refresh();
      }
    });
  return (
    <section className="grid gap-2">
      <h2 className="text-[11px] uppercase tracking-[0.16em] text-faint">Comments · executives only</h2>
      {comments.length > 0 ? (
        <ul className="grid gap-2">
          {comments.map((c) => (
            <li key={c.id} className="rounded-[14px] border border-line bg-surface px-3.5 py-2.5">
              <p className="text-[12px] text-faint">
                {c.who} · {when(c.at)}
              </p>
              <p className="mt-0.5 whitespace-pre-wrap text-[13.5px] leading-relaxed">{c.body}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">No comments yet.</p>
      )}
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Add a comment for the other executives" className={field} />
      <div>
        <button type="button" disabled={pending || !text.trim()} onClick={send} className="min-h-11 rounded-full border border-line px-4 py-2 text-sm text-muted hover:text-fg disabled:opacity-50 md:min-h-0">
          Comment
        </button>
      </div>
      {error && <p className="text-[12px] text-bad">{error}</p>}
    </section>
  );
}
