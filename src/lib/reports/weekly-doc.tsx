import { Fragment } from "react";
import { Circle, Defs, Image, Line, LinearGradient, Link, Page, Path, Polygon, Rect, Stop, StyleSheet, Svg, Text, View } from "@react-pdf/renderer";
import type { ReportMetrics } from "./metrics";
import type { Sections } from "./write";
import type { ReportLayout } from "./format";
import { metricNumber, platformName } from "./format";
import { paletteFor, type Palette } from "./brand";
import { barMetric, barsRead, sayable, scoreHead, chartWeeks, costLabel, niceMax, scoreColumns, scoreValue, scorecardRows, shortLabel, supportKeys, takeawaysFor, weeklyTile, weeklyTileKeys, weeklyValue, type Move, type ScoreRow, type Takeaway } from "./weekly-core";

// The weekly client report, after the hand-made report the team loved: co-branded (the client's logo and colour beside
// Kaizen's, or only the client's for a white label client), then the week at a glance (four tiles, green when the move
// is good for the client, red when it isn't), five weeks of results and their cost, the creative scorecard (each ad's
// picture beside its numbers, best first by the client's KPI, or on Google each campaign and ad group), what each brought,
// and three takeaways. The narrative (what we did, what's next) travels in the message that carries the report; the
// buyer can print it here too ("Include our notes in the report"). A joint Meta + TikTok report is one document, a
// section per platform. A PDF can't sort or hover, so it's sorted by the KPI with every value labelled; the studio's
// preview is this same document.

/** Where the studio's preview can click: an invisible link over the element (its address says what it is) */
export const EDIT_HOST = "https://edit.kaizen.invalid";

/** The parts of the report input the weekly reads (the full type lives in report-doc.tsx) */
export type WeeklyPart = { platform: "meta" | "google" | "tiktok"; buyer: string | null; metrics: ReportMetrics; sections: Sections; extras: string | null; layout?: ReportLayout | null };
export type WeeklyBrand = { logo: string | null; light?: boolean; color: string | null; agencyLogo?: string | null };
export type WeeklyInput = { client: string; periodLabel: string; parts: WeeklyPart[]; edit?: boolean; dashboard?: string | null; whiteLabel?: boolean; brand?: WeeklyBrand | null };

const INK = "#15283c";
const MUTED = "#6b7b8c";
const FAINT = "#94a2b0";
const LINE = "#e3e9ef";
const BG = "#f4f7fa";
const GOOD = { fg: "#087a5e", bg: "#e3f6ee" };
const BAD = { fg: "#c23e4c", bg: "#ffebed" };
const FLAT = { fg: "#5f6f80", bg: "#eef2f5" };
const W = 595.28;
const PAD = 34;
const INNER = W - PAD * 2;

