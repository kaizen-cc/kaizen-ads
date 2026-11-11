"use client";

import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { TicketBrief } from "./ticket-brief";
import type { Ticket } from "./types";

/** The brief PDF's request, from the ticket: the same route and design as the request form's PDF */
export function pdfBody(t: Ticket) {
  return {
    clientId: t.clientId,
    title: t.title,
    formats: { [t.format]: { new: t.newCount, variations: t.variationCount, ...(t.format === "carousel" ? { cards: t.cards ?? 5 } : {}) } },
    sizes: t.sizes,
    priority: t.priority,
    angle: t.angleName ?? "",
    audience: t.audience ?? "",
    brief: t.brief ?? "",
    refs: t.refs.join(" "),
    landing: t.landingUrl ?? undefined,
    origin: t.origin ?? null,
    number: t.number,
  };
}

const fileName = (t: Ticket) => `${t.clientName} - ${t.title}.pdf`.replace(/[^\w .()-]+/g, "").slice(0, 120);

/**
 * "Open brief": the brief as its PDF (the same design as the brief PDF) in a large sheet, with download. Phones that
 * can't show a PDF inline get it as a file, and the brief as text underneath.
 */
export function BriefPdfSheet({ ticket, onClose, demo = false }: { ticket: Ticket; onClose: () => void; demo?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(demo ? "The PDF opens on a live ticket." : null);
  const [text, setText] = useState(false);

  useEffect(() => {
    if (demo) return;
    let live = true;
    let made: string | null = null;
    fetch("/api/requests/brief-pdf", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(pdfBody(ticket)) })
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 404 ? "This client isn't yours to see." : "The PDF couldn't be made just now.");
        const blob = await r.blob();
        made = URL.createObjectURL(blob);
        if (live) setUrl(made);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "The PDF couldn't be made just now."));
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
    // The board refreshes the ticket every minute: the PDF is made again only when the brief itself changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket.id, ticket.brief, demo]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[80] grid bg-black/70 backdrop-blur-sm md:place-items-center md:p-6 animate-[sheet-fade_.2s_ease-out]" role="dialog" aria-modal="true" aria-label="Brief" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="grid h-full w-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-bg shadow-2xl md:h-[92vh] md:max-w-[1180px] md:rounded-[20px] md:border md:border-line">
        <header className="flex items-center gap-2 border-b border-line px-5 py-3 pt-[calc(0.75rem+env(safe-area-inset-top))] max-md:px-4 md:pt-3">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Brief · #{ticket.number}</p>
            <p className="truncate font-heading text-[17px]">{ticket.title}</p>
          </div>
          <button type="button" onClick={() => setText((t) => !t)} className="min-h-11 shrink-0 rounded-full px-3.5 text-sm text-muted hover:bg-surface-2 hover:text-fg">
            {text ? "PDF" : "As text"}
          </button>
          {url && (
            <a href={url} download={fileName(ticket)} className="inline-flex min-h-11 shrink-0 items-center rounded-full bg-fg px-4 text-sm font-medium text-bg">
              Download
            </a>
          )}
          <button type="button" onClick={onClose} aria-label="Close the brief" className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg">
            ✕
          </button>
        </header>
        {text || error ? (
          <div className="overflow-y-auto px-6 py-5 pb-[calc(1.5rem+env(safe-area-inset-bottom))] max-md:px-4">
            {error && <p className="mb-4 rounded-[12px] bg-surface px-4 py-3 text-sm text-muted">{error} The brief as written is below.</p>}
            <TicketBrief ticket={ticket} demo={demo} />
          </div>
        ) : url ? (
          <iframe src={url} title={`Brief for #${ticket.number}`} className="h-full w-full bg-surface-2" />
        ) : (
          <div className="grid place-items-center gap-3 p-10 text-center">
            <span className="relative h-1 w-40 overflow-hidden rounded-full bg-surface-2">
              <span className="absolute inset-y-0 left-0 w-1/3 animate-[ai-sweep_1.4s_ease-in-out_infinite] rounded-full bg-brand" />
            </span>
            <p className="text-sm text-muted">Laying out the brief…</p>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
