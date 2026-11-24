"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { documentText, redrawDocument, type DocText } from "@/app/(team)/assistant/document-actions";
import type { CallDocument } from "@/lib/agent-call/core";
import { closeParams, pushParams, useParam } from "@/lib/url-state";

// A Kaizen document the assistant or Kaizen AI made (make_document): a Google Doc or Slides file opens in Google in a new
// tab (PDF beside it, edited in Google); an older PDF document has Open, Download, and
// Edit (a sheet with its text: change it and it's drawn again as the next version, prices guarded again). A price
// that isn't stored shows as a placeholder on the PDF; the card says which. The sheet lives in the address (?doc=),
// so back closes it.

const KIND: Record<CallDocument["kind"], string> = { sow: "Scope of Work", proposal: "Proposal", handoff: "Handoff summary", one_pager: "One-pager" };

export function DocumentCardView({ doc: start, onDismiss, wide = true }: { doc: CallDocument; onDismiss?: () => void; wide?: boolean }) {
  const [doc, setDoc] = useState(start);
  const editing = useParam("doc") === doc.id;
  return (
    <li className={`relative grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 overflow-hidden rounded-[16px] border border-line bg-surface p-3.5 shadow-sm ${wide ? "sm:col-span-2" : ""}`} aria-label={`${KIND[doc.kind]}: ${doc.title}`}>
      <span aria-hidden className="pointer-events-none absolute -right-10 -top-12 h-28 w-28 rounded-full bg-brand opacity-[0.08] blur-2xl" />
      <div className="relative flex items-start gap-3">
        <span aria-hidden className="grid h-11 w-9 shrink-0 place-items-center rounded-[8px] border border-line bg-surface-2 text-brand-text">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
            <path d="M14 3v5h5M9 13h6M9 17h4" />
          </svg>
        </span>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="text-[10.5px] font-medium uppercase tracking-[0.14em] text-brand-text">
            {KIND[doc.kind]} · {doc.google ? (doc.google.kind === "slides" ? "Google Slides" : "Google Doc") : "PDF"}
            {doc.version > 1 ? ` · v${doc.version}` : ""}
          </span>
          <span className="text-[14px] font-semibold leading-snug text-fg [overflow-wrap:anywhere]">{doc.title}</span>
          {doc.google ? <span className="text-[12px] text-faint [overflow-wrap:anywhere]">In {doc.google.place}</span> : doc.client && <span className="text-[12px] text-faint">{doc.client} · saved to their documents</span>}
        </span>
        {onDismiss && (
          <button type="button" onClick={onDismiss} aria-label={`Hide ${doc.title}`} className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-faint transition-colors hover:bg-surface-2 hover:text-fg">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        )}
      </div>
      {doc.placeholders.length > 0 &&
        (doc.placeholders.every((p) => p.startsWith("[")) ? (
          <p className="relative rounded-[10px] bg-warn-soft px-3 py-2 text-[12px] leading-snug text-fg">
            <span className="font-medium">Still to fill:</span> {doc.placeholders.join(", ")}. {doc.google ? "Fill them in Google, or tell the assistant." : "The document marks each spot in brackets instead of guessing."}
          </p>
        ) : (
          <p className="relative rounded-[10px] bg-warn-soft px-3 py-2 text-[12px] leading-snug text-fg">
            <span className="font-medium">Price to confirm:</span> {doc.placeholders.join(", ")}. No price is stored for {doc.placeholders.length === 1 ? "it" : "them"}, so the PDF marks the spot instead of guessing.
          </p>
        ))}
      <div className="relative flex flex-wrap items-center gap-2">
        <a href={doc.google?.url ?? doc.href} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center rounded-full bg-brand px-4 text-[13px] font-medium text-white transition hover:bg-brand-hover active:scale-[0.98] md:min-h-9">
          {doc.google ? `Open in Google ${doc.google.kind === "slides" ? "Slides" : "Docs"}` : "Open"}
        </a>
        {doc.download !== (doc.google?.url ?? null) && (
          <a href={doc.download} className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[13px] text-muted transition-colors hover:border-faint hover:text-fg md:min-h-9">
            {doc.google ? "PDF" : "Download"}
          </a>
        )}
        {doc.docx && (
          <a href={doc.docx} className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[13px] text-muted transition-colors hover:border-faint hover:text-fg md:min-h-9">
            Word file
          </a>
        )}
        {!doc.google && (
          <button type="button" onClick={() => pushParams({ doc: doc.id })} className="inline-flex min-h-11 items-center rounded-full px-3 text-[13px] text-muted transition-colors hover:bg-surface-2 hover:text-fg md:min-h-9">
            Edit text
          </button>
        )}
      </div>
      {editing && <EditSheet doc={doc} onClose={() => closeParams("doc")} onSaved={setDoc} />}
    </li>
  );
}

const field = "w-full rounded-[12px] border border-line bg-bg/60 px-3 py-2 text-[16px] leading-snug text-fg outline-none transition-colors focus:border-faint md:text-[14px]";
const label = "text-[11px] font-medium uppercase tracking-[0.12em] text-faint";

function EditSheet({ doc, onClose, onSaved }: { doc: CallDocument; onClose: () => void; onSaved: (d: CallDocument) => void }) {
  const [text, setText] = useState<DocText | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void documentText(doc.id).then((r) => {
      if (!live) return;
      if (r.ok) setText(r.text);
      else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [doc.id]);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const set = (patch: Partial<DocText>) => setText((t) => (t ? { ...t, ...patch } : t));
  const save = async () => {
    if (!text) return;
    setBusy(true);
    setError(null);
    const r = await redrawDocument(doc.id, text);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onSaved(r.document);
    onClose();
  };
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-end justify-center md:items-center md:p-6" role="dialog" aria-modal="true" aria-label={`Edit ${doc.title}`}>
      <button type="button" aria-label="Close" tabIndex={-1} onClick={onClose} className="absolute inset-0 cursor-default bg-black/55 backdrop-blur-sm animate-[sheet-fade_.15s_ease-out]" />
      <div className="relative flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-[24px] border border-line bg-surface shadow-[0_30px_80px_-24px_rgba(0,0,0,0.6)] animate-[sheet-up_.24s_cubic-bezier(.2,.8,.2,1)] md:max-w-2xl md:rounded-[24px]">
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <div className="min-w-0">
            <p className="text-[10.5px] font-medium uppercase tracking-[0.14em] text-brand-text">Edit the {KIND[doc.kind]}</p>
            <p className="truncate text-[14px] font-semibold text-fg">{doc.title}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-faint transition-colors hover:text-fg active:bg-surface-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="grid flex-1 gap-4 overflow-y-auto px-5 py-4 pb-safe">
          {!text && !error && <p className="text-[13px] text-faint">Opening its text…</p>}
          {text && (
            <>
              <label className="grid gap-1.5">
                <span className={label}>Title</span>
                <input value={text.title} onChange={(e) => set({ title: e.target.value })} className={`${field} h-11`} />
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-1.5">
                  <span className={label}>Subtitle</span>
                  <input value={text.subtitle} onChange={(e) => set({ subtitle: e.target.value })} className={`${field} h-11`} />
                </label>
                <label className="grid gap-1.5">
                  <span className={label}>Period</span>
                  <input value={text.period} onChange={(e) => set({ period: e.target.value })} className={`${field} h-11`} />
                </label>
              </div>
              <label className="grid gap-1.5">
                <span className={label}>Summary</span>
                <textarea value={text.summary} rows={4} onChange={(e) => set({ summary: e.target.value })} className={`${field} resize-y`} />
              </label>
              {text.sections.map((s, i) => (
                <fieldset key={i} className="grid gap-2 rounded-[16px] border border-line p-3">
                  <legend className={`${label} px-1`}>Section {i + 1}</legend>
                  <input aria-label="Heading" value={s.heading} onChange={(e) => set({ sections: text.sections.map((x, j) => (j === i ? { ...x, heading: e.target.value } : x)) })} className={`${field} h-11 font-medium`} />
                  <textarea aria-label="Text" value={s.body} rows={3} onChange={(e) => set({ sections: text.sections.map((x, j) => (j === i ? { ...x, body: e.target.value } : x)) })} className={`${field} resize-y`} />
                  <textarea aria-label="Points, one per line" placeholder="Points, one per line" value={s.bullets} rows={Math.min(8, Math.max(2, s.bullets.split("\n").length))} onChange={(e) => set({ sections: text.sections.map((x, j) => (j === i ? { ...x, bullets: e.target.value } : x)) })} className={`${field} resize-y`} />
                </fieldset>
              ))}
              {(
                [
                  ["inclusions", "Included, one per line"],
                  ["exclusions", "Not included, one per line"],
                  ["nextSteps", "Next steps, one per line"],
                ] as const
              ).map(([k, l]) => (
                <label key={k} className="grid gap-1.5">
                  <span className={label}>{l}</span>
                  <textarea value={text[k]} rows={Math.min(8, Math.max(2, text[k].split("\n").length))} onChange={(e) => set({ [k]: e.target.value } as Partial<DocText>)} className={`${field} resize-y`} />
                </label>
              ))}
              <p className="text-[12px] leading-relaxed text-faint">Tables (deliverables, cadence, prices) stay as they are. A price only ever shows when it&apos;s stored; anything else stays marked to confirm.</p>
            </>
          )}
          {error && (
            <p role="alert" className="text-[13px] text-bad">
              {error}
            </p>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3 pb-safe">
          <button type="button" onClick={onClose} className="inline-flex min-h-11 items-center rounded-full px-4 text-[13.5px] text-muted transition-colors hover:text-fg md:min-h-10">
            Cancel
          </button>
          <button type="button" disabled={!text || busy || !text.title.trim()} onClick={save} className="inline-flex min-h-11 items-center rounded-full bg-brand px-5 text-[13.5px] font-medium text-white transition hover:bg-brand-hover active:scale-[0.98] disabled:opacity-50 md:min-h-10">
            {busy ? "Drawing it again…" : "Save and redraw"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
