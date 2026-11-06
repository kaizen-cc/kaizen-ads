import { inScope, type KpiScope } from "@/lib/kpi/scope";

// The Copy library, as plain functions: every primary text, headline and description that has run in a client's Meta
// ads (from the client playbook, one row per ad), and every Google headline, description, sitelink and callout (from
// the asset-level Google sync, with Google's own Best / Good / Low rating), with its numbers added up across the ads
// that used it, judged against the client's KPI on that platform (rule one: if it isn't profitable, it isn't working),
// badged and ranked. Shared by the library pages, Kaizen AI and the copywriters; tested in tests/copy-library.test.ts.

export type CopyPlatform = "meta" | "google";
export type CopyKind = "primary" | "headline" | "description" | "long_headline" | "sitelink" | "callout";
export type CopyBadge = "winner" | "solid" | "tired" | "unproven";

export const KIND_LABEL: Record<CopyKind, string> = { primary: "Primary text", headline: "Headline", description: "Description", long_headline: "Long headline", sitelink: "Sitelink", callout: "Callout" };
export const PLATFORM_LABEL: Record<CopyPlatform, string> = { meta: "Meta", google: "Google" };
export const BADGE_LABEL: Record<CopyBadge, string> = { winner: "Winner", solid: "Solid", tired: "Tired", unproven: "Not proven" };
/** Meta's limits the variations keep to (primary: what shows before "See more") */
export const COPY_LIMITS = { primary: 125, headline: 40, description: 30 } as const;
/** Google's limits: RSA headlines 30, descriptions 90, Performance Max long headlines 90, sitelinks and callouts 25 */
export const GOOGLE_LIMITS = { headline: 30, description: 90, long_headline: 90, sitelink: 25, callout: 25 } as const;
/** The hard limit for a kind of copy on a platform (null: Meta primary text, judged by its form) */
export function limitOf(platform: CopyPlatform, kind: CopyKind): number | null {
  if (platform === "google") return kind === "primary" ? null : GOOGLE_LIMITS[kind];
  return kind === "primary" ? null : kind === "headline" ? COPY_LIMITS.headline : kind === "description" ? COPY_LIMITS.description : null;
}

export type LedgerAd = {
  key: string; // the ad id
  clientId: string;
  detail: {
    text?: string;
    texts?: string[];
    headline?: string;
    headlines?: string[];
    description?: string;
    descriptions?: string[];
    angle?: string;
    avatar?: string;
    hook?: string;
    offer?: string;
    format?: string;
    campaign?: string;
    campaignId?: string;
  };
  spend: number;
  results: number;
  revenue: number;
  impressions: number;
  clicks: number;
  first_seen: string | null;
  last_seen: string | null;
  live: boolean;
};

export type ClientKpi = { roas: boolean; target: number | null; label: string; scope?: KpiScope | null };

export type CopyLine = {
  key: string;
  clientId: string;
  platform: CopyPlatform;
  kind: CopyKind;
  /** Google's rating of it among the ad's assets (BEST, GOOD, LOW…), Google only */
  label?: string | null;
  /** Where it's pinned in its RSA (HEADLINE_1…), Google only */
  pinned?: string | null;
  text: string;
  ads: number;
  adIds: string[]; // the biggest spenders first
  spend: number;
  results: number;
  revenue: number;
  impressions: number;
  clicks: number;
  ctr: number | null;
  cpa: number | null;
  roas: number | null;
  /** Against the KPI (the target, or the account's own average): 1.25 = 25% better */
  vsKpi: number | null;
  reference: number | null;
  days: number;
  firstSeen: string | null;
  lastSeen: string | null;
  live: boolean;
  angle: string | null;
  avatar: string | null;
  hook: string | null;
  offer: string | null;
  formats: string[];
  badge: CopyBadge;
  reason: string;
  score: number;
};

