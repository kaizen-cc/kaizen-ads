import { POOL_FORMAT, createBriefHref, freshIdea, nextBucket, resetsLabel, suggestIdea, type AllotmentGap, type BriefIdea } from "@/lib/creative-allotments";

// Allotment gaps and fresh-creative needs as Next for me rows (plain, tested). Types are kept local so this stays free of
// server imports; the shape matches NextItem in src/lib/next-for-me.ts.

type Item = {
  id: string;
  kind: "allotment";
  tone: "bad" | "warn" | "brand" | "ok";
  client: string;
  title: string;
  why: string;
  when: string | null;
  href: string;
  action: string;
  briefIdea: BriefIdea;
};
type Fresh = { clientId: string; client: string; slug: string; why: string; targetId: string };

/** At most this many of each, the most urgent first (the Overview's Creative allotments has the rest) */
const MAX = 8;

export const gapBriefIdea = (g: AllotmentGap): BriefIdea => {
  const s = suggestIdea(g);
  return { clientId: g.clientId, slug: g.slug, key: `allot-${g.clientId}-${g.pool}`, label: s.label, text: s.text, format: POOL_FORMAT[g.pool], kicker: "Creative allotment" };
};

export const freshBriefIdea = (f: Fresh): BriefIdea => {
  const s = freshIdea(f.client, f.why);
  return { clientId: f.clientId, slug: f.slug, key: `fresh-${f.targetId}`, label: s.label, text: s.text, format: null, kicker: "Needs fresh creative" };
};

export function allotmentNext(d: { gaps: readonly AllotmentGap[]; fresh: readonly Fresh[] }): { bucket: "now" | "watch"; item: Item }[] {
  const out: { bucket: "now" | "watch"; item: Item }[] = [];
  const counts = { now: 0, watch: 0 };
  for (const g of d.gaps) {
    const bucket = nextBucket(g);
    if (!bucket || counts[bucket] >= MAX) continue;
    counts[bucket]++;
    const idea = gapBriefIdea(g);
    out.push({
      bucket,
      item: {
        // Per cycle: cleared for the person for this cycle only
        id: `allot-${g.clientId}-${g.pool}-${g.resetsOn}`,
        kind: "allotment",
        tone: bucket === "now" ? (g.state === "nothing" ? "bad" : "warn") : "brand",
        client: g.client,
        title: g.line.replace(/ · resets .*$/, ""),
        why: `${g.detail} · ${g.pace}`,
        when: resetsLabel(g.resetsOn, g.daysLeft).replace(/^resets/, "Resets"),
        href: createBriefHref(g.slug, idea.format),
        action: "Create brief",
        briefIdea: idea,
      },
    });
  }
  for (const f of d.fresh.slice(0, MAX)) {
    const idea = freshBriefIdea(f);
    out.push({ bucket: "watch", item: { id: `fresh-${f.targetId}`, kind: "allotment", tone: "warn", client: f.client, title: "Needs fresh creative", why: `${f.why}: new hooks and visuals to bring it back`, when: null, href: createBriefHref(f.slug, null), action: "Create brief", briefIdea: idea } });
  }
  return out;
}
