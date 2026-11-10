// The TikTok account audit's plain parts, kept apart from the database and the AI so they're tested: which agent writes
// it (the TikTok auditor once the Head of Meta brings the TikTok Ads Buyer online, the Meta auditor with TikTok framing
// until then), the account's 90 days in words (by window, week, campaign, ad group and ad, with each ad's hook rate and
// whether it's tiring), the live state of its ads, and the link that opens the account in TikTok Ads Manager. TikTok
// is read only: every move an audit writes is a checklist for the buyer to make in TikTok Ads Manager.

const DAY = 86_400_000;

// ─── Who writes it ─────────────────────────────────────────────────────────

/** The TikTok audit's agent: tiktok_auditor once its role is online, the Meta auditor (with TikTok framing) until then */
export function tiktokAuditAgent(tiktokOffline: boolean): "tiktok_auditor" | "auditor" {
  return tiktokOffline ? "auditor" : "tiktok_auditor";
}

/** What the auditor is told about TikTok, on top of the audit's own rules (the same for both agents) */
export const TIKTOK_FRAMING = `This is a TikTok ad account, not Meta. Judge it the way a senior TikTok buyer would:
- Creative first. TikTok is won or lost on the first seconds: the hook rate (6-second views over impressions) and the 2-second rate are the creative's report card. Compare each ad's hook rate with the account's; a hook rate that falls week over week while frequency climbs is creative fatigue, and TikTok creative tires in days to a couple of weeks, far faster than Meta. Native, vertical, sound-on, creator-style video beats polished ads; say which hooks and formats win here.
- Frequency: TikTok audiences saturate quickly. Daily frequency creeping past about 1.5 to 2 with a falling hook rate and rising CPA means refresh the creative, not the budget.
- CPA (or ROAS) against the target, by campaign, ad group and ad, with the spend behind it. Don't call a result on a handful of conversions.
- Structure: campaigns and ad groups (TikTok's ad sets), the optimization event each ad group optimizes for, too many ad groups splitting a small budget, ad groups stuck learning or limited, Smart+ or automated campaigns versus manual ones, and budgets too small to exit learning (roughly 50 conversions a week per ad group).
- Delivery and tracking: rejected or limited ads, TikTok's own diagnosis of each ad group, and whether the pixel's events are firing (a purchase or lead event that stopped firing makes every number lie).
TikTok is read only in Kaizen Ads: nothing can be changed in TikTok from here. Every action is a checklist the buyer works through in TikTok Ads Manager, step by step, naming the campaign, ad group or ad. Call ad sets "ad groups". Never suggest Meta-only features (Advantage+, Conversions API on Meta, Ads Manager on Facebook).`;

// ─── TikTok Ads Manager ───────────────────────────────────────────────────

/**
 * The account in TikTok Ads Manager. TikTok has no stable public deep links to one campaign, ad group or ad, so every
 * object opens the account's campaign list (the buyer finds it by the name shown next to the link).
 */
export function tiktokManagerLink(advertiserId: string | null | undefined): string {
  const id = String(advertiserId ?? "").replace(/\D/g, "");
  return id ? `https://ads.tiktok.com/i18n/perf/campaign?aadvid=${id}` : "https://ads.tiktok.com/i18n/perf/campaign";
}

// ─── The numbers ───────────────────────────────────────────────────────────

/** One ad's day, as tiktok_ad_daily keeps it */
export type TikTokAuditRow = {
  date: string;
  ad_id: string;
  ad_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  adgroup_id: string | null;
  adgroup_name: string | null;
  spend: number | string | null;
  impressions: number | string | null;
  clicks: number | string | null;
  conversions: number | string | null;
  purchases: number | string | null;
  conversion_value: number | string | null;
  video_2s: number | string | null;
  video_6s: number | string | null;
  frequency: number | string | null;
};

const n = (v: unknown) => Number(v) || 0;
const r2 = (x: number | null) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const pct = (a: number, b: number) => (b > 0 ? r2((a / b) * 100) : null);

/** What a TikTok KPI counts, from its card's conversion key */
export function tiktokCounts(conversion: string | null | undefined): { roas: boolean; result: "conversions" | "purchases" | "clicks"; label: string } {
  if (conversion === "tiktok_roas") return { roas: true, result: "purchases", label: "purchase" };
  if (conversion === "tiktok_purchases") return { roas: false, result: "purchases", label: "purchase" };
  if (conversion === "tiktok_clicks") return { roas: false, result: "clicks", label: "click" };
  return { roas: false, result: "conversions", label: "conversion" };
}

