import type { RequestDemo } from "@/app/(team)/requests/new/request-form";

// Sample AI answers for the request form in the local design preview only.
export const sampleRequest: RequestDemo = {
  context: { requests: 14, angles: 5, memory: 4, adAccount: true },
  suggestions: {
    titles: ["BFCM · Buy More, Save More", "BFCM · Doorbusters week", "Black Friday · Family bundle"],
    angles: [
      { name: "Weekly Deals", why: "Their best-performing angle in recent requests; ties straight to a price." },
      { name: "Family night in", why: "Fits the bundle offer and the parents audience." },
    ],
    audiences: ["Past customers, last 180 days", "Parents within 10 miles, retargeting site visitors", "Broad, ages 25–54, local"],
    mix: [
      { format: "image", new: 3, variations: 2 },
      { format: "video", new: 1, variations: 0 },
    ],
    mixWhy: "Statics carry the offer; one short video for Reels, where they've had the cheapest clicks.",
    sizes: ["4x5", "9x16"],
    brief:
      "Lead with the offer: buy 2 pizzas, get a calzone free, this week only.\nShow the calzone cut open with the cheese pull, warm lighting, on a family table.\nOn-image text under 8 words; the price goes top left.\nUse the new red logo, never the old one.\nVideo: 10–15s, hook in the first second, captions on.\nVariations test the headline only: price-first vs family-first.",
    hooks: ["Two pizzas in, one calzone free", "Friday night, sorted", "The cheese pull you've been waiting for"],
    watchouts: ["Use the new red logo; the old one is retired", "No stock photos of people eating; they want real customers", "Don't mention delivery. They're pickup only until December"],
  },
  review: {
    verdict: "check",
    summary: "Mostly solid, but the brief mentions delivery, which the client asked us not to promote.",
    issues: [
      {
        severity: "block",
        field: "brief",
        issue: "The brief says “free delivery”, but the client is pickup only until December and asked us not to mention delivery.",
        fix: "Swap it for “ready in 15 minutes for pickup”.",
      },
      {
        severity: "warn",
        field: "formats",
        issue: "The brief describes a 30s story, but the video is set to 1 net new for Reels at 10–15s.",
        fix: "Either shorten the story in the brief or add a second video.",
      },
    ],
  },
};
