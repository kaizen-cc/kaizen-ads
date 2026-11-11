import type { Stage } from "./stages";

// The ticket on the Board, stage by stage (the owner, Nov 2026): each stage shows only what that stage needs, with one
// main call to action pinned at the bottom that changes as the work moves. Everything else (activity, the full brief,
// settings, moving to any stage) sits behind "More". Pure: tested in tests/ticket-layout.test.ts.

/**
 * Who is looking: lead (the Head of Creative, a creative lead or an exec: approves creative and copy), copywriter
 * (approves copy), maker (the person the ticket is assigned to), team (anyone else).
 */
export type TicketRole = "lead" | "copywriter" | "maker" | "team";

/** The role from what the person can do and whether the ticket is theirs */
export function ticketRole(can: { review?: boolean; approveCopy?: boolean }, assignedToMe = false): TicketRole {
  if (can.review) return "lead";
  if (can.approveCopy) return "copywriter";
  return assignedToMe ? "maker" : "team";
}

/** What a stage's main view holds, in order (the compact header and the summary come first on every stage) */
export type Section =
  /** Requested: the compact chat about the brief */
  | "brief-chat"
  /** Production: the copy or script the AI copywriter wrote, with its chat */
  | "copy-draft"
  /** Production: sizes needed against uploaded, per version */
  | "ratios"
  /** Production: the creative (upload, versions, replace) */
  | "creative"
  /** Client changes: what the client asked for */
  | "client-notes"
  /** Creative review: the AI review's comments, summarized */
  | "ai-summary"
  /** Creative review: what happened in production (versions, comments resolved, time) */
  | "story"
  /** The creative, viewable on click */
  | "creative-strip"
  /** The copy studio entry (copy stages) */
  | "copy"
  /** The ad copy, viewable on click (client and launch stages) */
  | "copy-strip"
  /** Ready to launch: the Ads launcher pop-out */
  | "launcher"
  /** Completed: what went live */
  | "done";

export type CtaKind =
  | "start-production"
  | "upload"
  | "ai-review"
  | "view-comments"
  | "upload-version"
  | "send-approval"
  | "view-creative"
  | "review-creative"
  | "approve-creative"
  | "view-copy"
  | "review-copy"
  | "approve-copy"
  | "client-approved"
  | "client-revision"
  | "make-live"
  | "ads-manager"
  | "complete";

export type Cta = { kind: CtaKind; label: string };

/** The bar: one main action (or who has it, when it isn't this person's move) and at most two quieter ones */
export type Bar = { primary: Cta | null; secondary: Cta[]; wait: string | null };

export type TicketView = { sections: Section[]; bar: Bar; readOnly: boolean };

/** Production's moving parts: the uploads, the AI review of the current files and the open comments */
export type ProductionState = {
  /** Designs with at least one finished file */
  uploaded: number;
  /** Files still on their way up */
  uploading: number;
  /** What's still to upload (sizes, versions, cards) */
  missing: string[];
  review: {
    status: "none" | "running" | "done" | "failed";
    /** The latest review looked at the files on the ticket now (nothing replaced since) */
    current: boolean;
  };
  /** Open comments on the current versions (the AI's and people's) */
  openComments: number;
};

/** Ready to launch: where the launch stands */
export type LaunchState = { status: "none" | "planning" | "ready" | "blocked" | "launching" | "launched" | "failed"; link: string | null; sandbox: boolean };

export type ViewState = {
  production?: ProductionState;
  /** The person has opened the creative (creative review) or the copy (copy review) on this ticket at this stage */
  opened?: boolean;
  launch?: LaunchState;
};

const C = {
  start: { kind: "start-production", label: "Start production" },
  upload: { kind: "upload", label: "Upload creative" },
  review: { kind: "ai-review", label: "Review my creative" },
  comments: { kind: "view-comments", label: "View comments" },
  version: { kind: "upload-version", label: "Upload new version" },
  send: { kind: "send-approval", label: "Send for approval" },
  viewCreative: { kind: "view-creative", label: "View creative" },
  reviewCreative: { kind: "review-creative", label: "Review creative" },
  approveCreative: { kind: "approve-creative", label: "Approve creative" },
  viewCopy: { kind: "view-copy", label: "View copy" },
  reviewCopy: { kind: "review-copy", label: "Review copy" },
  approveCopy: { kind: "approve-copy", label: "Approve copy" },
  clientOk: { kind: "client-approved", label: "Approved by client" },
  clientRevise: { kind: "client-revision", label: "Send for revision" },
  live: { kind: "make-live", label: "Make campaign live" },
  manager: { kind: "ads-manager", label: "View in Ads Manager" },
  complete: { kind: "complete", label: "Complete task" },
} satisfies Record<string, Cta>;

const bar = (primary: Cta | null, secondary: Cta[] = [], wait: string | null = null): Bar => ({ primary, secondary, wait });

