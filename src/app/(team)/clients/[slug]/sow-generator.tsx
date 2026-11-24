"use client";

import { useState, useTransition } from "react";
import { draftEmailSow } from "./email-scope-actions";

// The client page's Draft SOW (Email · Allotment and SOW): Kaizen's Email SOW Generator writes the Sprint Recap and
// Ongoing Management SOW from the client's own numbers, priced from the email packages, as a Google Doc
// made as a Google Doc in their Headquarters › Proposals & SOWs. An optional line says what to pitch or include.

type Made = { url: string; pdf: string | null; place: string; saved: string; placeholders: string[] };
type Ask = { say: string; path: string | null; link: string | null; needsLink: boolean };

export function SowGenerator({ clientId }: { clientId: string }) {
  const [brief, setBrief] = useState("");
  const [made, setMade] = useState<Made | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [link, setLink] = useState("");
  const [busy, start] = useTransition();
  // The Drive rule: the folder is said back first (Saving to <path>, OK?) or a link asked for; written only after the yes
  const go = (where: { folder?: string | null; yes?: boolean } = {}) =>
    start(async () => {
      setError(null);
      const r = await draftEmailSow(clientId, brief, where);
      if (r.ok) {
        setMade(r);
        setAsk(null);
        setLink("");
      } else if ("folder" in r) setAsk(r.folder);
      else setError(r.error);
    });
  return (
    <section className="grid gap-3 rounded-[16px] border border-line bg-surface p-4" aria-label="Draft an SOW">
      <div className="grid gap-0.5">
        <h3 className="text-[14px] font-semibold text-fg">Draft an SOW</h3>
        <p className="text-[12.5px] leading-snug text-muted">A Sprint Recap and Ongoing Management SOW from their numbers, priced from the email packages, made as a Google Doc. You confirm the Drive folder first.</p>
      </div>
      <textarea
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        rows={2}
        placeholder="Optional: what to pitch or include (Basic plus a full SMS program, the path to Silver...)"
        className="w-full rounded-[12px] border border-line bg-bg/60 px-3 py-2 text-[16px] leading-snug text-fg outline-none transition-colors focus:border-faint md:text-[14px]"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => go()} disabled={busy || Boolean(ask)} className="inline-flex min-h-11 items-center rounded-full bg-brand px-4 text-[13px] font-medium text-white transition hover:bg-brand-hover active:scale-[0.98] disabled:opacity-60 md:min-h-9">
          {busy ? (ask ? "Writing the SOW… (about a minute)" : "Checking the folder…") : made ? "Draft again" : "Draft SOW"}
        </button>
        {made && (
          <>
            <a href={made.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[13px] text-fg transition-colors hover:border-faint md:min-h-9">
              Open in Google Docs
            </a>
            {made.pdf && (
              <a href={made.pdf} className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[13px] text-muted transition-colors hover:border-faint hover:text-fg md:min-h-9">
                PDF
              </a>
            )}
          </>
        )}
      </div>
      {ask && (
        <div className="grid gap-2 rounded-[12px] border border-line bg-surface-2 p-3">
          <p className="text-[13px] leading-snug text-fg [overflow-wrap:anywhere]">
            {ask.path ? (
              <>
                Saving to <span className="font-medium">{ask.path}</span>
                {ask.link && (
                  <>
                    {" "}
                    (
                    <a href={ask.link} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                      open
                    </a>
                    )
                  </>
                )}
                , OK?
              </>
            ) : (
              ask.say
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {!ask.needsLink && (
              <button type="button" onClick={() => go({ yes: true })} disabled={busy} className="inline-flex min-h-11 items-center rounded-full bg-brand px-4 text-[13px] font-medium text-white transition hover:bg-brand-hover disabled:opacity-60 md:min-h-9">
                Yes, save there
              </button>
            )}
            <input value={link} onChange={(e) => setLink(e.target.value)} placeholder={ask.needsLink ? "Paste the Drive folder link" : "Or paste another folder link"} className="h-11 min-w-0 flex-1 rounded-[10px] border border-line bg-bg/60 px-3 text-[16px] text-fg outline-none focus:border-faint md:h-9 md:text-[13px]" />
            <button type="button" onClick={() => go({ folder: link })} disabled={busy || !link.trim()} className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[13px] text-fg transition-colors hover:border-faint disabled:opacity-50 md:min-h-9">
              Use this folder
            </button>
            <button type="button" onClick={() => setAsk(null)} className="inline-flex min-h-11 items-center rounded-full px-3 text-[13px] text-muted hover:bg-surface hover:text-fg md:min-h-9">
              Cancel
            </button>
          </div>
        </div>
      )}
      {made && <p className="text-[12px] text-faint [overflow-wrap:anywhere]">{made.saved}</p>}
      {made && made.placeholders.length > 0 && <p className="rounded-[10px] bg-warn-soft px-3 py-2 text-[12px] leading-snug text-fg">Still to fill: {made.placeholders.join(", ")}.</p>}
      {error && <p className="text-[12.5px] text-bad">{error}</p>}
    </section>
  );
}
