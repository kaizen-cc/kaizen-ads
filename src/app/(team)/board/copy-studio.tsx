"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CTA_BUTTONS, LIMITS, meters, type Ad, type Meter } from "@/lib/copy";
import { chatWithCopywriter, copyChat, type ChatMessage, type CopyState } from "./copy-actions";
import type { CopyViolation } from "@/lib/ai";
import { ticketDesigns, type Design } from "./design-actions";
import type { Ticket } from "./types";

// The copy studio: copy review works here, not inside the ticket. The creative sits at the top, the five ads on the left,
// the one being edited in the middle with live counts, and on the right either a Meta feed preview of that ad on the
// chosen creative or a chat with the Copywriter that wrote it.

const TONE = { ok: "text-ok", warn: "text-warn", bad: "text-bad" } as const;
const BAR = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad" } as const;
const DOT = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad" } as const;

function Count({ m }: { m: Meter }) {
  const pct = Math.min(100, (m.value / m.max) * 100);
  return (
    <span className="flex items-center gap-2">
      <span className="h-1 w-14 overflow-hidden rounded-full bg-surface-2">
        <span className={`block h-full rounded-full transition-all ${BAR[m.tone]}`} style={{ width: `${pct}%` }} />
      </span>
      <span className={`tabular text-[11px] ${TONE[m.tone]}`}>
        {m.value}
        {m.min != null ? ` / ${m.min}–${m.max}` : ` / ${m.max}`} {m.unit === "words" ? "words" : ""}
      </span>
    </span>
  );
}

const worst = (ad: Ad) => {
  const m = meters(ad);
  const tones = [m.primary.tone, m.headline.tone, m.description.tone];
  return tones.includes("bad") ? "bad" : tones.includes("warn") || m.hook.tone === "warn" ? "warn" : "ok";
};

