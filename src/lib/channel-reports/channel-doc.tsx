import { Fragment } from "react";
import { Circle, Defs, Document, Font, G, Image, Line, LinearGradient, Link, Page, Rect, Stop, Svg, Text, View } from "@react-pdf/renderer";
import { docKit, KAIZEN_RED, lookFor, notesOf, type Look, type WeeklyBrand } from "@/lib/reports/weekly-doc";
import { scrubAgency, scrubSections } from "@/lib/reports/white-label";
import type { Sections } from "@/lib/reports/write";
import type { Move } from "@/lib/reports/weekly-core";
import { BENCHMARKS } from "@/lib/klaviyo/insights";
import { cadenceWord, channelName, fitFont, int, isEngagement, metricsSupport, money, moveOf, pct, priorWordOf, shortMoney, signed, takeawaysFor, type EmailMetrics, type SocialMetrics } from "./core";
import { channelMtdView, MTD_STATUS_WORD, type ChannelMtdView } from "./mtd";
import { columnKeys, tileViews, type ChannelLayout, type TileView } from "./layout";
import { wholeMoney } from "./email-message";
import { splitDay, splitLegend, splitOfDays, splitTotal, SPLIT_HEX } from "./email-split";
import { audienceLines } from "@/lib/klaviyo/audiences";
import { rprOf, type Grade, type MessageRow, type Pair, type PerfBlock } from "./email-detail";
import type { RevenueSource } from "./email-sources";
import type { LocationMetricBreakdown } from "@/lib/klaviyo/locations";
import { campaignPicks, cardCampaigns, cardStats, flowCardViews, fromKlaviyo, heat, klaviyoCampaignUrl, locationViews, shareText, tint, type CardStat, type FlowCardView } from "./email-cards";
import { SocialBody } from "./social-doc";
import { withTeamFindings } from "./social-notes";
import { EngagementBody } from "./engagement-doc";
import { measuresShort } from "./email-engagement";

// A channel client report as a PDF, in the same design as the ads report (weekly-doc.tsx): the client's logo beside
// Kaizen's, the hero band with the period, the period at a glance, and three takeaways. Email reads like the overview the
// email team used to pull from Klaviyo, kept to two pages: revenue and orders, each day's campaigns against automated
// emails, campaign and flow performance against Kaizen's bars with every campaign and the best flows, deliverability and
// subscriber growth, each against the period before; each campaign is a card with the top of its email (linked to it in
// Klaviyo) and its numbers against the bars; a multi-location client's report ends with its orders by restaurant (a
// headline band, the locations ranked, the three best and a shaded location by campaign table), straight after the
// rest. Social: each platform and the best posts with their pictures.
// Boxes have fixed heights and values are sized to fit them, so nothing can overlap whatever the numbers are. The
// narrative travels in the message, never in the document. A white label client's carries only the client's brand.

/**
 * layout: the tiles and table columns picked for this report (null: the defaults). edit: the studio's preview, with an
 * invisible link over every tile, column and line the owner can change (never sent). withNotes: the write-up as a last
 * page, only on the copy saved to the client's Drive. extras: what the owner added by hand (in the notes only).
 */
export type ChannelPdfInput = { client: string; clientId?: string | null; metrics: EmailMetrics | SocialMetrics; sections: Sections; whiteLabel?: boolean; brand?: WeeklyBrand | null; dashboard?: string | null; layout?: ChannelLayout | null; edit?: boolean; withNotes?: boolean; extras?: string | null };

// Whole words only: a campaign name in a narrow column wraps between words, never "Piz-za" (as the ads report does)
Font.registerHyphenationCallback((word) => [word]);

const { s, Logo, Arrow, Hot, toneOf, INK, MUTED, FAINT, LINE, INNER, HERO_H, GOOD, BAD } = docKit;
const AGENCY = "Kaizen Marketing";
const GAP = 8;
const AMBER = { fg: "#a1650f", bg: "#fdf1dc" };
const GRADE_TONE: Record<Grade, { fg: string; bg: string }> = { good: GOOD, fair: AMBER, poor: BAD };
const GRADE_WORD: Record<Grade, string> = { good: "Good", fair: "Fair", poor: "Poor" };
const CAMPAIGN_HEX = "#24364d";
/** Revenue per recipient with its cents */
const centsMoney = (n: number | null | undefined, currency: string | null) => (n == null || !Number.isFinite(n) ? "–" : `${!currency || currency === "USD" ? "$" : `${currency} `}${n.toFixed(2)}`);

/** Image data URIs by what they picture (a campaign's id, a post's platform and id) */
export type ChannelImages = Record<string, string | null>;
export const postKey = (p: { platform: string; id: string }) => `${p.platform}:${p.id}`;
/** A campaign card's picture: the top of the email as drawn (or its first picture) */
export const shotKey = (campaignId: string) => `shot:${campaignId}`;

const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const weekday = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
const fullRange = (a: string, b: string) => `${day(a)} – ${new Date(`${b}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
const priorWord = (m: { kind: string }) => priorWordOf(m.kind);

function Masthead({ input, look }: { input: ChannelPdfInput; look: Look }) {
  const agency = !input.whiteLabel;
  const logo = input.brand?.logo;
  return (
    <View style={s.mast}>
      <View style={s.brandRow}>
        {logo ? <Logo src={logo} light={input.brand?.light} chip={look.hero} height={agency ? 24 : 30} maxWidth={agency ? 84 : 150} /> : <Text style={{ fontSize: agency ? 12 : 15, fontFamily: "Helvetica-Bold", color: agency ? INK : look.primary }}>{input.client}</Text>}
        {agency ? (
          <>
            <View style={s.divider} />
            {input.brand?.agencyLogo ? <Logo src={input.brand.agencyLogo} chip={look.hero} height={26} maxWidth={110} /> : <Text style={{ fontSize: 17, fontFamily: "Helvetica-Bold", color: KAIZEN_RED }}>kaizen</Text>}
          </>
        ) : null}
      </View>
      <Text style={s.topKicker}>Performance Intelligence / {channelName(input.metrics.platform)}</Text>
    </View>
  );
}

function Hero({ input, look }: { input: ChannelPdfInput; look: Look }) {
  const m = input.metrics;
  const long = input.client.length > 16;
  const word = cadenceWord(m.kind);
  return (
    <View style={s.hero}>
      <Svg width={INNER} height={HERO_H} viewBox={`0 0 ${INNER} ${HERO_H}`} style={{ position: "absolute", top: 0, left: 0 }}>
        <Defs>
          <LinearGradient id="band" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={look.hero} />
            <Stop offset="1" stopColor={look.heroEdge} />
          </LinearGradient>
        </Defs>
        <Rect x={0} y={0} width={INNER} height={HERO_H} fill="url(#band)" />
        <Circle cx={INNER - 30} cy={HERO_H * 0.22} r={118} fill="none" stroke="#ffffff" strokeOpacity={0.11} strokeWidth={1} />
        <Circle cx={INNER - 30} cy={HERO_H * 0.22} r={150} fill="none" stroke="#ffffff" strokeOpacity={0.06} strokeWidth={28} />
      </Svg>
      <View style={s.heroBody}>
        <View style={{ maxWidth: 300 }}>
          <Text style={[s.eyebrow, { color: look.heroSoft }]}>{word ? `${word} ` : ""}{m.platform === "klaviyo" ? "Email Marketing" : "Organic Social"} Report</Text>
          <Text style={[s.h1, long ? { fontSize: 20 } : {}]}>{input.client.length <= 11 ? `${input.client} Performance\nOverview` : `${input.client}\nPerformance Overview`}</Text>
          <Text style={s.heroSub}>{m.platform === "klaviyo" ? (isEngagement(m) ? "Reach, engagement, clicks to your site & list health" : "Revenue, campaigns, automated emails & list health") : "Audience growth, reach & what resonated"}</Text>
        </View>
        <View>
          <Text style={s.periodSmall}>Reporting period</Text>
          <Text style={s.periodBig}>{fullRange(m.main.start, m.main.end)}</Text>
          <Text style={s.periodSmall}>Compared with {fullRange(m.compare.start, m.compare.end)}</Text>
        </View>
      </View>
    </View>
  );
}

// ─── Building blocks ───────────────────────────────────────────────────────

/** The move against the period before as a chip: green when it's good for the client, red when it isn't */
function Chip({ mv }: { mv: Move }) {
  if (!mv) return null;
  const c = toneOf(mv);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", height: 12, borderRadius: 3.5, paddingHorizontal: 4, backgroundColor: c.bg, marginRight: 4 }}>
      {mv.pct !== "0.0%" ? (
        <View style={{ marginRight: 2.5 }}>
          <Arrow up={mv.up} color={c.fg} />
        </View>
      ) : null}
      <Text style={{ fontSize: 6.6, fontFamily: "Helvetica-Bold", color: c.fg }}>{mv.pct}</Text>
    </View>
  );
}

/** A grade against Kaizen's bar ("Good", "Fair", "Poor") */
function Badge({ g }: { g: Grade | null }) {
  if (!g) return null;
  const c = GRADE_TONE[g];
  return (
    <View style={{ height: 11, borderRadius: 5.5, paddingHorizontal: 5, backgroundColor: c.bg, justifyContent: "center", marginLeft: 5 }}>
      <Text style={{ fontSize: 5.8, fontFamily: "Helvetica-Bold", color: c.fg, letterSpacing: 0.3 }}>{GRADE_WORD[g].toUpperCase()}</Text>
    </View>
  );
}

/** The chip and what it's against, on one line that never wraps into the next box */
function MoveLine({ mv, before, prior }: { mv: Move; before: string; prior: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", height: 12 }}>
      <Chip mv={mv} />
      <Text style={{ fontSize: 6.2, color: MUTED, maxLines: 1, textOverflow: "ellipsis", flexShrink: 1 }}>{before === "–" ? "No prior number" : `vs ${before} prior ${prior}`}</Text>
    </View>
  );
}

const label = { fontSize: 6.4, color: "#5f6f82", fontFamily: "Helvetica-Bold" as const, textTransform: "uppercase" as const, letterSpacing: 0.7, maxLines: 1, textOverflow: "ellipsis" as const };

/**
 * One number in a box of a set width and height: its label, the value sized to fit the width, its move and an optional
 * line under it. Heights are fixed, so a long value or a long line can't push into the box below.
 */
function Stat({ title, value, mv, before, prior, sub, width, height = 80, max = 20, color, badge }: { title: string; value: string; mv?: Move; before?: string; prior: string; sub?: string | null; width: number; height?: number; max?: number; color?: string; badge?: Grade | null }) {
  const pad = 10;
  const size = fitFont(value, width - pad * 2 - (badge ? 34 : 0), max);
  return (
    <View style={{ width, height, paddingHorizontal: pad, paddingVertical: 9 }}>
      {/* A long title in a narrow box (five or six tiles) tightens instead of being cut */}
      <Text style={title.length * 5.2 > width - pad * 2 ? [label, { fontSize: 5.6, letterSpacing: 0.15 }] : label}>{title}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", height: max + 6, marginTop: 4 }}>
        <Text style={{ fontSize: size, fontFamily: "Helvetica-Bold", letterSpacing: -0.4, color: color ?? INK, lineHeight: 1 }}>{value}</Text>
        <Badge g={badge ?? null} />
      </View>
      {before !== undefined ? <MoveLine mv={mv ?? null} before={before} prior={prior} /> : null}
      {sub ? <Text style={{ fontSize: 6.2, color: MUTED, marginTop: 3, lineHeight: 1.3, maxLines: 2, textOverflow: "ellipsis" }}>{sub}</Text> : null}
    </View>
  );
}

/** A white card holding a row of boxes split by hairlines */
function StatRow({ children, height }: { children: React.ReactNode; height?: number }) {
  return <View style={{ flexDirection: "row", backgroundColor: "#ffffff", borderWidth: 1, borderColor: LINE, borderRadius: 10, height }}>{children}</View>;
}
const Rule = () => <View style={{ width: 1, backgroundColor: "#edf1f4", marginVertical: 10 }} />;

function Head({ title, sub }: { title: string; sub?: string }) {
  return (
    <View style={s.head}>
      <Text style={s.h2}>{title}</Text>
      {sub ? <Text style={[s.sub, { maxWidth: 330, textAlign: "right" }]}>{sub}</Text> : null}
    </View>
  );
}

// ─── At a glance ───────────────────────────────────────────────────────────

/** Where the preview can click on this report (null on the PDF the client gets) */
type HotOf = (what: string) => string | null;
const hotOf = (input: ChannelPdfInput): HotOf => (what) => (input.edit ? `${input.metrics.platform}/${what}` : null);

