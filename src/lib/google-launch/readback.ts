// After a Google launch is deployed: what Google really has, read back by querying the campaign's own children (ad
// groups, keywords, ads, locations, negatives, budget, extensions), never by trusting the resource names the mutate
// returned. Each line of the plan is ok only when it's found; what isn't is said plainly ("3 ad groups found, 0 ads:
// Google didn't keep the ads") and can be added into the same campaign in one click (missingPlan). Pure: the server,
// the card and the tests (tests/google-readback.test.ts) agree.

import { kwKey, type GooglePlan, type GAdGroup } from "./core";

export type FoundCampaign = { id: string; name: string; status: string; budget: number | null };
export type FoundAdGroup = { id: string; campaignId: string; name: string; status: string };
export type FoundKeyword = { adGroupId: string; text: string; match: string; negative: boolean; status: string };
export type FoundAd = { adGroupId: string; status: string; headlines: string[]; descriptions: string[] };
export type FoundCriterion = { campaignId: string; kind: string; negative: boolean; geo: string | null; text: string | null; match: string | null };
export type FoundAsset = { campaignId: string; fieldType: string };
/** Everything Google has under the launch's campaigns */
export type Found = { campaigns: FoundCampaign[]; adGroups: FoundAdGroup[]; keywords: FoundKeyword[]; ads: FoundAd[]; criteria: FoundCriterion[]; assets: FoundAsset[] };

export type QaLine = { key: string; ok: boolean; diffs: string[]; link: string | null };
export type ReadBack = {
  lines: QaLine[];
  /** One honest sentence for the card and the chat */
  summary: string;
  /** The plan lines Google doesn't have */
  missing: string[];
  counts: { adGroups: [number, number]; keywords: [number, number]; ads: [number, number]; places: [number, number] };
  /** The campaign and ad group ids found, by the plan's keys */
  ids: Record<string, string>;
};

const idOf = (res: string | null | undefined, kind: string) => res?.match(new RegExp(`/${kind}/(\\d+)`))?.[1] ?? null;
const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Each line of the plan against what Google has. `made`: the resource names the deploy got back by line (only used to
 * know which campaign and ad group ids to look under: a line is ok only when the query finds it).
 */
