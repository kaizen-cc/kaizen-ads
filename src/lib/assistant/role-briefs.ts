// Each person's assistant (chat and call alike) knows their exact role: what they're responsible for, what matters to
// them, and what to leave alone (the owner's brief, Nov 20 2026). Roles, never names. Pure, so the prompt, the tool
// filter and the tests share it.

export type RoleBrief = { duties: string; matters: string; ignore: string };

export const ROLE_BRIEFS: Record<string, RoleBrief> = {
  executive: { duties: "runs the agency: client retention, revenue, the team's output across every line", matters: "clients at risk or on fire, accounts off target, money (fees, spend pace, margins), what each line head is behind on", ignore: "single tasks and tickets unless they ask; never bury them in detail" },
  head_of_meta: { duties: "leads the Meta (and TikTok) buyers: account performance against target, launches, audits and sprints", matters: "accounts off target, buyers behind (the escalation ladder's nudges), launches waiting, reports not sent", ignore: "Google, email and social work unless asked" },
  head_of_google: { duties: "leads the Google Ads buyers: performance against target, search terms, launches and audits", matters: "Google accounts off target, buyers behind, Google ideas to apply", ignore: "Meta creative, allotments, email and social" },
  head_of_creative: { duties: "leads the designers, video editors and copywriter: allotments, briefs, production speed and quality", matters: "the design and video allotments against pace, briefs waiting on approval (rate the drafted ones), late pieces, revisions, makers behind (nudges)", ignore: "ad account numbers, KPIs per account, email and social" },
  lead_graphic_designer: { duties: "leads the graphic designers: their plates, quality, and the design allotment", matters: "My team (each designer's tasks and what's overdue), the design allotment, drafted briefs to rate, designers behind", ignore: "ad account numbers, video, email and social" },
  lead_video_editor: { duties: "leads the video editors: their plates, quality, and video production", matters: "My team (each editor's tasks and what's overdue), video production and the video allotment, drafted briefs to rate, editors behind", ignore: "ad account numbers, design-only work, email and social" },
  graphic_designer: { duties: "makes the static and carousel creative on their plate", matters: "their own tasks by due date, revisions, briefs and the client's Brand Bible (read only: suggest changes)", ignore: "KPIs, accounts, other people's work" },
  video_editor: { duties: "makes the video creative on their plate", matters: "their own tasks by due date, revisions, footage and the Brand Bible (read only: suggest changes)", ignore: "KPIs, accounts, other people's work" },
  copywriter: { duties: "writes ad and email copy", matters: "pieces waiting on copy, the client's voice and Brand Bible, the copy library", ignore: "account numbers and production scheduling" },
  media_buyer: { duties: "runs Meta ad accounts for their clients against target", matters: "their accounts off target, launches, copy waiting on them, tracking tasks to send the tracking specialist, reports to send", ignore: "other buyers' accounts and creative production details" },
  google_buyer: { duties: "runs Google Ads accounts for their clients", matters: "their accounts off target, search terms, Google ideas, reports", ignore: "Meta creative and allotments" },
  head_of_email: { duties: "leads the email team: strategy, design, build, scores and reports", matters: "email clients at risk, the board's stuck tickets, teammates behind (nudges)", ignore: "ads and organic social" },
  email_strategist: { duties: "plans email for their clients", matters: "their clients' calendars, requests, scores and reports", ignore: "ads and organic social" },
  email_designer: { duties: "designs emails on the Email Board", matters: "their tickets by due date and revisions", ignore: "account numbers" },
  email_builder: { duties: "builds emails on the Email Board", matters: "their tickets by due date and builds sent back", ignore: "account numbers" },
  head_of_social: { duties: "leads organic social: posting, scores, reports", matters: "social clients at risk, posting gaps, teammates behind", ignore: "paid ads and email" },
  social_media_manager: { duties: "runs organic social for their clients", matters: "their posting plan, client approvals, reports", ignore: "paid ads and email" },
  customer_success: {
    duties: "the Client Success Coordinator: keeps clients answered and informed",
    matters: "client messages waiting on a reply (who owes each, how long), client channels' response health, reports not sent (by owner, with a nudge to send them; they build reports but never send one), creatives stuck in Ready for copy or with the client, onboarding blockers",
    ignore: "anything creative to make or approve, Brand Bible approvals, ad account performance",
  },
  onboarding_specialist: {
    duties: "the Onboarding Specialist: gets new clients set up",
    matters: "intake forms not filled out, onboarding calls not booked, client assets not coming in, access still missing, messages waiting on them",
    ignore: "anything creative, Brand Bibles, ad performance, reports",
  },
  tracking_specialist: {
    duties: "the Tracking Specialist: makes sure every client's conversions are measured right",
    matters: "audits that found tracking issues, platform vs store conversion gaps, conversion rate drops, tracking tasks buyers send, clients with no tracking set up, landing page and tracking requests, messages waiting on them",
    ignore: "creative entirely (briefs, designs, Brand Bibles), allotments, reports",
  },
};

/** The role brief the assistant reads, in one block */
export function roleBriefBlock(role: string | null | undefined): string {
  const b = ROLE_BRIEFS[String(role ?? "")];
  if (!b) return "";
  return `<their_role>\nThey are ${b.duties}.\nWhat matters to them: ${b.matters}.\nLeave alone unless they ask: ${b.ignore}.\nTalk about their work in these terms, offer what fits this role, and never steer them into work that isn't theirs.\n</their_role>`;
}

/** Tools that are creative work: never offered to a role that doesn't do or approve creative */
const CREATIVE_TOOLS = /^(create_brief|approve_brief|reject_brief|ready_briefs|my_unfinished_briefs|discard_unfinished_brief|creative_allotments|creative_assessment|write_ad_copy|create_copy_doc|rate_drafted_brief|suggest_bible_change|decide_bible_change|bible_changes|waive_brief_asset|brief_asset_waivers|plan_ad_changes|launch_.*|make_creative.*)$/;
const NO_CREATIVE = new Set(["customer_success", "onboarding_specialist", "tracking_specialist"]);

/** Whether this role's assistant carries a tool: the support positions get nothing creative */
export function toolFitsRole(role: string | null | undefined, tool: string): boolean {
  if (NO_CREATIVE.has(String(role ?? ""))) return !CREATIVE_TOOLS.test(tool);
  return true;
}
