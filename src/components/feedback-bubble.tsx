"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { submitFeedback, type FeedbackInput } from "@/app/(team)/feedback/actions";
import { captured, installCapture } from "@/lib/feedback-capture";
import { TYPES, type FeedbackType } from "@/lib/feedback-logic";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import { toast } from "./toasts";

// Feedback from any page, in a few seconds: a small bubble in the corner (a tab at the edge on phones, above the tab
// bar), dragged up or down out of the way. It opens a compact sheet: what kind (bug, idea, something confusing), a
// line about it, an optional screenshot, and what was on screen goes with it. Sending is instant.

// Errors and failed requests are kept from the moment the app loads, so a report sees what happened just before
if (typeof window !== "undefined") installCapture();

const SPOT_KEY = "kz-feedback-spot";
const PLACEHOLDER: Record<FeedbackType, string> = {
  bug: "What happened, and what did you expect?",
  idea: "What would make this better?",
  confusing: "What was hard to find or understand?",
};

/** A picture made smaller (at most 1400px wide, JPEG) so it sends fast; under ~700KB of text. */
function shrink(source: CanvasImageSource, w: number, h: number) {
  let width = Math.min(1400, w);
  let quality = 0.78;
  for (let i = 0; i < 5; i++) {
    const height = Math.round((h * width) / w);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")?.drawImage(source, 0, 0, width, height);
    const url = canvas.toDataURL("image/jpeg", quality);
    if (url.length < 700_000) return url;
    width = Math.round(width * 0.8);
    quality = Math.max(0.5, quality - 0.08);
  }
  return null;
}

async function fileToShot(file: File) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return shrink(img, img.naturalWidth, img.naturalHeight);
  } finally {
    URL.revokeObjectURL(url);
  }
}

const canCapture = () => typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getDisplayMedia) && !/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
const noSubscribe = () => () => {};
const readSpot = () => {
  try {
    const v = Number(localStorage.getItem(SPOT_KEY));
    return v > 0 ? Math.min(v, window.innerHeight - 220) : 0;
  } catch {
    return 0;
  }
};
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