const s = StyleSheet.create({
  page: { fontFamily: "Helvetica", fontSize: 9, color: INK, backgroundColor: BG, paddingTop: 28, paddingBottom: 54, paddingHorizontal: PAD },
  mast: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 16 },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  divider: { width: 1, height: 24, backgroundColor: "#cbd6df" },
  topRight: { alignItems: "flex-end" },
  topKicker: { fontSize: 7, letterSpacing: 1.6, fontFamily: "Helvetica-Bold", color: MUTED, textTransform: "uppercase" },
  hero: { borderRadius: 14, overflow: "hidden", height: 132, marginBottom: 20 },
  heroBody: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, paddingHorizontal: 26, paddingVertical: 22, flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" },
  eyebrow: { fontSize: 7.5, letterSpacing: 1.8, fontFamily: "Helvetica-Bold", textTransform: "uppercase" },
  h1: { fontSize: 25, fontFamily: "Helvetica-Bold", color: "#ffffff", lineHeight: 1.12, marginTop: 8, marginBottom: 6, letterSpacing: -0.4 },
  heroSub: { fontSize: 9, color: "#c9d6e0" },
  periodSmall: { fontSize: 7.5, color: "#c9d6e0", textAlign: "right" },
  periodBig: { fontSize: 13, fontFamily: "Helvetica-Bold", color: "#ffffff", textAlign: "right", marginVertical: 2 },
  section: { marginBottom: 18 },
  head: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 9 },
  h2: { fontSize: 13.5, fontFamily: "Helvetica-Bold", letterSpacing: -0.2 },
  h3: { fontSize: 10.5, fontFamily: "Helvetica-Bold" },
  sub: { fontSize: 7.5, color: MUTED },
  tiles: { flexDirection: "row", gap: 9 },
  tile: { flex: 1, backgroundColor: "#ffffff", borderWidth: 1, borderColor: LINE, borderRadius: 11, paddingVertical: 13, paddingHorizontal: 13 },
  tileLabel: { fontSize: 7.5, color: MUTED, fontFamily: "Helvetica-Bold", textTransform: "uppercase", letterSpacing: 0.8 },
  tileValue: { fontSize: 21, fontFamily: "Helvetica-Bold", letterSpacing: -0.6, marginTop: 6, marginBottom: 9 },
  chip: { flexDirection: "row", alignItems: "center", gap: 3, borderRadius: 5, paddingVertical: 3, paddingHorizontal: 5 },
  chipText: { fontSize: 7.5, fontFamily: "Helvetica-Bold" },
  baseline: { fontSize: 7, color: MUTED, marginTop: 5 },
  support: { flexDirection: "row", gap: 18, marginTop: 10, flexWrap: "wrap" },
  supportText: { fontSize: 8, color: "#5d7184" },
  panel: { backgroundColor: "#ffffff", borderWidth: 1, borderColor: LINE, borderRadius: 11, padding: 14 },
  legend: { flexDirection: "row", gap: 14, alignItems: "center" },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  dot: { width: 7, height: 7, borderRadius: 2 },
  note: { fontSize: 7.5, color: "#728393", marginTop: 6 },
  th: { flexDirection: "row", backgroundColor: "#f5f8fa", borderRadius: 6, paddingVertical: 6, paddingHorizontal: 6, marginBottom: 2 },
  thText: { fontSize: 6.5, color: "#718194", fontFamily: "Helvetica-Bold", textTransform: "uppercase", letterSpacing: 0.5 },
  tr: { flexDirection: "row", alignItems: "center", paddingVertical: 6, paddingHorizontal: 6, borderBottomWidth: 1, borderBottomColor: "#edf1f4" },
  td: { fontSize: 8.5, textAlign: "right" },
  thumb: { width: 30, height: 30, borderRadius: 5, objectFit: "cover" },
  thumbBlank: { width: 30, height: 30, borderRadius: 5, backgroundColor: "#eef2f5" },
  adName: { fontSize: 8.5, fontFamily: "Helvetica-Bold" },
  adMeta: { fontSize: 6.8, color: MUTED, marginTop: 2 },
  barRow: { flexDirection: "row", alignItems: "center", gap: 10, marginVertical: 5 },
  barLabel: { width: 150, fontSize: 8, fontFamily: "Helvetica-Bold" },
  barTrack: { flex: 1, height: 9, borderRadius: 5, overflow: "hidden" },
  barValue: { width: 46, fontSize: 8.5, fontFamily: "Helvetica-Bold", textAlign: "right" },
  insights: { flexDirection: "row", gap: 9 },
  insight: { flex: 1, backgroundColor: "#ffffff", borderWidth: 1, borderColor: LINE, borderRadius: 11, paddingVertical: 12, paddingHorizontal: 13 },
  insightTitle: { fontSize: 9.5, fontFamily: "Helvetica-Bold", marginBottom: 5, lineHeight: 1.25 },
  insightText: { fontSize: 8, color: "#5d7184", lineHeight: 1.45 },
  platformBar: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 14, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: LINE },
  footer: { position: "absolute", bottom: 20, left: PAD, right: PAD, borderTopWidth: 1, borderTopColor: "#d9e2ea", paddingTop: 7, flexDirection: "row", justifyContent: "space-between", gap: 12 },
  footText: { fontSize: 6.8, color: "#82909e", lineHeight: 1.35 },
  pageNumber: { position: "absolute", bottom: 9, left: PAD, width: INNER, textAlign: "right", fontSize: 6.5, color: FAINT },
  notesHead: { fontSize: 9, fontFamily: "Helvetica-Bold", marginBottom: 4, marginTop: 6 },
  bullet: { flexDirection: "row", marginBottom: 3 },
  bulletText: { flex: 1, fontSize: 8.5, lineHeight: 1.45, color: "#33475b" },
  para: { fontSize: 8.5, lineHeight: 1.45, color: "#33475b" },
});

const hotStyle = { position: "absolute" as const, top: 0, left: 0, right: 0, bottom: 0, textDecoration: "none" as const };
function Hot({ href }: { href: string | null | undefined }) {
  return href ? <Link src={`${EDIT_HOST}/${href}`} style={hotStyle} /> : null;
}

/** Text inside an Svg (react-pdf's own svg text: x, y, fill and a font) */
const SvgText = Text as unknown as React.FC<{ x: number; y: number; fill?: string; textAnchor?: "start" | "middle" | "end"; style?: Record<string, unknown>; children: React.ReactNode }>;