export function compareReadBack(plan: GooglePlan, made: Map<string, string>, found: Found): ReadBack {
  const lines: QaLine[] = [];
  const ids: Record<string, string> = {};
  const missing: string[] = [];
  const counts: ReadBack["counts"] = { adGroups: [0, 0], keywords: [0, 0], ads: [0, 0], places: [0, 0] };
  const line = (key: string, ok: boolean, diffs: string[] = []) => {
    lines.push({ key, ok: ok && !diffs.length, diffs: ok ? diffs : diffs.length ? diffs : ["not found in Google Ads"], link: null });
    if (!ok) missing.push(key);
  };
  for (const c of plan.campaigns) {
    const cid = c.existingId ?? idOf(made.get(`campaign:${c.key}`), "campaigns");
    const camp = cid ? found.campaigns.find((x) => x.id === cid) : (found.campaigns.find((x) => norm(x.name) === norm(c.name)) ?? null);
    if (camp) ids[`campaign:${c.key}`] = camp.id;
    const campId = camp?.id ?? null;
    if (c.mode === "new") {
      if (c.type === "SEARCH") line(`budget:${c.key}`, Boolean(camp && camp.budget != null), camp && c.budget != null && camp.budget != null && Math.abs(camp.budget - c.budget) > 0.01 ? [`budget is $${camp.budget}/day instead of $${c.budget}`] : []);
      line(`campaign:${c.key}`, Boolean(camp), camp && camp.status !== "PAUSED" ? [`status is ${camp.status.toLowerCase()}`] : []);
    }
    const crit = found.criteria.filter((x) => x.campaignId === campId);
    if (c.mode === "new" || c.locations.length || c.excludedLocations?.length) {
      const inc = crit.filter((x) => x.kind === "LOCATION" && !x.negative).map((x) => x.geo);
      const exc = crit.filter((x) => x.kind === "LOCATION" && x.negative).map((x) => x.geo);
      const wantInc = c.locations.map((l) => l.geo);
      const wantExc = (c.excludedLocations ?? []).map((l) => l.geo);
      const lostInc = wantInc.filter((g) => !inc.includes(g));
      const lostExc = wantExc.filter((g) => !exc.includes(g));
      counts.places[0] += wantInc.length + wantExc.length - lostInc.length - lostExc.length;
      counts.places[1] += wantInc.length + wantExc.length;
      if (c.type === "SEARCH") {
        const diffs = [
          ...(lostInc.length ? [`${lostInc.length} of ${wantInc.length} place${wantInc.length === 1 ? "" : "s"} missing`] : []),
          ...(lostExc.length ? [`${lostExc.length} excluded place${lostExc.length === 1 ? "" : "s"} missing`] : []),
          ...(!wantInc.length && !inc.length ? ["no locations: it shows in every country"] : []),
        ];
        const ok = Boolean(camp) && !lostInc.length && !lostExc.length;
        line(`targeting:${c.key}`, ok, diffs);
      }
    }
    c.negatives.forEach((k, i) => line(`cneg:${c.key}:${i}`, crit.some((x) => x.kind === "KEYWORD" && x.negative && norm(x.text ?? "") === norm(k.text) && (x.match ?? k.match) === k.match)));
    const assets = found.assets.filter((x) => x.campaignId === campId);
    const nth = (type: string, i: number) => assets.filter((a) => a.fieldType === type).length > i;
    c.sitelinks.forEach((_, i) => line(`sitelink:${c.key}:${i}`, nth("SITELINK", i)));
    c.callouts.forEach((_, i) => line(`callout:${c.key}:${i}`, nth("CALLOUT", i)));
    c.snippets.forEach((_, i) => line(`snippet:${c.key}:${i}`, nth("STRUCTURED_SNIPPET", i)));
    if (c.revive) line(`revive:${c.key}`, Boolean(camp && camp.status === "ENABLED"), camp && camp.status !== "ENABLED" ? [`status is ${camp.status.toLowerCase()}`] : []);
  }
  for (const g of plan.adGroups) {
    const campId = ids[`campaign:${g.campaignKey}`] ?? null;
    const gid = g.existingId ?? idOf(made.get(`adgroup:${g.key}`), "adGroups");
    const grp = found.adGroups.find((x) => x.id === gid) ?? found.adGroups.find((x) => x.campaignId === campId && norm(x.name) === norm(g.name)) ?? null;
    if (grp) ids[`adgroup:${g.key}`] = grp.id;
    counts.adGroups[1]++;
    if (grp) counts.adGroups[0]++;
    if (g.mode === "new") line(`adgroup:${g.key}`, Boolean(grp), grp && grp.status !== "PAUSED" ? [`status is ${grp.status.toLowerCase()}`] : []);
    const kws = found.keywords.filter((x) => x.adGroupId === grp?.id);
    const has = new Set(kws.filter((x) => !x.negative).map((x) => kwKey({ text: x.text, match: x.match as GAdGroup["keywords"][number]["match"] })));
    const negs = new Set(kws.filter((x) => x.negative).map((x) => kwKey({ text: x.text, match: x.match as GAdGroup["keywords"][number]["match"] })));
    g.keywords.forEach((k, i) => {
      const ok = has.has(kwKey(k));
      counts.keywords[1]++;
      if (ok) counts.keywords[0]++;
      line(`kw:${g.key}:${i}`, ok);
    });
    g.negatives.forEach((k, i) => line(`aneg:${g.key}:${i}`, negs.has(kwKey(k))));
    const ads = found.ads.filter((x) => x.adGroupId === grp?.id);
    const used = new Set<number>();
    for (const r of g.rsas) {
      const want = new Set(r.headlines.map((h) => norm(h.text)));
      // The ad with the most of this ad's headlines (each ad Google has is matched once)
      let best = -1;
      let score = 0;
      ads.forEach((a, j) => {
        if (used.has(j)) return;
        const s = a.headlines.filter((h) => want.has(norm(h))).length;
        if (s > score) [best, score] = [j, s];
      });
      counts.ads[1]++;
      if (best < 0) {
        line(`rsa:${g.key}:${r.key}`, false);
        continue;
      }
      used.add(best);
      counts.ads[0]++;
      const a = ads[best];
      const diffs = [
        ...(a.headlines.length !== r.headlines.length ? [`${a.headlines.length} headlines instead of ${r.headlines.length}`] : []),
        ...(a.descriptions.length !== r.descriptions.length ? [`${a.descriptions.length} descriptions instead of ${r.descriptions.length}`] : []),
        ...(a.status !== "PAUSED" ? [`status is ${a.status.toLowerCase()}`] : []),
      ];
      line(`rsa:${g.key}:${r.key}`, true, diffs);
    }
  }
  return { lines, summary: readBackSummary(counts, missing), missing, counts, ids };
}

