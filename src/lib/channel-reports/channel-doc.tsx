import { Fragment } from "react";
import { Circle, Defs, Document, G, Image, Line, LinearGradient, Link, Page, Rect, Stop, Svg, Text, View } from "@react-pdf/renderer";
import { docKit, KAIZEN_RED, lookFor, type Look, type WeeklyBrand } from "@/lib/reports/weekly-doc";
import { scrubAgency, scrubSections } from "@/lib/reports/white-label";
import type { Sections } from "@/lib/reports/write";
import type { Move } from "@/lib/reports/weekly-core";
import { BENCHMARKS } from "@/lib/klaviyo/insights";
import { channelName, fitFont, int, metricsSupport, metricsTiles, money, moveOf, pct, postRateText, shortMoney, signed, socialName, takeawaysFor, type EmailMetrics, type SocialMetrics, type TrendPoint } from "./core";
import { wholeMoney } from "./email-message";
import { grade, RATE_BARS, type Grade, type MessageRow, type Pair, type PerfBlock } from "./email-detail";

// A channel client report as a PDF, in the same design as the ads report (weekly-doc.tsx): the client's logo beside
// Kaizen's, the hero band with the period, the period at a glance, and three takeaways. Email reads like the overview the
// email team used to pull from Klaviyo, kept to two pages: revenue and orders, each day's campaigns against automated
// emails, campaign and flow performance against Kaizen's bars with every campaign and the best flows, deliverability and
// subscriber growth, each against the period before. Social: each platform and the best posts with their pictures.
// Boxes have fixed heights and values are sized to fit them, so nothing can overlap whatever the numbers are. The
// narrative travels in the message, never in the document. A white label client's carries only the client's brand.

export type ChannelPdfInput = { client: string; clientId?: string | null; metrics: EmailMetrics | SocialMetrics; sections: Sections; whiteLabel?: boolean; brand?: WeeklyBrand | null; dashboard?: string | null };

const { s, Logo, Arrow, toneOf, INK, MUTED, FAINT, LINE, INNER, HERO_H, GOOD, BAD } = docKit;
const AGENCY = "Kaizen Marketing";
const GAP = 8;
const AMBER = { fg: "#a1650f", bg: "#fdf1dc" };
const GRADE_TONE: Record<Grade, { fg: string; bg: string }> = { good: GOOD, fair: AMBER, poor: BAD };
const GRADE_WORD: Record<Grade, string> = { good: "Good", fair: "Fair", poor: "Poor" };
const CAMPAIGN_HEX = "#24364d";

/** Image data URIs by what they picture (a campaign's id, a post's platform and id) */
export type ChannelImages = Record<string, string | null>;
export const postKey = (p: { platform: string; id: string }) => `${p.platform}:${p.id}`;

const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const weekday = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
const fullRange = (a: string, b: string) => `${day(a)} – ${new Date(`${b}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
const priorWord = (m: { kind: string }) => (m.kind === "monthly" ? "month" : "week");

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
  const word = m.kind === "monthly" ? "Monthly" : "Weekly";
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
          <Text style={[s.eyebrow, { color: look.heroSoft }]}>{word} {m.platform === "klaviyo" ? "Email Marketing" : "Organic Social"} Report</Text>
          <Text style={[s.h1, long ? { fontSize: 20 } : {}]}>{input.client.length <= 11 ? `${input.client} Performance\nOverview` : `${input.client}\nPerformance Overview`}</Text>
          <Text style={s.heroSub}>{m.platform === "klaviyo" ? "Revenue, campaigns, automated emails & list health" : "Audience growth, reach & what resonated"}</Text>
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
      <Text style={label}>{title}</Text>
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

