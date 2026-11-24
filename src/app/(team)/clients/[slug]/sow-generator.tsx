"use client";

import { useState, useTransition } from "react";
import { draftEmailSow } from "./email-scope-actions";

// The client page's Draft SOW (Email · Allotment and SOW): Kaizen's Email SOW Generator writes the Sprint Recap and
// Ongoing Management SOW from the client's own numbers, priced from the email packages, as a PDF and a Word file
// (filed with the client's documents). An optional line says what to pitch or include.

type Made = { href: string; download: string; docx: string; placeholders: string[] };

export function SowGenerator({ clientId }: { clientId: string }) {
  const [brief, setBrief] = useState("");
  const [made, setMade] = useState<Made | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const go = () =>
    start(async () => {
      setError(null);
      const r = await draftEmailSow(clientId, brief);
      if (r.ok) setMade(r);
      else setError(r.error);
    });
  return (
    <section className="grid gap-3 rounded-[16px] border border-line bg-surface p-4" aria-label="Draft an SOW">
      <div className="grid gap-0.5">
        <h3 className="text-[14px] font-semibold text-fg">Draft an SOW</h3>
        <p className="text-[12.5px] leading-snug text-muted">A Sprint Recap and Ongoing Management SOW from their numbers, priced from the email packages. PDF and Word file, saved to their documents.</p>
      </div>
      <textarea
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        rows={2}
        placeholder="Optional: what to pitch or include (Basic plus a full SMS program, the path to Silver...)"
        className="w-full rounded-[12px] border border-line bg-bg/60 px-3 py-2 text-[16px] leading-snug text-fg outline-none transition-colors focus:border-faint md:text-[14px]"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={go} disabled={busy} className="inline-flex min-h-11 items-center rounded-full bg-brand px-4 text-[13px] font-medium text-white transition hover:bg-brand-hover active:scale-[0.98] disabled:opacity-60 md:min-h-9">
          {busy ? "Writing the SOW… (about a minute)" : made ? "Draft again" : "Draft SOW"}
        </button>
        {made && (
          <>
            <a href={made.href} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[13px] text-fg transition-colors hover:border-faint md:min-h-9">
              Open PDF
            </a>
            <a href={made.docx} className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[13px] text-muted transition-colors hover:border-faint hover:text-fg md:min-h-9">
              Word file
            </a>
          </>
        )}
      </div>
      {made && made.placeholders.length > 0 && <p className="rounded-[10px] bg-warn-soft px-3 py-2 text-[12px] leading-snug text-fg">Still to fill: {made.placeholders.join(", ")}.</p>}
      {error && <p className="text-[12.5px] text-bad">{error}</p>}
    </section>
  );
}
