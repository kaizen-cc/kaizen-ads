import { Fragment } from "react";
import { Document, Font, Image, Link, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { ReportMetrics, TopAd } from "./metrics";
import type { Sections, Story } from "./write";
import { scrubAgency, scrubSections } from "./white-label";
import { campaignLines, columnKeys, conversionTiles, formatMetric, count, headlineTiles, kpiRows, metricLabel, metricText, money, percent, multiple, platformName, rowsFor, singular, tilesFor, type Delta, type MetricKey, type ReportLayout, type Tile } from "./format";

// The client report as a PDF document: the weekly recap (one platform, a page or two), the monthly recap as a landscape
// slide deck (one idea per slide: the cover, the month at a glance, then for each platform where it stands against its
// target, the numbers, each trend as its own story, the best ads, the campaigns and the plan, and a closing slide), and a
// built report (a cover, then each platform). Helvetica, lots of
// white, Kaizen red only where the eye should go (a white label client's: a neutral slate, no agency name, mark or link
// anywhere, so the partner can pass it on as their own). The same document on the server (the PDF the client gets) and in the
// studio's browser (the preview, drawn as the buyer edits, so a change shows at once); ad images come in ready-made.

/** extra: a built report's other date ranges (the first range is metrics) */
/** layout: the metrics the buyer chose (null: the defaults) */
export type ReportPart = { platform: "meta" | "google"; buyer: string | null; metrics: ReportMetrics; sections: Sections; extras: string | null; extra?: ReportMetrics[] | null; layout?: ReportLayout | null };
/** built: a report from the report builder (a cover, the whole account when it covers more than one service, then each) */
/** edit: the studio's preview, with an invisible link over every metric, row and column the buyer can change (never sent) */
/** dashboard: the client's live dashboard in their portal, linked from every part (when their portal is open) */
/** whiteLabel: a white label client's report: generic, with no agency name, mark, red or link anywhere */
export type ReportPdfInput = { client: string; kind: "weekly" | "monthly" | "built"; periodLabel: string; parts: ReportPart[]; edit?: boolean; dashboard?: string | null; /** The monthly recap's ask: next cycle's shot list (clients on a creative package) */ shots?: { month: string; items: string[]; url: string | null } | null; whiteLabel?: boolean };

// Words wrap whole: no "APPLICA-TION" in a tile label or a column header
Font.registerHyphenationCallback((word) => [word]);

const RED = "#c8102e";
const INK = "#0b0b0c";
const MUTED = "#6b6b73";
const FAINT = "#a1a1aa";
const LINE = "#e7e7ea";
const SOFT = "#f6f6f7";
const GOOD = "#16794c";
const BAD = "#c8102e";

const s = StyleSheet.create({
  page: { fontFamily: "Helvetica", fontSize: 9.5, color: INK, paddingTop: 44, paddingBottom: 60, paddingHorizontal: 44 }, // no lineHeight here: it would reach the page numbers, and a render-prop Text with one is dropped
  band: { backgroundColor: INK, marginTop: -44, marginHorizontal: -44, paddingHorizontal: 44, paddingTop: 34, paddingBottom: 26, marginBottom: 26 },
  bandRule: { width: 28, height: 3, backgroundColor: RED, marginBottom: 14 },
  bandClient: { color: "#ffffff", fontSize: 22, fontFamily: "Helvetica-Bold", letterSpacing: -0.3, lineHeight: 1.2 },
  bandMeta: { color: "#b4b4bb", fontSize: 10, marginTop: 6 },
  eyebrow: { fontSize: 7.5, letterSpacing: 1.2, color: MUTED, textTransform: "uppercase", fontFamily: "Helvetica-Bold", marginBottom: 8 },
  headline: { fontSize: 15, fontFamily: "Helvetica-Bold", lineHeight: 1.3, letterSpacing: -0.2, marginBottom: 8 },
  summary: { fontSize: 10, color: "#3a3a40", lineHeight: 1.55, marginBottom: 20 },
  section: { marginBottom: 22 },
  tiles: { flexDirection: "row", gap: 8 },
  tile: { flex: 1, borderWidth: 1, borderColor: LINE, borderRadius: 6, paddingVertical: 12, paddingHorizontal: 12 },
  tileLabel: { fontSize: 7.5, color: MUTED, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6 },
  tileValue: { fontSize: 18, fontFamily: "Helvetica-Bold", letterSpacing: -0.4, lineHeight: 1.2 },
  tileSub: { fontSize: 8, color: MUTED, marginTop: 3 },
  tileDelta: { fontSize: 8, fontFamily: "Helvetica-Bold", marginTop: 7 },
  mtd: { backgroundColor: SOFT, borderRadius: 6, paddingVertical: 10, paddingHorizontal: 12, fontSize: 9, color: "#3a3a40", lineHeight: 1.5 },
  ad: { flexDirection: "row", gap: 12, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: LINE, alignItems: "center" },
  adImage: { width: 54, height: 54, borderRadius: 4, objectFit: "cover" },
  adBlank: { width: 54, height: 54, borderRadius: 4, backgroundColor: SOFT },
  adName: { fontSize: 9.5, fontFamily: "Helvetica-Bold", marginBottom: 4 },
  adMeta: { fontSize: 8.5, color: MUTED, lineHeight: 1.4 },
  link: { fontSize: 8.5, color: RED, textDecoration: "none", fontFamily: "Helvetica-Bold" },
  th: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: INK, paddingBottom: 5, marginBottom: 2 },
  thText: { fontSize: 7.5, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6, fontFamily: "Helvetica-Bold" },
  tr: { flexDirection: "row", paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: LINE },
  td: { fontSize: 9, lineHeight: 1.35 },
  noteHead: { fontSize: 10.5, fontFamily: "Helvetica-Bold", marginBottom: 6 },
  bullet: { flexDirection: "row", marginBottom: 4, paddingRight: 8 },
  dot: { width: 12, color: RED, fontFamily: "Helvetica-Bold" },
  bulletText: { flex: 1, fontSize: 9.5, lineHeight: 1.5 },
  footer: { position: "absolute", bottom: 26, left: 44, right: 44, flexDirection: "row", justifyContent: "space-between", fontSize: 7.5, color: FAINT, borderTopWidth: 1, borderTopColor: LINE, paddingTop: 8, lineHeight: 1.2 },
  pageNumber: { position: "absolute", bottom: 26, left: 44, width: 507, textAlign: "right", fontSize: 7.5, color: FAINT }, // no lineHeight: it drops a render-prop Text
  platformHead: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", borderBottomWidth: 2, borderBottomColor: RED, paddingBottom: 8, marginBottom: 18 },
  platformName: { fontSize: 18, fontFamily: "Helvetica-Bold", letterSpacing: -0.3, lineHeight: 1.2 },
  extras: { borderLeftWidth: 2, borderLeftColor: RED, paddingLeft: 12, fontSize: 9.5, color: "#3a3a40", lineHeight: 1.55 },
});

