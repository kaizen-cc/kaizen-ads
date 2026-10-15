import type { Industry } from "@/lib/industries";

// The marketing intake as the AI read it, and how every agent sees it. Kept apart from the AI module (no cycle).

export type IntakeSummary = {
  business: string;
  offer: string;
  audience: string;
  locations: string;
  goals: string;
  voice: string;
  avoid: string[];
  proof: string[]; // reviews, results, awards, guarantees they mentioned
  competitors: string[];
  assets: string[]; // photos, videos, brand files they have or linked
  questions: string[]; // what the team should still ask
  industry: Industry;
  industryDetail: string;
};

/** The intake in lines, for every agent's view of the client. */
export function describeIntake(x: IntakeSummary) {
  const list = (label: string, items: string[]) => (items.length ? `${label}: ${items.join("; ")}` : null);
  return [
    `What they are: ${x.business}`,
    `Offer: ${x.offer}`,
    `Audience: ${x.audience}`,
    x.locations && x.locations !== "Not given" && `Where: ${x.locations}`,
    `Goals: ${x.goals}`,
    `Voice: ${x.voice}`,
    list("Avoid", x.avoid),
    list("Proof", x.proof),
    list("Competitors", x.competitors),
    list("Assets they have", x.assets),
  ]
    .filter(Boolean)
    .join("\n");
}
