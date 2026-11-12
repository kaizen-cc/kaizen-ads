import type { ClientSocial } from "./store";
import type { HealthFinding } from "./insights";

// The short Social card on the whole-business view. Pure and free of server code, so the client page can use it.

export type SocialSummary = { followers: number | null; change: number | null; reach: number | null; prevReach: number | null; rate: number | null; postsPerWeek: number; findings: Pick<HealthFinding, "tone" | "title">[] };

export function socialSummary(d: ClientSocial): SocialSummary {
  return { followers: d.followersNow, change: d.followersChange, reach: d.now.reach, prevReach: d.before.reach, rate: d.now.rate, postsPerWeek: d.postsPerWeek, findings: d.health.map((h) => ({ tone: h.tone, title: h.title })) };
}
