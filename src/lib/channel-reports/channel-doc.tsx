import { Circle, Defs, Document, G, Image, Line, LinearGradient, Link, Page, Rect, Stop, Svg, Text, View } from "@react-pdf/renderer";
import { docKit, KAIZEN_RED, lookFor, type Look, type WeeklyBrand } from "@/lib/reports/weekly-doc";
import { scrubAgency, scrubSections } from "@/lib/reports/white-label";
import type { Sections } from "@/lib/reports/write";
import { checkText, pointsLost } from "@/lib/email-score-calc";
import { channelName, int, metricsSupport, metricsTiles, money, pct, postRateText, signed, socialName, takeawaysFor, type EmailMetrics, type SocialMetrics, type TrendPoint } from "./core";

// A channel client report as a PDF, in the same design as the ads report (weekly-doc.tsx): the client's logo beside
// Kaizen's, the hero band with the period, four tiles with their move against the period before (green when it is good for
// the client, red when it isn't), the weekly trend, what the line is made of (email: the campaigns with their pictures and
// the flows, the list and deliverability; social: each platform and the best posts with their pictures), and three
// takeaways. The narrative (what we did, what we're doing, what's next) travels in the message, never in the document.
// A white label client's carries only the client's brand. Pictures come in ready-made (pdf.ts).

export type ChannelPdfInput = { client: string; clientId?: string | null; metrics: EmailMetrics | SocialMetrics; sections: Sections; whiteLabel?: boolean; brand?: WeeklyBrand | null; dashboard?: string | null };

const { s, Logo, Tile, INK, MUTED, FAINT, LINE, INNER, HERO_H } = docKit;
const AGENCY = "Kaizen Marketing";

/** Image data URIs by what they picture (a campaign's id, a post's platform and id) */
export type ChannelImages = Record<string, string | null>;
export const postKey = (p: { platform: string; id: string }) => `${p.platform}:${p.id}`;

