"use client";

import { AiProgress, AiProgressButton } from "@/components/ai-progress";

import { useRouter } from "next/navigation";
import { PromisesStrip } from "./promises-strip";
import { ClientPicker, StartPage, forgetStart, prefetchStart, rememberClient, seedStart, type PreviewItem } from "./start-flow";
import { QuickBriefSheet, useQuickPreview } from "@/components/quick-brief-sheet";
import { ReadyToSend, MAKER, TURNAROUND, plural, type ReadyHandle } from "./ready-to-send";
import type { StartData } from "@/lib/request-start";
import { RequestChat } from "./request-chat";
import { AsanaSend, BriefPdfButton } from "@/components/asana-send";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useCreativeFormats } from "@/components/creative-formats-provider";
import { formatsOutside, formatsPhrase, keepFormats } from "@/lib/creative-formats";
import { PersonAvatar } from "@/components/person-avatar";
import { closeParams, pushParams, replaceParams, useParam } from "@/lib/url-state";
import type { DraftPatch, Review, ReviewIssue, Suggestions } from "@/lib/ai";
import { type Allotment } from "@/lib/allotment";
import { FORMAT_LABEL, type Format } from "@/lib/stages";
import { ClientTag, FormatIcon } from "@/app/(team)/board/ticket-card";
import { applyFixes, asanaPreview, createBatch, fulfilPromise, loadBriefing, reviewRequest, sendToAsana, suggestForRequest, type ContextSummary, type RefSummary, type ReviewDecisions, type ReviewResult, type SimilarCard, type SuggestResult } from "./actions";
import { ReviewWorkspace, startHandled, type Handled } from "./review-workspace";
import { FORMATS, INSPIRE_KEY, MAX_VARIATIONS, SIZES, emptyDraft, selectedFormats, totalFor, type Draft, type Size } from "./draft";
import { AllotmentBars, AspectOption, Chip, Progress, Spark, Stepper, conceptLine, type ClientOption } from "./parts";
import { SavedConcepts } from "@/components/saved-concepts";
import { savedHref, savedLine } from "@/lib/saved-references";
import { aiUnedited } from "@/lib/brief-fingerprint";

const STEPS = ["Client", "Start", "Formats", "Direction", "Brief", "Review"];
// Each step in the address (?step=formats), so back returns to the step before
const STEP_KEYS = STEPS.map((x) => x.toLowerCase());
const FIELD_ID: Record<ReviewIssue["field"], string> = { formats: "formats", sizes: "sizes", title: "title", angle: "angle", audience: "audience", brief: "brief", references: "references" };
const input =
  "h-12 w-full rounded-[8px] border border-line bg-surface px-4 text-[15px] outline-none transition-colors placeholder:text-faint focus:border-brand-text/70";

type AiState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; s: Suggestions; context: ContextSummary; prepared: boolean }
  | { status: "error"; error: string };
type ReviewState = { status: "idle" } | { status: "running" } | { status: "done"; review: Review; similar: SimilarCard[]; refs: RefSummary[] } | { status: "error"; error: string };

export type RequestDemo = { suggestions: Suggestions; context: ContextSummary; review: Review; similar?: SimilarCard[] };

/** A key for a split's next brief (kept with the request in progress) */
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const countLabel = (n: number, v: number) => [n && `${n} new`, v && plural(v, "variation")].filter(Boolean).join(" + ");

