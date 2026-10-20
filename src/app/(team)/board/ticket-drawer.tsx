"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";
import { PersonAvatar } from "@/components/person-avatar";
import { FORMAT_LABEL, PHASE_LABEL, businessDuration, health, stageInfo, type Phase, type Priority, type Stage } from "@/lib/stages";
import { assignTicket, commentTicket, deleteTicket, moveTicket, setTicketDue, setTicketPriority, ticketHistory, type TicketEvent } from "./actions";
import { briefChanges, type BriefChange, type Design } from "./design-actions";

/** What the maker had to change from the brief, said when they uploaded: right under the brief for the lead to see. */
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
    <div className="grid gap-2 rounded-[10px] border border-warn/40 bg-warn-soft/40 px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-warn">Brief adjusted</p>
      {list.map((c, i) => (
        <div key={i} className="grid gap-0.5">
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{c.note}</p>
          <p className="text-[11px] text-faint">
            {c.by} · {new Date(c.at).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          </p>
        </div>
      ))}
    </div>
  );
}
import { Deliverables, type UploadState } from "./deliverables";
import { ScriptPanel } from "./script-panel";
import { ReviewPanel } from "./review-panel";
import { AiGate } from "./ai-review";
import { CopyPanel } from "./copy-panel";
import { ClientTag, FormatIcon, TimeStamp } from "./ticket-card";
import type { Person, Ticket } from "./types";

const PHASES: Phase[] = ["brief", "make", "review", "client", "launch"];

// "Send back" moves where the flow allows going backwards.
const BACK: Partial<Record<Stage, { to: Stage; label: string }>> = {
  in_production: { to: "requested", label: "Back to request" },
  internal_review: { to: "in_production", label: "Send back to creative" },
  client_review: { to: "client_revision", label: "Client asked for changes" },
  ready_for_launch: { to: "client_review", label: "Back to client" },
};

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

const fmtDate = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).format(new Date(iso));

/** datetime-local value in New York time. */
function toLocalInput(iso: string | null) {
  if (!iso) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(iso));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour") === "24" ? "00" : g("hour")}:${g("minute")}`;
}