/** Social, and an older email report without the detail: the tiles picked and the rates under them */
function Glance({ m, layout, hot }: { m: EmailMetrics | SocialMetrics; layout?: ChannelLayout | null; hot: HotOf }) {
  return (
    <View style={s.section} wrap={false}>
      <Head title="Performance at a glance" sub={`${m.kind === "monthly" ? "Month-over-month" : m.kind === "weekly" ? "Week-over-week" : "Period-over-period"} movement · green = favorable, red = unfavorable`} />
      <Tiles m={m} tiles={tileViews(m, layout)} hot={hot} height={86} />
      <View style={[s.support, { marginTop: 8 }]}>
        {metricsSupport(m).map((x) => (
          <Text key={x.label} style={[s.supportText, { lineHeight: 1.3 }]}>
            {x.label} <Text style={{ fontFamily: "Helvetica-Bold", color: INK }}>{x.value}</Text>
          </Text>
        ))}
      </View>
    </View>
  );
}

/** The split of revenue between campaigns and automated emails, as a bar */
function SplitBox({ m, w, h }: { m: EmailMetrics; w: number; h: number }) {
  const total = m.now.campaignRevenue + m.now.flowRevenue;
  const camp = total > 0 ? m.now.campaignRevenue / total : 0;
  return (
    <View style={{ width: w, height: h, paddingHorizontal: 10, paddingVertical: 9 }}>
      <Text style={label}>Campaigns vs automated</Text>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", height: 26, marginTop: 4 }}>
        <Text style={{ fontSize: 17, fontFamily: "Helvetica-Bold", color: CAMPAIGN_HEX, lineHeight: 1 }}>{total > 0 ? `${Math.round(camp * 100)}%` : "–"}</Text>
        <Text style={{ fontSize: 17, fontFamily: "Helvetica-Bold", color: "#4f7cff", lineHeight: 1 }}>{total > 0 ? `${100 - Math.round(camp * 100)}%` : "–"}</Text>
      </View>
      <View style={{ flexDirection: "row", height: 6, borderRadius: 3, overflow: "hidden", backgroundColor: "#edf1f4", marginTop: 4 }}>
        {total > 0 ? (
          <>
            <View style={{ width: `${camp * 100}%`, backgroundColor: CAMPAIGN_HEX }} />
            <View style={{ flex: 1, backgroundColor: "#4f7cff" }} />
          </>
        ) : null}
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 5 }}>
        <Text style={{ fontSize: 6.2, color: MUTED }}>Campaigns</Text>
        <Text style={{ fontSize: 6.2, color: MUTED }}>Automated</Text>
      </View>
    </View>
  );
}

/** The tiles picked for the report, in one card: each a number with its move (or the split), each one click in the preview */
function Tiles({ m, tiles, hot, height }: { m: EmailMetrics | SocialMetrics; tiles: TileView[]; hot: HotOf; height: number }) {
  const w = (INNER - 2 - (tiles.length - 1)) / Math.max(1, tiles.length);
  const prior = priorWord(m);
  return (
    <StatRow height={height}>
      {tiles.map((t, i) => (
        <Fragment key={t.key}>
          {i ? <Rule /> : null}
          <View style={{ width: w, height }}>
            {t.kind === "split" && m.platform === "klaviyo" ? (
              <SplitBox m={m} w={w} h={height} />
            ) : (
              <Stat title={t.label} value={t.value} mv={t.move} before={t.before} prior={prior} sub={t.sub} width={w} height={height} badge={t.badge ?? null} max={tiles.length > 4 ? 16 : 20} />
            )}
            <Hot href={hot(`tile/${i}`)} />
          </View>
        </Fragment>
      ))}
    </StatRow>
  );
}

/**
 * Month to date, right under the week's headline numbers: the month so far against the same days last month and, when
 * the line has a monthly target, how it paces against it (a bar of how much is done against how much of the month has
 * gone, and where the month lands at this rate). Weekly reports only.
 */
function ChannelMtd({ m, look }: { m: EmailMetrics | SocialMetrics; look: Look }) {
  const v: ChannelMtdView | null = channelMtdView(m);
  if (!v) return null;
  const tone = v.status === "on" || v.status === "over" ? GOOD : v.status === "under" ? AMBER : { fg: "#5f6f80", bg: "#eef2f5" };
  const sub = `${v.range} · vs the same days last month`;
  return (
    <View style={s.section} wrap={false}>
      <Head title="Month to date" sub={sub} />
      <View style={s.panel}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", gap: 10 }}>
          <View>
            <Text style={label}>{v.headline.label}</Text>
            <Text style={{ fontSize: 21, fontFamily: "Helvetica-Bold", letterSpacing: -0.5, marginTop: 5 }}>{v.headline.value}</Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <View style={{ height: 13, borderRadius: 4, paddingHorizontal: 6, backgroundColor: tone.bg, justifyContent: "center" }}>
              <Text style={{ fontSize: 7, fontFamily: "Helvetica-Bold", color: tone.fg }}>{MTD_STATUS_WORD[v.status]}</Text>
            </View>
            <Text style={[s.baseline, { marginTop: 4 }]}>{v.pace ? `of ${v.pace.target} monthly target` : v.projected ? `${v.projected.label} ${v.projected.value}` : `Day ${v.elapsed} of ${v.daysInMonth}`}</Text>
          </View>
        </View>
        {v.pace ? (
          <View style={{ marginTop: 11 }}>
            <View style={[s.barTrack, { backgroundColor: "#eaeff3", height: 8 }]}>
              <View style={{ width: `${v.pace.pctDone}%`, height: 8, backgroundColor: look.primary, borderRadius: 4 }} />
              <View style={{ position: "absolute", top: 0, bottom: 0, left: `${Math.min(100, v.pace.pctElapsed)}%`, width: 1.5, backgroundColor: INK }} />
            </View>
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 4 }}>
              <Text style={s.baseline}>{Math.round(v.pace.pctDone)}% of target reached · on track for {v.pace.projected}</Text>
              <Text style={s.baseline}>{Math.round(v.pace.pctElapsed)}% of the month gone (day {v.elapsed} of {v.daysInMonth})</Text>
            </View>
          </View>
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 11, paddingTop: 9, borderTopWidth: 1, borderTopColor: LINE, rowGap: 9 }}>
          {v.rows.map((r) => (
            <View key={r.label} style={{ width: `${100 / Math.min(4, v.rows.length)}%`, paddingRight: 8 }}>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <Text style={{ fontSize: 9.5, fontFamily: "Helvetica-Bold" }}>{r.value}</Text>
                {r.move && (r.move.tone !== "flat" || r.move.pct !== "0.0%") ? (
                  <View style={{ flexDirection: "row", alignItems: "center", marginLeft: 4 }}>
                    <Arrow up={r.move.up} color={toneOf(r.move).fg} />
                    <Text style={{ fontSize: 5.8, fontFamily: "Helvetica-Bold", color: toneOf(r.move).fg, marginLeft: 2 }}>{r.move.pct}</Text>
                  </View>
                ) : null}
              </View>
              <Text style={{ fontSize: 5.4, color: MUTED, marginTop: 1.5, textTransform: "uppercase", letterSpacing: 0.2 }}>{r.label}</Text>
            </View>
          ))}
        </View>
        <Text style={s.note}>{v.note}</Text>
      </View>
    </View>
  );
}

/** Email: the tiles picked (revenue from email and SMS, orders, and the split unless changed) */
function EmailGlance({ m, layout, hot }: { m: EmailMetrics; layout?: ChannelLayout | null; hot: HotOf }) {
  return (
    <View style={s.section} wrap={false}>
      <Head title="Performance at a glance" sub={`${m.kind === "monthly" ? "Month-over-month" : m.kind === "weekly" ? "Week-over-week" : "Period-over-period"} movement · green = favorable, red = unfavorable`} />
      <Tiles m={m} tiles={tileViews(m, layout)} hot={hot} height={84} />
      {m.sources ? null : <MetricSides m={m} />}
    </View>
  );
}

// ─── Revenue by source (two order systems) ─────────────────────────────────

/** A part of a whole as a thin bar with its two colours */
function SplitBar({ a, b, colors }: { a: number; b: number; colors: [string, string] }) {
  const t = a + b;
  return (
    <View style={{ flexDirection: "row", height: 4, borderRadius: 2, overflow: "hidden", backgroundColor: "#edf1f4" }}>
      {t > 0 ? (
        <>
          <View style={{ width: `${(a / t) * 100}%`, backgroundColor: colors[0] }} />
          <View style={{ flex: 1, backgroundColor: colors[1] }} />
        </>
      ) : null}
    </View>
  );
}

const SOURCE_H = 214;

/** One order system's card: what email earned through it, against the period before, its share, its split and its best locations */
function SourceCard({ x, m, w, look }: { x: RevenueSource; m: EmailMetrics; w: number; look: Look }) {
  const c = m.currency;
  const prior = priorWord(m);
  const camp = x.campaignRevenue ?? 0;
  const flow = x.flowRevenue ?? 0;
  const split = x.campaignRevenue != null && x.flowRevenue != null && camp + flow > 0;
  const value = wholeMoney(x.revenue.now, c);
  return (
    <View style={{ width: w, height: SOURCE_H, backgroundColor: "#ffffff", borderWidth: 1, borderColor: LINE, borderRadius: 10, overflow: "hidden" }}>
      <View style={{ height: 3, backgroundColor: x.primary ? look.primary : look.bars }} />
      <View style={{ paddingHorizontal: 11, paddingTop: 9 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", height: 12 }}>
          <Text style={[label, { flexShrink: 1 }]}>{x.name}</Text>
          {x.share != null ? <Text style={{ fontSize: 7, fontFamily: "Helvetica-Bold", color: look.barsText, marginLeft: 4 }}>{shareText(x.share)} of total</Text> : null}
        </View>
        <Text style={{ fontSize: fitFont(value, w - 22, 19), fontFamily: "Helvetica-Bold", letterSpacing: -0.4, marginTop: 6, lineHeight: 1 }}>{value}</Text>
        <View style={{ marginTop: 5 }}>
          <MoveLine mv={moveOf(x.revenue.now, x.revenue.before)} before={x.revenue.before == null ? "–" : wholeMoney(x.revenue.before, c)} prior={prior} />
        </View>
        <View style={{ flexDirection: "row", marginTop: 8, paddingTop: 7, borderTopWidth: 1, borderTopColor: "#edf1f4" }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 8.6, fontFamily: "Helvetica-Bold", color: INK }}>{int(x.orders.now)}</Text>
            <View style={{ flexDirection: "row", alignItems: "center", marginTop: 2 }}>
              <Chip mv={moveOf(x.orders.now, x.orders.before)} />
              <Text style={{ fontSize: 6.2, color: MUTED }}>orders</Text>
            </View>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 8.6, fontFamily: "Helvetica-Bold", color: INK }}>{x.attributedShare != null ? shareText(x.attributedShare) : "–"}</Text>
            <Text style={{ fontSize: 6.2, color: MUTED, marginTop: 3, maxLines: 1 }}>{x.store != null ? `of ${wholeMoney(x.store, c)} in ${x.name}` : "of its own total"}</Text>
          </View>
        </View>
        <View style={{ marginTop: 8 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 3 }}>
            <Text style={{ fontSize: 6.2, color: MUTED }}>Campaigns {split ? wholeMoney(camp, c) : "–"}</Text>
            <Text style={{ fontSize: 6.2, color: MUTED }}>Automated {split ? wholeMoney(flow, c) : "–"}</Text>
          </View>
          <SplitBar a={camp} b={flow} colors={[CAMPAIGN_HEX, look.bars]} />
        </View>
        <View style={{ marginTop: 8 }}>
          <Text style={[label, { fontSize: 5.8 }]}>{x.locationCount ? `Top locations · ${x.locationCount} converted` : "Locations"}</Text>
          {x.locations.length ? (
            x.locations.slice(0, 3).map((l) => (
              <View key={l.location} style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 3 }}>
                <Text style={{ fontSize: 6.8, color: INK, maxLines: 1, textOverflow: "ellipsis", flex: 1, paddingRight: 6 }}>{l.location.replace(/^.*?\s[-–|:·]\s/, "")}</Text>
                <Text style={{ fontSize: 6.8, fontFamily: "Helvetica-Bold", color: INK }}>{wholeMoney(l.revenue, c)}</Text>
              </View>
            ))
          ) : (
            <Text style={{ fontSize: 6.4, color: FAINT, marginTop: 3 }}>No location read for this source</Text>
          )}
        </View>
      </View>
    </View>
  );
}

/**
 * Two or more order systems (Toast and a custom POS): a card each with what email earned through it, and the combined
 * total beside them, every order counted once. The client's earlier reports showed each system on its own; this keeps
 * that, with the total the two make.
 */
