// The Email Board's rules as plain functions (no database, no network), so the flow is tested on its own:
// the stages and their order, where a ticket goes next (SMS skips design, an all-SMS batch skips the build), who owns
// each stage (the client's seats, primary first), the size limits (a batch up to 5 messages, a flow up to 6), each
// message's own status inside a ticket, the Asana email board's columns, and routing a client comment to copy or design
// when the AI can't say.

export type EmailStage = "copy_review" | "ready_for_design" | "for_review" | "with_client" | "revisions" | "ready_for_build" | "ready_to_send" | "live";
export type EmailKind = "batch" | "flow";
export type MessageChannel = "email" | "sms";
export type EmailPriority = "normal" | "high" | "urgent";
export type EmailSeat = "email_strategist" | "email_designer" | "email_builder";
export type Route = "copy" | "design";

/** The board's columns, in order (Sent or live is off the board: it's done) */
export const EMAIL_BOARD_ORDER: EmailStage[] = ["copy_review", "ready_for_design", "for_review", "with_client", "revisions", "ready_for_build", "ready_to_send"];
export const EMAIL_STAGES: EmailStage[] = [...EMAIL_BOARD_ORDER, "live"];

export type EmailPhase = "copy" | "design" | "client" | "build";
export const EMAIL_PHASE_LABEL: Record<EmailPhase, string> = { copy: "Copy", design: "Design", client: "Client", build: "Build and send" };

type Info = { label: string; short: string; phase: EmailPhase; owner: string; seat: EmailSeat | null; days: number };
const INFO: Record<EmailStage, Info> = {
  copy_review: { label: "Copy for review", short: "Copy", phase: "copy", owner: "AI writes, strategist approves", seat: "email_strategist", days: 1 },
  ready_for_design: { label: "Ready for design", short: "Design", phase: "design", owner: "Email designer", seat: "email_designer", days: 2 },
  for_review: { label: "For review", short: "Review", phase: "design", owner: "Strategist, final look", seat: "email_strategist", days: 1 },
  with_client: { label: "With client", short: "Client", phase: "client", owner: "Waiting on the client", seat: "email_strategist", days: 2 },
  revisions: { label: "Revisions", short: "Changes", phase: "client", owner: "Copy to the strategist, design to the designer", seat: null, days: 1 },
  ready_for_build: { label: "Ready for build", short: "Build", phase: "build", owner: "Email builder", seat: "email_builder", days: 1 },
  ready_to_send: { label: "Ready to send", short: "Send", phase: "build", owner: "Strategist, final check", seat: "email_strategist", days: 1 },
  live: { label: "Sent or live", short: "Live", phase: "build", owner: "Done", seat: null, days: 0 },
};
export const emailStageInfo = (s: EmailStage) => INFO[s];
/** Business days each stage has before its clock runs over */
export const turnaroundDays = (s: EmailStage) => INFO[s].days;

export const KIND_LABEL: Record<EmailKind, string> = { batch: "Campaign batch", flow: "Flow" };
/** A campaign batch holds up to 5 messages, a flow up to 6 */
export const MAX_MESSAGES: Record<EmailKind, number> = { batch: 5, flow: 6 };

/** Whether a ticket of this kind can hold this many messages; the reason when it can't */
export function sizeProblem(kind: EmailKind, count: number): string | null {
  if (count < 1) return `A ${kind === "flow" ? "flow" : "campaign batch"} needs at least one message.`;
  if (count > MAX_MESSAGES[kind]) return kind === "flow" ? `A flow holds up to ${MAX_MESSAGES.flow} messages. Split it into two flows.` : `A campaign batch holds up to ${MAX_MESSAGES.batch} emails. Make a second batch for the rest.`;
  return null;
}

export type MessageLite = {
  channel: MessageChannel;
  copyApproved: boolean;
  hasDesign: boolean;
  aiReview: "none" | "running" | "done" | "failed";
  clientStatus: "pending" | "approved" | "changes" | null;
  builtAt: string | null;
  liveAt: string | null;
};