/** "Nov 2 – Nov 8, 2026" */
const fullRange = (start: string, end: string) => {
  const f = (d: string, o: Intl.DateTimeFormatOptions) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { ...o, timeZone: "UTC" });
  return `${f(start, { month: "short", day: "numeric" })} – ${f(end, { month: "short", day: "numeric", year: "numeric" })}`;
};
/** "Nov 2–8" */
const shortRange = (start: string, end: string) => {
  const f = (d: string, o: Intl.DateTimeFormatOptions) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { ...o, timeZone: "UTC" });
  return start.slice(0, 7) === end.slice(0, 7) ? `${f(start, { month: "short", day: "numeric" })}–${f(end, { day: "numeric" })}` : `${f(start, { month: "short", day: "numeric" })}–${f(end, { month: "short", day: "numeric" })}`;
};

const toneOf = (m: Move) => (!m || m.tone === "flat" ? FLAT : m.tone === "good" ? GOOD : BAD);

/** The arrow on a change: up or down, drawn (Helvetica has no arrow glyphs) */
function Arrow({ up, color }: { up: boolean; color: string }) {
  return (
    <Svg width={6} height={5} viewBox="0 0 6 5">
      <Polygon points={up ? "3,0 6,5 0,5" : "0,0 6,0 3,5"} fill={color} />
    </Svg>
  );
}

/** A logo on the masthead: as it is, or on a dark chip when it's a white logo */
function Logo({ src, light, chip, height }: { src: string; light?: boolean; chip: string; height: number }) {
  /* eslint-disable jsx-a11y/alt-text -- a PDF image, no alt prop */
  const img = <Image src={src} style={{ height, maxWidth: 150, objectFit: "contain" }} />;
  return light ? <View style={{ backgroundColor: chip, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 5 }}>{img}</View> : img;
  /* eslint-enable jsx-a11y/alt-text */
}

/** The services in this report, for the masthead ("Meta Ads", "Meta + TikTok Ads") */
const servicesLabel = (parts: WeeklyPart[]) => {
  const names = [...new Set(parts.map((p) => platformName(p.platform).replace(/ Ads$/, "")))];
  return `${names.join(" + ")} Ads`;
};

function Masthead({ input, pal }: { input: WeeklyInput; pal: Palette }) {
  const agency = !input.whiteLabel;
  const logo = input.brand?.logo;
  return (
    <View style={s.mast}>
      <View style={s.brandRow}>
        {logo ? <Logo src={logo} light={input.brand?.light} chip={pal.hero} height={30} /> : <Text style={{ fontSize: 15, fontFamily: "Helvetica-Bold", color: pal.accentText, letterSpacing: -0.3 }}>{input.client}</Text>}
        {agency ? (
          <>
            <View style={s.divider} />
            {input.brand?.agencyLogo ? <Logo src={input.brand.agencyLogo} chip={pal.hero} height={19} /> : <Text style={{ fontSize: 12, fontFamily: "Helvetica-Bold", color: "#c8102e" }}>kaizen</Text>}
          </>
        ) : null}
      </View>
      <View style={s.topRight}>
        <Text style={[s.topKicker, { color: INK }]}>{agency ? `${input.client} × Kaizen` : input.client}</Text>
        <Text style={[s.topKicker, { marginTop: 3 }]}>Performance Intelligence / {servicesLabel(input.parts)}</Text>
      </View>
    </View>
  );
}