function Editor({ ad, ai, editable, onChange }: { ad: Ad; ai?: Ad; editable: boolean; onChange: (ad: Ad) => void }) {
  const m = meters(ad);
  const edited = (k: keyof Ad) => ai && ai[k] !== ad[k];
  const field = "w-full rounded-[10px] border border-line bg-bg px-3.5 py-2.5 text-sm leading-relaxed outline-none transition-colors focus:border-brand-text/60 disabled:opacity-80";
  return (
    <div className="grid content-start gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-[11px] ${ad.kind === "short" ? "bg-brand-soft text-brand-text" : "bg-surface-2 text-muted"}`}>{ad.kind === "short" ? "Short-form" : "Long-form"}</span>
        <span className="text-xs text-muted">{ad.formula}</span>
        {ad.angle && <span className="truncate text-xs text-faint">· {ad.angle}</span>}
      </div>
      <label className="grid gap-1.5">
        <span className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
          <span>Primary text {edited("primaryText") && <span className="text-[10px] text-brand-text">edited</span>}</span>
          <Count m={m.primary} />
        </span>
        <textarea value={ad.primaryText} disabled={!editable} onChange={(e) => onChange({ ...ad, primaryText: e.target.value })} rows={ad.kind === "short" ? 5 : 16} className={field} />
        <span className="flex items-center justify-between text-[11px] text-faint">
          <span>Hook shown before &ldquo;See more&rdquo;</span>
          <Count m={m.hook} />
        </span>
      </label>
      <label className="grid gap-1.5">
        <span className="flex items-center justify-between gap-2 text-xs text-muted">
          <span>Headline {edited("headline") && <span className="text-[10px] text-brand-text">edited</span>}</span>
          <Count m={m.headline} />
        </span>
        <input value={ad.headline} disabled={!editable} onChange={(e) => onChange({ ...ad, headline: e.target.value })} className={field} />
      </label>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_170px]">
        <label className="grid gap-1.5">
          <span className="flex items-center justify-between gap-2 text-xs text-muted">
            <span>Link description {edited("linkDescription") && <span className="text-[10px] text-brand-text">edited</span>}</span>
            <Count m={m.description} />
          </span>
          <input value={ad.linkDescription} disabled={!editable} onChange={(e) => onChange({ ...ad, linkDescription: e.target.value })} className={field} />
        </label>
        <label className="grid gap-1.5">
          <span className="text-xs text-muted">CTA button</span>
          <select value={ad.cta} disabled={!editable} onChange={(e) => onChange({ ...ad, cta: e.target.value })} className={field}>
            {CTA_BUTTONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

/** How the ad looks in the Facebook feed: primary text cut at "See more", the creative, then headline, description and CTA. */
function FeedPreview({ ad, client, image }: { ad: Ad; client: string; image: { url: string | null; aspect: string | null } | null }) {
  const [more, setMore] = useState(false);
  const cut = ad.primaryText.length > LIMITS.visible && !more;
  const ratio = image?.aspect === "1x1" ? "1 / 1" : image?.aspect === "9x16" ? "9 / 16" : "4 / 5";
  return (
    <div className="mx-auto w-full max-w-[340px] overflow-hidden rounded-[14px] bg-white text-[#050505] shadow-[0_20px_60px_-25px_rgba(0,0,0,0.9)]">
      <div className="flex items-center gap-2 px-3 pt-3">
        <span className="grid h-9 w-9 place-items-center rounded-full bg-[#1d1d1f] text-sm font-semibold text-white">{client.charAt(0)}</span>
        <span className="grid leading-tight">
          <span className="text-[13px] font-semibold">{client}</span>
          <span className="text-[11px] text-[#65676b]">Sponsored · ◍</span>
        </span>
        <span className="ml-auto text-[#65676b]">···</span>
      </div>
      <p className="whitespace-pre-wrap px-3 py-2 text-[13px] leading-[1.35]">
        {cut ? ad.primaryText.slice(0, LIMITS.visible).trimEnd() : ad.primaryText}
        {cut && (
          <button onClick={() => setMore(true)} className="text-[#65676b]">
            … See more
          </button>
        )}
      </p>
      <div className="relative w-full bg-[#e4e6eb]" style={{ aspectRatio: ratio }}>
        {image?.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image.url} alt="" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <span className="absolute inset-0 grid place-items-center text-xs text-[#65676b]">Creative preview</span>
        )}
      </div>
      <div className="flex items-center gap-3 bg-[#f0f2f5] px-3 py-2.5">
        <span className="grid min-w-0 flex-1 leading-tight">
          <span className="truncate text-[11px] uppercase text-[#65676b]">{client.replace(/\s+/g, "").toLowerCase()}.com</span>
          <span className="truncate text-[14px] font-semibold">{ad.headline || "Headline"}</span>
          {ad.linkDescription && <span className="truncate text-[12px] text-[#65676b]">{ad.linkDescription}</span>}
        </span>
        <span className="shrink-0 rounded-[6px] bg-[#e4e6eb] px-3 py-1.5 text-[13px] font-semibold">{ad.cta}</span>
      </div>
      <div className="flex justify-around border-t border-[#e4e6eb] py-2 text-[12px] font-medium text-[#65676b]">
        <span>Like</span>
        <span>Comment</span>
        <span>Share</span>
      </div>
    </div>
  );
}