const allSms = (msgs: Pick<MessageLite, "channel">[]) => msgs.length > 0 && msgs.every((m) => m.channel === "sms");

/** Whether the ticket needs a design step at all (SMS has none) */
export const needsDesign = (msgs: Pick<MessageLite, "channel">[]) => !allSms(msgs);
/** Whether it needs a build step: a flow always does; a campaign batch of texts only is set up by the strategist at the final check */
export const needsBuild = (kind: EmailKind, msgs: Pick<MessageLite, "channel">[]) => kind === "flow" || !allSms(msgs);

/**
 * Where a ticket goes when its stage's work is done. From the client it depends on their answer: any message sent
 * back goes to Revisions, all approved goes on to the build (or straight to the final check for texts only).
 */
export function nextStage(t: { kind: EmailKind; stage: EmailStage }, msgs: MessageLite[]): EmailStage {
  const design = needsDesign(msgs);
  const build = needsBuild(t.kind, msgs);
  switch (t.stage) {
    case "copy_review":
      return design ? "ready_for_design" : "with_client";
    case "ready_for_design":
      return "for_review";
    case "for_review":
      return "with_client";
    case "with_client":
      if (msgs.some((m) => m.clientStatus === "changes")) return "revisions";
      return build ? "ready_for_build" : "ready_to_send";
    case "revisions":
      // The strategist looks at a revised design before the client sees it again; texts go straight back
      return design ? "for_review" : "with_client";
    case "ready_for_build":
      return "ready_to_send";
    case "ready_to_send":
    case "live":
      return "live";
  }
}

/** Whether a stage is on this ticket's path at all (no design for texts, no build for a batch of texts) */
export function onPath(t: { kind: EmailKind }, msgs: Pick<MessageLite, "channel">[], s: EmailStage) {
  if ((s === "ready_for_design" || s === "for_review") && !needsDesign(msgs)) return false;
  if (s === "ready_for_build" && !needsBuild(t.kind, msgs)) return false;
  return true;
}

/** Where each stage sits in the flow, for telling a move back from a move forward (Revisions is design again) */
const RANK: Record<EmailStage, number> = { copy_review: 0, ready_for_design: 1, revisions: 1, for_review: 2, with_client: 3, ready_for_build: 4, ready_to_send: 5, live: 6 };
export const isBackwards = (from: EmailStage, to: EmailStage) => RANK[to] < RANK[from];

/** One message's place inside its ticket, in plain words: a batch can be part approved and part in revisions */
export type MessageStatus = "copy" | "design" | "review" | "client" | "approved" | "changes" | "built" | "live";
export const MESSAGE_STATUS_LABEL: Record<MessageStatus, string> = { copy: "Copy", design: "Design", review: "In review", client: "With client", approved: "Approved", changes: "Changes asked", built: "Built", live: "Live" };
export function messageStatus(m: MessageLite, stage: EmailStage): MessageStatus {
  if (m.liveAt || stage === "live") return "live";
  if (m.builtAt) return "built";
  if (m.clientStatus === "approved") return "approved";
  if (m.clientStatus === "changes") return "changes";
  if (stage === "with_client" && m.clientStatus === "pending") return "client";
  if (!m.copyApproved) return "copy";
  if (m.channel === "email" && !m.hasDesign) return "design";
  if (stage === "with_client") return "client";
  return "review";
}

export type MoveCheck = { backwards: boolean; blockers: string[]; warnings: string[]; effects: string[] };