/** The brand on the page: Kaizen's red and name, or (white label) a quiet slate accent and no agency anywhere */
type Brand = { accent: string; agency: string | null };
const KAIZEN: Brand = { accent: RED, agency: "Kaizen Marketing" };
const NEUTRAL: Brand = { accent: "#475569", agency: null };
const brandOf = (input: Pick<ReportPdfInput, "whiteLabel">): Brand => (input.whiteLabel ? NEUTRAL : KAIZEN);
/** A link a white label report may carry: never one to the agency's site or portal */
const linkFor = (b: Brand, url: string | null | undefined) => (url && (b.agency || !/kaizen/i.test(url)) ? url : null);

const toneColor = (d: Delta | null) => (!d ? FAINT : d.tone === "good" ? GOOD : d.tone === "bad" ? BAD : MUTED);

/** Where the studio's preview can click: an invisible link over the element (its address says what it is) */
export const EDIT_HOST = "https://edit.kaizen.invalid";
const hotStyle = { position: "absolute" as const, top: 0, left: 0, right: 0, bottom: 0, textDecoration: "none" as const };
function Hot({ href }: { href: string | null }) {
  return href ? <Link src={`${EDIT_HOST}/${href}`} style={hotStyle} /> : null;
}

function Footer({ client, b }: { client: string; b: Brand }) {
  return (
    <>
      {/* The page number sits on its own: a render-prop Text inside an absolute View drops the whole View */}
      <View style={s.footer} fixed>
        <Text>{b.agency ? `${b.agency} · ${client}` : `Performance report · ${client}`}</Text>
      </View>
      <Text style={s.pageNumber} fixed render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
    </>
  );
}

function Tiles({ tiles, hot }: { tiles: Tile[]; hot?: (i: number) => string | null }) {
  return (
    <View style={s.tiles}>
      {tiles.map((t, i) => (
        <View key={`${t.label}-${i}`} style={s.tile}>
          <Text style={s.tileLabel}>{t.label}</Text>
          <Text style={s.tileValue}>{t.value}</Text>
          {t.sub ? <Text style={s.tileSub}>{t.sub}</Text> : null}
          <Text style={[s.tileDelta, { color: toneColor(t.delta) }]}>{t.delta ? t.delta.text : "No comparison"}</Text>
          <Hot href={hot?.(i) ?? null} />
        </View>
      ))}
    </View>
  );
}