/** The words as compared: case, spacing and curly quotes don't make a different line */
export const normalize = (s: string) =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** A short stable key for a line (its platform, kind and words) */
export function lineKey(kind: CopyKind, text: string, platform: CopyPlatform = "meta") {
  const s = `${platform === "google" ? "g:" : ""}${kind}\u0001${normalize(text)}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return `${platform === "google" ? "g" : ""}${kind[0]}${(h >>> 0).toString(36)}${s.length.toString(36)}`;
}

/** Every line one ad ran, each once (a dynamic ad's rotating versions count for each of them) */
export function linesOf(d: LedgerAd["detail"]): { kind: CopyKind; text: string }[] {
  const out: { kind: CopyKind; text: string }[] = [];
  const seen = new Set<string>();
  const add = (kind: CopyKind, xs: (string | undefined)[]) => {
    for (const x of xs) {
      const t = x?.trim();
      if (!t || t.length < 2) continue;
      const k = `${kind}|${normalize(t)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ kind, text: t });
    }
  };
  add("primary", [d.text, ...(d.texts ?? [])]);
  add("headline", [d.headline, ...(d.headlines ?? [])]);
  add("description", [d.description, ...(d.descriptions ?? [])]);
  return out;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
const mostBySpend = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

/** Enough to judge: a few results (cost KPIs) or $100 spent (ROAS) */
export const proven = (l: Pick<CopyLine, "spend" | "results">, roas: boolean) => (roas ? l.spend >= 100 : l.results >= 3 && l.spend >= 30);

/** The badge: judged against the target (or the account's own average), tired when its ads are wearing out */
export function badgeOf(l: Pick<CopyLine, "spend" | "results" | "vsKpi" | "cpa" | "roas">, kpi: ClientKpi, fatigued: boolean): { badge: CopyBadge; reason: string } {
  const unit = kpi.label.replace(/s$/, "");
  const now = kpi.roas ? `${l.roas ?? 0}x ROAS` : l.cpa == null ? `no ${kpi.label}` : `$${l.cpa} per ${unit}`;
  if (!proven(l, kpi.roas)) return { badge: "unproven", reason: `Not enough to judge yet: $${Math.round(l.spend)} spent, ${Math.round(l.results)} ${kpi.label}` };
  const v = l.vsKpi ?? 0;
  const against = kpi.target != null ? "the target" : "the account's average";
  if (v >= 1) return fatigued ? { badge: "tired", reason: `Proven (${now}, beat ${against}) but its ads are wearing out: refresh it` } : { badge: "winner", reason: `${now}, ${Math.round((v - 1) * 100)}% better than ${against}` };
  if (v >= 0.8) return fatigued ? { badge: "tired", reason: `Close to ${against} (${now}) and its ads are wearing out` } : { badge: "solid", reason: `${now}, within ${Math.round((1 - v) * 100)}% of ${against}` };
  return { badge: "unproven", reason: `${now}, behind ${against}: hasn't proven itself` };
}

const ORDER: Record<CopyBadge, number> = { winner: 0, solid: 1, tired: 2, unproven: 3 };

/** Rank: winners, then solid, then tired, then the rest; within each, how far ahead weighted by how much it spent */
export function rankCopy(lines: CopyLine[]) {
  return [...lines].sort((a, b) => ORDER[a.badge] - ORDER[b.badge] || b.score - a.score || b.spend - a.spend);
}

/**
 * One client's lines, added up across the ads that ran them (only the KPI's campaigns when a scope is given). fatigued:
 * the ad ids the fatigue watcher has flagged.
 */
