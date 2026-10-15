// What each kind of strategist suggestion is called, for the server and the Home page alike.
export type SuggestionKind = "fatigue" | "kpi" | "pacing" | "offer" | "unhappy" | "flop" | "lab" | "winner" | "refresh" | "onboarding";
export const KIND_LABEL: Record<SuggestionKind, string> = {
  fatigue: "Ads tiring",
  kpi: "KPI off target",
  pacing: "Behind on creative",
  offer: "New offer, no request",
  unhappy: "Client not happy",
  flop: "Angle not landing",
  lab: "From the Ads Lab",
  winner: "From a winner",
  refresh: "Refresh a tiring ad",
  onboarding: "First round",
};