/** Before a ticket moves by hand (dragged, or picked in the ticket): what's missing, what to know, what happens there */
export function checkMove(t: { kind: EmailKind; stage: EmailStage }, msgs: MessageLite[], to: EmailStage): MoveCheck {
  const out: MoveCheck = { backwards: isBackwards(t.stage, to), blockers: [], warnings: [], effects: [] };
  if (to === t.stage) return out;
  const emails = msgs.filter((m) => m.channel === "email");
  const unapproved = msgs.filter((m) => !m.copyApproved).length;
  const noDesign = emails.filter((m) => !m.hasDesign).length;
  if (!onPath(t, msgs, to)) out.warnings.push(to === "ready_for_build" ? "Texts in a campaign batch aren't built: the strategist sets them up at the final check." : "Texts have no design step.");
  if (RANK[to] >= 1 && to !== "revisions" && unapproved) out.warnings.push(`${unapproved} of ${msgs.length} ${msgs.length === 1 ? "message's copy isn't" : "messages' copy isn't"} approved yet.`);
  if (RANK[to] >= 2 && to !== "revisions" && noDesign) out.blockers.push(`${noDesign} ${noDesign === 1 ? "email has" : "emails have"} no design uploaded yet.`);
  if (to === "with_client" && emails.some((m) => m.hasDesign && m.aiReview !== "done")) out.warnings.push("The AI hasn't reviewed every design yet.");
  if (RANK[to] >= 4 && msgs.some((m) => m.clientStatus !== "approved")) out.warnings.push(`The client has approved ${msgs.filter((m) => m.clientStatus === "approved").length} of ${msgs.length}.`);
  if (to === "ready_to_send" && needsBuild(t.kind, msgs) && msgs.some((m) => !m.builtAt)) out.warnings.push("Not every message is marked built yet.");
  if (to === "live" && msgs.some((m) => !m.builtAt && needsBuild(t.kind, msgs))) out.warnings.push("Not every message is marked built.");
  if (to === "ready_for_design") out.effects.push("It goes to the client's email designer.");
  if (to === "for_review") out.effects.push("The strategist gets it for the final look; the AI reviews any design not reviewed yet.");
  if (to === "with_client") out.effects.push("It shows in the client's portal for their approval, and they hear about it.");
  if (to === "ready_for_build") out.effects.push("It goes to the client's email builder.");
  if (to === "ready_to_send") out.effects.push("The strategist does the final check, then schedules it or sets the flow live.");
  if (to === "live") out.effects.push("It leaves the board as sent or live.");
  if (out.backwards) out.effects.push("The turnaround for that stage starts again, and it goes to that stage's owner.");
  return out;
}

export type SeatRow = { profile_id: string; role: string; is_primary?: boolean | null; created_at?: string | null };

