"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { PriorityBadge } from "@/components/priority-badge";
import { useFabClear } from "@/components/fab-clear";
import { closeParams, closeThen, pushParams, useParam } from "@/lib/url-state";
import { filesFromDrop } from "@/lib/uploads/media";
import { MAKING, makingMinutes, span, ticketRole, ticketView, type Cta, type LaunchState, type Section } from "@/lib/ticket-layout";
import { PHASE_LABEL, health, stageInfo, type Phase, type Stage } from "@/lib/stages";
import { MoveDialog } from "./move-dialog";
import { moveTicket, ticketHistory, type TicketEvent } from "./actions";
import { briefChanges, type BriefChange, type Design } from "./design-actions";
import { Deliverables, dropFiles, pickFiles, type UploadState } from "./deliverables";
import { reviewCreative, sendOn, startAiReview } from "./review-actions";
import { prepareVideos } from "./prepare-videos";
import { Progress, ScanIcon, useReview, VERDICT } from "./ai-review";
import { ReviewPanel } from "./review-panel";
import { CopyPanel } from "./copy-panel";
import { CarouselCards } from "./carousel-cards";
import { CopyProgress } from "./copy-studio";
import { approveCopy, ticketCopy, type CopyState } from "./copy-actions";
import { launchFor, startLaunch, type LaunchView } from "./launch-actions";
import { completeTicket } from "./ticket-done-actions";
import { startProduction } from "./ticket-copy-actions";
import { ClientTag, TimeStamp } from "./ticket-card";
import { BriefEssentials } from "./ticket-essentials";
import { TicketBrief } from "./ticket-brief";
import { BriefChat } from "./brief-chat";
import { CopyDraftPanel } from "./copy-draft-panel";
import { BriefPdfSheet } from "./brief-pdf-sheet";
import { LauncherSheet } from "./launcher-sheet";
import { RevisionDialog } from "./revision-dialog";
import { TicketActivity, fmtDate } from "./ticket-activity";
import { AiSummary, CreativeStrip, RatioBars, Story, TicketSummary, card, label } from "./ticket-parts";
import { ScriptPanel } from "./script-panel";
import { addTicketRef } from "../media-actions";
import { HiggsfieldPanel } from "@/components/media/higgsfield-panel";
import { MotionReferences } from "@/components/media/motion-references";
import { VoiceoverPanel } from "@/components/media/voiceover-panel";
import { LinkCards } from "@/components/link-refs";
import { SavedConcepts } from "@/components/saved-concepts";
import { parseBriefFileUrl } from "@/lib/brief-files";
import { savedHref } from "@/lib/saved-references";
import { markSavedUsed } from "../requests/new/saved-actions";
import type { Person, Ticket } from "./types";

// The ticket, stage by stage (the owner, Nov 2026): a compact header, the brief's summary, then only what this stage
// needs, and one main action pinned at the bottom that changes as the work moves (src/lib/ticket-layout.ts). Activity,
// the full brief, the AI tools and moving to any stage sit behind "More". The windows it opens (the creative viewer,
// the copy studio, the AI review, the Ads launcher) are the existing ones, unchanged.

const PHASES: Phase[] = ["brief", "make", "review", "client", "launch"];
type View = "activity" | "brief" | "tools";
const VIEWS: View[] = ["activity", "brief", "tools"];

const DEMO_HISTORY = (t: Ticket): TicketEvent[] => [
  { id: "d1", kind: "created", fromStage: null, toStage: "requested", actor: t.buyerName, body: null, data: {}, at: t.createdAt },
  { id: "d2", kind: "stage", fromStage: "requested", toStage: "in_production", actor: t.creativeName, body: null, data: {}, at: t.stageEnteredAt },
  { id: "d3", kind: "comment", fromStage: null, toStage: null, actor: "Jesus", body: "Lead with the price. The calzone should be cut open so you see the cheese pull.", data: {}, at: t.stageEnteredAt },
];

const DEMO_DESIGNS: Design[] = [
  { id: "dd1", position: 1, name: "Calzone pull", isVariation: false, variationOf: null, currentVersion: 2, versions: [
    { id: "dv2", version: 2, note: "Bigger price, logo top left", by: "Nelson", at: "2026-10-13T15:20:00Z", files: [
      { id: "f1", name: "calzone_4x5.jpg", mime: "image/jpeg", bytes: 820000, aspect: "4x5", width: 1080, height: 1350, durationMs: null, card: null, url: null, thumbUrl: null },
      { id: "f2", name: "calzone_9x16.jpg", mime: "image/jpeg", bytes: 910000, aspect: "9x16", width: 1080, height: 1920, durationMs: null, card: null, url: null, thumbUrl: null },
    ] },
    { id: "dv1", version: 1, note: null, by: "Nelson", at: "2026-10-12T19:02:00Z", files: [] },
  ] },
  { id: "dd2", position: 2, name: "Calzone pull · CTA test", isVariation: true, variationOf: "dd1", currentVersion: 1, versions: [
    { id: "dv3", version: 1, note: null, by: "Nelson", at: "2026-10-13T15:40:00Z", files: [
      { id: "f3", name: "calzone_cta_4x5.jpg", mime: "image/jpeg", bytes: 800000, aspect: "4x5", width: 1080, height: 1350, durationMs: null, card: null, url: null, thumbUrl: null },
    ] },
  ] },
];