export function aggregateCopy(ads: LedgerAd[], kpi: ClientKpi, fatigued: Set<string> = new Set()): CopyLine[] {
  const kept = ads.filter((a) => !kpi.scope || inScope(kpi.scope, { id: a.detail.campaignId ?? null, name: a.detail.campaign ?? null }));
  // The account's own average, for clients without a target
  const spend = kept.reduce((s, a) => s + a.spend, 0);
  const results = kept.reduce((s, a) => s + a.results, 0);
  const revenue = kept.reduce((s, a) => s + a.revenue, 0);
  const average = kpi.roas ? (spend ? revenue / spend : null) : results ? spend / results : null;
  const reference = kpi.target ?? (average == null ? null : r2(average));

  type Acc = Omit<CopyLine, "ctr" | "cpa" | "roas" | "vsKpi" | "reference" | "days" | "angle" | "avatar" | "hook" | "offer" | "formats" | "badge" | "reason" | "score" | "adIds"> & {
    ids: Map<string, number>;
    angles: Map<string, number>;
    avatars: Map<string, number>;
    hooks: Map<string, number>;
    offers: Map<string, number>;
    fmt: Set<string>;
  };
  const by = new Map<string, Acc>();
  const bump = (m: Map<string, number>, v: string | undefined, w: number) => {
    const t = v?.trim();
    if (t) m.set(t, (m.get(t) ?? 0) + w + 0.001);
  };
  for (const a of kept) {
    for (const { kind, text } of linesOf(a.detail)) {
      const key = lineKey(kind, text);
      const l =
        by.get(key) ??
        ({ key, clientId: a.clientId, platform: "meta", kind, text, ads: 0, spend: 0, results: 0, revenue: 0, impressions: 0, clicks: 0, firstSeen: null, lastSeen: null, live: false, ids: new Map(), angles: new Map(), avatars: new Map(), hooks: new Map(), offers: new Map(), fmt: new Set() } as Acc);
      l.ads++;
      l.spend += a.spend;
      l.results += a.results;
      l.revenue += a.revenue;
      l.impressions += a.impressions;
      l.clicks += a.clicks;
      if (a.first_seen && (!l.firstSeen || a.first_seen < l.firstSeen)) l.firstSeen = a.first_seen;
      if (a.last_seen && (!l.lastSeen || a.last_seen > l.lastSeen)) l.lastSeen = a.last_seen;
      l.live ||= a.live;
      l.ids.set(a.key, a.spend);
      bump(l.angles, a.detail.angle, a.spend);
      bump(l.avatars, a.detail.avatar, a.spend);
      bump(l.hooks, a.detail.hook, a.spend);
      bump(l.offers, a.detail.offer, a.spend);
      if (a.detail.format) l.fmt.add(a.detail.format);
      by.set(key, l);
    }
  }
  return rankCopy(
    [...by.values()].map(({ ids, angles, avatars, hooks, offers, fmt, ...l }) => {
      const cpa = l.results ? r2(l.spend / l.results) : null;
      const roas = l.spend && l.revenue ? r2(l.revenue / l.spend) : null;
      const vsKpi = reference == null ? null : kpi.roas ? r2((roas ?? 0) / reference) : cpa ? r2(reference / cpa) : 0;
      const adIds = [...ids].sort((x, y) => y[1] - x[1]).map(([id]) => id);
      const base = {
        ...l,
        spend: r2(l.spend),
        results: Math.round(l.results * 10) / 10,
        revenue: r2(l.revenue),
        adIds,
        ctr: l.impressions ? Math.round((l.clicks / l.impressions) * 10000) / 100 : null,
        cpa,
        roas,
        vsKpi,
        reference,
        days: l.firstSeen && l.lastSeen ? dayDiff(l.firstSeen, l.lastSeen) + 1 : 0,
        angle: mostBySpend(angles),
        avatar: mostBySpend(avatars),
        hook: mostBySpend(hooks),
        offer: mostBySpend(offers),
        formats: [...fmt],
      };
      const { badge, reason } = badgeOf(base, kpi, adIds.some((id) => fatigued.has(id)));
      const score = badge === "unproven" ? Math.log10(base.spend + 10) / 10 : (vsKpi ?? 0) * Math.log10(base.spend + 10);
      return { ...base, badge, reason, score: r2(score) };
    }),
  );
}

/** One piece of Google copy as synced (google_copy_assets): per campaign and ad group, last 90 days */
export type GoogleAssetRow = {
  clientId: string;
  kind: CopyKind;
  text: string;
  label: string | null;
  pinned: string | null;
  campaignId: string | null;
  campaignName: string | null;
  adGroup: string | null;
  impressions: number;
  clicks: number;
  conversions: number;
  value: number;
  spend: number;
  syncedAt: string | null;
};

const LABEL_RANK = ["BEST", "GOOD", "LOW", "LEARNING", "PENDING", "UNKNOWN", "UNSPECIFIED"];