function Hero({ input, pal }: { input: WeeklyInput; pal: Palette }) {
  const m = input.parts[0].metrics;
  const search = input.parts.every((p) => p.platform === "google");
  const h = 132;
  return (
    <View style={s.hero}>
      <Svg width={INNER} height={h} viewBox={`0 0 ${INNER} ${h}`} style={{ position: "absolute", top: 0, left: 0 }}>
        <Defs>
          <LinearGradient id="band" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={pal.hero} />
            <Stop offset="1" stopColor={pal.heroEdge} />
          </LinearGradient>
        </Defs>
        <Rect x={0} y={0} width={INNER} height={h} fill="url(#band)" />
        <Circle cx={INNER - 40} cy={-30} r={120} fill="none" stroke="#ffffff" strokeOpacity={0.12} strokeWidth={1} />
        <Circle cx={INNER - 40} cy={-30} r={150} fill="none" stroke="#ffffff" strokeOpacity={0.07} strokeWidth={26} />
        <Circle cx={INNER - 40} cy={-30} r={196} fill="none" stroke="#ffffff" strokeOpacity={0.05} strokeWidth={26} />
      </Svg>
      <View style={s.heroBody}>
        <View style={{ maxWidth: 320 }}>
          <Text style={[s.eyebrow, { color: pal.heroSoft }]}>{search ? "Weekly Paid Search Report" : input.parts.length > 1 ? "Weekly Paid Social Report" : `Weekly ${input.parts[0].platform === "tiktok" ? "TikTok" : "Paid Social"} Report`}</Text>
          <Text style={[s.h1, input.client.length > 16 ? { fontSize: 21 } : {}]}>{input.client.length <= 11 ? `${input.client} Performance\nOverview` : `${input.client}\nPerformance Overview`}</Text>
          <Text style={s.heroSub}>{search ? "Key results, efficiency trends & campaign performance" : "Key results, efficiency trends & creative performance"}</Text>
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

function Glance({ input, part, pal }: { input: WeeklyInput; part: WeeklyPart; pal: Palette }) {
  const m = part.metrics;
  const keys = weeklyTileKeys(m, part.layout);
  const tiles = keys.map((k) => weeklyTile(m, k, m.main, m.compare));
  const support = supportKeys(m, keys);
  // More tiles than four (the buyer added some): smaller numbers so each still fits its tile
  const size = tiles.length <= 4 ? 21 : tiles.length === 5 ? 17 : 14;
  return (
    <View style={s.section} wrap={false}>
      <View style={s.head}>
        <Text style={s.h2}>Performance at a glance</Text>
        <Text style={s.sub}>Week-over-week movement · Green = favorable, red = unfavorable</Text>
      </View>
      <View style={s.tiles}>
        {tiles.map((t, i) => {
          const c = toneOf(t.move);
          return (
            <View key={`${t.key}-${i}`} style={s.tile}>
              <View style={{ width: 16, height: 2.5, borderRadius: 2, backgroundColor: pal.accent, marginBottom: 7 }} />
              <Text style={s.tileLabel}>{t.label}</Text>
              <Text style={[s.tileValue, { fontSize: size }]}>{t.value}</Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                {t.move ? (
                  <View style={[s.chip, { backgroundColor: c.bg }]}>
                    {t.move.tone !== "flat" || t.move.pct !== "0.0%" ? <Arrow up={t.move.up} color={c.fg} /> : null}
                    <Text style={[s.chipText, { color: c.fg }]}>{t.move.pct}</Text>
                  </View>
                ) : (
                  <View style={[s.chip, { backgroundColor: FLAT.bg }]}>
                    <Text style={[s.chipText, { color: FLAT.fg }]}>New</Text>
                  </View>
                )}
              </View>
              <Text style={s.baseline}>vs {t.before} prior week</Text>
              <Hot href={input.edit ? `${part.platform}/tile/${i}` : null} />
            </View>
          );
        })}
      </View>
      <View style={s.support}>
        {support.map((k) => {
          const now = metricNumber(m.main, k);
          const mv = k === "spend" && now != null ? weeklyTile(m, k, m.main, m.compare).move : null;
          return (
            <Text key={k} style={s.supportText}>
              {k === "spend" ? "Ad spend" : shortLabel(m, k)} <Text style={{ fontFamily: "Helvetica-Bold", color: INK }}>{weeklyValue(k, now)}</Text>
              {mv ? ` (${mv.up ? "+" : "-"}${mv.pct} WoW)` : ""}
            </Text>
          );
        })}
      </View>
    </View>
  );
}

/** Five weeks: results as bars on the left axis, their cost (or ROAS) as a line on the right, every value labelled */
function Trend({ part, pal }: { part: WeeklyPart; pal: Palette }) {
  const m = part.metrics;
  const weeks = chartWeeks(m);
  if (weeks.length < 2) return null;
  const roas = m.roasKpi;
  const line = (w: (typeof weeks)[number]) => (roas ? w.roas : w.costPerResult);
  const lineName = roas ? "ROAS" : costLabel(m);
  const fmtLine = (v: number | null) => (v == null ? "" : roas ? `${v.toFixed(2)}x` : `$${v >= 1000 ? Math.round(v).toLocaleString("en-US") : v.toFixed(2)}`);
  const width = INNER - 28;
  const height = 196;
  const L = 34;
  const R = width - 40;
  const T = 18;
  const B = height - 26;
  const H = B - T;
  const barMax = niceMax(Math.max(...weeks.map((w) => w.results)), true);
  const lineMax = niceMax(Math.max(...weeks.map((w) => line(w) ?? 0)));
  const xs = weeks.map((_, i) => L + ((R - L) * (i + 0.5)) / weeks.length);
  const bw = Math.min(54, ((R - L) / weeks.length) * 0.52);
  const yBar = (v: number) => B - (H * v) / barMax;
  const yLine = (v: number) => B - (H * v) / lineMax;
  const pts = weeks.map((w, i) => ({ x: xs[i], v: line(w) })).filter((p): p is { x: number; v: number } => p.v != null);
  const d = pts.map((p, i) => `${i ? "L" : "M"} ${p.x.toFixed(1)} ${yLine(p.v).toFixed(1)}`).join(" ");
  const axis = { fontSize: 6.5, fontFamily: "Helvetica" };
  const tick = (v: number, money: boolean) => (money ? (roas ? `${v % 1 ? v.toFixed(1) : v}x` : `$${Math.round(v).toLocaleString("en-US")}`) : `${v % 1 ? v.toFixed(1) : v}`);
  return (
    <View style={s.section} wrap={false}>
      <View style={s.head}>
        <Text style={s.h2}>
          {m.conversion} &amp; {roas ? "return on ad spend" : "acquisition cost"}
        </Text>
        <Text style={s.sub}>5-week historical view</Text>
      </View>
      <View style={s.panel}>
        <View style={s.legend}>
          <View style={s.legendItem}>
            <View style={[s.dot, { backgroundColor: pal.accent }]} />
            <Text style={{ fontSize: 7.5, color: MUTED }}>{m.conversion} · left axis</Text>
          </View>
          <View style={s.legendItem}>
            <View style={[s.dot, { backgroundColor: pal.line }]} />
            <Text style={{ fontSize: 7.5, color: MUTED }}>
              {lineName}
              {roas ? "" : " (USD)"} · right axis
            </Text>
          </View>
        </View>
        <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ marginTop: 8 }}>
          {[0, 1, 2, 3, 4].map((j) => {
            const y = B - (H * j) / 4;
            return (
              <Fragment key={j}>
                <Line x1={L} y1={y} x2={R} y2={y} stroke="#e9eff3" strokeWidth={0.8} />
                <SvgText x={L - 6} y={y + 2.2} textAnchor="end" fill="#7a8b99" style={axis}>
                  {tick((barMax * j) / 4, false)}
                </SvgText>
                <SvgText x={R + 6} y={y + 2.2} fill="#7a8b99" style={axis}>
                  {tick((lineMax * j) / 4, true)}
                </SvgText>
              </Fragment>
            );
          })}
          {weeks.map((w, i) => {
            const y = yBar(w.results);
            const last = i === weeks.length - 1;
            const lv = line(w);
            const ly = lv == null ? -100 : yLine(lv);
            const tall = B - y >= 20;
            // Inside the bar's top unless the line's point is there; then its foot; a short bar keeps it above
            const at = !tall ? y - 4 : Math.abs(ly - (y + 11)) < 15 ? (B - y >= 36 ? B - 6 : y - 4) : y + 11;
            const inside = tall && at > y;
            return (
              <Fragment key={w.start}>
                <Rect x={xs[i] - bw / 2} y={y} width={bw} height={Math.max(0.5, B - y)} rx={3} fill={pal.accent} fillOpacity={last ? 1 : 0.62} />
                <SvgText x={xs[i]} y={at} textAnchor="middle" fill={inside ? "#ffffff" : pal.accentText} style={{ fontSize: 8, fontFamily: "Helvetica-Bold" }}>
                  {weeklyValue("results", w.results)}
                </SvgText>
                <SvgText x={xs[i]} y={B + 13} textAnchor="middle" fill={last ? INK : "#7a8b99"} style={{ fontSize: 7, fontFamily: last ? "Helvetica-Bold" : "Helvetica" }}>
                  {w.label}
                </SvgText>
              </Fragment>
            );
          })}
          {d ? <Path d={d} stroke={pal.line} strokeWidth={2.2} fill="none" strokeLinecap="round" strokeLinejoin="round" /> : null}
          {pts.map((p, i) => {
            const y = yLine(p.v);
            // The cost label sits above its point, or below when the bar's own label is in the way
            const above = y - 8 > T;
            return (
              <Fragment key={i}>
                <Circle cx={p.x} cy={y} r={3.6} fill="#ffffff" stroke={pal.line} strokeWidth={2} />
                <Rect x={p.x + 5} y={(above ? y - 15 : y + 4) - 0.5} width={fmtLine(p.v).length * 3.7 + 5} height={10} rx={2} fill="#ffffff" fillOpacity={0.85} />
                <SvgText x={p.x + 7.5} y={above ? y - 7.5 : y + 11.5} fill={pal.line} style={{ fontSize: 7, fontFamily: "Helvetica-Bold" }}>
                  {fmtLine(p.v)}
                </SvgText>
              </Fragment>
            );
          })}
        </Svg>
        <Text style={s.note}>{roas ? "ROAS = attributed revenue ÷ spend." : `${costLabel(m)} = spend ÷ attributed ${m.conversion.toLowerCase()}.`} Spend by week: {chartWeeks(m).map((w) => `${w.label} $${Math.round(w.spend).toLocaleString("en-US")}`).join(" · ")}.</Text>
      </View>
    </View>
  );
}

