"use client";

import { useEffect, useRef, useState } from "react";
import type { Ad } from "@/lib/copy";
import type { PortalData, PortalDesign, PortalFile, PortalItem, PortalRow } from "@/lib/portal";
import { submitReview, type Pin, type PieceDecision } from "./actions";

// The client portal. Home: what's waiting on them, what we're changing, what's live, what's launching. Reviewing a
// ticket is a guided pass: why we made it (audience, strategy), then each design, then each copy, one at a time, each
// approved or sent back with notes (pins on the creative, comments on the video timeline). A preview of any design with
// any copy is one tap away, and works like the real ad (headline and button open the landing page).

const LIMIT = 125;
const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms / 1000) % 60)).padStart(2, "0")}`;
const sizeLabel = (a: string | null) => (!a ? "" : a === "191x100" ? "1.91:1" : a.includes("x") && a.length <= 5 ? a.replace("x", ":") : a.replace("x", "×"));
const ratio = (a: string | null) => (a === "1x1" ? "1 / 1" : a === "9x16" ? "9 / 16" : a === "16x9" ? "16 / 9" : "4 / 5");
const isVideo = (f: PortalFile) => f.mime.startsWith("video/");
const host = (url: string) => url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0];

export function Portal({ slug, clientName, firstName, data, testing, live, demo = false }: { slug: string; clientName: string; firstName: string | null; data: PortalData; testing: boolean; live: boolean; demo?: boolean }) {
  const [queue, setQueue] = useState(data.items);
  const [open, setOpen] = useState<PortalItem | null>(null);
  const pieces = (i: PortalItem) => i.designs.filter((d) => !d.context && d.clientStatus !== "approved").length + i.ads.filter((a) => a.status !== "approved").length;
  const total = queue.reduce((n, i) => n + pieces(i), 0);

  return (
    <>
      {testing && (
        <div className="bg-brand px-4 py-2 text-center text-xs leading-relaxed text-white">
          {live ? "You're previewing the portal as a Kaizen team member." : `The portal isn't live for ${clientName}: they can't sign in or see any of this, and nothing is sent to them.`}{" "}
          <b>Decisions you make here are real</b>: they move the tickets as if the client made them.
        </div>
      )}

      <main className="mx-auto grid max-w-md gap-4 px-4 pb-16 pt-4">
        <section className="grid gap-2.5 rounded-[12px] bg-brand p-4 text-white">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-white/75">Waiting on you</p>
          <h1 className="font-heading text-[20px] font-semibold leading-tight">
            {queue.length ? `${total} ${total === 1 ? "piece is" : "pieces are"} ready for your review` : firstName ? `You're all caught up, ${firstName}` : "You're all caught up"}
          </h1>
          <p className="text-[12.5px] text-white/90">
            {queue.length ? `${queue.length} ${queue.length === 1 ? "batch" : "batches"}. Approve or ask for changes on each design and each copy.` : "When your Kaizen team sends new ads, they'll show up here."}
          </p>
          {queue.length > 0 && (
            <button onClick={() => setOpen(queue[0])} className="justify-self-start rounded-[5px] bg-white px-3.5 py-2 text-[13px] font-semibold text-[#7f1420]">
              Start reviewing →
            </button>
          )}
        </section>

        {queue.length > 1 && (
          <section className="grid gap-2">
            {queue.map((i) => (
              <button key={i.id} onClick={() => setOpen(i)} className="flex items-center gap-2.5 rounded-[8px] border border-line bg-surface p-2.5 text-left hover:border-faint">
                <Thumb url={cover(i)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{i.title}</span>
                  <span className="text-[11.5px] text-muted">
                    {pieces(i)} to review{i.revised ? " · revised" : ""}
                  </span>
                </span>
                <span className="text-muted">→</span>
              </button>
            ))}
          </section>
        )}

        <Rows title="In revision" pill={data.revising.length} tone="warn" rows={data.revising} empty="Nothing in revision." />

        <section className="grid gap-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-[13px] font-semibold">Running now</h2>
            {data.running.syncedAt && <span className="text-[11.5px] text-muted">synced {ago(data.running.syncedAt)}</span>}
          </div>
          {data.running.ads.length ? (
            <div className="grid grid-cols-3 gap-2">
              {data.running.ads.map((a) => (
                <div key={a.id} className="relative aspect-[4/5] overflow-hidden rounded-[8px] bg-surface-2" title={a.headline ?? a.name}>
                  {a.thumbnail ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={a.thumbnail} alt={a.headline ?? a.name} className="absolute inset-0 h-full w-full object-cover" />
                  ) : (
                    <span className="absolute inset-0 grid place-items-center p-2 text-center text-[10px] text-muted">{a.headline ?? a.name}</span>
                  )}
                  <span className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-full bg-black/55 px-1.5 py-px text-[9.5px] text-white">
                    <i className="h-1.5 w-1.5 rounded-full bg-[#3fb27f]" />
                    Live
                  </span>
                  {a.headline && <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/75 to-transparent px-2 pb-1.5 pt-4 text-[10px] font-medium text-white">{a.headline}</span>}
                </div>
              ))}
            </div>
          ) : (
            <Empty>Your live ads will show up here.</Empty>
          )}
        </section>

        <Rows title="Approved · launching soon" pill={data.approved.length} tone="ok" rows={data.approved} empty="Nothing waiting to launch." />
      </main>

      {open && (
        <Session
          key={open.id}
          slug={slug}
          clientName={clientName}
          item={open}
          demo={demo}
          next={queue.filter((i) => i.id !== open.id)[0] ?? null}
          onSent={() => setQueue((q) => q.filter((i) => i.id !== open.id))}
          onNext={(i) => setOpen(i)}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

const cover = (i: PortalItem) => {
  const f = i.designs[0]?.files.find((x) => x.aspect === "4x5") ?? i.designs[0]?.files[0];
  return f?.thumbUrl ?? (f && !isVideo(f) ? f.url : null) ?? null;
};

function ago(iso: string) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 60 ? `${Math.max(1, m)} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}

function Thumb({ url }: { url: string | null }) {
  return (
    <div className="relative h-11 w-11 shrink-0 overflow-hidden rounded-[6px] bg-surface-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {url && <img src={url} alt="" className="absolute inset-0 h-full w-full object-cover" />}
    </div>
  );
}

function Rows({ title, pill, tone, rows, empty }: { title: string; pill: number; tone: "ok" | "warn"; rows: PortalRow[]; empty: string }) {
  return (
    <section className="grid gap-2">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[13px] font-semibold">{title}</h2>
        {pill > 0 && <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${tone === "ok" ? "bg-ok/15 text-ok" : "bg-warn-soft text-warn"}`}>{pill}</span>}
      </div>
      {rows.length ? (
        rows.map((r) => (
          <div key={r.id} className="flex items-center gap-2.5 rounded-[8px] border border-line bg-surface p-2.5">
            <Thumb url={r.thumbUrl} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium">{r.title}</p>
              <p className="line-clamp-2 text-[11.5px] text-muted">{r.note}</p>
            </div>
          </div>
        ))
      ) : (
        <Empty>{empty}</Empty>
      )}
    </section>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => <p className="rounded-[8px] border border-dashed border-line px-4 py-4 text-center text-[12.5px] text-faint">{children}</p>;

// ─── One ticket's review ────────────────────────────────────────────────────

type Step = { kind: "intro" } | { kind: "design"; design: PortalDesign; n: number; of: number } | { kind: "copy"; index: number; n: number; of: number } | { kind: "recap" };
type DesignChoice = { decision: PieceDecision; note: string; pins: (Pin & { n: number })[] };
type AdChoice = { decision: PieceDecision; note: string };

function Session({ slug, clientName, item, demo, next, onSent, onNext, onClose }: { slug: string; clientName: string; item: PortalItem; demo: boolean; next: PortalItem | null; onSent: () => void; onNext: (i: PortalItem) => void; onClose: () => void }) {
  const designs = item.designs.filter((d) => !d.context && d.clientStatus !== "approved");
  const adIdx = item.ads.map((a, i) => (a.status === "approved" ? -1 : i)).filter((i) => i >= 0);
  const steps: Step[] = [
    { kind: "intro" },
    ...designs.map((d, i) => ({ kind: "design" as const, design: d, n: i + 1, of: designs.length })),
    ...adIdx.map((index, i) => ({ kind: "copy" as const, index, n: i + 1, of: adIdx.length })),
    { kind: "recap" },
  ];
  const [at, setAt] = useState(0);
  const [dChoice, setDChoice] = useState<Record<string, DesignChoice>>({});
  const [aChoice, setAChoice] = useState<Record<number, AdChoice>>({});
  const [editing, setEditing] = useState(false); // writing what to change on the current piece
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ split: number | null } | null>(null);
  const step = steps[at];

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  const go = (i: number) => {
    setEditing(false);
    setAt(Math.max(0, Math.min(steps.length - 1, i)));
  };
  const decideDesign = (d: PortalDesign, c: DesignChoice) => {
    setDChoice((x) => ({ ...x, [d.id]: c }));
    go(at + 1);
  };
  const decideAd = (i: number, c: AdChoice) => {
    setAChoice((x) => ({ ...x, [i]: c }));
    go(at + 1);
  };

  // ← changes, → approve (on a piece)
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (editing || preview || (e.target as HTMLElement).closest("textarea, input")) return;
      if (e.key === "Escape") onClose();
      if (step.kind === "design") {
        if (e.key === "ArrowRight") decideDesign(step.design, { decision: "approved", note: "", pins: [] });
        if (e.key === "ArrowLeft") setEditing(true);
      }
      if (step.kind === "copy") {
        if (e.key === "ArrowRight") decideAd(step.index, { decision: "approved", note: "" });
        if (e.key === "ArrowLeft") setEditing(true);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  const send = async () => {
    setBusy(true);
    setError(null);
    const review = {
      requestId: item.id,
      designs: designs.map((d) => ({ designId: d.id, decision: dChoice[d.id].decision, note: dChoice[d.id].note, pins: dChoice[d.id].pins.map((p) => ({ designId: p.designId, version: p.version, fileId: p.fileId, x: p.x, y: p.y, tMs: p.tMs, body: p.body })) })),
      ads: adIdx.map((i) => ({ index: i, decision: aChoice[i].decision, note: aChoice[i].note })),
    };
    const approvedD = review.designs.filter((d) => d.decision === "approved").length + item.designs.filter((d) => !d.context && d.clientStatus === "approved").length;
    const approvedA = review.ads.filter((a) => a.decision === "approved").length + item.ads.filter((a) => a.status === "approved").length;
    const anyChanges = review.designs.some((d) => d.decision === "changes") || review.ads.some((a) => a.decision === "changes");
    const r = demo ? { ok: true as const, splitNumber: anyChanges && approvedD && approvedA ? item.number + 8 : null } : await submitReview(slug, review);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setSent({ split: r.splitNumber });
    onSent();
  };

  const allDecided = designs.every((d) => dChoice[d.id]) && adIdx.every((i) => aChoice[i]);
  const changes = designs.filter((d) => dChoice[d.id]?.decision === "changes").length + adIdx.filter((i) => aChoice[i]?.decision === "changes").length;
  const approvals = designs.filter((d) => dChoice[d.id]?.decision === "approved").length + adIdx.filter((i) => aChoice[i]?.decision === "approved").length;

  return (
    <div className="fixed inset-0 z-50 grid bg-bg/95 backdrop-blur sm:place-items-center sm:p-6">
      <div className="relative flex h-full w-full flex-col overflow-hidden bg-bg sm:h-[min(880px,100%)] sm:max-w-[430px] sm:rounded-[28px] sm:border sm:border-line sm:shadow-[0_20px_60px_rgba(0,0,0,0.55)]">
        {/* Top: close or back, progress, preview */}
        <div className="flex items-center gap-2 px-3 pb-2 pt-[max(12px,env(safe-area-inset-top))]">
          <button onClick={sent ? onClose : at > 0 ? () => go(at - 1) : onClose} aria-label={at > 0 && !sent ? "Back" : "Close"} className="grid h-8 w-8 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg">
            {at > 0 && !sent ? "←" : "✕"}
          </button>
          <div className="flex flex-1 gap-[3px]">
            {steps.map((_, i) => (
              <i key={i} className={`block h-[3px] flex-1 rounded-full ${sent || i < at ? "bg-brand" : i === at ? "bg-brand/50" : "bg-surface-3"}`} />
            ))}
          </div>
          {!sent && (
            <button onClick={() => setPreview(true)} className="flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-[11.5px] text-muted hover:text-fg">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5" aria-hidden>
                <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
              </svg>
              Preview
            </button>
          )}
        </div>

        {sent ? (
          <div className="grid flex-1 place-items-center p-6 text-center">
            <div className="grid justify-items-center gap-2">
              <span className="grid h-14 w-14 place-items-center rounded-full bg-ok/15 text-2xl text-ok">✓</span>
              <h3 className="mt-2 text-[20px] font-semibold">Sent to your Kaizen team</h3>
              <p className="max-w-[30ch] text-sm text-muted">
                {changes === 0
                  ? "Everything's approved. We'll get it live."
                  : sent.split
                    ? `What you approved is going live first. We're working on the ${changes} change${changes === 1 ? "" : "s"} you asked for and will send ${changes === 1 ? "it" : "them"} back to you.`
                    : `We're working on the ${changes} change${changes === 1 ? "" : "s"} you asked for and will send ${changes === 1 ? "it" : "them"} back to you.`}
              </p>
              {next ? (
                <button onClick={() => onNext(next)} className="mt-3 rounded-[5px] bg-brand px-4 py-2 text-sm font-medium text-white">
                  Next: {next.title} →
                </button>
              ) : (
                <button onClick={onClose} className="mt-3 rounded-[5px] bg-brand px-4 py-2 text-sm font-medium text-white">
                  Back to home
                </button>
              )}
            </div>
          </div>
        ) : step.kind === "intro" ? (
          <Intro item={item} designs={designs.length} ads={adIdx.length} onStart={() => go(1)} />
        ) : step.kind === "design" ? (
          editing ? (
            <MarkDesign
              key={step.design.id}
              item={item}
              design={step.design}
              initial={dChoice[step.design.id]}
              onCancel={() => setEditing(false)}
              onSave={(pins, note) => decideDesign(step.design, { decision: "changes", note, pins })}
            />
          ) : (
            <DesignStep key={step.design.id} item={item} step={step} choice={dChoice[step.design.id]} onApprove={() => decideDesign(step.design, { decision: "approved", note: "", pins: [] })} onChanges={() => setEditing(true)} />
          )
        ) : step.kind === "copy" ? (
          <CopyStep
            key={step.index}
            item={item}
            step={step}
            choice={aChoice[step.index]}
            editing={editing}
            onApprove={() => decideAd(step.index, { decision: "approved", note: "" })}
            onChanges={() => setEditing(true)}
            onCancel={() => setEditing(false)}
            onSave={(note) => decideAd(step.index, { decision: "changes", note })}
          />
        ) : (
          <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-2">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">Your review</p>
              <h3 className="text-[18px] font-semibold leading-tight">{item.title}</h3>
              <p className="mt-1 text-[12.5px] text-muted">
                {approvals} approved · {changes} with changes. Tap any piece to change your answer.
              </p>
            </div>
            {designs.map((d, i) => {
              const c = dChoice[d.id];
              return (
                <button key={d.id} onClick={() => go(1 + i)} className="flex items-center gap-2.5 rounded-[8px] border border-line bg-surface p-2.5 text-left">
                  <Thumb url={d.files[0]?.thumbUrl ?? (d.files[0] && !isVideo(d.files[0]) ? d.files[0].url : null)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">
                      {item.format === "video" ? "Video" : "Design"} {i + 1}
                    </span>
                    <span className="line-clamp-1 text-[11.5px] text-muted">{c?.decision === "changes" ? c.note || `${c.pins.length} note${c.pins.length === 1 ? "" : "s"}` : d.name}</span>
                  </span>
                  <Chip choice={c?.decision} />
                </button>
              );
            })}
            {adIdx.map((ai, i) => {
              const c = aChoice[ai];
              return (
                <button key={ai} onClick={() => go(1 + designs.length + i)} className="flex items-center gap-2.5 rounded-[8px] border border-line bg-surface p-2.5 text-left">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[6px] bg-surface-2 text-[11px] font-semibold text-muted">Aa</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">Copy {i + 1}</span>
                    <span className="line-clamp-1 text-[11.5px] text-muted">{c?.decision === "changes" ? c.note : item.ads[ai].ad.primaryText.split("\n")[0]}</span>
                  </span>
                  <Chip choice={c?.decision} />
                </button>
              );
            })}
            {changes > 0 && approvals > 0 && (
              <p className="rounded-[8px] bg-surface px-3 py-2 text-[11.5px] text-muted">What you approve can go live first, while we work on the rest. Approved pieces won&apos;t be changed.</p>
            )}
            {error && <p className="text-xs text-bad">{error}</p>}
            <button disabled={busy || !allDecided} onClick={send} className="h-11 rounded-[5px] bg-brand text-sm font-medium text-white disabled:opacity-40">
              {busy ? "Sending…" : allDecided ? "Send to Kaizen" : "Decide on every piece first"}
            </button>
          </div>
        )}

        {preview && <Preview item={item} clientName={clientName} onClose={() => setPreview(false)} />}
      </div>
    </div>
  );
}

const Chip = ({ choice }: { choice?: PieceDecision }) =>
  choice === "approved" ? (
    <span className="shrink-0 rounded-full bg-ok/15 px-2 py-0.5 text-[11px] font-medium text-ok">✓ Approved</span>
  ) : choice === "changes" ? (
    <span className="shrink-0 rounded-full bg-warn-soft px-2 py-0.5 text-[11px] font-medium text-warn">✎ Changes</span>
  ) : (
    <span className="shrink-0 rounded-full bg-surface-3 px-2 py-0.5 text-[11px] text-muted">To review</span>
  );

function Intro({ item, designs, ads, onStart }: { item: PortalItem; designs: number; ads: number; onStart: () => void }) {
  const s = item.summary;
  return (
    <div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-2">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">{item.revised ? `Revised · round ${item.revised.round + 1}` : "Before you review"}</p>
        <h3 className="text-[22px] font-semibold leading-tight">{item.title}</h3>
      </div>
      {item.revised && item.revised.changes.length > 0 && (
        <div className="grid gap-2 rounded-[12px] border border-brand-text/30 bg-brand-soft/30 p-3.5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-brand-text">What you asked · what we changed</p>
          {item.revised.changes.map((c, i) => (
            <div key={i} className="grid gap-0.5 text-[12.5px]">
              <span className="text-muted">You asked: {c.asked}</span>
              <span>✓ {c.changed}</span>
            </div>
          ))}
        </div>
      )}
      {s ? (
        <div className="grid gap-3">
          {(
            [
              ["Why we made this", s.why],
              ["Who it's for", s.audience],
              ["The strategy", s.strategy],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="grid gap-1 rounded-[10px] border border-line bg-surface p-3.5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">{k}</p>
              <p className="text-[13.5px] leading-relaxed">{v}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-[10px] border border-line bg-surface p-3.5 text-[13px] text-muted">Your Kaizen team made these ads for you. Look at each design and each copy, and approve it or tell us what to change.</p>
      )}
      {item.landingUrl && (
        <a href={item.landingUrl} target="_blank" rel="noreferrer" className="flex items-center justify-between gap-2 rounded-[10px] border border-line bg-surface px-3.5 py-2.5 text-[12.5px]">
          <span className="text-muted">Where the ads send people</span>
          <span className="truncate text-brand-text">{host(item.landingUrl)} ↗</span>
        </a>
      )}
      <div className="grid gap-2 pt-1">
        <p className="text-center text-[12px] text-muted">
          You&apos;ll review {designs ? `${designs} ${item.format === "video" ? "video" : "design"}${designs === 1 ? "" : "s"}` : ""}
          {designs && ads ? " and " : ""}
          {ads ? `${ads} cop${ads === 1 ? "y" : "ies"}` : ""}, one at a time.
        </p>
        <button onClick={onStart} className="h-11 rounded-[5px] bg-brand text-sm font-medium text-white">
          Start →
        </button>
      </div>
    </div>
  );
}

/** Drag left or right on a piece; past the line it decides. */
function useSwipe(onApprove: () => void, onChanges: () => void) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<number | null>(null);
  const bind = {
    onPointerDown: (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest("button, video, a, textarea, input")) return;
      start.current = e.clientX;
      setDragging(true);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent) => start.current !== null && setDx(e.clientX - start.current),
    onPointerUp: () => {
      if (start.current === null) return;
      start.current = null;
      setDragging(false);
      if (dx > 110) onApprove();
      else if (dx < -110) onChanges();
      setDx(0);
    },
    onPointerCancel: () => {
      start.current = null;
      setDragging(false);
      setDx(0);
    },
  };
  const style = { transform: `translateX(${dx}px) rotate(${dx / 24}deg)`, transition: dragging ? "none" : "transform .25s ease" };
  return { bind, style, dx };
}

function Stamps({ dx }: { dx: number }) {
  return (
    <>
      <span className="pointer-events-none absolute left-4 top-4 z-10 -rotate-[10deg] rounded-[6px] border-[3px] border-ok px-2.5 py-0.5 text-[20px] font-bold tracking-[0.04em] text-ok" style={{ opacity: Math.max(0, Math.min(1, dx / 110)) }}>
        APPROVE
      </span>
      <span className="pointer-events-none absolute right-4 top-4 z-10 rotate-[10deg] rounded-[6px] border-[3px] border-warn px-2.5 py-0.5 text-[20px] font-bold tracking-[0.04em] text-warn" style={{ opacity: Math.max(0, Math.min(1, -dx / 110)) }}>
        CHANGES
      </span>
    </>
  );
}

function Decide({ onApprove, onChanges }: { onApprove: () => void; onChanges: () => void }) {
  return (
    <>
      <div className="flex items-center justify-center gap-[18px] pb-1 pt-3">
        <button onClick={onChanges} aria-label="Ask for changes" className="grid h-[54px] w-[54px] place-items-center rounded-full border border-line bg-surface text-[20px] font-semibold text-warn">
          ✎
        </button>
        <button onClick={onApprove} aria-label="Approve" className="grid h-[62px] w-[62px] place-items-center rounded-full bg-ok text-[24px] font-semibold text-white shadow-[0_10px_30px_-10px_rgba(63,178,127,0.9)]">
          ✓
        </button>
      </div>
      <p className="pb-[max(10px,env(safe-area-inset-bottom))] text-center text-[10.5px] text-faint">← changes · → approve</p>
    </>
  );
}

function DesignStep({ item, step, choice, onApprove, onChanges }: { item: PortalItem; step: Extract<Step, { kind: "design" }>; choice?: DesignChoice; onApprove: () => void; onChanges: () => void }) {
  const [fi, setFi] = useState(0);
  const d = step.design;
  const file = d.files[fi] ?? d.files[0];
  const { bind, style, dx } = useSwipe(onApprove, onChanges);
  const label = item.format === "video" ? "Video" : "Design";
  return (
    <>
      <div className="flex items-center justify-between gap-2 px-4 pb-2">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">
            {label} {step.n} of {step.of}
          </p>
          <p className="truncate text-[15px] font-semibold">{d.name}</p>
        </div>
        <span className="flex shrink-0 items-center gap-1.5">
          {d.clientStatus === "changes" && <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand-text">Revised</span>}
          {choice && <Chip choice={choice.decision} />}
        </span>
      </div>
      <div {...bind} style={style} className="relative mx-3 flex min-h-0 flex-1 touch-pan-y select-none flex-col overflow-hidden rounded-[14px] border border-line bg-surface">
        <Stamps dx={dx} />
        <Media file={file} />
        {d.files.length > 1 && (
          <div className="flex flex-wrap justify-center gap-1.5 px-3 py-2.5">
            {d.files.map((f, i) => (
              <button key={f.id} aria-pressed={i === fi} onClick={() => setFi(i)} className={`rounded-full border px-2.5 py-0.5 text-[10.5px] ${i === fi ? "border-fg bg-fg text-bg" : "border-line text-muted"}`}>
                {item.format === "carousel" ? `Card ${i + 1}` : sizeLabel(f.aspect)}
              </button>
            ))}
          </div>
        )}
      </div>
      <Decide onApprove={onApprove} onChanges={onChanges} />
    </>
  );
}

function CopyStep({
  item,
  step,
  choice,
  editing,
  onApprove,
  onChanges,
  onCancel,
  onSave,
}: {
  item: PortalItem;
  step: Extract<Step, { kind: "copy" }>;
  choice?: AdChoice;
  editing: boolean;
  onApprove: () => void;
  onChanges: () => void;
  onCancel: () => void;
  onSave: (note: string) => void;
}) {
  const { ad, status } = item.ads[step.index];
  const [note, setNote] = useState(choice?.decision === "changes" ? choice.note : "");
  const { bind, style, dx } = useSwipe(onApprove, onChanges);
  return (
    <>
      <div className="flex items-center justify-between gap-2 px-4 pb-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">
            Copy {step.n} of {step.of}
          </p>
          <p className="text-[15px] font-semibold">{ad.kind === "long" ? "Long-form" : "Short-form"}</p>
        </div>
        <span className="flex shrink-0 items-center gap-1.5">
          {status === "changes" && <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand-text">Revised</span>}
          {choice && <Chip choice={choice.decision} />}
        </span>
      </div>
      <div {...bind} style={style} className="relative mx-3 flex min-h-0 flex-1 touch-pan-y select-none flex-col overflow-hidden rounded-[14px] border border-line bg-surface">
        <Stamps dx={dx} />
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <p className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">Primary text</p>
          <p className="whitespace-pre-wrap text-[13.5px] leading-[1.55]">{ad.primaryText}</p>
          <div className="mt-4 grid gap-3 border-t border-line pt-3.5">
            <div>
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">Headline</p>
              <p className="text-[14px] font-semibold">{ad.headline}</p>
            </div>
            {ad.linkDescription && (
              <div>
                <p className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">Link description</p>
                <p className="text-[13px]">{ad.linkDescription}</p>
              </div>
            )}
            <div>
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">Button</p>
              <span className="mt-1 inline-block rounded-[4px] bg-surface-3 px-2.5 py-1 text-[12px] font-semibold">{ad.cta}</span>
            </div>
          </div>
        </div>
      </div>
      {editing ? (
        <div className="grid gap-2 px-4 pb-[max(14px,env(safe-area-inset-bottom))] pt-3">
          <p className="text-[13px] font-semibold">What should change in this copy?</p>
          <textarea
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Don't say 'cheap'. Add a couple of emojis."
            className="min-h-[76px] w-full resize-none rounded-[8px] border border-line bg-surface p-2.5 text-[13px] outline-none placeholder:text-faint focus:border-brand-text/60"
          />
          <p className="text-[11px] text-muted">We change only what you ask. If you&apos;d like it rewritten from scratch, just say so.</p>
          <div className="flex gap-2">
            <button onClick={onCancel} className="h-10 rounded-[5px] px-3 text-sm text-muted">
              Cancel
            </button>
            <button disabled={!note.trim()} onClick={() => onSave(note.trim())} className="h-10 flex-1 rounded-[5px] bg-brand text-sm font-medium text-white disabled:opacity-40">
              Save and continue
            </button>
          </div>
        </div>
      ) : (
        <Decide onApprove={onApprove} onChanges={onChanges} />
      )}
    </>
  );
}

function Media({ file, children, onTap, videoRef, onTime }: { file: PortalFile; children?: React.ReactNode; onTap?: (x: number, y: number) => void; videoRef?: React.RefObject<HTMLVideoElement | null>; onTime?: (ms: number) => void }) {
  return (
    <div className="relative grid min-h-0 flex-1 place-items-center overflow-hidden bg-black">
      <div
        className="relative h-full max-w-full overflow-hidden"
        style={{ aspectRatio: ratio(file.aspect) }}
        onClick={(e) => {
          if (!onTap) return;
          const r = e.currentTarget.getBoundingClientRect();
          onTap((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
        }}
      >
        {isVideo(file) ? (
          <video
            ref={videoRef}
            key={file.id}
            src={file.url ?? undefined}
            poster={file.thumbUrl ?? undefined}
            onTimeUpdate={(e) => onTime?.(Math.round(e.currentTarget.currentTime * 1000))}
            controls
            playsInline
            muted={!videoRef}
            loop={!videoRef}
            autoPlay={!videoRef}
            className="h-full w-full object-contain"
          />
        ) : file.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={file.url} alt="" draggable={false} className={`h-full w-full object-contain ${onTap ? "cursor-crosshair" : ""}`} />
        ) : (
          <span className="grid h-full w-full place-items-center text-xs text-white/60">Preview not available</span>
        )}
        {children}
      </div>
    </div>
  );
}

// ─── Marking what to change on one design ───────────────────────────────────

function MarkDesign({ item, design, initial, onCancel, onSave }: { item: PortalItem; design: PortalDesign; initial?: DesignChoice; onCancel: () => void; onSave: (pins: (Pin & { n: number })[], note: string) => void }) {
  const [fi, setFi] = useState(0);
  const [pins, setPins] = useState<(Pin & { n: number })[]>(initial?.decision === "changes" ? initial.pins : []);
  const [draft, setDraft] = useState<{ x: number | null; y: number | null; tMs: number | null } | null>(null);
  const [text, setText] = useState("");
  const [note, setNote] = useState(initial?.decision === "changes" ? initial.note : "");
  const [at, setAt] = useState(0);
  const video = useRef<HTMLVideoElement | null>(null);
  const file = design.files[fi] ?? design.files[0];
  const here = pins.filter((p) => p.fileId === file.id);

  const add = () => {
    if (!draft || !text.trim()) return;
    const n = (pins.at(-1)?.n ?? 0) + 1;
    setPins([...pins, { n, designId: design.id, version: design.version, fileId: file.id, x: draft.x, y: draft.y, tMs: draft.tMs, body: text.trim() }]);
    setDraft(null);
    setText("");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-4 pb-2">
        <div>
          <p className="text-[15px] font-semibold">Mark what to change</p>
          <p className="text-[11.5px] text-muted">{isVideo(file) ? "Pause where an edit is needed, then comment at that moment." : "Tap the creative where something should change."}</p>
        </div>
        <button onClick={onCancel} className="text-xs text-muted hover:text-fg">
          Cancel
        </button>
      </div>
      {design.files.length > 1 && (
        <div className="flex flex-wrap gap-1.5 px-4 pb-2">
          {design.files.map((f, i) => (
            <button key={f.id} onClick={() => (setFi(i), setDraft(null))} className={`rounded-full border px-2.5 py-0.5 text-[10.5px] ${i === fi ? "border-fg bg-fg text-bg" : "border-line text-muted"}`}>
              {item.format === "carousel" ? `Card ${i + 1}` : sizeLabel(f.aspect)}
            </button>
          ))}
        </div>
      )}
      <div className="mx-3 flex min-h-[36%] flex-1 overflow-hidden rounded-[12px] border border-line">
        <Media file={file} videoRef={video} onTime={setAt} onTap={isVideo(file) ? undefined : (x, y) => setDraft({ x, y, tMs: null })}>
          {here.map((p) =>
            p.x != null && p.y != null ? (
              <span key={p.n} className="absolute z-[4] -ml-[11px] -mt-[11px] grid h-[22px] w-[22px] place-items-center rounded-full border-2 border-white bg-warn text-[11px] font-bold text-[#111]" style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}>
                {p.n}
              </span>
            ) : null,
          )}
          {draft?.x != null && draft.y != null && <span className="absolute z-[4] -ml-[11px] -mt-[11px] h-[22px] w-[22px] animate-pulse rounded-full border-2 border-white bg-warn" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%` }} />}
        </Media>
      </div>
      <div className="grid min-h-0 gap-2.5 overflow-y-auto px-4 pb-[max(14px,env(safe-area-inset-bottom))] pt-3">
        {isVideo(file) && !draft && (
          <button
            onClick={() => {
              video.current?.pause();
              setDraft({ x: null, y: null, tMs: at });
            }}
            className="h-9 rounded-[8px] border border-warn/50 text-[12.5px] text-warn"
          >
            Comment at {clock(at)}
          </button>
        )}
        {draft && (
          <div className="grid gap-2 rounded-[10px] border border-warn/40 bg-warn-soft/40 p-2.5">
            <p className="text-[11.5px] text-muted">{draft.tMs != null ? `At ${clock(draft.tMs)}` : "Here"}: what should change?</p>
            <div className="flex gap-2">
              <input
                autoFocus
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && add()}
                placeholder="e.g. Make the logo bigger"
                className="h-9 min-w-0 flex-1 rounded-[6px] border border-line bg-surface px-2.5 text-[13px] outline-none focus:border-brand-text/60"
              />
              <button onClick={add} disabled={!text.trim()} className="rounded-[6px] bg-fg px-3 text-[12.5px] font-medium text-bg disabled:opacity-40">
                Add
              </button>
              <button onClick={() => (setDraft(null), setText(""))} className="px-1 text-xs text-muted">
                ✕
              </button>
            </div>
          </div>
        )}
        {pins.length > 0 && (
          <ol className="grid gap-1.5">
            {pins.map((p) => (
              <li key={p.n} className="flex items-start gap-2 rounded-[8px] bg-surface px-2.5 py-2 text-[12.5px]">
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-warn text-[10px] font-bold text-[#111]">{p.n}</span>
                <span className="min-w-0 flex-1">
                  {p.tMs != null && <span className="block text-[10.5px] text-faint">at {clock(p.tMs)}</span>}
                  {p.body}
                </span>
                <button onClick={() => setPins(pins.filter((x) => x.n !== p.n))} aria-label="Remove" className="text-xs text-faint hover:text-fg">
                  ✕
                </button>
              </li>
            ))}
          </ol>
        )}
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={`Anything else about this ${item.format === "video" ? "video" : "design"}? (optional)`}
          className="min-h-[56px] w-full resize-none rounded-[8px] border border-line bg-surface p-2.5 text-[13px] outline-none placeholder:text-faint focus:border-brand-text/60"
        />
        <button disabled={!pins.length && !note.trim()} onClick={() => onSave(pins, note.trim())} className="h-10 rounded-[5px] bg-brand text-sm font-medium text-white disabled:opacity-40">
          Save and continue
        </button>
      </div>
    </div>
  );
}

// ─── Preview: any design with any copy, as people will see it ──────────────

function Preview({ item, clientName, onClose }: { item: PortalItem; clientName: string; onClose: () => void }) {
  const [di, setDi] = useState(0);
  const [fi, setFi] = useState(0);
  const [ai, setAi] = useState(0);
  const [more, setMore] = useState(false);
  const design = item.designs[di];
  const file = design?.files[fi] ?? design?.files[0];
  const ad: Ad | undefined = item.ads[ai]?.ad;
  const text = ad?.primaryText ?? "";
  const cut = text.length > LIMIT && !more;
  const link = item.landingUrl;

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-bg animate-[step-in_.2s_ease-out]">
      <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-[max(12px,env(safe-area-inset-top))]">
        <p className="text-[15px] font-semibold">Preview</p>
        <button onClick={onClose} className="rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-fg">
          Done
        </button>
      </div>
      <div className="grid gap-1.5 px-4 pb-2">
        {item.designs.length > 1 && <Picker label={item.format === "video" ? "Video" : "Design"} count={item.designs.length} value={di} onChange={(i) => (setDi(i), setFi(0))} />}
        {design && design.files.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="w-12 text-[11px] text-faint">{item.format === "carousel" ? "Card" : "Size"}</span>
            {design.files.map((f, i) => (
              <button key={f.id} onClick={() => setFi(i)} className={`rounded-full border px-2.5 py-0.5 text-[10.5px] ${i === fi ? "border-fg bg-fg text-bg" : "border-line text-muted"}`}>
                {item.format === "carousel" ? i + 1 : sizeLabel(f.aspect)}
              </button>
            ))}
          </div>
        )}
        {item.ads.length > 1 && <Picker label="Copy" count={item.ads.length} value={ai} onChange={(i) => (setAi(i), setMore(false))} />}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-[max(16px,env(safe-area-inset-bottom))]">
        <div className="mx-auto max-w-[400px] overflow-hidden rounded-[14px] bg-white text-[#050505]">
          <div className="flex items-center gap-2 px-3 pt-3">
            <span className="grid h-9 w-9 place-items-center rounded-full bg-[#1d1d1f] text-sm font-semibold text-white">{clientName.charAt(0)}</span>
            <span className="grid leading-tight">
              <span className="text-[13px] font-semibold">{clientName}</span>
              <span className="text-[11px] text-[#65676b]">Sponsored · ◍</span>
            </span>
          </div>
          {ad && (
            <p className="whitespace-pre-wrap px-3 py-2 text-[13px] leading-[1.35]">
              {cut ? text.slice(0, LIMIT).trimEnd() : text}
              {cut && (
                <button onClick={() => setMore(true)} className="text-[#65676b]">
                  … See more
                </button>
              )}
            </p>
          )}
          {file && (
            <div className="relative w-full bg-black" style={{ aspectRatio: ratio(file.aspect) }}>
              {isVideo(file) ? (
                <video src={file.url ?? undefined} poster={file.thumbUrl ?? undefined} controls playsInline muted autoPlay loop className="absolute inset-0 h-full w-full object-contain" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                file.url && <img src={file.url} alt="" className="absolute inset-0 h-full w-full object-cover" />
              )}
            </div>
          )}
          {ad && (
            <a href={link ?? undefined} target="_blank" rel="noreferrer" className={`flex items-center gap-3 bg-[#f0f2f5] px-3 py-2.5 ${link ? "active:bg-[#e4e6eb]" : "pointer-events-none"}`}>
              <span className="grid min-w-0 flex-1 leading-tight">
                <span className="truncate text-[11px] uppercase text-[#65676b]">{link ? host(link) : clientName}</span>
                <span className="truncate text-[14px] font-semibold">{ad.headline}</span>
                {ad.linkDescription && <span className="truncate text-[12px] text-[#65676b]">{ad.linkDescription}</span>}
              </span>
              <span className="shrink-0 rounded-[6px] bg-[#e4e6eb] px-3 py-1.5 text-[13px] font-semibold">{ad.cta}</span>
            </a>
          )}
          <div className="flex justify-around border-t border-[#e4e6eb] py-2 text-[12px] font-medium text-[#65676b]">
            <span>Like</span>
            <span>Comment</span>
            <span>Share</span>
          </div>
        </div>
        <p className="mt-3 text-center text-[11px] text-faint">{link ? "Tap the headline or the button to open the page people land on." : "No landing page set yet."}</p>
      </div>
    </div>
  );
}

function Picker({ label, count, value, onChange }: { label: string; count: number; value: number; onChange: (i: number) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-12 text-[11px] text-faint">{label}</span>
      {Array.from({ length: count }, (_, i) => (
        <button key={i} onClick={() => onChange(i)} className={`rounded-full border px-2.5 py-0.5 text-[10.5px] ${i === value ? "border-brand-text bg-brand-soft text-fg" : "border-line text-muted"}`}>
          {i + 1}
        </button>
      ))}
    </div>
  );
}