/** Social, and an older email report without the detail: four boxes and the rates under them */
function Glance({ m }: { m: EmailMetrics | SocialMetrics }) {
  const tiles = metricsTiles(m);
  const w = (INNER - 2 - 3) / tiles.length;
  return (
    <View style={s.section} wrap={false}>
      <Head title="Performance at a glance" sub={`${m.kind === "monthly" ? "Month-over-month" : "Week-over-week"} movement · green = favorable, red = unfavorable`} />
      <StatRow>
        {tiles.map((t, i) => (
          <Fragment key={t.label}>
            {i ? <Rule /> : null}
            <Stat title={t.label} value={t.value} mv={t.move} before={t.before} prior={priorWord(m)} sub={t.sub} width={w} height={86} />
          </Fragment>
        ))}
      </StatRow>
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

const BAND_HEX = { good: "#087a5e", watch: "#b7791f", bad: "#c23e4c" } as const;
const BAND_WORD = { good: "Healthy", watch: "Watch", bad: "At risk" } as const;
const scoreHex = (n: number) => (n >= 80 ? BAND_HEX.good : n >= 60 ? BAND_HEX.watch : BAND_HEX.bad);

/** Email: revenue from email and SMS, orders, the campaigns and automated emails split, and the email score */
function EmailGlance({ m }: { m: EmailMetrics }) {
  const d = m.detail!;
  const c = m.currency;
  const prior = priorWord(m);
  const w = (INNER - 2 - 3) / 4;
  const total = m.now.campaignRevenue + m.now.flowRevenue;
  const camp = total > 0 ? m.now.campaignRevenue / total : 0;
  const aov = d.orders.now ? m.now.revenue / d.orders.now : null;
  const sc = m.score && m.score.unmeasured.length < m.score.checks.length ? m.score : null;
  return (
    <View style={s.section} wrap={false}>
      <Head title="Performance at a glance" sub={`${m.kind === "monthly" ? "Month-over-month" : "Week-over-week"} movement · green = favorable, red = unfavorable`} />
      <StatRow height={84}>
        <Stat title="Revenue from email & SMS" value={money(m.now.revenue, c)} mv={moveOf(m.now.revenue, m.before.revenue)} before={money(m.before.revenue, c)} prior={prior} sub={m.now.estimated ? "Added up from campaigns and automated emails" : "Attributed by Klaviyo"} width={w} height={84} />
        <Rule />
        <Stat title="Orders" value={int(d.orders.now)} mv={moveOf(d.orders.now, d.orders.before)} before={int(d.orders.before)} prior={prior} sub={aov != null ? `Average order ${money(aov, c)}` : null} width={w} height={84} />
        <Rule />
        <View style={{ width: w, height: 84, paddingHorizontal: 10, paddingVertical: 9 }}>
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
        <Rule />
        <View style={{ width: w, height: 84, paddingHorizontal: 10, paddingVertical: 9 }}>
          <Text style={label}>Email score</Text>
          {sc ? (
            <>
              <View style={{ flexDirection: "row", alignItems: "flex-end", height: 26, marginTop: 4 }}>
                <Text style={{ fontSize: 22, fontFamily: "Helvetica-Bold", color: BAND_HEX[sc.band], lineHeight: 1 }}>{sc.score}</Text>
                <Text style={{ fontSize: 7, color: FAINT, marginLeft: 3, marginBottom: 2 }}>of 100</Text>
              </View>
              <Text style={{ fontSize: 7, fontFamily: "Helvetica-Bold", color: BAND_HEX[sc.band], marginTop: 3 }}>{BAND_WORD[sc.band]}</Text>
              <Text style={{ fontSize: 6.2, color: MUTED, marginTop: 2, maxLines: 2 }}>Kaizen&apos;s account score, last 30 days</Text>
            </>
          ) : (
            <Text style={{ fontSize: 7, color: FAINT, marginTop: 10 }}>Not scored yet</Text>
          )}
        </View>
      </StatRow>
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

/** Each day's revenue from campaigns stacked on automated emails, with the split and its move beside it */
function ConversionSummary({ m, look }: { m: EmailMetrics; look: Look }) {
  const d = m.detail!;
  const c = m.currency;
  const prior = priorWord(m);
  const total = m.now.campaignRevenue + m.now.flowRevenue;
  const share = (x: number) => (total > 0 ? `${Math.round((x / total) * 100)}%` : "");
  const left = 132;
  const W = INNER - 26 - left - 14;
  const H = 128;
  const top = 12;
  const base = H - 16;
  const daily = d.daily;
  const scale = niceTop(Math.max(...daily.map((x) => x.campaign + x.flow), 0));
  const slot = daily.length ? (W - 30) / daily.length : 0;
  const bar = Math.max(3, Math.min(30, slot * 0.62));
  const y = (v: number) => base - (v / scale) * (base - top);
  const few = daily.length <= 10;
  return (
    <View style={s.section} wrap={false}>
      <Head title="Conversion summary" sub={`Revenue attributed to email and SMS by day, ${m.main.label}`} />
      <View style={[s.panel, { flexDirection: "row" }]}>
        <View style={{ width: left, paddingRight: 10, borderRightWidth: 1, borderRightColor: "#edf1f4", marginRight: 14 }}>
          <LegendRow color={CAMPAIGN_HEX} name="Campaigns" value={wholeMoney(m.now.campaignRevenue, c)} share={share(m.now.campaignRevenue)} mv={moveOf(m.now.campaignRevenue, m.before.campaignRevenue)} before={wholeMoney(m.before.campaignRevenue, c)} prior={prior} />
          <LegendRow color={look.bars} name="Automated emails" value={wholeMoney(m.now.flowRevenue, c)} share={share(m.now.flowRevenue)} mv={moveOf(m.now.flowRevenue, m.before.flowRevenue)} before={wholeMoney(m.before.flowRevenue, c)} prior={prior} />
          {m.now.smsRevenue > 0 ? <Text style={{ fontSize: 6.4, color: MUTED }}>SMS within these: {money(m.now.smsRevenue, c)}</Text> : null}
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
              const yf = y(p.flow);
              const yt = y(p.flow + p.campaign);
              // A long period labels every few days, counted back from the last so the last day is always named
              const every = few ? 1 : Math.ceil(daily.length / 7);
              const named = (daily.length - 1 - i) % every === 0;
              return (
                <G key={p.date}>
                  {p.flow > 0 ? <Rect x={x} y={yf} width={bar} height={base - yf} fill={look.bars} /> : null}
                  {p.campaign > 0 ? <Rect x={x} y={yt} width={bar} height={Math.max(0.8, yf - yt)} fill={CAMPAIGN_HEX} /> : null}
                  {few && p.flow + p.campaign > 0 ? (
                    <SvgText x={x + bar / 2} y={yt - 3} anchor="middle" fill={INK} size={6}>
                      {shortMoney(p.flow + p.campaign, c)}
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

/** Recipients, open, click and placed order rate for the period, each graded against Kaizen's bar where it has one */
function PerfCells({ p, bars, prior, kind }: { p: PerfBlock; bars: { open: number; click: number }; prior: string; kind: "campaign" | "flow" }) {
  const w = (INNER - 2 - 3) / 4;
  const rate = (x: Pair, digits: number, better: "up" | "down" = "up") => ({ value: pct(x.now, digits), mv: moveOf(x.now, x.before, better), before: pct(x.before, digits) });
  const open = rate(p.open, 1);
  const click = rate(p.click, 2);
  const order = rate(p.orderRate, 2);
  return (
    <StatRow height={62}>
      <Stat title={kind === "campaign" ? "Recipients" : "Recipients"} value={int(p.recipients.now)} mv={moveOf(p.recipients.now, p.recipients.before, "none")} before={int(p.recipients.before)} prior={prior} width={w} height={62} max={15} />
      <Rule />
      <Stat title="Open rate" value={open.value} mv={open.mv} before={open.before} prior={prior} width={w} height={62} max={15} badge={grade(p.open.now, bars.open)} />
      <Rule />
      <Stat title="Click rate" value={click.value} mv={click.mv} before={click.before} prior={prior} width={w} height={62} max={15} badge={grade(p.click.now, bars.click)} />
      <Rule />
      <Stat title="Placed order rate" value={order.value} mv={order.mv} before={order.before} prior={prior} width={w} height={62} max={15} />
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
];
const FLOW_COLS: Col[] = [
  { key: "name", head: "Automated email (flow)", align: "left" },
  { key: "status", head: "Status", width: 38 },
  { key: "recipients", head: "Recipients", width: 48 },
  { key: "open", head: "Open", width: 36 },
  { key: "click", head: "Click", width: 36 },
  { key: "orders", head: "Orders", width: 34 },
  { key: "orderRate", head: "Order rate", width: 42 },
  { key: "revenue", head: "Revenue", width: 56 },
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
    default:
      return r.name;
  }
}

function Table({ cols, rows, currency, foot }: { cols: Col[]; rows: (MessageRow & { muted?: boolean })[]; currency: string | null; foot?: string | null }) {
  // A long list keeps each name to one line so it stays on the two pages
  const lines = rows.length > 8 ? 1 : 2;
  const th = { fontSize: 5.4, color: "#6f7f92", fontFamily: "Helvetica-Bold" as const, textTransform: "uppercase" as const, letterSpacing: 0.25 };
  const box = (c: Col) => (c.width ? { width: c.width } : { flex: 1, paddingRight: 8 });
  return (
    <View style={[s.panel, { paddingVertical: 8, marginTop: GAP }]}>
      <View style={s.th} fixed>
        {cols.map((c) => (
          <Text key={c.key} style={[th, box(c), { textAlign: c.align ?? "right" }]}>
            {c.head}
          </Text>
        ))}
      </View>
      {rows.map((r, i) => (
        <View key={r.id} style={[s.tr, { paddingVertical: 5, borderBottomWidth: i === rows.length - 1 ? 0 : 1 }]} wrap={false}>
          {cols.map((c) =>
            c.key === "name" ? (
              <Text key={c.key} style={[box(c), { fontSize: 7.2, fontFamily: r.muted ? "Helvetica-Oblique" : "Helvetica-Bold", color: r.muted ? MUTED : INK, lineHeight: 1.25, maxLines: lines, textOverflow: "ellipsis" }]}>
                {r.name}
              </Text>
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

function CampaignPerformance({ m }: { m: EmailMetrics }) {
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
          <Text style={{ fontSize: 7, color: MUTED, marginTop: 3 }}>
            {before ? `The ${prior} before: ${before} ${before === 1 ? "campaign" : "campaigns"}, ${money(d.campaign.revenue.before, m.currency)} in revenue.` : `None were sent the ${prior} before either.`} Revenue this {prior} came from automated emails.
          </Text>
        </View>
      </View>
    );
  const shown = d.campaigns.slice(0, MAX_CAMPAIGNS);
  const rest = d.campaigns.slice(MAX_CAMPAIGNS);
  const foot = rest.length ? `And ${rest.length} more ${rest.length === 1 ? "campaign" : "campaigns"} earning ${money(rest.reduce((a, r) => a + r.revenue, 0), m.currency)}.` : null;
  return (
    <View style={s.section}>
      <View wrap={false}>
        <Head title="Campaign performance" sub={`${n} ${n === 1 ? "campaign" : "campaigns"} sent · graded against Kaizen's bars: open ${pct(RATE_BARS.campaign.open, 0)}, click ${pct(RATE_BARS.campaign.click, 0)}`} />
        <PerfCells p={d.campaign} bars={RATE_BARS.campaign} prior={prior} kind="campaign" />
      </View>
      <Table cols={CAMPAIGN_COLS} rows={shown} currency={m.currency} foot={foot} />
    </View>
  );
}

function FlowPerformance({ m }: { m: EmailMetrics }) {
  const d = m.detail!;
  if (!d.flow) return <LegacyFlows m={m} />;
  const prior = priorWord(m);
  const sent = d.flow.sent.now ?? 0;
  const rows: (MessageRow & { muted?: boolean })[] = [...d.flows, ...(d.flowsOther ? [{ ...d.flowsOther, muted: true }] : [])];
  return (
    <View style={s.section}>
      <View wrap={false}>
        <Head title="Automated email performance" sub={`${sent} ${sent === 1 ? "flow" : "flows"} sent · graded against Kaizen's bars: open ${pct(RATE_BARS.flow.open, 0)}, click ${pct(RATE_BARS.flow.click, 1)}`} />
        <PerfCells p={d.flow} bars={RATE_BARS.flow} prior={prior} kind="flow" />
      </View>
      {rows.length ? <Table cols={FLOW_COLS} rows={rows} currency={m.currency} foot={d.flowsOther ? "Best by revenue; the rest are added up in the last row." : null} /> : null}
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
  const score = dl.score.now;
  return (
    <View style={[s.panel, { width, paddingVertical: 11 }]}>
      <View style={{ flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 8, height: 30 }}>
        <View style={{ flexShrink: 1 }}>
          <Text style={label}>Deliverability score</Text>
          <Text style={{ fontSize: 6.2, color: MUTED, marginTop: 3, maxLines: 2 }}>Campaign email to {int(dl.recipients.now)} recipients</Text>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <View style={{ flexDirection: "row", alignItems: "flex-end" }}>
            <Text style={{ fontSize: 20, fontFamily: "Helvetica-Bold", color: score == null ? FAINT : scoreHex(score), lineHeight: 1 }}>{score ?? "–"}</Text>
            <Text style={{ fontSize: 6.4, color: FAINT, marginLeft: 3, marginBottom: 2 }}>of 100</Text>
          </View>
          <View style={{ marginTop: 3 }}>
            <Chip mv={moveOf(score, dl.score.before)} />
          </View>
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

// ─── Social ────────────────────────────────────────────────────────────────

/** Eight weeks of reach as bars (every value labelled) */
function Trend({ m, look }: { m: SocialMetrics; look: Look }) {
  const pts: TrendPoint[] = m.trend;
  if (!pts.length || pts.every((p) => !p.value)) return null;
  const W = INNER - 26;
  const H = 108;
  const top = 16;
  const base = H - 20;
  const max = Math.max(...pts.map((p) => p.value), 1);
  const slot = W / pts.length;
  const bar = Math.min(34, slot - 10);
  return (
    <View style={s.section} wrap={false}>
      <Head title="Reach by week" sub={`Eight weeks ending ${day(m.main.end)}`} />
      <View style={s.panel}>
        <Svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
          <Line x1={0} y1={base} x2={W} y2={base} stroke={LINE} strokeWidth={1} />
          {pts.map((p, i) => {
            const h = (p.value / max) * (base - top);
            const x = i * slot + (slot - bar) / 2;
            const last = i === pts.length - 1;
            return (
              <G key={p.start}>
                <Rect x={x} y={base - h} width={bar} height={Math.max(h, 1)} rx={3} fill={last ? look.bars : look.barsSoft} />
                <SvgText x={x + bar / 2} y={base - h - 4} anchor="middle" fill={INK}>
                  {int(p.value)}
                </SvgText>
                <SvgText x={x + bar / 2} y={H - 6} anchor="middle" fill={MUTED}>
                  {p.label}
                </SvgText>
              </G>
            );
          })}
        </Svg>
      </View>
    </View>
  );
}

function Platforms({ m }: { m: SocialMetrics }) {
  if (!m.platforms.length) return null;
  return (
    <View style={s.section} wrap={false}>
      <Head title="By platform" sub={`${m.main.label} against ${m.compare.label}`} />
      <View style={s.panel}>
        <View style={s.th}>
          <Text style={[...th, { flex: 1 }]}>Platform</Text>
          <Text style={[...th, { width: 58, textAlign: "right" }]}>Followers</Text>
          <Text style={[...th, { width: 50, textAlign: "right" }]}>Change</Text>
          <Text style={[...th, { width: 54, textAlign: "right" }]}>Reach</Text>
          <Text style={[...th, { width: 54, textAlign: "right" }]}>Views</Text>
          <Text style={[...th, { width: 50, textAlign: "right" }]}>Engage</Text>
          <Text style={[...th, { width: 36, textAlign: "right" }]}>Posts</Text>
        </View>
        {m.platforms.map((p) => (
          <View key={p.platform} style={s.tr}>
            <Text style={[s.adName, { flex: 1 }]}>
              {socialName(p.platform)}
              {p.name ? `  ${p.name}` : ""}
            </Text>
            <Text style={[s.td, { width: 58 }]}>{int(p.now.followers)}</Text>
            <Text style={[s.td, { width: 50, color: (p.now.followerChange ?? 0) < 0 ? "#c23e4c" : "#087a5e" }]}>{signed(p.now.followerChange)}</Text>
            <Text style={[s.td, { width: 54 }]}>{int(p.now.reach)}</Text>
            <Text style={[s.td, { width: 54 }]}>{int(p.now.views)}</Text>
            <Text style={[s.td, { width: 50 }]}>{m.insightsRead ? pct(p.now.rate) : "–"}</Text>
            <Text style={[s.td, { width: 36 }]}>{int(p.now.posts)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function TopPosts({ m, images, look }: { m: SocialMetrics; images: ChannelImages; look: Look }) {
  const top = m.posts.slice(0, 3);
  if (!top.length) return null;
  return (
    <View style={s.section} wrap={false}>
      <Head title="Top posts" sub={`${m.postsTotal} published · best by engagement`} />
      <View style={s.insights}>
        {top.map((p) => {
          const pic = images[postKey(p)];
          return (
            <View key={postKey(p)} style={s.adCard}>
              {/* eslint-disable-next-line jsx-a11y/alt-text -- a PDF image, no alt prop */}
              {pic ? <Image src={pic} style={s.adPic} /> : <View style={s.adPicBlank}><Text style={{ fontSize: 7, color: FAINT }}>{p.format}</Text></View>}
              <View style={s.adBody}>
                <Text style={s.adName}>{p.caption ? p.caption.slice(0, 70) : `${socialName(p.platform)} ${p.format}`}</Text>
                <Text style={s.adMeta}>
                  {socialName(p.platform)} · {p.format}
                  {p.postedAt ? ` · ${day(p.postedAt.slice(0, 10))}` : ""}
                </Text>
                <Text style={[s.adMeta, { marginTop: 4, color: INK }]}>
                  {int(p.interactions)} interactions · reach {int(p.reach)}
                </Text>
                <Text style={s.adMeta}>{postRateText(p)}</Text>
                {p.permalink ? (
                  <Link src={p.permalink} style={{ fontSize: 7, color: look.primary, fontFamily: "Helvetica-Bold", textDecoration: "none", marginTop: 5 }}>
                    View post
                  </Link>
                ) : null}
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

// ─── Both ──────────────────────────────────────────────────────────────────

function Takeaways({ m, sections, look }: { m: EmailMetrics | SocialMetrics; sections: Sections; look: Look }) {
  const items = takeawaysFor(m, sections.takeaways);
  if (!items.length) return null;
  return (
    <View style={s.section} wrap={false}>
      <Head title="Key takeaways" sub={`From this period's ${channelName(m.platform).toLowerCase()} numbers`} />
      <View style={s.insights}>
        {items.map((t, i) => (
          <View key={i} style={s.insight}>
            <View style={{ width: 14, height: 2.5, borderRadius: 2, backgroundColor: look.primary, marginBottom: 8 }} />
            <Text style={s.insightTitle}>{t.title}</Text>
            <Text style={s.insightText}>{t.text}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function Footer({ input }: { input: ChannelPdfInput }) {
  const src = input.metrics.platform === "klaviyo" ? "Klaviyo" : "Meta (Facebook and Instagram insights)";
  return (
    <>
      <View style={s.footer} fixed>
        <Text style={[s.footText, { maxWidth: 250 }]}>
          {input.whiteLabel ? `Prepared for ${input.client}` : `Prepared for ${input.client} · Kaizen`} | Data: {src}, synced daily
        </Text>
        <Text style={[s.footText, { textAlign: "right", flex: 1 }]}>{input.metrics.platform === "klaviyo" ? "Revenue and orders are attributed by Klaviyo · rates are of delivered email · order rate is orders over recipients" : "Engagement rate is interactions over reach"}</Text>
      </View>
      <Text style={s.pageNumber} fixed render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
    </>
  );
}

/** A white label client's words cleaned of the agency, whatever the AI or the owner wrote */
function cleaned(input: ChannelPdfInput): ChannelPdfInput {
  if (!input.whiteLabel) return input;
  return { ...input, dashboard: null, brand: input.brand ? { ...input.brand, agencyLogo: null } : input.brand, sections: scrubSections(input.sections) };
}

function EmailBody({ m, images, look }: { m: EmailMetrics; images: ChannelImages; look: Look }) {
  if (!m.detail)
    return (
      <>
        <Glance m={m} />
        <LegacyCampaigns m={m} images={images} />
        <LegacyFlows m={m} />
        <LegacyListHealth m={m} />
      </>
    );
  return (
    <>
      <EmailGlance m={m} />
      <ConversionSummary m={m} look={look} />
      <CampaignPerformance m={m} />
      <FlowPerformance m={m} />
      <ListAndDelivery m={m} />
    </>
  );
}

export function ChannelDocument({ input: asked, images }: { input: ChannelPdfInput; images: ChannelImages }) {
  const input = cleaned(asked);
  const look = lookFor(input);
  const m = input.metrics;
  const by = input.whiteLabel ? input.client : AGENCY;
  const title = `${input.client} · ${m.kind === "monthly" ? "Monthly" : "Weekly"} ${channelName(m.platform).toLowerCase()} report · ${m.main.label}`;
  return (
    <Document title={input.whiteLabel ? scrubAgency(title) : title} author={by} creator={by} producer={by}>
      <Page size="A4" style={s.page}>
        <Footer input={input} />
        <Masthead input={input} look={look} />
        <Hero input={input} look={look} />
        {m.platform === "klaviyo" ? (
          <EmailBody m={m} images={images} look={look} />
        ) : (
          <>
            <Glance m={m} />
            <Trend m={m} look={look} />
            <Platforms m={m} />
            <TopPosts m={m} images={images} look={look} />
          </>
        )}
        {/* The detailed email report ends on the numbers: what the team learned travels in the message */}
        {m.platform === "klaviyo" && m.detail ? null : <Takeaways m={m} sections={input.sections} look={look} />}
        {input.dashboard && !input.whiteLabel ? (
          <Link src={input.dashboard} style={{ fontSize: 8, color: look.primary, fontFamily: "Helvetica-Bold", textDecoration: "none", marginTop: 2 }}>
            See every number, any dates, on your live dashboard
          </Link>
        ) : null}
      </Page>
    </Document>
  );
}
