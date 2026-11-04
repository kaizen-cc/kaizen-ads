"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CTA_BUTTONS, meters, type Ad, type Meter } from "@/lib/copy";
import { chatWithCopywriter, copyChat, reopenCopy, setLandingUrl, type ChatMessage, type CopyState } from "./copy-actions";
import type { CopyViolation } from "@/lib/ai";
import type { Design } from "./design-actions";
import { cachedMedia, loadMedia } from "./media-cache";
import { AdPreview, previewMedia } from "@/components/ad-preview";
import type { Dismissed } from "@/lib/copy";
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

function Editor({ ad, ai, editable, onChange, highlight }: { ad: Ad; ai?: Ad; editable: boolean; onChange: (ad: Ad) => void; /** A flagged phrase to jump to: its field is focused with the words selected */ highlight?: { field: string; quote: string; n: number } | null }) {
  const m = meters(ad);
  const refs = useRef<Record<string, HTMLTextAreaElement | HTMLInputElement | null>>({});
  useEffect(() => {
    if (!highlight) return;
    const el = refs.current[highlight.field];
    if (!el) return;
    const at = el.value.toLowerCase().indexOf(highlight.quote.trim().toLowerCase());
    el.focus();
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    if (at >= 0) el.setSelectionRange(at, at + highlight.quote.trim().length);
  }, [highlight]);
  const flagged = (f: string) => (highlight?.field === f ? "ring-2 ring-bad/50" : "");
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
        <textarea ref={(el) => void (refs.current.primaryText = el)} value={ad.primaryText} disabled={!editable} onChange={(e) => onChange({ ...ad, primaryText: e.target.value })} rows={ad.kind === "short" ? 5 : 16} className={`${field} ${flagged("primaryText")}`} />
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
        <input ref={(el) => void (refs.current.headline = el)} value={ad.headline} disabled={!editable} onChange={(e) => onChange({ ...ad, headline: e.target.value })} className={`${field} ${flagged("headline")}`} />
      </label>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_170px]">
        <label className="grid gap-1.5">
          <span className="flex items-center justify-between gap-2 text-xs text-muted">
            <span>Link description {edited("linkDescription") && <span className="text-[10px] text-brand-text">edited</span>}</span>
            <Count m={m.description} />
          </span>
          <input ref={(el) => void (refs.current.linkDescription = el)} value={ad.linkDescription} disabled={!editable} onChange={(e) => onChange({ ...ad, linkDescription: e.target.value })} className={`${field} ${flagged("linkDescription")}`} />
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
          <textarea data-chat
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
          <button disabled={busy || disabled || !text.trim()} onClick={send} className="h-10 rounded-brand bg-fg px-4 text-sm font-medium text-bg disabled:opacity-40 max-md:h-11">
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
    // Eases ever closer to the next step without reaching it, so the bar never sits still
    const t = setInterval(() => setCreep((c) => c + (0.95 - c) * 0.06), 700);
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
  rebutted = [],
  dismissed = [],
  checking = false,
  busy,
  error,
  canApprove,
  canForce = false,
  demo,
  onChange,
  onApprove,
  onForce,
  onRebut,
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
  /** Open conflicts with what the client told us (rebutted ones left out) */
  violations: CopyViolation[];
  /** Conflicts the copywriter or a lead rebutted for this copy, shown with why */
  rebutted?: CopyViolation[];
  dismissed?: Dismissed[];
  /** The check against the client's rules is running for the current words */
  checking?: boolean;
  busy: boolean;
  error: string | null;
  canApprove: boolean;
  canForce?: boolean;
  demo: boolean;
  onChange: (i: number, ad: Ad) => void;
  onApprove: () => void;
  onForce?: (reason: string) => void;
  onRebut?: (v: CopyViolation, reason: string) => Promise<void>;
  onRewrite: (note: string) => void;
  onRewriting: () => void;
  onClose: () => void;
}) {
  const set = state.set!;
  const [pick, setPick] = useState(0);
  const [side, setSide] = useState<"preview" | "chat">("preview");
  // Phones have no room for three panes: one at a time, picked from tabs under the header
  const [pane, setPane] = useState<"edit" | "preview" | "chat">("edit");
  const [designs, setDesigns] = useState<Design[] | null>(cachedMedia(ticket.id)?.designs ?? null);
  const [highlight, setHighlight] = useState<{ field: string; quote: string; n: number } | null>(null);
  const [rebutting, setRebutting] = useState<{ key: string; reason: string } | null>(null);
  const [forcing, setForcing] = useState<string | null>(null);
  const jumps = useRef(0);
  const jump = (v: CopyViolation) => {
    setPick(v.ad - 1);
    setPane("edit");
    jumps.current += 1;
    setHighlight({ field: v.field, quote: v.quote, n: jumps.current });
  };
  const [designIx, setDesignIx] = useState(0);
  const [note, setNote] = useState("");
  const [reopening, setReopening] = useState(false);
  const [reopenError, setReopenError] = useState<string | null>(null);
  const drafting = set.status === "drafting";
  const [landing, setLanding] = useState<string | null>(ticket.landingUrl ?? null);
  const [landingDraft, setLandingDraft] = useState(ticket.landingUrl ?? "");
  const lockedAd = (i: number) => set.clientStatus?.[i]?.status === "approved";
  const editable = set.status === "review" && !lockedAd(pick);
  const ad = ads[pick] ?? ads[0];

  useEffect(() => {
    if (demo) return;
    let live = true;
    // The same cached request the ticket made: the creative is usually here already, its covers preloaded
    loadMedia(ticket.id).then((m) => live && m && setDesigns(m.designs));
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
  const chosenDesign = designs?.[designIx] ?? null;
  const media = chosenDesign ? previewMedia(ticket.format, chosenDesign.versions[0]?.files ?? [], set.cards?.[chosenDesign.id] ?? []) : null;

  // Rendered at the page level, over everything (the ticket drawer would otherwise contain it)
  return createPortal(
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/70 backdrop-blur-sm md:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="grid h-full max-h-[920px] w-full max-w-[1320px] grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden rounded-[18px] border border-line bg-bg shadow-2xl animate-[step-in_.2s_ease-out] max-md:flex max-md:max-h-none max-md:flex-col max-md:rounded-none max-md:border-0">
        {/* Header */}
        <header className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3.5 max-md:gap-2.5 max-md:px-4 max-md:pb-3 max-md:pt-[calc(0.5rem+env(safe-area-inset-top))]">
          <div className="min-w-0 max-md:order-1 max-md:flex-1">
            <p className="text-xs text-faint">
              {ticket.clientName} · #{ticket.number}
            </p>
            <h2 className="truncate font-heading text-[18px]">Copy · {ticket.title}</h2>
          </div>
          <label className="flex min-w-[220px] flex-1 items-center gap-2 rounded-full border border-line px-3 py-1 text-xs md:max-w-[340px] max-md:order-3 max-md:min-h-11 max-md:min-w-0 max-md:basis-full">
            <span className="shrink-0 text-faint">Landing page</span>
            <input
              value={landingDraft}
              onChange={(e) => setLandingDraft(e.target.value)}
              onBlur={async () => {
                if (landingDraft.trim() === (landing ?? "")) return;
                const r = demo ? ({ ok: true } as const) : await setLandingUrl(ticket.id, landingDraft);
                if (r.ok) setLanding(landingDraft.trim() || null);
                else setLandingDraft(landing ?? "");
              }}
              placeholder="https://brand.com/offer"
              className="min-w-0 flex-1 bg-transparent py-1 outline-none placeholder:text-faint"
            />
          </label>
          <span className="text-xs text-faint max-md:order-4">
            v{set.version}
            {set.status === "approved" ? ` · approved${set.approvedBy ? ` by ${set.approvedBy}` : ""}` : drafting ? " · rewriting" : dirty ? " · saving…" : " · saved"}
          </span>
          {/* Approved copy is locked: the copywriter or a lead can open it again for edits */}
          {set.status === "approved" && canApprove && !demo && (
            <button
              disabled={reopening}
              onClick={async () => {
                setReopening(true);
                const r = await reopenCopy(set.id);
                if (!r.ok) setReopenError(r.error);
                onRewriting();
                setReopening(false);
              }}
              className="h-9 rounded-full border border-line px-3 text-xs text-muted hover:border-faint hover:text-fg disabled:opacity-50 max-md:order-4 max-md:h-11"
            >
              {reopening ? "Opening…" : "Reopen to edit"}
            </button>
          )}
          {reopenError && <span className="text-xs text-bad max-md:order-4">{reopenError}</span>}
          <div className="ml-auto flex items-center gap-1 rounded-full border border-line p-0.5 text-xs max-md:hidden">
            {(["preview", "chat"] as const).map((k) => (
              <button key={k} onClick={() => setSide(k)} className={`rounded-full px-3 py-1.5 ${side === k ? "bg-surface-2 text-fg" : "text-muted hover:text-fg"}`}>
                {k === "preview" ? "Feed preview" : "Chat with the Copywriter"}
              </button>
            ))}
          </div>
          <button onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg max-md:order-2 max-md:h-11 max-md:w-11 max-md:shrink-0 max-md:bg-surface">
            ✕
          </button>
          {/* Phones: edit, preview or chat, one at a time */}
          <div className="order-5 flex w-full rounded-full border border-line p-0.5 text-sm md:hidden" role="tablist">
            {(["edit", "preview", "chat"] as const).map((k) => (
              <button
                key={k}
                role="tab"
                aria-selected={pane === k}
                onClick={() => setPane(k)}
                className={`h-10 flex-1 rounded-full ${pane === k ? "bg-surface-2 text-fg" : "text-muted"}`}
              >
                {k === "edit" ? "Edit" : k === "preview" ? "Preview" : "Chat"}
              </button>
            ))}
          </div>
        </header>

        {/* The creative */}
        <div className={`flex gap-2.5 overflow-x-auto border-b border-line px-5 py-3 max-md:shrink-0 max-md:px-4 max-md:py-2.5 ${pane === "preview" ? "" : "max-md:hidden"}`}>
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
        <div className="grid min-h-0 grid-cols-1 md:grid-cols-[190px_minmax(0,1fr)] lg:grid-cols-[190px_minmax(0,1fr)_380px] max-md:flex max-md:flex-1 max-md:flex-col">
          <ol className={`flex gap-1.5 overflow-x-auto border-b border-line p-3 md:grid md:content-start md:overflow-y-auto md:border-b-0 md:border-r max-md:shrink-0 max-md:px-4 max-md:py-2.5 ${pane === "chat" ? "max-md:hidden" : ""}`}>
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
                      {lockedAd(i) && <span className="ml-auto text-[10px] font-normal text-ok">✓ client</span>}
                    </span>
                    <span className="truncate text-[11px] text-muted">{a.formula}</span>
                  </button>
                </li>
              );
            })}
          </ol>

          <div
            className={`min-h-0 overflow-y-auto p-5 max-md:flex-1 max-md:overscroll-contain max-md:px-4 max-md:pt-4 ${pane === "edit" ? "" : "max-md:hidden"} ${
              set.status === "approved" ? "max-md:pb-[calc(1.5rem+env(safe-area-inset-bottom))]" : ""
            }`}
          >
            {drafting ? (
              <div className="grid gap-4 rounded-[14px] border border-line bg-surface p-5">
                <CopyProgress progress={set.progress} />
                <p className="text-xs text-faint">The Copywriter is rewriting the whole set. It appears here when it&apos;s done.</p>
              </div>
            ) : ad ? (
              <div className="grid gap-5">
                {(violations.length > 0 || rebutted.length > 0) && (
                  <div className={`grid gap-2 rounded-[12px] border px-4 py-3 ${violations.length ? "border-bad/30 bg-bad-soft/30" : "border-line bg-surface"}`}>
                    {violations.length > 0 && (
                      <p className="text-xs font-medium text-bad">
                        {violations.length} thing{violations.length === 1 ? "" : "s"} go{violations.length === 1 ? "es" : ""} against what {ticket.clientName} told us. Fix {violations.length === 1 ? "it" : "them"} before approving:
                      </p>
                    )}
                    <ul className="grid gap-2">
                      {[...violations, ...rebutted].map((v) => {
                        const key = `${v.ad}:${v.field}:${v.quote}`;
                        const done = dismissed.find((d) => d.rule === v.rule && d.quote.trim().toLowerCase() === v.quote.trim().toLowerCase());
                        return (
                          <li key={key} className={`grid gap-1.5 text-xs ${done ? "opacity-70" : ""}`}>
                            <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                              <button type="button" onClick={() => jump(v)} className="rounded-full bg-bg px-2 py-0.5 text-faint hover:text-fg max-md:py-2">
                                Ad {v.ad} · {v.field === "primaryText" ? "primary text" : v.field === "linkDescription" ? "link description" : v.field} →
                              </button>
                              <span className="text-fg">&ldquo;{v.quote}&rdquo;</span>
                              <span className="text-muted">· {v.rule}</span>
                              {done ? (
                                <span className="text-ok">Rebutted by {done.by}: {done.reason}</span>
                              ) : (
                                canApprove &&
                                onRebut &&
                                rebutting?.key !== key && (
                                  <button type="button" onClick={() => setRebutting({ key, reason: "" })} className="text-faint underline-offset-2 hover:text-fg hover:underline max-md:py-2">
                                    Disagree
                                  </button>
                                )
                              )}
                            </span>
                            {rebutting?.key === key && (
                              <span className="flex flex-wrap gap-1.5">
                                <input
                                  autoFocus
                                  value={rebutting.reason}
                                  onChange={(e) => setRebutting({ key, reason: e.target.value })}
                                  placeholder="Why it's fine, e.g. the client approved this wording on the Oct 12 call"
                                  className="h-8 min-w-0 flex-1 rounded-full border border-line bg-bg px-3 outline-none focus:border-brand-text/60 max-md:h-11 max-md:basis-full max-md:text-base"
                                />
                                <button
                                  type="button"
                                  disabled={rebutting.reason.trim().length < 4}
                                  onClick={async () => {
                                    const reason = rebutting.reason;
                                    setRebutting(null);
                                    await onRebut!(v, reason);
                                  }}
                                  className="h-8 rounded-full bg-fg px-3 font-medium text-bg disabled:opacity-40 max-md:h-11"
                                >
                                  Set it aside
                                </button>
                                <button type="button" onClick={() => setRebutting(null)} className="h-8 rounded-full px-2.5 text-muted hover:text-fg max-md:h-11">
                                  Cancel
                                </button>
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
                {pick === 0 && set.clientNotes && (
                  <div className="grid gap-2 rounded-[12px] border border-brand-text/30 bg-brand-soft/30 px-4 py-3 text-sm">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand-text">Revised for the client</span>
                      <span className="text-xs text-muted">{set.scope === "rewrite" ? "They rejected the set, so it was rewritten" : "Amended: only what they asked was changed"}</span>
                    </p>
                    <p className="leading-relaxed">
                      <span className="text-muted">They asked: </span>
                      {set.clientNotes}
                    </p>
                    {set.changes && set.changes.length > 0 && (
                      <ul className="grid gap-1 text-[13px] text-muted">
                        {set.changes.map((c, i) => (
                          <li key={i}>
                            <button onClick={() => setPick(Math.max(0, c.ad - 1))} className="mr-1.5 text-faint hover:text-fg">
                              Ad {c.ad}
                            </button>
                            {c.what}
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="text-[11px] text-faint">Check each change matches what they asked, then approve. It goes back to them tagged as revised.</p>
                  </div>
                )}
                {pick === 0 && set.notes && (
                  <p className="rounded-[12px] border border-line bg-surface px-4 py-3 text-sm leading-relaxed text-muted">
                    <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.12em] text-faint">From the Copywriter</span>
                    {set.notes}
                  </p>
                )}
                {lockedAd(pick) && <p className="rounded-[10px] bg-ok/10 px-3.5 py-2 text-xs text-ok">The client approved this ad, so it&apos;s locked.</p>}
                {set.clientStatus?.[pick]?.status === "changes" && set.clientStatus[pick].note && (
                  <p className="rounded-[10px] bg-warn-soft/50 px-3.5 py-2 text-xs text-warn">The client asked: {set.clientStatus[pick].note}</p>
                )}
                <Editor ad={ad} ai={set.aiAds[pick]} editable={editable} onChange={(a) => onChange(pick, a)} highlight={highlight && highlight.n && ads[pick] === ad ? highlight : null} />
              </div>
            ) : null}
          </div>

          <aside className="hidden min-h-0 border-l border-line bg-surface/40 p-5 lg:grid">
            {side === "preview" ? (
              <div className="min-h-0 overflow-y-auto">{ad && <AdPreview page={ticket.clientName} primaryText={ad.primaryText} headline={ad.headline} description={ad.linkDescription} cta={ad.cta} landing={landing} media={media} />}</div>
            ) : (
              <Chat ticket={ticket} demo={demo} disabled={set.status === "approved"} onRewriting={onRewriting} />
            )}
          </aside>

          {/* Phones: the preview and the chat take the editor's place */}
          {pane === "preview" && (
            <div className={`min-h-0 flex-1 overflow-y-auto overscroll-contain bg-surface/40 px-4 py-4 md:hidden ${set.status === "approved" ? "pb-[calc(1.5rem+env(safe-area-inset-bottom))]" : ""}`}>
              {ad && <AdPreview page={ticket.clientName} primaryText={ad.primaryText} headline={ad.headline} description={ad.linkDescription} cta={ad.cta} landing={landing} media={media} />}
            </div>
          )}
          {pane === "chat" && (
            <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-4 md:hidden">
              <Chat ticket={ticket} demo={demo} disabled={set.status === "approved"} onRewriting={onRewriting} />
            </div>
          )}
        </div>

        {/* Approve */}
        {set.status !== "approved" && (
          <footer
            className={`grid gap-2.5 border-t border-line bg-surface/60 px-5 py-3.5 max-md:max-h-[45svh] max-md:shrink-0 max-md:overflow-y-auto max-md:px-4 max-md:pb-[calc(0.75rem+env(safe-area-inset-bottom))] max-md:pt-3 ${
              pane === "chat" ? "max-md:hidden" : ""
            }`}
          >
            {violations.length > 0 && (
              <p className="text-xs text-bad">
                {violations.length} thing{violations.length === 1 ? "" : "s"} go{violations.length === 1 ? "es" : ""} against what {ticket.clientName} told us: listed above the ad.
                {canForce && !forcing && (
                  <button type="button" onClick={() => setForcing("")} className="ml-2 text-muted underline-offset-2 hover:text-fg hover:underline">
                    Force approve
                  </button>
                )}
              </p>
            )}
            {forcing !== null && (
              <div className="grid gap-2 rounded-[10px] border border-warn/40 bg-warn-soft/30 px-3.5 py-3">
                <p className="text-xs">Approve over {violations.map((v) => `Ad ${v.ad} "${v.quote}" (${v.rule})`).join("; ")}? It&apos;s logged on the ticket, the media buyer is told, and the copy check learns the rule was read too strictly.</p>
                <div className="flex flex-wrap gap-1.5">
                  <input autoFocus value={forcing} onChange={(e) => setForcing(e.target.value)} placeholder="Why it's fine" className="h-9 min-w-0 flex-1 rounded-brand border border-line bg-bg px-3 text-sm outline-none focus:border-brand-text/60 max-md:h-11 max-md:basis-full" />
                  <button type="button" disabled={busy || forcing.trim().length < 4} onClick={() => (onForce?.(forcing), setForcing(null))} className="h-9 rounded-brand bg-fg px-4 text-sm font-medium text-bg disabled:opacity-40 max-md:h-11">
                    Force approve
                  </button>
                  <button type="button" onClick={() => setForcing(null)} className="h-9 rounded-brand px-3 text-sm text-muted hover:text-fg max-md:h-11">
                    Cancel
                  </button>
                </div>
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
              violations.length === 0 && (checking ? <p className="text-xs text-faint">Checking against what {ticket.clientName} told us…</p> : <p className="text-xs text-ok">On Kaizen&apos;s copy standard, and nothing against what {ticket.clientName} told us.</p>)
            )}
            <div className="flex flex-wrap items-center gap-2">
              {canApprove && (
                <button disabled={busy || drafting || missing.length > 0 || violations.length > 0 || checking} onClick={onApprove} title={missing[0] ?? (violations.length ? "Fix or rebut the conflicts first" : undefined)} className="h-10 rounded-brand bg-ok px-5 text-sm font-medium text-white disabled:opacity-40 max-md:order-3 max-md:h-11 max-md:flex-1">
                  {busy ? "Approving…" : "Approve copy"}
                </button>
              )}
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={drafting}
                placeholder="Quick rewrite with a note, e.g. warmer, lead with the price"
                className="h-10 min-w-0 flex-1 rounded-brand border border-line bg-bg px-3 text-sm outline-none placeholder:text-faint focus:border-brand-text/60 disabled:opacity-60 max-md:order-1 max-md:h-11 max-md:basis-full"
              />
              <button
                disabled={busy || drafting}
                onClick={() => {
                  onRewrite(note);
                  setNote("");
                }}
                className="h-10 rounded-brand border border-line px-4 text-sm text-muted hover:text-fg disabled:opacity-60 max-md:order-2 max-md:h-11"
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