function RevenueSources({ m, look }: { m: EmailMetrics; look: Look }) {
  const src = m.sources;
  if (!src || src.sources.length < 2) return null;
  const c = m.currency;
  const prior = priorWord(m);
  const list = src.sources.slice(0, 3);
  const w = (INNER - GAP * list.length) / (list.length + 1);
  const comb = src.combined;
  const total = wholeMoney(comb.revenue.now, c);
  return (
    <View style={s.section} wrap={false}>
      <Head title="Revenue by source" sub={`Each order system ${m.source ?? "Klaviyo"} credits to email, on its own and combined · ${m.main.label}`} />
      <View style={{ flexDirection: "row", gap: GAP }}>
        {list.map((x) => (
          <SourceCard key={x.id} x={x} m={m} w={w} look={look} />
        ))}
        <View style={{ width: w, height: SOURCE_H, borderRadius: 10, overflow: "hidden", backgroundColor: look.hero }}>
          <View style={{ paddingHorizontal: 11, paddingTop: 12, flex: 1 }}>
            <Text style={[s.eyebrow, { color: look.heroSoft }]}>Combined</Text>
            <Text style={{ fontSize: fitFont(total, w - 22, 21), fontFamily: "Helvetica-Bold", color: "#ffffff", letterSpacing: -0.5, marginTop: 6, lineHeight: 1 }}>{total}</Text>
            <Text style={{ fontSize: 6.6, color: "#d8dde3", marginTop: 5 }}>{comb.revenue.before == null ? "No prior number" : `vs ${wholeMoney(comb.revenue.before, c)} prior ${prior}`}</Text>
            <View style={{ marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.2)" }}>
              <Text style={{ fontSize: 9, fontFamily: "Helvetica-Bold", color: "#ffffff" }}>{int(comb.orders.now)}</Text>
              <Text style={{ fontSize: 6.2, color: "#d8dde3", marginTop: 2 }}>orders, each counted once</Text>
            </View>
            {comb.campaignRevenue != null && comb.flowRevenue != null ? (
              <View style={{ marginTop: 9 }}>
                <Text style={{ fontSize: 6.4, color: "#d8dde3" }}>Campaigns {wholeMoney(comb.campaignRevenue, c)}</Text>
                <Text style={{ fontSize: 6.4, color: "#d8dde3", marginTop: 2 }}>Automated {wholeMoney(comb.flowRevenue, c)}</Text>
              </View>
            ) : null}
            <Text style={{ position: "absolute", left: 11, right: 11, bottom: 10, fontSize: 6, color: "#d8dde3", lineHeight: 1.35 }}>{src.note}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

// ─── Conversion summary ────────────────────────────────────────────────────

/** Text inside an Svg: react-pdf's own svg text */
const SvgTextRaw = Text as unknown as React.FC<{ x: number; y: number; fill?: string; textAnchor?: "start" | "middle" | "end"; style?: Record<string, unknown>; children: React.ReactNode }>;
function SvgText({ x, y, anchor, fill, size = 6.4, bold = true, children }: { x: number; y: number; anchor: "start" | "middle" | "end"; fill: string; size?: number; bold?: boolean; children: React.ReactNode }) {
  return (
    <SvgTextRaw x={x} y={y} fill={fill} textAnchor={anchor} style={{ fontSize: size, fontFamily: bold ? "Helvetica-Bold" : "Helvetica" }}>
      {children}
    </SvgTextRaw>
  );
}

/** A tidy top for the chart's scale: 1, 2, 2.5 or 5 times a power of ten */
function niceTop(max: number): number {
  if (max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  return ([1, 2, 3, 4, 5, 6, 8, 10].find((k) => k * p >= max) ?? 10) * p;
}

function LegendRow({ color, name, value, share, mv, prior, before }: { color: string; name: string; value: string; share: string; mv: Move; prior: string; before: string }) {
  return (
    <View style={{ marginBottom: 9 }}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <View style={[s.dot, { backgroundColor: color, marginRight: 5 }]} />
        <Text style={{ fontSize: 7, color: MUTED }}>{name}</Text>
        <Text style={{ fontSize: 7, color: FAINT, marginLeft: 4 }}>{share}</Text>
      </View>
      <Text style={{ fontSize: fitFont(value, 120, 13), fontFamily: "Helvetica-Bold", marginTop: 3, marginBottom: 3, lineHeight: 1 }}>{value}</Text>
      <MoveLine mv={mv} before={before} prior={prior} />
    </View>
  );
}

/**
 * Each day's revenue by channel and type, stacked in one palette (email blues, SMS oranges; the darker shade for campaigns,
 * the lighter for automations), with the legend, each part's share and the total beside it. The SMS shades only appear
 * when texts earned revenue in the period. The numbers come from email-split.ts, the same as the live page's.
 */
function ConversionSummary({ m }: { m: EmailMetrics }) {
  const d = m.detail!;
  const c = m.currency;
  const prior = priorWord(m);
  const daily = d.daily;
  const now = d.split?.now ?? splitOfDays(daily) ?? splitDay({ campaign: m.now.campaignRevenue, flow: m.now.flowRevenue, sms: m.now.smsRevenue });
  const before = d.split ? d.split.before : splitDay({ campaign: m.before.campaignRevenue, flow: m.before.flowRevenue, sms: m.before.smsRevenue });
  const lg = splitLegend(now, before);
  const ch = d.channels ?? null;
  const parts = daily.map(splitDay);
  const keys = lg.rows.map((r) => r.key);
  const left = 132;
  const W = INNER - 26 - left - 14;
  const H = lg.sms ? 200 : 132;
  const top = 12;
  const base = H - 16;
  const scale = niceTop(Math.max(...parts.map(splitTotal), 0));
  const slot = daily.length ? (W - 30) / daily.length : 0;
  const bar = Math.max(3, Math.min(30, slot * 0.62));
  const y = (v: number) => base - (v / scale) * (base - top);
  const few = daily.length <= 10;
  const shareText2 = (x: number | null) => (x == null ? "" : `${Math.round(x * 100)}%`);
  return (
    <View style={s.section} wrap={false}>
      <Head title="Conversion summary" sub={lg.sms ? `Revenue by day from email and SMS, campaigns and automations, ${m.main.label}` : `Revenue by day from email campaigns and automations, ${m.main.label}`} />
      <View style={[s.panel, { flexDirection: "row" }]}>
        <View style={{ width: left, paddingRight: 10, borderRightWidth: 1, borderRightColor: "#edf1f4", marginRight: 14 }}>
          {lg.rows.map((r) => (
            <LegendRow key={r.key} color={r.color} name={r.label} value={wholeMoney(r.revenue, c)} share={shareText2(r.share)} mv={moveOf(r.revenue, r.before)} before={wholeMoney(r.before, c)} prior={prior} />
          ))}
          <View style={{ borderTopWidth: 1, borderTopColor: "#edf1f4", paddingTop: 6 }}>
            <Text style={{ fontSize: 7, color: MUTED }}>Total attributed</Text>
            <Text style={{ fontSize: fitFont(wholeMoney(lg.total, c), 120, 13), fontFamily: "Helvetica-Bold", marginTop: 3, marginBottom: 3, lineHeight: 1 }}>{wholeMoney(lg.total, c)}</Text>
            <MoveLine mv={moveOf(lg.total, lg.totalBefore)} before={wholeMoney(lg.totalBefore, c)} prior={prior} />
          </View>
          {lg.sms && ch ? (
            <Text style={{ fontSize: 6.2, color: MUTED, lineHeight: 1.35, marginTop: 5 }}>
              {int(ch.email.sends.now)} emails and {int(ch.sms.sends.now)} texts sent ({int(ch.sms.campaigns.now)} SMS {ch.sms.campaigns.now === 1 ? "campaign" : "campaigns"})
            </Text>
          ) : null}
        </View>
        {daily.length ? (
          <Svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
            {[0, 0.5, 1].map((f) => (
              <G key={f}>
                <Line x1={30} y1={y(scale * f)} x2={W} y2={y(scale * f)} stroke={f ? "#eef2f5" : LINE} strokeWidth={f ? 0.6 : 1} />
                <SvgText x={26} y={y(scale * f) + 2} anchor="end" fill={FAINT} bold={false} size={5.8}>
                  {shortMoney(scale * f, c)}
                </SvgText>
              </G>
            ))}
            {daily.map((p, i) => {
              const x = 30 + i * slot + (slot - bar) / 2;
              const b = parts[i];
              const dayTotal = splitTotal(b);
              // Stacked from the bottom in the legend's order, so the two blues sit under the two oranges
              let acc = 0;
              const rects = keys.map((k) => {
                const from = acc;
                acc += b[k];
                return b[k] > 0 ? <Rect key={k} x={x} y={y(acc)} width={bar} height={Math.max(0.8, y(from) - y(acc))} fill={SPLIT_HEX[k]} /> : null;
              });
              // A long period labels every few days, counted back from the last so the last day is always named
              const every = few ? 1 : Math.ceil(daily.length / 7);
              const named = (daily.length - 1 - i) % every === 0;
              return (
                <G key={p.date}>
                  {rects}
                  {few && dayTotal > 0 ? (
                    <SvgText x={x + bar / 2} y={y(dayTotal) - 3} anchor="middle" fill={INK} size={6}>
                      {shortMoney(dayTotal, c)}
                    </SvgText>
                  ) : null}
                  {named ? (
                    <SvgText x={x + bar / 2} y={H - 4} anchor={!few && i === daily.length - 1 ? "end" : "middle"} fill={MUTED} bold={false} size={6}>
                      {few ? `${weekday(p.date)} ${Number(p.date.slice(8))}` : day(p.date)}
                    </SvgText>
                  ) : null}
                </G>
              );
            })}
          </Svg>
        ) : (
          <Text style={{ fontSize: 7.5, color: MUTED, marginTop: 20 }}>The day-by-day numbers weren&apos;t read for this period, so the totals are added up from campaigns and automated emails.</Text>
        )}
      </View>
    </View>
  );
}

// ─── Campaign and flow performance ─────────────────────────────────────────

/** Recipients, open, click and placed order rate for the period, each against the period before (never graded against Kaizen's internal bars) */
function PerfCells({ p, prior, kind, currency, measured = true }: { p: PerfBlock; prior: string; kind: "campaign" | "flow"; currency: string | null; measured?: boolean }) {
  const withRpr = measured && p.rpr != null;
  const w = (INNER - 2 - (withRpr ? 4 : 3)) / (withRpr ? 5 : 4);
  const rate = (x: Pair, digits: number, better: "up" | "down" = "up") => ({ value: pct(x.now, digits), mv: moveOf(x.now, x.before, better), before: pct(x.before, digits) });
  const open = rate(p.open, 1);
  const click = rate(p.click, 2);
  const order = rate(p.orderRate, 2);
  return (
    <StatRow height={62}>
      <Stat title={kind === "campaign" ? "Recipients" : "Recipients"} value={int(p.recipients.now)} mv={moveOf(p.recipients.now, p.recipients.before, "none")} before={int(p.recipients.before)} prior={prior} width={w} height={62} max={15} />
      <Rule />
      <Stat title="Open rate" value={open.value} mv={open.mv} before={open.before} prior={prior} width={w} height={62} max={15} />
      <Rule />
      <Stat title="Click rate" value={click.value} mv={click.mv} before={click.before} prior={prior} width={w} height={62} max={15} />
      <Rule />
      <Stat title="Placed order rate" value={order.value} mv={order.mv} before={order.before} prior={prior} width={w} height={62} max={15} />
      {withRpr && p.rpr ? (
        <>
          <Rule />
          <Stat title="Revenue per recipient" value={centsMoney(p.rpr.now, currency)} mv={moveOf(p.rpr.now, p.rpr.before)} before={centsMoney(p.rpr.before, currency)} prior={prior} width={w} height={62} max={15} />
        </>
      ) : null}
    </StatRow>
  );
}

type Col = { key: string; head: string; width?: number; align?: "left" | "right" };
const CAMPAIGN_COLS: Col[] = [
  { key: "name", head: "Campaign", align: "left" },
  { key: "date", head: "Sent", width: 38 },
  { key: "channel", head: "Type", width: 30 },
  { key: "recipients", head: "Recipients", width: 48 },
  { key: "open", head: "Open", width: 36 },
  { key: "click", head: "Click", width: 36 },
  { key: "orders", head: "Orders", width: 34 },
  { key: "orderRate", head: "Order rate", width: 42 },
  { key: "revenue", head: "Revenue", width: 56 },
  { key: "rpr", head: "Per recip.", width: 42 },
];
/** Every campaign in the period, compact: under the best and the lowest */
const COMPACT_COLS: Col[] = [
  { key: "name", head: "Campaign", align: "left" },
  { key: "date", head: "Sent", width: 36 },
  { key: "recipients", head: "Recipients", width: 48 },
  { key: "open", head: "Open", width: 36 },
  { key: "click", head: "Click", width: 36 },
  { key: "revenue", head: "Revenue", width: 54 },
  { key: "rpr", head: "Per recip.", width: 44 },
];

function cell(r: MessageRow, key: string, currency: string | null): string {
  switch (key) {
    case "date":
      return r.date ? day(r.date) : "–";
    case "channel":
      return r.channel === "sms" ? "SMS" : "Email";
    case "status":
      return r.status ? r.status.charAt(0).toUpperCase() + r.status.slice(1).toLowerCase() : "–";
    case "recipients":
      return int(r.recipients);
    case "open":
      return pct(r.openRate);
    case "click":
      return pct(r.clickRate, 2);
    case "orders":
      return int(r.orders);
    case "orderRate":
      return pct(r.orderRate, 2);
    case "revenue":
      return wholeMoney(r.revenue, currency);
    case "rpr":
      return centsMoney(rprOf(r.revenue, r.recipients), currency);
    default:
      return r.name;
  }
}

/** The columns picked for the email tables (the name always first): each header one click in the preview */
const pickedCols = (cols: Col[], keys: string[]) => cols.filter((c) => c.key === "name" || keys.includes(c.key));

function Table({ cols, rows, currency, foot, keys, hot }: { cols: Col[]; rows: (MessageRow & { muted?: boolean })[]; currency: string | null; foot?: string | null; keys?: string[]; hot?: HotOf }) {
  // A long list keeps each name to one line so it stays on the two pages
  const lines = rows.length > 8 ? 1 : 2;
  const th = { fontSize: 5.4, color: "#6f7f92", fontFamily: "Helvetica-Bold" as const, textTransform: "uppercase" as const, letterSpacing: 0.25 };
  const box = (c: Col) => (c.width ? { width: c.width } : { flex: 1, paddingRight: 8 });
  // A table that fits a page is one card that moves whole; a longer one runs across pages unframed, its header on each
  const framed = rows.length <= 18;
  return (
    <View style={framed ? [s.panel, { paddingVertical: 8, marginTop: GAP }] : { marginTop: GAP }} wrap={!framed}>
      <View style={s.th} fixed={!framed}>
        {cols.map((c) => (
          <View key={c.key} style={box(c)}>
            <Text style={[th, { textAlign: c.align ?? "right" }]}>{c.head}</Text>
            {hot && keys && c.key !== "name" ? <Hot href={hot(`col/${keys.indexOf(c.key)}`)} /> : null}
          </View>
        ))}
      </View>
      {rows.map((r, i) => (
        <View key={r.id} style={[s.tr, { paddingVertical: 5, borderBottomWidth: i === rows.length - 1 ? 0 : 1 }]} wrap={false}>
          {cols.map((c) =>
            c.key === "name" ? (
              <View key={c.key} style={box(c)}>
                <Text style={{ fontSize: 7.2, fontFamily: r.muted ? "Helvetica-Oblique" : "Helvetica-Bold", color: r.muted ? MUTED : INK, lineHeight: 1.25, maxLines: lines, textOverflow: "ellipsis" }}>{r.name}</Text>
                {audienceLines(r.audiences).sent || audienceLines(r.audiences).excluded ? (
                  <Text style={{ fontSize: 5.6, color: MUTED, lineHeight: 1.3, marginTop: 1.5, maxLines: 2, textOverflow: "ellipsis" }}>
                    {audienceLines(r.audiences).sent ? `Sent to ${audienceLines(r.audiences).sent}` : ""}
                    {audienceLines(r.audiences).sent && audienceLines(r.audiences).excluded ? " · " : ""}
                    {audienceLines(r.audiences).excluded ? `Excluded ${audienceLines(r.audiences).excluded}` : ""}
                  </Text>
                ) : null}
              </View>
            ) : (
              <Text key={c.key} style={[box(c), { fontSize: 7.2, textAlign: "right", color: r.muted ? MUTED : INK, fontFamily: c.key === "revenue" ? "Helvetica-Bold" : "Helvetica" }]}>
                {cell(r, c.key, currency)}
              </Text>
            ),
          )}
        </View>
      ))}
      {foot ? <Text style={[s.note, { marginTop: 4, paddingHorizontal: 5 }]}>{foot}</Text> : null}
    </View>
  );
}

const MAX_CAMPAIGNS = 14;
const CARD_H = 184;
const PIC_W = 122;

/** Placeholder for a card with no picture: a text message, or an email whose preview couldn't be read */
function NoPicture({ sms, height = CARD_H }: { sms: boolean; height?: number }) {
  return (
    <View style={{ width: PIC_W, height, backgroundColor: "#eef2f5", alignItems: "center", justifyContent: "center", paddingHorizontal: 12 }}>
      <Text style={{ fontSize: 8, fontFamily: "Helvetica-Bold", color: MUTED, textTransform: "uppercase", letterSpacing: 0.8 }}>{sms ? "SMS" : "Email"}</Text>
      <Text style={{ fontSize: 6.4, color: FAINT, marginTop: 3, textAlign: "center" }}>{sms ? "A text message" : "Preview not available"}</Text>
    </View>
  );
}

/** A text message as it arrived: a phone-grey panel holding the message in a bubble, in place of an email's picture */
function SmsPhone({ body, height }: { body: string; height: number }) {
  return (
    <View style={{ width: PIC_W, height, backgroundColor: "#eef2f5", paddingHorizontal: 10, paddingTop: 12, alignItems: "center" }}>
      <View style={{ width: 26, height: 3, borderRadius: 1.5, backgroundColor: "#d5dce3", marginBottom: 10 }} />
      <View style={{ alignSelf: "flex-start", maxWidth: PIC_W - 28, backgroundColor: "#ffffff", borderRadius: 9, borderBottomLeftRadius: 3, paddingHorizontal: 8, paddingVertical: 7 }}>
        <Text style={{ fontSize: 6.6, color: INK, lineHeight: 1.35, maxLines: Math.max(6, Math.floor((height - 60) / 9)), textOverflow: "ellipsis" }}>{body}</Text>
      </View>
      <Text style={{ position: "absolute", bottom: 8, left: 0, right: 0, textAlign: "center", fontSize: 5.8, fontFamily: "Helvetica-Bold", color: FAINT, letterSpacing: 0.8 }}>SMS</Text>
    </View>
  );
}

/** A rate against its bar: the track, the fill in the grade's colour and a tick where the bar sits */
function Gauge({ fill, mark, g }: { fill: number; mark: number; g: Grade | null }) {
  const c = g ? GRADE_TONE[g].fg : CAMPAIGN_HEX;
  return (
    <View style={{ height: 7, justifyContent: "center", marginTop: 4 }}>
      <View style={{ height: 3, borderRadius: 1.5, backgroundColor: "#edf1f4" }}>
        <View style={{ width: `${Math.max(2, fill * 100)}%`, height: 3, borderRadius: 1.5, backgroundColor: c }} />
      </View>
      <View style={{ position: "absolute", left: `${mark * 100}%`, top: 0, width: 1, height: 7, backgroundColor: INK, opacity: 0.55 }} />
    </View>
  );
}

function CardCell({ x, w }: { x: CardStat; w: number }) {
  return (
    <View style={{ width: w, height: 46, paddingRight: 8 }}>
      <Text style={[label, { fontSize: 6.2 }]}>{x.label}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", marginTop: 3, height: 14 }}>
        <Text style={{ fontSize: fitFont(x.value, w - (x.grade ? 44 : 10), x.strong ? 13.5 : 12.5), fontFamily: "Helvetica-Bold", color: INK, letterSpacing: -0.2, lineHeight: 1 }}>{x.value}</Text>
        <Badge g={x.grade ?? null} />
      </View>
      {x.gauge ? <Gauge fill={x.gauge.fill} mark={x.gauge.mark} g={x.grade ?? null} /> : null}
      {x.sub ? <Text style={{ fontSize: 6.2, color: MUTED, marginTop: x.gauge ? 1 : 4, maxLines: 1 }}>{x.sub}</Text> : null}
    </View>
  );
}

/** One campaign as the email itself (its top half, linked to the campaign in Klaviyo) beside its numbers against the bars */
type CardPick = { tone: "best" | "lowest"; why: string };
const PICK_H = CARD_H + 26;

function CampaignCard({ r, m, pic, total, look, pick }: { r: MessageRow; m: EmailMetrics; pic: string | null | undefined; total: number; look: Look; pick?: CardPick }) {
  const link = fromKlaviyo(m.source) ? klaviyoCampaignUrl(r.id) : null;
  const stats = cardStats(r, m.currency, m.revenueMeasured !== false);
  const right = INNER - 2 - PIC_W - 28;
  const cw = right / 3;
  const share = total > 0 && m.revenueMeasured !== false ? r.revenue / total : null;
  const aud = audienceLines(r.audiences);
  // Who it went to and who it left out: one more line under the numbers, so the card grows a little for it
  const audRows = (aud.sent ? 1 : 0) + (aud.excluded ? 1 : 0);
  const h = (pick ? PICK_H : CARD_H) + audRows * 9 + (audRows ? 4 : 0);
  const pickTone = pick?.tone === "best" ? GOOD : AMBER;
  // eslint-disable-next-line jsx-a11y/alt-text -- a PDF image, no alt prop
  const picture = pic ? <Image src={pic} style={{ width: PIC_W, height: h, objectFit: "cover", objectPosition: "top" }} /> : r.channel === "sms" && r.smsBody ? <SmsPhone body={r.smsBody} height={h} /> : <NoPicture sms={r.channel === "sms"} height={h} />;
  return (
    <View wrap={false} style={{ flexDirection: "row", height: h, backgroundColor: "#ffffff", borderWidth: 1, borderColor: LINE, borderRadius: 10, overflow: "hidden", marginTop: GAP }}>
      <View style={{ width: PIC_W, height: h, borderRightWidth: 1, borderRightColor: LINE }}>
        {link ? (
          <Link src={link} style={{ textDecoration: "none" }}>
            {picture}
          </Link>
        ) : (
          picture
        )}
      </View>
      <View style={{ flex: 1, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", height: 44 }}>
          <View style={{ flex: 1, paddingRight: 10 }}>
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              {pick ? (
                <View style={{ height: 11, borderRadius: 3, paddingHorizontal: 5, backgroundColor: pickTone.bg, justifyContent: "center", marginRight: 6 }}>
                  <Text style={{ fontSize: 6, fontFamily: "Helvetica-Bold", color: pickTone.fg, letterSpacing: 0.5 }}>{pick.tone === "best" ? "BEST PERFORMER" : "LOWEST PERFORMER"}</Text>
                </View>
              ) : null}
              <Text style={{ fontSize: 6.4, fontFamily: "Helvetica-Bold", color: look.primary, letterSpacing: 0.8, textTransform: "uppercase" }}>
                {r.date ? `Sent ${weekday(r.date)} ${day(r.date)}` : "Sent"} · {r.channel === "sms" ? "SMS" : "Email"}
              </Text>
            </View>
            <Text style={{ fontSize: 9.5, fontFamily: "Helvetica-Bold", color: INK, lineHeight: 1.22, marginTop: 3, maxLines: 2, textOverflow: "ellipsis" }}>{r.name}</Text>
          </View>
          {share != null ? (
            <View style={{ alignItems: "flex-end" }}>
              <Text style={{ fontSize: 14, fontFamily: "Helvetica-Bold", color: look.barsText, lineHeight: 1 }}>{`${Math.round(share * 100)}%`}</Text>
              <Text style={{ fontSize: 6.2, color: MUTED, marginTop: 2 }}>of campaign revenue</Text>
            </View>
          ) : null}
        </View>
        <View style={{ height: 1, backgroundColor: "#edf1f4", marginBottom: 9 }} />
        <View style={{ flexDirection: "row", flexWrap: "wrap", rowGap: 8 }}>
          {stats.map((x) => (
            <CardCell key={x.key} x={x} w={cw} />
          ))}
        </View>
        {pick ? (
          <Text style={{ fontSize: 7, color: INK, lineHeight: 1.3, marginTop: 6, maxLines: 2, textOverflow: "ellipsis", paddingRight: link ? 128 : 0 }}>
            <Text style={{ fontFamily: "Helvetica-Bold", color: pickTone.fg }}>Why: </Text>
            {pick.why}
          </Text>
        ) : null}
        {audRows ? (
          <View style={{ marginTop: 4, paddingRight: link ? 128 : 0 }}>
            {aud.sent ? (
              <Text style={{ fontSize: 6.2, color: MUTED, maxLines: 1, textOverflow: "ellipsis" }}>
                <Text style={{ fontFamily: "Helvetica-Bold", color: INK }}>Sent to: </Text>
                {aud.sent}
              </Text>
            ) : null}
            {aud.excluded ? (
              <Text style={{ fontSize: 6.2, color: MUTED, maxLines: 1, textOverflow: "ellipsis" }}>
                <Text style={{ fontFamily: "Helvetica-Bold", color: INK }}>Excluded: </Text>
                {aud.excluded}
              </Text>
            ) : null}
          </View>
        ) : null}
        {link ? (
          <Link src={link} style={{ position: "absolute", right: 14, bottom: 9, fontSize: 7.2, fontFamily: "Helvetica-Bold", color: look.primary, textDecoration: "none" }}>
            Open the campaign in Klaviyo ›
          </Link>
        ) : null}
      </View>
    </View>
  );
}

function CampaignPerformance({ m, keys, hot, images, look }: { m: EmailMetrics; keys: string[]; hot: HotOf; images: ChannelImages; look: Look }) {
  const d = m.detail!;
  const prior = priorWord(m);
  const n = d.campaigns.length;
  const before = d.campaign.sent.before ?? 0;
  if (!n)
    return (
      <View style={s.section} wrap={false}>
        <Head title="Campaign performance" />
        <View style={s.panel}>
          <Text style={{ fontSize: 8, color: INK }}>No campaigns were sent in {m.main.label}.</Text>
          <Text style={{ fontSize: 7.2, color: MUTED, marginTop: 3 }}>
            {before ? `The ${prior} before: ${before} ${before === 1 ? "campaign" : "campaigns"}, ${money(d.campaign.revenue.before, m.currency)} in revenue.` : `None were sent the ${prior} before either.`} Revenue this {prior} came from automated emails.
          </Text>
        </View>
      </View>
    );
  const measured = m.revenueMeasured !== false;
  const total = d.campaigns.reduce((a, r) => a + r.revenue, 0);
  const picks = campaignPicks(d.campaigns, { currency: m.currency, revenueMeasured: measured });
  if (picks) {
    // Several campaigns: the best and the lowest as cards with why, then every campaign in one compact table
    const cols = COMPACT_COLS.filter((col) => measured || (col.key !== "revenue" && col.key !== "rpr"));
    const by = picks.basis === "rpr" ? "revenue per recipient" : "click rate (revenue isn't tracked)";
    return (
      <View style={s.section}>
        <View wrap={false} minPresenceAhead={120}>
          <Head title="Campaign performance" sub={`${n} campaigns sent · the best and the lowest by ${by}, each with why, then every campaign`} />
          <PerfCells p={d.campaign} prior={prior} kind="campaign" currency={m.currency} measured={measured} />
        </View>
        <CampaignCard r={picks.best.row} m={m} pic={images[shotKey(picks.best.row.id)]} total={total} look={look} pick={{ tone: "best", why: picks.best.why }} />
        <CampaignCard r={picks.lowest.row} m={m} pic={images[shotKey(picks.lowest.row.id)]} total={total} look={look} pick={{ tone: "lowest", why: picks.lowest.why }} />
        <View wrap={n > 18} minPresenceAhead={60}>
          <Text style={[s.h3, { marginTop: 14 }]}>{`All ${n} campaigns, by send date`}</Text>
          <Table cols={cols} rows={d.campaigns} currency={m.currency} foot={measured ? "Per recipient: revenue over everyone the campaign went to." : null} />
        </View>
      </View>
    );
  }
  const cards = cardCampaigns(d.campaigns);
  const carded = new Set(cards.map((c) => c.id));
  const others = d.campaigns.filter((c) => !carded.has(c.id));
  const shown = others.slice(0, MAX_CAMPAIGNS);
  const rest = others.slice(MAX_CAMPAIGNS);
  const foot = rest.length ? `And ${rest.length} more ${rest.length === 1 ? "campaign" : "campaigns"} earning ${money(rest.reduce((a, r) => a + r.revenue, 0), m.currency)}.` : null;
  const card = (r: MessageRow) => <CampaignCard key={r.id} r={r} m={m} pic={images[shotKey(r.id)]} total={total} look={look} />;
  return (
    <View style={s.section}>
      {/* The heading and the totals stay together, and never sit alone at the foot of a page */}
      <View wrap={false} minPresenceAhead={120}>
        <Head title="Campaign performance" sub={`${n} ${n === 1 ? "campaign" : "campaigns"} sent · against the ${prior} before`} />
        <PerfCells p={d.campaign} prior={prior} kind="campaign" currency={m.currency} measured={measured} />
      </View>
      {cards.map(card)}
      {shown.length ? (
        <View wrap={shown.length > 18} minPresenceAhead={60}>
          <Text style={[s.h3, { marginTop: 14 }]}>{`The other ${others.length} ${others.length === 1 ? "campaign" : "campaigns"}`}</Text>
          <Table cols={pickedCols(CAMPAIGN_COLS, keys)} rows={shown} currency={m.currency} foot={foot} keys={keys} hot={hot} />
        </View>
      ) : null}
    </View>
  );
}

const FLOW_CARD_H = 88;

/** A small labelled number on a flow card, coloured by its grade against Kaizen's bar when it has one */
function FlowMini({ label: text, value, g, mv, sub }: { label: string; value: string; g?: Grade | null; mv?: Move; sub?: string | null }) {
  return (
    <View style={{ flex: 1, paddingRight: 6 }}>
      <Text style={{ fontSize: 5.6, color: "#6f7f92", fontFamily: "Helvetica-Bold", textTransform: "uppercase", letterSpacing: 0.4, maxLines: 1 }}>{text}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", marginTop: 2 }}>
        <Text style={{ fontSize: 9, fontFamily: "Helvetica-Bold", color: g ? GRADE_TONE[g].fg : INK, lineHeight: 1 }}>{value}</Text>
        {mv ? (
          <View style={{ marginLeft: 4 }}>
            <Chip mv={mv} />
          </View>
        ) : null}
      </View>
      {sub ? <Text style={{ fontSize: 5.6, color: FAINT, marginTop: 1.5, maxLines: 1 }}>{sub}</Text> : null}
    </View>
  );
}

/** One automated email: its revenue with the move against the period before, revenue per recipient, opens and clicks against the bars, and its share of the flow revenue as a bar */
function FlowCard({ v, m, w, look }: { v: FlowCardView; m: EmailMetrics; w: number; look: Look }) {
  const r = v.row;
  const c = m.currency;
  const measured = m.revenueMeasured !== false;
  const rev = wholeMoney(r.revenue, c);
  const mv = measured && r.prevRevenue != null ? moveOf(r.revenue, r.prevRevenue) : null;
  const status = r.status ? r.status.charAt(0).toUpperCase() + r.status.slice(1).toLowerCase() : null;
  return (
    <View wrap={false} style={{ width: w, height: FLOW_CARD_H, backgroundColor: v.top ? look.barsSoft : "#ffffff", borderWidth: v.top ? 1.4 : 1, borderColor: v.top ? look.primary : LINE, borderRadius: 10, paddingHorizontal: 11, paddingVertical: 9 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", height: 32 }}>
        <View style={{ flex: 1, paddingRight: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", height: 11 }}>
            {v.top ? (
              <View style={{ height: 10, borderRadius: 3, paddingHorizontal: 4, backgroundColor: GOOD.bg, justifyContent: "center", marginRight: 5 }}>
                <Text style={{ fontSize: 5.6, fontFamily: "Helvetica-Bold", color: GOOD.fg, letterSpacing: 0.5 }}>TOP AUTOMATION</Text>
              </View>
            ) : null}
            {status ? <Text style={{ fontSize: 5.8, color: MUTED, maxLines: 1 }}>{status}</Text> : null}
          </View>
          <Text style={{ fontSize: 8.6, fontFamily: "Helvetica-Bold", color: INK, lineHeight: 1.2, marginTop: 3, maxLines: 1, textOverflow: "ellipsis" }}>{r.name}</Text>
        </View>
        {measured ? (
          <View style={{ alignItems: "flex-end" }}>
            <Text style={{ fontSize: fitFont(rev, w * 0.32, 14), fontFamily: "Helvetica-Bold", color: look.barsText, lineHeight: 1 }}>{rev}</Text>
            <View style={{ marginTop: 4, flexDirection: "row", alignItems: "center" }}>
              {mv ? <Chip mv={mv} /> : <Text style={{ fontSize: 5.8, color: FAINT }}>{r.prevRevenue == null ? "New this period" : ""}</Text>}
            </View>
          </View>
        ) : null}
      </View>
      <View style={{ flexDirection: "row", marginTop: 6, height: 26 }}>
        {measured ? <FlowMini label="Revenue per recipient" value={centsMoney(v.rpr, c)} mv={moveOf(v.rpr, r.prevRpr)} /> : <FlowMini label="Recipients" value={int(r.recipients)} />}
        <FlowMini label="Open rate" value={pct(r.openRate, 1)} />
        <FlowMini label="Click rate" value={pct(r.clickRate, 2)} />
        {measured ? <FlowMini label="Orders" value={int(r.orders)} sub={`${int(r.recipients)} recipients`} /> : null}
      </View>
      {measured && v.share != null ? (
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: 3, height: 10 }}>
          <View style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: "#edf1f4" }}>
            <View style={{ width: `${Math.max(2, v.share * 100)}%`, height: 4, borderRadius: 2, backgroundColor: v.top ? look.primary : look.bars }} />
          </View>
          <Text style={{ fontSize: 6.2, fontFamily: "Helvetica-Bold", color: MUTED, marginLeft: 6, width: 78, textAlign: "right" }}>{`${shareText(v.share)} of automation revenue`}</Text>
        </View>
      ) : null}
    </View>
  );
}

function FlowPerformance({ m, look }: { m: EmailMetrics; look: Look }) {
  const d = m.detail!;
  if (!d.flow) return <LegacyFlows m={m} />;
  const prior = priorWord(m);
  const sent = d.flow.sent.now ?? 0;
  const view = flowCardViews(d.flows, d.flowsOther);
  const [first, ...rest] = view.cards;
  const half = (INNER - GAP) / 2;
  const pairs: (typeof view.cards)[] = [];
  for (let i = 0; i < rest.length; i += 2) pairs.push(rest.slice(i, i + 2));
  const o = view.other;
  return (
    <View style={s.section}>
      <View wrap={false}>
        <Head title="Automated email performance" sub={`${sent} ${sent === 1 ? "automated email" : "automated emails"} sent · against the ${prior} before`} />
        <PerfCells p={d.flow} prior={prior} kind="flow" currency={m.currency} measured={m.revenueMeasured !== false} />
        {first ? (
          <View style={{ marginTop: GAP }}>
            <FlowCard v={first} m={m} w={INNER} look={look} />
          </View>
        ) : null}
      </View>
      {pairs.map((p) => (
        <View key={p[0].row.id} wrap={false} style={{ flexDirection: "row", gap: GAP, marginTop: GAP }}>
          {p.map((v) => (
            <FlowCard key={v.row.id} v={v} m={m} w={half} look={look} />
          ))}
        </View>
      ))}
      {o ? (
        <View wrap={false} style={[s.panel, { marginTop: GAP, flexDirection: "row", alignItems: "center", paddingVertical: 7 }]}>
          <Text style={{ flex: 1, fontSize: 7.2, fontFamily: "Helvetica-Oblique", color: MUTED }}>{o.row.name}, added up</Text>
          {m.revenueMeasured !== false ? <Text style={{ fontSize: 7.2, color: MUTED, marginRight: 14 }}>{`${centsMoney(o.rpr, m.currency)} per recipient`}</Text> : null}
          <Text style={{ fontSize: 7.2, fontFamily: "Helvetica-Bold", color: INK }}>{m.revenueMeasured !== false ? `${wholeMoney(o.row.revenue, m.currency)}${o.share != null ? ` · ${shareText(o.share)}` : ""}` : `${int(o.row.recipients)} recipients`}</Text>
        </View>
      ) : null}
    </View>
  );
}


// ─── Deliverability and subscribers ────────────────────────────────────────

function KeyLine({ name, value, note, mv, color }: { name: string; value: string; note?: string; mv: Move; color?: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", height: 20, borderTopWidth: 1, borderTopColor: "#f0f3f6" }}>
      <Text style={{ flex: 1, fontSize: 7.2, color: INK, maxLines: 1 }}>{name}</Text>
      {note ? <Text style={{ width: 62, fontSize: 6, color: FAINT, textAlign: "right", marginRight: 6, maxLines: 1 }}>{note}</Text> : null}
      <Text style={{ width: 52, fontSize: 7.6, fontFamily: "Helvetica-Bold", color: color ?? INK, textAlign: "right", marginRight: 6 }}>{value}</Text>
      <View style={{ width: 50, alignItems: "flex-end" }}>{mv ? <Chip mv={mv} /> : <Text style={{ fontSize: 6, color: FAINT }}>–</Text>}</View>
    </View>
  );
}

/** Green under the healthy line, amber under the line providers act on, red past it */
const health = (rate: number | null, b: { warn: number; bad: number }) => (rate == null ? INK : rate <= b.warn ? GOOD.fg : rate <= b.bad ? AMBER.fg : BAD.fg);

function Deliverability({ m, width }: { m: EmailMetrics; width: number }) {
  const dl = m.detail!.deliverability!;
  return (
    <View style={[s.panel, { width, paddingVertical: 11 }]}>
      <View style={{ flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 8, height: 30 }}>
        <View style={{ flexShrink: 1 }}>
          <Text style={label}>Deliverability</Text>
          <Text style={{ fontSize: 6.2, color: MUTED, marginTop: 3, maxLines: 2 }}>Campaign email to {int(dl.recipients.now)} recipients</Text>
        </View>
      </View>
      <KeyLine name="Bounce rate" value={pct(dl.bounce.now, 2)} note={`healthy < ${pct(BENCHMARKS.bounce.warn, 0)}`} mv={moveOf(dl.bounce.now, dl.bounce.before, "down")} color={health(dl.bounce.now, BENCHMARKS.bounce)} />
      <KeyLine name="Spam complaints" value={pct(dl.spam.now, 3)} note={`healthy < ${pct(BENCHMARKS.spam.warn, 2)}`} mv={moveOf(dl.spam.now, dl.spam.before, "down")} color={health(dl.spam.now, BENCHMARKS.spam)} />
      <KeyLine name="Unsubscribe rate" value={pct(dl.unsub.now, 2)} note={`healthy < ${pct(BENCHMARKS.unsubscribe.warn, 1)}`} mv={moveOf(dl.unsub.now, dl.unsub.before, "down")} color={health(dl.unsub.now, BENCHMARKS.unsubscribe)} />
    </View>
  );
}

function Subscribers({ m, width }: { m: EmailMetrics; width: number }) {
  const sb = m.detail!.subscribers!;
  const grew = sb.total.now != null && sb.total.before != null ? sb.total.now - sb.total.before : null;
  const net = sb.joined.now != null ? (sb.joined.now ?? 0) - (sb.left.now ?? 0) : null;
  // Without the list's size, the box leads with the net growth instead
  const big = sb.total.now != null ? int(sb.total.now) : signed(net);
  return (
    <View style={[s.panel, { width, paddingVertical: 11 }]}>
      <View style={{ flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 8, height: 30 }}>
        <View style={{ flexShrink: 1 }}>
          <Text style={label}>{sb.total.now != null ? "Email subscribers" : "Net new subscribers"}</Text>
          <Text style={{ fontSize: 6.2, color: MUTED, marginTop: 3, maxLines: 2 }}>{grew != null ? `${signed(grew)} on the main list this ${priorWord(m)}` : sb.total.now != null ? "The main list" : "Joins less unsubscribes"}</Text>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Text style={{ fontSize: fitFont(big, 90, 20), fontFamily: "Helvetica-Bold", lineHeight: 1 }}>{big}</Text>
          <View style={{ marginTop: 3 }}>
            <Chip mv={sb.total.now != null ? moveOf(sb.total.now, sb.total.before) : null} />
          </View>
        </View>
      </View>
      <KeyLine name="New subscribers" value={int(sb.joined.now)} note={sb.joined.before != null ? `prior ${int(sb.joined.before)}` : undefined} mv={moveOf(sb.joined.now, sb.joined.before)} />
      <KeyLine name="Unsubscribed" value={int(sb.left.now)} note={sb.left.before != null ? `prior ${int(sb.left.before)}` : undefined} mv={moveOf(sb.left.now, sb.left.before, "down")} />
      {sb.total.now != null ? <KeyLine name="Net growth" value={signed(net)} mv={null} /> : null}
    </View>
  );
}

function ListAndDelivery({ m }: { m: EmailMetrics }) {
  const d = m.detail!;
  const both = d.deliverability && d.subscribers;
  if (!d.deliverability && !d.subscribers) return null;
  const w = both ? (INNER - GAP) / 2 : INNER;
  return (
    <View style={s.section} wrap={false}>
      <Head title={both ? "Deliverability and subscriber growth" : d.deliverability ? "Deliverability" : "Subscriber growth"} sub={`${m.main.label} against the ${priorWord(m)} before`} />
      <View style={{ flexDirection: "row", gap: GAP }}>
        {d.deliverability ? <Deliverability m={m} width={w} /> : null}
        {d.subscribers ? <Subscribers m={m} width={w} /> : null}
      </View>
    </View>
  );
}

// ─── Older email reports (stored before the detail) ────────────────────────

function Thumb({ src }: { src: string | null | undefined }) {
  // eslint-disable-next-line jsx-a11y/alt-text -- a PDF image, no alt prop
  return src ? <Image src={src} style={s.thumb} /> : <View style={s.thumbBlank} />;
}

const th = [s.thText];
function LegacyCampaigns({ m, images }: { m: EmailMetrics; images: ChannelImages }) {
  if (!m.campaigns.length) return null;
  const list = m.campaigns.slice(0, 6);
  return (
    <View style={s.section}>
      <Head title="Campaigns" sub={`${m.campaignsTotal} sent in ${m.main.label} · best by revenue`} />
      <View style={s.panel}>
        <View style={s.th}>
          <View style={{ width: 34 }} />
          <Text style={[...th, { flex: 1 }]}>Campaign</Text>
          <Text style={[...th, { width: 44, textAlign: "right" }]}>Sent</Text>
          <Text style={[...th, { width: 40, textAlign: "right" }]}>Open</Text>
          <Text style={[...th, { width: 40, textAlign: "right" }]}>Click</Text>
          <Text style={[...th, { width: 52, textAlign: "right" }]}>Revenue</Text>
        </View>
        {list.map((c) => (
          <View key={c.id} style={s.tr} wrap={false}>
            <View style={{ width: 34 }}>
              <Thumb src={images[c.id]} />
            </View>
            <View style={{ flex: 1, paddingRight: 6 }}>
              <Text style={s.adName}>{c.name.slice(0, 60)}</Text>
              <Text style={s.adMeta}>
                {day(c.sendDay)}
                {c.subject ? ` · ${c.subject.slice(0, 64)}` : ""}
              </Text>
            </View>
            <Text style={[s.td, { width: 44 }]}>{int(c.recipients)}</Text>
            <Text style={[s.td, { width: 40 }]}>{pct(c.openRate)}</Text>
            <Text style={[s.td, { width: 40 }]}>{pct(c.clickRate, 2)}</Text>
            <Text style={[s.td, { width: 52, fontFamily: "Helvetica-Bold" }]}>{money(c.revenue, m.currency)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** The flows as Klaviyo's 30-day report gives them, for when their days aren't stored */
function LegacyFlows({ m }: { m: EmailMetrics }) {
  if (!m.flows.length) return null;
  const max = Math.max(...m.flows.map((f) => f.revenue), 1);
  return (
    <View style={s.section} wrap={false}>
      <Head title="Automated emails" sub={`Revenue by flow · ${m.flowsBasis}`} />
      <View style={s.panel}>
        {m.flows.slice(0, 8).map((f) => (
          <View key={f.id} style={s.barBlock}>
            <View style={s.barTop}>
              <Text style={s.barLabel}>
                {f.name.slice(0, 54)}
                {(f.status ?? "").toLowerCase() === "live" ? "" : `  (${f.status ?? "not live"})`}
              </Text>
              <Text style={s.barValue}>{money(f.revenue, m.currency)}</Text>
            </View>
            <View style={[s.barTrack, { backgroundColor: "#edf1f4" }]}>
              <View style={{ height: 7, width: `${Math.max(2, (f.revenue / max) * 100)}%`, backgroundColor: "#4f7cff" }} />
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

function LegacyListHealth({ m }: { m: EmailMetrics }) {
  return (
    <View style={s.section} wrap={false}>
      <Head title="List and deliverability" sub="Bounces, spam complaints and unsubscribes against healthy lines" />
      <View style={s.insights}>
        <View style={s.insight}>
          <Text style={s.insightTitle}>List growth</Text>
          <Text style={s.insightText}>
            {m.list.net != null ? `${signed(m.list.net)} net new subscribers (${int(m.list.subscribed)} joined, ${int(m.list.unsubscribed)} left).` : "No list movement was read for this period."}
            {m.list.profiles != null ? ` ${int(m.list.profiles)} profiles in the main list.` : ""}
          </Text>
        </View>
        <View style={s.insight}>
          <Text style={s.insightTitle}>{m.flags.length ? "Worth watching" : "Healthy"}</Text>
          <Text style={s.insightText}>{m.flags.length ? m.flags.slice(0, 3).map((f) => f.text).join(" ") : `Bounce ${pct(m.now.bounceRate, 2)}, spam ${pct(m.now.spamRate, 3)} and unsubscribe ${pct(m.now.unsubscribeRate, 2)} rates are inside healthy lines.`}</Text>
        </View>
      </View>
    </View>
  );
}

// Social: drawn by social-doc.tsx (the glance, the month to date, the takeaways, the chart, the platforms and the posts)

// ─── Both ──────────────────────────────────────────────────────────────────

function Takeaways({ m, sections, look, hot }: { m: EmailMetrics | SocialMetrics; sections: Sections; look: Look; hot: HotOf }) {
  const items = takeawaysFor(m, sections.takeaways);
  if (!items.length) return null;
  return (
    <View style={s.section} wrap={false}>
      <Head title="Key takeaways" sub={`From this period's ${channelName(m.platform).toLowerCase()} numbers`} />
      <View style={s.insights}>
        {items.map((t, i) => (
          <View key={i} style={s.insight}>
            <View style={{ width: 14, height: 2.5, borderRadius: 2, backgroundColor: look.primary, marginBottom: 8 }} />
            <View>
              <Text style={s.insightTitle}>{t.title}</Text>
              <Hot href={hot(`text/takeaway-${i}-title`)} />
            </View>
            <View>
              <Text style={s.insightText}>{t.text}</Text>
              <Hot href={hot(`text/takeaway-${i}-text`)} />
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

/**
 * Our notes: the write-up as a last page, only on the copy saved to the client's Drive (the client's PDF never carries
 * it), the same as the ads reports: the headline and summary, what we did, are doing and will do, the highlights, and
 * anything the owner added. Every line is a click target in the preview.
 */
function Notes({ input, look, hot }: { input: ChannelPdfInput; look: Look; hot: HotOf }) {
  if (!input.withNotes) return null;
  const n = notesOf(input.sections);
  const list = (xs: string[] | undefined) => (Array.isArray(xs) ? xs.map((x) => String(x ?? "").trim()) : []);
  const highlights = list(input.sections.highlights).filter(Boolean);
  const groups = [...n.groups, ...(highlights.length ? [{ title: "Highlights", items: highlights }] : [])];
  const extras = String(input.extras ?? "").trim();
  if (n.empty && !highlights.length && !extras) return null;
  const places: Record<string, "did" | "doing" | "next" | "highlights"> = { "What we did": "did", "What we're doing": "doing", "What's next": "next", Highlights: "highlights" };
  return (
    <View break>
      <View style={s.head}>
        <Text style={s.h2}>Our notes</Text>
        <Text style={s.sub}>{input.metrics.main.label}</Text>
      </View>
      {n.headline || n.summary ? (
        <View style={[s.panel, { borderLeftWidth: 3, borderLeftColor: look.primary, marginBottom: 8 }]}>
          {n.headline ? (
            <View style={{ marginBottom: n.summary ? 5 : 0 }}>
              <Text style={{ fontSize: 11, fontFamily: "Helvetica-Bold", lineHeight: 1.3 }}>{n.headline}</Text>
              <Hot href={hot("text/headline")} />
            </View>
          ) : null}
          {n.summary ? (
            <View>
              <Text style={{ fontSize: 8.4, lineHeight: 1.5, color: "#33475b" }}>{n.summary}</Text>
              <Hot href={hot("text/summary")} />
            </View>
          ) : null}
        </View>
      ) : null}
      {groups.map((g) => {
        const key = places[g.title];
        const all = list(input.sections[key]);
        // each printed point with its place in the owner's full list (blank ones aren't printed but still count)
        let seen = -1;
        const at = g.items.map((text) => (seen = all.indexOf(text, seen + 1)));
        return (
          <View key={g.title} style={[s.panel, { marginBottom: 8 }]} wrap={false}>
            <Text style={[s.h3, { marginBottom: 6 }]}>{g.title}</Text>
            {g.items.map((x, j) => (
              <View key={j} style={{ flexDirection: "row", marginBottom: 3 }}>
                <Text style={{ width: 9, color: look.primary, fontFamily: "Helvetica-Bold", fontSize: 8 }}>•</Text>
                <Text style={{ flex: 1, fontSize: 8, lineHeight: 1.45, color: "#33475b" }}>{x}</Text>
                <Hot href={at[j] >= 0 ? hot(`text/${key}/${at[j]}`) : null} />
              </View>
            ))}
          </View>
        );
      })}
      {extras ? (
        <View style={[s.panel, { marginBottom: 8 }]} wrap={false}>
          <Text style={[s.h3, { marginBottom: 6 }]}>Also</Text>
          <Text style={{ fontSize: 8, lineHeight: 1.45, color: "#33475b" }}>{extras}</Text>
          <Hot href={hot("text/extras")} />
        </View>
      ) : null}
    </View>
  );
}

function Footer({ input }: { input: ChannelPdfInput }) {
  const src = input.metrics.platform === "klaviyo" ? (input.metrics.source ?? "Klaviyo") : "Meta (Facebook and Instagram insights)";
  return (
    <>
      <View style={s.footer} fixed>
        <Text style={[s.footText, { maxWidth: 250 }]}>
          {input.whiteLabel ? `Prepared for ${input.client}` : `Prepared for ${input.client} · Kaizen`} | Data: {src}, synced daily
        </Text>
        {isEngagement(input.metrics) ? (
          <Text style={[s.footText, { textAlign: "right", flex: 1 }]}>{measuresShort((input.metrics as EmailMetrics).engagement!, (input.metrics as EmailMetrics).source ?? null)}</Text>
        ) : <Text style={[s.footText, { textAlign: "right", flex: 1 }]}>{input.metrics.platform === "klaviyo" ? (input.metrics.revenueMeasured === false ? "Rates are of delivered email" : `Revenue and orders are attributed by ${input.metrics.source ?? "Klaviyo"} · rates are of delivered email · order rate is orders over recipients`) : "Engagement rate is interactions over reach"}</Text>}
      </View>
      <Text style={s.pageNumber} fixed render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
    </>
  );
}

// ─── Each conversion metric side by side ───────────────────────────────────

/** Several metrics counting as the sale (Toast orders, a custom POS's...): each one's revenue, conversions and store total, primary first */
function MetricSides({ m }: { m: EmailMetrics }) {
  const list = m.byMetric ?? [];
  if (list.length < 2) return null;
  const c = m.currency;
  const prior = priorWord(m);
  const th = { fontSize: 5.4, color: "#6f7f92", fontFamily: "Helvetica-Bold" as const, textTransform: "uppercase" as const, letterSpacing: 0.25, textAlign: "right" as const };
  const cellMove = (now: number | null, before: number | null, f: (x: number | null) => string) => (
    <View style={{ width: 118, alignItems: "flex-end" }}>
      <Text style={{ fontSize: 8, fontFamily: "Helvetica-Bold", color: INK }}>{f(now)}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", marginTop: 2 }}>
        <Chip mv={moveOf(now, before)} />
        <Text style={{ fontSize: 5.8, color: MUTED }}>{before == null ? "No prior number" : `vs ${f(before)}`}</Text>
      </View>
    </View>
  );
  const cash = (v: number | null) => (v == null ? "–" : wholeMoney(v, c));
  return (
    <View style={[s.panel, { paddingVertical: 8, marginTop: GAP }]} wrap={false}>
      <View style={s.th}>
        <Text style={[th, { flex: 1, textAlign: "left" }]}>Counts as the sale</Text>
        <Text style={[th, { width: 118 }]}>Attributed revenue</Text>
        <Text style={[th, { width: 118 }]}>Conversions</Text>
        <Text style={[th, { width: 90 }]}>Store total</Text>
      </View>
      {list.map((x, i) => (
        <View key={x.id} style={[s.tr, { paddingVertical: 5, borderBottomWidth: i === list.length - 1 ? 0 : 1 }]}>
          <View style={{ flex: 1, paddingRight: 8 }}>
            <Text style={{ fontSize: 7.4, fontFamily: "Helvetica-Bold", color: INK, maxLines: 1, textOverflow: "ellipsis" }}>{x.name}</Text>
            <Text style={{ fontSize: 5.8, color: FAINT, marginTop: 1.5 }}>{i === 0 ? "Primary · the revenue above" : `Ranked ${i + 1}`}</Text>
          </View>
          {cellMove(x.revenue.now, x.revenue.before, cash)}
          {cellMove(x.conversions.now, x.conversions.before, int)}
          <Text style={{ width: 90, fontSize: 7.4, textAlign: "right", color: MUTED }}>{cash(x.store.now)}</Text>
        </View>
      ))}
      <Text style={[s.note, { marginTop: 4, paddingHorizontal: 5 }]}>Each metric is attributed by {m.source ?? "Klaviyo"} on its own, against the {prior} before; the store total counts every order of that metric, from email or not.</Text>
    </View>
  );
}

// ─── Location breakdown (multi-location clients) ───────────────────────────

type LocViews = ReturnType<typeof locationViews>;
const LOC_HERO_H = 104;
const LOC_ROW = 15;

/** Where a metric's located orders came from, in a few words */
function fromWhat(x: LocationMetricBreakdown): string {
  const flows = x.columns.some((col) => col.id === "flows");
  const camps = x.columns.some((col) => col.id !== "flows");
  return camps && flows ? "campaigns and flows" : flows ? "automated emails" : "campaigns";
}

/** The headline: what email earned across the restaurants, how many converted, the orders, and who led */
function LocationHero({ x, v, m, look }: { x: LocationMetricBreakdown; v: LocViews; m: EmailMetrics; look: Look }) {
  const c = m.currency;
  const lead = v.leader;
  const stats = [
    { label: "Locations converted", value: int(x.ranked.length), sub: fromWhat(x) },
    { label: "Attributed orders", value: int(x.conversions), sub: x.conversions > 0 ? `${wholeMoney(x.revenue / x.conversions, c)} per order` : null },
    { label: "Per location", value: wholeMoney(v.average, c), sub: "average revenue" },
  ];
  const leftW = 140;
  const statW = 76;
  return (
    <View style={{ height: LOC_HERO_H, borderRadius: 12, overflow: "hidden" }}>
      <Svg width={INNER} height={LOC_HERO_H} viewBox={`0 0 ${INNER} ${LOC_HERO_H}`} style={{ position: "absolute", top: 0, left: 0 }}>
        <Defs>
          <LinearGradient id="locband" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={look.hero} />
            <Stop offset="1" stopColor={look.heroEdge} />
          </LinearGradient>
        </Defs>
        <Rect x={0} y={0} width={INNER} height={LOC_HERO_H} fill="url(#locband)" />
        <Circle cx={INNER - 40} cy={LOC_HERO_H + 10} r={96} fill="none" stroke="#ffffff" strokeOpacity={0.09} strokeWidth={1} />
        <Circle cx={INNER - 40} cy={LOC_HERO_H + 10} r={128} fill="none" stroke="#ffffff" strokeOpacity={0.05} strokeWidth={24} />
      </Svg>
      <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingVertical: 16, flexDirection: "row", alignItems: "stretch" }}>
        <View style={{ width: leftW, justifyContent: "space-between" }}>
          <Text style={[s.eyebrow, { color: look.heroSoft }]}>Attributed revenue</Text>
          <View>
            <Text style={{ fontSize: fitFont(wholeMoney(x.revenue, c), leftW - 10, 26), fontFamily: "Helvetica-Bold", color: "#ffffff", letterSpacing: -0.5, lineHeight: 1 }}>{wholeMoney(x.revenue, c)}</Text>
            <Text style={{ fontSize: 7.4, color: "#d8dde3", marginTop: 5 }}>across {x.ranked.length} {x.ranked.length === 1 ? "restaurant" : "restaurants"}, {m.main.label}</Text>
          </View>
        </View>
        {stats.map((st) => (
          <View key={st.label} style={{ width: statW, paddingLeft: 12, borderLeftWidth: 1, borderLeftColor: "rgba(255,255,255,0.2)", justifyContent: "flex-end" }}>
            <Text style={{ fontSize: 6.2, color: look.heroSoft, fontFamily: "Helvetica-Bold", textTransform: "uppercase", letterSpacing: 0.7, maxLines: 2, height: 16, lineHeight: 1.25 }}>{st.label}</Text>
            <Text style={{ fontSize: fitFont(st.value, statW - 14, 15), fontFamily: "Helvetica-Bold", color: "#ffffff", marginTop: 4, lineHeight: 1 }}>{st.value}</Text>
            {st.sub ? <Text style={{ fontSize: 6.4, color: "#d8dde3", marginTop: 3, maxLines: 1, textOverflow: "ellipsis" }}>{st.sub}</Text> : null}
          </View>
        ))}
        {lead ? (
          <View style={{ flex: 1, marginLeft: 12, backgroundColor: "#ffffff", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 9, justifyContent: "space-between" }}>
            <Text style={{ fontSize: 6.2, color: look.primary, fontFamily: "Helvetica-Bold", textTransform: "uppercase", letterSpacing: 0.7 }}>Top location</Text>
            <Text style={{ fontSize: 8.6, fontFamily: "Helvetica-Bold", color: INK, lineHeight: 1.2, maxLines: 2, textOverflow: "ellipsis" }}>{lead.name}</Text>
            <View style={{ flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between" }}>
              <Text style={{ fontSize: 13, fontFamily: "Helvetica-Bold", color: INK, lineHeight: 1 }}>{wholeMoney(lead.revenue, c)}</Text>
              <Text style={{ fontSize: 7.4, fontFamily: "Helvetica-Bold", color: look.barsText }}>{shareText(lead.share)} share</Text>
            </View>
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** Every location (or the best fifteen and the rest together) as a bar of its revenue, with its share and orders */
function LocationBars({ v, currency, look }: { v: LocViews; currency: string | null; look: Look }) {
  const max = v.shown[0]?.revenue ?? 0;
  const nameW = 132;
  return (
    <View style={[s.panel, { paddingVertical: 10, paddingHorizontal: 12 }]}>
      {v.shown.map((r) => {
        const top3 = r.rank <= 3;
        return (
          <View key={r.full} style={{ flexDirection: "row", alignItems: "center", height: LOC_ROW }}>
            <Text style={{ width: 16, fontSize: 7.2, fontFamily: top3 ? "Helvetica-Bold" : "Helvetica", color: top3 ? INK : FAINT }}>{r.rank}</Text>
            <Text style={{ width: nameW, fontSize: 7.4, fontFamily: top3 ? "Helvetica-Bold" : "Helvetica", color: INK, maxLines: 1, textOverflow: "ellipsis", paddingRight: 8 }}>{r.name}</Text>
            <View style={{ flex: 1, height: 8, justifyContent: "center" }}>
              <View style={{ width: `${max > 0 ? Math.max(1.5, (r.revenue / max) * 100) : 0}%`, height: 8, borderRadius: 2.5, backgroundColor: top3 ? look.bars : tint(look.bars, 0.42) }} />
            </View>
            <Text style={{ width: 56, fontSize: 7.4, fontFamily: "Helvetica-Bold", color: INK, textAlign: "right" }}>{wholeMoney(r.revenue, currency)}</Text>
            <Text style={{ width: 34, fontSize: 7.2, color: top3 ? look.barsText : MUTED, fontFamily: top3 ? "Helvetica-Bold" : "Helvetica", textAlign: "right" }}>{shareText(r.share)}</Text>
            <Text style={{ width: 52, fontSize: 7.2, color: MUTED, textAlign: "right" }}>
              {int(r.conversions)} {r.conversions === 1 ? "order" : "orders"}
            </Text>
          </View>
        );
      })}
      {v.rest ? (
        <View style={{ flexDirection: "row", alignItems: "center", height: LOC_ROW + 2, borderTopWidth: 1, borderTopColor: "#edf1f4", marginTop: 3 }}>
          <Text style={{ width: 16 }} />
          <Text style={{ flex: 1, fontSize: 7.4, fontFamily: "Helvetica-Oblique", color: MUTED }}>
            And {v.rest.count} more {v.rest.count === 1 ? "location" : "locations"}, each in the table below
          </Text>
          <Text style={{ width: 56, fontSize: 7.4, fontFamily: "Helvetica-Bold", color: MUTED, textAlign: "right" }}>{wholeMoney(v.rest.revenue, currency)}</Text>
          <Text style={{ width: 34, fontSize: 7.2, color: MUTED, textAlign: "right" }}>{shareText(v.rest.share)}</Text>
          <Text style={{ width: 52 }} />
        </View>
      ) : null}
    </View>
  );
}

/** The three best restaurants as cards: revenue, share, orders, order value and what earned them the most */
function TopLocations({ v, currency, look }: { v: LocViews; currency: string | null; look: Look }) {
  const top = v.all.slice(0, 3);
  if (top.length < 2) return null;
  return (
    <View style={{ flexDirection: "row", gap: GAP }}>
      {top.map((r, i) => (
        <View key={r.full} style={{ flex: 1, backgroundColor: "#ffffff", borderWidth: 1, borderColor: LINE, borderRadius: 10, overflow: "hidden" }}>
          <View style={{ height: 3, backgroundColor: i === 0 ? look.primary : i === 1 ? look.bars : tint(look.bars, 0.5) }} />
          <View style={{ paddingHorizontal: 11, paddingTop: 9, paddingBottom: 10 }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <View style={{ backgroundColor: i === 0 ? look.primary : INK, borderRadius: 4, paddingVertical: 2.5, paddingHorizontal: 5 }}>
                <Text style={{ fontSize: 6.6, fontFamily: "Helvetica-Bold", color: "#ffffff" }}>#{r.rank}</Text>
              </View>
              <Text style={{ fontSize: 7.4, fontFamily: "Helvetica-Bold", color: look.barsText }}>{shareText(r.share)} of revenue</Text>
            </View>
            <Text style={{ fontSize: 9.2, fontFamily: "Helvetica-Bold", color: INK, lineHeight: 1.2, marginTop: 7, height: 22, maxLines: 2, textOverflow: "ellipsis" }}>{r.name}</Text>
            <Text style={{ fontSize: fitFont(wholeMoney(r.revenue, currency), 140, 17), fontFamily: "Helvetica-Bold", color: INK, letterSpacing: -0.3, marginTop: 4, lineHeight: 1 }}>{wholeMoney(r.revenue, currency)}</Text>
            <View style={{ flexDirection: "row", marginTop: 8, paddingTop: 7, borderTopWidth: 1, borderTopColor: "#edf1f4" }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 8, fontFamily: "Helvetica-Bold", color: INK }}>{int(r.conversions)}</Text>
                <Text style={{ fontSize: 6.2, color: MUTED, marginTop: 1.5 }}>orders</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 8, fontFamily: "Helvetica-Bold", color: INK }}>{r.conversions > 0 ? wholeMoney(r.revenue / r.conversions, currency) : "–"}</Text>
                <Text style={{ fontSize: 6.2, color: MUTED, marginTop: 1.5 }}>per order</Text>
              </View>
            </View>
            {r.best ? (
              <Text style={{ fontSize: 7.2, color: MUTED, marginTop: 6, lineHeight: 1.3, maxLines: 2, textOverflow: "ellipsis" }}>
                Most from <Text style={{ fontFamily: "Helvetica-Bold", color: INK }}>{r.best.id === "flows" ? "automated emails" : r.best.name}</Text> ({shareText(r.best.share)})
              </Text>
            ) : null}
          </View>
        </View>
      ))}
      {top.length < 3 ? <View style={{ flex: 1 }} /> : null}
    </View>
  );
}

/**
 * Every location against each campaign and the flows, each cell shaded by its revenue (darker earns more), with the
 * totals. Up to 40 rows stay one card that moves whole; a longer one runs across pages without a frame, its header on
 * each page.
 */
function LocationHeat({ x, v, currency, look }: { x: LocationMetricBreakdown; v: LocViews; currency: string | null; look: Look }) {
  const framed = x.rows.length <= 40;
  const nameW = 124;
  const totalW = 56;
  const n = Math.max(1, x.columns.length);
  const colW = Math.min(66, (INNER - 2 - 20 - nameW - totalW) / n);
  const th = { fontSize: 6, color: "#5f6f82", fontFamily: "Helvetica-Bold" as const };
  const totals = x.columns.map((_, i) => x.rows.reduce((t, r) => t + (r.cells[i] ?? 0), 0));
  const cell = (val: number | null, key: string) => {
    const t = heat(val, v.maxCell);
    return (
      <View key={key} style={{ width: colW, paddingHorizontal: 1.5, height: 14 }}>
        <View style={{ flex: 1, borderRadius: 3, backgroundColor: t ? tint(look.bars, t) : "#f6f8fa", justifyContent: "center", paddingHorizontal: 4 }}>
          <Text style={{ fontSize: 7.2, textAlign: "right", color: t > 0.55 ? "#ffffff" : val ? INK : FAINT, fontFamily: t > 0.55 ? "Helvetica-Bold" : "Helvetica" }}>{val ? wholeMoney(val, currency) : "–"}</Text>
        </View>
      </View>
    );
  };
  return (
    <View style={framed ? [s.panel, { paddingVertical: 9, paddingHorizontal: 10 }] : { paddingHorizontal: 1 }} wrap={!framed}>
      <View style={[s.th, { alignItems: "flex-end", paddingVertical: 6 }]} fixed={!framed}>
        <Text style={[th, { width: nameW, textTransform: "uppercase", letterSpacing: 0.3 }]}>Location</Text>
        {x.columns.map((col) => (
          <View key={col.id} style={{ width: colW, paddingLeft: 4, paddingRight: 1.5 }}>
            <Text style={[th, { textAlign: "right", lineHeight: 1.2, maxLines: 3, textOverflow: "ellipsis", fontFamily: col.id === "other" ? "Helvetica-Oblique" : "Helvetica-Bold" }]}>{col.name}</Text>
            <Text style={{ fontSize: 5.8, color: FAINT, textAlign: "right", marginTop: 1 }}>{col.sendDay ? day(col.sendDay) : col.id === "flows" ? "Automated" : col.id === "other" ? "Added up" : "Before these dates"}</Text>
          </View>
        ))}
        <Text style={[th, { width: totalW, textAlign: "right", textTransform: "uppercase", letterSpacing: 0.3 }]}>Total</Text>
      </View>
      {x.rows.map((r) => (
        <View key={r.location} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 1, paddingHorizontal: 5 }} wrap={false}>
          <Text style={{ width: nameW, fontSize: 7.2, color: INK, maxLines: 1, textOverflow: "ellipsis", paddingRight: 6 }}>{v.name(r.location)}</Text>
          {r.cells.map((val, j) => cell(val, x.columns[j].id))}
          <Text style={{ width: totalW, fontSize: 7.4, textAlign: "right", fontFamily: "Helvetica-Bold", color: INK }}>{wholeMoney(r.total, currency)}</Text>
        </View>
      ))}
      <View style={{ flexDirection: "row", alignItems: "center", paddingVertical: 6, paddingHorizontal: 5, marginTop: 4, backgroundColor: "#f3f6f9", borderRadius: 5 }} wrap={false}>
        <Text style={{ width: nameW, fontSize: 6.8, fontFamily: "Helvetica-Bold", color: INK, letterSpacing: 0.4 }}>TOTAL · {x.rows.length}</Text>
        {totals.map((t, j) => (
          <Text key={x.columns[j].id} style={{ width: colW, fontSize: 7.2, textAlign: "right", fontFamily: "Helvetica-Bold", color: INK, paddingRight: 5.5 }}>
            {wholeMoney(t, currency)}
          </Text>
        ))}
        <Text style={{ width: totalW, fontSize: 7.6, textAlign: "right", fontFamily: "Helvetica-Bold", color: INK }}>{wholeMoney(x.revenue, currency)}</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", marginTop: 7, paddingHorizontal: 5 }} wrap={false}>
        <Text style={{ fontSize: 6.4, color: MUTED, marginRight: 5 }}>Less</Text>
        {[0.12, 0.3, 0.5, 0.7, 0.9].map((t) => (
          <View key={t} style={{ width: 14, height: 6, borderRadius: 1.5, backgroundColor: tint(look.bars, t), marginRight: 2 }} />
        ))}
        <Text style={{ fontSize: 6.4, color: MUTED, marginLeft: 3 }}>More revenue</Text>
        <Text style={{ flex: 1, fontSize: 6.4, color: MUTED, textAlign: "right" }}>{x.summary.split(". ")[0]}.</Text>
      </View>
    </View>
  );
}

/** The location blocks for one metric: the headline band, the ranked bars, the three best, then the full table */
function LocationMetric({ x, m, look, first }: { x: LocationMetricBreakdown; m: EmailMetrics; look: Look; first: React.ReactNode }) {
  const c = m.currency;
  const v = locationViews(x, x.ranked.length <= 18 ? 18 : 15);
  const several = (m.locations?.metrics.length ?? 0) > 1;
  return (
    <>
      <View style={s.section} wrap={false}>
        {first}
        {several ? <Text style={[s.h3, { marginBottom: 7 }]}>{x.name}</Text> : null}
        <LocationHero x={x} v={v} m={m} look={look} />
      </View>
      <View style={s.section} wrap={false}>
        <Head title={several ? `${x.name} · revenue by location` : "Revenue by location"} sub={v.rest ? `The best ${v.shown.length} of ${v.all.length}, with each one's share of the total` : "Each location's share of the total"} />
        <LocationBars v={v} currency={c} look={look} />
      </View>
      {v.all.length >= 2 ? (
        <View style={s.section} wrap={false}>
          <Head title={several ? `${x.name} · top locations` : "Top locations"} sub="What earned each of them the most" />
          <TopLocations v={v} currency={c} look={look} />
        </View>
      ) : null}
      <View style={s.section} wrap={x.rows.length > 40}>
        <View wrap={false} minPresenceAhead={80}>
          <Head title={several ? `${x.name} · by location and campaign` : "By location and campaign"} sub={x.columns.some((col) => col.id === "other") ? "The six best campaigns in send order, the rest together, and the automated emails" : "Each campaign in send order, and the automated emails"} />
        </View>
        <LocationHeat x={x} v={v} currency={c} look={look} />
      </View>
    </>
  );
}

/**
 * The report's last section for a multi-location client, straight after the rest (no page of its own): per metric a
 * headline band, the locations ranked as bars, the three best as cards and every location against each campaign as a
 * shaded table. Several metrics get their totals side by side first, with the note that they aren't deduplicated.
 */
function LocationSection({ m, look }: { m: EmailMetrics; look: Look }) {
  const b = m.locations;
  if (!b || !b.metrics.length) return null;
  const c = m.currency;
  const head = <Head title="Orders by location" sub={`Revenue ${m.source ?? "Klaviyo"} attributes to email, by the restaurant each order came from · ${m.main.label}`} />;
  if (b.metrics.length === 1) return <LocationMetric x={b.metrics[0]} m={m} look={look} first={head} />;
  const boxes = [...b.metrics.map((x) => ({ key: x.metricId, title: x.name, value: wholeMoney(x.revenue, c), sub: `${int(x.conversions)} orders · ${x.ranked.length} locations` })), { key: "combined", title: "Combined", value: wholeMoney(b.combined.revenue, c), sub: `${int(b.combined.conversions)} orders` }];
  const w = (INNER - 2 - (boxes.length - 1)) / boxes.length;
  return (
    <>
      <View style={s.section} wrap={false}>
        {head}
        <StatRow height={60}>
          {boxes.map((x, i) => (
            <Fragment key={x.key}>
              {i ? <Rule /> : null}
              <Stat title={x.title} value={x.value} sub={x.sub} prior={priorWord(m)} width={w} height={60} max={17} color={x.key === "combined" ? look.barsText : undefined} />
            </Fragment>
          ))}
        </StatRow>
        <Text style={[s.note, { fontSize: 7.2 }]}>{b.note}</Text>
      </View>
      {b.metrics.map((x) => (
        <LocationMetric key={x.metricId} x={x} m={m} look={look} first={null} />
      ))}
    </>
  );
}

/** A white label client's words cleaned of the agency, whatever the AI or the owner wrote */
function cleaned(input: ChannelPdfInput): ChannelPdfInput {
  if (!input.whiteLabel) return input;
  return { ...input, dashboard: null, brand: input.brand ? { ...input.brand, agencyLogo: null } : input.brand, sections: scrubSections(input.sections), extras: input.extras ? scrubAgency(input.extras) : input.extras };
}

function EmailBody({ m, images, look, layout, hot, sections }: { m: EmailMetrics; images: ChannelImages; look: Look; layout?: ChannelLayout | null; hot: HotOf; sections: Sections }) {
  // No readable revenue: the engagement report (reach, clicks, what people clicked, the list, against the usual)
  if (isEngagement(m)) return <EngagementBody m={m} images={images} look={look} hot={hot} sections={sections} />;
  if (!m.detail)
    return (
      <>
        <Glance m={m} layout={layout} hot={hot} />
        <ChannelMtd m={m} look={look} />
        <LegacyCampaigns m={m} images={images} />
        <LegacyFlows m={m} />
        <LegacyListHealth m={m} />
        <LocationSection m={m} look={look} />
      </>
    );
  const keys = columnKeys("klaviyo", layout);
  return (
    <>
      <EmailGlance m={m} layout={layout} hot={hot} />
      <RevenueSources m={m} look={look} />
      <ChannelMtd m={m} look={look} />
      <ConversionSummary m={m} />
      <CampaignPerformance m={m} keys={keys} hot={hot} images={images} look={look} />
      <FlowPerformance m={m} look={look} />
      <ListAndDelivery m={m} />
      <LocationSection m={m} look={look} />
    </>
  );
}

export function ChannelDocument({ input: asked, images }: { input: ChannelPdfInput; images: ChannelImages }) {
  const input = cleaned(asked);
  const look = lookFor(input);
  // A social report's numbers carry the figures the strategist entered where Meta gave none
  const m = input.metrics.platform === "social" ? withTeamFindings(input.metrics, input.sections) : input.metrics;
  const hot = hotOf(input);
  const by = input.whiteLabel ? input.client : AGENCY;
  const title = `${input.client} · ${[cadenceWord(m.kind), channelName(m.platform).toLowerCase()].filter(Boolean).join(" ")} report · ${m.main.label}`;
  return (
    <Document title={input.whiteLabel ? scrubAgency(title) : title} author={by} creator={by} producer={by}>
      <Page size="A4" style={s.page}>
        <Footer input={input} />
        <Masthead input={input} look={look} />
        <Hero input={input} look={look} />
        {m.platform === "klaviyo" ? (
          <EmailBody m={m} images={images} look={look} layout={input.layout} hot={hot} sections={input.sections} />
        ) : (
          <SocialBody m={m} images={images} look={look} layout={input.layout} hot={hot} sections={input.sections} whiteLabel={input.whiteLabel} />
        )}
        {/* The detailed email report ends on the numbers: what the team learned travels in the message; social draws its own (social-doc.tsx) */}
        {m.platform === "social" || m.detail ? null : <Takeaways m={m} sections={input.sections} look={look} hot={hot} />}
        {input.dashboard && !input.whiteLabel ? (
          <Link src={input.dashboard} style={{ fontSize: 8, color: look.primary, fontFamily: "Helvetica-Bold", textDecoration: "none", marginTop: 2 }}>
            See every number, any dates, on your live dashboard
          </Link>
        ) : null}
        <Notes input={input} look={look} hot={hot} />
      </Page>
    </Document>
  );
}
