"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { TAG_LABEL, type GtmNotes } from "@/lib/sales-gtm-core";
import { gtmPdfAction, gtmStatusAction, startGtmAction } from "../actions";

// The prospect's go-to-market strategy, inside the Research view (no tab of its own): build it (Kaizen's branding or a
// white-label partner's), follow it while it's built in the background (researching → writing → talking notes → PDF),
// then download the client-facing PDF and read the internal talking notes, which are never sent. Saving to Drive or
// emailing it goes through the assistant (the Drive rule: the folder is said back for a yes first).

export type GtmView = { id: string; status: string; stage: string | null; partner: string | null; documentId: string | null; notes: GtmNotes | null; error: string | null; createdAt: string };

const STAGE: Record<string, string> = { researching: "Researching the business and its market…", researched: "Research done, writing next…", writing: "Writing the strategy…", notes: "Writing your talking notes…", pdf: "Drawing the PDF…" };

export function GtmCard({ prospectId, gtm, partners }: { prospectId: string; gtm: GtmView | null; partners: { key: string; name: string }[] }) {
  const router = useRouter();
  const [partner, setPartner] = useState("");
  const [ask, setAsk] = useState("");
  const [state, setState] = useState<{ status: string; stage: string | null } | null>(gtm ? { status: gtm.status, stage: gtm.stage } : null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const live = state?.status === "queued" || state?.status === "running";

  useEffect(() => {
    if (!gtm || !live) return;
    const t = setInterval(async () => {
      const r = await gtmStatusAction(gtm.id);
      if (!r.ok) return;
      setState({ status: r.status, stage: r.stage });
      if (r.status !== "queued" && r.status !== "running") router.refresh();
    }, 5000);
    return () => clearInterval(t);
  }, [gtm, live, router]);

  const download = () =>
    start(async () => {
      if (!gtm?.documentId) return;
      const r = await gtmPdfAction(gtm.documentId);
      if (!r.ok) setError(r.error);
      else window.open(r.url, "_blank", "noopener,noreferrer");
    });

  return (
    <section id="gtm" className="grid min-w-0 scroll-mt-20 gap-3 rounded-[20px] border border-line bg-surface p-4 md:p-6">
      <div className="grid gap-1">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.16em] text-faint">Go-to-market strategy</h2>
        <p className="text-[13.5px] leading-relaxed text-muted">A branded PDF for the prospect (the market, competitors, positioning and offer, channel plan, investment tiers, 90-day plan) and your internal talking notes. Separate from the proposal. Takes several minutes; you&apos;ll get a notification.</p>
      </div>

      {live && (
        <div className="flex items-center gap-2 rounded-[14px] bg-bg px-3 py-3 text-[13.5px]">
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current/30 border-t-current" aria-hidden />
          {state?.status === "queued" && !state.stage ? "Queued: it starts within a few minutes…" : (STAGE[state?.stage ?? ""] ?? "Working…")}
        </div>
      )}

      {gtm?.status === "done" && (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={download} disabled={pending || !gtm.documentId} className="inline-flex h-11 items-center justify-center rounded-full bg-brand px-5 text-[14px] font-medium text-white hover:bg-brand-hover disabled:opacity-60 md:h-9 md:text-[13px]">
              Download the PDF{gtm.partner ? ` (${gtm.partner})` : ""}
            </button>
            <span className="text-[12.5px] text-faint">Save it to Drive or email it: ask your assistant (it confirms the folder first).</span>
          </div>
          {gtm.notes && <Notes notes={gtm.notes} />}
        </div>
      )}
      {gtm?.status === "failed" && <p className="text-[13.5px] text-bad">The last one didn&apos;t finish: {gtm.error ?? "unknown error"}.</p>}

      {!live && (
        <form
          className="grid gap-2 md:grid-cols-[180px_minmax(0,1fr)_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            start(async () => {
              const r = await startGtmAction(prospectId, partner || null, ask);
              if (!r.ok) setError(r.error);
              else {
                setState({ status: "queued", stage: null });
                router.refresh();
              }
            });
          }}
        >
          <label className="grid">
            <span className="sr-only">Branding</span>
            <select value={partner} onChange={(e) => setPartner(e.target.value)} className="h-11 rounded-[14px] border border-line bg-bg px-3 text-[16px] text-fg md:text-[14px]">
              <option value="">Kaizen branding</option>
              {partners.map((p) => (
                <option key={p.key} value={p.key}>
                  White label: {p.name}
                </option>
              ))}
            </select>
          </label>
          <input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Anything to focus on? (channels, the creative package, who it's for)" className="h-11 min-w-0 rounded-[14px] border border-line bg-bg px-3.5 text-[16px] text-fg placeholder:text-faint md:text-[14px]" />
          <button type="submit" disabled={pending} className="inline-flex h-11 items-center justify-center rounded-full border border-line bg-surface px-5 text-[14px] font-medium text-fg hover:bg-surface-2 disabled:opacity-60">
            {gtm?.status === "done" ? "Build a new version" : "Build it"}
          </button>
        </form>
      )}
      {error && <p className="text-[13px] text-bad">{error}</p>}
    </section>
  );
}

function Notes({ notes }: { notes: GtmNotes }) {
  const sections: [string, GtmNotes["flags"]][] = [
    ["Flags", notes.flags],
    ["Strategy decisions", notes.decisions],
    ["Numbers caveats", notes.caveats],
    ["Risks and objections", notes.risks],
    ["Firm facts", notes.facts],
  ];
  return (
    <details className="group rounded-[16px] border border-line bg-bg p-4">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 text-[14px] font-medium md:min-h-0">
        Internal talking notes{notes.partner_label ? ` · for ${notes.partner_label} only` : " · never sent"}
        <span className="text-[12px] font-normal text-faint group-open:hidden">Open</span>
      </summary>
      <div className="mt-3 grid gap-4">
        {notes.headline && <p className="break-words text-[14px] leading-relaxed">{notes.headline}</p>}
        {sections
          .filter(([, xs]) => xs.length)
          .map(([title, xs]) => (
            <div key={title} className="grid gap-1.5">
              <p className="text-[12px] font-medium text-faint">{title}</p>
              <ul className="grid gap-1.5">
                {xs.map((x, i) => (
                  <li key={i} className="break-words text-[13.5px] leading-relaxed">
                    {x.text} <span className={x.tag === "certain" ? "text-ok" : x.tag === "likely" ? "text-warn" : "text-faint"}>{TAG_LABEL[x.tag]}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
      </div>
    </details>
  );
}