export type TikTokStats = {
  spend: number;
  impressions: number;
  clicks: number;
  results: number;
  purchases: number;
  value: number;
  /** The KPI: cost per result, or ROAS */
  kpi: number | null;
  ctr: number | null;
  cpm: number | null;
  hook: number | null;
  hold2: number | null;
  freq: number | null;
  roas: number | null;
};

/** Everything worth knowing about a set of rows, against the KPI */
export function tiktokStats(rows: readonly TikTokAuditRow[], conversion: string | null | undefined): TikTokStats {
  const c = tiktokCounts(conversion);
  let spend = 0;
  let impressions = 0;
  let clicks = 0;
  let conversions = 0;
  let purchases = 0;
  let value = 0;
  let v2 = 0;
  let v6 = 0;
  let freqW = 0;
  for (const r of rows) {
    const imp = n(r.impressions);
    spend += n(r.spend);
    impressions += imp;
    clicks += n(r.clicks);
    conversions += n(r.conversions);
    purchases += n(r.purchases);
    value += n(r.conversion_value);
    v2 += n(r.video_2s);
    v6 += n(r.video_6s);
    freqW += n(r.frequency) * imp;
  }
  const results = c.result === "purchases" ? purchases : c.result === "clicks" ? clicks : conversions;
  const kpi = c.roas ? (spend > 0 ? r2(value / spend) : null) : results > 0 ? r2(spend / results) : null;
  return {
    spend: r2(spend) ?? 0,
    impressions,
    clicks,
    results: Math.round(results * 10) / 10,
    purchases: Math.round(purchases * 10) / 10,
    value: r2(value) ?? 0,
    kpi,
    ctr: pct(clicks, impressions),
    cpm: impressions > 0 ? r2((spend / impressions) * 1000) : null,
    hook: pct(v6, impressions),
    hold2: pct(v2, impressions),
    freq: impressions > 0 && freqW > 0 ? r2(freqW / impressions) : null,
    roas: spend > 0 && value > 0 ? r2(value / spend) : null,
  };
}

/** One line of stats, for the auditor */
export function statsLine(name: string, s: TikTokStats, conversion: string | null | undefined, extra = "") {
  const c = tiktokCounts(conversion);
  const kpi = s.kpi == null ? "no results" : c.roas ? `${s.kpi}x ROAS` : `$${s.kpi} per ${c.label}`;
  return `${name}: $${Math.round(s.spend)} spend, ${s.results} ${c.label}s, ${kpi}${!c.roas && s.purchases && c.result !== "purchases" ? `, ${s.purchases} purchases` : ""}${s.roas != null && !c.roas ? ` (ROAS ${s.roas}x)` : ""}, CTR ${s.ctr ?? "?"}%, CPM $${s.cpm ?? "?"}, hook rate ${s.hook ?? "?"}% (2s ${s.hold2 ?? "?"}%)${s.freq ? `, daily freq ~${s.freq}` : ""}${extra}`;
}

export type FatigueSignal = { adId: string; name: string; why: string };

/**
 * TikTok creative tiring, read from the ad's own days: its hook rate down 20%+ from the week before, or its cost per
 * result up 30%+, with daily frequency rising or past 2. Only ads that spent enough in both weeks to judge ($30+).
 */
export function tiktokFatigue(rows: readonly TikTokAuditRow[], conversion: string | null | undefined, today: string): FatigueSignal[] {
  const since = (d: number) => new Date(Date.parse(today) - d * DAY).toISOString().slice(0, 10);
  const byAd = new Map<string, TikTokAuditRow[]>();
  for (const r of rows) byAd.set(r.ad_id, [...(byAd.get(r.ad_id) ?? []), r]);
  const c = tiktokCounts(conversion);
  const out: (FatigueSignal & { spend: number })[] = [];
  for (const [id, list] of byAd) {
    const last = tiktokStats(list.filter((r) => r.date > since(7) && r.date <= today), conversion);
    const prev = tiktokStats(list.filter((r) => r.date > since(14) && r.date <= since(7)), conversion);
    if (last.spend < 30 || prev.spend < 30) continue;
    const why: string[] = [];
    if (last.hook != null && prev.hook != null && prev.hook > 0 && last.hook <= prev.hook * 0.8) why.push(`hook rate ${prev.hook}% → ${last.hook}%`);
    if (!c.roas && last.kpi != null && prev.kpi != null && last.kpi >= prev.kpi * 1.3) why.push(`$${prev.kpi} → $${last.kpi} per ${c.label}`);
    if (c.roas && last.kpi != null && prev.kpi != null && last.kpi <= prev.kpi * 0.7) why.push(`ROAS ${prev.kpi}x → ${last.kpi}x`);
    if (!why.length) continue;
    const freqUp = last.freq != null && (last.freq >= 2 || (prev.freq != null && last.freq > prev.freq * 1.15));
    if (freqUp) why.push(`daily frequency ${prev.freq ?? "?"} → ${last.freq}`);
    // A falling hook with frequency climbing, or both the hook and the cost turning: that's fatigue, not a bad day
    if (why.length < 2) continue;
    out.push({ adId: id, name: list[list.length - 1].ad_name ?? id, why: why.join(", "), spend: last.spend });
  }
  return out.sort((a, b) => b.spend - a.spend).map(({ adId, name, why }) => ({ adId, name, why }));
}