/** Going back where the flow allows it (behind More) */
const BACK: Partial<Record<Stage, { to: Stage; label: string }>> = {
  in_production: { to: "requested", label: "Back to request" },
  client_revision: { to: "client_review", label: "Back to the client" },
  ready_for_launch: { to: "client_review", label: "Back to the client" },
};
const COPY_STAGES: Stage[] = ["copy", "copy_review", "ready_for_client", "client_review", "client_revision", "ready_for_launch", "launched"];
const CLIENT_STAGES: Stage[] = ["ready_for_client", "client_review", "client_revision", "ready_for_launch"];

/** A brief adjustment the maker logged (what wasn't possible): shown with the full brief */
function BriefAdjustments({ ticketId }: { ticketId: string }) {
  const [list, setList] = useState<BriefChange[]>([]);
  useEffect(() => {
    let live = true;
    const load = () => briefChanges(ticketId).then((l) => live && setList(l));
    load();
    const on = (e: Event) => (e as CustomEvent).detail === ticketId && load();
    window.addEventListener("kz:brief", on);
    return () => {
      live = false;
      window.removeEventListener("kz:brief", on);
    };
  }, [ticketId]);
  if (!list.length) return null;
  return (
    <div className="grid gap-2 rounded-[12px] border border-warn/40 bg-warn-soft/40 px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-warn">Brief adjusted</p>
      {list.map((c, i) => (
        <div key={i} className="grid gap-0.5">
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{c.note}</p>
          <p className="text-[11px] text-faint">
            {c.by} · {fmtDate(c.at)}
          </p>
        </div>
      ))}
    </div>
  );
}

/** Opened the creative (creative review) or the copy (copy review) at this stage: the decision comes next */
function useOpened(ticket: Ticket) {
  const key = `kz:opened:${ticket.id}:${ticket.stage}`;
  const read = (k: string) => {
    try {
      return typeof window !== "undefined" && localStorage.getItem(k) === "1";
    } catch {
      return false;
    }
  };
  // Kept per stage: a ticket that moves while open reads its new stage's flag
  const [opened, setOpened] = useState(() => ({ key, on: read(key) }));
  if (opened.key !== key) setOpened({ key, on: read(key) });
  const mark = useCallback(() => {
    setOpened({ key, on: true });
    try {
      localStorage.setItem(key, "1");
    } catch {}
  }, [key]);
  return [opened.key === key && opened.on, mark] as const;
}

