// What each agent leads with when someone asks about numbers: the metrics its role cares about and what it ranks
// (emails, ads, posts or clients), so "what's the best performing email?" gets a designer's answer from the email
// designer and a strategist's from the strategist. One short line in the call's and the chat's instructions.

export const ROLE_FOCUS: Record<string, string> = {
  email_strategist: "You lead with revenue: attributed revenue, revenue per recipient, the account score and pace against the month's target. Asked for the best email or client, rank by revenue per recipient or revenue (top_emails, rank_clients on email).",
  email_creative: "You're the email designer and copywriter: you lead with click rate (CTR) first, then open rate for subject lines. Asked for the best email, rank single emails, not clients (top_emails by click_rate), name it, give its numbers and its link, and explain why it worked with email_detail when asked.",
  email_builder: "You lead with what the build affects: click rate, deliverability (bounces, spam, unsubscribes) and whether flows are live and sending (top_emails, email_marketing).",
  copywriter: "You lead with what copy moves: ad CTR and hook strength, and email open and click rates for subject lines (top_ads by ctr, top_emails).",
  creative_director: "You lead with creative performance: ad CTR, ROAS and cost per purchase, winners and what's wearing out (top_ads, winners_and_fatigue).",
  media_buyer: "You lead with Meta: ROAS or cost per result against the KPI target, spend and budget pacing (rank_clients on meta, account_metrics, top_ads).",
  google_buyer: "You lead with Google: conversions, cost per conversion or ROAS against target, and spend (rank_clients on google, account_metrics).",
  tiktok_buyer: "You lead with TikTok's cost per result and CTR; TikTok numbers are read only, in get_client_context.",
  strategist: "You lead with each client's main KPI against target across their lines, and who is most at risk (rank_clients, get_client_context).",
  market_analyst: "You lead with what's working across clients: winning ads and angles, and trends by kind of business (top_ads, winners_and_fatigue).",
  account_manager: "You lead with how each client is doing against their goals, what changed and what's owed to them (rank_clients, what_changed).",
};

/** The agent's line for its instructions (a general one for an agent without its own) */
export function focusFor(roleKey: string): string {
  return ROLE_FOCUS[roleKey] ?? "You lead with each client's main KPI against its target (rank_clients, get_client_context).";
}

/** The seat a request to "make sure that gets done" goes to on a client, by the agent's line (primary holder first) */
export const OWNER_SEAT: Record<string, string> = {
  email_strategist: "email_strategist",
  email_creative: "email_strategist",
  email_builder: "email_builder",
  media_buyer: "meta_buyer",
  google_buyer: "google_buyer",
  tiktok_buyer: "tiktok_buyer",
  creative_director: "coordinator",
  copywriter: "coordinator",
  strategist: "coordinator",
  market_analyst: "coordinator",
  account_manager: "coordinator",
};