/** The account's 90 days in words for the auditor: windows, weeks, campaigns, ad groups, ads, and the tiring ones */
export function tiktokDigest(rows: readonly TikTokAuditRow[], conversion: string | null | undefined, today: string) {
  const since = (d: number) => new Date(Date.parse(today) - d * DAY).toISOString().slice(0, 10);
  const inRange = (from: number, to: number) => rows.filter((r) => r.date > since(from) && r.date <= since(to));
  const st = (rs: readonly TikTokAuditRow[]) => tiktokStats(rs, conversion);
  const line = (name: string, rs: readonly TikTokAuditRow[], extra = "") => statsLine(name, st(rs), conversion, extra);
  const last14 = inRange(14, 0);
  const prev14 = inRange(28, 14);
  const last30 = inRange(30, 0);
  const prev30 = inRange(60, 30);
  const out: string[] = ["ACCOUNT (TikTok)"];
  out.push(line("Last 14 days", last14), line("The 14 before", prev14), line("Last 30 days", last30), line("The 30 before", prev30), line("Last 90 days", inRange(90, 0)));
  const av = st(last30);
  out.push(`Account averages, last 30 days (what "high" and "low" mean here): CPM $${av.cpm ?? "?"}, CTR ${av.ctr ?? "?"}%, hook rate ${av.hook ?? "?"}%, 2-second rate ${av.hold2 ?? "?"}%, daily frequency ~${av.freq ?? "?"}.`);

  out.push("\nWEEK BY WEEK (newest first)");
  for (let w = 0; w < 12; w++) {
    const wk = inRange((w + 1) * 7, w * 7);
    if (wk.length) out.push(line(`Week ending ${since(w * 7)}`, wk));
  }

  const group = (rs: readonly TikTokAuditRow[], key: (r: TikTokAuditRow) => string | null) => {
    const m = new Map<string, TikTokAuditRow[]>();
    for (const r of rs) {
      const k = key(r);
      if (k) m.set(k, [...(m.get(k) ?? []), r]);
    }
    return [...m].sort((a, b) => st(b[1]).spend - st(a[1]).spend);
  };
  const total30 = av.spend || 1;
  const share = (rs: readonly TikTokAuditRow[]) => ` · ${Math.round((st(rs).spend / total30) * 100)}% of spend`;

  out.push("\nCAMPAIGNS, last 30 days vs the 30 before");
  const prevCamp = new Map(group(prev30, (r) => r.campaign_name ?? r.campaign_id));
  for (const [name, rs] of group(last30, (r) => r.campaign_name ?? r.campaign_id).slice(0, 15)) {
    const p = prevCamp.get(name);
    out.push(line(name, rs, `${share(rs)}${p ? ` · before: ${st(p).kpi ?? "no results"}` : " · new"}`));
  }

  out.push("\nAD GROUPS, last 30 days");
  for (const [name, rs] of group(last30, (r) => (r.adgroup_name ?? r.adgroup_id ? `${r.campaign_name ?? r.campaign_id ?? "?"} › ${r.adgroup_name ?? r.adgroup_id}` : null)).slice(0, 20)) out.push(line(name, rs, share(rs)));

  const firstSeen = new Map<string, string>();
  for (const r of rows) if (n(r.spend) > 0 && (!firstSeen.has(r.ad_id) || r.date < firstSeen.get(r.ad_id)!)) firstSeen.set(r.ad_id, r.date);
  const ads = group(last30, (r) => r.ad_id);
  const age = (id: string) => Math.round((Date.parse(today) - Date.parse(firstSeen.get(id) ?? today)) / DAY);
  const top3 = ads.slice(0, 3).reduce((x, [, rs]) => x + st(rs).spend, 0);
  out.push(`\nADS, last 30 days: ${ads.length} ads spent; the top 3 took ${Math.round((top3 / total30) * 100)}% of spend; ${ads.filter(([id]) => age(id) <= 30).length} launched in the last 30 days`);
  for (const [id, rs] of ads.slice(0, 30)) {
    const s7 = st(rs.filter((r) => r.date > since(7)));
    out.push(line(`${rs[rs.length - 1].ad_name ?? id} [${id}] (${age(id)} days old)`, rs, `${share(rs)} · last 7: $${Math.round(s7.spend)}, ${s7.kpi ?? "no results"}, hook ${s7.hook ?? "?"}%`));
  }
  const burners = ads.filter(([, rs]) => st(rs).results === 0 && st(rs).spend > 0).slice(0, 8);
  if (burners.length) out.push(`Spent with no results: ${burners.map(([id, rs]) => `${rs[rs.length - 1].ad_name ?? id} $${Math.round(st(rs).spend)}`).join("; ")}`);

  const fatigue = tiktokFatigue(rows, conversion, today);
  out.push(`\nTIRING ADS (hook rate or cost turning week over week, with frequency): ${fatigue.length ? "" : "none found"}`);
  for (const f of fatigue.slice(0, 12)) out.push(`- ${f.name} [${f.adId}]: ${f.why}`);

  return {
    text: out.join("\n"),
    ads: ads.length,
    days: new Set(rows.map((r) => r.date)).size,
    campaigns: new Set(rows.map((r) => r.campaign_id).filter(Boolean)).size,
    adgroups: new Set(rows.map((r) => r.adgroup_id).filter(Boolean)).size,
    last14: st(last14).kpi,
    prev14: st(prev14).kpi,
    fatigue,
    hook: av.hook,
  };
}

