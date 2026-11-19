"use client";

import type { CallCard, CallCopyDoc } from "@/lib/agent-call/core";

// Campaign, flow or SMS copy shown on a call or in the chat as a document: each email's subject, preview text, body
// sections, button and design notes, wrapping (never sideways). Open shows it full screen to comment on lines, ask for
// changes and approve; once approved and requested, the Google Doc and Asana links sit on the card.

const KIND: Record<CallCopyDoc["kind"], string> = { campaign: "Email campaign", flow: "Email flow", sms: "SMS", creative: "Ad creative brief", social: "Organic social" };

export function CopyDocCardView({ card, onOpen, onDismiss, wide = true }: { card: CallCard & { copy: CallCopyDoc }; onOpen: (c: CallCard) => void; onDismiss?: () => void; wide?: boolean }) {
  const c = card.copy;
  return (
    <li className={`relative grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 overflow-hidden rounded-[18px] border border-line bg-surface p-4 shadow-sm ${wide ? "sm:col-span-2" : ""}`} aria-label={`${KIND[c.kind]}: ${c.title}`}>
      <span aria-hidden className="pointer-events-none absolute -right-12 -top-14 h-32 w-32 rounded-full bg-brand opacity-[0.08] blur-2xl" />
      <div className="relative flex items-start gap-3">
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="text-[10.5px] font-medium uppercase tracking-[0.14em] text-brand-text">
            {KIND[c.kind]} · {c.emails.length} {c.kind === "sms" ? "text" : c.kind === "social" ? "post" : c.kind === "creative" ? "concept" : "email"}
            {c.emails.length === 1 ? "" : "s"}
            {c.version > 1 ? ` · v${c.version}` : ""}
            {c.status !== "draft" ? ` · ${c.status === "requested" ? "Requested" : "Approved"}` : ""}
          </span>
          <span className="text-[15px] font-semibold leading-snug text-fg [overflow-wrap:anywhere]">{c.title}</span>
          {c.client && <span className="text-[12px] text-faint">{c.client}</span>}
        </span>
        {onDismiss && (
          <button type="button" onClick={onDismiss} aria-label={`Hide ${c.title}`} className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-faint transition-colors hover:bg-surface-2 hover:text-fg">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        )}
      </div>
      <div className="relative grid max-h-[26rem] gap-3 overflow-y-auto pr-1">
        {c.emails.map((e, i) => (
          <section key={i} className="grid gap-1.5 rounded-[14px] border border-line bg-bg/40 p-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-faint">{e.name}</p>
            {e.subject && <p className="text-[14px] font-semibold leading-snug text-fg [overflow-wrap:anywhere]">{e.subject}</p>}
            {e.preview && <p className="text-[12.5px] leading-snug text-muted [overflow-wrap:anywhere]">{e.preview}</p>}
            {e.sections.map((s, j) => (
              <div key={j} className="grid gap-0.5 pt-1">
                {s.heading && <p className="text-[13px] font-medium text-fg [overflow-wrap:anywhere]">{s.heading}</p>}
                {s.body && <p className="line-clamp-4 whitespace-pre-line text-[13px] leading-relaxed text-muted [overflow-wrap:anywhere]">{s.body}</p>}
              </div>
            ))}
            {e.cta && <span className="mt-1 inline-flex w-fit rounded-full bg-brand px-3 py-1 text-[12px] font-medium text-white">{e.cta}</span>}
            {e.designNotes.length > 0 && <p className="text-[11.5px] text-faint [overflow-wrap:anywhere]">Design: {e.designNotes.join(" · ")}</p>}
          </section>
        ))}
      </div>
      <div className="relative flex flex-wrap items-center gap-2">
        <a
          href={card.href}
          onClick={(e) => {
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            onOpen(card);
          }}
          className="inline-flex min-h-11 items-center rounded-full bg-brand px-4 text-[13px] font-medium text-white transition hover:bg-brand-hover active:scale-[0.98] md:min-h-9"
        >
          {c.status === "draft" ? "Open to comment and approve" : "Open"}
        </a>
        {c.docUrl && (
          <a href={c.docUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[13px] text-muted transition-colors hover:border-faint hover:text-fg md:min-h-9">
            Google Doc
          </a>
        )}
        {c.asanaUrl && (
          <a href={c.asanaUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[13px] text-muted transition-colors hover:border-faint hover:text-fg md:min-h-9">
            Asana
          </a>
        )}
      </div>
    </li>
  );
}
