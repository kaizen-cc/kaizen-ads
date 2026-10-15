// The seats at the Ads Lab round table and the metrics a test can be read on, for the server and the page alike.
export const SEATS = {
  strategist: { name: "Strategist", tint: "#e0a03f", does: "connects the idea to the business problem and the account data; decides what's worth testing" },
  copy: { name: "Copywriter", tint: "#c08a2e", does: "hooks, angles, offers in words; what the first line and headline say" },
  creative: { name: "Creative director", tint: "#9b6bd6", does: "what's shown: format, visual idea, first 3 seconds, brand fit" },
  media: { name: "Media buyer", tint: "#5b8def", does: "how to run it cleanly on Meta: budget, audience, structure, how long to read it, what can confound it" },
  analyst: { name: "Analyst", tint: "#2fa37a", does: "what the numbers say, what a fair test looks like, whether a result is real or noise; spots duplicates of tests already run" },
} as const;
export type Seat = keyof typeof SEATS;
export type Metric = "cpr" | "results" | "ctr" | "roas";
export const METRIC_LABEL: Record<Metric, string> = { cpr: "Cost per result", results: "Results", ctr: "Click-through rate", roas: "ROAS" };