/** The person on a client's seat: the primary first, then whoever was seated first */
export function pickSeat(seats: readonly SeatRow[], seat: EmailSeat): string | null {
  const on = seats.filter((s) => s.role === seat);
  if (!on.length) return null;
  const sorted = [...on].sort((a, b) => Number(Boolean(b.is_primary ?? true)) - Number(Boolean(a.is_primary ?? true)) || String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  return sorted[0].profile_id;
}

/**
 * Who a ticket goes to when it lands on a stage. In Revisions: the designer when any change is to a design, else the
 * strategist. A seat nobody holds leaves it unassigned (the Head of Email sees every ticket).
 */
export function ownerFor(stage: EmailStage, seats: readonly SeatRow[], routes: readonly Route[] = []): string | null {
  if (stage === "live") return null;
  if (stage === "revisions") return (routes.includes("design") ? pickSeat(seats, "email_designer") : null) ?? pickSeat(seats, "email_strategist");
  const seat = INFO[stage].seat;
  if (!seat) return null;
  // A builder who also designs holds the designer seat itself, so the seat is all there is to read
  return pickSeat(seats, seat);
}

/**
 * A client comment's route when the AI can't say: words about the picture, layout, colours, images, buttons or fonts
 * go to design, anything else (wording, subject lines, offers, dates) to copy. Texts are always copy.
 */
export function routeFallback(text: string, channel: MessageChannel = "email"): Route {
  if (channel === "sms") return "copy";
  const t = text.toLowerCase();
  const design = /\b(image|images|photo|photos|picture|pictures|colou?rs?|font|fonts|logo|layout|spacing|button|buttons|banner|hero|background|bigger|smaller|align|aligned|centered|centre|center|crop|cropped|graphic|graphics|design|icon|icons|mobile view|looks?|visual|white space|padding|gif)\b/;
  const copy = /\b(subject|preview text|preheader|wording|word|words|typo|spelling|grammar|sentence|headline|copy|text says|rephrase|reword|tone|offer|discount|code|date|price|says)\b/;
  const d = design.test(t);
  const c = copy.test(t);
  if (d && !c) return "design";
  return "copy";
}

/** Where the client's answer leaves the ticket: who each comment went to and which messages wait on whom */
export function routesOf(comments: readonly { route: Route | null }[]): Route[] {
  return [...new Set(comments.map((c) => c.route).filter((r): r is Route => Boolean(r)))];
}

// ─── The Asana email board's columns ─────────────────────────────────────────

/** Asana's email columns → the Email Board's stages (the first match wins; Sent, Live, Scheduled and Done are done) */
export const EMAIL_COLUMN_STAGE: [RegExp, EmailStage | null][] = [
  // The team's real Asana columns first: "Email Requests" (new requests) and "Needs Revision" (client changes)
  [/^email requests?/i, "copy_review"],
  [/^needs? revisions?/i, "revisions"],
  [/^(copy|copywriting).*(review|approval)/i, "copy_review"],
  [/^(brief|request|backlog|to ?do|new|ideas?|copy|copywriting|writing)/i, "copy_review"],
  [/^(ready for design|design|in design|designing|in progress)/i, "ready_for_design"],
  [/^(for review|internal review|review|qa|strategist)/i, "for_review"],
  [/^(with client|sent to client|client review|client approval|ready for client|waiting on client)/i, "with_client"],
  [/^(revision|revisions|client revision|changes|edits)/i, "revisions"],
  [/^(ready for build|build|building|in build|to build)/i, "ready_for_build"],
  [/^(ready to send|ready to schedule|final|final qa|ready to go live|approved)/i, "ready_to_send"],
];
export const emailStageForColumn = (name: string | null): EmailStage | null => {
  if (!name) return null;
  const n = name.trim();
  if (isDoneColumn(n)) return null;
  for (const [re, s] of EMAIL_COLUMN_STAGE) if (re.test(n)) return s;
  return null;
};
/** Whether a column is a done one (the task is finished there, not waiting on anything) */
export const isDoneColumn = (name: string | null) => Boolean(name && /^(sent|live|scheduled|done|complete)/i.test(name.trim()) && !/client/i.test(name));

/**
 * The Asana email project among the workspace's projects, when no id is set: "Email" exactly, then a name starting
 * with Email (Email Board, Email Marketing), then any with the word email, never an archived or template one.
 */
export function pickEmailProject(projects: readonly { gid: string; name: string }[]): { gid: string; name: string } | null {
  const ok = projects.filter((p) => !/archive|template|old|copy of/i.test(p.name));
  const exact = ok.find((p) => p.name.trim().toLowerCase() === "email");
  if (exact) return exact;
  const starts = ok.filter((p) => /^email\b/i.test(p.name.trim()));
  if (starts.length) return [...starts].sort((a, b) => a.name.length - b.name.length)[0];
  const any = ok.filter((p) => /\bemail\b/i.test(p.name) && !/client|onboard/i.test(p.name));
  return any.length ? [...any].sort((a, b) => a.name.length - b.name.length)[0] : null;
}

// ─── Health of a ticket's clock ───────────────────────────────────────────────

export type Health = "ok" | "warn" | "bad";
/** On time, up to 12 business hours over, or more (the creative board's bands) */
export const emailHealth = (minutesOver: number, stage: EmailStage): Health => (stage === "with_client" || stage === "live" ? "ok" : minutesOver <= 0 ? "ok" : minutesOver <= 12 * 60 ? "warn" : "bad");

/** The ticket's short handle, so email tickets never read as creative ones: E-12 */
export const handle = (n: number) => `E-${n}`;
