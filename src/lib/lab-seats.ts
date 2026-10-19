// The seats at the Ads Lab round table are Kaizen's six agents (no others: the Lab improves them, it never adds one),
// and the metrics a test can be read on, for the server and the page alike. `role` is the agent in Settings.
export const SEATS = {
  strategist: { name: "Strategist", role: "strategist", tint: "#e0a03f", does: "connects the idea to the business problem, the account data and the vertical playbook; decides what's worth testing" },
  creative: { name: "Creative Director", role: "creative_director", tint: "#9b6bd6", does: "what's shown: format, visual idea, first 3 seconds, brand fit, whether it carries the avatar and angle" },
  copy: { name: "Copywriter", role: "copywriter", tint: "#c08a2e", does: "hooks, angles and offers in words; what the first line and headline say to the avatar" },
  media: { name: "Media Buyer", role: "media_buyer", tint: "#5b8def", does: "how to run it cleanly on Meta: budget, audience, structure, how long to read it, what can confound it" },
  analyst: { name: "Market Analyst", role: "market_analyst", tint: "#2fa37a", does: "what our winners and the market (ads live 30+ days) say, whether a result is real or noise; spots tests already run" },
  account: { name: "Account Manager", role: "account_manager", tint: "#3fa7b5", does: "what the clients said, asked for and were promised; what they'll accept" },
} as const;
export type Seat = keyof typeof SEATS;
export type Metric = "cpr" | "results" | "ctr" | "roas";
export const METRIC_LABEL: Record<Metric, string> = { cpr: "Cost per result", results: "Results", ctr: "Click-through rate", roas: "ROAS" };

