import { Section } from "@/components/ui";
import type { ClientTikTok } from "@/lib/tiktok/store";
import { isKeyEvent, type DiagnosisWarning, type TikTokDiagnostics } from "@/lib/tiktok/diagnostics-core";
import { tiktokManagerLink } from "@/lib/tiktok/audit-core";

// A client's TikTok over the last 30 days against the 30 before: spend, conversions and their cost, purchases and ROAS,
// CTR and CPM, and the hook rate (6-second views over impressions), then the campaigns and the top ads with their
// thumbnails. Read only: nothing is changed in TikTok from here.

const money = (n: number | null, cur = "USD") => (n == null ? "–" : `${cur === "USD" ? "$" : `${cur} `}${n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 })}`);
const pct = (n: number | null) => (n == null ? "–" : `${n.toFixed(2)}%`);
const delta = (now: number | null, before: number | null, lowerIsBetter: boolean) => {
  if (now == null || before == null || !before) return null;
  const d = (now - before) / before;
  if (Math.abs(d) < 0.01) return { text: "same as before", tone: "text-faint" };
  const better = lowerIsBetter ? d < 0 : d > 0;
  return { text: `${d > 0 ? "+" : ""}${Math.round(d * 100)}% vs before`, tone: better ? "text-ok" : "text-bad" };
};

const KIND: Record<DiagnosisWarning["kind"], { label: string; tone: string }> = {
  rejected: { label: "Rejected", tone: "bg-bad/12 text-bad" },
  learning: { label: "Learning", tone: "bg-warn/12 text-warn" },
  tracking: { label: "Tracking", tone: "bg-bad/12 text-bad" },
  budget: { label: "Budget or bid", tone: "bg-warn/12 text-warn" },
  creative: { label: "Creative", tone: "bg-surface-3 text-muted" },
  delivery: { label: "Delivery", tone: "bg-warn/12 text-warn" },
  other: { label: "Note", tone: "bg-surface-3 text-muted" },
};
const ORDER: DiagnosisWarning["kind"][] = ["tracking", "rejected", "learning", "budget", "delivery", "creative", "other"];

