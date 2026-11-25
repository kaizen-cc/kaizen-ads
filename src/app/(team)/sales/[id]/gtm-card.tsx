"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { modeLabel, TAG_LABEL, type GtmNotes } from "@/lib/sales-gtm-core";
import { prospectStamp } from "@/lib/sales-dates";
import { gtmPdfAction, gtmStatusAction, setRelationshipAction, startGtmAction } from "../actions";

// The prospect's go-to-market strategy, inside the Research view (no tab of its own): build it (Kaizen's branding or a
// white-label partner's), follow it while it's built in the background (researching → writing → talking notes → PDF),
// then download the client-facing PDF and read the internal talking notes, which are never sent. Saving to Drive or
// emailing it goes through the assistant (the Drive rule: the folder is said back for a yes first).

export type GtmView = { id: string; status: string; stage: string | null; partner: string | null; documentId: string | null; notes: GtmNotes | null; error: string | null; createdAt: string; assumed?: boolean };

// One bar from research to the PDF: where each stage sits on it, and what it says
const STAGE: Record<string, { label: string; at: number }> = {
  start: { label: "Starting…", at: 4 },
  refresh: { label: "Researching…", at: 6 },
  researching: { label: "Researching…", at: 20 },
  researched: { label: "Building the strategy…", at: 45 },
  writing: { label: "Building the strategy…", at: 60 },
  notes: { label: "Writing your talking notes…", at: 82 },
  pdf: { label: "Rendering the PDF…", at: 94 },
};
const stageOf = (s: string | null) => STAGE[s ?? "start"] ?? STAGE.start;

/** The branding badge: which mode is active, so nobody sends the wrong brand */
export function ModeBadge({ relationship, partner }: { relationship: string | null; partner: string | null }) {
  const tone = relationship === "white_label" ? "bg-warn-soft text-warn" : relationship === "direct" ? "bg-brand-soft text-brand-text" : "bg-surface-2 text-faint";
  return <span className={`inline-flex w-fit items-center rounded-full px-2.5 py-1 text-[12px] font-medium ${tone}`}>{modeLabel(relationship, partner)}</span>;
}

