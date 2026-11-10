import type { Winner } from "@/lib/industry";
import type { WinnerSource } from "@/lib/suggestions";
import { resultLine } from "@/lib/tiktok/winners";

// A winning ad from the "Working for similar clients" picker (Meta's from the snapshot, or our own TikTok winners) as
// the brief source the strategist writes from, and the words its card shows. A TikTok winner carries platform
// "tiktok", its numbers and its landing page, so the brief is written as a TikTok ad (src/lib/suggestions.ts
// winningAdBlock) and its picture comes from the TikTok sync, never from Meta.

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 })}`;

export const isTikTokWinner = (w: Pick<Winner, "platform">) => w.platform === "tiktok";

/** A TikTok winner's numbers in one line: result against its target, the 6s view rate, spend and days */
export function tiktokMetricsLine(w: Winner): string {
  const vs = resultLine({ roas: Boolean(w.fame?.roas), value: w.costPerResult, target: w.usual, targetSource: w.fame?.basis ?? "kpi", conversion: w.result ?? "result" });
  return [vs, w.sixSecRate != null ? `6s view rate ${w.sixSecRate}%` : "", `${money(w.spend)} spent${w.fame?.days ? ` over ${w.fame.days} days` : ""}`].filter(Boolean).join(", ");
}

/** The brief source a picked winner becomes (TikTok's labelled, with its numbers and link) */
export function winnerSourceOf(w: Winner): WinnerSource {
  const base: WinnerSource = { adId: w.id, client: w.client, detail: w.detail, headline: w.headline, text: w.text, thumbnail: w.thumbnail, ratio: w.ratio, result: w.result, costPerResult: w.costPerResult, usual: w.usual };
  if (!isTikTokWinner(w)) return base;
  return { ...base, platform: "tiktok", metrics: tiktokMetricsLine(w), link: w.link ?? null, clientId: w.clientId ?? null };
}

/** The card's chip: how far past the bar ("2.1x their usual", or for TikTok "TikTok · 2.1x their target") */
export const winnerChip = (w: Winner) => (isTikTokWinner(w) ? `TikTok · ${w.ratio}x their ${w.fame?.basis === "benchmark" ? "benchmark" : "target"}` : `${w.ratio}x their usual`);

/** The card's foot line */
export const winnerFoot = (w: Winner) => (isTikTokWinner(w) ? tiktokMetricsLine(w) : w.result ? `Beat their usual cost per ${w.result}` : "");

/** A Meta ad id whose kept picture can be loaded (/api/ad-media/<id>); TikTok's pictures come with the winner instead */
export const winnerMetaAdId = (w: Pick<Winner, "id" | "platform">) => (isTikTokWinner(w) ? null : w.id);