function Thumb({ src }: { src: string | null | undefined }) {
  // eslint-disable-next-line jsx-a11y/alt-text -- a PDF image, no alt prop
  return src ? <Image src={src} style={s.thumb} /> : <View style={s.thumbBlank} />;
}

function Scorecard({ input, part, rows, images }: { input: WeeklyInput; part: WeeklyPart; rows: ScoreRow[]; images: (string | null)[] }) {
  const m = part.metrics;
  const cols = scoreColumns(m);
  const google = part.platform === "google";
  const pictures = !google || rows.some((r) => r.img != null);
  const colW = 50;
  const head = (k: (typeof cols)[number]) => scoreHead(m, k);
  const unit = google ? (rows[0]?.kind === "campaign" ? "Campaign" : "Campaign / ad group") : "Ad / creative";
  return (
    <View style={s.panel}>
      <View style={s.head}>
        <Text style={s.h3}>{google ? "Campaign scorecard" : "Creative scorecard"}</Text>
        <Text style={s.sub}>Sorted by {m.roasKpi ? "ROAS" : m.conversion.toLowerCase()}, best first</Text>
      </View>
      <View style={s.th}>
        <Text style={[s.thText, { flex: 1 }]}>{unit}</Text>
        {cols.map((k) => (
          <Text key={k} style={[s.thText, { width: colW, textAlign: "right" }]}>
            {head(k)}
          </Text>
        ))}
      </View>
      {rows.map((r, i) => (
        <View key={r.id} style={[s.tr, i === rows.length - 1 ? { borderBottomWidth: 0 } : {}]} wrap={false}>
          <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8, paddingRight: 6 }}>
            {pictures ? <Thumb src={r.img != null ? images[r.img] : null} /> : null}
            <View style={{ flex: 1 }}>
              {r.link && (!input.whiteLabel || !/kaizen/i.test(r.link)) ? (
                <Link src={r.link} style={[s.adName, { color: INK, textDecoration: "none" }]}>
                  {r.name}
                </Link>
              ) : (
                <Text style={s.adName}>{r.name}</Text>
              )}
              {r.detail ? <Text style={s.adMeta}>{r.detail}</Text> : null}
            </View>
          </View>
          {cols.map((k) => (
            <Text key={k} style={[s.td, { width: colW }, k === (m.roasKpi ? "roas" : "results") ? { fontFamily: "Helvetica-Bold" } : {}]}>
              {scoreValue(r, k)}
            </Text>
          ))}
          <Hot href={input.edit && r.kind === "campaign" ? `${part.platform}/camp/${encodeURIComponent(r.name)}` : null} />
        </View>
      ))}
    </View>
  );
}