/**
 * A client's Google copy, added up across the ads, ad groups and campaigns that ran it (only the Google KPI's campaigns
 * when a scope is given), judged on the KPI like Meta copy; Google's own rating breaks the tie when the numbers are
 * thin (Best with conversions is solid; Low is never a winner).
 */
export function aggregateGoogleCopy(rows: GoogleAssetRow[], kpi: ClientKpi): CopyLine[] {
  const kept = rows.filter((r) => !kpi.scope || inScope(kpi.scope, { id: r.campaignId, name: r.campaignName }));
  const spend = kept.reduce((s, r) => s + r.spend, 0);
  const conv = kept.reduce((s, r) => s + r.conversions, 0);
  const value = kept.reduce((s, r) => s + r.value, 0);
  const average = kpi.roas ? (spend ? value / spend : null) : conv ? spend / conv : null;
  const reference = kpi.target ?? (average == null ? null : r2(average));
  const by = new Map<string, { rows: GoogleAssetRow[] }>();
  for (const r of kept) {
    const key = lineKey(r.kind, r.text, "google");
    (by.get(key) ?? by.set(key, { rows: [] }).get(key)!).rows.push(r);
  }
  return rankCopy(
    [...by].map(([key, { rows: rs }]) => {
      const t = rs.reduce((o, r) => ({ spend: o.spend + r.spend, results: o.results + r.conversions, revenue: o.revenue + r.value, impressions: o.impressions + r.impressions, clicks: o.clicks + r.clicks }), { spend: 0, results: 0, revenue: 0, impressions: 0, clicks: 0 });
      const label = rs.map((r) => r.label).filter((x): x is string => Boolean(x)).sort((x, y) => LABEL_RANK.indexOf(x) - LABEL_RANK.indexOf(y))[0] ?? null;
      const pinned = rs.find((r) => r.pinned)?.pinned ?? null;
      const cpa = t.results ? r2(t.spend / t.results) : null;
      const roas = t.spend && t.revenue ? r2(t.revenue / t.spend) : null;
      const vsKpi = reference == null ? null : kpi.roas ? r2((roas ?? 0) / reference) : cpa ? r2(reference / cpa) : 0;
      const synced = rs.map((r) => r.syncedAt).filter((x): x is string => Boolean(x)).sort().at(-1)?.slice(0, 10) ?? null;
      const base = {
        key,
        clientId: rs[0].clientId,
        platform: "google" as const,
        kind: rs[0].kind,
        text: rs[0].text,
        label,
        pinned,
        ads: new Set(rs.map((r) => `${r.campaignId}|${r.adGroup}`)).size,
        adIds: [] as string[],
        spend: r2(t.spend),
        results: Math.round(t.results * 10) / 10,
        revenue: r2(t.revenue),
        impressions: t.impressions,
        clicks: t.clicks,
        ctr: t.impressions ? Math.round((t.clicks / t.impressions) * 10000) / 100 : null,
        cpa,
        roas,
        vsKpi,
        reference,
        days: 90,
        firstSeen: null,
        lastSeen: synced,
        live: t.impressions > 0,
        angle: null,
        avatar: null,
        hook: null,
        offer: null,
        formats: [...new Set(rs.map((r) => r.campaignName ?? ""))].filter(Boolean).slice(0, 3),
      };
      let { badge, reason } = badgeOf(base, kpi, false);
      if (label === "LOW" && (badge === "winner" || badge === "solid")) [badge, reason] = ["unproven", `Google rates it Low among the ad's assets (${reason})`];
      else if (label === "BEST" && badge === "unproven" && t.results >= 1 && (base.vsKpi ?? 0) >= 0.8) [badge, reason] = ["solid", `Google rates it Best; ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`];
      else if (label === "BEST" && badge === "unproven" && !t.spend && t.impressions >= 1000) [badge, reason] = ["solid", "Google rates it Best among the ad's assets"];
      else if (label) reason = `${reason} · Google rates it ${label.charAt(0)}${label.slice(1).toLowerCase()}`;
      const score = badge === "unproven" ? Math.log10(base.spend + 10) / 10 : (vsKpi ?? (label === "BEST" ? 1 : 0.8)) * Math.log10(base.spend + 10);
      return { ...base, badge, reason, score: r2(score) };
    }),
  );
}

