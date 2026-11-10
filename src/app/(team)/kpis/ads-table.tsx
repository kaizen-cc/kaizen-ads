"use client";

import { useSearchParams } from "next/navigation";
import { money } from "@/lib/kpi/format";
import { HOLD_GOOD, HOOK_GOOD, TONE_CLASS, VIDEO_HELP, WATCH_GOOD, videoTone } from "@/lib/kpi/video";
import { adSortParam, nextAdSort, parseAdSort, sortAds, type AdSortKey } from "@/lib/kpi/ad-sort";
import type { KpiAds } from "./creative-actions";

// The KPI card's "Ads this week": every ad over the last 7 complete days with its spend, result, CTR and, on video,
// hook rate, hold rate and how much of the video people watch. Sortable by any column (the sort lives in the address,
// so back returns to it); a table on a computer, a card per ad on a phone.

const shortDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
type Ad = KpiAds["ads"][number];

export function AdsThisWeek({ a }: { a: KpiAds }) {
  const sp = useSearchParams();
  const sort = parseAdSort(sp.get("adsort"), a.roas);
  const setSort = (key: AdSortKey) => {
    const u = new URL(window.location.href);
    const v = adSortParam(nextAdSort(sort, key, a.roas), a.roas);
    if (v) u.searchParams.set("adsort", v);
    else u.searchParams.delete("adsort");
    if (u.href !== window.location.href) window.history.pushState(null, "", u);
  };
  const ads = sortAds(a.ads, sort);
  const anyVideo = a.ads.some((x) => x.plays > 0);
  const cols: { key: AdSortKey; label: string; help?: string }[] = [
    { key: "spend", label: "Spend" },
    { key: "results", label: a.result },
    { key: "cost", label: a.roas ? "ROAS" : "Cost per result" },
    { key: "ctr", label: "CTR (link)" },
    { key: "hook", label: "Hook rate", help: VIDEO_HELP.hook },
    { key: "hold", label: "Hold rate", help: VIDEO_HELP.hold },
    { key: "watch", label: "Watched", help: VIDEO_HELP.watch },
  ];
  const cost = (x: Ad) => (a.roas ? (x.value != null ? `${x.value.toFixed(2)}x` : "no sales") : x.value != null ? money(x.value) : "no results");
  const cell = (x: Ad, key: AdSortKey) => {
    if (key === "spend") return <span className="tabular">{money(x.spend)}</span>;
    if (key === "results") return <span className="tabular">{Math.round(x.results * 10) / 10}</span>;
    if (key === "cost") return <span className={`tabular ${x.value == null ? "text-faint" : ""}`}>{cost(x)}</span>;
    if (key === "ctr") return <span className="tabular">{x.ctr != null ? `${x.ctr}%` : "—"}</span>;
    const [v, good, approx] = key === "hook" ? [x.hookRate, HOOK_GOOD, false] : key === "hold" ? [x.holdRate, HOLD_GOOD, false] : [x.watchPct, WATCH_GOOD, x.watchEstimated];
    if (v == null) return <span className="text-faint">{x.plays ? "n/a" : "—"}</span>;
    const tone = videoTone(v, good);
    const tip = key === "watch" ? (approx ? VIDEO_HELP.estimate : x.avgWatchSec != null && x.videoSeconds ? `Watched ${x.avgWatchSec}s of ${x.videoSeconds}s on average.` : undefined) : undefined;
    return (
      <span title={tip} className={`tabular inline-flex rounded-full px-1.5 py-px text-[11px] font-medium ${tone ? TONE_CLASS[tone] : ""}`}>
        {approx ? "~" : ""}
        {v}%
      </span>
    );
  };
  const arrow = (key: AdSortKey) => (sort.key === key ? (sort.dir === "asc" ? "↑" : "↓") : "");
  const thumb = (x: Ad) =>
    x.thumbnail ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={x.thumbnail} alt="" loading="lazy" className="h-12 w-10 shrink-0 rounded-[8px] bg-surface-2 object-cover" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
    ) : (
      <span className="h-12 w-10 shrink-0 rounded-[8px] bg-surface-2" />
    );
  const grid = "md:grid md:grid-cols-[minmax(0,1fr)_repeat(7,minmax(64px,auto))] md:items-center md:gap-x-4";

  return (
    <section className="grid min-w-0 gap-3 rounded-[20px] border border-line bg-surface p-4 md:p-5">
      <div>
        <h2 className="font-heading text-[17px]">Ads this week</h2>
        <p className="mt-1 text-sm text-muted">
          {shortDay(a.from)} to {shortDay(a.to)}, complete days like Ads Manager. {a.result} counted as the card counts them.
          {anyVideo ? " Video ads add hook rate, hold rate and how much of the video people watch." : ""}
        </p>
      </div>
      {ads.length ? (
        <>
          {/* Sort: chips on a phone, the column headers on a computer */}
          <div className="flex flex-wrap gap-1.5 md:hidden" role="group" aria-label="Sort ads by">
            {cols.map((c) => (
              <button key={c.key} type="button" onClick={() => setSort(c.key)} aria-pressed={sort.key === c.key} className={`min-h-11 rounded-full border px-3 text-xs transition-colors ${sort.key === c.key ? "border-fg bg-fg text-bg" : "border-line text-muted"}`}>
                {c.label} {arrow(c.key)}
              </button>
            ))}
          </div>
          <div role="table" aria-label="Ads this week" className="grid min-w-0 gap-1.5">
            <div role="row" className={`hidden px-2.5 text-[11px] text-faint ${grid}`}>
              <span role="columnheader">Ad</span>
              {cols.map((c) => (
                <span key={c.key} role="columnheader" aria-sort={sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} className="text-right">
                  <button type="button" onClick={() => setSort(c.key)} title={c.help} className={`inline-flex items-center gap-1 whitespace-nowrap hover:text-fg ${sort.key === c.key ? "text-fg" : ""}`}>
                    {c.label}
                    <span aria-hidden className="w-2">
                      {arrow(c.key)}
                    </span>
                  </button>
                </span>
              ))}
            </div>
            {ads.map((x) => (
              <div key={x.id} role="row" className={`grid gap-2 rounded-[14px] bg-bg/50 p-2.5 ${grid}`}>
                <span role="cell" className="flex min-w-0 items-center gap-3">
                  {thumb(x)}
                  <span className="line-clamp-2 min-w-0 text-sm md:truncate" title={x.name}>
                    {x.name}
                  </span>
                </span>
                {/* Phone: the numbers as a labelled grid under the ad */}
                <span className="grid grid-cols-3 gap-x-3 gap-y-2 text-[11px] md:hidden">
                  {cols.map((c) => (
                    <span key={c.key} className="grid min-w-0 gap-0.5">
                      <span className="truncate text-faint">{c.label}</span>
                      <span className="text-fg">{cell(x, c.key)}</span>
                    </span>
                  ))}
                </span>
                {cols.map((c) => (
                  <span key={c.key} role="cell" className="hidden text-right text-[12px] md:block">
                    {cell(x, c.key)}
                  </span>
                ))}
              </div>
            ))}
          </div>
          <p className="text-[11px] leading-relaxed text-faint">
            See-more rate: n/a. {VIDEO_HELP.seeMore} Hook is 3-second views per impression, hold is ThruPlays per 3-second view; a ~ means watched is estimated from completion counts until the video&apos;s length is read.
          </p>
        </>
      ) : (
        <p className="text-sm text-faint">No ad spent in these days.</p>
      )}
    </section>
  );
}