function Bars({ part, rows, pal }: { part: WeeklyPart; rows: ScoreRow[]; pal: Palette }) {
  const m = part.metrics;
  const k = barMetric(m);
  const vals = rows.map((r) => metricNumber(r, k) ?? 0);
  const max = Math.max(...vals, 0);
  if (!max) return null;
  const read = barsRead(m, rows);
  const say = sayable(rows);
  const google = part.platform === "google";
  return (
    <View style={[s.panel, { marginTop: 9 }]} wrap={false}>
      <Text style={s.h3}>
        {k === "revenue" ? "Revenue" : m.conversion} by {google ? (rows[0]?.kind === "campaign" ? "campaign" : "campaign and ad group") : "creative"}
      </Text>
      <View style={{ marginTop: 8 }}>
        {rows
          .map((r, i) => ({ r, v: vals[i] }))
          .filter((x) => x.v > 0)
          .sort((a, b) => b.v - a.v)
          .map(({ r, v }) => (
            <View key={r.id} style={s.barRow}>
              <Text style={s.barLabel}>{say(r)}</Text>
              <View style={[s.barTrack, { backgroundColor: pal.soft }]}>
                <View style={{ width: `${Math.max(2, (v / max) * 100)}%`, height: "100%", borderRadius: 5, backgroundColor: pal.accent }} />
              </View>
              <Text style={s.barValue}>{weeklyValue(k, v)}</Text>
            </View>
          ))}
      </View>
      {read ? <Text style={s.note}>{read}</Text> : null}
    </View>
  );
}

function Creative({ input, part, images, pal }: { input: WeeklyInput; part: WeeklyPart; images: (string | null)[]; pal: Palette }) {
  const m = part.metrics;
  const hide = new Set(part.layout?.campaigns?.hide ?? []);
  const rows = scorecardRows(m).filter((r) => r.kind !== "campaign" || !hide.has(r.name));
  if (!rows.length) return null;
  const google = part.platform === "google";
  return (
    <View style={s.section}>
      <View wrap={false}>
        <View style={s.head}>
          <Text style={s.h2}>{google ? "Campaign performance" : "Creative performance"}</Text>
          <Text style={s.sub}>
            {shortRange(m.main.start, m.main.end)} · {google ? (rows[0].kind === "campaign" ? "campaign level" : "campaign and ad group level") : "ad level"}
          </Text>
        </View>
        <Scorecard input={input} part={part} rows={rows} images={images} />
      </View>
      <Bars part={part} rows={rows} pal={pal} />
    </View>
  );
}