export type CopyFilter = { platform?: CopyPlatform | null; kind?: CopyKind | null; badge?: CopyBadge | null; angle?: string | null; avatar?: string | null; search?: string | null; sinceDays?: number | null; today?: string };

/** The library's search and filters */
export function filterCopy(lines: CopyLine[], f: CopyFilter) {
  const q = f.search ? normalize(f.search) : "";
  const since = f.sinceDays ? new Date(Date.parse(`${f.today ?? new Date().toISOString().slice(0, 10)}T12:00:00Z`) - f.sinceDays * 86_400_000).toISOString().slice(0, 10) : null;
  return lines.filter(
    (l) =>
      (!f.platform || l.platform === f.platform) &&
      (!f.kind || l.kind === f.kind) &&
      (!f.badge || l.badge === f.badge) &&
      (!f.angle || (l.angle ?? "").toLowerCase() === f.angle.toLowerCase()) &&
      (!f.avatar || (l.avatar ?? "").toLowerCase() === f.avatar.toLowerCase()) &&
      (!since || (l.lastSeen ?? "") >= since) &&
      (!q || normalize(`${l.text} ${l.angle ?? ""} ${l.avatar ?? ""} ${l.hook ?? ""}`).includes(q)),
  );
}

const fmtKpi = (l: CopyLine, roas: boolean) => (roas ? `${l.roas ?? 0}x ROAS` : l.cpa == null ? "no results" : `$${l.cpa} each`);

/** One line written for an AI: its type, words and numbers */
export function lineForAi(l: CopyLine & { roasKpi?: boolean }, roas0: boolean, max = 400) {
  // Each line on its own platform's KPI when it carries it
  const roas = l.roasKpi ?? roas0;
  const text = l.text.length > max ? `${l.text.slice(0, max)}…` : l.text;
  const where = l.platform === "google" ? `Google ${KIND_LABEL[l.kind]}` : KIND_LABEL[l.kind];
  return `- [${where} · ${BADGE_LABEL[l.badge]}] "${text.replace(/\n+/g, " / ")}" (${fmtKpi(l, roas)}, $${Math.round(l.spend)} spent, CTR ${l.ctr ?? "?"}%, ${l.platform === "google" ? `${Math.round(l.results)} conv${l.label ? `, rated ${l.label.toLowerCase()}` : ""}${l.pinned ? `, pinned ${l.pinned.toLowerCase().replace("_", " ")}` : ""}` : `${l.ads} ${l.ads === 1 ? "ad" : "ads"}, ${l.days} days`}${l.angle ? `, angle: ${l.angle}` : ""})`;
}

/** Whether a chat message asks for ad copy (to bring the client's copy context with it) */
export function wantsCopy(text: string) {
  return /\b(ad copy|copy (?:set|for|ideas?|variations?)|(?:write|rewrite|draft|new|more|fresh|better)\b[^.?!\n]{0,40}\b(?:copy|headlines?|primary texts?|hooks?|captions?|descriptions?|ctas?|taglines?)|headlines?|primary texts?|hooks?|captions?|taglines?|link descriptions?|copywrit\w*)\b/i.test(text);
}

/** Whether a message is about Google copy (RSA headlines, descriptions, sitelinks, callouts, search ads) */
export function wantsGoogle(text: string) {
  return /\b(google|rsa|responsive search|search ads?|sitelinks?|callouts?|pmax|performance max)\b/i.test(text);
}

export type CopyContextParts = {
  client: string;
  roas: boolean;
  /** Which platform the copy is for: its limits come first, its lines lead (the other platform's proven lines follow) */
  platform?: CopyPlatform;
  lines: CopyLine[];
  voice?: string | null;
  rules?: { rule: string; polarity: "do" | "dont" }[];
  avoid?: string[];
  prefer?: string[];
  overrides?: { kind: string; rule: string; reason: string | null }[];
  reviews?: { status: string; note: string }[];
};