export function TicketDrawer({
  ticket,
  people,
  can = { review: false, approveCopy: false },
  meId = null,
  onClose,
  onOptimisticMove,
  demo = false,
}: {
  ticket: Ticket;
  people: Person[];
  can?: { review: boolean; approveCopy: boolean; exec?: boolean };
  /** Who's looking: the ticket opens on what they act on */
  meId?: string | null;
  onClose: () => void;
  onOptimisticMove: (id: string, stage: Stage) => void;
  demo?: boolean; // design preview: sample history, no server calls
}) {
  const stage = ticket.stage;
  const info = stageInfo(stage);
  const h = health(ticket.minutesOver, stage);
  const role = ticketRole(can, Boolean(meId && meId === ticket.assigneeId));
  const making = MAKING.includes(stage);
  const [history, setHistory] = useState<TicketEvent[] | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // A step that needs a word before it goes: sending with open comments, sending the creative back
  const [step, setStep] = useState<null | { kind: "send" | "changes"; note: string }>(null);

  // Places of their own in the address, so back closes them: the views behind More, the brief PDF, the launcher,
  // the revision dialog, the move dialog (the creative viewer and the copy studio keep theirs)
  const viewParam = useParam("tab");
  const view: View | null = VIEWS.includes(viewParam as View) ? (viewParam as View) : null;
  const briefOpen = useParam("brief") === "pdf";
  const launcherOpen = useParam("launcher") === "1";
  const reviseOpen = useParam("revise") === "1";
  const moving = useParam("move") === String(ticket.number);
  const designParam = useParam("design");
  const copyParam = useParam("copy");

  // The creative (from the uploads), the AI review, the copy and the launch, each only where the stage reads it
  const [uploads, setUploads] = useState<UploadState>({ uploaded: 0, uploading: 0, loaded: false, missing: [] });
  const onUploads = useCallback((u: UploadState) => setUploads(u), []);
  const reviewing = making || stage === "internal_review";
  const [review, setReview] = useReview(ticket.id, demo || !reviewing, making);
  const [copy, setCopy] = useState<CopyState | null>(null);
  const [launch, setLaunch] = useState<LaunchView | null>(null);
  const [opened, markOpened] = useOpened(ticket);
  // Start production just kicked off the copywriter: the copy panel shows it writing until it lands
  const [copyStarted, setCopyStarted] = useState(false);

  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [view]);

  const reload = useCallback(() => (demo ? Promise.resolve().then(() => setHistory(DEMO_HISTORY(ticket))) : ticketHistory(ticket.id).then(setHistory)), [demo, ticket]);
  useEffect(() => {
    void reload();
    // Escape closes what's on top: the windows over the ticket handle their own
    const esc = (e: KeyboardEvent) => {
      const q = new URLSearchParams(window.location.search);
      if (e.key === "Escape" && !["move", "copy", "design", "brief", "launcher", "revise"].some((k) => q.has(k))) onClose();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
    // The board remounts this drawer per ticket (key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket.id]);

  // The copy set (copy stages on): for the summary card, approving, and the client and launch stages
  const copyStage = COPY_STAGES.includes(stage);
  useEffect(() => {
    if (demo || !copyStage) return;
    let live = true;
    const load = () => ticketCopy(ticket.id).then((s) => live && setCopy(s));
    void load();
    // While the AI writes the ad copy, check back
    const t = stage === "copy" ? setInterval(load, 3000) : null;
    return () => {
      live = false;
      if (t) clearInterval(t);
    };
  }, [ticket.id, stage, copyStage, demo]);

  // The launch (Ready to launch and after): what the bar offers, and the Ads Manager link once it's made
  const launchStage = stage === "ready_for_launch" || stage === "launched";
  useEffect(() => {
    if (demo || !launchStage || launcherOpen) return;
    let live = true;
    void launchFor(ticket.id).then((l) => live && setLaunch(l));
    return () => {
      live = false;
    };
  }, [ticket.id, launchStage, launcherOpen, demo]);
  useEffect(() => {
    if (demo || !launch || !["planning", "launching"].includes(launch.status)) return;
    const t = setInterval(() => void launchFor(ticket.id).then(setLaunch), 4000);
    return () => clearInterval(t);
  }, [launch, ticket.id, demo]);

  // Opening the creative (creative review) or the copy (copy review) counts as having looked: the decision comes next
  useEffect(() => {
    if ((stage === "internal_review" && designParam) || (stage === "copy_review" && copyParam === "1")) markOpened();
  }, [stage, designParam, copyParam, markOpened]);

  // The first AI review starts on its own the moment everything asked for is in (the existing rule)
  const autoStarted = useRef(false);
  const autoReady = making && !demo && uploads.loaded && uploads.uploaded > 0 && uploads.uploading === 0 && !uploads.missing.length && review !== null && review.runs === 0 && !review.latest;
  useEffect(() => {
    if (!autoReady || autoStarted.current) return;
    autoStarted.current = true;
    void startAiReview(ticket.id, { auto: true }).then((r) => r.ok && setReview(r.state));
  }, [autoReady, ticket.id, setReview]);

  const run = review?.latest ?? null;
  const openComments = uploads.comments?.open ?? 0;
  const launchState: LaunchState | undefined = launch
    ? { status: launch.status === "discarded" ? "none" : launch.status, link: launch.result?.link ?? null, sandbox: launch.sandbox }
    : launchStage
      ? { status: "none", link: null, sandbox: false }
      : undefined;
  const layout = ticketView(stage, role, {
    production: {
      uploaded: uploads.uploaded || (demo ? 2 : 0),
      uploading: uploads.uploading,
      missing: uploads.missing,
      review: { status: run ? run.status : "none", current: Boolean(run?.current) },
      openComments,
    },
    opened,
    launch: launchState,
  });
  const has = (s: Section) => layout.sections.includes(s);

  const act = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>, after?: () => void) =>
    start(async () => {
      if (demo) return after?.();
      setError(null);
      const res = await fn();
      if (!res.ok) setError(res.error);
      else {
        after?.();
        void reload();
      }
    });
  // Moved on: the ticket closes (the work here is done)
  const moved = (to: Stage) => {
    onOptimisticMove(ticket.id, to);
    onClose();
  };
  const move = (to: Stage, note?: string) => act(() => moveTicket(ticket.id, to, note), () => moved(to));

  const openCreative = () => {
    const first = uploads.comments?.first;
    const d = uploads.designs?.[0];
    if (first) pushParams({ design: first.designId, ver: null, pin: first.commentId });
    else if (d) pushParams({ design: d.id, ver: null, pin: null });
    else setError("No creative uploaded yet.");
  };
  const reviewNow = () =>
    act(async () => {
      // Videos are watched first (frames and audio), so the review sees the whole thing
      const problem = await prepareVideos(ticket.id, () => {}).catch(() => null);
      const r = await startAiReview(ticket.id);
      if (!r.ok) return r;
      setReview(r.state);
      if (problem) setError(problem);
      return { ok: true as const };
    });
  const send = (note: string) => {
    const clean = run?.status === "done" && run.current && run.notes?.verdict !== "fix";
    act(() => sendOn(ticket.id, { force: !clean || openComments > 0, note }), () => moved(info.next!));
  };

  const primary = (c: Cta) => {
    setError(null);
    switch (c.kind) {
      case "start-production":
        // The ticket stays open on In production, where the copywriter is already writing
        return act(async () => {
          const r = await startProduction(ticket.id);
          if (!r.ok) return r;
          setCopyStarted(r.copy);
          onOptimisticMove(ticket.id, "in_production");
          return { ok: true as const };
        }, demo ? () => onOptimisticMove(ticket.id, "in_production") : undefined);
      case "upload":
        return pickFiles(ticket.id, "new");
      case "upload-version":
        return pickFiles(ticket.id, "version");
      case "ai-review":
        return reviewNow();
      case "view-comments":
      case "view-creative":
      case "review-creative":
        return openCreative();
      case "send-approval":
        // Open comments or a review with fixes go along with a word for the lead; a clean review just goes
        if (openComments > 0 || run?.notes?.verdict === "fix" || !run?.current) return setStep({ kind: "send", note: "" });
        return send("");
      case "approve-creative":
        return act(async () => {
          const r = await reviewCreative(ticket.id, "approve");
          if (!r.ok) return r;
          moved(r.stage as Stage);
          return { ok: true as const };
        });
      case "view-copy":
      case "review-copy":
        return pushParams({ copy: "1" });
      case "approve-copy":
        return act(async () => {
          // The words as saved now (the studio saves edits as they're typed), never an older copy of them
          const fresh = await ticketCopy(ticket.id);
          setCopy(fresh);
          const set = fresh.set;
          if (!set || set.status !== "review") return { ok: false as const, error: "The copy isn't ready for approval yet." };
          const r = await approveCopy(set.id, set.ads);
          if (!r.ok) return { ok: false as const, error: r.violations?.length ? `${r.violations.length} line${r.violations.length === 1 ? " goes" : "s go"} against what ${ticket.clientName} told us. Review the copy to fix ${r.violations.length === 1 ? "it" : "them"}.` : r.error };
          moved("client_review");
          return { ok: true as const };
        });
      case "client-approved":
        return move("ready_for_launch");
      case "client-revision":
        return pushParams({ revise: "1" });
      case "make-live":
        return act(async () => {
          if (!launch) {
            const r = await startLaunch(ticket.id);
            if (!r.ok) return r;
          }
          pushParams({ launcher: "1" });
          return { ok: true as const };
        });
      case "ads-manager":
        if (launchState?.link) window.open(launchState.link, "_blank", "noopener,noreferrer");
        return;
      case "complete":
        return act(() => completeTicket(ticket.id), () => moved("launched"));
    }
  };

  // The bar's height keeps the feedback bubble above it, so it never covers the main action
  const barRef = useRef<HTMLDivElement>(null);
  const [barH, setBarH] = useState(0);
  const bar = !view && (Boolean(layout.bar.primary) || Boolean(layout.bar.wait) || layout.bar.secondary.length > 0 || Boolean(step));
  useEffect(() => {
    const el = barRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setBarH(Math.ceil(el.getBoundingClientRect().height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [bar]);
  useFabClear(barH, bar && barH > 0);

  // Files dropped anywhere on a ticket being made upload like a drop on the creative
  const [over, setOver] = useState(false);
  const dropProps = making && !demo
    ? {
        onDragOver: (e: React.DragEvent) => {
          if (![...e.dataTransfer.types].includes("Files")) return;
          e.preventDefault();
          setOver(true);
        },
        onDragLeave: (e: React.DragEvent) => e.currentTarget.contains(e.relatedTarget as Node) || setOver(false),
        onDrop: async (e: React.DragEvent) => {
          setOver(false);
          // A drop on the creative itself is handled there
          if (e.defaultPrevented) return;
          e.preventDefault();
          const files = await filesFromDrop(e.dataTransfer.items);
          if (files.length) dropFiles(ticket.id, files);
        },
      }
    : {};

  const who = ticket.assigneeName ?? (info.owner || null);
  const canMove = stage !== "launched" && !demo;
  const back = BACK[stage];
  const phase = PHASES.indexOf(info.phase);
  const refFiles = ticket.refs.filter((r) => parseBriefFileUrl(r));
  const refLinks = ticket.refs.filter((r) => !parseBriefFileUrl(r));
  const productionTime = useMemo(() => (history ? span(makingMinutes(history.map((e) => ({ kind: e.kind, toStage: e.toStage, at: e.at, data: e.data })))) : null), [history]);

  const menu: { label: string; run: () => void; tone?: "bad" }[] = [
    { label: "Activity", run: () => pushParams({ tab: "activity" }) },
    { label: "Full brief and references", run: () => pushParams({ tab: "brief" }) },
    ...(making || stage === "requested" ? [{ label: ticket.format === "video" ? "Script, voiceover and AI footage" : "AI images and video", run: () => pushParams({ tab: "tools" }) }] : []),
    ...(stage === "internal_review" && can.review ? [{ label: "Send back with changes", run: () => setStep({ kind: "changes", note: "" }) }] : []),
    ...(back && canMove ? [{ label: back.label, run: () => move(back.to) }] : []),
    ...(CLIENT_STAGES.includes(stage) ? [{ label: "Open the client's view ↗", run: () => window.open(`/c/${ticket.clientSlug}`, "_blank", "noopener,noreferrer") }] : []),
    ...(canMove ? [{ label: "Move to any stage…", run: () => pushParams({ move: String(ticket.number) }) }] : []),
  ];

  const sectionsOf: Record<Section, () => React.ReactNode> = {
    "brief-chat": () => <BriefChat key="brief-chat" ticket={ticket} demo={demo} />,
    "copy-draft": () => <CopyDraftPanel key="copy-draft" ticket={ticket} demo={demo} starting={copyStarted} />,
    ratios: () => (uploads.loaded || demo ? <RatioBars key="ratios" ticket={ticket} designs={uploads.designs ?? []} /> : null),
    creative: () => (
      <section key="creative" className={card} aria-label="Creative">
        {run && (
          <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-[12px] bg-bg/60 px-3.5 py-3">
            <ScanIcon className="h-4 w-4 shrink-0 text-[#6c7ee1]" />
            {run.status === "running" ? (
              <div className="min-w-0 flex-1">
                <Progress p={run.progress} />
              </div>
            ) : (
              <>
                <span className="text-sm font-medium">AI review</span>
                {run.status === "done" && run.notes && <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${VERDICT[run.notes.verdict].cls}`}>{run.current ? VERDICT[run.notes.verdict].label : "Files changed since"}</span>}
                {run.status === "failed" && <span className="text-xs text-muted">{run.error ?? "Didn't finish"}</span>}
                <span className="ml-auto text-xs text-faint">{openComments ? `${openComments} open comment${openComments === 1 ? "" : "s"}` : uploads.comments?.resolved ? "All comments resolved" : ""}</span>
              </>
            )}
          </div>
        )}
        <Deliverables ticket={ticket} demoDesigns={demo ? DEMO_DESIGNS : undefined} onState={onUploads} canDisagree={can.review} />
      </section>
    ),
    "client-notes": () => <ReviewPanel key="client-notes" ticket={ticket} canReview={can.review} onMoved={moved} demo={demo} />,
    "ai-summary": () => <AiSummary key="ai-summary" ticket={ticket} state={review} showForced={can.review} />,
    story: () => <Story key="story" designs={uploads.designs ?? []} comments={uploads.comments} minutes={productionTime} rounds={ticket.internalRounds ?? 0} />,
    "creative-strip": () => <CreativeStrip key="creative-strip" designs={uploads.designs ?? []} loaded={uploads.loaded || demo} />,
    copy: () => <CopyCard key="copy" ticket={ticket} state={copy} demo={demo} />,
    "copy-strip": () => <CopyCard key="copy-strip" ticket={ticket} state={copy} demo={demo} compact />,
    launcher: () => <LauncherCard key="launcher" launch={launch} onOpen={() => pushParams({ launcher: "1" })} />,
    done: () => <DoneCard key="done" ticket={ticket} launch={launch} />,
  };

  const button = "min-h-12 rounded-[14px] px-5 text-[15px] font-medium transition-colors disabled:opacity-60 md:min-h-11 md:text-sm";

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`Ticket ${ticket.number}`}>
      <button aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/60 backdrop-blur-[2px] animate-[sheet-fade_.2s_ease-out]" />
      <aside {...dropProps} className="relative flex h-full w-full max-w-[640px] flex-col border-l border-line bg-bg shadow-2xl animate-[drawer-right_.25s_cubic-bezier(.2,.8,.2,1)] max-md:border-l-0">
        {over && (
          <div className="pointer-events-none absolute inset-3 z-30 grid place-items-center rounded-[20px] border-2 border-dashed border-brand-text bg-brand-soft/70 backdrop-blur-sm">
            <p className="font-heading text-[18px]">Drop to upload</p>
          </div>
        )}

        {/* The compact header: number, client, title, stage, who has it, due */}
        <header className="grid gap-2.5 border-b border-line px-7 pb-4 pt-5 max-md:px-4 max-md:pt-[calc(0.5rem+env(safe-area-inset-top))]">
          <div className="flex items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              <span className="tabular text-xs text-faint">#{ticket.number}</span>
              <ClientTag name={ticket.clientName} />
              {ticket.priority !== "normal" && <PriorityBadge priority={ticket.priority} size="md" />}
            </div>
            <div className="relative">
              <button
                type="button"
                onClick={() => setMenuOpen((o) => !o)}
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                aria-label="More"
                className="grid h-11 w-11 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg md:h-9 md:w-9"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
                  <circle cx="3" cy="8" r="1.4" fill="currentColor" />
                  <circle cx="8" cy="8" r="1.4" fill="currentColor" />
                  <circle cx="13" cy="8" r="1.4" fill="currentColor" />
                </svg>
              </button>
              {menuOpen && (
                <>
                  <button type="button" aria-label="Close menu" onClick={() => setMenuOpen(false)} className="fixed inset-0 z-10 cursor-default" />
                  <div role="menu" className="absolute right-0 top-[calc(100%+6px)] z-20 grid w-64 gap-0.5 rounded-[14px] border border-line bg-surface p-1.5 shadow-2xl">
                    {menu.map((m) => (
                      <button key={m.label} role="menuitem" type="button" disabled={pending} onClick={() => (setMenuOpen(false), m.run())} className="flex min-h-11 items-center rounded-[10px] px-3 text-left text-sm hover:bg-surface-2 disabled:opacity-60">
                        {m.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <button onClick={onClose} className="-mr-2 grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg md:h-9 md:w-9" aria-label="Close ticket">
              ✕
            </button>
          </div>

          <h2 className="line-clamp-2 font-heading text-[22px] leading-tight max-md:text-[20px] max-md:[overflow-wrap:anywhere]">{ticket.title}</h2>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 font-medium text-fg">
              <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${h === "bad" ? "bg-bad" : h === "warn" ? "bg-warn" : stage === "launched" ? "bg-ok" : "bg-brand"}`} />
              {stage === "launched" ? "Completed" : info.label}
            </span>
            {who && stage !== "launched" && <span className="text-muted">with {who}</span>}
            {ticket.stageDueAt && stage !== "launched" && <span className="tabular text-muted">Due {fmtDate(ticket.stageDueAt)}</span>}
            {stage !== "launched" && (
              <span className="ml-auto">
                <TimeStamp ticket={ticket} label />
              </span>
            )}
          </div>
          <div className="grid grid-cols-5 gap-1" aria-label={`Phase: ${PHASE_LABEL[info.phase]}`}>
            {PHASES.map((p, i) => (
              <span key={p} title={PHASE_LABEL[p]} className={`h-1 rounded-full ${i < phase || stage === "launched" ? "bg-fg/40" : i === phase ? (h === "bad" ? "bg-bad" : h === "warn" ? "bg-warn" : "bg-brand") : "bg-surface-2"}`} />
            ))}
          </div>
        </header>

        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden max-md:overscroll-contain">
          <div className={`grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-5 px-7 py-6 [overflow-wrap:anywhere] max-md:gap-4 max-md:px-4 max-md:py-5 ${bar ? "" : "max-md:pb-[calc(1.5rem+env(safe-area-inset-bottom))]"}`}>
            {view ? (
              <>
                <button type="button" onClick={() => closeParams("tab")} className="-my-2 min-h-11 justify-self-start text-sm text-muted hover:text-fg">
                  ← Back to the ticket
                </button>
                {view === "activity" && <TicketActivity ticket={ticket} people={people} history={history} pending={pending} run={act} canDelete={can.review} readOnly={layout.readOnly} onClose={onClose} />}
                {view === "brief" && (
                  <>
                    <BriefEssentials ticket={ticket} variant={making ? "make" : "brief"} />
                    {!demo && <BriefAdjustments ticketId={ticket.id} />}
                    <TicketBrief key={ticket.id} ticket={ticket} demo={demo} />
                    <section className="grid gap-3">
                      <p className={label}>References</p>
                      {refFiles.length > 0 && <LinkCards urls={refFiles} size="sm" />}
                      {refLinks.length > 0 && (
                        <ul className="grid gap-1.5">
                          {refLinks.map((r) => (
                            <li key={r} className="flex min-w-0 items-center gap-2 text-sm">
                              <a href={r} target="_blank" rel="noreferrer" className="truncate text-brand-text hover:underline max-md:min-w-0 max-md:py-2">
                                {r}
                              </a>
                            </li>
                          ))}
                        </ul>
                      )}
                      {!demo && !layout.readOnly && <MotionReferences clientId={ticket.clientId} name={`t${ticket.number}`} picked={ticket.refs} onPick={(r) => addTicketRef(ticket.id, r.url)} />}
                      {!demo && !layout.readOnly && (
                        <SavedConcepts
                          key={ticket.id}
                          clientId={ticket.clientId}
                          only={(r) => Boolean(savedHref(r))}
                          hint="Starred for this client by the team. Add one to this ticket's references; it leaves Saved once it's used."
                          onAdd={async (r) => {
                            const href = savedHref(r, window.location.origin);
                            if (!href) return { ok: false, error: "That one has no link to add." };
                            const added = await addTicketRef(ticket.id, href);
                            if (!added.ok) return added;
                            await markSavedUsed([r.id], ticket.id);
                            return { ok: true };
                          }}
                        />
                      )}
                      {!ticket.refs.length && (demo || layout.readOnly) && <p className="text-sm text-faint">No references.</p>}
                    </section>
                  </>
                )}
                {view === "tools" && (
                  <>
                    {ticket.format === "video" && <ScriptPanel requestId={ticket.id} demo={demo ? null : undefined} />}
                    {!demo && ticket.format === "video" && <VoiceoverPanel requestId={ticket.id} fromScript />}
                    {!demo && <HiggsfieldPanel requestId={ticket.id} />}
                    {demo && <p className="text-sm text-faint">AI images and video are made here on a live ticket.</p>}
                  </>
                )}
              </>
            ) : (
              <>
                {ticket.migration && (
                  <div className="grid gap-1.5 rounded-[14px] border border-warn/40 bg-warn-soft px-4 py-3 text-sm">
                    <p className="font-medium text-warn">Finish moving this from Asana</p>
                    <ul className="grid gap-1 text-[13px] text-fg">
                      {ticket.migration.needsCreative && <li>· Upload the creative as it stands: the client portal only shows tickets with their files here.</li>}
                      {ticket.migration.needsCopy && <li>· Add the copy set: it&apos;s past copy, so the client needs to see it.</li>}
                    </ul>
                    {ticket.migration.url && (
                      <a href={ticket.migration.url} target="_blank" rel="noreferrer" className="text-xs text-muted hover:text-fg max-md:py-2">
                        Open the task in Asana ↗
                      </a>
                    )}
                  </div>
                )}
                {ticket.parentNumber && <p className="text-xs text-ok">Split from #{ticket.parentNumber}: the designs and copy the client approved, ready to launch while the rest is reworked.</p>}
                {ticket.clientProgress && <p className="text-xs text-ok">{ticket.clientProgress}</p>}
                <TicketSummary ticket={ticket} onBrief={() => pushParams({ brief: "pdf" })} briefLabel={stage === "requested" ? "Open brief" : "View brief"} />
                {layout.sections.map((s) => sectionsOf[s]())}
              </>
            )}
            {/* The viewer opens the creative over any stage; the copy studio opens the copy */}
            {(view || !has("creative")) && <Deliverables ticket={ticket} demoDesigns={demo ? DEMO_DESIGNS : undefined} onState={onUploads} canDisagree={can.review} mode="viewer" />}
            {copyStage && (
              <div hidden>
                <CopyPanel ticket={ticket} canApprove={can.approveCopy} canForce={can.review} onMoved={moved} />
              </div>
            )}
            {error && !bar && <p className="rounded-[12px] bg-bad-soft px-4 py-3 text-sm text-bad">{error}</p>}
          </div>
        </div>

        {/* One main action, pinned at the bottom in thumb reach and clear of the feedback bubble */}
        {bar && (
          <div ref={barRef} className="relative grid gap-2.5 border-t border-line bg-bg/95 px-7 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 backdrop-blur-xl max-md:px-4">
            {error && <p className="text-sm text-bad">{error}</p>}
            {step ? (
              <div className="grid gap-2.5">
                <p className="text-sm">
                  {step.kind === "send"
                    ? openComments
                      ? `${openComments} comment${openComments === 1 ? " is" : "s are"} still open. It goes for approval with ${openComments === 1 ? "it" : "them"}; the lead sees that.`
                      : "It goes for approval as it is; the lead sees the AI review's notes."
                    : "Send it back to the maker with the open comments and this note."}
                </p>
                <input
                  autoFocus
                  value={step.note}
                  onChange={(e) => setStep({ ...step, note: e.target.value })}
                  placeholder={step.kind === "send" ? "A note for the lead (optional)" : "What to change (optional with pinned comments)"}
                  aria-label="Note"
                  className="h-12 rounded-[14px] border border-line bg-surface px-3.5 text-sm outline-none placeholder:text-faint focus:border-brand-text/60 max-md:text-base md:h-11"
                />
                <div className="flex gap-2">
                  <button type="button" onClick={() => setStep(null)} className={`${button} text-muted hover:text-fg`}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      const s = step;
                      setStep(null);
                      if (s.kind === "send") return send(s.note);
                      act(async () => {
                        const r = await reviewCreative(ticket.id, "changes", s.note);
                        if (!r.ok) return r;
                        moved(r.stage as Stage);
                        return { ok: true as const };
                      });
                    }}
                    className={`${button} flex-1 bg-brand text-white shadow-[0_8px_24px_-10px_rgba(178,30,44,0.9)] hover:bg-brand-hover`}
                  >
                    {step.kind === "send" ? "Send for approval" : "Send back"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 max-md:flex-wrap">
                {layout.bar.primary ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => primary(layout.bar.primary!)}
                    className={`${button} min-w-0 flex-1 truncate bg-brand text-white shadow-[0_8px_24px_-10px_rgba(178,30,44,0.9)] hover:bg-brand-hover max-md:basis-full md:flex-none md:px-6`}
                  >
                    {pending ? "Working…" : layout.bar.primary.label}
                  </button>
                ) : (
                  <p className="flex min-h-12 min-w-0 flex-1 items-center gap-2 text-sm text-muted md:min-h-11 max-md:basis-full">
                    {layout.bar.wait && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[#9aa7f0]" />}
                    <span className="truncate">{layout.bar.wait ?? info.label}</span>
                  </p>
                )}
                {layout.bar.secondary.map((c) => (
                  <button key={c.kind} type="button" disabled={pending} onClick={() => primary(c)} className={`${button} shrink-0 border border-line text-fg hover:border-faint max-md:flex-1 max-md:px-3`}>
                    {c.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {briefOpen && <BriefPdfSheet ticket={ticket} demo={demo} onClose={() => closeParams("brief")} />}
        {launcherOpen && <LauncherSheet ticket={ticket} isExec={Boolean(can.exec)} demo={demo} onClose={() => closeParams("launcher")} />}
        {reviseOpen && (
          <RevisionDialog
            busy={pending}
            error={error}
            onClose={() => closeParams("revise")}
            onSend={(note) =>
              act(
                () => moveTicket(ticket.id, "client_revision", note),
                () => moved("client_revision"),
              )
            }
          />
        )}
        {moving && (
          <MoveDialog
            ticket={ticket}
            to={null}
            onClose={() => closeParams("move")}
            onMoved={moved}
            onFix={(fix) =>
              closeThen(() => {
                setTimeout(() => document.querySelector(fix === "upload" ? "[data-deliverables]" : "[data-copy]")?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
              }, "move")
            }
          />
        )}
      </aside>
    </div>
  );
}

/** The ad copy: written, in review or approved, and a tap opens it in the copy studio */
function CopyCard({ ticket, state, demo, compact = false }: { ticket: Ticket; state: CopyState | null; demo: boolean; compact?: boolean }) {
  const set = state?.set ?? null;
  const drafting = set?.status === "drafting" || (!set && ticket.stage === "copy" && state !== null);
  const ads = set?.ads ?? [];
  const short = ads.filter((a) => a.kind === "short").length;
  const hook = ads[0]?.primaryText.split("\n")[0] ?? "";
  return (
    <section className={card} aria-label="Copy">
      <div className="flex items-baseline justify-between gap-3">
        <p className={label}>Ad copy</p>
        {set && set.status !== "drafting" && <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${set.status === "approved" ? "bg-ok/15 text-ok" : "bg-surface-2 text-muted"}`}>{set.status === "approved" ? "Approved" : `v${set.version} in review`}</span>}
      </div>
      {demo ? (
        <p className="text-sm text-faint">The copy shows here on a live ticket.</p>
      ) : state === null ? (
        <span className="h-12 animate-pulse rounded-[12px] bg-surface-2" />
      ) : drafting ? (
        <div className="grid gap-2">
          <CopyProgress progress={set?.progress ?? {}} />
          <p className="text-xs text-faint">The AI copywriter is writing 3 short and 2 long ads to the approved creative.</p>
        </div>
      ) : set && set.status !== "failed" ? (
        <button type="button" onClick={() => pushParams({ copy: "1" })} className="grid gap-1.5 rounded-[12px] bg-bg/60 px-3.5 py-3 text-left transition-colors hover:bg-surface-2">
          {hook && <span className={`text-sm leading-relaxed ${compact ? "line-clamp-2" : "line-clamp-3"}`}>&ldquo;{hook}&rdquo;</span>}
          <span className="text-xs text-faint">
            {ads.length} ads · {short} short, {ads.length - short} long · tap to view
          </span>
        </button>
      ) : (
        <p className="text-sm text-muted">{set?.error ?? "No copy yet."}</p>
      )}
      {!compact && ticket.format === "carousel" && set && set.status !== "drafting" && !demo && <CarouselCards requestId={ticket.id} />}
    </section>
  );
}

/** Ready to launch: the Ads launcher, popped out, with where the launch stands */
function LauncherCard({ launch, onOpen }: { launch: LaunchView | null; onOpen: () => void }) {
  const status = launch?.status ?? "none";
  const line =
    status === "none" || status === "discarded"
      ? "Not planned yet: the media buyer AI plans the campaign, ad set and ads when you open it."
      : status === "planning"
        ? (launch?.progress ?? "Planning the launch") + "…"
        : status === "ready"
          ? "The plan checks out: campaign, ad set, ads and copy are ready to create, paused."
          : status === "blocked"
            ? "Something needs a decision before it can launch."
            : status === "launching"
              ? "Creating the ads in Meta…"
              : status === "launched"
                ? `Created paused${launch?.sandbox ? " in the sandbox (a test)" : ""}: turn it on in Ads Manager and the ticket completes itself.`
                : (launch?.error ?? "The launch didn't go through.");
  return (
    <section className={card} aria-label="Ads launcher">
      <div className="flex items-baseline justify-between gap-3">
        <p className={label}>Ads launcher</p>
        {launch?.plan && <span className="truncate text-xs text-faint">{launch.plan.ads.length} ad{launch.plan.ads.length === 1 ? "" : "s"}</span>}
      </div>
      <p className={`text-sm leading-relaxed ${status === "blocked" || status === "failed" ? "text-warn" : "text-muted"}`}>{line}</p>
      <button type="button" onClick={onOpen} className="min-h-11 justify-self-start rounded-full border border-line px-4 text-sm font-medium hover:border-faint">
        Open the Ads launcher
      </button>
    </section>
  );
}

/** A completed ticket, read-only: when it completed and where its ads are */
function DoneCard({ ticket, launch }: { ticket: Ticket; launch: LaunchView | null }) {
  return (
    <section className={`${card} border-ok/30`} aria-label="Completed">
      <p className={`${label} text-ok`}>Completed</p>
      <p className="text-sm">
        {fmtDate(ticket.stageEnteredAt)}
        {launch?.launchedBy ? ` · launched by ${launch.launchedBy}` : ""}
      </p>
      {launch?.result && <p className="text-xs text-muted">{launch.result.ads.filter((a) => a.adId).map((a) => a.name).join(" · ")}</p>}
    </section>
  );
}
