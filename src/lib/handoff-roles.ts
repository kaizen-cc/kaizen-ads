// One handoff for every seat on a client: the Meta and Google buyers, the designer and video editor, the email
// strategist, designer and builder, the social manager and social creative. What each seat does (so the handoff is
// written for that job), which of the account's open work follows the seat to the new person, and who leads the line
// (they see every handoff on it). Pure, so the handoff writer, the work mover and the tests share it.

export type SeatJob = { label: string; job: string; focus: string };

const JOBS: Record<string, SeatJob> = {
  meta_buyer: { label: "Meta buyer", job: "runs the client's Meta (Facebook and Instagram) ads", focus: "campaigns, budgets, audiences, the KPI and its target, the optimization sprint, creative in testing and launches" },
  tiktok_buyer: { label: "TikTok buyer", job: "runs the client's TikTok ads", focus: "TikTok campaigns, budgets, the KPI and creative in testing" },
  google_buyer: { label: "Google buyer", job: "runs the client's Google Ads", focus: "campaigns, keywords and search terms, budgets and bids, conversion tracking, the KPI and its target" },
  graphic_designer: { label: "designer", job: "designs the client's static ads", focus: "open creative tickets and their briefs, revision rounds and what the client asked for, the brand's look and rules, assets on Drive, deadlines" },
  video_editor: { label: "video editor", job: "edits the client's video ads", focus: "open creative tickets and their briefs, revision rounds and what the client asked for, footage and assets on Drive, the brand's look and rules, deadlines" },
  email_strategist: { label: "email strategist", job: "plans the client's email and SMS (campaigns, flows, the calendar) and talks to the client about it", focus: "the email calendar and allotment, open email tickets by stage, flows live and planned, the email KPIs, offers and launches coming up, promises made to the client" },
  email_designer: { label: "email designer", job: "designs the client's emails", focus: "open email tickets in design, revisions the client asked for, the brand's email look, templates, deadlines" },
  email_builder: { label: "email builder", job: "builds and schedules the client's emails and flows in their email platform", focus: "open email tickets in build and QA, scheduled sends, flows, the email platform's setup, deadlines" },
  social_manager: { label: "social media manager", job: "runs the client's organic social (posts, stories, the calendar, community) and talks to the client about it", focus: "the posting calendar and allotment, posts waiting on approval, the social KPIs, the social sprint, offers and launches coming up, promises made to the client" },
  social_creative: { label: "social creative", job: "makes the client's organic social posts and stories", focus: "posts in production and their briefs, revisions the client asked for, the brand's look, deadlines" },
};

export const seatJob = (role: string): SeatJob => JOBS[role] ?? { label: role.replace(/_/g, " "), job: "works on the client's account", focus: "the client's open work and deadlines" };

/** Every seat that gets a handoff */
export const HANDOFF_SEATS = Object.keys(JOBS);

/** Who leads each seat's line (sees and is told about every handoff on it) */
const HEAD: Record<string, string> = {
  meta_buyer: "head_of_meta",
  tiktok_buyer: "head_of_meta",
  google_buyer: "head_of_google",
  graphic_designer: "head_of_creative",
  video_editor: "head_of_creative",
  email_strategist: "head_of_email",
  email_designer: "head_of_email",
  email_builder: "head_of_email",
  social_manager: "head_of_social",
  social_creative: "head_of_social",
};
export const headOf = (role: string): string | null => HEAD[role] ?? null;

/**
 * The open work that follows a seat to the new person. Each is an update of one column from the old person to the
 * new one, on this client's rows that are still open. `shared` work (promises, owed replies, tasks) moves only when the
 * old person keeps no other seat on the client: otherwise it may be theirs for that other seat.
 */
export type WorkMove = { key: string; table: string; column: string; open: Record<string, unknown>; notIn?: [string, string[]]; label: string; shared?: boolean };

const TICKETS = (column: string): WorkMove => ({ key: `tickets_${column}`, table: "requests", column, open: { deleted_at: null }, notIn: ["stage", ["launched"]], label: "open creative tickets" });

export function workFor(role: string): WorkMove[] {
  const common: WorkMove[] = [
    { ...TICKETS("assignee_id"), key: "held", label: "creative tickets they were holding" },
    { key: "promises", table: "message_promises", column: "owner_id", open: {}, notIn: ["status", ["done", "dismissed", "not_promise"]], label: "promises to the client", shared: true },
    { key: "owed", table: "owed_replies", column: "target_id", open: {}, notIn: ["status", ["answered", "dismissed"]], label: "messages waiting on a reply", shared: true },
    { key: "tasks", table: "client_tasks", column: "owner_id", open: { done_at: null }, label: "setup tasks", shared: true },
  ];
  switch (role) {
    case "meta_buyer":
      return [
        { key: "kpis", table: "kpi_targets", column: "owner_id", open: { platform: "meta", active: true }, label: "Meta KPI" },
        { ...TICKETS("buyer_id"), key: "tickets" },
        { key: "sprints", table: "optimization_sprints", column: "buyer_id", open: { status: "active" }, label: "optimization sprint" },
        ...common,
      ];
    case "google_buyer":
      return [{ key: "kpis", table: "kpi_targets", column: "owner_id", open: { platform: "google", active: true }, label: "Google KPI" }, ...common];
    case "tiktok_buyer":
      return common;
    case "graphic_designer":
    case "video_editor":
      return [{ ...TICKETS("creative_id"), key: "tickets", label: "open creative tickets" }, ...common];
    case "email_strategist":
    case "email_designer":
    case "email_builder":
      return [
        { key: "email_tickets", table: "email_tickets", column: "assignee_id", open: { deleted_at: null }, notIn: ["stage", ["live"]], label: "open email tickets" },
        ...(role === "email_strategist"
          ? [
              { key: "email_sprints", table: "email_sprints", column: "owner_id", open: { status: "active" }, label: "email sprint" },
              { key: "email_targets", table: "channel_targets", column: "owner_id", open: { line: "email" }, label: "email KPI targets" },
            ]
          : []),
        ...common,
      ];
    case "social_manager":
    case "social_creative":
      return [
        ...(role === "social_manager"
          ? [
              { key: "social_sprints", table: "social_sprints", column: "owner_id", open: { status: "active" }, label: "social sprint" },
              { key: "social_targets", table: "channel_targets", column: "owner_id", open: { line: "social" }, label: "social KPI targets" },
            ]
          : []),
        ...common,
      ];
    default:
      return common;
  }
}

/** "3 open email tickets, the email sprint" from what moved */
export function movedLine(role: string, moved: Record<string, number>): string[] {
  return workFor(role)
    .filter((w) => (moved[w.key] ?? 0) > 0)
    .map((w) => (["kpis", "sprints", "email_sprints", "social_sprints"].includes(w.key) ? `the ${w.label}` : `${moved[w.key]} ${w.label}`));
}