/** The pixels and whether their events fire, and what TikTok flags on the ad groups and ads (checked once a day) */
function Health({ d, advertiserId }: { d: TikTokDiagnostics | null; advertiserId: string | null }) {
  if (!d) return null;
  const warnings = [...d.warnings].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  return (
    <Section title="Tracking and delivery" description={`The TikTok pixel's events over the last 7 days, and what TikTok flags on the ad groups and ads${d.checkedAt ? `, checked ${d.checkedAt.slice(0, 10)}` : ""}. Fix these in TikTok Ads Manager.`}>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="grid content-start gap-2 rounded-[14px] border border-line p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Pixels</p>
          {d.pixels.length ? (
            d.pixels.map((p) => {
              const counted = p.events.some((e) => e.count != null);
              const silent = p.events.filter((e) => e.count === 0 && isKeyEvent(e.name));
              return (
                <div key={p.id} className="grid gap-1.5">
                  <p className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="truncate">{p.name ?? p.id}</span>
                    {p.status && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10.5px] text-muted">{p.status.toLowerCase().replace(/_/g, " ")}</span>}
                  </p>
                  <ul className="flex flex-wrap gap-1.5">
                    {p.events.slice(0, 12).map((e) => (
                      <li key={e.name} className={`tabular rounded-full px-2.5 py-1 text-[11.5px] ${e.count ? "bg-ok/12 text-ok" : counted && isKeyEvent(e.name) ? "bg-bad/12 text-bad" : "bg-surface-2 text-muted"}`}>
                        {e.name.replace(/_/g, " ")}
                        {e.count != null ? ` · ${e.count.toLocaleString("en-US")}` : ""}
                      </li>
                    ))}
                    {!p.events.length && <li className="text-xs text-faint">No events set up</li>}
                  </ul>
                  {silent.length > 0 && <p className="text-xs text-bad">Nothing in 7 days from {silent.map((e) => e.name.replace(/_/g, " ")).join(", ")}: check the pixel on the site.</p>}
                </div>
              );
            })
          ) : (
            <p className="text-sm text-bad">No TikTok pixel on this ad account: conversions can&apos;t be tracked or optimized for.</p>
          )}
        </div>
        <div className="grid content-start gap-2 rounded-[14px] border border-line p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">What TikTok flags</p>
          {warnings.length ? (
            <ul className="grid gap-2">
              {warnings.slice(0, 12).map((w, i) => (
                <li key={`${w.id}-${i}`} className="grid gap-1">
                  <span className="flex flex-wrap items-center gap-2 text-[11px]">
                    <span className={`rounded-full px-2 py-0.5 ${KIND[w.kind].tone}`}>{KIND[w.kind].label}</span>
                    {w.level !== "account" && <span className="truncate text-faint">{w.level === "adgroup" ? "Ad group" : "Ad"} {w.name ?? w.id}</span>}
                  </span>
                  <span className="text-[13px] leading-snug text-muted">{w.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ok">Nothing flagged on the active ad groups.</p>
          )}
          {d.errors.length > 0 && <p className="text-[11px] text-faint">Some checks couldn&apos;t be read this time ({d.errors.map((e) => e.split(":")[0]).join(", ")}).</p>}
          <a href={tiktokManagerLink(advertiserId)} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center justify-self-start text-xs text-muted hover:text-fg md:min-h-0">
            Open in TikTok Ads Manager ↗
          </a>
        </div>
      </div>
    </Section>
  );
}

export function TikTokPanel({ t }: { t: ClientTikTok }) {
  const cur = t.accounts[0]?.currency ?? "USD";
  const tiles: { k: string; v: string; d: ReturnType<typeof delta> }[] = [
    { k: "Spend", v: money(t.now.spend, cur), d: delta(t.now.spend, t.before.spend, false) },
    { k: "Conversions", v: t.now.conversions.toLocaleString("en-US", { maximumFractionDigits: 1 }), d: delta(t.now.conversions, t.before.conversions, false) },
    { k: "Cost per conversion", v: money(t.now.cpa, cur), d: delta(t.now.cpa, t.before.cpa, true) },
    ...(t.now.purchases || t.before.purchases ? [{ k: "Purchases · ROAS", v: `${t.now.purchases.toLocaleString("en-US", { maximumFractionDigits: 1 })} · ${t.now.roas == null ? "–" : `${t.now.roas.toFixed(2)}x`}`, d: delta(t.now.roas, t.before.roas, false) }] : []),
    { k: "CTR", v: pct(t.now.ctr), d: delta(t.now.ctr, t.before.ctr, false) },
    { k: "CPM", v: money(t.now.cpm, cur), d: delta(t.now.cpm, t.before.cpm, true) },
    { k: "6-second views", v: t.now.views6s.toLocaleString("en-US"), d: delta(t.now.views6s, t.before.views6s, false) },
    { k: "Hook rate", v: pct(t.now.hookRate), d: delta(t.now.hookRate, t.before.hookRate, false) },
  ];
  return (
    <div className="grid gap-6">
      <Section title="TikTok, last 30 days" description={`Against the 30 days before${t.dataThrough ? `, through ${t.dataThrough}` : ""}. Hook rate: 6-second views over impressions. Read only: changes are made in TikTok Ads Manager.`}>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {tiles.map((s) => (
            <div key={s.k} className="grid min-w-0 gap-0.5 rounded-[12px] bg-surface-2/70 px-3.5 py-3">
              <span className="text-[11px] text-faint">{s.k}</span>
              <span className="tabular truncate font-display text-xl leading-tight">{s.v}</span>
              {s.d && <span className={`text-[11px] ${s.d.tone}`}>{s.d.text}</span>}
            </div>
          ))}
        </div>
      </Section>

      <Health d={t.diagnostics} advertiserId={t.accounts[0]?.id ?? null} />

      <Section title="TikTok campaigns" description="Last 30 days, biggest spend first. Conversions are each campaign's own optimization event.">
        {t.campaigns.length ? (
          <ul className="grid divide-y divide-line overflow-hidden rounded-[14px] border border-line">
            {t.campaigns.slice(0, 20).map((c) => (
              <li key={c.id} className="grid gap-1.5 px-4 py-3 md:grid-cols-[minmax(0,1fr)_repeat(4,88px)] md:items-center md:gap-3">
                <span className="min-w-0 truncate text-sm">{c.name}</span>
                <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted md:contents">
                  <span className="tabular md:text-right">{money(c.spend, cur)}</span>
                  <span className="tabular md:text-right">{c.conversions.toLocaleString("en-US", { maximumFractionDigits: 1 })} conv.</span>
                  <span className="tabular md:text-right">{money(c.cpa, cur)} each</span>
                  <span className="tabular md:text-right">hook {pct(c.hookRate)}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-faint">No TikTok campaign spent in the last 30 days.</p>
        )}
      </Section>

      <Section title="Top TikTok ads" description="The most conversions in the last 30 days, then the cheapest.">
        {t.topAds.length ? (
          <ul className="grid grid-cols-2 gap-3 md:grid-cols-3">
            {t.topAds.map((a) => (
              <li key={a.id} className="grid min-w-0 content-start gap-2 overflow-hidden rounded-[14px] border border-line bg-surface">
                <div className="relative aspect-[9/16] max-h-72 w-full bg-surface-2">
                  {a.thumbnail ? (
                    // TikTok's own CDN; its URLs expire, so they're shown as they are rather than through the image optimizer
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={a.thumbnail} alt={a.name} loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
                  ) : (
                    <span className="absolute inset-0 grid place-items-center text-xs text-faint">No thumbnail</span>
                  )}
                  {a.status && <span className="absolute left-2 top-2 rounded-full bg-bg/80 px-2 py-0.5 text-[10.5px] text-muted backdrop-blur">{a.status.replace(/^(AD_STATUS_|ENABLE$)/, "").toLowerCase().replace(/_/g, " ") || "on"}</span>}
                </div>
                <div className="grid gap-1 px-3 pb-3">
                  <p className="line-clamp-2 text-[13px] leading-snug">{a.text || a.name}</p>
                  <p className="tabular text-[11.5px] text-muted">
                    {a.conversions.toLocaleString("en-US", { maximumFractionDigits: 1 })} conv. · {money(a.cpa, cur)} each
                  </p>
                  <p className="tabular text-[11px] text-faint">
                    {money(a.spend, cur)} · CTR {pct(a.ctr)} · hook {pct(a.hookRate)}
                    {a.cta ? ` · ${a.cta.toLowerCase().replace(/_/g, " ")}` : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-faint">No TikTok ad spent in the last 30 days.</p>
        )}
      </Section>
    </div>
  );
}
