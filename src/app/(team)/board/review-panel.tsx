"use client";

import { useEffect, useState, useTransition } from "react";
import { reviewCreative, ticketComments, type ReviewComment } from "./review-actions";
import type { Ticket } from "./types";
import { AiReviewNotes } from "./ai-review";

const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms / 1000) % 60)).padStart(2, "0")}`;

/**
 * Creative review on the ticket. The Head of Creative (or an exec) approves, which sends it to Copy and starts the copy draft,
 * or sends it back to the maker with the open comments. In production, the maker sees what to change.
 */
export function ReviewPanel({
  ticket,
  canReview,
  onMoved,
  demo = false,
}: {
  ticket: Ticket;
  canReview: boolean;
  onMoved: (stage: Ticket["stage"]) => void;
  demo?: boolean;
}) {
  const [comments, setComments] = useState<ReviewComment[] | null>(demo ? [] : null);
  const [note, setNote] = useState("");
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (demo) return;
    let live = true;
    const load = () => ticketComments(ticket.id).then((c) => live && setComments(c));
    load();
    const on = (e: Event) => (e as CustomEvent).detail === ticket.id && load();
    window.addEventListener("kz:comments", on);
    return () => {
      live = false;
      window.removeEventListener("kz:comments", on);
    };
  }, [ticket.id, demo]);

  const open = (comments ?? []).filter((c) => !c.resolved && c.round === "internal");
  const reviewing = ticket.stage === "internal_review";
  if (!reviewing && open.length === 0) return null;

  const decide = (decision: "approve" | "changes") =>
    start(async () => {
      setError(null);
      if (demo) return onMoved(decision === "approve" ? "copy" : "in_production");
      const r = await reviewCreative(ticket.id, decision, note);
      if (!r.ok) return setError(r.error);
      setNote("");
      onMoved(decision === "approve" ? "copy" : "in_production");
    });

  return (
    <section className={`grid gap-4 rounded-[12px] border p-5 ${reviewing ? "border-brand/30 bg-brand-soft/20" : "border-warn/30 bg-warn-soft/30"}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-heading text-[16px]">{reviewing ? "Creative review" : "Changes requested"}</h3>
        <span className="text-xs text-muted">
          {open.length ? `${open.length} open comment${open.length === 1 ? "" : "s"}` : "No comments yet"} · open a design above to pin one
        </span>
      </div>

      {reviewing && <AiReviewNotes ticket={ticket} demo={demo} />}

      {open.length > 0 && (
        <ol className="grid gap-1.5">
          {open.map((c) => (
            <li key={c.id} className="flex gap-2.5 rounded-[8px] bg-surface px-3 py-2 text-sm">
              <span className="shrink-0 text-xs text-faint">
                v{c.version}
                {c.tMs != null && ` · ${clock(c.tMs)}`}
                {c.x != null && " · pin"}
              </span>
              <span className="min-w-0 flex-1 leading-relaxed">{c.body}</span>
              <span className="shrink-0 text-[11px] text-faint">{c.author}</span>
            </li>
          ))}
        </ol>
      )}

      {reviewing &&
        (canReview ? (
          <div className="grid gap-3">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Overall note (optional when you've pinned comments)"
              className="rounded-[10px] border border-line bg-surface px-3.5 py-2.5 text-sm outline-none placeholder:text-faint focus:border-brand-text/60"
            />
            <div className="flex flex-wrap items-center gap-2">
              <button disabled={busy} onClick={() => decide("approve")} className="h-10 rounded-brand bg-ok px-5 text-sm font-medium text-white shadow-[0_8px_24px_-12px_rgba(47,163,122,0.9)] disabled:opacity-60">
                {busy ? "Saving…" : "Approve creative"}
              </button>
              <button disabled={busy} onClick={() => decide("changes")} className="h-10 rounded-brand border border-line bg-surface px-4 text-sm text-fg hover:border-faint disabled:opacity-60">
                Send back with changes
              </button>
              <span className="text-xs text-faint">Approving starts the copy draft for copy review.</span>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted">Waiting for the Head of Creative to review. Anyone on the team can pin comments in the meantime.</p>
        ))}
      {error && <p className="text-xs text-bad">{error}</p>}
    </section>
  );
}