export function GtmCard({ prospectId, gtm, earlier = [], partners, relationship, partnerKey }: { prospectId: string; gtm: GtmView | null; earlier?: { documentId: string; partner: string | null; createdAt: string }[]; partners: { key: string; name: string; confirmed: boolean }[]; relationship: "direct" | "white_label" | null; partnerKey: string | null }) {
  const router = useRouter();
  const mode = relationship === "white_label" && partnerKey ? `p:${partnerKey}` : relationship === "direct" ? "direct" : "";
  const partnerName = partners.find((x) => x.key === partnerKey)?.name ?? null;
  const kitMissing = relationship === "white_label" && partnerKey && !partners.find((x) => x.key === partnerKey)?.confirmed;
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

  const download = (documentId: string | null | undefined = gtm?.documentId) =>
    start(async () => {
      if (!documentId) return;
      const r = await gtmPdfAction(documentId);
      if (!r.ok) setError(r.error);
      else window.open(r.url, "_blank", "noopener,noreferrer");
    });

  return (
    <section id="gtm" className="grid min-w-0 scroll-mt-20 gap-3 rounded-[20px] border border-line bg-surface p-4 md:p-6">
      <div className="grid gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.16em] text-faint">Go-to-market strategy</h2>
          {gtm?.assumed ? <span className="inline-flex w-fit items-center rounded-full bg-warn-soft px-2.5 py-1 text-[12px] font-medium text-warn">Assumed Kaizen: switch?</span> : <ModeBadge relationship={relationship} partner={partnerName} />}
        </div>
        <p className="text-[13.5px] leading-relaxed text-muted">A branded PDF for the prospect (the market, competitors, positioning and offer, channel plan, investment tiers, 90-day plan) and your internal talking notes. Separate from the proposal. It builds by itself whenever the research runs; you&apos;ll get one notification when the PDF is ready.</p>
      </div>

      {live && (
        <div className="grid gap-2 rounded-[14px] bg-bg px-3 py-3" role="status" aria-live="polite">
          <div className="flex items-center justify-between gap-2 text-[13.5px]">
            <span className="flex min-w-0 items-center gap-2">
              <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current/30 border-t-current" aria-hidden />
              <span className="truncate">{stageOf(state?.stage ?? null).label}</span>
            </span>
            <span className="shrink-0 text-[12px] text-faint">Research → strategy → PDF</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
            <div className="h-full rounded-full bg-brand transition-[width] duration-700" style={{ width: `${stageOf(state?.stage ?? null).at}%` }} />
          </div>
          <p className="text-[12px] text-faint">Several minutes. You can leave this page; the PDF lands here and you get a notification.</p>
        </div>
      )}

      {gtm?.status === "done" && (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => download()} disabled={pending || !gtm.documentId} className="inline-flex h-11 items-center justify-center rounded-full bg-brand px-5 text-[14px] font-medium text-white hover:bg-brand-hover disabled:opacity-60 md:h-9 md:text-[13px]">
              Download the PDF · {gtm.partner ? `${gtm.partner} branding` : "Kaizen branding"}
            </button>
            <span className="text-[12.5px] text-faint">Save it to Drive or email it: ask your assistant (it confirms the folder first).</span>
          </div>
          {gtm.notes && <Notes notes={gtm.notes} />}
        </div>
      )}
      {gtm?.status === "failed" && <p className="text-[13.5px] text-bad">The last one didn&apos;t finish: {gtm.error ?? "unknown error"}.</p>}

      {earlier.length > 0 && (
        <details className="group rounded-[16px] border border-line bg-bg p-3">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 text-[13.5px] font-medium md:min-h-0">
            Earlier versions ({earlier.length})
            <span className="text-[12px] font-normal text-faint group-open:hidden">Open</span>
          </summary>
          <ul className="mt-2 grid gap-1">
            {earlier.map((e) => (
              <li key={e.documentId}>
                <button type="button" onClick={() => download(e.documentId)} disabled={pending} className="flex min-h-11 w-full items-center justify-between gap-2 rounded-[12px] px-2 text-left text-[13.5px] hover:bg-surface-2 md:min-h-9">
                  <span className="min-w-0 truncate">{prospectStamp(e.createdAt)}</span>
                  <span className="shrink-0 text-[12px] text-faint">{e.partner ? `${e.partner} branding` : "Kaizen branding"} · Download</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {!live && (
        <form
          className="grid gap-2 md:grid-cols-[220px_minmax(0,1fr)_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            start(async () => {
              const r = await startGtmAction(prospectId, ask);
              if (!r.ok) setError(r.error);
              else {
                setState({ status: "queued", stage: null });
                router.refresh();
              }
            });
          }}
        >
          <label className="grid">
            <span className="sr-only">Direct Kaizen deal or white-label pitch</span>
            <select
              value={mode}
              onChange={(e) => {
                const v = e.target.value;
                setError(null);
                start(async () => {
                  const r = await setRelationshipAction(prospectId, v === "direct" ? "direct" : "white_label", v.startsWith("p:") ? v.slice(2) : null);
                  if (!r.ok) setError(r.error);
                  else router.refresh();
                });
              }}
              className="h-11 rounded-[14px] border border-line bg-bg px-3 text-[16px] text-fg md:text-[14px]"
            >
              <option value="" disabled>
                Direct deal or white label?
              </option>
              <option value="direct">Direct · Kaizen branding</option>
              {partners.map((p) => (
                <option key={p.key} value={`p:${p.key}`}>
                  White label · {p.name}
                </option>
              ))}
            </select>
          </label>
          <input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Anything to focus on? (channels, the creative package, who it's for)" className="h-11 min-w-0 rounded-[14px] border border-line bg-bg px-3.5 text-[16px] text-fg placeholder:text-faint md:text-[14px]" />
          <button type="submit" disabled={pending || !mode || Boolean(kitMissing)} className="inline-flex h-11 items-center justify-center rounded-full border border-line bg-surface px-5 text-[14px] font-medium text-fg hover:bg-surface-2 disabled:opacity-60">
            {gtm ? "Rebuild" : "Generate strategy"}
          </button>
        </form>
      )}
      {!live && !mode && <p className="text-[12.5px] text-warn">Is this a direct Kaizen deal or a white-label pitch for a partner agency? Set it and the strategy builds right away: the PDF, the notes and the proposal follow it.</p>}
      {gtm?.assumed && !live && <p className="text-[12.5px] text-warn">Built ahead of the sales call in Kaizen&apos;s branding because nobody said otherwise. If it&apos;s a partner pitch, pick the partner above: it rebuilds in their branding.</p>}
      {kitMissing && <p className="text-[12.5px] text-warn">{partnerName}&apos;s brand kit isn&apos;t confirmed yet. Ask your assistant to set it up (it pulls the logo from their site for a yes).</p>}
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
