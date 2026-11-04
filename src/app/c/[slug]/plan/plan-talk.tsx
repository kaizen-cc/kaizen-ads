"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PlanTurn } from "@/lib/plan-chat-types";
import type { Reactions } from "@/lib/presentation-types";
import { createClient } from "@/lib/supabase/client";
import { extractAudio } from "@/lib/uploads/video-prep";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import { planUploadSlots, talkPlan } from "./actions";

// Talking it through with us: the client writes, shares files (their customer list too) or holds the mic for a voice
// message, and the strategist answers one thing at a time. A sheet over the page (full screen on a phone), opened from
// the button at the bottom; in the address (?talk=1), so back closes it.

const MAX_VOICE_MS = 4 * 60_000;

/** A computer's width: the conversation sits beside the presentation instead of opening over it */
function useWide() {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia("(min-width: 1024px)");
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia("(min-width: 1024px)").matches,
    () => false,
  );
}
const clock = () => Date.now();

export function PlanTalk({ slug, brand, chat: initial, locked, onReactions }: { slug: string; brand: string; chat: PlanTurn[]; locked: boolean; onReactions: (r: Reactions) => void }) {
  const wide = useWide();
  const open = useParam("talk") === "1" || wide;
  const [chat, setChat] = useState(initial);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState<number | null>(null);
  const rec = useRef<{ media: MediaRecorder; chunks: Blob[]; started: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const pick = useRef<HTMLInputElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [chat, busy, open]);
  useEffect(() => {
    if (recording == null) return;
    const t = setInterval(() => setRecording(clock() - (rec.current?.started ?? clock())), 250);
    return () => clearInterval(t);
  }, [recording]);

  const upload = async (list: File[]) => {
    if (!list.length) return [];
    const slots = await planUploadSlots(slug, list.map((f) => ({ name: f.name, bytes: f.size })));
    if (!slots.ok) throw new Error(slots.error);
    const supabase = createClient();
    const done: { path: string; name: string; mime: string; bytes: number }[] = [];
    for (let i = 0; i < list.length; i++) {
      const { error: e } = await supabase.storage.from("client-docs").uploadToSignedUrl(slots.slots[i].path, slots.slots[i].token, list[i], { contentType: list[i].type || "application/octet-stream" });
      if (e) throw new Error(`${list[i].name} didn't upload. Try again.`);
      done.push({ path: slots.slots[i].path, name: list[i].name, mime: list[i].type, bytes: list[i].size });
    }
    return done;
  };

  const send = async (opts: { voice?: Blob } = {}) => {
    if (busy || locked) return;
    const words = text.trim();
    if (!opts.voice && !words && !files.length) return;
    setError(null);
    const sending = files;
    setBusy(opts.voice ? "Listening to your message…" : sending.length ? "Reading what you shared…" : "Thinking…");
    if (!opts.voice) {
      setText("");
      setFiles([]);
    }
    try {
      const uploaded = await upload(sending);
      let voicePath: string | null = null;
      if (opts.voice) {
        const [slot] = await upload([new File([opts.voice], "voice-message.wav", { type: "audio/wav" })]);
        voicePath = slot.path;
      }
      const r = await talkPlan(slug, opts.voice ? "" : words, uploaded, voicePath);
      if (!r.ok) throw new Error(r.error);
      setChat(r.chat as PlanTurn[]);
      onReactions(r.reactions as Reactions);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
      if (!opts.voice) {
        setText(words);
        setFiles(sending);
      }
    } finally {
      setBusy(null);
    }
  };

  const startVoice = async () => {
    if (busy || recording != null) return;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const media = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      media.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      media.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: media.mimeType || "audio/webm" });
        const url = URL.createObjectURL(blob);
        const wav = await extractAudio(url);
        URL.revokeObjectURL(url);
        if (!wav) return setError("We couldn't hear anything in that one. Try again a little closer to the mic.");
        void send({ voice: wav });
      };
      rec.current = { media, chunks, started: clock(), timer: setTimeout(() => stopVoice(), MAX_VOICE_MS) };
      media.start();
      setRecording(0);
    } catch {
      setError("Your browser didn't let us use the microphone. Allow it for this page, or type instead.");
    }
  };
  const stopVoice = (cancel = false) => {
    const r = rec.current;
    if (!r) return;
    clearTimeout(r.timer);
    if (cancel) r.media.onstop = () => r.media.stream.getTracks().forEach((t) => t.stop());
    r.media.stop();
    rec.current = null;
    setRecording(null);
  };

  const secs = Math.floor((recording ?? 0) / 1000);

  return (
    <>
      {/* The way in: a bar along the bottom */}
      {!open && (
        <div className="pointer-events-none fixed inset-x-0 bottom-[calc(58px+env(safe-area-inset-bottom))] z-30 px-4 pb-3">
          <button
            type="button"
            onClick={() => pushParams({ talk: "1" })}
            className="pointer-events-auto mx-auto flex h-14 w-full max-w-md items-center gap-3 rounded-full border border-line bg-surface/95 pl-2 pr-5 text-left shadow-[0_18px_50px_-16px_rgba(0,0,0,0.6)] backdrop-blur-xl"
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand text-white" aria-hidden>
              ✦
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14.5px] font-medium">{chat.length ? "Continue the conversation" : "Easier to just talk it through?"}</span>
              <span className="block truncate text-[12px] text-muted">Type, share files or send a voice message</span>
            </span>
          </button>
        </div>
      )}

      {open && (
        <div className={wide ? "sticky top-8 h-[calc(100vh-4rem)]" : "fixed inset-0 z-50 flex justify-end"}>
          {!wide && <button type="button" aria-label="Close" onClick={() => closeParams("talk")} className="absolute inset-0 bg-black/40 backdrop-blur-[2px] max-md:hidden" />}
          <div className={wide ? "flex h-full flex-col overflow-hidden rounded-[24px] border border-line bg-surface" : "relative flex h-full w-full flex-col border-l border-line bg-bg md:w-[min(560px,94vw)]"}>
            <header className={`flex items-center gap-3 border-b border-line px-4 py-3 ${wide ? "" : "pt-safe"}`}>
              <span className="grid h-9 w-9 place-items-center rounded-full bg-brand text-[13px] text-white" aria-hidden>
                ✦
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-heading text-[15px] leading-tight">Talk it through with Kaizen</p>
                <p className="truncate text-[12px] text-muted">About {brand} · anything you tell us goes into the work</p>
              </div>
              {!wide && (
                <button type="button" onClick={() => closeParams("talk")} className="grid h-11 w-11 place-items-center rounded-full text-[18px] text-muted hover:text-fg" aria-label="Close">
                  ×
                </button>
              )}
            </header>

            <div className="grid flex-1 content-start gap-3 overflow-y-auto px-4 py-4">
              {!chat.length && (
                <div className="grid gap-2 rounded-[18px] border border-line bg-surface p-4">
                  <p className="text-[14.5px] leading-relaxed">Tell us anything: what we got right, what we missed, what you&rsquo;d love to see. Share files like a brand guide, photos or your customer list, or hold the mic and just talk.</p>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {["What did we get wrong?", "Here's what makes us different", "I'll share our customer list"].map((x) => (
                      <button key={x} type="button" onClick={() => setText(x)} className="min-h-10 rounded-full border border-line px-3 text-[12.5px] text-muted hover:text-fg">
                        {x}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {chat.map((t, i) => (
                <div key={i} className={`grid max-w-[88%] gap-1.5 ${t.role === "client" ? "justify-self-end" : ""}`}>
                  <p className={`whitespace-pre-wrap rounded-[18px] px-4 py-2.5 text-[15px] leading-relaxed ${t.role === "client" ? "bg-fg text-bg" : "bg-surface-2 text-fg"}`}>
                    {t.voice && <span className="mb-1 block text-[11px] opacity-70">🎙 Voice message</span>}
                    {t.text || (t.files?.length ? "Shared files" : "")}
                  </p>
                  {t.files?.length ? <p className="justify-self-end text-[11.5px] text-faint">📎 {t.files.join(", ")}</p> : null}
                  {t.saved?.length ? (
                    <div className="flex flex-wrap gap-1">
                      {t.saved.slice(0, 4).map((x) => (
                        <span key={x} className="rounded-full bg-ok-soft px-2.5 py-0.5 text-[11px] text-ok">
                          ✓ {x.length > 48 ? `${x.slice(0, 48)}…` : x}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
              {busy && (
                <p className="flex items-center gap-2 text-[13px] text-faint">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" /> {busy}
                </p>
              )}
              <div ref={end} />
            </div>

            {locked ? (
              <p className="border-t border-line px-4 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))] text-center text-[13.5px] text-muted">It&rsquo;s approved: the team has it from here. Thank you!</p>
            ) : (
              <div className="grid gap-2 border-t border-line px-3 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
                {error && <p className="px-1 text-[13px] text-bad">{error}</p>}
                {files.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 px-1">
                    {files.map((f, i) => (
                      <span key={`${f.name}-${i}`} className="inline-flex items-center gap-1 rounded-full bg-surface-2 py-1 pl-3 pr-1 text-[12px]">
                        {f.name}
                        <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))} className="grid h-6 max-md:h-11 w-6 max-md:w-11 place-items-center rounded-full text-muted hover:text-fg" aria-label={`Remove ${f.name}`}>
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                {recording != null ? (
                  <div className="flex items-center gap-3 rounded-[22px] border border-brand/50 bg-brand/10 px-4 py-2">
                    <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-brand" />
                    <span className="tabular flex-1 text-[14px]">
                      Recording {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}
                    </span>
                    <button type="button" onClick={() => stopVoice(true)} className="h-11 rounded-full px-3 text-[13.5px] text-muted hover:text-fg">
                      Cancel
                    </button>
                    <button type="button" onClick={() => stopVoice()} className="h-11 rounded-full bg-brand px-5 text-[14px] font-medium text-white">
                      Send
                    </button>
                  </div>
                ) : (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void send();
                    }}
                    className="flex items-end gap-1.5 rounded-[22px] border border-line bg-surface p-1.5 focus-within:border-brand-text/60"
                  >
                    <input ref={pick} type="file" multiple hidden onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])].slice(0, 6))} />
                    <button type="button" onClick={() => pick.current?.click()} disabled={Boolean(busy)} className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-[18px] text-muted hover:text-fg" aria-label="Share files">
                      📎
                    </button>
                    <textarea data-chat
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey && window.matchMedia("(min-width: 768px)").matches) {
                          e.preventDefault();
                          void send();
                        }
                      }}
                      rows={1}
                      placeholder="Write a message"
                      className="max-h-[30vh] min-h-11 w-full resize-none bg-transparent px-1 py-2.5 text-[15px] leading-relaxed outline-none [field-sizing:content]"
                    />
                    {text.trim() || files.length ? (
                      <button type="submit" disabled={Boolean(busy)} className="h-11 shrink-0 rounded-full bg-fg px-4 text-[14px] text-bg disabled:opacity-40">
                        Send
                      </button>
                    ) : (
                      <button type="button" onClick={startVoice} disabled={Boolean(busy)} className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand text-[17px] text-white disabled:opacity-40" aria-label="Record a voice message">
                        🎙
                      </button>
                    )}
                  </form>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