function Field({ id, label, hint, children }: { id?: string; label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid gap-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {hint && <span className="text-xs text-faint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

// A request in progress is kept in this browser, so a refresh, a crash or clicking away doesn't lose it (or the
// AI work already done). Cancel, Start over and sending it clear it. Kept for 7 days.
const SAVE_KEY = "kz:new-request:v1";
const SAVE_DAYS = 7;
type Saved = {
  at: number;
  draft: Draft;
  step: number;
  ai: AiState;
  briefAi: { status: "idle" | "loading" } | { status: "offer"; text: string };
  review: ReviewState;
  handled: Handled | null;
  /** The other briefs of a split, still to preview and write */
  queue?: PreviewItem[];
};
function readSaved(key = SAVE_KEY): Saved | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const s = JSON.parse(raw) as Saved;
    if (!s?.draft || Date.now() - s.at > SAVE_DAYS * 86_400_000) return null;
    return s;
  } catch {
    return null;
  }
}
function writeSaved(s: Saved | null, key = SAVE_KEY) {
  try {
    if (s) window.localStorage.setItem(key, JSON.stringify(s));
    else window.localStorage.removeItem(key);
  } catch {
    // Private windows or blocked storage: the form still works, it just isn't kept
  }
}

export function RequestForm({
  clients,
  allotments,
  anglesByClient,
  teamByClient,
  initialClient,
  aiOn,
  demo,
  initialDraft = null,
  startAtReview = false,
  initialStart = null,
  initialPreview = null,
  initialPromise = null,
}: {
  clients: ClientOption[];
  allotments: Record<string, Allotment>;
  anglesByClient: Record<string, string[]>;
  teamByClient: Record<string, Record<string, string>>;
  initialClient: string | null;
  aiOn: boolean;
  demo?: RequestDemo; // design preview: sample AI answers, no server calls
  /** Filled in from somewhere (a deleted ticket started again) */
  initialDraft?: Partial<Draft> | null;
  /** Open straight on the review step (the brief as it was) */
  startAtReview?: boolean;
  /** The start page's sections, already read on the server for ?client= (no wait at all) */
  initialStart?: StartData | null;
  /** Arriving with an idea to brief (an audit's creative idea): its quick preview opens first */
  initialPreview?: PreviewItem | null;
  /** A brief written from a call's promise: sending it puts the promise in motion */
  initialPromise?: { id: string; clientId: string } | null;
}) {
  // Seeded once, before anything asks for it
  useState(() => {
    if (initialStart) seedStart(initialStart);
    return null;
  });
  const router = useRouter();
  // Only the formats this person can request (a designer images and carousels, a video editor video): whatever fills
  // the form (a saved copy, the AI, a brief written elsewhere) is read through this
  const allowed = useCreativeFormats();
  const [rawDraft, setDraft] = useState<Draft>(() => ({ ...emptyDraft(initialClient), ...(initialDraft ?? {}) }));
  const draft = useMemo(() => {
    const kept = keepFormats(rawDraft.formats, allowed);
    return kept === rawDraft.formats ? rawDraft : { ...rawDraft, formats: kept };
  }, [rawDraft, allowed]);
  // Opened from somewhere (a deleted ticket, Asana, a brief written in Kaizen AI) in formats this person doesn't make
  // requests for: theirs to read, not to switch to another format
  const outside = formatsOutside(Object.keys(initialDraft?.formats ?? {}), allowed);
  const readOnly = outside.length > 0 && Object.keys(keepFormats(initialDraft?.formats ?? {}, allowed)).length === 0;
  // Part of what it was opened with is outside their formats: that part is left out, and the form says so
  const leftOut = readOnly ? [] : outside;
  const askedStep = STEP_KEYS.indexOf(useParam("step") ?? "");
  // No client yet: the first step, whatever the address says
  const step = !draft.clientId ? 0 : askedStep >= 0 ? askedStep : startAtReview ? STEPS.length - 1 : initialClient ? 1 : 0;
  const [ai, setAi] = useState<AiState>({ status: "idle" });
  const [briefAi, setBriefAi] = useState<{ status: "idle" | "loading" } | { status: "offer"; text: string }>({ status: "idle" });
  const [review, setReview] = useState<ReviewState>({ status: "idle" });
  const [handled, setHandled] = useState<Handled | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<number[] | null>(null);
  const [asanaSent, setAsanaSent] = useState<{ name: string; url: string | null }[] | null>(null);
  // The quick preview every brief starts from (in the address as ?preview=), and a split's briefs still to write
  const preview = useQuickPreview<PreviewItem>();
  const [queue, setQueue] = useState<PreviewItem[]>([]);
  const readyRef = useRef<ReadyHandle | null>(null);
  // Start: talking the idea through with the strategist (in the address, so back returns to the cards)
  const talking = useParam("path") === "talk";
  // Phones: the winners and market ideas open as a bottom sheet instead of pushing the form down
  const ideasOpen = useParam("ideas") === "1";
  const aiRef = useRef(ai);
  useEffect(() => {
    aiRef.current = ai;
  }, [ai]);
  const [pending, start] = useTransition();
  const latest = useRef(0); // ignore suggestions that come back after the client changed
  const topRef = useRef<HTMLDivElement>(null);
  const reviewRef = useRef<HTMLDivElement>(null);
  const reveal = (el: React.RefObject<HTMLDivElement | null>, block: ScrollLogicalPosition) =>
    requestAnimationFrame(() => el.current?.scrollIntoView({ behavior: "smooth", block }));

  const client = clients.find((c) => c.id === draft.clientId) ?? null;
  const team = draft.clientId ? (teamByClient[draft.clientId] ?? {}) : {};
  const formats = selectedFormats(draft);
  const total = formats.reduce((n, f) => n + totalFor(draft.formats[f]), 0);
  const s = ai.status === "ready" ? ai.s : null;
  const allotment = draft.clientId ? allotments[draft.clientId] : undefined;
  // Written entirely by the AI and not changed since: it goes straight through, no review (the server checks it again).
  // Any edit to what the review reads brings the review back; edited back to how it was, it's unchanged again.
  const [serverEdited, setServerEdited] = useState(false); // the server found it changed after all: reviewed from here on
  const unedited = aiOn && !demo && !serverEdited && aiUnedited(draft);
  // Where the person asked it to go once the review is through
  const intent = useRef<"here" | "asana">("here");
  const asanaRef = useRef<{ open: () => void } | null>(null);

  // Prepared suggestions come from the twice-daily briefing and load instantly. Live ones ask the AI now,
  // using what's filled in; that's also the fallback for a client with no briefing yet.
  const fetchSuggestions = (d: Draft, live: boolean): Promise<AiState> => {
    if (demo) return new Promise((r) => setTimeout(() => r({ status: "ready", s: demo.suggestions, context: demo.context, prepared: !live }), live ? 1100 : 250));
    const toState = (res: SuggestResult, prepared: boolean): AiState =>
      res.ok ? { status: "ready", s: res.suggestions, context: res.context, prepared } : { status: "error", error: res.error };
    if (live) return suggestForRequest(d).then((r) => toState(r, false));
    return loadBriefing(d.clientId!).then((b) => (b ? toState(b, true) : suggestForRequest(d).then((r) => toState(r, false))));
  };

  const suggest = (d: Draft, live: boolean) => {
    if (!aiOn) return;
    const id = ++latest.current;
    setAi({ status: "loading" });
    fetchSuggestions(d, live).then((r) => id === latest.current && setAi(r));
  };

  // On arrival: pick up a request in progress (no new AI calls), or start reading ?client= right away
  const [restoredAt, setRestoredAt] = useState<number | null>(null);
  // The design preview keeps its sample request apart from a real one
  // A migration from Asana never picks up (or overwrites) someone's own unsent request
  // A brief written in the background keeps its own saved copy, so it never overwrites another request in progress
  const saveKey = demo ? `${SAVE_KEY}:preview` : initialDraft?.migration ? `${SAVE_KEY}:asana:${initialDraft.migration.gid}` : initialPromise || initialDraft?.origin?.suggestionId ? `${SAVE_KEY}:brief:${initialDraft?.origin?.suggestionId ?? initialPromise?.id}` : SAVE_KEY;
  const [loaded, setLoaded] = useState(false); // nothing is saved until the saved copy has been read
  useEffect(() => {
    const saved = readSaved(saveKey);
    // Read storage after mount (the server can't), then apply it
    void Promise.resolve().then(() => {
      if (saved && saved.draft.clientId && (!initialClient || saved.draft.clientId === initialClient)) {
        setDraft(saved.draft);
        // Picked up where it was left: the client's Start page, or the step reached past it
        replaceParams({ step: STEP_KEYS[Math.max(1, saved.step)] ?? null });
        // Anything that was mid-flight comes back settled: an unfinished AI call is simply asked again
        setAi(saved.ai.status === "loading" ? { status: "idle" } : saved.ai);
        setBriefAi(saved.briefAi.status === "loading" ? { status: "idle" } : saved.briefAi);
        setReview(saved.review.status === "running" ? { status: "idle" } : saved.review);
        setHandled(saved.handled ? { ...saved.handled, fixing: null, running: null } : null);
        setQueue(saved.queue ?? []);
        setRestoredAt(saved.at);
        // Already in the form: the briefing fills its suggestions in the background
        if (saved.step >= 2 && (saved.ai.status === "loading" || saved.ai.status === "idle") && aiOn) suggest(saved.draft, false);
      } else if (initialClient && aiOn && step >= 2) suggest(draft, false);
      // Arriving from the winners library: that ad goes into the brief as a reference
      if (!demo) {
        let inspire: string | null = null;
        try {
          inspire = sessionStorage.getItem(INSPIRE_KEY);
          sessionStorage.removeItem(INSPIRE_KEY);
        } catch {}
        if (inspire) {
          const line = inspire;
          setDraft((d) => (d.brief.includes(line) ? d : { ...d, brief: d.brief.trim() ? `${d.brief.trim()}\n\n${line}` : line }));
        }
      }
      setLoaded(true);
      if (initialPreview && initialClient) preview.open(initialPreview.key, initialPreview);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the request in progress as it changes
  useEffect(() => {
    if (!loaded || created) return;
    if (!draft.clientId) return writeSaved(null, saveKey);
    writeSaved({ at: Date.now(), draft, step, ai, briefAi, review, handled: handled ? { ...handled, fixing: null, running: null } : null, queue }, saveKey);
  }, [loaded, created, draft, step, ai, briefAi, review, handled, queue, saveKey]);

  const startOver = () => {
    writeSaved(null, saveKey);
    setRestoredAt(null);
    reset();
  };

  // A promise from a call this request delivers (its brief was loaded); sending marks it in motion
  const [promise] = useState<{ id: string; clientId: string } | null>(initialPromise);

  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setReview({ status: "idle" });
  };

  const pickClient = (c: ClientOption) => {
    void prefetchStart(c.id).catch(() => {});
    rememberClient(c.id);
    const next = { ...emptyDraft(c.id), formats: draft.formats, sizes: draft.sizes };
    latest.current++;
    setDraft(next);
    setAi({ status: "idle" });
    setBriefAi({ status: "idle" });
    setReview({ status: "idle" });
    go(1, next);
  };

  const toggleFormat = (f: Format) => {
    const next = { ...draft.formats };
    if (next[f]) delete next[f];
    else next[f] = { new: 1, variations: 0 };
    set({ formats: next });
  };

  const setCount = (f: Format, key: "new" | "variations" | "cards", n: number) => set({ formats: { ...draft.formats, [f]: { ...draft.formats[f]!, [key]: n } } });

  const applyMix = (sg: Suggestions) =>
    set({
      formats: Object.fromEntries(sg.mix.filter((m) => allowed.has(m.format)).map((m) => [m.format, { new: m.new, variations: Math.min(m.variations, MAX_VARIATIONS) }])),
      ...(sg.sizes.length ? { sizes: sg.sizes } : {}),
    });

  const toggleSize = (z: Size) => set({ sizes: draft.sizes.includes(z) ? draft.sizes.filter((x) => x !== z) : SIZES.filter((x) => x === z || draft.sizes.includes(x)) });

  const blocked = [
    !draft.clientId && "Pick a client to continue.",
    false,
    (formats.length === 0 && "Pick at least one format.") ||
      (formats.some((f) => totalFor(draft.formats[f]) === 0) && "Each format needs at least one creative.") ||
      (draft.sizes.length === 0 && "Pick at least one size."),
    !draft.title.trim() && "Give it a title.",
    false,
    false,
  ][step];

  function go(i: number, d: Draft = draft) {
    setError(null);
    // Reaching the manual form: the client's briefing pre-fills its suggestions, quietly, in the background
    if (i >= 2 && aiOn && d.clientId && aiRef.current.status === "idle") suggest(d, false);
    // From the ideas sheet, the step takes the sheet's place: back doesn't open it again
    (ideasOpen || preview.current ? replaceParams : pushParams)({ step: STEP_KEYS[i], ideas: null, path: null, preview: null });
    reveal(topRef, "start");
  }

  // A whole brief from a winner or a market ad: fill the form and go straight to Review
  const applyIdea = (patch: Partial<Draft>) => {
    // Its own AI stamp (or none), never one left from an earlier brief
    set({ ...patch, ai: patch.ai ?? null });
    go(STEPS.length - 1);
  };

  // The full brief from an agreed quick preview is written in the background, like everywhere else: the sheet closes,
  // the card it came from shows the progress, and when it's ready a toast offers to open it in Ready to send (as its
  // own draft, so what's here is kept). A split's other briefs from Ready to send wait in the queue, each previewed.
  const openNext = (item: PreviewItem) => {
    setCreated(null);
    setAsanaSent(null);
    preview.open(item.key, item);
  };

  const draftBrief = () => {
    if (!aiOn) return;
    setBriefAi({ status: "loading" });
    fetchSuggestions(draft, true).then((r) => {
      if (r.status !== "ready") {
        setBriefAi({ status: "idle" });
        setError(r.status === "error" ? r.error : null);
        return;
      }
      setAi(r);
      if (!draft.brief.trim()) {
        set({ brief: r.s.brief });
        setBriefAi({ status: "idle" });
      } else setBriefAi({ status: "offer", text: r.s.brief });
    });
  };

  // What the person did with the review, kept on every ticket's history
  const decisionsOf = (r: Review | null): ReviewDecisions | undefined => {
    if (!r || !handled) return undefined;
    const pick = (want: (st: string) => boolean) => r.issues.filter((_, i) => want(handled.issues[i])).map((x) => ({ severity: x.severity, field: x.field, issue: x.issue }));
    return {
      // Sending with an issue still open counts as going past it
      dismissed: pick((st) => st === "dismissed" || st === "open"),
      fixed: pick((st) => st === "fixed"),
      continuedPast: Object.keys(handled.similar).map(Number),
      usedStrongerBrief: handled.brief === "used",
    };
  };

  const send = (r: Review | null, reviewFailed = false) =>
    start(async () => {
      setError(null);
      if (demo) {
        writeSaved(null, saveKey);
        setCreated(formats.map((_, i) => 1061 + i));
        return;
      }
      const res = await createBatch(draft, r, decisionsOf(r), { reviewFailed });
      // The server didn't find it to be the AI's unchanged brief: it gets the review after all
      if (!res.ok && res.needsReview) {
        setServerEdited(true);
        intent.current = "here";
        runReview();
        return;
      }
      if (res.ok) {
        writeSaved(null, saveKey);
        if (draft.clientId) forgetStart(draft.clientId);
        // Migrated past production: open the ticket to upload its creative
        if (draft.migration?.needsCreative && res.numbers[0]) {
          router.push(`/board?t=${res.numbers[0]}`);
          return;
        }
        setCreated(res.numbers);
        if (promise && promise.clientId === draft.clientId) void fulfilPromise(promise.id, res.numbers);
      }
      else setError(res.error);
    });

  const runReview = (to: "here" | "asana" = intent.current) => {
    intent.current = to;
    if (!aiOn) return to === "asana" ? asanaRef.current?.open() : send(null);
    setReview({ status: "running" });
    reveal(reviewRef, "center");
    const ask: Promise<ReviewResult> = demo
      ? new Promise((r) => setTimeout(() => r({ ok: true, review: demo.review, similar: demo.similar ?? [], refs: [] }), 3200))
      : reviewRequest(draft);
    ask.then((res) => {
      if (!res.ok) return setReview({ status: "error", error: res.error });
      const h = startHandled(res.review, res.similar, draft.brief);
      setHandled(h);
      setReview({ status: "done", review: res.review, similar: res.similar, refs: res.refs });
      reveal(reviewRef, "start");
      // Nothing to look at: straight to the team (or on to Asana's preview)
      if (res.review.issues.length === 0 && res.similar.length === 0 && h.brief === "none") {
        if (intent.current === "asana") asanaRef.current?.open();
        else send(res.review);
      }
    });
  };

  // Text changes from the review keep the review on screen (a manual edit starts a fresh review)
  const patchText = (p: Partial<Pick<Draft, "title" | "angle" | "audience" | "brief" | "refs" | "sizes" | "formats">>) => setDraft((d) => ({ ...d, ...p }));
  const pickUndo = (d: Draft) => ({ title: d.title, angle: d.angle, audience: d.audience, brief: d.brief, refs: d.refs, sizes: d.sizes, formats: d.formats });
  const snapshot = (reopen: number[], briefWas: Handled["brief"]) => ({ draft: pickUndo(draft), reopen, briefWas });

  /** An AI patch, kept inside what the form allows. */
  const fromPatch = (base: Draft, p: DraftPatch): Draft => {
    const formats: Draft["formats"] = {};
    for (const f of p.formats ?? []) {
      if (!FORMATS.includes(f.format) || !allowed.has(f.format) || formats[f.format]) continue;
      const n = Math.max(0, Math.min(20, Math.floor(f.new || 0)));
      const v = Math.max(0, Math.min(MAX_VARIATIONS, Math.floor(f.variations || 0)));
      if (n + v > 0) formats[f.format] = { new: n, variations: v };
    }
    const sizes = (p.sizes ?? []).filter((z): z is Size => SIZES.includes(z as Size));
    return {
      ...base,
      title: p.title,
      angle: p.angle,
      audience: p.audience,
      brief: p.brief,
      refs: typeof p.refs === "string" ? p.refs : base.refs,
      sizes: sizes.length ? sizes : base.sizes,
      formats: Object.keys(formats).length ? formats : base.formats,
    };
  };

  // AI fixes run one after another, each on top of the last, so clicking several in a row never loses a change
  const fixQueue = useRef<number[][]>([]);
  const fixBusy = useRef(false);
  const draftNow = useRef(draft);
  useEffect(() => {
    draftNow.current = draft;
  }, [draft]);

  const runFixes = async () => {
    if (fixBusy.current || review.status !== "done") return;
    fixBusy.current = true;
    while (fixQueue.current.length) {
      const indexes = fixQueue.current.shift()!;
      const before = draftNow.current;
      const issues = indexes.map((i) => review.review.issues[i]);
      setHandled((h) => (h ? { ...h, running: indexes, note: null } : h));
      const res = demo
        ? await new Promise<Awaited<ReturnType<typeof applyFixes>>>((r) =>
            setTimeout(() => r({ ok: true, patch: { title: before.title, angle: before.angle, audience: before.audience, brief: `${before.brief}\n${issues.map((x) => x.fix).join("\n")}`, refs: before.refs, sizes: before.sizes, formats: FORMATS.filter((f) => before.formats[f]).map((f) => ({ format: f, ...before.formats[f]! })), changed: ["brief"], note: "" } }), 1400),
          )
        : await applyFixes(before, issues);
      if (res.ok) {
        const next = fromPatch(draftNow.current, res.patch);
        draftNow.current = next;
        patchText(pickUndo(next));
      }
      setHandled((h) => {
        if (!h) return h;
        const fixing = (h.fixing ?? []).filter((i) => !indexes.includes(i));
        if (!res.ok) return { ...h, running: null, fixing: fixing.length ? fixing : null, note: res.error };
        return {
          ...h,
          running: null,
          fixing: fixing.length ? fixing : null,
          note: res.patch.note || h.note,
          undo: { draft: pickUndo(before), reopen: indexes, briefWas: h.brief },
          issues: h.issues.map((st, i) => (indexes.includes(i) ? "fixed" : st)),
        };
      });
    }
    fixBusy.current = false;
  };

  const fixWithAi = (indexes: number[]) => {
    if (review.status !== "done" || !handled) return;
    const waiting = new Set(handled.fixing ?? []);
    const fresh = indexes.filter((i) => !waiting.has(i) && handled.issues[i] === "open");
    if (!fresh.length) return;
    fixQueue.current.push(fresh);
    setHandled((h) => (h ? { ...h, fixing: [...(h.fixing ?? []), ...fresh] } : h));
    void runFixes();
  };

  const useStrongerBrief = (choice: "used" | "kept") => {
    if (review.status !== "done" || !handled) return;
    if (choice === "used") {
      setHandled({ ...handled, brief: "used", undo: snapshot([], handled.brief) });
      patchText({ brief: review.review.strongerBrief });
    } else setHandled({ ...handled, brief: "kept" });
  };

  const undoAi = () => {
    if (!handled?.undo) return;
    const u = handled.undo;
    if (!u.draft) return setHandled({ ...handled, undo: null }); // saved by an older version of the form
    patchText(u.draft);
    setHandled({
      ...handled,
      undo: null,
      note: null,
      brief: handled.brief === "used" && u.reopen.length === 0 ? "offer" : handled.brief,
      issues: handled.issues.map((st, i) => (u.reopen.includes(i) ? "open" : st)),
    });
  };

  const reset = () => {
    writeSaved(null, saveKey);
    setHandled(null);
    latest.current++;
    setDraft(emptyDraft(null));
    setAi({ status: "idle" });
    setReview({ status: "idle" });
    setBriefAi({ status: "idle" });
    setCreated(null);
    setQueue([]);
    setServerEdited(false);
    go(0);
  };

  const heading = [
    ["Who’s it for?", "Search by name. The work goes to that client’s designer or editor."],
    talking
      ? ["Talk it through", "Tell the strategist what you want to make. It asks only what it needs and builds the brief as you go."]
      : ["How do you want to start?", "Briefs ready for this client, what works for similar clients and in their market, or your own idea."],
    ["What are we making?", "Pick every format you need. Each one becomes its own ticket for the right person."],
    ["What’s the direction?", "Name it and set the angle, so the team and the copy agent aim the same way."],
    ["Brief the team", "What to show, what to say, and what to stay away from."],
    [
      "Ready to send",
      unedited
        ? "This is what the team receives, as the AI wrote it. Change anything right here; a changed brief is scrubbed against the client’s history before it goes out."
        : aiOn
          ? "This is what the team receives. Change anything right here; the AI scrubs it against the client’s history before it goes out."
          : "This is what the team receives. Change anything right here before it goes out.",
    ],
  ][step];

  return (
    <div ref={topRef} className="scroll-mt-8">
      <div className={`mx-auto grid min-w-0 content-start gap-9 ${step <= 1 && !created && !asanaSent ? "max-w-6xl" : "max-w-3xl"}`}>
        <div className="grid gap-6">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">New request</p>
            <Link href="/board" onClick={() => writeSaved(null, saveKey)} className="-m-3 p-3 text-xs text-muted hover:text-fg md:m-0 md:p-0">
              Cancel
            </Link>
          </div>
          {!created && restoredAt && (
            <span className="inline-flex items-center gap-2 justify-self-start rounded-full border border-line bg-surface py-1 pl-3 pr-1 text-[12px] text-faint">
              Resumed · saved {new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).format(new Date(restoredAt))}
              <button type="button" onClick={startOver} className="min-h-8 rounded-full px-2.5 text-muted hover:bg-surface-2 hover:text-fg">
                Start over
              </button>
            </span>
          )}
          {!created && draft.migration && <MigrationPanel m={draft.migration} onChange={(m) => set({ migration: m })} />}
          {!created && !readOnly && <Progress steps={STEPS} current={step} onJump={go} />}
          {!created && !readOnly && step >= 2 && <AiStrip aiOn={aiOn} ai={ai} clientName={client?.name ?? null} onRefresh={() => suggest(draft, true)} />}
        </div>

        {(created || asanaSent || step === STEPS.length - 1) && queue.length > 0 && <UpNext queue={queue} onOpen={openNext} onDrop={(k) => setQueue((q) => q.filter((x) => x.key !== k))} />}
        {asanaSent ? (
          <div className="grid gap-4 rounded-[20px] border border-ok/40 bg-ok-soft/30 p-6">
            <p className="font-heading text-[24px]">Sent to Asana</p>
            <p className="text-sm text-muted">On the Creative board in the Creative Brief column, built like a form request, and on our Board too.</p>
            <ul className="grid gap-2">
              {asanaSent.map((t) => (
                <li key={t.name} className="text-[14px]">
                  ✓ {t.url ? <a href={t.url} target="_blank" rel="noreferrer" className="underline">{t.name}</a> : t.name}
                </li>
              ))}
            </ul>
            <div>
              <button type="button" onClick={() => { setAsanaSent(null); reset(); }} className="min-h-11 rounded-full border border-line px-5 text-[14px] hover:border-faint">
                Start another request
              </button>
            </div>
          </div>
        ) : created ? (
          <Done numbers={created} formats={formats} team={team} clientName={client?.name ?? ""} onAgain={reset} />
        ) : readOnly ? (
          <ReadOnlyRequest draft={rawDraft} clientName={client?.name ?? ""} outside={outside} allowedPhrase={formatsPhrase(allowed)} />
        ) : (
          <form
            key={step}
            onSubmit={(e) => {
              e.preventDefault();
              if (step < STEPS.length - 1 && !blocked) go(step + 1);
            }}
            className="grid gap-8 animate-[step-in_.35s_cubic-bezier(.2,.8,.2,1)]"
          >
            <div className="grid gap-2">
              {client && step > 0 && (
                <div className="mb-2 flex items-center gap-2">
                  <ClientTag name={client.name} />
                  <button type="button" onClick={() => go(0)} className="-my-2 px-1 py-2 text-xs text-faint hover:text-fg md:my-0 md:px-0 md:py-0">
                    Change
                  </button>
                </div>
              )}
              <h1 className={`font-heading leading-tight tracking-tight ${step <= 1 ? "text-[32px] sm:text-[44px]" : "text-[28px] sm:text-[32px]"}`}>{heading[0]}</h1>
              <p className={step <= 1 ? "max-w-2xl text-[15px] text-muted" : "text-sm text-muted"}>{heading[1]}</p>
            </div>

            {step === 0 && <ClientPicker clients={clients} allotments={allotments} onPick={pickClient} />}

            {step === 1 && draft.clientId && client && (
              talking ? (
                <RequestChat clientId={draft.clientId} clientName={client.name} onUse={applyIdea} onPreview={(item) => preview.open(item.key, item)} onBack={() => closeParams("path")} />
              ) : (
                <StartPage
                  key={draft.clientId}
                  clientId={draft.clientId}
                  clientName={client.name}
                  aiOn={aiOn && !demo}
                  onPreview={(item) => preview.open(item.key, item)}
                  onManual={() => go(2)}
                  onTalk={() => pushParams({ path: "talk" })}
                  promises={(list) =>
                    demo ? null : (
                      <PromisesStrip clientId={draft.clientId ?? ""} preloaded={list} used={promise?.clientId === draft.clientId ? promise.id : null} onPreview={(item) => preview.open(item.key, item)} />
                    )
                  }
                />
              )
            )}

            {step === 2 && (
              <div className="grid gap-8">
                {leftOut.length > 0 && <LeftOutNote outside={leftOut} />}
                <div className={`grid gap-3 ${allowed.size >= 3 ? "sm:grid-cols-3" : allowed.size === 2 ? "sm:grid-cols-2" : ""}`}>
                  {FORMATS.filter((f) => allowed.has(f)).map((f) => {
                    const on = Boolean(draft.formats[f]);
                    const maker = team[MAKER[f].role];
                    return (
                      <button
                        key={f}
                        type="button"
                        role="checkbox"
                        aria-checked={on}
                        onClick={() => toggleFormat(f)}
                        className={`grid gap-4 rounded-[10px] border p-4 text-left transition-all ${
                          on ? "border-brand-text/60 bg-brand-soft shadow-[0_10px_30px_-18px_rgba(178,30,44,0.9)]" : "border-line bg-surface hover:border-faint"
                        }`}
                      >
                        <span className="flex items-start justify-between">
                          <span className={`grid h-10 w-10 place-items-center rounded-[8px] ${on ? "bg-brand text-white" : "bg-surface-2 text-muted"}`}>
                            <FormatIcon format={f} size={20} />
                          </span>
                          <span className={`grid h-5 w-5 place-items-center rounded-full border text-[11px] ${on ? "border-brand bg-brand text-white" : "border-line text-transparent"}`}>✓</span>
                        </span>
                        <span className="grid gap-0.5">
                          <span className="font-medium">{FORMAT_LABEL[f]}</span>
                          <span className="text-xs text-faint">{plural(TURNAROUND[f], "business day")}</span>
                        </span>
                        <span className="flex min-w-0 items-center gap-2 border-t border-line/70 pt-3 text-xs">
                          {maker ? (
                            <>
                              <PersonAvatar name={maker} size={20} />
                              <span className="truncate text-muted">{maker}</span>
                            </>
                          ) : (
                            <span className="text-warn">No {MAKER[f].label} assigned</span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {s && s.mix.some((m) => allowed.has(m.format)) && (
                  <div className="grid gap-3 rounded-[10px] border border-brand-text/20 bg-brand-soft/30 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="flex items-center gap-1.5 text-xs text-muted">
                        <Spark size={11} className="text-brand-text" /> Suggested for this client
                      </p>
                      <button type="button" onClick={() => applyMix(s)} className="h-10 shrink-0 rounded-full border border-brand-text/40 px-3 text-xs text-fg hover:bg-brand-soft md:h-8">
                        Use this mix
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {s.mix.filter((m) => allowed.has(m.format)).map((m) => (
                        <span key={m.format} className="inline-flex items-center gap-1.5 rounded-full bg-bg/60 px-3 py-1 text-xs">
                          <FormatIcon format={m.format} size={12} /> {FORMAT_LABEL[m.format]}
                          <span className="text-muted">· {countLabel(m.new, m.variations)}</span>
                        </span>
                      ))}
                      {s.sizes.length > 0 && <span className="tabular rounded-full bg-bg/60 px-3 py-1 text-xs text-muted">{s.sizes.map((z) => z.replace("x", ":")).join(" · ")}</span>}
                    </div>
                    {s.mixWhy && <p className="text-xs leading-relaxed text-muted">{s.mixWhy}</p>}
                  </div>
                )}

                <AllotmentBars allotment={allotment} formats={formats.map((f) => ({ format: f, ...draft.formats[f]! }))} />

                {formats.length > 0 && (
                  <Field label="How many" hint={`${plural(formats.length, "ticket")} · ${plural(total, "creative")}`}>
                    <div className="grid divide-y divide-line overflow-hidden rounded-[10px] border border-line bg-surface">
                      {formats.map((f) => {
                        const c = draft.formats[f]!;
                        return (
                          <div key={f} className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end sm:gap-6">
                            <span className="flex items-center gap-2 text-sm sm:h-11 md:h-10">
                              <FormatIcon format={f} size={16} /> {FORMAT_LABEL[f]}
                            </span>
                            <div className="grid grid-cols-[auto_auto_minmax(40px,1fr)] items-end gap-2 md:gap-3">
                              <Stepper label="Net new" value={c.new} onChange={(n) => setCount(f, "new", n)} />
                              <Stepper label="Variations" value={c.variations} max={MAX_VARIATIONS} onChange={(n) => setCount(f, "variations", n)} />
                              <span className="grid justify-items-end gap-1.5" title={conceptLine({ format: f, ...c })}>
                                <span className="text-[11px] text-faint">Total</span>
                                <span className={`tabular grid h-11 place-items-center text-lg md:h-10 ${c.new + c.variations === 0 ? "text-bad" : ""}`}>{c.new + c.variations}</span>
                              </span>
                            </div>
                            {f === "carousel" && (
                              <div className="flex flex-wrap items-end justify-between gap-3 border-t border-line pt-3 sm:col-span-2">
                                <span className="grid gap-0.5 text-sm">
                                  Cards per carousel
                                  <span className="text-[11px] text-faint">The upload gets a slot for each card, in order.</span>
                                </span>
                                <Stepper label="Cards" value={c.cards ?? 5} min={2} max={10} onChange={(n) => setCount(f, "cards", n)} />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <p className="text-xs leading-relaxed text-faint">
                      One concept per brief. <span className="text-muted">Net new</span> is a distinct design of it; a <span className="text-muted">variation</span> keeps the design and tests copy, headline or CTA (up to {MAX_VARIATIONS} per format). Every version counts toward the allotment, and each carousel slide; sizes of the same version don&apos;t.
                    </p>
                  </Field>
                )}

                <Field label="Sizes" hint="Sizes of one design count as one">
                  <div className="grid max-w-md grid-cols-3 gap-3">
                    {SIZES.map((z) => (
                      <AspectOption key={z} size={z} on={draft.sizes.includes(z)} onToggle={() => toggleSize(z)} />
                    ))}
                  </div>
                </Field>
              </div>
            )}

            {step === 3 && (
              <div className="grid gap-8">
                <Field id="title" label="Title">
                  <input id="title" autoFocus value={draft.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. BFCM · Buy More, Save More" className={input} />
                  <Suggest loading={ai.status === "loading"}>
                    {s?.titles.map((t) => (
                      <Chip key={t} ai on={draft.title === t} onClick={() => set({ title: t })}>
                        {t}
                      </Chip>
                    ))}
                  </Suggest>
                </Field>

                <Field id="angle" label="Angle or avatar" hint="Copy is written once per angle">
                  <input id="angle" value={draft.angle} onChange={(e) => set({ angle: e.target.value })} placeholder="Fresh, never frozen" className={input} />
                  <Suggest loading={ai.status === "loading"}>
                    {s?.angles.map((a) => (
                      <Chip key={a.name} ai title={a.why} on={draft.angle === a.name} onClick={() => set({ angle: a.name })}>
                        {a.name}
                      </Chip>
                    ))}
                    {(anglesByClient[draft.clientId ?? ""] ?? [])
                      .filter((a) => !s?.angles.some((x) => x.name === a))
                      .slice(0, 8)
                      .map((a) => (
                        <Chip key={a} on={draft.angle === a} onClick={() => set({ angle: a })}>
                          {a}
                        </Chip>
                      ))}
                  </Suggest>
                </Field>

                <Field id="audience" label="Audience">
                  <input id="audience" value={draft.audience} onChange={(e) => set({ audience: e.target.value })} placeholder="Parents of kids 5–12, retargeting" className={input} />
                  <Suggest loading={ai.status === "loading"}>
                    {s?.audiences.map((a) => (
                      <Chip key={a} ai on={draft.audience === a} onClick={() => set({ audience: a })}>
                        {a}
                      </Chip>
                    ))}
                  </Suggest>
                </Field>

                <Field label="Priority">
                  <div role="radiogroup" className="grid gap-3 sm:grid-cols-3">
                    {(
                      [
                        ["normal", "Normal", "Standard turnaround"],
                        ["high", "High", "Top of their queue"],
                        ["urgent", "Urgent", "Half the turnaround"],
                      ] as const
                    ).map(([v, l, h]) => (
                      <button
                        key={v}
                        type="button"
                        role="radio"
                        aria-checked={draft.priority === v}
                        onClick={() => set({ priority: v })}
                        className={`grid gap-0.5 rounded-[10px] border px-4 py-3 text-left transition-colors ${
                          draft.priority === v ? (v === "urgent" ? "border-bad/60 bg-bad-soft" : "border-brand-text/60 bg-brand-soft") : "border-line bg-surface hover:border-faint"
                        }`}
                      >
                        <span className="text-sm font-medium">{l}</span>
                        <span className="text-xs text-faint">{h}</span>
                      </button>
                    ))}
                  </div>
                </Field>
              </div>
            )}

            {step === 4 && (
              <div className="grid gap-8">
                <Field
                  id="brief"
                  label="Brief"
                  hint={
                    aiOn && (
                      <button
                        type="button"
                        onClick={draftBrief}
                        disabled={briefAi.status === "loading"}
                        className={`inline-flex items-center gap-1.5 rounded-full border border-brand-text/30 text-xs text-fg hover:bg-brand-soft disabled:opacity-80 ${briefAi.status === "loading" ? "h-9 w-64 max-w-[60vw] p-0 md:h-7" : "min-h-9 px-3 py-1 md:min-h-0"}`}
                      >
                        {briefAi.status === "loading" ? (
                          <AiProgressButton label="suggest" fallbackMs={20_000} text="Writing" />
                        ) : (
                          <>
                            <Spark size={10} className="text-brand-text" />
                            {draft.brief.trim() ? "Rewrite with AI" : "Draft with AI"}
                          </>
                        )}
                      </button>
                    )
                  }
                >
                  <textarea
                    id="brief"
                    autoFocus
                    rows={10}
                    value={draft.brief}
                    onChange={(e) => set({ brief: e.target.value })}
                    placeholder="What it should say and show. The hook, the offer, on-image text, anything the creative needs."
                    className="w-full rounded-[8px] border border-line bg-surface px-4 py-3.5 text-[15px] leading-relaxed outline-none transition-colors placeholder:text-faint focus:border-brand-text/70"
                  />
                  {briefAi.status === "offer" && (
                    <div className="grid gap-3 rounded-[10px] border border-brand-text/25 bg-brand-soft/30 p-4 animate-[step-in_.25s_ease-out]">
                      <p className="flex items-center gap-1.5 text-xs text-muted">
                        <Spark size={10} className="text-brand-text" /> Suggested brief
                      </p>
                      <p className="whitespace-pre-wrap text-sm leading-relaxed">{briefAi.text}</p>
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => (set({ brief: briefAi.text }), setBriefAi({ status: "idle" }))} className="h-10 rounded-full bg-fg px-3 text-xs text-bg md:h-8">
                          Replace mine
                        </button>
                        <button type="button" onClick={() => (set({ brief: `${draft.brief.trim()}\n\n${briefAi.text}` }), setBriefAi({ status: "idle" }))} className="h-10 rounded-full border border-line px-3 text-xs hover:border-faint md:h-8">
                          Add below mine
                        </button>
                        <button type="button" onClick={() => setBriefAi({ status: "idle" })} className="h-10 px-2 text-xs text-faint hover:text-fg md:h-8">
                          Dismiss
                        </button>
                      </div>
                    </div>
                  )}
                  {s && s.hooks.length > 0 && (
                    <div className="grid gap-2">
                      <span className="text-xs text-faint">Hooks to try · click to add</span>
                      <div className="flex flex-wrap gap-2">
                        {s.hooks.map((h) => (
                          <Chip key={h} ai on={draft.brief.includes(h)} onClick={() => !draft.brief.includes(h) && set({ brief: `${draft.brief.trimEnd()}${draft.brief.trim() ? "\n" : ""}Hook: ${h}` })}>
                            {h}
                          </Chip>
                        ))}
                      </div>
                    </div>
                  )}
                </Field>

                {s && s.watchouts.length > 0 && <Watchouts items={s.watchouts} />}

                <Field id="landing" label="Landing page" hint="Where the ad sends people">
                  <input
                    id="landing"
                    type="url"
                    value={draft.landing ?? ""}
                    onChange={(e) => set({ landing: e.target.value })}
                    placeholder="https://brand.com/offer"
                    className="h-11 w-full rounded-[8px] border border-line bg-surface px-4 text-sm outline-none transition-colors placeholder:text-faint focus:border-brand-text/70"
                  />
                </Field>

                <Field id="refs" label="References" hint="One link per line">
                  {draft.clientId && !demo && (
                    <SavedConcepts
                      clientId={draft.clientId}
                      added={draft.savedRefIds ?? []}
                      hint={`Starred for ${client?.name ?? "this client"} by the team. Add one and it goes with the brief to the designer or editor.`}
                      onAdd={async (r) => {
                        const href = savedHref(r, window.location.origin);
                        setDraft((d) => ({
                          ...d,
                          refs: href && !d.refs.includes(href) ? `${d.refs.trimEnd()}${d.refs.trim() ? "\n" : ""}${href}` : d.refs,
                          brief: href ? d.brief : `${d.brief.trimEnd()}${d.brief.trim() ? "\n\n" : ""}${savedLine(r)}`,
                          savedRefIds: [...new Set([...(d.savedRefIds ?? []), r.id])],
                        }));
                        return { ok: true };
                      }}
                    />
                  )}
                  <textarea
                    id="refs"
                    rows={3}
                    value={draft.refs}
                    onChange={(e) => set({ refs: e.target.value })}
                    placeholder="Motion snapshots, the ad to iterate, examples"
                    className="w-full rounded-[8px] border border-line bg-surface px-4 py-3 text-sm outline-none transition-colors placeholder:text-faint focus:border-brand-text/70"
                  />
                </Field>
              </div>
            )}

            {step === 5 && (
              <div className="grid gap-6">
                {leftOut.length > 0 && <LeftOutNote outside={leftOut} />}
                <ReadyToSend
                  draft={draft}
                  clientName={client?.name ?? ""}
                  team={team}
                  allotment={allotment}
                  demo={Boolean(demo)}
                  handleRef={readyRef}
                  // Edits here keep a finished review on screen (its fixes and dismissals still count); before one, they're simply the request
                  onChange={(p) => setDraft((d) => ({ ...d, ...(typeof p === "function" ? p(d) : p) }))}
                  onSplit={(rest, keep) => {
                    if (!draft.clientId) return;
                    set(keep);
                    const base: PreviewItem = { key: `split-${uid()}`, source: { kind: "idea", label: `Split from: ${draft.title}`.slice(0, 200), text: "" }, from: { kicker: "From a split", label: draft.title }, progressLabel: "brief from an idea+brief self-review", origin: draft.origin ?? null };
                    setQueue((q) => [
                      ...rest.map((c, i) => ({
                        ...base,
                        key: `${base.key}-${i}`,
                        // Each its own label (and so its own background brief), the concept first
                        source: { kind: "idea" as const, label: `${c.name.slice(0, 90)} (split from: ${draft.title})`.slice(0, 200), text: `${c.name}\n${c.body}` },
                        from: { kicker: "From a split", label: c.name || draft.title },
                        given: { title: c.name.slice(0, 80), concept: c.body.replace(/\s+/g, " ").slice(0, 400), angle: draft.angle, audience: draft.audience, hook: /Hook:\s*(.+)/.exec(c.body)?.[1] ?? "", formats: formats.slice(0, 1).map((f) => ({ format: f, new: 1, variations: 0 })), why: "", note: "" },
                      })),
                      ...q,
                    ]);
                  }}
                />

                {aiOn && !demo && draft.ai && review.status === "idle" && (
                  <p className="flex items-center gap-2 px-1 text-[12.5px] text-faint" aria-live="polite">
                    <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${unedited ? "bg-ok" : "bg-warn"}`} />
                    {unedited ? `Written by ${draft.ai.source.kind === "kaizen-ai" ? "Kaizen AI" : "the strategist"}, unchanged: goes straight through` : "Edited: the AI checks it before it goes out"}
                  </p>
                )}

                <div ref={reviewRef} className="grid min-w-0 grid-cols-[minmax(0,1fr)] empty:hidden">
                  {review.status === "running" && <Scanning />}
                  {review.status === "done" && handled && (
                    <ReviewWorkspace
                      review={review.review}
                      similar={review.similar}
                      refs={review.refs}
                      handled={handled}
                      brief={draft.brief}
                      onFix={fixWithAi}
                      onEdit={(f) => readyRef.current?.focus(FIELD_ID[f])}
                      onSetIssue={(i, st) => setHandled({ ...handled, issues: handled.issues.map((x, j) => (j === i ? st : x)) })}
                      onBrief={useStrongerBrief}
                      onSimilar={(n, st) => setHandled({ ...handled, similar: { ...handled.similar, [n]: st } })}
                      onUndo={undoAi}
                    />
                  )}
                </div>
                {review.status === "error" && (
                  <p className="rounded-[10px] border border-line bg-surface px-4 py-3 text-sm text-muted">
                    The AI review didn&apos;t run: {review.error} You can still send it.
                  </p>
                )}
              </div>
            )}

            {/* Footer */}
            {/* Phones: Back and Continue stay under the thumb, just above the tab bar */}
            {step === STEPS.length - 1 && (
              <div className="grid gap-1 px-1">
                <p className="font-heading text-[18px]">Where should it go?</p>
                <p className="text-[13px] text-muted">Create it here (the Board, the allotment and the AI review), send it to the Creative board in Asana exactly like a form request, or download it as a branded PDF.</p>
              </div>
            )}
            <div
              className={`sticky z-20 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t border-line bg-bg/95 px-4 py-3 backdrop-blur-xl md:mx-0 md:px-0 ${step === STEPS.length - 1 ? "bottom-[calc(59px+env(safe-area-inset-bottom))] md:bottom-0 md:rounded-[22px] md:border md:bg-surface/95 md:px-4 md:shadow-[0_20px_50px_-30px_rgba(0,0,0,0.6)]" : "bottom-[calc(59px+env(safe-area-inset-bottom))] md:static md:z-auto md:bg-transparent md:pb-0 md:pt-6 md:backdrop-blur-none"} ${step === 0 ? "hidden" : ""}`}
            >
              <div>
                {step > 0 && (
                  <button type="button" onClick={() => go(step - 1)} className="-ml-3 h-12 rounded-brand px-3 text-sm text-muted hover:bg-surface hover:text-fg md:ml-0 md:h-11 md:px-4">
                    ← Back
                  </button>
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-x-3 gap-y-2 md:flex-none md:gap-3">
                {(error || (blocked && step > 0)) && <span className={`text-right text-xs md:text-left md:text-sm ${error ? "text-brand-text" : "text-faint"}`}>{error ?? blocked}</span>}
                {step === STEPS.length - 1 && draft.clientId && !demo && (
                  <span className="flex items-center gap-2">
                    <AsanaSend
                      handleRef={asanaRef}
                      // A changed or hand-written brief gets the AI review first; the AI's own unchanged brief opens straight away
                      gate={() => {
                        if (unedited || !aiOn || review.status === "done" || review.status === "error") return true;
                        if (review.status !== "running") runReview("asana");
                        return false;
                      }}
                      preview={() => asanaPreview(draft)}
                      send={async () => {
                        const r = await sendToAsana(draft, review.status === "done" ? review.review : null, { reviewFailed: review.status === "error" });
                        // The server didn't find it to be the AI's unchanged brief: reviewed next time
                        if (!r.ok && r.needsReview) setServerEdited(true);
                        return r.ok || !r.needsReview ? r : { ok: false as const, error: "This brief was changed, so the AI checks it first. Close this and press Asana again." };
                      }}
                      label="Asana"
                      className="inline-flex h-12 items-center gap-2 rounded-full border border-line px-4 text-[14px] text-fg hover:border-faint md:h-11"
                      onSent={(tasks) => {
                        writeSaved(null, saveKey);
                        if (draft.clientId) forgetStart(draft.clientId);
                        setAsanaSent(tasks.map((t) => ({ name: t.name, url: t.url })));
                      }}
                    />
                    <BriefPdfButton body={() => ({ ...draft, clientId: draft.clientId })} onStructure={(pdfCache) => setDraft((d) => ({ ...d, pdfCache }))} className="inline-flex h-12 items-center gap-2 rounded-full border border-line px-4 text-[14px] text-fg hover:border-faint disabled:opacity-60 md:h-11" />
                  </span>
                )}
                {step < STEPS.length - 1 ? (
                  step > 0 && (
                    <button disabled={Boolean(blocked)} className="h-12 rounded-brand md:h-11 bg-brand px-6 text-sm font-medium text-white shadow-[0_8px_30px_-8px_rgba(178,30,44,0.7)] transition-colors hover:bg-brand-hover disabled:bg-surface-2 disabled:text-faint disabled:shadow-none">
                      Continue
                    </button>
                  )
                ) : review.status === "done" && handled ? (
                  (() => {
                    const openItems = handled.issues.filter((x) => x === "open").length + Object.values(handled.similar).filter((x) => x === "open").length;
                    return openItems > 0 ? (
                      <button
                        type="button"
                        disabled={pending || Boolean(handled.fixing)}
                        onClick={() => send(review.review)}
                        className="h-12 rounded-brand md:h-11 border border-line px-5 text-sm text-muted hover:border-faint hover:text-fg disabled:opacity-60"
                        title="Anything still open is noted on the tickets as dismissed"
                      >
                        {pending ? "Creating…" : `Send anyway · ${openItems} open`}
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={pending || Boolean(handled.fixing)}
                        onClick={() => send(review.review)}
                        className="inline-flex h-12 items-center md:h-11 gap-2 rounded-brand bg-brand px-6 text-sm font-medium text-white shadow-[0_8px_30px_-8px_rgba(178,30,44,0.7)] hover:bg-brand-hover disabled:opacity-70"
                      >
                        {pending ? "Creating…" : `Send to the team · ${plural(formats.length, "ticket")}`}
                      </button>
                    );
                  })()
                ) : (
                  <button
                    type="button"
                    disabled={pending || review.status === "running"}
                    // The AI's own unchanged brief: created at once, no review
                    onClick={() => (unedited && review.status !== "running" ? send(null) : review.status === "error" ? send(null, true) : runReview("here"))}
                    className="inline-flex h-12 items-center md:h-11 gap-2 rounded-brand bg-brand px-6 text-sm font-medium text-white shadow-[0_8px_30px_-8px_rgba(178,30,44,0.7)] transition-colors hover:bg-brand-hover disabled:opacity-70"
                  >
                    {aiOn && !unedited && review.status !== "error" && <Spark size={12} />}
                    {pending
                      ? "Creating…"
                      : review.status === "running"
                        ? "Reviewing…"
                        : review.status === "error"
                          ? "Send without review"
                          : aiOn
                            ? "Create here"
                            : `Create ${plural(formats.length, "ticket")}`}
                  </button>
                )}
              </div>
            </div>
          </form>
        )}
      </div>

      {preview.current && draft.clientId && (
        <QuickBriefSheet
          key={preview.current.key}
          clientId={draft.clientId}
          source={preview.current.source}
          from={preview.current.from}
          given={preview.current.given ?? null}
          // A split's brief, once it's being written, leaves the queue
          onStarted={() => {
            const key = preview.current?.key;
            if (key) setQueue((q) => q.filter((x) => x.key !== key));
          }}
          onClose={preview.close}
        />
      )}
    </div>
  );
}

const FORMAT_WORDS: Record<Format, string> = { image: "single images", video: "videos", carousel: "carousels" };
const listWords = (fs: Format[]) => {
  const w = fs.map((f) => FORMAT_WORDS[f]);
  return w.length > 1 ? `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}` : (w[0] ?? "");
};

/** Part of what the request was opened with is in a format this person doesn't request: left out, said plainly */
function LeftOutNote({ outside }: { outside: Format[] }) {
  return (
    <p className="rounded-[16px] border border-line bg-surface px-4 py-3 text-[13.5px] leading-relaxed text-muted">
      The {listWords(outside)} in this brief {outside.length > 1 ? "aren't" : "isn't"} here: your requests are for the formats you make. A lead can send {outside.length > 1 ? "those" : "that part"}.
    </p>
  );
}

/** Opened in a format this person doesn't request (a designer opening a video request): theirs to read, not to switch */
function ReadOnlyRequest({ draft, clientName, outside, allowedPhrase }: { draft: Draft; clientName: string; outside: Format[]; allowedPhrase: string }) {
  const fs = FORMATS.filter((f) => draft.formats[f]);
  return (
    <article className="relative isolate grid min-w-0 gap-5 overflow-hidden rounded-[28px] border border-line bg-surface px-5 pb-6 pt-5 shadow-[0_30px_80px_-50px_rgba(0,0,0,0.55)] md:px-8 md:pt-7">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        {clientName && <span className="rounded-full bg-fg px-3 py-1 font-medium text-bg">{clientName}</span>}
        <span className="rounded-full border border-line px-3 py-1 text-faint">Read only</span>
      </div>
      <p className="rounded-[16px] border border-warn/40 bg-warn-soft/40 px-4 py-3 text-[14px] leading-relaxed">
        This brief is for {listWords(outside)}. Your requests are for {allowedPhrase}, so it&apos;s here to read. A lead can send it, or change its format.
      </p>
      <h2 className="font-heading text-[28px] leading-[1.1] tracking-tight md:text-[34px]">{draft.title || "Untitled brief"}</h2>
      <div className="flex flex-wrap gap-2">
        {fs.map((f) => (
          <span key={f} className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1.5 text-[12.5px]">
            <FormatIcon format={f} size={13} /> {FORMAT_LABEL[f]} <span className="text-muted">· {countLabel(draft.formats[f]!.new, draft.formats[f]!.variations)}</span>
          </span>
        ))}
      </div>
      {(draft.angle || draft.audience) && (
        <dl className="grid gap-3 text-[14px] sm:grid-cols-2">
          {draft.angle && (
            <div className="grid gap-1">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Angle</dt>
              <dd>{draft.angle}</dd>
            </div>
          )}
          {draft.audience && (
            <div className="grid gap-1">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Audience</dt>
              <dd>{draft.audience}</dd>
            </div>
          )}
        </dl>
      )}
      {draft.brief.trim() && <p className="whitespace-pre-wrap text-[14.5px] leading-relaxed text-muted">{draft.brief}</p>}
      <div>
        <Link href="/board" className="inline-flex min-h-11 items-center rounded-full border border-line px-5 text-[14px] hover:border-faint">
          Back to the board
        </Link>
      </div>
    </article>
  );
}

/** A split's other briefs, waiting: each opens its quick preview and is written on its own */
function UpNext({ queue, onOpen, onDrop }: { queue: PreviewItem[]; onOpen: (item: PreviewItem) => void; onDrop: (key: string) => void }) {
  return (
    <section className="grid gap-3 rounded-[20px] border border-brand/30 bg-brand-soft/25 p-4">
      <p className="flex items-center gap-2 text-[13.5px] font-medium">
        <Spark size={12} className="text-brand-text" /> Up next from the split <span className="tabular rounded-full bg-bg/70 px-2 py-0.5 text-[11px] text-muted">{queue.length}</span>
      </p>
      <ul className="grid gap-2">
        {queue.map((q) => (
          <li key={q.key} className="flex flex-wrap items-center gap-3 rounded-[14px] border border-line bg-bg/70 px-3.5 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px]">{q.given?.title || q.from.label}</span>
              <span className="block truncate text-[12px] text-faint">{q.given?.concept || q.from.kicker}</span>
            </span>
            <button type="button" onClick={() => onDrop(q.key)} className="min-h-11 rounded-full px-3 text-[12.5px] text-faint hover:text-fg md:min-h-9">
              Skip
            </button>
            <button type="button" onClick={() => onOpen(q)} className="min-h-11 rounded-full bg-fg px-4 text-[13px] font-medium text-bg hover:opacity-90 md:min-h-9">
              Brief on this
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Suggest({ loading, children }: { loading: boolean; children: React.ReactNode }) {
  if (loading)
    return (
      <div className="flex gap-2" aria-label="Loading suggestions">
        {[96, 140, 80].map((w) => (
          <span key={w} className="relative h-7 overflow-hidden rounded-full bg-surface-2" style={{ width: w }}>
            <span className="absolute inset-y-0 w-1/2 bg-gradient-to-r from-transparent via-fg/10 to-transparent animate-[ai-sweep_1.4s_ease-in-out_infinite]" />
          </span>
        ))}
      </div>
    );
  const items = Array.isArray(children) ? children.flat().filter(Boolean) : children;
  if (!items || (Array.isArray(items) && items.length === 0)) return null;
  return <div className="flex flex-wrap gap-2">{children}</div>;
}

function Watchouts({ items }: { items: string[] }) {
  return (
    <div className="grid gap-2 rounded-[10px] border border-warn/25 bg-warn-soft/40 px-4 py-3.5">
      <p className="text-xs font-medium text-warn">From this client&apos;s feedback</p>
      <ul className="grid gap-1.5">
        {items.map((w) => (
          <li key={w} className="flex gap-2 text-sm text-muted">
            <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-warn" />
            {w}
          </li>
        ))}
      </ul>
    </div>
  );
}

const SCAN_LINES = ["Reading the client’s feedback history", "Checking the campaign direction", "Matching formats, sizes and brief", "Looking for anything Meta would reject"];

/** While the AI reviews the request: the steps, a percentage and the time left (timed from its recent reviews). */
function Scanning() {
  return (
    <div className="relative overflow-hidden rounded-[10px] border border-brand-text/25 bg-surface p-5" role="status">
      <span className="pointer-events-none absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-transparent via-brand/15 to-transparent animate-[ai-sweep_1.8s_ease-in-out_infinite]" />
      <div className="relative">
        <AiProgress size="sm" label="review" fallbackMs={25_000} title="Reviewing the request" steps={SCAN_LINES} />
      </div>
    </div>
  );
}

function sourcesLine(c: ContextSummary) {
  const parts = [plural(c.requests, "past request"), plural(c.angles, "angle"), plural(c.memory, "feedback note")];
  if (c.briefing) {
    const b = c.briefing;
    if (b.slack) parts.push(plural(b.slack, "Slack message"));
    if (b.gmail) parts.push(plural(b.gmail, "email"));
    if (b.drive) parts.push(plural(b.drive, "new Drive file"));
  }
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** The AI's status on one line above the form (the steps after Start). */
function AiStrip({ aiOn, ai, clientName, onRefresh }: { aiOn: boolean; ai: AiState; clientName: string | null; onRefresh: () => void }) {
  if (!aiOn || !clientName) return null;
  return (
    <div className="flex items-center gap-3 rounded-[10px] border border-line bg-surface px-3.5 py-2.5 text-xs text-muted">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand to-[#5a0f16] text-white">
        <Spark size={11} className={ai.status === "loading" ? "animate-[ai-pulse_1s_ease-in-out_infinite]" : ""} />
      </span>
      <span className="min-w-0 flex-1 truncate">
        {ai.status === "loading"
          ? `Reading ${clientName}\u2019s history\u2026`
          : ai.status === "ready"
            ? `${ai.prepared ? "Prepared" : "Suggested"} from ${sourcesLine(ai.context)}`
            : ai.status === "error"
              ? ai.error
              : "Kaizen AI is standing by"}
      </span>
      {ai.status !== "loading" && (
        <button type="button" onClick={onRefresh} className="-my-2 inline-flex min-h-11 shrink-0 items-center px-2 text-faint hover:text-fg md:my-0 md:min-h-0 md:px-0">
          {ai.status === "error" ? "Retry" : "Refresh"}
        </button>
      )}
    </div>
  );
}

function Done({
  numbers,
  formats,
  team,
  clientName,
  onAgain,
}: {
  numbers: number[];
  formats: Format[];
  team: Record<string, string>;
  clientName: string;
  onAgain: () => void;
}) {
  const makers = [...new Set(formats.map((f) => team[MAKER[f].role]).filter(Boolean))];
  return (
    <div className="grid justify-items-start gap-6 animate-[step-in_.4s_cubic-bezier(.2,.8,.2,1)]">
      <span className="grid h-14 w-14 place-items-center rounded-full bg-ok-soft text-2xl text-ok ring-8 ring-ok-soft/40">✓</span>
      <div className="grid gap-2">
        <h1 className="font-heading text-[32px] leading-tight">{numbers.length === 1 ? "Request sent" : `${numbers.length} tickets created`}</h1>
        <p className="text-sm text-muted">
          {clientName} · {makers.length ? `${makers.join(" and ")} ${makers.length === 1 ? "has" : "have"} it now.` : "It's on the board, waiting for someone to pick it up."} The turnaround clock is running.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {numbers.map((n, i) => (
          <Link key={n} href={`/board?t=${n}`} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-1.5 text-sm hover:border-faint md:min-h-0 md:px-3">
            {formats[i] && <FormatIcon format={formats[i]} />}
            <span className="tabular text-muted">#{n}</span>
            {formats[i] && FORMAT_LABEL[formats[i]]}
          </Link>
        ))}
      </div>
      <div className="flex flex-wrap gap-3">
        <Link href={`/board?t=${numbers[0]}`} className="grid h-11 place-items-center rounded-brand bg-brand px-6 text-sm font-medium text-white hover:bg-brand-hover">
          Open the board
        </Link>
        <button type="button" onClick={onAgain} className="h-11 rounded-brand border border-line px-5 text-sm text-muted hover:border-faint hover:text-fg">
          Request another
        </button>
      </div>
    </div>
  );
}

/** Moving a task over from Asana: where it lands, and what that stage needs before it can sit there. */
function MigrationPanel({ m, onChange }: { m: import("./draft").Migration; onChange: (m: import("./draft").Migration) => void }) {
  return (
    <div className="grid gap-3 rounded-[12px] border border-dashed border-brand/50 bg-brand-soft/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          Migrating from Asana: <span className="font-medium">{m.name}</span>
        </p>
        <a href={m.url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center md:min-h-0 text-xs text-muted hover:text-fg">
          Open in Asana ↗
        </a>
      </div>
      <p className="text-xs text-muted">
        Filled in from the task. Check the formats and counts, then it lands in <b className="text-fg">{m.stageLabel}</b>, where it&apos;s up to in Asana, and is worked here from now on.
      </p>
      {m.needsCreative && (
        <label className="grid gap-1 text-xs text-muted">
          The current creative (a Drive folder or file link): it&apos;s already past production
          <input value={m.creativeLink} onChange={(e) => onChange({ ...m, creativeLink: e.target.value })} placeholder="https://drive.google.com/…" className="h-10 rounded-[10px] border border-line bg-bg px-3 text-sm text-fg" />
        </label>
      )}
      {m.needsCopy && (
        <label className="grid gap-1 text-xs text-muted">
          The copy as it stands (it&apos;s past copy)
          <textarea value={m.copy} onChange={(e) => onChange({ ...m, copy: e.target.value })} rows={4} className="rounded-[10px] border border-line bg-bg px-3 py-2 text-sm text-fg" />
        </label>
      )}
    </div>
  );
}
