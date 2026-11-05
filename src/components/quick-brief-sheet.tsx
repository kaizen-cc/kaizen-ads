"use client";

import { useRouter } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AiProgress } from "@/components/ai-progress";
import { readyHref, trackJob } from "@/components/brief-jobs";
import { toast } from "@/components/toasts";
import { startBrief } from "@/app/(team)/brief-job-actions";
import { RefThumb } from "@/components/ref-thumb";
import { AllotmentBars, Spark, Stepper, conceptLine } from "@/app/(team)/requests/new/parts";
import { previewBrief, type PreviewResult } from "@/app/(team)/quick-brief-actions";
import { quickEdited, type BriefSource, type QuickBrief, type QuickFormat } from "@/lib/quick-brief";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import type { Allotment } from "@/lib/allotment";

// The quick preview every brief starts from. Picking a card ("Brief on this") opens this sheet: a short summary in a
// few seconds that can be changed line by line, then "Write the full brief" starts the usual (longer) write, seeded
// with what's here so the brief follows the edits. "Not this one" closes it. The sheet lives in the address
// (?preview=), so back closes it. One concept per brief: when what's previewed holds several distinct concepts, it
// offers "Split into N briefs", and each is written on its own.
// Opened anywhere but the request form (no onWrite), the full brief is written in the background (src/lib/brief-jobs.ts):
// the sheet closes, the progress sits by the bell, and a toast and the bell open it as a draft in Ready to send.
// "Not this one" writes nothing.

type Fmt = QuickFormat["format"];
const FMTS: Fmt[] = ["image", "video", "carousel"];
const FMT_LABEL: Record<Fmt, string> = { image: "Image", video: "Video", carousel: "Carousel" };

export type WriteResult = { ok: true } | { ok: false; error: string } | void;

/** What's being previewed, kept while ?preview= points at it (back and forward reopen it) */
export function useQuickPreview<T>() {
  const key = useParam("preview");
  const [item, setItem] = useState<{ key: string; data: T } | null>(null);
  return {
    current: item && item.key === key ? item.data : null,
    open: (k: string, data: T) => {
      setItem({ key: k, data });
      pushParams({ preview: k });
    },
    close: () => closeParams("preview"),
  };
}

