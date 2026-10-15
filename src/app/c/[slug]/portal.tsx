"use client";

import { useEffect, useRef, useState } from "react";
import type { Ad } from "@/lib/copy";
import type { PortalData, PortalDesign, PortalFile, PortalItem, PortalRow } from "@/lib/portal";
import { decide, type Pin } from "./actions";

// The client portal: home (what's waiting on you, what we're changing, what's live, what's launching) and the review
// deck. Each card is the ad as people will see it. Swipe right to approve; swipe left to ask for changes, pick design or
// copy, then pin notes on the creative (or the video timeline) and write what to change in the copy.

const LIMIT = 125;
const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms / 1000) % 60)).padStart(2, "0")}`;
const sizeLabel = (a: string | null) => (!a ? "" : a === "191x100" ? "1.91:1" : a.includes("x") && a.length <= 5 ? a.replace("x", ":") : a.replace("x", "×"));
const ratio = (a: string | null) => (a === "1x1" ? "1 / 1" : a === "9x16" ? "9 / 16" : a === "16x9" ? "16 / 9" : "4 / 5");
const isVideo = (f: PortalFile) => f.mime.startsWith("video/");

export function Portal({ slug, clientName, firstName, data, testing, live, demo = false }: { slug: string; clientName: string; firstName: string | null; data: PortalData; testing: boolean; live: boolean; demo?: boolean }) {
  const [reviewing, setReviewing] = useState(false);
  const [queue, setQueue] = useState(data.items);
  const n = queue.length;

  return (
    <>
      {testing && (
        <div className="bg-brand px-4 py-2 text-center text-xs leading-relaxed text-white">
          {live ? "You're previewing the portal as a Kaizen team member." : `The portal isn't live for ${clientName}: they can't sign in or see any of this, and nothing is sent to them.`}{" "}
          <b>Decisions you make here are real</b>: they move the tickets as if the client made them.
        </div>
      )}

      <main className="mx-auto grid max-w-md gap-4 px-4 pb-16 pt-4">
        {/* Waiting on you */}
        <section className="grid gap-2.5 rounded-[12px] bg-brand p-4 text-white">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-white/75">Waiting on you</p>
          <h1 className="font-heading text-[20px] font-semibold leading-tight">
            {n ? `${n} ${n === 1 ? "ad is" : "ads are"} ready for your review` : firstName ? `You're all caught up, ${firstName}` : "You're all caught up"}
          </h1>
          <p className="text-[12.5px] text-white/90">
            {n ? `About ${Math.max(1, Math.round(n * 0.5))} minute${n > 2 ? "s" : ""}. Swipe right to approve, left to ask for changes.` : "When your Kaizen team sends new ads, they'll show up here."}
          </p>
          {n > 0 && (
            <button onClick={() => setReviewing(true)} className="justify-self-start rounded-[5px] bg-white px-3.5 py-2 text-[13px] font-semibold text-[#7f1420]">
              Start reviewing →
            </button>
          )}
        </section>

        <Rows title="In revision" pill={data.revising.length} tone="warn" rows={data.revising} empty="Nothing in revision." />

        {/* Live in the ad account */}
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

      {reviewing && (
        <Deck
          slug={slug}
          clientName={clientName}
          items={queue}
          demo={demo}
          onDone={(id) => setQueue((q) => q.filter((x) => x.id !== id))}
          onClose={() => setReviewing(false)}
        />
      )}
    </>
  );
}