/** "3 of 3 ad groups found, 20 of 20 keywords, 0 of 3 ads: Google didn't keep the ads." */
export function readBackSummary(c: ReadBack["counts"], missing: string[]) {
  const part = ([got, want]: [number, number], one: string, many = `${one}s`) => (want ? `${got} of ${want} ${want === 1 ? one : many}` : "");
  const head = [part(c.adGroups, "ad group"), part(c.keywords, "keyword"), part(c.ads, "ad"), part(c.places, "place")].filter(Boolean).join(", ");
  if (!missing.length) return `Read back from Google: ${head || "everything"} found, all paused. Turn them on in Google Ads when you're ready.`;
  const lost = [
    c.adGroups[0] < c.adGroups[1] ? "ad groups" : "",
    c.keywords[0] < c.keywords[1] ? "keywords" : "",
    c.ads[0] < c.ads[1] ? "ads" : "",
    c.places[0] < c.places[1] || missing.some((k) => k.startsWith("targeting:")) ? "locations" : "",
    missing.some((k) => /^(cneg|aneg):/.test(k)) ? "negatives" : "",
    missing.some((k) => /^(sitelink|callout|snippet):/.test(k)) ? "extensions" : "",
    missing.some((k) => /^(campaign|budget):/.test(k)) ? "the campaign" : "",
  ].filter(Boolean);
  const list = lost.length > 1 ? `${lost.slice(0, -1).join(", ")} and ${lost[lost.length - 1]}` : (lost[0] ?? "some lines");
  return `Read back from Google: ${head} found. Google didn't keep the ${list}.`;
}

/**
 * Only what Google doesn't have, as a plan into the same campaign: the campaign as it is (existing), its missing
 * places and negatives, ad groups that aren't there (whole) and, inside the ones that are, only their missing
 * keywords, negatives and ads. Null when nothing's missing.
 */
export function missingPlan(plan: GooglePlan, rb: Pick<ReadBack, "missing" | "ids">): GooglePlan | null {
  const miss = new Set(rb.missing);
  if (!miss.size) return null;
  const campaigns = plan.campaigns.map((c) => {
    const id = rb.ids[`campaign:${c.key}`] ?? c.existingId;
    // The campaign itself isn't there: it's planned whole again
    if (!id) return { ...c };
    const placesLost = miss.has(`targeting:${c.key}`);
    return {
      ...c,
      mode: "existing" as const,
      existingId: id,
      revive: false,
      budget: null,
      addPlaces: placesLost,
      locations: placesLost ? c.locations : [],
      excludedLocations: placesLost ? (c.excludedLocations ?? []) : [],
      negatives: c.negatives.filter((_, i) => miss.has(`cneg:${c.key}:${i}`)),
      sitelinks: c.sitelinks.filter((_, i) => miss.has(`sitelink:${c.key}:${i}`)),
      callouts: c.callouts.filter((_, i) => miss.has(`callout:${c.key}:${i}`)),
      snippets: c.snippets.filter((_, i) => miss.has(`snippet:${c.key}:${i}`)),
    };
  });
  const adGroups = plan.adGroups
    .map((g) => {
      const id = rb.ids[`adgroup:${g.key}`] ?? g.existingId;
      if (!id) return { ...g };
      return {
        ...g,
        mode: "existing" as const,
        existingId: id,
        keywords: g.keywords.filter((_, i) => miss.has(`kw:${g.key}:${i}`)),
        negatives: g.negatives.filter((_, i) => miss.has(`aneg:${g.key}:${i}`)),
        rsas: g.rsas.filter((r) => miss.has(`rsa:${g.key}:${r.key}`)),
      };
    })
    .filter((g) => g.mode === "new" || g.keywords.length || g.negatives.length || g.rsas.length);
  return { ...plan, campaigns, adGroups, assetGroups: [], note: "Only what Google didn't have after the deploy, added into the same campaign, paused." };
}