function Chat({ ticket, demo, disabled, onRewriting }: { ticket: Ticket; demo: boolean; disabled: boolean; onRewriting: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(demo ? [] : null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (demo) return;
    let live = true;
    copyChat(ticket.id).then((m) => live && setMessages(m));
    return () => {
      live = false;
    };
  }, [ticket.id, demo]);
  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollIntoView, and an effect may only return a cleanup
    end.current?.scrollIntoView({ block: "end" });
  }, [messages, busy]);

  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setError(null);
    setText("");
    const mine: ChatMessage = { role: "user", text: t, by: "You", at: new Date().toISOString() };
    setMessages((m) => [...(m ?? []), mine]);
    setBusy(true);
    if (demo) {
      await new Promise((r) => setTimeout(r, 1200));
      setMessages((m) => [
        ...(m ?? []),
        { role: "assistant", text: "Got it: no discount language, lead with the live teachers, and keep the $7 as a first-week trial. Rewriting the whole set now.", by: null, at: new Date().toISOString(), rewrote: true, lessons: [{ kind: "avoid", body: "Don't call the $7 week a discount; it's a trial." }] },
      ]);
      setBusy(false);
      return;
    }
    const r = await chatWithCopywriter(ticket.id, t);
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      setText(t);
      setMessages((m) => (m ?? []).filter((x) => x !== mine));
      return;
    }
    setMessages(r.messages);
    if (r.rewriting) onRewriting();
  };

  return (
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-3">
      <div className="min-h-0 overflow-y-auto pr-1">
        {messages === null ? (
          <p className="text-xs text-faint">Loading…</p>
        ) : messages.length === 0 ? (
          <div className="grid gap-2 rounded-[12px] border border-dashed border-line p-4 text-sm text-muted">
            <p className="font-medium text-fg">Talk to the Copywriter</p>
            <p>If something is off (the voice, the offer, a claim), tell it what&apos;s wrong. It explains, and rewrites the whole set when that&apos;s what you want.</p>
            <p className="text-xs text-faint">Anything you say that should always apply to {ticket.clientName} is saved as client memory, so every future draft follows it.</p>
          </div>
        ) : (
          <ul className="grid gap-2.5">
            {messages.map((m, i) => (
              <li key={i} className={`grid gap-1.5 ${m.role === "user" ? "justify-items-end" : "justify-items-start"}`}>
                <p className={`max-w-[92%] whitespace-pre-wrap rounded-[12px] px-3.5 py-2.5 text-sm leading-relaxed ${m.role === "user" ? "bg-brand text-white" : "bg-surface-2"}`}>{m.text}</p>
                {m.rewrote && <span className="text-[11px] text-[#9aa7f0]">Rewrote the set</span>}
                {m.lessons?.map((l, j) => (
                  <span key={j} className="max-w-[92%] rounded-full border border-line px-2.5 py-1 text-[11px] text-muted">
                    Saved for {ticket.clientName}: {l.kind === "avoid" ? "avoid · " : ""}
                    {l.body}
                  </span>
                ))}
              </li>
            ))}
            {busy && (
              <li className="flex items-center gap-1.5 text-xs text-faint">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#9aa7f0]" />
                The Copywriter is thinking…
              </li>
            )}
          </ul>
        )}
        <div ref={end} />
      </div>
      <div className="grid gap-1.5">
        {error && <p className="text-xs text-bad">{error}</p>}
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
            placeholder={disabled ? "The copy is approved." : "e.g. They never call it a discount. Lead with the teachers, not the price."}
            className="min-w-0 flex-1 resize-none rounded-[10px] border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-brand-text/60 disabled:opacity-60"
          />
          <button disabled={busy || disabled || !text.trim()} onClick={send} className="h-10 rounded-brand bg-fg px-4 text-sm font-medium text-bg disabled:opacity-40">
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

export function CopyProgress({ progress }: { progress: { written?: number; total?: number; label?: string } }) {
  const total = progress.total ?? 5;
  const written = progress.written ?? 0;
  // Eases toward the next ad so the bar keeps moving between real steps
  const [creep, setCreep] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setCreep((c) => Math.min(0.85, c + 0.04)), 700);
    return () => clearInterval(t);
  }, []);
  const [seen, setSeen] = useState(written);
  if (seen !== written) {
    setSeen(written);
    setCreep(0);
  }
  const pct = Math.min(97, 4 + ((written + creep) / total) * 93);
  return (
    <div className="grid gap-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 truncate text-sm">{progress.label ?? "Writing the copy"}…</p>
        <span className="tabular font-heading text-[20px] leading-none text-brand-text">{Math.floor(pct)}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div className="h-full rounded-full bg-brand transition-[width] duration-700 ease-out" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex gap-1.5">
        {Array.from({ length: total }, (_, i) => (
          <span key={i} className={`h-1 flex-1 rounded-full ${i < written ? "bg-brand" : i === written ? "animate-pulse bg-brand/40" : "bg-surface-2"}`} />
        ))}
      </div>
    </div>
  );
}

