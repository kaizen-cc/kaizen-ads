import { stageInfo, type Stage } from "./stages";

// The ticket on the Board follows its stage (the owner, Nov 2026: "VERY chaotic and lots of scroll to get to the
// information"). Each stage opens on what the person at that stage acts on, with one primary action pinned at the
// bottom; everything else is one tap away in tabs (Brief, Creative, Copy, Launch, Activity) that live in the address.
// Pure: tested in tests/ticket-layout.test.ts.

export type TicketTab = "brief" | "creative" | "copy" | "launch" | "activity";

export const TAB_LABEL: Record<TicketTab, string> = { brief: "Brief", creative: "Creative", copy: "Copy", launch: "Launch", activity: "Activity" };

/**
 * Who is looking: lead (the Head of Creative, an exec or a lead: approves creative and copy), copywriter (approves
 * copy), maker (the person the ticket is assigned to), team (anyone else).
 */
export type TicketRole = "lead" | "copywriter" | "maker" | "team";

/** What the stage opens on */
export type FocusPanel = "brief" | "make" | "review" | "fix" | "copy" | "client" | "launch" | "done";

/** Where a panel's own action sits, so the bar can take you there */
export type ActionTarget = "ai-gate" | "review" | "copy" | "launch";

export type PrimaryAction =
  /** The stage's plain next step: the bar moves the ticket */
  | { kind: "move"; to: Stage; label: string }
  /** The action lives in a panel (the AI review gate, approve or send back, the copy studio, the launcher): the bar takes you there */
  | { kind: "panel"; tab: TicketTab; target: ActionTarget; label: string }
  /** Someone else has it: said, no button */
  | { kind: "wait"; label: string };

export type TicketLayout = {
  focus: FocusPanel;
  defaultTab: TicketTab;
  tabs: TicketTab[];
  action: PrimaryAction | null;
  /** Quieter moves in the bar beside the primary one (going back, marking launched by hand) */
  secondary: { to: Stage; label: string }[];
  /** Making stages: going back sits with the AI review gate, beside sending on */
  gateBack: { to: Stage; label: string } | null;
  /** The client's portal shows where it stands: a link to their view */
  clientView: boolean;
};

// "Send back" moves where the flow allows going backwards
export const BACK: Partial<Record<Stage, { to: Stage; label: string }>> = {
  in_production: { to: "requested", label: "Back to request" },
  internal_review: { to: "in_production", label: "Send back to creative" },
  client_review: { to: "client_revision", label: "Client asked for changes" },
  ready_for_launch: { to: "client_review", label: "Back to client" },
};

/** Making stages: the upload area and the AI review gate are the work */
export const MAKING: Stage[] = ["in_production", "client_revision"];
/** Stages with a copy set (the Copy tab) */
export const COPY_STAGES: Stage[] = ["copy", "copy_review", "ready_for_client", "client_review", "client_revision", "ready_for_launch", "launched"];
const CLIENT_STAGES: Stage[] = ["ready_for_client", "client_review", "client_revision", "ready_for_launch"];

/** The role from what the person can do and whether the ticket is theirs */
export function ticketRole(can: { review?: boolean; approveCopy?: boolean }, assignedToMe = false): TicketRole {
  if (can.review) return "lead";
  if (can.approveCopy) return "copywriter";
  return assignedToMe ? "maker" : "team";
}

export function ticketLayout(stage: Stage, role: TicketRole): TicketLayout {
  const info = stageInfo(stage);
  const back = BACK[stage];
  const tabs: TicketTab[] = ["brief", "creative"];
  if (COPY_STAGES.includes(stage)) tabs.push("copy");
  if (stage === "ready_for_launch" || stage === "launched") tabs.push("launch");
  tabs.push("activity");
  const making = MAKING.includes(stage);
  const base = { tabs, secondary: back && !making ? [back] : [], gateBack: making ? (back ?? null) : null, clientView: CLIENT_STAGES.includes(stage) };
  const nextMove = (): PrimaryAction | null => (info.next && info.nextLabel ? { kind: "move", to: info.next, label: info.nextLabel } : null);

  switch (stage) {
    case "requested":
      return { ...base, focus: "brief", defaultTab: "brief", action: nextMove() };
    case "in_production":
      return { ...base, focus: "make", defaultTab: "creative", action: { kind: "panel", tab: "creative", target: "ai-gate", label: "Upload and send to review" } };
    case "client_revision":
      return { ...base, focus: "fix", defaultTab: "creative", action: { kind: "panel", tab: "creative", target: "ai-gate", label: "Fix and send to review" } };
    case "internal_review":
      return {
        ...base,
        focus: "review",
        defaultTab: "creative",
        action: role === "lead" ? { kind: "panel", tab: "creative", target: "review", label: "Approve or send back" } : { kind: "wait", label: "With the Head of Creative for review" },
        // Sending back is the reviewer's call, made in the review panel with the notes
        secondary: [],
      };
    case "copy":
    case "copy_review": {
      const approver = role === "lead" || role === "copywriter";
      return {
        ...base,
        focus: "copy",
        defaultTab: "copy",
        action: { kind: "panel", tab: "copy", target: "copy", label: approver && stage === "copy_review" ? "Review and approve the copy" : "Open the copy" },
      };
    }
    case "ready_for_client":
    case "client_review":
      return { ...base, focus: "client", defaultTab: "creative", action: nextMove() };
    case "ready_for_launch":
      return {
        ...base,
        focus: "launch",
        defaultTab: "launch",
        action: { kind: "panel", tab: "launch", target: "launch", label: "Launch it" },
        // Launched outside Kaizen Ads: marked by hand
        secondary: [...base.secondary, { to: "launched", label: "Mark launched" }],
      };
    case "launched":
      return { ...base, focus: "done", defaultTab: "launch", action: null };
  }
}

/** The tab to show: the address's when the stage has it, else the stage's own */
export function activeTab(layout: TicketLayout, param: string | null): TicketTab {
  return param && (layout.tabs as string[]).includes(param) ? (param as TicketTab) : layout.defaultTab;
}