/** New York wall time → ISO (handles EST/EDT). */
function fromLocalInput(v: string) {
  const guess = new Date(`${v}:00Z`);
  const ny = new Date(guess.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const utc = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(guess.getTime() + (utc.getTime() - ny.getTime())).toISOString();
}

function describe(e: TicketEvent) {
  switch (e.kind) {
    case "created":
      return "created this request";
    case "stage":
      if (e.data.action === "deleted") return <span className="text-bad">deleted the ticket</span>;
      if (e.data.action === "restored") return <span className="text-ok">restored the ticket</span>;
      return (
        <>
          moved it to <span className="text-fg">{e.toStage ? stageInfo(e.toStage).label : "—"}</span>
        </>
      );
    case "assign":
      return e.data.toName ? (
        <>
          assigned it to <span className="text-fg">{e.data.toName}</span>
        </>
      ) : (
        "unassigned it"
      );
    case "due":
      return <>changed the due date{e.data.to ? <> to <span className="text-fg">{fmtDate(e.data.to)}</span></> : null}</>;
    case "priority":
      return (
        <>
          set priority to <span className="text-fg">{e.data.to}</span>
        </>
      );
    case "comment":
      return "commented";
    case "upload":
      if (e.data.action === "rejoined")
        return (
          <>
            rejoined <span className="text-fg">#{String(e.data.from)}</span>, the client-approved part, now that both are in the same stage
          </>
        );
      if (e.data.action === "counts" && e.data.auto)
        return (
          <>
            counts went up to <span className="text-fg">{String(e.data.new)} new{Number(e.data.variations) ? ` + ${String(e.data.variations)} var.` : ""}</span>{" "}
            <span className="text-faint">(more designs were added than asked for)</span>
          </>
        );
      if (e.data.action === "counts")
        return (
          <>
            changed the ticket to{" "}
            <span className="text-fg">
              {String(e.data.new)} new{Number(e.data.variations) ? ` + ${String(e.data.variations)} variation${Number(e.data.variations) === 1 ? "" : "s"}` : ""}
            </span>{" "}
            <span className="text-faint">
              (was {String(e.data.from_new)} new{Number(e.data.from_variations) ? ` + ${String(e.data.from_variations)}` : ""})
            </span>
          </>
        );
      return e.data.version ? (
        <>
          uploaded <span className="text-fg">v{e.data.version}</span> of {e.data.design}
        </>
      ) : (
        `uploaded ${String(e.data.designs) === "1" ? "a design" : `${e.data.designs} designs`}`
      );
    case "review":
      switch (e.data.action ?? e.data.decision) {
        case "approve":
          return <>approved the creative</>;
        case "changes":
          return <>sent the creative back with changes</>;
        case "dismissed":
          return (
            <>
              dismissed an AI <span className={e.data.severity === "block" ? "text-bad" : "text-warn"}>{e.data.severity === "block" ? "must fix" : "heads up"}</span> on the request
            </>
          );
        case "ai_fixed":
          return <>let the AI fix a review note on the request</>;
        case "continued_past_similar":
          return (
            <>
              went ahead although <span className="text-fg">#{e.data.ticket}</span> looked similar
            </>
          );
        case "stronger_brief":
          return <>used the AI&apos;s stronger brief</>;
        case "client_split":
          return (
            <>
              split off what the client approved on <span className="text-fg">#{String(e.data.from)}</span> to launch it first
            </>
          );
        case "client_approved":
          return (
            <>
              <span className="text-ok">client approved</span>
              {e.data.by_name ? <span className="text-faint"> · {String(e.data.by_name)}</span> : null}
            </>
          );
        case "client_revise":
          return (
            <>
              <span className="text-warn">client asked for changes</span> to the {Array.isArray(e.data.targets) ? (e.data.targets as string[]).join(" and ") : "ad"}
              {e.data.by_name ? <span className="text-faint"> · {String(e.data.by_name)}</span> : null}
            </>
          );
        default:
          return "reviewed it";
      }
    case "copy":
      if (e.data.action === "revised_for_client") return e.data.scope === "rewrite" ? "rewrote the copy for the client's notes (AI)" : "amended the copy for the client's notes (AI)";
      return e.data.action === "drafted" ? "drafted the copy with the AI" : e.data.action === "redrafted" ? "rewrote the copy with the AI" : e.data.action === "reused" ? "reused approved copy" : "approved the copy";
  }
}

// Design preview: a sample copy set in Kaizen's copy standard
const DEMO_AD = (kind: "short" | "long", formula: string, primaryText: string, headline: string, linkDescription: string, cta: string) => ({ kind, formula, angle: "Live classes beat apps", primaryText, headline, linkDescription, cta });
const DEMO_LONG =
  "Most apps teach you to tap the right answer. Real conversations don't come with multiple choice.\n\n" +
  Array.from({ length: 34 }, () => "Our teachers are native speakers who build every class around real situations, so you practise ordering, asking and joking the way you will on your trip.").join(" ");
const DEMO_COPY = {
  reusable: null,
  set: {
    id: "demo",
    status: "review" as const,
    ads: [
      DEMO_AD("short", "Offer-led", "Speak Spanish in real conversations from day one. Unlimited live classes, $7 for your first week.", "Unlimited Live Classes for $7", "First week, cancel anytime", "Sign Up"),
      DEMO_AD("short", "Proof-led", "4.9 stars from 2,300 learners who finally stopped freezing mid-sentence. Your turn.", "Real Teachers. Real Spanish.", "Classes every hour", "Learn More"),
      DEMO_AD("short", "Pain + relief", "Three years of an app and you still can't order a coffee in Spanish? Talk with a teacher instead.", "Stop Tapping. Start Talking.", "", "Sign Up"),
      DEMO_AD("long", "PASTOR", DEMO_LONG, "Your First Week Is $7", "Unlimited classes", "Sign Up"),
      DEMO_AD("long", "Epiphany Bridge", DEMO_LONG.slice(0, 900), "Spanish That Sticks", "Live, every hour", "Learn More"),
    ],
    aiAds: [],
    notes: "Leaned on the $7 first week as the offer and kept every hook about the situation, not the learner.",
    error: null,
    version: 1,
    approvedBy: null,
    approvedAt: null,
    updatedAt: new Date().toISOString(),
    progress: {},
    clientNotes: null,
    changes: null,
    scope: null,
    clientStatus: [],
    reusedFrom: null,
  },
};

// These stages have their own panel instead of the generic "next step" button
const SPECIAL: Stage[] = ["internal_review", "copy", "copy_review"];
// Making stages: the upload area takes the place of the note, and the next step appears once a file is up
const MAKING: Stage[] = ["in_production", "client_revision"];
const COPY_STAGES: Stage[] = ["copy", "copy_review", "ready_for_client", "client_review", "client_revision", "ready_for_launch", "launched"];

export function TicketDrawer({
  ticket,
  people,
  can = { review: false, approveCopy: false },
  onClose,
  onOptimisticMove,
  demo = false,
}: {
  ticket: Ticket;
  people: Person[];
  can?: { review: boolean; approveCopy: boolean };
  onClose: () => void;
  onOptimisticMove: (id: string, stage: Stage) => void;
  demo?: boolean; // design preview: sample history, no server calls
}) {
  const [history, setHistory] = useState<TicketEvent[] | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [moveNote, setMoveNote] = useState("");
  const [uploads, setUploads] = useState<UploadState>({ uploaded: 0, uploading: 0, loaded: false });
  const onUploads = useCallback((u: UploadState) => setUploads(u), []);
  const hasCreative = uploads.uploaded > 0 || demo;
  const making = MAKING.includes(ticket.stage);
  const filesFirst = !making && ticket.stage !== "requested";
  const info = stageInfo(ticket.stage);
  const back = BACK[ticket.stage];
  const h = health(ticket.minutesOver, ticket.stage);

  const reload = () =>
    demo
      ? Promise.resolve().then(() => setHistory(DEMO_HISTORY(ticket)))
      : ticketHistory(ticket.id).then(setHistory);
  // The board remounts this drawer per ticket (key), so history starts empty for each one
  useEffect(() => {
    reload();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket.id]);

  const run = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>, after?: () => void) =>
    start(async () => {
      if (demo) {
        after?.();
        return;
      }
      setError(null);
      const res = await fn();
      if (!res.ok) setError(res.error);
      else {
        after?.();
        reload();
      }
    });

  // Moved on: the ticket closes (the work is done here). It stays open only while the AI reviews, which isn't a move.
  const moved = (stage: Stage) => {
    onOptimisticMove(ticket.id, stage);
    onClose();
  };
  const move = (stage: Stage) => {
    onOptimisticMove(ticket.id, stage);
    run(() => moveTicket(ticket.id, stage, moveNote), () => {
      setMoveNote("");
      onClose();
    });
  };

  const currentPhaseIndex = PHASES.indexOf(info.phase);

  const section = "grid gap-3";
  const sectionTitle = "text-[11px] font-semibold uppercase tracking-[0.14em] text-faint";
  const control =
    "h-9 w-full min-w-0 rounded-brand border border-transparent bg-transparent px-2.5 text-sm text-fg outline-none transition-colors hover:border-line hover:bg-surface-2 focus:border-brand-text/60 disabled:opacity-60";
  const counts =
    [ticket.newCount && `${ticket.newCount} new`, ticket.variationCount && `${ticket.variationCount} variation${ticket.variationCount === 1 ? "" : "s"}`].filter(Boolean).join(" + ") ||
    `${ticket.quantity} creative${ticket.quantity === 1 ? "" : "s"}`;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`Ticket ${ticket.number}`}>
      <button aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/60 backdrop-blur-[2px] animate-[sheet-fade_.2s_ease-out]" />
      <aside className="relative flex h-full w-full max-w-[600px] flex-col border-l border-line bg-bg shadow-2xl animate-[drawer-right_.25s_cubic-bezier(.2,.8,.2,1)]">
        {/* Header: who, what, and where it is in the journey */}
        <header className="grid gap-5 border-b border-line px-7 pb-6 pt-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <ClientTag name={ticket.clientName} />
              <span className="tabular text-xs text-faint">#{ticket.number}</span>
              {ticket.priority !== "normal" && (
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${ticket.priority === "urgent" ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn"}`}>
                  {ticket.priority === "urgent" ? "Urgent" : "High"}
                </span>
              )}
            </div>
            <button onClick={onClose} className="-mr-2 grid h-8 w-8 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg" aria-label="Close ticket">
              ✕
            </button>
          </div>

          <div className="grid gap-2.5">
            <h2 className="font-heading text-[26px] leading-tight">{ticket.title}</h2>
            {ticket.migration && (
              <div className="grid gap-1.5 rounded-[10px] border border-warn/40 bg-warn-soft px-3.5 py-3 text-sm">
                <p className="font-medium text-warn">Finish moving this from Asana</p>
                <ul className="grid gap-1 text-[13px] text-fg">
                  {ticket.migration.needsCreative && <li>· Upload the creative as it stands (Deliverables, below). The client portal only shows tickets with their files here.</li>}
                  {ticket.migration.needsCopy && <li>· Add the copy set (Copy, below): it&apos;s past copy, so the client needs to see it.</li>}
                </ul>
                {ticket.migration.url && (
                  <a href={ticket.migration.url} target="_blank" rel="noreferrer" className="text-xs text-muted hover:text-fg">
                    Open the task in Asana ↗
                  </a>
                )}
              </div>
            )}
            {ticket.parentNumber && (
              <p className="text-xs text-ok">
                Split from #{ticket.parentNumber}: the designs and copy the client approved, ready to launch while the rest is reworked.
              </p>
            )}
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
              <span className="inline-flex items-center gap-1.5 text-fg">
                <FormatIcon format={ticket.format} /> {FORMAT_LABEL[ticket.format]}
              </span>
              <span className="text-faint">·</span>
              <span>{counts}</span>
              {((ticket.internalRounds ?? 0) > 0 || (ticket.clientRounds ?? 0) > 0) && (
                <>
                  <span className="text-faint">·</span>
                  <span className={(ticket.clientRounds ?? 0) >= 2 ? "text-warn" : ""}>
                    Revisions: {ticket.internalRounds ?? 0} internal, {ticket.clientRounds ?? 0} client
                  </span>
                </>
              )}
              {ticket.angleName && (
                <>
                  <span className="text-faint">·</span>
                  <span>{ticket.angleName}</span>
                </>
              )}
            </p>
          </div>

          {/* Journey: five phases, current one lit */}
          <div className="grid grid-cols-5 gap-1.5">
            {PHASES.map((p, i) => (
              <div key={p} className="grid gap-1.5">
                <div
                  className={`h-1 rounded-full ${
                    i < currentPhaseIndex ? "bg-fg/40" : i === currentPhaseIndex ? (h === "bad" ? "bg-bad" : h === "warn" ? "bg-warn" : "bg-brand") : "bg-surface-2"
                  }`}
                />
                <span className={`text-[11px] ${i === currentPhaseIndex ? "text-fg" : "text-faint"}`}>{PHASE_LABEL[p]}</span>
              </div>
            ))}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid content-start gap-9 px-7 py-7">
          {/* Where it is and what happens next */}
          <section className="overflow-hidden rounded-[10px] border border-line bg-surface">
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
              <div className="min-w-0">
                <p className="font-medium">{info.label}</p>
                <p className="mt-0.5 text-xs text-muted">{ticket.stageDueAt ? <>Due {fmtDate(ticket.stageDueAt)}</> : "No turnaround in this stage"}</p>
              </div>
              <div className="flex items-center gap-2">
                <TimeStamp ticket={ticket} label />
              </div>
            </div>
            {making && (
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 border-t border-line px-5 py-5">
                <Deliverables ticket={ticket} demoDesigns={demo ? DEMO_DESIGNS : undefined} onState={onUploads} />
                {hasCreative && uploads.uploading === 0 ? (
                  // Remounts after each upload, so it always knows whether the review is about the current files
                  <AiGate
                    ticket={ticket}
                    demo={demo}
                    onSent={moved}
                    back={
                      back && (
                        <button disabled={pending} onClick={() => move(back.to)} className="h-10 rounded-brand px-3 text-xs text-faint hover:text-fg disabled:opacity-60">
                          ↩ {back.label}
                        </button>
                      )
                    }
                  />
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-faint">
                    <span>{uploads.uploading > 0 ? "Uploading… the next step appears when it's done." : "Upload the creative to send it to creative review."}</span>
                    {back && (
                      <button disabled={pending} onClick={() => move(back.to)} className="rounded-full px-3 py-1.5 text-muted hover:text-fg disabled:opacity-60">
                        ↩ {back.label}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
            {ticket.stage !== "launched" && !SPECIAL.includes(ticket.stage) && !making && (
              <div className="grid gap-3 border-t border-line px-5 py-4">
                <input
                  value={moveNote}
                  onChange={(e) => setMoveNote(e.target.value)}
                  placeholder="Add a note with this move (optional)"
                  aria-label="Note for this move"
                  className="h-10 rounded-brand border border-line bg-bg px-3 text-sm outline-none placeholder:text-faint focus:border-brand-text/60"
                />
                <div className="flex flex-wrap items-center gap-2">
                  {info.next && (
                    <button
                      disabled={pending}
                      onClick={() => move(info.next!)}
                      className="h-10 rounded-brand bg-brand px-4 text-sm font-medium text-white shadow-[0_8px_24px_-10px_rgba(178,30,44,0.9)] hover:bg-brand-hover disabled:opacity-60"
                    >
                      {info.nextLabel} →
                    </button>
                  )}
                  {back && (
                    <button disabled={pending} onClick={() => move(back.to)} className="h-10 rounded-brand border border-line px-4 text-sm text-muted hover:border-faint hover:text-fg disabled:opacity-60">
                      ↩ {back.label}
                    </button>
                  )}
                </div>
              </div>
            )}
            {["ready_for_client", "client_review", "client_revision", "ready_for_launch"].includes(ticket.stage) && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-3 text-xs">
                <span className="text-faint">
                  {ticket.stage === "client_review" ? "Waiting on the client in their portal." : "The client's portal shows where this stands."}
                </span>
                <a href={`/c/${ticket.clientSlug}`} target="_blank" rel="noreferrer" className="rounded-full border border-line px-3 py-1 text-muted hover:border-faint hover:text-fg">
                  Open the client&apos;s view ↗
                </a>
              </div>
            )}
            {error && <p className="border-t border-line px-5 py-3 text-sm text-brand-text">{error}</p>}
          </section>

          {/* Once there's creative, the files come first */}
          {filesFirst && <Deliverables ticket={ticket} demoDesigns={demo ? DEMO_DESIGNS : undefined} onState={onUploads} />}

          <ReviewPanel ticket={ticket} canReview={can.review} onMoved={moved} demo={demo} />
          {(COPY_STAGES.includes(ticket.stage)) && <CopyPanel ticket={ticket} canApprove={can.approveCopy} onMoved={moved} demo={demo ? DEMO_COPY : undefined} />}

          {/* Properties: label on the left, editable value on the right */}
          <section className={section}>
            <h3 className={sectionTitle}>Details</h3>
            <dl className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted">Assigned to</dt>
              <dd className="flex min-w-0 items-center gap-1">
                <PersonAvatar name={ticket.assigneeName ?? "?"} size={22} muted={!ticket.assigneeName} />
                <select
                  aria-label="Assigned to"
                  value={ticket.assigneeId ?? ""}
                  disabled={pending}
                  onChange={(e) => run(() => assignTicket(ticket.id, e.target.value || null))}
                  className={control}
                >
                  <option value="">Unassigned</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.role}
                    </option>
                  ))}
                </select>
              </dd>

              <dt className="text-muted">Due (ET)</dt>
              <dd className="min-w-0">
                <input
                  type="datetime-local"
                  aria-label="Due date, Eastern time"
                  defaultValue={toLocalInput(ticket.stageDueAt)}
                  key={ticket.stageDueAt ?? "none"}
                  disabled={pending || !ticket.stageDueAt}
                  onBlur={(e) => e.target.value && e.target.value !== toLocalInput(ticket.stageDueAt) && run(() => setTicketDue(ticket.id, fromLocalInput(e.target.value)))}
                  className={control}
                />
              </dd>

              <dt className="text-muted">Priority</dt>
              <dd className="flex gap-1 px-1 py-1">
                {(["normal", "high", "urgent"] as Priority[]).map((p) => (
                  <button
                    key={p}
                    disabled={pending}
                    onClick={() => p !== ticket.priority && run(() => setTicketPriority(ticket.id, p))}
                    aria-pressed={ticket.priority === p}
                    className={`h-7 rounded-full px-3 text-xs capitalize transition-colors disabled:opacity-60 ${
                      ticket.priority === p
                        ? p === "urgent"
                          ? "bg-bad-soft text-bad"
                          : p === "high"
                            ? "bg-warn-soft text-warn"
                            : "bg-surface-2 text-fg"
                        : "text-faint hover:bg-surface-2 hover:text-fg"
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </dd>

              {[
                ["Creative", ticket.creativeName],
                ["Media buyer", ticket.buyerName],
                ["Requested", fmtDate(ticket.createdAt)],
                ["In this stage", `${businessDuration(ticket.minutesInStage)} business time`],
              ].map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted">{k}</dt>
                  <dd className="flex h-9 min-w-0 items-center truncate px-2.5">{v ?? <span className="text-faint">—</span>}</dd>
                </div>
              ))}
            </dl>
          </section>

          {/* Brief */}
          <section className={section}>
            <h3 className={sectionTitle}>Brief</h3>
            {(ticket.audience || ticket.sizes.length > 0) && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {ticket.sizes.map((s) => (
                  <span key={s} className="tabular rounded-full border border-line px-2.5 py-0.5 text-xs text-muted">
                    {s.replace("x", ":")}
                  </span>
                ))}
                {ticket.audience && <span className="text-muted">{ticket.audience}</span>}
              </div>
            )}
            {ticket.landingUrl && (
              <p className="flex items-center gap-2 text-sm">
                <span className="text-faint">Landing page</span>
                <a href={ticket.landingUrl} target="_blank" rel="noreferrer" className="truncate text-brand-text hover:underline">
                  {ticket.landingUrl.replace(/^https?:\/\//, "")}
                </a>
              </p>
            )}
            {ticket.origin && (
              <div className="flex items-center gap-3 rounded-[12px] border border-brand/25 bg-brand-soft/30 px-3 py-2.5">
                {ticket.origin.thumb && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={ticket.origin.thumb} alt="" className="h-11 w-11 shrink-0 rounded-[8px] object-cover" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block text-[10px] font-medium uppercase tracking-[0.14em] text-brand-text">
                    Built on {ticket.origin.kind === "winner" ? "a winning ad" : ticket.origin.kind === "market" ? "a live ad in the market" : ticket.origin.kind === "promise" ? "a promise from a call" : "an AI brief"}
                  </span>
                  <span className="block truncate text-sm">{ticket.origin.label}</span>
                </span>
                {ticket.origin.link && (
                  <a href={ticket.origin.link} target="_blank" rel="noreferrer" className="shrink-0 rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-fg">
                    See it ↗
                  </a>
                )}
              </div>
            )}
            {ticket.brief ? (
              <p className="whitespace-pre-wrap rounded-[10px] border border-line bg-surface px-5 py-4 text-sm leading-relaxed text-muted">{ticket.brief}</p>
            ) : (
              <p className="text-sm text-faint">No brief written.</p>
            )}
            {!demo && <BriefAdjustments ticketId={ticket.id} />}
            {ticket.refs.length > 0 && (
              <ul className="grid gap-1.5">
                {ticket.refs.map((r) => (
                  <li key={r} className="flex min-w-0 items-center gap-2 text-sm">
                    {/motionapp\.com|facebook\.com\/ads\/library/i.test(r) && (
                      <span className="shrink-0 rounded-full bg-[#6c5ce7]/15 px-2 py-0.5 text-[10px] font-medium text-[#8b7cf6]">{/motionapp\.com/i.test(r) ? "Motion" : "Ad Library"}</span>
                    )}
                    <a href={r} target="_blank" rel="noreferrer" className="truncate text-brand-text hover:underline">
                      {r}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {ticket.format === "video" && <ScriptPanel requestId={ticket.id} demo={demo ? null : undefined} />}

          {!making && !filesFirst && <Deliverables ticket={ticket} demoDesigns={demo ? DEMO_DESIGNS : undefined} onState={onUploads} />}

          {can.review && <DeleteTicket ticket={ticket} onDeleted={onClose} />}

          {/* Activity */}
          <section className="grid gap-4">
            <h3 className={sectionTitle}>Activity</h3>
            {history === null ? (
              <p className="text-xs text-faint">Loading…</p>
            ) : (
              <ol className="relative grid gap-5 before:absolute before:bottom-3 before:left-[13px] before:top-3 before:w-px before:bg-line">
                {history.map((e) => (
                  <li key={e.id} className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-3">
                    {e.actor ? <PersonAvatar name={e.actor} size={28} /> : <span className="h-7 w-7 rounded-full bg-surface-2" />}
                    <div className="grid min-w-0 gap-1.5 pt-1">
                      <p className="text-sm leading-snug text-muted">
                        <span className="font-medium text-fg">{e.actor ?? "Kaizen Ads"}</span> {describe(e)}
                        <span className="ml-2 whitespace-nowrap text-xs text-faint">{fmtDate(e.at)}</span>
                      </p>
                      {e.body && <p className="whitespace-pre-wrap rounded-[8px] bg-surface px-3.5 py-2.5 text-sm leading-relaxed">{e.body}</p>}
                    </div>
                  </li>
                ))}
              </ol>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (comment.trim()) run(() => commentTicket(ticket.id, comment), () => setComment(""));
              }}
              className="mt-1 flex gap-2"
            >
              <input
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Write a comment…"
                aria-label="Comment"
                className="h-10 min-w-0 flex-1 rounded-brand border border-line bg-surface px-3 text-sm outline-none placeholder:text-faint focus:border-brand-text/60"
              />
              <button disabled={pending || !comment.trim()} className="h-10 rounded-brand bg-surface-2 px-4 text-sm hover:bg-line disabled:opacity-50">
                Post
              </button>
            </form>
          </section>

          <Link href={`/clients/${ticket.clientSlug}`} className="border-t border-line pt-5 text-xs text-muted hover:text-fg">
            {ticket.clientName} client page →
          </Link>
          </div>
        </div>
      </aside>
    </div>
  );
}

/** Execs and leads: delete the ticket, with a reason. It goes to Settings → Deleted, where it can be restored. */
function DeleteTicket({ ticket, onDeleted }: { ticket: Ticket; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  if (!open)
    return (
      <button onClick={() => setOpen(true)} className="justify-self-start text-xs text-faint hover:text-bad">
        Delete ticket
      </button>
    );
  return (
    <section className="grid gap-3 rounded-[12px] border border-bad/30 bg-bad-soft/30 p-4">
      <p className="text-sm font-medium">
        Delete #{ticket.number} · {ticket.title}?
      </p>
      <p className="text-xs text-muted">It disappears from the board, the client&apos;s page and portal, and gives its creative back to the allotment. An exec or lead can restore it from Settings → Deleted.</p>
      <input
        autoFocus
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why? e.g. Duplicate of #1044"
        className="h-10 rounded-brand border border-line bg-bg px-3 text-sm outline-none placeholder:text-faint focus:border-bad/60"
      />
      <div className="flex items-center gap-2">
        <button
          disabled={busy || !reason.trim()}
          onClick={async () => {
            setBusy(true);
            setError(null);
            const r = await deleteTicket(ticket.id, reason);
            setBusy(false);
            if (!r.ok) return setError(r.error);
            onDeleted();
            router.refresh();
          }}
          className="h-9 rounded-brand bg-bad px-4 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? "Deleting…" : "Delete ticket"}
        </button>
        <button onClick={() => (setOpen(false), setReason(""))} className="h-9 rounded-brand px-3 text-sm text-muted hover:text-fg">
          Cancel
        </button>
      </div>
      {error && <p className="text-xs text-bad">{error}</p>}
    </section>
  );
}
