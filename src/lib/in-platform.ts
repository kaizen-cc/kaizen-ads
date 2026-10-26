// Whether an audit action or sprint move is something Kaizen Ads can do in the ad account itself: what the change
// planners know how to make (src/lib/ad-changes.ts). Meta: switching campaigns, ad sets or ads on or off and daily
// budgets. Google: also bids (target CPA / ROAS) and negative keywords. Anything else (tracking, reporting, the site,
// the offer, creative, copy, naming, audiences) is done by a person, and the "Make this change" button isn't offered.

type Action = { title: string; area?: string | null; owner?: string | null; steps?: string[]; inPlatform?: boolean };

const META = /\b(pause|paus(ed|ing)|turn(ing)? (it |them )?(off|on)|switch(ing)? (it |them )?(off|on)|shut (it )?off|kill|unpause|re-?enable|budgets?|scale|reallocat\w*)\b|\$\d[\d,]*(\.\d+)? ?(\/ ?day|a day|per day)/i;
const GOOGLE = new RegExp(`${META.source}|\\b(target (cpa|roas)|tcpa|troas|bids?|negative keywords?|negatives)\\b`, "i");

export function inPlatform(a: Action, platform: "meta" | "google") {
  if (a.owner === "creative" || a.owner === "client") return false;
  // The audit says so itself (audits written since this was asked)
  if (typeof a.inPlatform === "boolean") return a.inPlatform;
  if (a.area === "tracking" || a.area === "landing_page" || a.area === "offer" || a.area === "creative") return false;
  const text = [a.title, ...(a.steps ?? [])].join(" ");
  return (platform === "google" ? GOOGLE : META).test(text);
}
