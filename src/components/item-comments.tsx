"use client";

import { useVisualViewport } from "@/lib/use-visual-viewport";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { commentOnItem, itemThread } from "@/app/(team)/comment-actions";
import type { ItemThread } from "@/lib/item-comments";
import { closeParams, pushParams, useParam } from "@/lib/url-state";

// Comments on any Overview or Today item: a button on the item, and one sheet over any page (?comments=<key>, so back
// closes it and a notification can open it). Everyone the item reaches reads the same thread (keyed by its stable key).
// "Waiting on client" pauses its reminders and escalations until the client writes, sends something new, or it's due.

export type CommentTarget = { key: string; clientId: string | null; title: string; href?: string | null; dueAt?: string | null };

// What the sheet needs to start a new thread (the client, a title): left here by the button that opened it
const targets = new Map<string, CommentTarget>();

export function CommentButton({ target, count = 0, waiting = false, tone = "auto" }: { target: CommentTarget; count?: number; waiting?: boolean; tone?: "auto" | "dark" }) {
  const open = () => {
    targets.set(target.key, target);
    pushParams({ comments: target.key });
  };
  const base = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full px-3.5 text-[13px] transition-colors sm:min-h-8 sm:px-3 sm:text-[12px]";
  return (
    <button type="button" onClick={open} className={`${base} border ${tone === "dark" ? "border-white/25 text-white/80 hover:bg-white/10" : "border-ink/15 text-ink/75 hover:border-ink/35 hover:text-fg"}`}>
      <span aria-hidden>💬</span>
      {count ? `Comments · ${count}` : "Comment"}
      {waiting && <span className="rounded-full bg-[#f2b14c]/20 px-1.5 text-[10.5px] text-[#f2b14c]">waiting on client</span>}
    </button>
  );
}

export function CommentsSheet() {
  const key = useParam("comments");
  if (!key) return null;
  return <Sheet key={key} k={key} />;
}

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