const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const fullRange = (a: string, b: string) => `${day(a)} – ${new Date(`${b}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`;

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
          <Text style={s.heroSub}>{m.platform === "klaviyo" ? "Revenue, campaigns, flows & list health" : "Audience growth, reach & what resonated"}</Text>
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

function Glance({ m }: { m: EmailMetrics | SocialMetrics }) {
  const tiles = metricsTiles(m);
  const prior = m.kind === "monthly" ? "month" : "week";
  return (
    <View style={s.section} wrap={false}>
      <View style={s.head}>
        <Text style={s.h2}>Performance at a glance</Text>
        <Text style={s.sub}>{m.kind === "monthly" ? "Month-over-month movement" : "Week-over-week movement"} · Green = favorable, red = unfavorable</Text>
      </View>
      <View style={s.tiles}>
        {tiles.map((t) => (
          <View key={t.label} style={{ flex: 1 }}>
            <Tile label={t.label} value={t.value} mv={t.move} before={t.before} size={t.value.length > 9 ? 16 : 21} prior={prior} />
            {t.sub ? <Text style={[s.baseline, { marginTop: 4 }]}>{t.sub}</Text> : null}
          </View>
        ))}
      </View>
      <View style={s.support}>
        {metricsSupport(m).map((x) => (
          <Text key={x.label} style={s.supportText}>
            {x.label} <Text style={{ fontFamily: "Helvetica-Bold", color: INK }}>{x.value}</Text>
          </Text>
        ))}
      </View>
    </View>
  );
}

/** Eight weeks as bars (every value labelled): revenue for email, reach for social */
function Trend({ m, look }: { m: EmailMetrics | SocialMetrics; look: Look }) {
  const pts: TrendPoint[] = m.trend;
  if (!pts.length || pts.every((p) => !p.value)) return null;
  const email = m.platform === "klaviyo";
  const label = email ? "Attributed revenue by week" : "Reach by week";
  const W = INNER - 26;
  const H = 108;
  const top = 16;
  const base = H - 20;
  const max = Math.max(...pts.map((p) => p.value), 1);
  const slot = W / pts.length;
  const bar = Math.min(34, slot - 10);
  const fmt = (n: number) => (email ? money(n, (m as EmailMetrics).currency) : int(n));
  return (
    <View style={s.section} wrap={false}>
      <View style={s.head}>
        <Text style={s.h2}>{label}</Text>
        <Text style={s.sub}>Eight weeks ending {day(m.main.end)}</Text>
      </View>
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
                  {fmt(p.value)}
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

/** Text inside an Svg: react-pdf's own svg text */
const SvgTextRaw = Text as unknown as React.FC<{ x: number; y: number; fill?: string; textAnchor?: "start" | "middle" | "end"; style?: Record<string, unknown>; children: React.ReactNode }>;
function SvgText({ x, y, anchor, fill, children }: { x: number; y: number; anchor: "start" | "middle" | "end"; fill: string; children: React.ReactNode }) {
  return (
    <SvgTextRaw x={x} y={y} fill={fill} textAnchor={anchor} style={{ fontSize: 6.4, fontFamily: "Helvetica-Bold" }}>
      {children}
    </SvgTextRaw>
  );
}

function Thumb({ src }: { src: string | null | undefined }) {
  // eslint-disable-next-line jsx-a11y/alt-text -- a PDF image, no alt prop
  return src ? <Image src={src} style={s.thumb} /> : <View style={s.thumbBlank} />;
}

const th = [s.thText];
function Campaigns({ m, images }: { m: EmailMetrics; images: ChannelImages }) {
  if (!m.campaigns.length) return null;
  const list = m.campaigns.slice(0, 6);
  return (
    <View style={s.section}>
      <View style={s.head}>
        <Text style={s.h2}>Campaigns</Text>
        <Text style={s.sub}>{m.campaignsTotal} sent in {m.main.label} · best by revenue</Text>
      </View>
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

const BAND_HEX = { good: "#087a5e", watch: "#b7791f", bad: "#c23e4c" } as const;
const BAND_WORD = { good: "Healthy", watch: "Watch", bad: "At risk" } as const;

/** The email health score: the number in its colour, the seven checks against their bars, and what is holding it back */
function ScorePanel({ m }: { m: EmailMetrics }) {
  const sc = m.score;
  if (!sc || sc.unmeasured.length >= sc.checks.length) return null;
  const hex = BAND_HEX[sc.band];
  return (
    <View style={s.section} wrap={false}>
      <View style={s.head}>
        <Text style={s.h2}>Email health score</Text>
        <Text style={s.sub}>Seven checks of the account, last 30 days to {day(sc.window.to)} · green from 80, yellow from 60</Text>
      </View>
      <View style={[s.panel, { flexDirection: "row", gap: 18 }]}>
        <View style={{ width: 92 }}>
          <Text style={{ fontSize: 38, fontFamily: "Helvetica-Bold", color: hex }}>{sc.score}</Text>
          <Text style={{ fontSize: 8, color: FAINT }}>out of 100</Text>
          <Text style={{ fontSize: 9, fontFamily: "Helvetica-Bold", color: hex, marginTop: 4 }}>{BAND_WORD[sc.band]}</Text>
        </View>
        <View style={{ flex: 1 }}>
          {sc.checks.map((k) => (
            <View key={k.key} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 }}>
              <Text style={{ fontSize: 8.5, color: INK }}>
                {k.value == null ? "-" : k.met ? "Met" : "Short"}  {k.label}
              </Text>
              <Text style={{ fontSize: 8.5, color: k.value == null ? FAINT : k.met ? BAND_HEX.good : BAND_HEX.bad }}>
                {checkText(k.unit, k.value, m.currency)} <Text style={{ color: FAINT }}>(bar {checkText(k.unit, k.bar, m.currency)})</Text>
              </Text>
            </View>
          ))}
          {sc.weighingDown.length ? (
            <Text style={{ fontSize: 8.5, color: MUTED, marginTop: 6 }}>
              Holding it back: {sc.weighingDown.slice(0, 3).map((k) => `${k.label.toLowerCase()} (about ${pointsLost(k)} points)`).join(", ")}.
            </Text>
          ) : (
            <Text style={{ fontSize: 8.5, color: MUTED, marginTop: 6 }}>Every check is at or over its bar.</Text>
          )}
        </View>
      </View>
    </View>
  );
}

function Flows({ m }: { m: EmailMetrics }) {
  if (!m.flows.length) return null;
  const max = Math.max(...m.flows.map((f) => f.revenue), 1);
  return (
    <View style={s.section} wrap={false}>
      <View style={s.head}>
        <Text style={s.h2}>Flows</Text>
        <Text style={s.sub}>Revenue by flow · {m.flowsBasis}</Text>
      </View>
      <View style={s.panel}>
        {m.flows.slice(0, 6).map((f) => (
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

function ListHealth({ m }: { m: EmailMetrics }) {
  return (
    <View style={s.section} wrap={false}>
      <View style={s.head}>
        <Text style={s.h2}>List and deliverability</Text>
        <Text style={s.sub}>Bounces, spam complaints and unsubscribes against healthy lines</Text>
      </View>
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

function Platforms({ m }: { m: SocialMetrics }) {
  if (!m.platforms.length) return null;
  return (
    <View style={s.section} wrap={false}>
      <View style={s.head}>
        <Text style={s.h2}>By platform</Text>
        <Text style={s.sub}>{m.main.label} against {m.compare.label}</Text>
      </View>
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
      <View style={s.head}>
        <Text style={s.h2}>Top posts</Text>
        <Text style={s.sub}>{m.postsTotal} published · best by engagement</Text>
      </View>
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

function Takeaways({ m, sections, look }: { m: EmailMetrics | SocialMetrics; sections: Sections; look: Look }) {
  const items = takeawaysFor(m, sections.takeaways);
  if (!items.length) return null;
  return (
    <View style={s.section} wrap={false}>
      <View style={s.head}>
        <Text style={s.h2}>Key takeaways</Text>
        <Text style={s.sub}>From this period&apos;s {channelName(m.platform).toLowerCase()} numbers</Text>
      </View>
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
        <Text style={[s.footText, { textAlign: "right", flex: 1 }]}>{input.metrics.platform === "klaviyo" ? "Revenue is attributed by Klaviyo (Placed Order) · rates are of delivered email" : "Engagement rate is interactions over reach"}</Text>
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
        <Glance m={m} />
        <Trend m={m} look={look} />
        {m.platform === "klaviyo" ? (
          <>
            <ScorePanel m={m} />
            <Campaigns m={m} images={images} />
            <Flows m={m} />
            <ListHealth m={m} />
          </>
        ) : (
          <>
            <Platforms m={m} />
            <TopPosts m={m} images={images} look={look} />
          </>
        )}
        <Takeaways m={m} sections={input.sections} look={look} />
        {input.dashboard && !input.whiteLabel ? (
          <Link src={input.dashboard} style={{ fontSize: 8, color: look.primary, fontFamily: "Helvetica-Bold", textDecoration: "none", marginTop: 2 }}>
            See every number, any dates, on your live dashboard
          </Link>
        ) : null}
      </Page>
    </Document>
  );
}

