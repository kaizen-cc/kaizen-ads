import "server-only";
import { clientNamed } from "@/lib/client-named";
import { createClient } from "@/lib/supabase/server";
import { seesAccountNumbers } from "@/lib/ai-access-core";
import { asRange, filterAds, freqBand, isLive, DEFAULT_FILTERS, type AdPlatform } from "@/lib/ad-library/core";
import { str, num, type AiTool } from "./types";

// "What ads are running for X": every ad in the client's Meta, Google or TikTok account over a window, the same list as
// the client page's Ads tab (registered in src/lib/kaizen-ai/extensions.ts). Read with the person's own session.

const runningAds: AiTool = {
  name: "running_ads",
  description:
    "Every ad running in a client's ad account (Meta, Google or TikTok): name, campaign and ad set, status (active, learning, learning limited, paused, rejected), spend, results and cost per result (or ROAS) against the client's KPI target, CTR, CPM, frequency with our bands (under 1.25 TOF, 1.25-2 MOF, over 2 BOF), days running, and the fatigue flag with why when it's tiring. days: 7, 14 or 30 (default 7). status: live (default), recent (live or spent in the window) or all. tiring: true for the tiring ones only. Biggest spend first. open_screen the 'page' it returns to show it (the client's Ads tab).",
  input_schema: { type: "object", properties: { client: { type: "string" }, platform: { type: "string", enum: ["meta", "google", "tiktok"] }, days: { type: "number", enum: [7, 14, 30] }, status: { type: "string", enum: ["live", "recent", "all"] }, tiring: { type: "boolean" }, search: { type: "string" } }, required: ["client"], additionalProperties: false },
  lines: ["ads"],
  run: async (user, input) => {
    if (!seesAccountNumbers(user)) return { ok: false, error: "Account numbers aren't part of your view." };
    const db = await createClient();
    let c: { id: string; name: string; slug: string };
    try {
      c = await clientNamed(db, str(input.client));
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Which client?" };
    }
    const platform = (str(input.platform) ?? "meta") as AdPlatform;
    const days = asRange(num(input.days) ?? 7);
    const { loadAds } = await import("@/lib/ad-library/load");
    const list = await loadAds(db, c.id, platform, days);
    const st = str(input.status);
    const ads = filterAds(list.ads, { ...DEFAULT_FILTERS, status: st === "all" ? "all" : st === "recent" ? "recent" : "active", tiring: input.tiring === true, q: str(input.search) ?? "" });
    const tab = platform === "meta" ? "meta" : platform;
    return {
      ok: true,
      client: c.name,
      platform,
      window: `${list.window.from} to ${list.window.to}`,
      kpi: list.target,
      live: list.ads.filter((a) => isLive(a.status)).length,
      tiring: list.ads.filter((a) => a.fatigue).length,
      note: list.note,
      page: `/clients/${c.slug}?service=${tab}&tab=ads${days !== 7 ? `&ads_days=${days}` : ""}`,
      ads: ads.slice(0, 40).map((a) => ({
        id: a.id,
        name: a.name,
        campaign: a.campaign,
        adSet: a.adset,
        status: a.status,
        format: a.format,
        spend: a.spend,
        results: a.results,
        [list.target?.roas ? "roas" : "costPerResult"]: a.cpr,
        ctr: a.ctr,
        cpm: a.cpm,
        frequency: a.frequency,
        frequencyBand: freqBand(a.frequency)?.label ?? null,
        daysRunning: a.daysRunning,
        fatigue: a.fatigue,
      })),
    };
  },
};

export const tools: AiTool[] = [runningAds];