/**
 * Production's main action as the work moves: upload, have the AI review it, read its comments and upload a new
 * version, then send it for approval. Sending is never blocked by anything optional: once the creative is in and the
 * AI has reviewed it, it can go (open comments go with it, which the lead sees).
 */
export function productionBar(p: ProductionState): Bar {
  if (p.uploading > 0) return bar(null, [], "Uploading. The next step shows when it's done.");
  if (p.uploaded === 0) return bar(C.upload);
  if (p.review.status === "running") return bar(null, p.openComments ? [C.comments] : [], "The AI is reviewing the creative");
  // Sizes or versions still to come: uploading them is the step (the review starts on its own once they're in)
  if (p.missing.length) return bar(C.upload, p.review.status === "done" && p.openComments ? [C.comments] : []);
  const reviewed = p.review.status === "done" && p.review.current;
  if (!reviewed) {
    // Never reviewed, failed, or files replaced since: review it (again). A run that happened can already be sent.
    const ran = p.review.status === "done";
    return bar(C.review, [...(p.openComments ? [C.comments] : []), ...(ran ? [C.send] : [])].slice(0, 2));
  }
  if (p.openComments > 0) return bar(C.comments, [C.version, C.send]);
  return bar(C.send, [C.version]);
}

function launchBar(l: LaunchState | undefined): Bar {
  if (!l || l.status === "none" || l.status === "planning" || l.status === "ready" || l.status === "blocked" || l.status === "failed") return bar(C.live);
  if (l.status === "launching") return bar(null, [], "Creating the ads in Meta");
  // Launched (paused, to be turned on in Ads Manager); the ticket completes itself once Meta shows it live
  return bar(l.link ? C.manager : null, [C.complete], l.link ? null : "Launched");
}

export function ticketView(stage: Stage, role: TicketRole, state: ViewState = {}): TicketView {
  const lead = role === "lead";
  switch (stage) {
    case "requested":
      return { sections: ["brief-chat"], bar: bar(C.start), readOnly: false };
    case "in_production":
    case "client_revision": {
      const p = state.production ?? { uploaded: 0, uploading: 0, missing: [], review: { status: "none", current: false }, openComments: 0 };
      const sections: Section[] = stage === "client_revision" ? ["client-notes", "copy-draft", "ratios", "creative"] : ["copy-draft", "ratios", "creative"];
      return { sections, bar: productionBar(p), readOnly: false };
    }
    case "internal_review":
      return {
        sections: ["ai-summary", "story", "creative-strip"],
        bar: lead ? (state.opened ? bar(C.approveCreative, [C.reviewCreative]) : bar(C.viewCreative)) : bar(null, [C.viewCreative], "With the Head of Creative for review"),
        readOnly: false,
      };
    case "copy":
      return { sections: ["creative-strip", "copy"], bar: bar(null, [], "The AI copywriter is writing the ad copy"), readOnly: false };
    case "copy_review": {
      const approver = lead || role === "copywriter";
      return {
        sections: ["creative-strip", "copy"],
        bar: approver ? (state.opened ? bar(C.approveCopy, [C.reviewCopy]) : bar(C.viewCopy)) : bar(null, [C.viewCopy], "With the copywriter for review"),
        readOnly: false,
      };
    }
    case "ready_for_client":
    case "client_review":
      return { sections: ["creative-strip", "copy-strip"], bar: bar(C.clientOk, [C.clientRevise]), readOnly: false };
    case "ready_for_launch":
      return { sections: ["creative-strip", "copy-strip", "launcher"], bar: launchBar(state.launch), readOnly: false };
    case "launched":
      return { sections: ["done", "creative-strip", "copy-strip"], bar: bar(state.launch?.link ? C.manager : null), readOnly: true };
  }
}

/** Stages where the person has to open something before the decision (the creative in review, the copy in copy review) */
export const OPEN_FIRST: Stage[] = ["internal_review", "copy_review"];

/** Stages the AI copywriter writes the creative's own copy for (the script, the headlines) */
export const MAKING: Stage[] = ["in_production", "client_revision"];

/** A ticket event as the story reads it (from the ticket's history) */
export type StoryEvent = { kind: string; toStage: Stage | null; at: string; data?: Record<string, unknown> };

/** Wall-clock minutes the ticket spent being made (in production and client changes), from its moves */
export function makingMinutes(events: StoryEvent[], now = Date.now()): number {
  const moves = events.filter((e) => (e.kind === "stage" || e.kind === "created") && e.toStage && !e.data?.action).sort((a, b) => a.at.localeCompare(b.at));
  let total = 0;
  for (let i = 0; i < moves.length; i++) {
    if (!MAKING.includes(moves[i].toStage!)) continue;
    const end = i + 1 < moves.length ? Date.parse(moves[i + 1].at) : now;
    total += Math.max(0, end - Date.parse(moves[i].at));
  }
  return Math.round(total / 60000);
}

/** "45m", "5h", "2d 3h": wall-clock time */
export function span(minutes: number) {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return h ? `${d}d ${h}h` : `${d}d`;
}