export function FeedbackBubble() {
  const open = useParam("feedback") === "1";
  const path = usePathname();
  const [type, setType] = useState<FeedbackType>("bug");
  const [message, setMessage] = useState("");
  const [shot, setShot] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [thanks, setThanks] = useState(false);
  const [details, setDetails] = useState(false);
  // How far up from its resting place the bubble was dragged (kept on this device)
  const saved = useSyncExternalStore(noSubscribe, readSpot, () => 0);
  const [dragged, setLift] = useState<number | null>(null);
  const lift = dragged ?? saved;
  // The sheet reads the browser (capture support, errors so far), so it only draws in the browser
  const mounted = useSyncExternalStore(noSubscribe, () => true, () => false);
  const drag = useRef<{ y: number; lift: number; moved: boolean } | null>(null);
  const text = useRef<HTMLTextAreaElement>(null);

  const show = useCallback(() => {
    setThanks(false);
    pushParams({ feedback: "1" });
  }, []);
  const hide = useCallback(() => closeParams("feedback"), []);

  // Ctrl/Cmd + Shift + F opens it from anywhere; Escape closes it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        if (open) hide();
        else show();
      } else if (e.key === "Escape" && open) hide();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, show, hide]);

  useEffect(() => {
    if (open && !thanks) text.current?.focus();
  }, [open, thanks]);

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { y: e.clientY, lift, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dy = d.y - e.clientY;
    if (Math.abs(dy) > 5) d.moved = true;
    if (d.moved) setLift(Math.max(0, Math.min(window.innerHeight - 220, d.lift + dy)));
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved) {
      try {
        localStorage.setItem(SPOT_KEY, String(Math.round(lift)));
      } catch {}
    } else show();
  };

  const capture = async () => {
    setCapturing(true);
    await nextFrame();
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "browser" }, audio: false, preferCurrentTab: true } as DisplayMediaStreamOptions);
      try {
        const video = document.createElement("video");
        video.srcObject = stream;
        video.muted = true;
        await video.play();
        // The browser's "sharing this tab" bar settles first
        await new Promise((r) => setTimeout(r, 350));
        const url = shrink(video, video.videoWidth, video.videoHeight);
        if (url) setShot(url);
      } finally {
        stream.getTracks().forEach((t) => t.stop());
      }
    } catch {
      // Cancelled at the browser's prompt: nothing to do
    } finally {
      setCapturing(false);
    }
  };

  const addFile = async (file: File | null | undefined) => {
    if (!file || !file.type.startsWith("image/")) return;
    const url = await fileToShot(file).catch(() => null);
    if (url) setShot(url);
    else toast({ tone: "warn", title: "That image couldn't be added", body: "Try a smaller one, or a PNG or JPEG." });
  };

  const send = () => {
    const body = message.trim();
    if (!body) {
      text.current?.focus();
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("feedback");
    const input: FeedbackInput = {
      type,
      message: body,
      pageUrl: url.href,
      path: `${url.pathname}${url.search}`,
      clientSlug: url.pathname.match(/^\/clients\/([^/]+)/)?.[1] ?? null,
      screenshot: shot,
      context: {
        userAgent: navigator.userAgent,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        screen: `${window.screen.width}x${window.screen.height}`,
        pixelRatio: window.devicePixelRatio,
        theme: document.documentElement.dataset.theme ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "system-dark" : "system-light"),
        online: navigator.onLine,
        language: navigator.language,
        version: process.env.APP_VERSION ?? "dev",
        ...captured(),
      },
    };
    // Thanked at once; it sends behind. If it doesn't go, the draft comes back with a way to try again.
    setThanks(true);
    setMessage("");
    setShot(null);
    setDetails(false);
    setTimeout(() => {
      if (new URLSearchParams(window.location.search).get("feedback") === "1") hide();
    }, 1700);
    const attempt = () =>
      submitFeedback(input)
        .then((r) => {
          if ("error" in r) throw new Error(r.error);
        })
        .catch((e: unknown) => {
          setMessage((m) => m || input.message);
          setShot((s) => s ?? input.screenshot);
          setType(input.type);
          toast({ tone: "bad", title: "Your feedback didn't send", body: e instanceof Error ? e.message : "Check your connection.", ms: 12000, actions: [{ label: "Try again", run: attempt, primary: true }] });
        });
    void attempt();
  };

  const ctx = mounted && open ? captured() : { consoleErrors: [], failedRequests: [] };
  const issues = ctx.consoleErrors.length + ctx.failedRequests.length;
  const onFeedbackPage = path === "/feedback";

  return (
    <>
      {/* The bubble: a round button in the corner on computers, a small tab at the edge on phones, above the tab bar */}
      {!open && !onFeedbackPage && (
        <button
          type="button"
          aria-label="Leave feedback or flag a bug (Ctrl+Shift+F)"
          title="Feedback or a bug? (Ctrl+Shift+F). Drag to move"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (drag.current = null)}
          // Above a page's own corner button (--fab-clear, set by useFabClear), plus wherever it was dragged
          style={{ transform: `translateY(calc(${-lift}px - var(--fab-clear, 0px)))`, touchAction: "none" }}
          className="group fixed bottom-[calc(74px+env(safe-area-inset-bottom))] right-0 z-40 grid h-12 w-11 cursor-grab select-none place-items-center rounded-l-full bg-brand text-white shadow-[0_10px_28px_-10px_rgba(178,30,44,0.85)] transition-[background-color,transform] hover:bg-brand-hover active:cursor-grabbing md:bottom-6 md:right-6 md:h-14 md:w-14 md:rounded-full md:hover:scale-105"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
            <path d="M9 11h.01M12 11h.01M15 11h.01" strokeWidth="2.4" />
          </svg>
        </button>
      )}

      {mounted && open && !capturing && (
        <div className="fixed inset-0 z-50 md:pointer-events-none" role="dialog" aria-modal="true" aria-label="Feedback">
          <button type="button" aria-label="Close feedback" onClick={hide} className="absolute inset-0 bg-black/50 backdrop-blur-[2px] animate-[sheet-fade_.2s_ease-out] md:hidden" />
          <div
            onPaste={(e) => {
              const file = [...e.clipboardData.files].find((f) => f.type.startsWith("image/"));
              if (file) {
                e.preventDefault();
                void addFile(file);
              }
            }}
            className="pb-safe absolute inset-x-0 bottom-0 flex max-h-[92dvh] flex-col gap-5 overflow-y-auto rounded-t-[22px] border border-line bg-surface px-5 pt-5 shadow-2xl animate-[sheet-up_.28s_cubic-bezier(.2,.8,.2,1)] md:pointer-events-auto md:inset-x-auto md:bottom-6 md:right-6 md:max-h-[calc(100dvh-48px)] md:w-[420px] md:rounded-[20px] md:px-6 md:pt-6"
          >
            {thanks ? (
              <div className="grid justify-items-center gap-2 py-8 text-center">
                <span className="grid h-12 w-12 place-items-center rounded-full bg-ok-soft text-ok">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M5 12.5l4.5 4.5L19 7.5" />
                  </svg>
                </span>
                <p className="font-heading text-lg">Thank you</p>
                <p className="max-w-[280px] text-sm text-muted">It&apos;s with the team. If others hit the same thing it moves up the list, and you&apos;ll hear when it&apos;s fixed.</p>
              </div>
            ) : (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-heading text-[17px]">Feedback</p>
                    <p className="mt-0.5 text-[13px] text-muted">A bug, an idea, or something that confused you.</p>
                  </div>
                  <button type="button" onClick={hide} aria-label="Close feedback" className="-mr-2 -mt-2 grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </div>

                <div className="grid grid-cols-3 gap-1 rounded-[12px] bg-surface-2 p-1" role="radiogroup" aria-label="What kind">
                  {TYPES.map((t) => (
                    <button
                      key={t.value}
                      type="button"
                      role="radio"
                      aria-checked={type === t.value}
                      title={t.hint}
                      onClick={() => setType(t.value)}
                      className={`min-h-11 rounded-[9px] px-2 text-[13px] leading-tight transition-colors ${type === t.value ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"}`}
                    >
                      {t.value === "confusing" ? "Confusing" : t.label}
                    </button>
                  ))}
                </div>

                <textarea
                  ref={text}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  rows={4}
                  maxLength={5000}
                  placeholder={PLACEHOLDER[type]}
                  className="min-h-[112px] w-full resize-none rounded-[12px] border border-line bg-bg px-3.5 py-3 text-[15px] text-fg outline-none placeholder:text-faint focus:border-brand-text/70 md:text-sm"
                />

                {shot ? (
                  <div className="flex items-center gap-3 rounded-[12px] border border-line bg-bg p-2">
                    {/* eslint-disable-next-line @next/next/no-img-element -- a local data: preview */}
                    <img src={shot} alt="Screenshot to send" className="h-14 w-20 rounded-[8px] object-cover object-top" />
                    <p className="min-w-0 flex-1 text-[13px] text-muted">Screenshot added</p>
                    <button type="button" onClick={() => setShot(null)} className="min-h-11 rounded-full px-3 text-[13px] text-muted hover:bg-surface-2 hover:text-fg">
                      Remove
                    </button>
                  </div>
                ) : (
                  <div className="grid gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    {canCapture() && (
                      <button type="button" onClick={capture} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line px-3.5 text-[13px] text-muted hover:border-faint/60 hover:text-fg md:min-h-9">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
                        </svg>
                        Capture this screen
                      </button>
                    )}
                    <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-line px-3.5 text-[13px] text-muted hover:border-faint/60 hover:text-fg md:min-h-9">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <rect x="3" y="5" width="18" height="14" rx="2" />
                        <path d="M3 15l5-5 4 4 3-3 6 6" />
                      </svg>
                      Add an image
                      <input type="file" accept="image/*" className="sr-only" onChange={(e) => void addFile(e.target.files?.[0])} />
                    </label>
                  </div>
                  <p className="hidden text-[12px] text-faint md:block">Or paste a screenshot straight into this box.</p>
                  </div>
                )}

                <div className="text-[12px] text-faint">
                  <button type="button" onClick={() => setDetails((d) => !d)} className="min-h-8 text-left underline-offset-2 hover:text-muted hover:underline" aria-expanded={details}>
                    Sent with it: this page, your browser and screen{issues ? `, and ${issues} recent ${issues === 1 ? "error" : "errors"}` : ""}
                  </button>
                  {details && (
                    <ul className="mt-1.5 grid gap-1 rounded-[10px] bg-surface-2 p-2.5 font-mono text-[11px] leading-relaxed text-muted [overflow-wrap:anywhere]">
                      <li>{path}</li>
                      <li>
                        {window.innerWidth}x{window.innerHeight} · version {(process.env.APP_VERSION ?? "dev").slice(0, 7)}
                      </li>
                      {ctx.consoleErrors.slice(-3).map((e, i) => (
                        <li key={`e${i}`}>Error: {e.message.slice(0, 140)}</li>
                      ))}
                      {ctx.failedRequests.slice(-3).map((r, i) => (
                        <li key={`r${i}`}>
                          {r.method} {r.url} {r.status ?? "failed"}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="sticky bottom-0 -mx-5 mt-auto flex items-center justify-between gap-3 border-t border-line bg-surface px-5 py-4 md:-mx-6 md:px-6">
                  <Link href="/feedback?tab=mine" className="inline-flex min-h-11 items-center text-[13px] text-muted hover:text-fg">
                    My feedback
                  </Link>
                  <button
                    type="button"
                    onClick={send}
                    disabled={!message.trim()}
                    className="min-h-11 rounded-full bg-brand px-6 text-[14px] font-medium text-white shadow-[0_8px_24px_-12px_rgba(178,30,44,0.9)] transition-colors hover:bg-brand-hover disabled:opacity-50"
                  >
                    Send
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