function Sheet({ k }: { k: string }) {
  const router = useRouter();
  const target = targets.get(k);
  const [thread, setThread] = useState<ItemThread | null>(null);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const end = useRef<HTMLDivElement>(null);
  // Phones: the sheet fills only what's visible above the keyboard, so Comment and the close stay in reach
  const vv = useVisualViewport();
  const swipe = useRef<number | null>(null);
  // A button pressed while typing keeps the field focused: the keyboard doesn't drop first and move the button away
  const keepFocus = (e: React.PointerEvent) => e.preventDefault();
  useEffect(() => {
    let live = true;
    itemThread(k).then((t) => live && setThread(t)).catch(() => live && setThread({ key: k, waiting: false, waitingSince: null, waitingBy: null, comments: [], clientId: null, title: null }));
    const esc = (e: KeyboardEvent) => e.key === "Escape" && closeParams("comments");
    window.addEventListener("keydown", esc);
    const was = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      live = false;
      window.removeEventListener("keydown", esc);
      document.body.style.overflow = was;
    };
  }, [k]);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [thread?.comments.length]);
  const title = target?.title ?? thread?.title ?? "This item";
  const send = (waiting?: boolean) =>
    start(async () => {
      setError(null);
      const r = await commentOnItem({ key: k, clientId: target?.clientId ?? thread?.clientId ?? null, title, body, waiting: waiting ?? null, dueAt: target?.dueAt ?? null, href: target?.href ?? null });
      if (!r.ok) return setError(r.error);
      setThread(r.thread);
      setBody("");
      router.refresh();
    });
  return (
    <div
      className="fixed inset-x-0 top-0 z-[60] flex h-[100dvh] items-end justify-center md:inset-0 md:h-auto md:items-stretch md:justify-end"
      style={vv ? { top: vv.top, height: vv.height } : undefined}
      role="dialog"
      aria-modal="true"
      aria-label="Comments"
      // Nothing behind it (the recap's taps and swipes) ever sees a touch meant for the sheet
      onClick={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
    >
      <button type="button" aria-label="Close" onClick={() => closeParams("comments")} className="absolute inset-0 bg-black/60 backdrop-blur-[2px] animate-[sheet-fade_.2s_ease-out]" />
      <div className="relative grid max-h-[92%] w-full grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-t-[26px] border border-line bg-bg shadow-[0_-30px_80px_-30px_rgba(0,0,0,0.6)] animate-[sheet-up_.32s_cubic-bezier(.2,.8,.2,1)] md:max-h-none md:w-[480px] md:rounded-none md:rounded-l-[26px] md:border-y-0 md:border-r-0 md:animate-[drawer-right_.32s_cubic-bezier(.2,.8,.2,1)]">
        <header
          className="grid gap-2 border-b border-line px-5 pb-4 pt-5"
          // Phones: pull the top of the sheet down to close it
          onTouchStart={(e) => (swipe.current = e.touches[0].clientY)}
          onTouchEnd={(e) => {
            if (swipe.current != null && e.changedTouches[0].clientY - swipe.current > 70) closeParams("comments");
            swipe.current = null;
          }}
        >
          <span aria-hidden className="mx-auto -mt-2 mb-1 h-1 w-10 rounded-full bg-ink/20 md:hidden" />
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">Comments</p>
              <h2 className="mt-1 font-heading text-[19px] leading-snug text-fg [overflow-wrap:anywhere]">{title}</h2>
            </div>
            <button type="button" onClick={() => closeParams("comments")} aria-label="Close" className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-ink/60 hover:bg-ink/[0.06] hover:text-fg">
              ✕
            </button>
          </div>
          <p className="text-[12px] text-muted">Everyone this item reaches sees these. Whoever it&apos;s on hears about a new one in the app.</p>
          {thread?.waiting && (
            <p className="rounded-[14px] bg-[#f2b14c]/12 px-3 py-2 text-[12.5px] text-[#d99a2b]">
              Waiting on the client{thread.waitingBy ? `, marked by ${thread.waitingBy}` : ""}. Reminders and escalations are paused until they reply, send something new, or it&apos;s due.
            </p>
          )}
        </header>
        <div className="overflow-y-auto px-5 py-4">
          {!thread ? (
            <p className="text-[13px] text-muted">Loading…</p>
          ) : thread.comments.length ? (
            <ul className="grid gap-3">
              {thread.comments.map((c) => (
                <li key={c.id} className={c.kind === "comment" ? "grid gap-1" : "text-center text-[12px] text-faint"}>
                  {c.kind === "comment" ? (
                    <>
                      <p className="text-[11.5px] text-faint">
                        <span className="text-ink/75">{c.author ?? "Someone"}</span> · {when(c.at)}
                      </p>
                      <p className="whitespace-pre-wrap rounded-[16px] bg-ink/[0.05] px-3.5 py-2.5 text-[14px] leading-relaxed text-fg">{c.body}</p>
                    </>
                  ) : (
                    <>
                      {c.author ? `${c.author}: ` : ""}
                      {c.body} · {when(c.at)}
                    </>
                  )}
                </li>
              ))}
              <div ref={end} />
            </ul>
          ) : (
            <p className="text-[13px] text-muted">No comments yet. Add context for whoever else this reaches, like &quot;waiting on the client&apos;s answer&quot;.</p>
          )}
        </div>
        <footer className="grid gap-2 border-t border-line px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} maxLength={2000} placeholder="Add a comment" className="min-h-[3.5rem] w-full resize-none rounded-[16px] border border-line bg-transparent px-3.5 py-2.5 text-[16px] text-fg outline-none focus:border-ink/35 md:text-[14px]" onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && body.trim() && send()} />
          {error && <p className="text-[12px] text-[var(--bad)]">{error}</p>}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button type="button" disabled={busy} onPointerDown={keepFocus} onClick={() => send(!thread?.waiting)} className={`min-h-11 rounded-full border px-3.5 text-[13px] sm:min-h-9 ${thread?.waiting ? "border-[#f2b14c]/50 text-[#d99a2b]" : "border-line text-ink/75 hover:text-fg"}`}>
              {thread?.waiting ? "Not waiting any more" : "Waiting on client"}
            </button>
            <button type="button" disabled={busy || !body.trim()} onPointerDown={keepFocus} onClick={() => send()} className="min-h-11 rounded-full bg-fg px-5 text-[14px] font-medium text-bg disabled:opacity-50 sm:min-h-9 sm:text-[13px]">
              {busy ? "Sending…" : "Comment"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