function Takeaways({ input, part, items, pal }: { input: WeeklyInput; part: WeeklyPart; items: Takeaway[]; pal: Palette }) {
  if (!items.length) return null;
  return (
    <View style={s.section} wrap={false}>
      <View style={s.head}>
        <Text style={s.h2}>Key takeaways</Text>
        <Text style={s.sub}>From this week&apos;s {platformName(part.platform)} numbers</Text>
      </View>
      <View style={s.insights}>
        {items.map((t, i) => (
          <View key={i} style={s.insight}>
            <View style={{ width: 16, height: 2.5, borderRadius: 2, backgroundColor: pal.accent, marginBottom: 8 }} />
            <View>
              <Text style={s.insightTitle}>{t.title}</Text>
              <Hot href={input.edit ? `${part.platform}/text/takeaway-${i}-title` : null} />
            </View>
            <View>
              <Text style={s.insightText}>{t.text}</Text>
              <Hot href={input.edit ? `${part.platform}/text/takeaway-${i}-text` : null} />
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

/** The buyer's notes, printed only when they switch it on for this report (normally they travel in the message) */
function Notes({ input, part, pal }: { input: WeeklyInput; part: WeeklyPart; pal: Palette }) {
  const sec = part.sections;
  const hot = (x: string) => (input.edit ? `${part.platform}/text/${x}` : null);
  const groups = [
    { key: "did", title: "What we did", items: sec.did ?? [] },
    { key: "doing", title: "What we're doing", items: sec.doing ?? [] },
    { key: "next", title: "What's next", items: sec.next ?? [] },
  ].filter((g) => g.items.length);
  return (
    <View style={s.section}>
      <View style={s.head} minPresenceAhead={80}>
        <Text style={s.h2}>Our notes</Text>
        <Text style={s.sub}>{part.buyer && !input.whiteLabel ? `From ${part.buyer}` : "From your account team"}</Text>
      </View>
      <View style={s.panel}>
        {sec.headline ? (
          <View style={{ marginBottom: 4 }}>
            <Text style={{ fontSize: 10.5, fontFamily: "Helvetica-Bold", lineHeight: 1.3 }}>{sec.headline}</Text>
            <Hot href={hot("headline")} />
          </View>
        ) : null}
        {sec.summary ? (
          <View style={{ marginBottom: 4 }}>
            <Text style={s.para}>{sec.summary}</Text>
            <Hot href={hot("summary")} />
          </View>
        ) : null}
        {groups.map((g) => (
          <View key={g.key}>
            <Text minPresenceAhead={24} style={[s.notesHead, { color: g.key === "next" ? pal.accentText : INK }]}>
              {g.title}
            </Text>
            {g.items.map((x, i) => (
              <View key={i} style={s.bullet} wrap={false}>
                <Text style={{ width: 10, color: pal.accent, fontFamily: "Helvetica-Bold", fontSize: 8.5 }}>•</Text>
                <Text style={s.bulletText}>{x}</Text>
                <Hot href={hot(`${g.key}/${i}`)} />
              </View>
            ))}
          </View>
        ))}
        {part.extras?.trim() ? (
          <View>
            <Text style={s.notesHead}>Also</Text>
            <Text style={s.para}>{part.extras.trim()}</Text>
            <Hot href={hot("extras")} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** A trend the buyer asked for (a chart with what we see, why and what's next) */
function Stories({ input, part, pal }: { input: WeeklyInput; part: WeeklyPart; pal: Palette }) {
  const list = (part.sections.stories ?? []).filter((st) => st.points?.length);
  if (!list.length) return null;
  const hot = (x: string) => (input.edit ? `${part.platform}/${x}` : null);
  return (
    <>
      {list.map((st, i) => {
        const pts = st.points!;
        const max = Math.max(...pts.map((p) => p.value ?? 0), 0) || 1;
        return (
          <View key={i} style={s.section} wrap={false}>
            <View style={s.head}>
              <View>
                <Text style={s.h2}>{st.title}</Text>
                <Hot href={hot(`text/story-${i}-title`)} />
              </View>
            </View>
            <View style={s.panel}>
              <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, height: 100 }}>
                {pts.map((p, k) => (
                  <View key={k} style={{ flex: 1, alignItems: "center", justifyContent: "flex-end", height: "100%" }}>
                    <Text style={{ fontSize: 7, color: MUTED, marginBottom: 2 }}>{weeklyValue(st.metric, p.value)}</Text>
                    <View style={{ width: "60%", height: `${Math.max(2, ((p.value ?? 0) / max) * 80)}%`, borderTopLeftRadius: 3, borderTopRightRadius: 3, backgroundColor: k === pts.length - 1 ? pal.accent : pal.soft }} />
                    <Text style={{ fontSize: 6.5, color: MUTED, marginTop: 3 }}>{p.label}</Text>
                  </View>
                ))}
                <Hot href={hot(`story/${i}`)} />
              </View>
              {(
                [
                  ["What we see", st.see, "see"],
                  ["Why", st.why, "why"],
                  ["What's next", st.next, "next"],
                ] as const
              )
                .filter(([, t]) => t?.trim())
                .map(([label, text, key]) => (
                  <View key={key} style={{ flexDirection: "row", gap: 8, marginTop: 5 }}>
                    <Text style={{ width: 62, fontSize: 7, fontFamily: "Helvetica-Bold", textTransform: "uppercase", color: key === "next" ? pal.accentText : INK }}>{label}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={s.bulletText}>{text}</Text>
                      <Hot href={hot(`text/story-${i}-${key}`)} />
                    </View>
                  </View>
                ))}
            </View>
          </View>
        );
      })}
    </>
  );
}

/** The data note in the footer: where the numbers come from and how they're counted */
function dataNote(parts: WeeklyPart[]) {
  const src = [...new Set(parts.map((p) => platformName(p.platform)))].join(" and ");
  const conv = parts[0].metrics.conversion.toLowerCase();
  const how = parts.map((p) => (p.platform === "meta" ? "Meta attribution: 7-day click, 1-day view" : p.platform === "google" ? "Conversions as Google Ads counts them" : "TikTok attribution as reported"));
  return { left: `Data: ${src}, synced daily`, right: `Currency USD · CTR uses link clicks · ${[...new Set(how)].join(" · ") || conv}` };
}

function Footer({ input }: { input: WeeklyInput }) {
  const note = dataNote(input.parts);
  return (
    <>
      <View style={s.footer} fixed>
        <Text style={[s.footText, { maxWidth: 230 }]}>
          {input.whiteLabel ? `Prepared for ${input.client}` : `Prepared for ${input.client} · Kaizen`} | {note.left}
        </Text>
        <Text style={[s.footText, { textAlign: "right", flex: 1 }]}>{note.right}</Text>
      </View>
      <Text style={s.pageNumber} fixed render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
    </>
  );
}

/** The whole weekly: one document, a section per platform. images: each part's pictures (the scorecard's img indexes) */
export function WeeklyReport({ input, images }: { input: WeeklyInput; images: (string | null)[][] }) {
  const pal = paletteFor(input.brand?.color, { whiteLabel: input.whiteLabel });
  const joint = input.parts.length > 1;
  return (
    <Page size="A4" style={s.page}>
      <Footer input={input} />
      <Masthead input={input} pal={pal} />
      <Hero input={input} pal={pal} />
      {input.parts.map((part, i) => {
        const items = takeawaysFor(part.metrics, part.sections.takeaways);
        return (
          <View key={`${part.platform}-${i}`} break={i > 0}>
            {joint ? (
              <View style={s.platformBar}>
                <View style={{ width: 4, height: 16, borderRadius: 2, backgroundColor: pal.accent }} />
                <Text style={{ fontSize: 15, fontFamily: "Helvetica-Bold", letterSpacing: -0.3 }}>{platformName(part.platform)}</Text>
                <Text style={[s.sub, { marginLeft: "auto" }]}>
                  {shortRange(part.metrics.main.start, part.metrics.main.end)} vs {shortRange(part.metrics.compare.start, part.metrics.compare.end)}
                </Text>
              </View>
            ) : null}
            <Glance input={input} part={part} pal={pal} />
            <Trend part={part} pal={pal} />
            <Creative input={input} part={part} images={images[i] ?? []} pal={pal} />
            <Takeaways input={input} part={part} items={items} pal={pal} />
            <Stories input={input} part={part} pal={pal} />
            {part.layout?.notes ? <Notes input={input} part={part} pal={pal} /> : null}
          </View>
        );
      })}
      {input.dashboard && !input.whiteLabel ? (
        <Link src={input.dashboard} style={{ fontSize: 8.5, color: pal.accentText, fontFamily: "Helvetica-Bold", textDecoration: "none", marginTop: 2 }}>
          See every number, any dates, on your live dashboard
        </Link>
      ) : null}
    </Page>
  );
}