/**
 * Everything a copywriter needs about a client's copy, in priority order and within a character budget: Meta's limits,
 * the client's rules and what to avoid, the proven lines (winners and solid, with their numbers), the tired lines not to
 * repeat, the Brand Bible's voice, what was rebutted or forced through, and what the client approved or sent back.
 */
export function buildCopyContext(p: CopyContextParts, budget = 14_000) {
  const sections: { title: string; lines: string[] }[] = [];
  const google = p.platform === "google";
  if (google)
    sections.push({ title: "Google character limits (hard)", lines: [`- RSA headline: ${GOOGLE_LIMITS.headline} characters (up to 15, each different; pin only what must stay in a position).`, `- RSA description: ${GOOGLE_LIMITS.description} characters (up to 4).`, `- Performance Max long headline: ${GOOGLE_LIMITS.long_headline} characters.`, `- Sitelink text and callouts: ${GOOGLE_LIMITS.sitelink} characters; sitelink description lines 35.`] });
  else sections.push({ title: "Meta character limits", lines: [`- Primary text: ${COPY_LIMITS.primary} characters show before "See more" (the hook goes there); short form up to 300.`, `- Headline: ${COPY_LIMITS.headline} characters or less.`, `- Description: ${COPY_LIMITS.description} characters or less.`, "- No links in the primary text."] });
  const rules = [...(p.rules ?? []).map((r) => `- ${r.polarity === "do" ? "Do" : "Don't"}: ${r.rule}`), ...(p.avoid ?? []).map((x) => `- Avoid: ${x}`)];
  if (rules.length) sections.push({ title: "The client's rules and what they told us to avoid (never break these)", lines: rules });
  // The platform's own proven lines first, then the other platform's (Meta and Google share what works: the same
  // promise, offer and proof, rewritten for the other platform's form)
  const mine = (l: CopyLine) => (l.platform ?? "meta") === (p.platform ?? "meta");
  const proven0 = p.lines.filter((l) => (l.badge === "winner" || l.badge === "solid") && mine(l));
  const across = p.lines.filter((l) => (l.badge === "winner" || l.badge === "solid") && !mine(l));
  if (proven0.length) sections.push({ title: "Proven copy (from the Copy library: model new lines on these, never copy them word for word into a different offer)", lines: proven0.map((l) => lineForAi(l, p.roas)) });
  if (across.length) sections.push({ title: `Proven on ${google ? "Meta" : "Google"} (the messages that convert there: carry the promise over in this platform's form)`, lines: across.map((l) => lineForAi(l, p.roas, 220)) });
  const tired = p.lines.filter((l) => l.badge === "tired");
  if (tired.length) sections.push({ title: "Tired lines (worked, now wearing out: don't repeat them as they are)", lines: tired.map((l) => lineForAi(l, p.roas, 200)) });
  if (p.prefer?.length) sections.push({ title: "What works for this client", lines: p.prefer.map((x) => `- ${x}`) });
  if (p.voice?.trim()) sections.push({ title: "Brand Bible: voice and messaging", lines: p.voice.trim().split("\n") });
  if (p.overrides?.length) sections.push({ title: "Copy checks the team settled (rebutted as too strict, or approved past)", lines: p.overrides.map((o) => `- ${o.kind === "force" ? "Approved past" : "Rebutted"}: ${o.rule}${o.reason ? ` (why: ${o.reason})` : ""}`) });
  if (p.reviews?.length) sections.push({ title: "What the client said about copy before", lines: p.reviews.map((r) => `- ${r.status === "approved" ? "Approved" : "Sent back"}: ${r.note}`) });

  // Fill in order until the budget runs out; a section that doesn't fit whole keeps as many lines as fit
  let out = `<copy_context client="${p.client}">\n`;
  const end = "</copy_context>";
  for (const s of sections) {
    const head = `${s.title}:\n`;
    if (out.length + head.length + end.length + 20 > budget) break;
    out += head;
    for (const line of s.lines) {
      if (out.length + line.length + 1 + end.length > budget) break;
      out += `${line}\n`;
    }
    out += "\n";
  }
  return `${out.trimEnd()}\n${end}`;
}