// ─── The ads as they stand ─────────────────────────────────────────────────

export type TikTokAdState = { ad_id: string; ad_name: string | null; campaign_id: string | null; adgroup_id: string | null; status: string | null; secondary_status: string | null; call_to_action?: string | null };

/** Whether TikTok rejected an ad (its review status) */
export const isRejected = (secondary: string | null | undefined) => /NOT_PASS|REJECT|DISAPPROV/i.test(String(secondary ?? ""));

/** The ads' live state in words: how many are on, off, rejected or in review, and the rejected ones by name */
export function adStateText(ads: readonly TikTokAdState[], campaignName: (id: string | null) => string | null = () => null): string {
  if (!ads.length) return "Ads: none read from TikTok yet.";
  const on = ads.filter((a) => /^(ENABLE|ACTIVE)$/i.test(String(a.status ?? "")));
  const rejected = ads.filter((a) => isRejected(a.secondary_status));
  const review = ads.filter((a) => /REVIEW|AUDIT/i.test(String(a.secondary_status ?? "")) && !isRejected(a.secondary_status));
  const lines = [`Ads: ${ads.length} in the account, ${on.length} switched on, ${rejected.length} rejected, ${review.length} in review.`];
  for (const a of rejected.slice(0, 10)) lines.push(`- Rejected: ${a.ad_name ?? a.ad_id}${campaignName(a.campaign_id) ? ` (campaign ${campaignName(a.campaign_id)})` : ""} [${String(a.secondary_status).toLowerCase().replace(/_/g, " ")}]`);
  return lines.join("\n");
}

// ─── Sprints: what changed in TikTok between two reads ────────────────────

/** A TikTok account as a sprint keeps it between checks: each ad's status (TikTok has no change history API for us) */
export type TikTokSetup = { platform: "tiktok"; ads: { id: string; name: string | null; status: string | null; secondary: string | null }[] };

export function tiktokSetupChanges(before: TikTokSetup | null | undefined, now: TikTokSetup | null | undefined): string[] {
  if (!before?.ads || !now?.ads) return [];
  const was = new Map(before.ads.map((a) => [a.id, a]));
  const out: string[] = [];
  let added = 0;
  for (const a of now.ads) {
    const b = was.get(a.id);
    if (!b) {
      added++;
      if (added <= 8) out.push(`New ad "${a.name ?? a.id}" (${String(a.status ?? "?").toLowerCase()})`);
      continue;
    }
    if (b.status !== a.status) out.push(`Ad "${a.name ?? a.id}" went from ${String(b.status ?? "?").toLowerCase()} to ${String(a.status ?? "?").toLowerCase()}`);
    if (!isRejected(b.secondary) && isRejected(a.secondary)) out.push(`Ad "${a.name ?? a.id}" was rejected by TikTok`);
  }
  if (added > 8) out.push(`${added - 8} more new ads`);
  for (const b of before.ads) if (!now.ads.some((a) => a.id === b.id)) out.push(`Ad "${b.name ?? b.id}" is gone (deleted)`);
  return out;
}