export function CopyStudio({
  ticket,
  state,
  ads,
  dirty,
  missing,
  notes,
  violations,
  busy,
  error,
  canApprove,
  demo,
  onChange,
  onApprove,
  onRewrite,
  onRewriting,
  onClose,
}: {
  ticket: Ticket;
  state: CopyState;
  ads: Ad[];
  dirty: boolean;
  missing: string[];
  notes: string[];
  violations: CopyViolation[];
  busy: boolean;
  error: string | null;
  canApprove: boolean;
  demo: boolean;
  onChange: (i: number, ad: Ad) => void;
  onApprove: () => void;
  onRewrite: (note: string) => void;
  onRewriting: () => void;
  onClose: () => void;
}) {
  const set = state.set!;
  const [pick, setPick] = useState(0);
  const [side, setSide] = useState<"preview" | "chat">("preview");
  const [designs, setDesigns] = useState<Design[] | null>(null);
  const [designIx, setDesignIx] = useState(0);
  const [note, setNote] = useState("");
  const drafting = set.status === "drafting";
  const editable = set.status === "review";
  const ad = ads[pick] ?? ads[0];

  useEffect(() => {
    if (demo) return;
    let live = true;
    ticketDesigns(ticket.id).then((d) => live && setDesigns(d));
    return () => {
      live = false;
    };
  }, [ticket.id, demo]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  const cover = (d: Design) => {
    const files = d.versions[0]?.files ?? [];
    return files.find((f) => f.aspect === "4x5") ?? files[0] ?? null;
  };
  const chosen = designs?.[designIx] ? cover(designs[designIx]) : null;

  // Rendered at the page level, over everything (the ticket drawer would otherwise contain it)
  return createPortal(
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/70 p-3 backdrop-blur-sm sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="grid h-full max-h-[920px] w-full max-w-[1320px] grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden rounded-[18px] border border-line bg-bg shadow-2xl animate-[step-in_.2s_ease-out]">
        {/* Header */}
        <header className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3.5">
          <div className="min-w-0">
            <p className="text-xs text-faint">
              {ticket.clientName} · #{ticket.number}
            </p>
            <h2 className="truncate font-heading text-[18px]">Copy · {ticket.title}</h2>
          </div>
          <span className="text-xs text-faint">
            v{set.version}
            {set.status === "approved" ? ` · approved${set.approvedBy ? ` by ${set.approvedBy}` : ""}` : drafting ? " · rewriting" : dirty ? " · saving…" : " · saved"}
          </span>
          <div className="ml-auto flex items-center gap-1 rounded-full border border-line p-0.5 text-xs">
            {(["preview", "chat"] as const).map((k) => (
              <button key={k} onClick={() => setSide(k)} className={`rounded-full px-3 py-1.5 ${side === k ? "bg-surface-2 text-fg" : "text-muted hover:text-fg"}`}>
                {k === "preview" ? "Feed preview" : "Chat with the Copywriter"}
              </button>
            ))}
          </div>
          <button onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg">
            ✕
          </button>
        </header>

        {/* The creative */}
        <div className="flex gap-2.5 overflow-x-auto border-b border-line px-5 py-3">
          {designs === null && !demo ? (
            <p className="text-xs text-faint">Loading the creative…</p>
          ) : (designs ?? []).length === 0 ? (
            <p className="text-xs text-faint">No creative on this ticket.</p>
          ) : (
            (designs ?? []).map((d, i) => {
              const f = cover(d);
              return (
                <button
                  key={d.id}
                  onClick={() => setDesignIx(i)}
                  className={`flex shrink-0 items-center gap-2.5 rounded-[10px] border p-1.5 pr-3 text-left transition-colors ${i === designIx ? "border-brand-text/60 bg-surface" : "border-line hover:border-faint"}`}
                >
                  <span className="relative h-14 w-11 overflow-hidden rounded-[6px] bg-surface-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {f?.thumbUrl && <img src={f.thumbUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />}
                  </span>
                  <span className="grid text-xs leading-tight">
                    <span className="font-medium">D{d.position}</span>
                    <span className="max-w-[140px] truncate text-muted">{d.name}</span>
                  </span>
                </button>
              );
            })
          )}
        </div>

        {/* Ads · editor · preview or chat */}
        <div className="grid min-h-0 grid-cols-1 md:grid-cols-[190px_minmax(0,1fr)] lg:grid-cols-[190px_minmax(0,1fr)_380px]">
          <ol className="flex gap-1.5 overflow-x-auto border-b border-line p-3 md:grid md:content-start md:overflow-y-auto md:border-b-0 md:border-r">
            {ads.map((a, i) => {
              const tone = violations.some((v) => v.ad === i + 1) ? "bad" : worst(a);
              return (
                <li key={i}>
                  <button
                    onClick={() => setPick(i)}
                    className={`grid w-full min-w-[150px] gap-1 rounded-[10px] px-3 py-2.5 text-left transition-colors ${i === pick ? "bg-surface-2" : "hover:bg-surface"}`}
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <span className={`h-1.5 w-1.5 rounded-full ${DOT[tone]}`} />
                      Ad {i + 1}
                      <span className="text-[11px] font-normal text-faint">{a.kind === "short" ? "Short" : "Long"}</span>
                    </span>
                    <span className="truncate text-[11px] text-muted">{a.formula}</span>
                  </button>
                </li>
              );
            })}
          </ol>

          <div className="min-h-0 overflow-y-auto p-5">
            {drafting ? (
              <div className="grid gap-4 rounded-[14px] border border-line bg-surface p-5">
                <CopyProgress progress={set.progress} />
                <p className="text-xs text-faint">The Copywriter is rewriting the whole set. It appears here when it&apos;s done.</p>
              </div>
            ) : ad ? (
              <div className="grid gap-5">
                {pick === 0 && set.notes && (
                  <p className="rounded-[12px] border border-line bg-surface px-4 py-3 text-sm leading-relaxed text-muted">
                    <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.12em] text-faint">From the Copywriter</span>
                    {set.notes}
                  </p>
                )}
                <Editor ad={ad} ai={set.aiAds[pick]} editable={editable} onChange={(a) => onChange(pick, a)} />
              </div>
            ) : null}
          </div>

          <aside className="hidden min-h-0 border-l border-line bg-surface/40 p-5 lg:grid">
            {side === "preview" ? (
              <div className="min-h-0 overflow-y-auto">{ad && <FeedPreview ad={ad} client={ticket.clientName} image={chosen ? { url: chosen.thumbUrl ?? chosen.url, aspect: chosen.aspect } : null} />}</div>
            ) : (
              <Chat ticket={ticket} demo={demo} disabled={set.status === "approved"} onRewriting={onRewriting} />
            )}
          </aside>
        </div>

        {/* Approve */}
        {set.status !== "approved" && (
          <footer className="grid gap-2.5 border-t border-line bg-surface/60 px-5 py-3.5">
            {violations.length > 0 && (
              <div className="grid gap-1.5 rounded-[10px] border border-bad/30 bg-bad-soft/40 px-3.5 py-2.5">
                <p className="text-xs font-medium text-bad">Goes against what {ticket.clientName} told us. Fix before approving:</p>
                <ul className="grid gap-1">
                  {violations.map((v, i) => (
                    <li key={i} className="text-xs text-fg">
                      <button onClick={() => setPick(v.ad - 1)} className="mr-1.5 text-faint hover:text-fg">
                        Ad {v.ad} · {v.field === "primaryText" ? "primary text" : v.field === "linkDescription" ? "link description" : v.field}
                      </button>
                      &ldquo;{v.quote}&rdquo; <span className="text-muted">· {v.rule}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {missing.length > 0 ? (
              <p className="text-xs text-bad">{missing[0]}</p>
            ) : notes.length > 0 ? (
              <p className="text-xs text-warn">
                Heads up: {notes[0]}
                {notes.length > 1 && <span className="text-faint"> · and {notes.length - 1} more</span>}
                <span className="text-faint"> · you can still approve</span>
              </p>
            ) : (
              violations.length === 0 && <p className="text-xs text-ok">On Kaizen&apos;s copy standard.</p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {canApprove && (
                <button disabled={busy || drafting || missing.length > 0} onClick={onApprove} title={missing[0]} className="h-10 rounded-brand bg-ok px-5 text-sm font-medium text-white disabled:opacity-40">
                  {busy ? "Checking against client feedback…" : "Approve copy"}
                </button>
              )}
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={drafting}
                placeholder="Quick rewrite with a note, e.g. warmer, lead with the price"
                className="h-10 min-w-0 flex-1 rounded-brand border border-line bg-bg px-3 text-sm outline-none placeholder:text-faint focus:border-brand-text/60 disabled:opacity-60"
              />
              <button
                disabled={busy || drafting}
                onClick={() => {
                  onRewrite(note);
                  setNote("");
                }}
                className="h-10 rounded-brand border border-line px-4 text-sm text-muted hover:text-fg disabled:opacity-60"
              >
                Rewrite
              </button>
            </div>
            {error && <p className="text-xs text-bad">{error}</p>}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
