"use client";

import { useEffect, useState } from "react";
import { previewReportEmail } from "./actions";
import type { EmailPreview } from "@/lib/reports/email-preview";

// The report's email as the client's mail app will show it: From, To, Subject, the body the send really builds (drawn on
// the server by the same builders, in a frame that runs nothing) and the PDF attached.

export function EmailFrame({ reportId, to, first, note, file }: { reportId: string; to: string[]; first: string | null; note: string; file: string }) {
  const key = `${reportId}|${first ?? ""}|${note}`;
  const [state, setState] = useState<{ key: string; preview: EmailPreview | null; error: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    // A line typed in the note is drawn once the typing pauses
    const t = setTimeout(() => {
      void previewReportEmail(reportId, first, note)
        .then((r) => live && setState({ key, preview: r.ok ? r.preview : null, error: r.ok ? null : r.error }))
        .catch(() => live && setState({ key, preview: null, error: "The email couldn't be drawn." }));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key, reportId, first, note]);
  const shown = state?.preview ?? null;
  const error = state?.key === key ? state.error : null;

  return (
    <div className="overflow-hidden rounded-[14px] border border-line bg-surface">
      <dl className="grid gap-1.5 border-b border-line px-4 py-3 text-[13px]">
        <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2">
          <dt className="text-faint">From</dt>
          <dd className="truncate">{shown ? <>{shown.fromName}{shown.fromAddress && <span className="text-muted"> &lt;{shown.fromAddress}&gt;</span>}</> : <span className="text-faint">…</span>}</dd>
        </div>
        <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2">
          <dt className="text-faint">To</dt>
          <dd className="min-w-0 break-words">{to.length ? to.join(", ") : <span className="text-warn">Nobody picked yet. Choose who it goes to on the next step.</span>}</dd>
        </div>
        <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2">
          <dt className="text-faint">Subject</dt>
          <dd className="min-w-0 break-words font-medium">{shown ? shown.subject : <span className="text-faint">…</span>}</dd>
        </div>
      </dl>
      {error ? (
        <p className="px-4 py-10 text-center text-sm text-warn">{error}</p>
      ) : shown ? (
        <iframe title="The email" srcDoc={shown.html} sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" className="block h-[560px] w-full border-0 bg-surface-2" />
      ) : (
        <div className="h-[560px] animate-pulse bg-surface-2" aria-label="Drawing the email" />
      )}
      {(!shown || shown.attached) && (
        <div className="border-t border-line px-4 py-3">
          <div className="flex max-w-[360px] items-center gap-3 rounded-[10px] border border-line bg-surface-2 px-3 py-2.5">
            <span className="grid h-10 w-9 shrink-0 place-items-center rounded-[4px] bg-[#e01e5a] text-[10px] font-bold text-white">PDF</span>
            <span className="min-w-0 truncate text-[13px] font-medium">{file}</span>
          </div>
        </div>
      )}
    </div>
  );
}