function ago(iso: string) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 60 ? `${Math.max(1, m)} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
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
            <div className="relative h-11 w-11 shrink-0 overflow-hidden rounded-[6px] bg-surface-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {r.thumbUrl && <img src={r.thumbUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />}
            </div>
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

// ─── The deck ───────────────────────────────────────────────────────────────

type Step = { kind: "card" } | { kind: "what" } | { kind: "copy"; both: false } | { kind: "annotate"; copy: boolean };

function Deck({ slug, clientName, items, demo, onDone, onClose }: { slug: string; clientName: string; items: PortalItem[]; demo: boolean; onDone: (id: string) => void; onClose: () => void }) {
  const [total] = useState(items.length);
  const [step, setStep] = useState<Step>({ kind: "card" });
  const [targets, setTargets] = useState<("design" | "copy")[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<"left" | "right" | null>(null);
  const [busy, setBusy] = useState(false);
  const item = items[0];
  const done = total - items.length;

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  const flash = (t: string) => {
    setToast(t);
    setTimeout(() => setToast(null), 2600);
  };

  const send = async (payload: Parameters<typeof decide>[1], message: string) => {
    setBusy(true);
    setError(null);
    const r = demo ? ({ ok: true } as const) : await decide(slug, payload);
    setBusy(false);
    if (!r.ok) {
      setLeaving(null);
      setError(r.error);
      return;
    }
    flash(message);
    setStep({ kind: "card" });
    setTargets([]);
    setTimeout(() => {
      setLeaving(null);
      onDone(payload.requestId);
    }, 260);
  };

  const approve = () => {
    if (!item || busy) return;
    setLeaving("right");
    void send({ requestId: item.id, decision: "approved" }, "Approved. We'll get it live.");
  };
  const changes = () => {
    if (!item || busy) return;
    setStep({ kind: "what" });
  };

  // ← changes, → approve
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (step.kind !== "card" || (e.target as HTMLElement).closest("textarea, input")) return;
      if (e.key === "ArrowRight") approve();
      if (e.key === "ArrowLeft") changes();
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  return (
    <div className="fixed inset-0 z-50 grid bg-bg/95 backdrop-blur sm:place-items-center sm:p-6">
      <div className="relative flex h-full w-full flex-col overflow-hidden bg-bg sm:h-[min(880px,100%)] sm:max-w-[430px] sm:rounded-[28px] sm:border sm:border-line sm:shadow-[0_20px_60px_rgba(0,0,0,0.55)]">
        {/* Progress */}
        <div className="flex items-center gap-2 px-4 pb-2 pt-[max(12px,env(safe-area-inset-top))]">
          <button onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg">
            ✕
          </button>
          <div className="flex flex-1 gap-[3px]">
            {Array.from({ length: total }, (_, i) => (
              <i key={i} className={`block h-[3px] flex-1 rounded-full ${i < done ? "bg-brand" : "bg-surface-3"}`} />
            ))}
          </div>
          <span className="tabular text-[11.5px] text-muted">{item ? `${done + 1} / ${total}` : `${total} / ${total}`}</span>
        </div>

        {!item ? (
          <div className="grid flex-1 place-items-center p-6 text-center">
            <div className="grid justify-items-center gap-2">
              <span className="grid h-14 w-14 place-items-center rounded-full bg-ok/15 text-2xl text-ok">✓</span>
              <h3 className="mt-2 text-[20px] font-semibold">All done</h3>
              <p className="max-w-[28ch] text-sm text-muted">Thanks! Your Kaizen team has everything. We&apos;ll let you know when there&apos;s more.</p>
              <button onClick={onClose} className="mt-3 rounded-[5px] bg-brand px-4 py-2 text-sm font-medium text-white">
                Back to home
              </button>
            </div>
          </div>
        ) : step.kind === "annotate" ? (
          <Annotate
            item={item}
            copy={step.copy}
            busy={busy}
            error={error}
            onCancel={() => setStep({ kind: "card" })}
            onSend={(pins, designNote, copyNotes) =>
              send({ requestId: item.id, decision: "revise", targets, pins, designNote, copyNotes }, "Sent to your team. We'll let you know when it's ready.")
            }
          />
        ) : (
          <>
            <div className="relative mx-3 flex-1">
              {items[2] && <div className="absolute inset-0 translate-y-5 scale-[0.92] rounded-[14px] border border-line bg-surface opacity-30" />}
              {items[1] && <div className="absolute inset-0 translate-y-2.5 scale-[0.96] rounded-[14px] border border-line bg-surface opacity-60" />}
              <Card key={item.id} item={item} clientName={clientName} leaving={leaving} onApprove={approve} onChanges={changes} />
            </div>
            <div className="flex items-center justify-center gap-[18px] pb-2 pt-3">
              <button onClick={changes} aria-label="Ask for changes" className="grid h-[54px] w-[54px] place-items-center rounded-full border border-line bg-surface text-[20px] font-semibold text-warn">
                ✎
              </button>
              <button onClick={approve} aria-label="Approve" className="grid h-[62px] w-[62px] place-items-center rounded-full bg-ok text-[24px] font-semibold text-white shadow-[0_10px_30px_-10px_rgba(63,178,127,0.9)]">
                ✓
              </button>
            </div>
            <p className="pb-[max(10px,env(safe-area-inset-bottom))] text-center text-[10.5px] text-faint">← changes · → approve</p>
            {error && <p className="px-4 pb-2 text-center text-xs text-bad">{error}</p>}
          </>
        )}

        {/* What needs changes? */}
        {step.kind === "what" && item && (
          <Sheet onClose={() => setStep({ kind: "card" })}>
            <h5 className="text-[15px] font-semibold">What needs changes?</h5>
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  ["design", item.format === "video" ? "The video" : "The design"],
                  ["copy", "The copy"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  aria-pressed={targets.includes(k)}
                  onClick={() => setTargets((t) => (t.includes(k) ? t.filter((x) => x !== k) : [...t, k]))}
                  className={`rounded-full border px-3 py-1.5 text-[12.5px] ${targets.includes(k) ? "border-brand-text bg-brand-soft text-fg" : "border-line text-muted"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="rounded-[8px] bg-surface px-2.5 py-2 text-[11.5px] text-muted">
              {targets.includes("design")
                ? item.format === "video"
                  ? "Next, scrub the video and leave a comment at each moment that needs an edit."
                  : "Next, tap the creative wherever something should change and say what."
                : targets.includes("copy")
                  ? "Next, tell us what to change in the copy. We only change what you ask."
                  : "Pick one or both."}
            </p>
            <button
              disabled={!targets.length}
              onClick={() => setStep(targets.includes("design") ? { kind: "annotate", copy: targets.includes("copy") } : { kind: "copy", both: false })}
              className="h-10 rounded-[5px] bg-brand text-sm font-medium text-white disabled:opacity-40"
            >
              Continue
            </button>
          </Sheet>
        )}
        {step.kind === "copy" && item && (
          <CopySheet
            ads={item.ads}
            busy={busy}
            error={error}
            onClose={() => setStep({ kind: "card" })}
            onSend={(notes) => send({ requestId: item.id, decision: "revise", targets: ["copy"], pins: [], designNote: "", copyNotes: notes }, "Sent to your team. We'll let you know when it's ready.")}
          />
        )}

        {toast && (
          <div className="absolute inset-x-3 bottom-4 z-40 flex items-center justify-between gap-2 rounded-[10px] bg-fg px-3 py-2.5 text-[12.5px] text-bg animate-[step-in_.2s_ease-out]">
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}

function Sheet({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <>
      <button aria-label="Close" onClick={onClose} className="absolute inset-0 z-20 bg-black/40" />
      <div className="absolute inset-x-0 bottom-0 z-30 grid gap-2.5 rounded-t-[18px] border-t border-line bg-surface-2 px-4 pb-[max(18px,env(safe-area-inset-bottom))] pt-3.5 shadow-[0_-10px_40px_rgba(0,0,0,0.4)] animate-[step-in_.2s_ease-out]">
        {children}
      </div>
    </>
  );
}

/** onChange gets the whole note, with the ads it's about ("[Ad 2] no emojis"). */
function CopySheet({ ads, busy, error, onClose, onSend, embedded = false, onChange }: { ads: Ad[]; busy?: boolean; error?: string | null; onClose?: () => void; onSend?: (notes: string) => void; embedded?: boolean; onChange?: (notes: string) => void }) {
  const [text, setText] = useState("");
  const [which, setWhich] = useState<number[]>([]);
  const compose = (t: string, w: number[]) => (t.trim() ? (w.length && w.length < ads.length ? `[${w.map((i) => `Ad ${i + 1}`).join(", ")}] ` : "") + t.trim() : "");
  const notes = () => compose(text, which);
  const set = (t: string) => {
    setText(t);
    onChange?.(compose(t, which));
  };
  const toggle = (i: number) => {
    const w = which.includes(i) ? which.filter((x) => x !== i) : [...which, i];
    setWhich(w);
    onChange?.(compose(text, w));
  };
  const body = (
    <>
      <h5 className="text-[15px] font-semibold">What should change in the copy?</h5>
      {ads.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          <span className="self-center text-[11.5px] text-muted">Which:</span>
          {ads.map((a, i) => (
            <button
              key={i}
              aria-pressed={which.includes(i)}
              onClick={() => toggle(i)}
              className={`rounded-full border px-2.5 py-1 text-[11.5px] ${which.includes(i) ? "border-brand-text bg-brand-soft text-fg" : "border-line text-muted"}`}
            >
              Copy {i + 1}
            </button>
          ))}
          <span className="self-center text-[11px] text-faint">{which.length ? "" : "or all of it"}</span>
        </div>
      )}
      <textarea
        autoFocus={!embedded}
        value={text}
        onChange={(e) => set(e.target.value)}
        placeholder="e.g. Don't say 'cheap'. Add a couple of emojis. Mention free delivery."
        className="min-h-[84px] w-full resize-none rounded-[8px] border border-line bg-surface p-2.5 text-[13px] outline-none placeholder:text-faint focus:border-brand-text/60"
      />
      {!embedded && <p className="rounded-[8px] bg-surface px-2.5 py-2 text-[11.5px] text-muted">We change only what you ask. If you&apos;d like it rewritten from scratch, just say so.</p>}
    </>
  );
  if (embedded) return <div className="grid gap-2">{body}</div>;
  return (
    <Sheet onClose={onClose!}>
      {body}
      {error && <p className="text-xs text-bad">{error}</p>}
      <button disabled={busy || !text.trim()} onClick={() => onSend!(notes())} className="h-10 rounded-[5px] bg-brand text-sm font-medium text-white disabled:opacity-40">
        {busy ? "Sending…" : "Send to my team"}
      </button>
    </Sheet>
  );
}