export function QuickBriefSheet({
  clientId,
  source,
  from,
  progressLabel,
  progressMs = 110_000,
  onWrite,
  onWriteAll,
  onClose,
  background: backgroundAsked = false,
  given = null,
}: {
  clientId: string;
  source: BriefSource;
  /** Where it comes from, shown at the top: a line and a picture when there is one */
  from: { kicker: string; label: string; thumb?: string | null; adId?: string | null; format?: Fmt | null };
  /** The AI label the full write is timed by (its recent runs) */
  progressLabel: string;
  progressMs?: number;
  /** Write the full brief from the agreed preview (rest: the other briefs of a split, still to write). A promise keeps
   *  the sheet open with the progress until it settles. Left out: written in the background, opening in Ready to send */
  onWrite?: (seed: QuickBrief, edited: boolean, rest: QuickBrief[]) => Promise<WriteResult> | WriteResult;
  /** Background surfaces: after a split, write every brief at once */
  onWriteAll?: (seeds: QuickBrief[]) => void;
  /** Already agreed (the next brief of a split): shown as it is, no AI */
  given?: QuickBrief | null;
  onClose: () => void;
  /** The full brief is written in the background (the sheet closes and the card shows its progress) */
  background?: boolean;
}) {
  const [state, setState] = useState<{ status: "loading" } | { status: "error"; error: string } | { status: "ready"; base: QuickBrief; others: QuickBrief[]; allotment: Allotment | null; client: string; instant: boolean }>({ status: "loading" });
  // Every brief on screen (one, or each concept after a split), and which one is open
  const [briefs, setBriefs] = useState<QuickBrief[]>([]);
  const [split, setSplit] = useState(false);
  const [active, setActive] = useState(0);
  const brief = briefs[active] ?? null;
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const sourceKey = JSON.stringify(source);
  const router = useRouter();
  // No writer of its own: every full brief is written in the background and opens in Ready to send
  const background = backgroundAsked || !onWrite;
  const inBackground = async (seeds: QuickBrief[], changed: boolean) => {
    const here = new URL(window.location.href);
    here.searchParams.delete("preview");
    const from = `${here.pathname}${here.search}`;
    let started = 0;
    for (const [i, seed] of seeds.entries()) {
      const r = await startBrief(clientId, source, seed, changed || seeds.length > 1, i, from).catch(() => ({ ok: false as const, error: "Something went wrong. Try again." }));
      if (!r.ok) {
        toast({ tone: "bad", title: "The brief couldn't be started", body: r.error, ms: 8000 });
        continue;
      }
      if ("ready" in r) return router.push(readyHref(r.ready));
      if ("job" in r) {
        trackJob(r.job);
        started++;
      } else router.push(readyHref(r.suggestion.id));
    }
    if (started)
      toast({
        tone: "info",
        title: started > 1 ? `Writing ${started} briefs in the background` : "Writing the full brief in the background",
        body: "Keep working. You'll get a notice when it's ready to open in Ready to send.",
        ms: 6000,
      });
  };
  const givenKey = given ? JSON.stringify(given) : "";

  useEffect(() => {
    let live = true;
    void Promise.resolve().then(() => live && setState({ status: "loading" }));
    previewBrief(clientId, JSON.parse(sourceKey) as BriefSource, givenKey ? (JSON.parse(givenKey) as QuickBrief) : null)
      .catch((): PreviewResult => ({ ok: false, error: "Couldn't sketch it. Try again." }))
      .then((r) => {
        if (!live) return;
        if (!r.ok) return setState({ status: "error", error: r.error });
        setState({ status: "ready", base: r.brief, others: r.others, allotment: r.allotment, client: r.client, instant: r.instant });
        setBriefs([r.brief]);
        setSplit(false);
        setActive(0);
      });
    return () => {
      live = false;
    };
  }, [clientId, sourceKey, givenKey, attempt]);

  // Escape closes (not while the brief is being written in the sheet)
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && !writing && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose, writing]);

  const ready = state.status === "ready" && brief ? state : null;
  // A split brief is always new: each is written from its own preview
  const edited = ready && brief ? split || quickEdited(ready.base, brief) : false;
  const setBrief = (fn: (b: QuickBrief) => QuickBrief) => setBriefs((all) => all.map((b, i) => (i === active ? fn(b) : b)));
  const set = (patch: Partial<QuickBrief>) => setBrief((b) => ({ ...b, ...patch }));
  const setFormat = (f: Fmt, patch: Partial<QuickFormat> | null) =>
    setBrief((b) => {
      const has = b.formats.some((x) => x.format === f);
      const formats = patch === null ? b.formats.filter((x) => x.format !== f) : has ? b.formats.map((x) => (x.format === f ? { ...x, ...patch } : x)) : [...b.formats, { format: f, new: 1, variations: 0, ...patch }];
      return { ...b, formats: FMTS.flatMap((k) => formats.filter((x) => x.format === k)) };
    });
  const total = brief?.formats.reduce((n, f) => n + f.new + f.variations, 0) ?? 0;

  const write = async () => {
    if (!brief || !total) return;
    setError(null);
    if (!onWrite) {
      // Already written and kept as it was: straight to Ready to send. Otherwise the sheet closes while it's written
      if (!(ready?.instant && !edited)) onClose();
      void inBackground([brief], edited);
      return;
    }
    const r = onWrite(brief, edited, briefs.filter((_, i) => i !== active));
    if (background || !(r instanceof Promise)) return;
    setWriting(true);
    const res = await r.catch(() => ({ ok: false as const, error: "Something went wrong. Try again." }));
    setWriting(false);
    if (res && !res.ok) setError(res.error);
  };

  const action = ready?.instant && !edited ? "Use this brief" : ready?.instant && !split ? "Rewrite with my changes" : "Write the full brief";
  const doSplit = () => {
    if (!ready) return;
    setBriefs([...briefs.slice(0, 1), ...ready.others]);
    setSplit(true);
    setActive(0);
  };

  // On the page itself, so no parent (a sheet that animates in) can hold it
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center md:items-stretch md:justify-end" role="dialog" aria-modal="true" aria-label="Quick preview of the brief">
      <button type="button" aria-label="Close" onClick={() => !writing && onClose()} className="absolute inset-0 bg-black/60 backdrop-blur-[2px] animate-[sheet-fade_.2s_ease-out]" />
      <div className="relative grid max-h-[94dvh] w-full grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-t-[26px] border border-line bg-bg shadow-[0_-30px_80px_-30px_rgba(0,0,0,0.6)] animate-[sheet-up_.32s_cubic-bezier(.2,.8,.2,1)] md:max-h-none md:w-[540px] md:rounded-none md:rounded-l-[26px] md:border-y-0 md:border-r-0 md:animate-[drawer-right_.32s_cubic-bezier(.2,.8,.2,1)]">
        {/* Where it comes from */}
        <div className="relative isolate flex items-center gap-3 overflow-hidden border-b border-line px-5 pb-4 pt-3 md:pt-5">
          <span aria-hidden className="pointer-events-none absolute -right-16 -top-24 -z-10 h-56 w-56 rounded-full bg-brand/20 blur-[80px]" />
          <span className="absolute left-1/2 top-2 h-1 w-10 -translate-x-1/2 rounded-full bg-line md:hidden" aria-hidden />
          {(from.thumb || from.adId) && (
            <span className="relative mt-2 h-14 w-12 shrink-0 overflow-hidden rounded-[10px] bg-surface-2 md:mt-0">
              <RefThumb src={from.thumb ?? null} adId={from.adId} format={from.format ?? null} hoverZoom={false} />
            </span>
          )}
          <span className="mt-2 grid min-w-0 flex-1 gap-0.5 md:mt-0">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-brand-text">
              <Spark size={11} /> {from.kicker}
            </span>
            <span className="truncate text-[13.5px] text-muted">{from.label}</span>
          </span>
          <button type="button" onClick={() => !writing && onClose()} disabled={writing} aria-label="Close" className="mt-2 grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40 md:mt-0">
            ✕
          </button>
        </div>

        <div className="grid min-w-0 content-start gap-6 overflow-y-auto overscroll-contain px-5 py-5">
          {state.status === "loading" && <Sketching />}
          {state.status === "error" && (
            <div className="grid gap-3 rounded-[16px] border border-bad/30 bg-bad-soft p-4 text-[14px] text-bad">
              {state.error}
              <button type="button" onClick={() => setAttempt((n) => n + 1)} className="min-h-11 justify-self-start rounded-full border border-bad/40 px-4 text-[13.5px] hover:bg-bad/10">
                Try again
              </button>
            </div>
          )}
          {ready && brief && (
            <div className={`grid min-w-0 gap-6 animate-[step-in_.3s_cubic-bezier(.2,.8,.2,1)] ${writing ? "pointer-events-none opacity-60" : ""}`}>
              {ready.others.length > 0 && !split && (
                <div className="grid gap-2.5 rounded-[16px] border border-warn/40 bg-warn-soft/40 p-4">
                  <p className="text-[13.5px] leading-relaxed">
                    This holds <b>{ready.others.length + 1} distinct concepts</b>. One concept per brief, so each gets its own designer brief and its own count.
                  </p>
                  <button type="button" onClick={doSplit} className="min-h-11 justify-self-start rounded-full bg-fg px-4 text-[13.5px] font-medium text-bg hover:opacity-90">
                    Split into {ready.others.length + 1} briefs
                  </button>
                </div>
              )}
              {split && (
                <div role="tablist" aria-label="Briefs from the split" className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1 [scrollbar-width:none]">
                  {briefs.map((b, i) => (
                    <button
                      key={i}
                      type="button"
                      role="tab"
                      aria-selected={i === active}
                      onClick={() => setActive(i)}
                      className={`grid min-h-11 max-w-[220px] shrink-0 content-center rounded-[14px] border px-3.5 py-2 text-left transition ${i === active ? "border-brand/60 bg-brand-soft" : "border-line bg-surface hover:border-faint"}`}
                    >
                      <span className="text-[11px] text-faint">Brief {i + 1} of {briefs.length}</span>
                      <span className="truncate text-[13px] font-medium">{b.title || "Untitled"}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="grid gap-1">
                <p className="text-[12px] text-faint">{split ? "Its own brief, written on its own. Change any line first." : ready.instant ? `Already written for ${ready.client}. Change any line and it's rewritten to match.` : `A first look for ${ready.client}. Change any line before the full brief is written.`}</p>
                <Line value={brief.title} onChange={(v) => set({ title: v })} label="Title" className="font-heading text-[24px] leading-tight tracking-tight" placeholder="Name it" />
              </div>

              <Block label="The idea">
                <Line value={brief.concept} onChange={(v) => set({ concept: v })} label="The idea" className="text-[15.5px] leading-relaxed" placeholder="What the creative shows and does" />
              </Block>

              <div className="relative rounded-[18px] border border-line bg-surface px-4 pb-3 pt-3.5">
                <span aria-hidden className="absolute -top-3 left-4 rounded-full bg-bg px-2 font-heading text-[26px] leading-none text-brand-text">&ldquo;</span>
                <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Hook</span>
                <Line value={brief.hook} onChange={(v) => set({ hook: v })} label="Hook" className="font-heading text-[18px] leading-snug" placeholder="The first line or on-image headline" />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Block label="Angle">
                  <Line value={brief.angle} onChange={(v) => set({ angle: v })} label="Angle" className="text-[14.5px]" placeholder="The angle" />
                </Block>
                <Block label="Audience">
                  <Line value={brief.audience} onChange={(v) => set({ audience: v })} label="Audience" className="text-[14.5px]" placeholder="Who it's for" />
                </Block>
              </div>

              <Block label="What gets made">
                <div className="grid gap-2">
                  {brief.formats.map((f) => (
                    <div key={f.format} className="flex flex-wrap items-end gap-3 rounded-[14px] border border-line bg-surface px-3.5 py-3">
                      <span className="grid min-w-[84px] flex-1 gap-0.5 self-center">
                        <span className="text-[14px] font-medium">{FMT_LABEL[f.format]}</span>
                        <span className="text-[11.5px] text-faint">{conceptLine(f)}</span>
                      </span>
                      <Stepper label="Net new" value={f.new} max={10} onChange={(n) => setFormat(f.format, { new: n })} />
                      <Stepper label="Variations" value={f.variations} max={5} onChange={(n) => setFormat(f.format, { variations: n })} />
                      <button type="button" onClick={() => setFormat(f.format, null)} aria-label={`Remove ${FMT_LABEL[f.format].toLowerCase()}`} className="grid h-11 w-11 place-items-center rounded-full text-faint hover:bg-surface-2 hover:text-fg md:h-10 md:w-10">
                        ✕
                      </button>
                    </div>
                  ))}
                  <div className="flex flex-wrap gap-2">
                    {FMTS.filter((f) => !brief.formats.some((x) => x.format === f)).map((f) => (
                      <button key={f} type="button" onClick={() => setFormat(f, {})} className="min-h-11 rounded-full border border-dashed border-line px-4 text-[13px] text-muted hover:border-faint hover:text-fg md:min-h-9">
                        + {FMT_LABEL[f]}
                      </button>
                    ))}
                  </div>
                  <AllotmentBars allotment={ready.allotment ?? undefined} formats={brief.formats} />
                </div>
              </Block>

              <Block label={`Why it fits ${ready.client}`}>
                <Line value={brief.why} onChange={(v) => set({ why: v })} label="Why it fits" className="text-[14px] leading-relaxed text-muted" placeholder="Why it fits them now" />
              </Block>

              <Block label="Add a note">
                <textarea
                  value={brief.note}
                  onChange={(e) => set({ note: e.target.value })}
                  rows={2}
                  placeholder="Anything the strategist should know: a product to feature, an offer to confirm, what to avoid"
                  className="w-full rounded-[14px] border border-line bg-surface px-4 py-3 text-[16px] leading-relaxed outline-none transition-colors placeholder:text-faint focus:border-brand/60 md:text-[14px]"
                />
              </Block>
            </div>
          )}
        </div>

        <div className="grid gap-2 border-t border-line bg-bg/95 px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-xl">
          {writing && (
            <div className="rounded-[16px] border border-brand/25 bg-brand-soft/30 px-4 py-3">
              <AiProgress size="sm" label={progressLabel} fallbackMs={progressMs} title={edited && ready?.instant ? "Rewriting the brief" : "Writing the brief"} note="It follows what's here. You can leave this open." />
            </div>
          )}
          {error && <p className="text-[13px] text-bad">{error}</p>}
          {background && ready && !(ready.instant && !edited) && <p className="text-[12px] text-faint">Written in the background while you keep working. It opens in Ready to send.</p>}
          {split && (onWriteAll || !onWrite) && briefs.length > 1 && (
            <button
              type="button"
              onClick={() => {
                if (onWriteAll) return onWriteAll(briefs);
                onClose();
                void inBackground(briefs, true);
              }}
              disabled={writing} className="min-h-11 rounded-full border border-line px-4 text-[13.5px] text-fg hover:border-faint disabled:opacity-50">
              Write all {briefs.length} in the background
            </button>
          )}
          <div className="flex items-center justify-between gap-2">
            <button type="button" onClick={onClose} disabled={writing} className="min-h-12 rounded-full px-4 text-[14px] text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40">
              Not this one
            </button>
            <button
              type="button"
              onClick={() => void write()}
              disabled={!ready || !total || writing}
              className="inline-flex min-h-12 items-center gap-2 rounded-full bg-brand px-6 text-[14.5px] font-medium text-white shadow-[0_10px_30px_-10px_rgba(200,16,46,0.8)] transition hover:bg-brand-hover disabled:opacity-50 disabled:shadow-none"
            >
              {!ready?.instant || edited ? <Spark size={13} /> : null}
              {writing ? "Writing…" : action}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

type PreviewSpec = {
  /** Unique on the page: it's what ?preview= holds, so back closes the sheet */
  previewKey: string;
  clientId: string;
  source: BriefSource;
  from: { kicker: string; label: string; thumb?: string | null; adId?: string | null; format?: Fmt | null };
  progressLabel?: string;
};

/**
 * A button that opens the quick preview right here (any page, even a server-rendered one): "Write the full brief"
 * writes it in the background and it opens in Ready to send; "Not this one" writes nothing.
 */
export function BriefPreviewButton({ children, className, ...spec }: PreviewSpec & { children: React.ReactNode; className?: string }) {
  const open = () => pushParams({ preview: spec.previewKey });
  return (
    <>
      <button type="button" onClick={open} className={className}>
        {children}
      </button>
      <Suspense fallback={null}>
        <PreviewWhenOpen {...spec} />
      </Suspense>
    </>
  );
}

/** The sheet for one preview key, while the address points at it */
export function PreviewWhenOpen({ previewKey, clientId, source, from, progressLabel = "brief from an idea+brief self-review" }: PreviewSpec) {
  const open = useParam("preview") === previewKey;
  return open ? <QuickBriefSheet clientId={clientId} source={source} from={from} progressLabel={progressLabel} onClose={() => closeParams("preview")} /> : null;
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">{label}</span>
      {children}
    </div>
  );
}

/** A line that reads as text and edits in place (it grows with what's typed) */
export function Line({ value, onChange, label, className = "", placeholder, id }: { value: string; onChange: (v: string) => void; label: string; className?: string; placeholder?: string; id?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      id={id}
      rows={1}
      aria-label={label}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={`-mx-2 block w-[calc(100%+1rem)] resize-none overflow-hidden rounded-[10px] border border-transparent bg-transparent px-2 py-1 outline-none transition-colors placeholder:text-faint hover:border-line hover:bg-surface/60 focus:border-brand/50 focus:bg-surface max-md:text-[16px] ${className}`}
    />
  );
}

function Sketching() {
  return (
    <div className="grid gap-6" aria-busy="true">
      <AiProgress size="sm" label="quick brief" fallbackMs={9_000} title="Sketching the idea" note="A first look in a few seconds. The full brief is written after you agree it." />
      <div className="grid gap-3" aria-hidden>
        {[70, 100, 92, 60, 84].map((w, i) => (
          <span key={i} className="relative h-3.5 overflow-hidden rounded-full bg-surface-2" style={{ width: `${w}%` }}>
            <span className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-fg/10 to-transparent animate-[ai-sweep_1.4s_ease-in-out_infinite]" />
          </span>
        ))}
      </div>
    </div>
  );
}