function TopAds({ ads, images, conversion, b }: { ads: TopAd[]; images: (string | null)[]; conversion: string; b: Brand }) {
  if (!ads.length) return null;
  const one = singular(conversion);
  return (
    <View style={s.section} wrap={false}>
      <Text style={s.eyebrow}>Top ads</Text>
      {ads.map((a, i) => (
        <View key={a.id} style={s.ad}>
          {/* eslint-disable-next-line jsx-a11y/alt-text -- a PDF image, no alt prop */}
          {images[i] ? <Image style={s.adImage} src={images[i]!} /> : <View style={s.adBlank} />}
          <View style={{ flex: 1 }}>
            <Text style={s.adName}>{a.name}</Text>
            <Text style={s.adMeta}>
              {count(a.results)} {conversion.toLowerCase()} · {money(a.costPerResult)} per {one} · {money(a.spend)} spent{a.ctr != null ? ` · ${percent(a.ctr)} CTR` : ""}
            </Text>
          </View>
          {linkFor(b, a.link) ? (
            <Link src={linkFor(b, a.link)!} style={[s.link, { color: b.accent }]}>
              View ad
            </Link>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function Campaigns({ m, limit, layout, hot }: { m: ReportMetrics; limit: number; layout?: ReportLayout | null; hot?: (what: string) => string | null }) {
  const rows = campaignLines(m, layout, limit);
  if (!rows.length) return null;
  const cols = columnKeys(m, layout);
  // The name takes what the numbers leave; every number column the same width, wide enough for its header on two lines
  const num = cols.length <= 3 ? 16 : cols.length === 4 ? 14 : cols.length === 5 ? 12.5 : 11;
  const nameW = `${100 - num * cols.length}%`;
  const label = (k: MetricKey) => (k === "results" ? (rows.some((c) => c.result && singular(c.result) !== singular(m.conversion)) ? "Results" : m.conversion) : k === "cost_per_result" ? (rows.some((c) => c.result && singular(c.result) !== singular(m.conversion)) ? "Per result" : `Per ${singular(m.conversion)}`) : metricLabel(m, k, true));
  return (
    <View style={s.section} wrap={false}>
      <Text style={s.eyebrow}>Campaigns</Text>
      <View style={s.th}>
        <Text style={[s.thText, { width: nameW }]}>Campaign</Text>
        {cols.map((k, i) => (
          <View key={k} style={{ width: `${num}%`, paddingLeft: 6 }}>
            <Text style={[s.thText, { textAlign: "right" }]}>{label(k)}</Text>
            <Hot href={hot?.(`col/${i}`) ?? null} />
          </View>
        ))}
      </View>
      {rows.map((c) => {
        // A campaign optimized for something else (an engagement campaign) shows its own result, named
        const own = c.result && singular(c.result) !== singular(m.conversion) ? c.result.toLowerCase() : null;
        return (
          <View key={c.name} style={s.tr}>
            <Text style={[s.td, { width: nameW, paddingRight: 8 }]}>{c.name}</Text>
            {cols.map((k) => (
              <View key={k} style={{ width: `${num}%`, paddingLeft: 6 }}>
                <Text style={[s.td, { textAlign: "right" }]}>{metricText(c, k)}</Text>
                {k === "results" && own ? <Text style={{ fontSize: 7, color: MUTED, textAlign: "right", marginTop: 1 }}>{own}</Text> : null}
              </View>
            ))}
            <Hot href={hot?.(`camp/${encodeURIComponent(c.name)}`) ?? null} />
          </View>
        );
      })}
    </View>
  );
}

function KpiTable({ m, layout, hot }: { m: ReportMetrics; layout?: ReportLayout | null; hot?: (i: number) => string | null }) {
  const w = ["28%", "18%", "18%", "14%", "22%"];
  return (
    <View style={s.section} wrap={false}>
      <Text style={s.eyebrow}>Key metrics</Text>
      <View style={s.th}>
        <Text style={[s.thText, { width: w[0] }]}>Metric</Text>
        <Text style={[s.thText, { width: w[1], textAlign: "right" }]}>{m.main.label}</Text>
        <Text style={[s.thText, { width: w[2], textAlign: "right" }]}>{m.compare.label}</Text>
        <Text style={[s.thText, { width: w[3], textAlign: "right" }]}>Change</Text>
        <Text style={[s.thText, { width: w[4], textAlign: "right" }]}>Target</Text>
      </View>
      {(layout?.table?.length ? rowsFor(m, layout.table) : kpiRows(m)).map((r, i) => (
        <View key={`${r.label}-${i}`} style={s.tr}>
          <Text style={[s.td, { width: w[0], fontFamily: "Helvetica-Bold" }]}>{r.label}</Text>
          <Text style={[s.td, { width: w[1], textAlign: "right" }]}>{r.now}</Text>
          <Text style={[s.td, { width: w[2], textAlign: "right", color: MUTED }]}>{r.before}</Text>
          <Text style={[s.td, { width: w[3], textAlign: "right", color: toneColor(r.delta), fontFamily: "Helvetica-Bold" }]}>{r.delta?.text ?? "–"}</Text>
          <Text style={[s.td, { width: w[4], textAlign: "right", color: MUTED }]}>{r.target}</Text>
          <Hot href={hot?.(i) ?? null} />
        </View>
      ))}
    </View>
  );
}

function Notes({ sections, hot, b }: { sections: Sections; hot?: (what: string) => string | null; b: Brand }) {
  const groups = [
    { key: "did", title: "What we did", items: sections.did },
    { key: "doing", title: "What we're doing", items: sections.doing },
    { key: "next", title: "What's next", items: sections.next },
  ].filter((g) => g.items?.length);
  if (!groups.length) return null;
  return (
    <View style={s.section}>
      {groups.map((g) => (
        <View key={g.title} style={{ marginBottom: 14 }} wrap={false}>
          <Text style={s.noteHead}>{g.title}</Text>
          {g.items.map((x, i) => (
            <View key={i} style={s.bullet}>
              <Text style={[s.dot, { color: b.accent }]}>•</Text>
              <Text style={s.bulletText}>{x}</Text>
              <Hot href={hot?.(`text/${g.key}/${i}`) ?? null} />
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

/** ROAS shows only when it's the KPI or the buyer put it in the report: a CPA report never sneaks it back in */
const showsRoas = (m: ReportMetrics, layout?: ReportLayout | null) => Boolean(m.roasKpi) || [...(layout?.tiles ?? []), ...(layout?.table ?? []), ...(layout?.columns ?? [])].some((k) => String(k) === "roas");

function Mtd({ m, layout }: { m: ReportMetrics; layout?: ReportLayout | null }) {
  if (!m.mtd) return null;
  const a = m.mtd;
  const b = m.mtdCompare;
  const one = singular(m.conversion);
  const roas = showsRoas(m, layout);
  const line = (p: NonNullable<ReportMetrics["mtd"]>) => `${money(p.spend)} spent, ${count(p.results)} ${m.conversion.toLowerCase()}${p.costPerResult != null ? ` at ${money(p.costPerResult)} per ${one}` : ""}${p.revenue > 0 && roas ? `, ${multiple(p.roas)} ROAS` : ""}`;
  return (
    <View style={s.section} wrap={false}>
      <Text style={s.eyebrow}>Month to date</Text>
      <Text style={s.mtd}>
        <Text style={{ fontFamily: "Helvetica-Bold", color: INK }}>{a.label}: </Text>
        {line(a)}
        {b ? <Text style={{ color: MUTED }}>{`   vs ${b.label}: ${line(b)}`}</Text> : null}
      </Text>
    </View>
  );
}

function Band({ client, title, period, b }: { client: string; title: string; period: string; b: Brand }) {
  return (
    <View style={s.band}>
      <View style={[s.bandRule, { backgroundColor: b.accent }]} />
      <Text style={s.bandClient}>{client}</Text>
      <Text style={s.bandMeta}>
        {title} · {period}
      </Text>
    </View>
  );
}

/** Trend charts, each told as a story: the chart (bars, the latest in red), then what we see, why, and what's next */
function Stories({ stories, hot, b }: { stories?: Story[]; hot?: (what: string) => string | null; b: Brand }) {
  const list = (stories ?? []).filter((st) => st.points?.length);
  if (!list.length) return null;
  return (
    <>
      {list.map((st, i) => {
        const pts = st.points!;
        const vals = pts.map((p) => p.value ?? 0);
        const max = Math.max(...vals, 0) || 1;
        const fmt = (v: number | null) => formatMetric(st.metric, v);
        const lines = [
          ["What we see", st.see, "see"],
          ["Why", st.why, "why"],
          ["What's next", st.next, "next"],
        ].filter(([, t]) => t?.trim());
        return (
          <View key={i} style={s.section} wrap={false}>
            <View>
              <Text style={s.eyebrow}>{st.title}</Text>
              <Hot href={hot?.(`text/story-${i}-title`) ?? null} />
            </View>
            <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, height: 120, borderBottomWidth: 1, borderBottomColor: LINE, paddingTop: 14 }}>
              {pts.map((p, k) => {
                const last = k === pts.length - 1;
                return (
                  <View key={k} style={{ flex: 1, alignItems: "center", justifyContent: "flex-end", height: "100%" }}>
                    <Text style={{ fontSize: 7.5, color: last ? INK : MUTED, fontFamily: last ? "Helvetica-Bold" : "Helvetica", marginBottom: 3 }}>{fmt(p.value)}</Text>
                    <View style={{ width: "62%", height: `${Math.max(2, ((p.value ?? 0) / max) * 82)}%`, backgroundColor: last ? b.accent : "#d4d4d8", borderTopLeftRadius: 3, borderTopRightRadius: 3 }} />
                  </View>
                );
              })}
              <Hot href={hot?.(`story/${i}`) ?? null} />
            </View>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 4, marginBottom: 10 }}>
              {pts.map((p, k) => (
                <Text key={k} style={{ flex: 1, fontSize: 7, color: MUTED, textAlign: "center" }}>
                  {p.label}
                </Text>
              ))}
            </View>
            {lines.map(([label, text, key]) => (
              <View key={key} style={{ flexDirection: "row", gap: 8, marginBottom: 5 }}>
                <Text style={{ width: 70, fontSize: 8, fontFamily: "Helvetica-Bold", color: key === "next" ? b.accent : INK, textTransform: "uppercase", letterSpacing: 0.4, paddingTop: 1 }}>{label}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 9.5, lineHeight: 1.5, color: "#3a3a40" }}>{text}</Text>
                  <Hot href={hot?.(`text/story-${i}-${key}`) ?? null} />
                </View>
              </View>
            ))}
          </View>
        );
      })}
    </>
  );
}

/** The headline and summary, each a click target in the studio */
function Words({ input, part }: { input: ReportPdfInput; part: ReportPart }) {
  const hot = hotFor<string>(input, part, null);
  return (
    <>
      <View>
        <Text style={s.headline}>{part.sections.headline}</Text>
        <Hot href={hot?.("text/headline") ?? null} />
      </View>
      {part.sections.summary ? (
        <View>
          <Text style={s.summary}>{part.sections.summary}</Text>
          <Hot href={hot?.("text/summary") ?? null} />
        </View>
      ) : null}
      {input.dashboard && !input.whiteLabel ? (
        <Link src={input.dashboard} style={{ marginTop: -10, marginBottom: 18, fontSize: 9, color: RED, fontFamily: "Helvetica-Bold", textDecoration: "none" }}>
          See every number, any dates, on your live dashboard →
        </Link>
      ) : null}
    </>
  );
}

function Weekly({ input, part, images }: { input: ReportPdfInput; part: ReportPart; images: (string | null)[] }) {
  const m = part.metrics;
  const b = brandOf(input);
  return (
    <Page size="A4" style={s.page}>
      <Footer client={input.client} b={b} />
      <Band client={input.client} title={`Weekly report · ${platformName(part.platform)}`} period={input.periodLabel} b={b} />
      <Words input={input} part={part} />
      <View style={s.section}>
        <Text style={s.eyebrow}>Last 7 days vs the week before</Text>
        <Tiles tiles={part.layout?.tiles?.length ? tilesFor(m, part.layout.tiles) : headlineTiles(m)} hot={hotFor(input, part, "tile")} />
      </View>
      <Stories stories={part.sections.stories} hot={hotFor(input, part, null)} b={b} />
      <Mtd m={m} layout={part.layout} />
      <TopAds ads={m.topAds.slice(0, 3)} images={images} conversion={m.conversion} b={b} />
      <Campaigns m={m} limit={6} layout={part.layout} hot={hotFor(input, part, null)} />
      <Notes sections={part.sections} hot={hotFor(input, part, null)} b={b} />
      {part.buyer && b.agency ? (
        <Text style={{ fontSize: 9, color: MUTED }}>
          Prepared by {part.buyer}, {b.agency}
        </Text>
      ) : null}
    </Page>
  );
}

/** A built report covering several services: the whole account first, each service side by side, for every range. */
function Overview({ input }: { input: ReportPdfInput }) {
  const ranges = [input.parts[0].metrics, ...(input.parts[0].extra ?? [])].map((m) => m.main.label);
  const w = ["30%", "17.5%", "17.5%", "17.5%", "17.5%"];
  const b = brandOf(input);
  return (
    <Page size="A4" style={s.page}>
      <Footer client={input.client} b={b} />
      <Band client={input.client} title="The whole account" period={input.periodLabel} b={b} />
      {ranges.map((label, ri) => {
        const rows = input.parts.map((p) => ({ p, m: ri === 0 ? p.metrics : p.extra?.[ri - 1] })).filter((x): x is { p: ReportPart; m: ReportMetrics } => Boolean(x.m));
        const spend = rows.reduce((n, x) => n + x.m.main.spend, 0);
        const before = rows.reduce((n, x) => n + x.m.compare.spend, 0);
        return (
          <View key={label} style={s.section} wrap={false}>
            <Text style={s.eyebrow}>{label}</Text>
            <Text style={{ fontSize: 10, color: "#3a3a40", marginBottom: 10 }}>
              {money(spend)} across {rows.length} services{before ? `, against ${money(before)} the period before` : ""}.
            </Text>
            <View style={s.th}>
              <Text style={[s.thText, { width: w[0] }]}>Service</Text>
              <Text style={[s.thText, { width: w[1], textAlign: "right" }]}>Spend</Text>
              <Text style={[s.thText, { width: w[2], textAlign: "right" }]}>Results</Text>
              <Text style={[s.thText, { width: w[3], textAlign: "right" }]}>Per result</Text>
              <Text style={[s.thText, { width: w[4], textAlign: "right" }]}>ROAS</Text>
            </View>
            {rows.map(({ p, m }) => (
              <View key={p.platform} style={s.tr}>
                <Text style={[s.td, { width: w[0], fontFamily: "Helvetica-Bold" }]}>
                  {platformName(p.platform)} <Text style={{ color: MUTED, fontFamily: "Helvetica" }}>· {m.conversion}</Text>
                </Text>
                <Text style={[s.td, { width: w[1], textAlign: "right" }]}>{money(m.main.spend)}</Text>
                <Text style={[s.td, { width: w[2], textAlign: "right" }]}>{count(m.main.results)}</Text>
                <Text style={[s.td, { width: w[3], textAlign: "right" }]}>{money(m.main.costPerResult)}</Text>
                <Text style={[s.td, { width: w[4], textAlign: "right" }]}>{m.main.roas != null ? multiple(m.main.roas) : "–"}</Text>
              </View>
            ))}
          </View>
        );
      })}
      <View style={s.section}>
        <Text style={s.eyebrow}>In short</Text>
        {input.parts.map((p) => (
          <View key={p.platform} style={s.bullet}>
            <Text style={[s.dot, { color: b.accent }]}>•</Text>
            <Text style={s.bulletText}>
              <Text style={{ fontFamily: "Helvetica-Bold" }}>{platformName(p.platform)}: </Text>
              {p.sections.headline}
            </Text>
          </View>
        ))}
      </View>
    </Page>
  );
}

/** A built report's other date ranges for one service, each with its headline tiles against its own comparison. */
function Ranges({ part }: { part: ReportPart }) {
  const keys = part.layout?.tiles?.length ? part.layout.tiles : null;
  if (!part.extra?.length) return null;
  return (
    <>
      {part.extra.map((m) => (
        <View key={m.main.label} style={s.section} wrap={false}>
          <Text style={s.eyebrow}>
            {m.main.label} vs {m.compare.label}
          </Text>
          <Tiles tiles={keys ? tilesFor(m, keys) : headlineTiles(m)} />
        </View>
      ))}
    </>
  );
}

function Cover({ input }: { input: ReportPdfInput }) {
  const buyers = [...new Set(input.parts.map((p) => p.buyer).filter(Boolean))];
  const b = brandOf(input);
  return (
    <Page size="A4" style={[s.page, { backgroundColor: INK, color: "#ffffff", justifyContent: "space-between", paddingTop: 72, paddingBottom: 56 }]}>
      <Text style={{ fontSize: 10, fontFamily: "Helvetica-Bold", letterSpacing: 2, color: "#ffffff" }}>{(b.agency ?? "Performance report").toUpperCase()}</Text>
      <View>
        <View style={{ width: 40, height: 4, backgroundColor: b.accent, marginBottom: 22 }} />
        <Text style={{ fontSize: 40, fontFamily: "Helvetica-Bold", letterSpacing: -1, lineHeight: 1.1 }}>{input.client}</Text>
        <Text style={{ fontSize: 16, color: "#b4b4bb", marginTop: 12 }}>
          Report · {input.periodLabel}
        </Text>
        <Text style={{ fontSize: 10, color: "#7a7a82", marginTop: 26 }}>{input.parts.map((p) => platformName(p.platform)).join("  ·  ")}</Text>
      </View>
      <Text style={{ fontSize: 9, color: "#7a7a82" }}>{!b.agency ? `Prepared for ${input.client}` : buyers.length ? `Prepared by ${buyers.join(" and ")}` : `Prepared by ${b.agency}`}</Text>
    </Page>
  );
}

function MonthlyPart({ input, part, images }: { input: ReportPdfInput; part: ReportPart; images: (string | null)[] }) {
  const m = part.metrics;
  const b = brandOf(input);
  return (
    <Page size="A4" style={s.page}>
      <Footer client={input.client} b={b} />
      <View style={[s.platformHead, { borderBottomColor: b.accent }]}>
        <Text style={s.platformName}>{platformName(part.platform)}</Text>
        <Text style={{ fontSize: 9, color: MUTED }}>
          {m.main.label} vs {m.compare.label}
        </Text>
      </View>
      <Words input={input} part={part} />
      <View style={s.section}>
        <Text style={s.eyebrow}>{input.kind === "built" ? `${m.main.label} vs ${m.compare.label}` : "Conversions"}</Text>
        <Tiles tiles={part.layout?.tiles?.length ? tilesFor(m, part.layout.tiles) : input.kind === "built" ? headlineTiles(m) : conversionTiles(m)} hot={hotFor(input, part, "tile")} />
      </View>
      <Stories stories={part.sections.stories} hot={hotFor(input, part, null)} b={b} />
      <Ranges part={part} />
      <KpiTable m={m} layout={part.layout} hot={hotFor(input, part, "row")} />
      {part.platform === "meta" ? <TopAds ads={m.topAds.slice(0, 3)} images={images} conversion={m.conversion} b={b} /> : null}
      <Campaigns m={m} limit={8} layout={part.layout} hot={hotFor(input, part, null)} />
      <Notes sections={part.sections} hot={hotFor(input, part, null)} b={b} />
      {part.extras?.trim() ? (
        <View style={s.section} wrap={false}>
          <Text style={s.eyebrow}>{input.kind === "built" ? "Also" : "Also this month"}</Text>
          <View>
            <Text style={[s.extras, { borderLeftColor: b.accent }]}>{part.extras.trim()}</Text>
            <Hot href={hotFor<string>(input, part, null)?.("text/extras") ?? null} />
          </View>
        </View>
      ) : null}
    </Page>
  );
}

// ---- The monthly recap as a deck: landscape slides, one idea each ----

const SLIDE_W = 842;
const SLIDE_H = 595;
const PAD = 48;
const d = StyleSheet.create({
  slide: { fontFamily: "Helvetica", fontSize: 11, color: INK, paddingTop: PAD, paddingBottom: PAD + 18, paddingHorizontal: PAD },
  dark: { backgroundColor: INK, color: "#ffffff" },
  kicker: { fontSize: 8.5, letterSpacing: 1.6, color: RED, textTransform: "uppercase", fontFamily: "Helvetica-Bold", marginBottom: 10 },
  title: { fontSize: 26, fontFamily: "Helvetica-Bold", letterSpacing: -0.6, lineHeight: 1.15, marginBottom: 18 },
  footer: { position: "absolute", bottom: 24, left: PAD, right: PAD, flexDirection: "row", justifyContent: "space-between", fontSize: 7.5, color: FAINT, lineHeight: 1.2 },
  pageNumber: { position: "absolute", bottom: 24, left: PAD, width: SLIDE_W - PAD * 2, textAlign: "right", fontSize: 7.5, color: FAINT },
  bigTile: { flex: 1, borderWidth: 1, borderColor: LINE, borderRadius: 10, paddingVertical: 18, paddingHorizontal: 18 },
  bigLabel: { fontSize: 8, color: MUTED, textTransform: "uppercase", letterSpacing: 0.9, marginBottom: 8 },
  bigValue: { fontSize: 30, fontFamily: "Helvetica-Bold", letterSpacing: -0.8, lineHeight: 1.1 },
});

function SlideFooter({ client, dark, b }: { client: string; dark?: boolean; b: Brand }) {
  return (
    <>
      <View style={d.footer} fixed>
        <Text style={dark ? { color: "#7a7a82" } : undefined}>{b.agency ? `${b.agency} · ${client}` : `Performance report · ${client}`}</Text>
      </View>
      <Text style={[d.pageNumber, dark ? { color: "#7a7a82" } : {}]} fixed render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
    </>
  );
}

function Slide({ input, children, dark, kicker }: { input: ReportPdfInput; children: React.ReactNode; dark?: boolean; kicker?: string }) {
  const b = brandOf(input);
  return (
    <Page size={[SLIDE_W, SLIDE_H]} style={[d.slide, dark ? d.dark : {}]}>
      <SlideFooter client={input.client} dark={dark} b={b} />
      {kicker ? <Text style={[d.kicker, { color: b.accent }]}>{kicker}</Text> : null}
      {children}
    </Page>
  );
}

function DeckCover({ input }: { input: ReportPdfInput }) {
  const buyers = [...new Set(input.parts.map((p) => p.buyer).filter(Boolean))];
  const b = brandOf(input);
  return (
    <Page size={[SLIDE_W, SLIDE_H]} style={[d.slide, d.dark, { justifyContent: "space-between", paddingTop: 56, paddingBottom: 48 }]}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ fontSize: 10, fontFamily: "Helvetica-Bold", letterSpacing: 2.4 }}>{(b.agency ?? "Performance report").toUpperCase()}</Text>
        <Text style={{ fontSize: 10, color: "#7a7a82" }}>{input.parts.map((p) => platformName(p.platform)).join("  ·  ")}</Text>
      </View>
      <View>
        <View style={{ width: 56, height: 5, backgroundColor: b.accent, marginBottom: 26 }} />
        <Text style={{ fontSize: 54, fontFamily: "Helvetica-Bold", letterSpacing: -1.6, lineHeight: 1.05 }}>{input.client}</Text>
        <Text style={{ fontSize: 20, color: "#b4b4bb", marginTop: 14 }}>Monthly recap · {input.periodLabel}</Text>
      </View>
      <Text style={{ fontSize: 10, color: "#7a7a82" }}>{!b.agency ? `Prepared for ${input.client}` : buyers.length ? `Prepared by ${buyers.join(" and ")}` : `Prepared by ${b.agency}`}</Text>
    </Page>
  );
}

/** Where a platform stands against its target: the KPI, the target, and spend against the budget */
function TargetCard({ m }: { m: ReportMetrics }) {
  const one = singular(m.conversion);
  const value = m.roasKpi ? m.main.roas : m.main.costPerResult;
  const show = (n: number | null) => (m.roasKpi ? multiple(n) : money(n));
  const on = m.target == null || value == null ? null : m.roasKpi ? value >= m.target : value <= m.target;
  return (
    <View style={{ width: 270, alignSelf: "flex-start", backgroundColor: SOFT, borderRadius: 12, padding: 22, gap: 16 }}>
      <View>
        <Text style={d.bigLabel}>{m.roasKpi ? "ROAS" : `Cost per ${one}`}</Text>
        <Text style={[d.bigValue, { fontSize: 38, color: on == null ? INK : on ? GOOD : BAD }]}>{show(value)}</Text>
        <Text style={{ fontSize: 9.5, color: MUTED, marginTop: 6 }}>
          {m.target != null ? `Target ${show(m.target)}${on == null ? "" : on ? " · on target" : " · off target"}` : "No target set yet"}
        </Text>
      </View>
      <View style={{ height: 1, backgroundColor: LINE }} />
      <View style={{ flexDirection: "row", gap: 16 }}>
        <View style={{ flex: 1 }}>
          <Text style={d.bigLabel}>{m.conversion}</Text>
          <Text style={{ fontSize: 18, fontFamily: "Helvetica-Bold" }}>{count(m.main.results)}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={d.bigLabel}>Spend</Text>
          <Text style={{ fontSize: 18, fontFamily: "Helvetica-Bold" }}>{money(m.main.spend)}</Text>
          {m.monthlyBudget ? <Text style={{ fontSize: 8.5, color: MUTED, marginTop: 3 }}>of {money(m.monthlyBudget)} budget</Text> : null}
        </View>
      </View>
    </View>
  );
}

/** More than one platform: each side by side, with its headline */
function DeckGlance({ input }: { input: ReportPdfInput }) {
  return (
    <Slide input={input} kicker="The month at a glance">
      <Text style={d.title}>{input.periodLabel}</Text>
      <View style={{ flexDirection: "row", gap: 16 }}>
        {input.parts.map((p) => {
          const m = p.metrics;
          return (
            <View key={p.platform} style={{ flex: 1, borderTopWidth: 3, borderTopColor: brandOf(input).accent, paddingTop: 14 }}>
              <Text style={{ fontSize: 15, fontFamily: "Helvetica-Bold", marginBottom: 12 }}>{platformName(p.platform)}</Text>
              <View style={{ flexDirection: "row", gap: 12, marginBottom: 14 }}>
                <View style={{ flex: 1 }}>
                  <Text style={d.bigLabel}>Spend</Text>
                  <Text style={{ fontSize: 20, fontFamily: "Helvetica-Bold" }}>{money(m.main.spend)}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={d.bigLabel}>{m.conversion}</Text>
                  <Text style={{ fontSize: 20, fontFamily: "Helvetica-Bold" }}>{count(m.main.results)}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={d.bigLabel}>{m.roasKpi ? "ROAS" : `Per ${singular(m.conversion)}`}</Text>
                  <Text style={{ fontSize: 20, fontFamily: "Helvetica-Bold" }}>{m.roasKpi ? multiple(m.main.roas) : money(m.main.costPerResult)}</Text>
                </View>
              </View>
              <Text style={{ fontSize: 11, lineHeight: 1.5, color: "#3a3a40" }}>{p.sections.headline}</Text>
            </View>
          );
        })}
      </View>
    </Slide>
  );
}

/** A platform's opening slide: the headline and summary beside where it stands against target */
function DeckIntro({ input, part }: { input: ReportPdfInput; part: ReportPart }) {
  const hot = hotFor<string>(input, part, null);
  const m = part.metrics;
  return (
    <Slide input={input} kicker={`${platformName(part.platform)} · ${m.main.label} vs ${m.compare.label}`}>
      <View style={{ flexDirection: "row", gap: 36, flexGrow: 1 }}>
        <View style={{ flex: 1 }}>
          <View>
            <Text style={[d.title, { fontSize: 28 }]}>{part.sections.headline}</Text>
            <Hot href={hot?.("text/headline") ?? null} />
          </View>
          {part.sections.summary ? (
            <View>
              <Text style={{ fontSize: 12, lineHeight: 1.6, color: "#3a3a40" }}>{part.sections.summary}</Text>
              <Hot href={hot?.("text/summary") ?? null} />
            </View>
          ) : null}
          {input.dashboard && !input.whiteLabel ? (
            <Link src={input.dashboard} style={{ marginTop: 18, fontSize: 10, color: RED, fontFamily: "Helvetica-Bold", textDecoration: "none" }}>
              See every number, any dates, on your live dashboard →
            </Link>
          ) : null}
        </View>
        <TargetCard m={m} />
      </View>
    </Slide>
  );
}

/** The numbers: the conversion tiles, big, then the key metrics against last month and the target */
function DeckNumbers({ input, part }: { input: ReportPdfInput; part: ReportPart }) {
  const m = part.metrics;
  const tiles = part.layout?.tiles?.length ? tilesFor(m, part.layout.tiles) : conversionTiles(m);
  const hot = hotFor<number>(input, part, "tile");
  return (
    <Slide input={input} kicker={`${platformName(part.platform)} · The numbers`}>
      <View style={{ flexDirection: "row", gap: 12, marginBottom: 22 }}>
        {tiles.map((t, i) => (
          <View key={`${t.label}-${i}`} style={d.bigTile}>
            <Text style={d.bigLabel}>{t.label}</Text>
            <Text style={d.bigValue}>{t.value}</Text>
            {t.sub ? <Text style={{ fontSize: 8.5, color: MUTED, marginTop: 4 }}>{t.sub}</Text> : null}
            <Text style={{ fontSize: 10, fontFamily: "Helvetica-Bold", marginTop: 10, color: toneColor(t.delta) }}>{t.delta ? t.delta.text : "No comparison"}</Text>
            <Hot href={hot?.(i) ?? null} />
          </View>
        ))}
      </View>
      <KpiTable m={m} layout={part.layout} hot={hotFor(input, part, "row")} />
    </Slide>
  );
}

/** One trend, one slide: the chart large on the left, what we see, why and what's next on the right */
function DeckStory({ input, part, story, i }: { input: ReportPdfInput; part: ReportPart; story: Story; i: number }) {
  const hot = hotFor<string>(input, part, null);
  const b = brandOf(input);
  const pts = story.points ?? [];
  const max = Math.max(...pts.map((p) => p.value ?? 0), 0) || 1;
  const fmt = (v: number | null) => formatMetric(story.metric, v);
  const lines = [
    ["What we see", story.see, "see"],
    ["Why", story.why, "why"],
    ["What's next", story.next, "next"],
  ].filter(([, t]) => t?.trim());
  return (
    <Slide input={input} kicker={`${platformName(part.platform)} · Trend`}>
      <View>
        <Text style={d.title}>{story.title}</Text>
        <Hot href={hot?.(`text/story-${i}-title`) ?? null} />
      </View>
      <View style={{ flexDirection: "row", gap: 32 }}>
        <View style={{ flex: 1.4 }}>
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 10, height: 290, borderBottomWidth: 1, borderBottomColor: LINE, paddingTop: 18 }}>
            {pts.map((p, k) => {
              const last = k === pts.length - 1;
              return (
                <View key={k} style={{ flex: 1, alignItems: "center", justifyContent: "flex-end", height: "100%" }}>
                  <Text style={{ fontSize: 9, color: last ? INK : MUTED, fontFamily: last ? "Helvetica-Bold" : "Helvetica", marginBottom: 4 }}>{fmt(p.value)}</Text>
                  <View style={{ width: "64%", height: `${Math.max(2, ((p.value ?? 0) / max) * 86)}%`, backgroundColor: last ? b.accent : "#d4d4d8", borderTopLeftRadius: 4, borderTopRightRadius: 4 }} />
                </View>
              );
            })}
            <Hot href={hot?.(`story/${i}`) ?? null} />
          </View>
          <View style={{ flexDirection: "row", gap: 10, marginTop: 6 }}>
            {pts.map((p, k) => (
              <Text key={k} style={{ flex: 1, fontSize: 8, color: MUTED, textAlign: "center" }}>
                {p.label}
              </Text>
            ))}
          </View>
        </View>
        <View style={{ flex: 1, gap: 16 }}>
          {lines.map(([label, text, key]) => (
            <View key={key}>
              <Text style={{ fontSize: 8.5, fontFamily: "Helvetica-Bold", color: key === "next" ? b.accent : INK, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 5 }}>{label}</Text>
              <View>
                <Text style={{ fontSize: 11.5, lineHeight: 1.55, color: "#3a3a40" }}>{text}</Text>
                <Hot href={hot?.(`text/story-${i}-${key}`) ?? null} />
              </View>
            </View>
          ))}
        </View>
      </View>
    </Slide>
  );
}

/** The best ads, as the creative: up to three side by side */
function DeckAds({ input, part, images }: { input: ReportPdfInput; part: ReportPart; images: (string | null)[] }) {
  const m = part.metrics;
  const ads = m.topAds.slice(0, 3);
  if (!ads.length) return null;
  const one = singular(m.conversion);
  return (
    <Slide input={input} kicker={`${platformName(part.platform)} · What worked`}>
      <Text style={d.title}>The ads that carried the month</Text>
      <View style={{ flexDirection: "row", gap: 18 }}>
        {ads.map((a, i) => (
          <View key={a.id} style={{ flex: 1, maxWidth: 236 }}>
            {/* eslint-disable-next-line jsx-a11y/alt-text -- a PDF image, no alt prop */}
            {images[i] ? <Image style={{ width: "100%", height: 200, borderRadius: 8, objectFit: "cover" }} src={images[i]!} /> : <View style={{ width: "100%", height: 200, borderRadius: 8, backgroundColor: SOFT }} />}
            <Text style={{ fontSize: 10.5, fontFamily: "Helvetica-Bold", marginTop: 10, marginBottom: 4 }}>{a.name}</Text>
            <Text style={{ fontSize: 9.5, color: MUTED, lineHeight: 1.45 }}>
              {count(a.results)} {m.conversion.toLowerCase()} · {money(a.costPerResult)} per {one}
            </Text>
            <Text style={{ fontSize: 9.5, color: MUTED, lineHeight: 1.45 }}>
              {money(a.spend)} spent{a.ctr != null ? ` · ${percent(a.ctr)} CTR` : ""}
            </Text>
            {a.copy?.body ? <Text style={{ fontSize: 9, color: "#3a3a40", lineHeight: 1.45, marginTop: 6 }}>{a.copy.body.length > 150 ? `${a.copy.body.slice(0, 147).trimEnd()}…` : a.copy.body}</Text> : null}
            {linkFor(brandOf(input), a.link) ? (
              <Link src={linkFor(brandOf(input), a.link)!} style={[s.link, { marginTop: 8, color: brandOf(input).accent }]}>
                View ad →
              </Link>
            ) : null}
          </View>
        ))}
      </View>
    </Slide>
  );
}

/** The plan: what we did, what we're doing and what's next, side by side, then anything else this month */
function DeckPlan({ input, part }: { input: ReportPdfInput; part: ReportPart }) {
  const hot = hotFor<string>(input, part, null);
  const b = brandOf(input);
  const groups = [
    { key: "did", title: "What we did", items: part.sections.did },
    { key: "doing", title: "What we're doing", items: part.sections.doing },
    { key: "next", title: "What's next", items: part.sections.next },
  ].filter((g) => g.items?.length);
  if (!groups.length && !part.extras?.trim()) return null;
  return (
    <Slide input={input} kicker={`${platformName(part.platform)} · The plan`}>
      <View style={{ flexDirection: "row", gap: 22 }}>
        {groups.map((g) => (
          <View key={g.key} style={{ flex: 1, borderTopWidth: 3, borderTopColor: g.key === "next" ? b.accent : INK, paddingTop: 12 }}>
            <Text style={{ fontSize: 14, fontFamily: "Helvetica-Bold", marginBottom: 10 }}>{g.title}</Text>
            {g.items.map((x, i) => (
              <View key={i} style={[s.bullet, { marginBottom: 7 }]}>
                <Text style={[s.dot, { color: b.accent }]}>•</Text>
                <Text style={[s.bulletText, { fontSize: 10.5 }]}>{x}</Text>
                <Hot href={hot?.(`text/${g.key}/${i}`) ?? null} />
              </View>
            ))}
          </View>
        ))}
      </View>
      {part.extras?.trim() ? (
        <View style={{ marginTop: 22 }}>
          <Text style={s.eyebrow}>Also this month</Text>
          <View>
            <Text style={[s.extras, { fontSize: 10.5, borderLeftColor: b.accent }]}>{part.extras.trim()}</Text>
            <Hot href={hot?.("text/extras") ?? null} />
          </View>
        </View>
      ) : null}
      {part.buyer && b.agency ? (
        <Text style={{ fontSize: 9, color: MUTED, marginTop: 18 }}>
          Prepared by {part.buyer}, {b.agency}
        </Text>
      ) : null}
    </Slide>
  );
}

/** The close: next month in a line per platform, and where to see it live */
function DeckClose({ input }: { input: ReportPdfInput }) {
  const next = input.parts.flatMap((p) => p.sections.next.slice(0, 3).map((x) => ({ p: p.platform, x })));
  const b = brandOf(input);
  const shotsUrl = linkFor(b, input.shots?.url);
  return (
    <Page size={[SLIDE_W, SLIDE_H]} style={[d.slide, d.dark, { justifyContent: "center" }]}>
      <SlideFooter client={input.client} dark b={b} />
      <View style={{ width: 56, height: 5, backgroundColor: b.accent, marginBottom: 22 }} />
      <Text style={{ fontSize: 34, fontFamily: "Helvetica-Bold", letterSpacing: -0.8, marginBottom: 20 }}>Next month</Text>
      {next.map((n, i) => (
        <View key={i} style={{ flexDirection: "row", marginBottom: 8, maxWidth: 620 }}>
          <Text style={{ width: 70, fontSize: 9, color: "#7a7a82", paddingTop: 2 }}>{platformName(n.p)}</Text>
          <Text style={{ flex: 1, fontSize: 12, lineHeight: 1.5, color: "#e4e4e7" }}>{n.x}</Text>
        </View>
      ))}
      {input.shots?.items.length ? (
        <View style={{ marginTop: 18, maxWidth: 620, borderLeftWidth: 3, borderLeftColor: b.accent, paddingLeft: 12 }}>
          <Text style={{ fontSize: 12, fontFamily: "Helvetica-Bold", color: "#ffffff", marginBottom: 6 }}>What we need from you for {input.shots.month}</Text>
          {input.shots.items.slice(0, 6).map((x, i) => (
            <Text key={i} style={{ fontSize: 10.5, lineHeight: 1.5, color: "#e4e4e7" }}>
              • {x}
            </Text>
          ))}
          {input.shots.items.length > 6 ? <Text style={{ fontSize: 10, color: "#a1a1aa", marginTop: 2 }}>and {input.shots.items.length - 6} more</Text> : null}
          {shotsUrl ? (
            <Link src={shotsUrl} style={{ marginTop: 6, fontSize: 10.5, color: "#ffffff", fontFamily: "Helvetica-Bold", textDecoration: "none" }}>
              Send them on your shot list →
            </Link>
          ) : null}
        </View>
      ) : null}
      {input.dashboard && !input.whiteLabel ? (
        <Link src={input.dashboard} style={{ marginTop: 22, fontSize: 11, color: "#ffffff", fontFamily: "Helvetica-Bold", textDecoration: "none" }}>
          Your live dashboard, any day, any dates →
        </Link>
      ) : null}
    </Page>
  );
}

function MonthlyDeck({ input, images }: { input: ReportPdfInput; images: (string | null)[][] }) {
  return (
    <>
      <DeckCover input={input} />
      {input.parts.length > 1 ? <DeckGlance input={input} /> : null}
      {input.parts.map((p, i) => (
        <Fragment key={i}>
          <DeckIntro input={input} part={p} />
          <DeckNumbers input={input} part={p} />
          {(p.sections.stories ?? []).map((st, k) => (st.points?.length ? <DeckStory key={k} input={input} part={p} story={st} i={k} /> : null))}
          {p.platform === "meta" ? <DeckAds input={input} part={p} images={images[i] ?? []} /> : null}
          {campaignLines(p.metrics, p.layout, 10).length ? (
            <Slide input={input} kicker={platformName(p.platform)}>
              <Text style={d.title}>Where the budget went</Text>
              <Campaigns m={p.metrics} limit={10} layout={p.layout} hot={hotFor(input, p, null)} />
            </Slide>
          ) : null}
          <DeckPlan input={input} part={p} />
        </Fragment>
      ))}
      <DeckClose input={input} />
    </>
  );
}

/** The click targets for one part in the studio's preview: "<platform>/tile/2", "<platform>/col/1", "<platform>/camp/<name>" */
function hotFor<T extends number | string>(input: ReportPdfInput, part: ReportPart, kind: "tile" | "row" | null): ((x: T) => string | null) | undefined {
  if (!input.edit) return undefined;
  return (x: T) => `${part.platform}/${kind ? `${kind}/` : ""}${x}`;
}

/** The whole document. images: each part's top ads as data URIs (null where none could be fetched) */
export function ReportDocument({ input: given, images }: { input: ReportPdfInput; images: (string | null)[][] }) {
  // White label: every written line cleaned of the agency too (whatever the AI or the buyer wrote), and no portal links
  const input: ReportPdfInput = given.whiteLabel
    ? { ...given, dashboard: null, shots: given.shots ? { ...given.shots, url: linkFor(NEUTRAL, given.shots.url), items: given.shots.items.map(scrubAgency) } : given.shots, parts: given.parts.map((p) => ({ ...p, buyer: null, sections: scrubSections(p.sections), extras: p.extras ? scrubAgency(p.extras) : p.extras })) }
    : given;
  const title = `${input.client} · ${input.kind === "weekly" ? "Weekly report" : input.kind === "built" ? "Report" : "Monthly recap"} · ${input.periodLabel}`;
  // The file's own properties too: a white label report names no agency there either
  const by = brandOf(input).agency ?? "Performance report";
  return (
    <Document title={title} author={brandOf(input).agency ?? input.client} creator={by} producer={by}>
      {input.kind === "weekly" ? (
        input.parts.map((p, i) => <Weekly key={i} input={input} part={p} images={images[i] ?? []} />)
      ) : input.kind === "monthly" ? (
        <MonthlyDeck input={input} images={images} />
      ) : (
        <>
          <Cover input={input} />
          {input.kind === "built" && input.parts.length > 1 ? <Overview input={input} /> : null}
          {input.parts.map((p, i) => (
            <MonthlyPart key={i} input={input} part={p} images={images[i] ?? []} />
          ))}
        </>
      )}
    </Document>
  );
}
