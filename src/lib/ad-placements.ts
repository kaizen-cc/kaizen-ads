import type { MetaRow } from "@/lib/client-creative";

// One creative often runs as two Meta ads: the post (feed, square or 4:5) and the story (9:16), named alike ("Image 3 -
// Feed", "Image 3 - Story"). The team counts that as one creative, so the client page shows them as one: the post's
// preview, with spend and results added up.

const PLACEMENT = /\b(?:stor(?:y|ies)|feeds?|posts?|reels?|square|vertical|9\s*[:x]\s*16|4\s*[:x]\s*5|1\s*[:x]\s*1)\b/gi;
const STORY = /\b(?:stor(?:y|ies)|reels?|vertical|9\s*[:x]\s*16)\b/i;

/** The ad's name without its placement words, or null when it names no placement (then it stands alone). */
export function placementKey(name: string) {
  if (!name.match(PLACEMENT)) return null;
  const key = name.replace(PLACEMENT, " ").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return key || null;
}

/** Story and post versions of the same ad as one creative, in the order they came (by spend). */
export function mergePlacements(ads: MetaRow[]): MetaRow[] {
  const groups = new Map<string, MetaRow[]>();
  for (const a of ads) {
    const key = placementKey(a.name) ?? `id:${a.id}`;
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  return [...groups.values()].map((list) => {
    if (list.length === 1) return list[0];
    // The post leads (its square or 4:5 preview); the story only when there's nothing else
    const lead = list.find((a) => !STORY.test(a.name)) ?? list[0];
    const spend = list.reduce((s, a) => s + a.spend, 0);
    const results = list.reduce((s, a) => s + a.results, 0);
    return {
      ...lead,
      thumbnail: lead.thumbnail ?? list.find((a) => a.thumbnail)?.thumbnail ?? null,
      headline: lead.headline ?? list.find((a) => a.headline)?.headline ?? null,
      text: lead.text ?? list.find((a) => a.text)?.text ?? null,
      spend: Math.round(spend * 100) / 100,
      results,
      costPerResult: results > 0 ? Math.round((spend / results) * 100) / 100 : null,
      ctr: spend > 0 ? list.reduce((s, a) => s + a.ctr * a.spend, 0) / spend : lead.ctr,
    };
  });
}
