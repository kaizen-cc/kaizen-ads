// The craft rules every brief writer, reviser and reviewer reads, written once so the writer is held to the same
// standard the checks hold it to (src/lib/brief-narrative.ts checks these in code where it can; the AI review pass
// judges the rest). From the lead strategist's notes on a video brief that took six rounds: the first strategic pass
// was generic (swap in a competitor's logo and it worked the same), and the narrative problems (a hook answered at
// 6 to 14 seconds, versions that didn't match the body, the strongest visual spent in the first seconds, a frame that
// didn't fit the client's best segment, critical claims not flagged) were only fixed once someone pointed them out.
// Roles, never names; no em dashes. Pure strings: safe anywhere.

/** The differentiation bar: client-specific proof, and the competitor swap test */
export const SWAP_RULE = `DIFFERENTIATION (before anything else). The concept must be this client's and nobody else's: build it on their own proof, their numbers, their customers and reviews, their offer, how their product or service actually works (the mechanism), their best-performing ads and what made them work. Never restate the intake or the angle back as the idea. Run the competitor swap test: put a direct competitor's logo on it; if the ad still works the same, it is generic. Rewrite it once with sharper, client-specific proof (a number, a named customer outcome, the real mechanism, a line from a review or the owner) and name where that proof comes from. If the context truly holds no such proof, say so under Confirm with client and keep the most specific version you can.`;

/** The narrative checks, by format: what makes the story work, not just the operational detail */
export const NARRATIVE_RULE = `THE STORY HAS TO WORK, by format (check it yourself before anyone sees it):
- Video: the hook's question or promise is answered within the first ~3 seconds (the answer never waits for 6 or 14 seconds); every version's hook matches the body it runs on (a version that needs a different body says so with "Also changes:"); the strongest visual (the reveal, the result, the best shot) is not spent in the first seconds unless it IS the hook, and something later earns the watch; the frame fits the client's best-performing segment and audience from their performance data; a claim the offer depends on is flagged under Confirm with client as "Blocker:" when it isn't approved.
- Single image: the headline answers the hook at a glance (no question left open on the image); every version's headline fits the frame it sits on; the strongest visual leads what reads first (never the logo or the button); the frame fits the best-performing segment; critical claims flagged as blockers when unapproved.
- Carousel: the first slide hooks on its own; the slide order builds (hook, then proof or the turn, then the payoff, never the payoff before the problem); the last slide asks for the click; every version's slides match its line; critical claims flagged as blockers when unapproved.`;