// ─── One ad, as people will see it ──────────────────────────────────────────

function Card({ item, clientName, leaving, onApprove, onChanges }: { item: PortalItem; clientName: string; leaving: "left" | "right" | null; onApprove: () => void; onChanges: () => void }) {
  const [di, setDi] = useState(0);
  const [fi, setFi] = useState(0);
  const [ai, setAi] = useState(0);
  const [more, setMore] = useState(false);
  const [revised, setRevised] = useState(false);
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; id: number } | null>(null);

  const design = item.designs[di] ?? item.designs[0];
  const file = design.files[fi] ?? design.files[0];
  const ad = item.ads[ai];
  const text = ad?.primaryText ?? "";
  const cut = text.length > LIMIT && !more;
  const x = leaving === "right" ? 600 : leaving === "left" ? -600 : dx;

  return (
    <article
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("button, video")) return;
        drag.current = { x: e.clientX, id: e.pointerId };
        setDragging(true);
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => drag.current && setDx(e.clientX - drag.current.x)}
      onPointerUp={() => {
        if (!drag.current) return;
        drag.current = null;
        setDragging(false);
        if (dx > 110) onApprove();
        else if (dx < -110) onChanges();
        setDx(0);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
        setDx(0);
      }}
      style={{ transform: `translateX(${x}px) rotate(${x / 22}deg)`, opacity: leaving ? 0 : 1, transition: dragging ? "none" : "transform .28s ease, opacity .28s ease" }}
      className="absolute inset-0 flex touch-pan-y select-none flex-col overflow-hidden rounded-[14px] border border-line bg-surface"
    >
      <span className="pointer-events-none absolute left-4 top-[18px] z-10 -rotate-[10deg] rounded-[6px] border-[3px] border-ok px-2.5 py-0.5 text-[20px] font-bold tracking-[0.04em] text-ok" style={{ opacity: Math.max(0, Math.min(1, x / 110)) }}>
        APPROVE
      </span>
      <span className="pointer-events-none absolute right-4 top-[18px] z-10 rotate-[10deg] rounded-[6px] border-[3px] border-warn px-2.5 py-0.5 text-[20px] font-bold tracking-[0.04em] text-warn" style={{ opacity: Math.max(0, Math.min(1, -x / 110)) }}>
        CHANGES
      </span>

      {/* What this is */}
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2 text-[11.5px] text-muted">
        <span className="min-w-0 truncate">
          <b className="font-semibold text-fg">{item.title}</b>
          {item.designs.length > 1 && ` · ${item.designs.length} designs`}
        </span>
        {item.revised && (
          <button onClick={() => setRevised(!revised)} className="shrink-0 rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand-text">
            Revised {revised ? "▴" : "▾"}
          </button>
        )}
      </div>
      {item.revised && revised && (
        <div className="grid max-h-[40%] gap-2 overflow-y-auto border-b border-line bg-surface-2 px-3 py-2.5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">What you asked · what we changed</p>
          {item.revised.changes.map((c, i) => (
            <div key={i} className="grid gap-0.5 text-[12px]">
              <span className="text-muted">You asked: {c.asked}</span>
              <span className="text-fg">✓ {c.changed}</span>
            </div>
          ))}
        </div>
      )}

      {/* Facebook-style post */}
      <div className="flex items-center gap-2 px-3 py-2.5">
        <span className="grid h-8 w-8 place-items-center rounded-full bg-brand text-[13px] font-semibold text-white">{clientName.charAt(0)}</span>
        <span className="grid leading-tight">
          <span className="text-[12.5px] font-semibold">{clientName}</span>
          <span className="text-[10.5px] text-muted">Sponsored · ◍</span>
        </span>
      </div>
      {ad && (
        <div className="px-3 pb-2 text-[12px] leading-[1.45]">
          <p className="whitespace-pre-wrap">
            {cut ? text.slice(0, LIMIT).trimEnd() : text}
            {cut && (
              <button onClick={() => setMore(true)} className="text-muted">
                … more
              </button>
            )}
          </p>
          {item.ads.length > 1 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {item.ads.map((_, i) => (
                <button
                  key={i}
                  aria-pressed={i === ai}
                  onClick={() => (setAi(i), setMore(false))}
                  className={`rounded-full border px-2 py-px text-[10.5px] ${i === ai ? "border-brand-text text-brand-text" : "border-line text-muted"}`}
                >
                  Copy {i + 1}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <Media file={file} />
      {ad && (
        <div className="flex items-center justify-between gap-2 bg-surface-2 px-3 py-2 text-[12px]">
          <span className="grid min-w-0">
            <span className="truncate text-[10px] uppercase tracking-[0.04em] text-muted">{ad.linkDescription || clientName}</span>
            <span className="truncate font-semibold">{ad.headline}</span>
          </span>
          <span className="shrink-0 rounded-[4px] bg-surface-3 px-2.5 py-1 text-[11px] font-semibold">{ad.cta}</span>
        </div>
      )}

      {/* Designs and sizes */}
      {(item.designs.length > 1 || design.files.length > 1) && (
        <div className="flex flex-wrap justify-center gap-1.5 px-3 pb-2.5 pt-2">
          {item.designs.length > 1 &&
            item.designs.map((d, i) => (
              <button
                key={d.id}
                aria-pressed={i === di}
                onClick={() => (setDi(i), setFi(0))}
                className={`rounded-full border px-2.5 py-0.5 text-[10.5px] ${i === di ? "border-fg bg-fg text-bg" : "border-line text-muted"}`}
              >
                Design {i + 1}
              </button>
            ))}
          {design.files.length > 1 &&
            design.files.map((f, i) => (
              <button
                key={f.id}
                aria-pressed={i === fi}
                onClick={() => setFi(i)}
                className={`rounded-full border px-2.5 py-0.5 text-[10.5px] ${i === fi ? "border-brand-text text-brand-text" : "border-line text-muted"}`}
              >
                {item.format === "carousel" ? `Card ${i + 1}` : sizeLabel(f.aspect)}
              </button>
            ))}
        </div>
      )}
    </article>
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
          <video ref={videoRef} key={file.id} onTimeUpdate={(e) => onTime?.(Math.round(e.currentTarget.currentTime * 1000))} src={file.url ?? undefined} poster={file.thumbUrl ?? undefined} controls playsInline muted={!videoRef} loop={!videoRef} autoPlay={!videoRef} className="h-full w-full object-contain" />
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

// ─── Marking what to change ─────────────────────────────────────────────────

type DraftPin = Pin & { n: number; label: string };

function Annotate({ item, copy, busy, error, onCancel, onSend }: { item: PortalItem; copy: boolean; busy: boolean; error: string | null; onCancel: () => void; onSend: (pins: Pin[], designNote: string, copyNotes: string) => void }) {
  const [di, setDi] = useState(0);
  const [fi, setFi] = useState(0);
  const [pins, setPins] = useState<DraftPin[]>([]);
  const [draft, setDraft] = useState<{ x: number | null; y: number | null; tMs: number | null } | null>(null);
  const [text, setText] = useState("");
  const [designNote, setDesignNote] = useState("");
  const [copyNotes, setCopyNotes] = useState("");
  const video = useRef<HTMLVideoElement | null>(null);
  const [at, setAt] = useState(0);
  const design: PortalDesign = item.designs[di] ?? item.designs[0];
  const file = design.files[fi] ?? design.files[0];
  const here = pins.filter((p) => p.designId === design.id && p.fileId === file.id);

  const add = () => {
    if (!draft || !text.trim()) return;
    const n = pins.length + 1;
    const where = draft.tMs != null ? `at ${clock(draft.tMs)}` : "";
    setPins([...pins, { n, designId: design.id, version: design.version, fileId: file.id, x: draft.x, y: draft.y, tMs: draft.tMs, body: text.trim(), label: [`Design ${di + 1}`, item.format === "carousel" ? `card ${fi + 1}` : sizeLabel(file.aspect), where].filter(Boolean).join(" · ") }]);
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
      {(item.designs.length > 1 || design.files.length > 1) && (
        <div className="flex flex-wrap gap-1.5 px-4 pb-2">
          {item.designs.length > 1 &&
            item.designs.map((d, i) => (
              <button key={d.id} onClick={() => (setDi(i), setFi(0), setDraft(null))} className={`rounded-full border px-2.5 py-0.5 text-[10.5px] ${i === di ? "border-fg bg-fg text-bg" : "border-line text-muted"}`}>
                Design {i + 1}
              </button>
            ))}
          {design.files.length > 1 &&
            design.files.map((f, i) => (
              <button key={f.id} onClick={() => (setFi(i), setDraft(null))} className={`rounded-full border px-2.5 py-0.5 text-[10.5px] ${i === fi ? "border-brand-text text-brand-text" : "border-line text-muted"}`}>
                {item.format === "carousel" ? `Card ${i + 1}` : sizeLabel(f.aspect)}
              </button>
            ))}
        </div>
      )}

      <div className="mx-3 flex min-h-[38%] flex-1 overflow-hidden rounded-[12px] border border-line">
        <Media file={file} videoRef={video} onTime={setAt} onTap={isVideo(file) ? undefined : (x, y) => setDraft({ x, y, tMs: null })}>
          {here.map((p) =>
            p.x != null && p.y != null ? (
              <span key={p.n} className="absolute z-[4] -ml-[11px] -mt-[11px] grid h-[22px] w-[22px] place-items-center rounded-full border-2 border-white bg-warn text-[11px] font-bold text-[#111]" style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}>
                {p.n}
              </span>
            ) : null,
          )}
          {draft?.x != null && draft.y != null && (
            <span className="absolute z-[4] -ml-[11px] -mt-[11px] h-[22px] w-[22px] animate-pulse rounded-full border-2 border-white bg-warn" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%` }} />
          )}
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
            <p className="text-[11.5px] text-muted">{draft.tMs != null ? `At ${clock(draft.tMs)}` : `Pin ${pins.length + 1}`}: what should change here?</p>
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
                  <span className="block text-[10.5px] text-faint">{p.label}</span>
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
          value={designNote}
          onChange={(e) => setDesignNote(e.target.value)}
          placeholder={`Anything else about the ${item.format === "video" ? "video" : "design"}? (optional)`}
          className="min-h-[56px] w-full resize-none rounded-[8px] border border-line bg-surface p-2.5 text-[13px] outline-none placeholder:text-faint focus:border-brand-text/60"
        />
        {copy && <CopySheet embedded ads={item.ads} onChange={setCopyNotes} />}
        {error && <p className="text-xs text-bad">{error}</p>}
        <button
          disabled={busy || (!pins.length && !designNote.trim()) || (copy && !copyNotes.trim())}
          onClick={() => onSend(pins.map((p) => ({ designId: p.designId, version: p.version, fileId: p.fileId, x: p.x, y: p.y, tMs: p.tMs, body: p.body })), designNote, copyNotes)}
          className="h-10 rounded-[5px] bg-brand text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? "Sending…" : `Send ${pins.length ? `${pins.length} note${pins.length === 1 ? "" : "s"} ` : ""}to my team`}
        </button>
      </div>
    </div>
  );
}
