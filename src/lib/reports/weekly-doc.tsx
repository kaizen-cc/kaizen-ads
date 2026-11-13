import { Fragment } from "react";
import { Circle, Defs, Image, Line, LinearGradient, Link, Page, Path, Polygon, Rect, Stop, StyleSheet, Svg, Text, View } from "@react-pdf/renderer";
import type { ReportMetrics } from "./metrics";
import type { Sections } from "./write";
import type { ReportLayout } from "./format";
import { count, manualTiles, metricNumber, money, multiple, platformName } from "./format";
import { manualCaption, platformConversion } from "./manual";
import { hue, paletteFor, parseHex, saturation } from "./brand";
import { barMetric, barsRead, sayable, scoreHead, chartWeeks, costLabel, niceMax, scoreColumns, scoreValue, scorecardRows, shortLabel, supportKeys, takeawaysFor, weeklyTile, weeklyTileKeys, weeklyValue, type Move, type ScoreRow, type Takeaway } from "./weekly-core";

// Every client report (weekly, monthly, built), after the hand-made report the team loved: a co-branded header (the
// client's logo beside Kaizen's, Kaizen leading; a white label client's logo and colours alone), a hero band with the
// period and what it's compared with, the period at a glance (four tiles, green when the move is good for the client, red
// when it isn't), five weeks of results and their cost, the creative scorecard (each ad's picture beside its numbers, best
// first by the client's KPI, or on Google each campaign and ad group) beside what each brought, the top ads as pictures,
// and three takeaways. Kaizen's red leads (the band, the accents); the client's colour is the second voice (the results
// bars). The narrative (what we did, what we're doing, what's next) travels only in the message that carries the report,
// never in the document. Several platforms: a section each, in the same design. A PDF can't sort or hover, so it's
// sorted by the KPI with every value labelled; the studio's preview is this same document.

/** Where the studio's preview can click: an invisible link over the element (its address says what it is) */
export const EDIT_HOST = "https://edit.kaizen.invalid";

/** The parts of the report input the document reads (the full type lives in report-doc.tsx). extra: a built report's other ranges */
export type WeeklyPart = { platform: "meta" | "google" | "tiktok"; buyer: string | null; metrics: ReportMetrics; sections: Sections; extras: string | null; extra?: ReportMetrics[] | null; layout?: ReportLayout | null };
export type WeeklyBrand = { logo: string | null; light?: boolean; color: string | null; agencyLogo?: string | null };
export type WeeklyInput = {
  client: string;
  kind?: "weekly" | "monthly" | "built";
  periodLabel: string;
  parts: WeeklyPart[];
  /** The buyer's write-up as a last section ("Our notes"): only the copy saved to Drive carries it, never the client's PDF */
  withNotes?: boolean;
  edit?: boolean;
  dashboard?: string | null;
  whiteLabel?: boolean;
  brand?: WeeklyBrand | null;
  /** The monthly's ask: next cycle's shot list */
  shots?: { month: string; items: string[]; url: string | null } | null;
};

/** Kaizen's own brand: the red of the app and the logo, and the near-black it sits on */
export const KAIZEN_RED = "#b21e2c";
const KAIZEN_DEEP = "#150a0d";
const KAIZEN_EDGE = "#5a111a";
const KAIZEN_SOFT = "#ff9ea7";

const INK = "#14202e";
const MUTED = "#66768a";
const FAINT = "#94a2b0";
const LINE = "#e3e8ee";
const BG = "#f4f6f9";
const GOOD = { fg: "#087a5e", bg: "#e1f5ec" };
const BAD = { fg: "#c23e4c", bg: "#ffeaec" };
const FLAT = { fg: "#5f6f80", bg: "#eef2f5" };
const W = 595.28;
const PAD = 32;
const INNER = W - PAD * 2;
const HERO_H = 128;

const s = StyleSheet.create({
  page: { fontFamily: "Helvetica", fontSize: 9, color: INK, backgroundColor: BG, paddingTop: 24, paddingBottom: 56, paddingHorizontal: PAD },
  mast: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 14, minHeight: 30 },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  divider: { width: 1, height: 22, backgroundColor: "#cdd6df" },
  topKicker: { fontSize: 6.8, letterSpacing: 1.6, fontFamily: "Helvetica-Bold", color: "#5f6f82", textTransform: "uppercase" },
  hero: { borderRadius: 13, overflow: "hidden", height: HERO_H, marginBottom: 20 },
  heroBody: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, paddingHorizontal: 24, paddingVertical: 21, flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" },
  eyebrow: { fontSize: 6.8, letterSpacing: 1.8, fontFamily: "Helvetica-Bold", textTransform: "uppercase" },
  h1: { fontSize: 24, fontFamily: "Helvetica-Bold", color: "#ffffff", lineHeight: 1.12, marginTop: 9, marginBottom: 7, letterSpacing: -0.4 },
  heroSub: { fontSize: 8.5, color: "#d8dde3" },
  periodSmall: { fontSize: 7.2, color: "#d2d8de", textAlign: "right" },
  periodBig: { fontSize: 12.5, fontFamily: "Helvetica-Bold", color: "#ffffff", textAlign: "right", marginVertical: 3 },
  section: { marginBottom: 18 },
  head: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 9, gap: 10 },
  h2: { fontSize: 13, fontFamily: "Helvetica-Bold", letterSpacing: -0.2 },
  h3: { fontSize: 9.5, fontFamily: "Helvetica-Bold" },
  sub: { fontSize: 7, color: MUTED },
  tiles: { flexDirection: "row", gap: 8 },
  tile: { flex: 1, backgroundColor: "#ffffff", borderWidth: 1, borderColor: LINE, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 10 },
  tileLabel: { fontSize: 6.8, color: "#5f6f82", fontFamily: "Helvetica-Bold", textTransform: "uppercase", letterSpacing: 0.8 },
  tileValue: { fontSize: 21, fontFamily: "Helvetica-Bold", letterSpacing: -0.6, marginTop: 7, marginBottom: 9 },
  moveRow: { flexDirection: "row", alignItems: "center", gap: 4, flexWrap: "wrap" },
  chip: { flexDirection: "row", alignItems: "center", gap: 3, borderRadius: 4, paddingVertical: 2.5, paddingHorizontal: 4.5 },
  chipText: { fontSize: 7, fontFamily: "Helvetica-Bold" },
  baseline: { fontSize: 6, color: MUTED },
  support: { flexDirection: "row", gap: 16, marginTop: 9, flexWrap: "wrap" },
  supportText: { fontSize: 7.5, color: "#5d7184" },
  panel: { backgroundColor: "#ffffff", borderWidth: 1, borderColor: LINE, borderRadius: 10, padding: 13 },
  legend: { flexDirection: "row", gap: 14, alignItems: "center" },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  note: { fontSize: 6.8, color: "#728393", marginTop: 6, lineHeight: 1.4 },
  th: { flexDirection: "row", alignItems: "center", backgroundColor: "#f3f6f9", borderRadius: 5, paddingVertical: 6, paddingHorizontal: 5, marginBottom: 1 },
  thText: { fontSize: 5.2, color: "#6f7f92", fontFamily: "Helvetica-Bold", textTransform: "uppercase", letterSpacing: 0.25 },
  tr: { flexDirection: "row", alignItems: "center", paddingVertical: 6, paddingHorizontal: 5, borderBottomWidth: 1, borderBottomColor: "#edf1f4" },
  td: { fontSize: 7.6, textAlign: "right" },
  thumb: { width: 26, height: 26, borderRadius: 4, objectFit: "cover" },
  thumbBlank: { width: 26, height: 26, borderRadius: 4, backgroundColor: "#eef2f5" },
  adName: { fontSize: 7.6, fontFamily: "Helvetica-Bold", lineHeight: 1.2 },
  adMeta: { fontSize: 6.2, color: MUTED, marginTop: 2 },
  barBlock: { marginBottom: 9 },
  barTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 3, gap: 6 },
  barLabel: { flex: 1, fontSize: 7.2, fontFamily: "Helvetica-Bold", lineHeight: 1.2 },
  barValue: { fontSize: 7.6, fontFamily: "Helvetica-Bold", textAlign: "right" },
  barTrack: { height: 7, borderRadius: 4, overflow: "hidden" },
  adCard: { flex: 1, backgroundColor: "#ffffff", borderWidth: 1, borderColor: LINE, borderRadius: 10, overflow: "hidden" },
  adPic: { width: "100%", height: 128, objectFit: "cover" },
  adPicBlank: { width: "100%", height: 128, backgroundColor: "#eef2f5", alignItems: "center", justifyContent: "center" },
  adBody: { paddingVertical: 9, paddingHorizontal: 10 },
  insights: { flexDirection: "row", gap: 8 },
  insight: { flex: 1, backgroundColor: "#ffffff", borderWidth: 1, borderColor: LINE, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 12 },
  insightTitle: { fontSize: 9, fontFamily: "Helvetica-Bold", marginBottom: 5, lineHeight: 1.25 },
  insightText: { fontSize: 7.6, color: "#5d7184", lineHeight: 1.45 },
  footer: { position: "absolute", bottom: 22, left: PAD, right: PAD, borderTopWidth: 1, borderTopColor: "#d9e0e7", paddingTop: 7, flexDirection: "row", justifyContent: "space-between", gap: 12 },
  footText: { fontSize: 6.3, color: "#7f8c9a", lineHeight: 1.35 },
  pageNumber: { position: "absolute", bottom: 10, left: PAD, width: INNER, textAlign: "right", fontSize: 6, color: FAINT },
});

const hotStyle = { position: "absolute" as const, top: 0, left: 0, right: 0, bottom: 0, textDecoration: "none" as const };
function Hot({ href }: { href: string | null | undefined }) {
  return href ? <Link src={`${EDIT_HOST}/${href}`} style={hotStyle} /> : null;
}

/** Text inside an Svg (react-pdf's own svg text: x, y, fill and a font) */
const SvgText = Text as unknown as React.FC<{ x: number; y: number; fill?: string; textAnchor?: "start" | "middle" | "end"; style?: Record<string, unknown>; children: React.ReactNode }>;

const day = (d: string, o: Intl.DateTimeFormatOptions) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { ...o, timeZone: "UTC" });
/** "Nov 2 – Nov 8, 2026" */
const fullRange = (start: string, end: string) => `${day(start, { month: "short", day: "numeric" })} – ${day(end, { month: "short", day: "numeric", year: "numeric" })}`;
/** "Nov 2–8" */
const shortRange = (start: string, end: string) => (start.slice(0, 7) === end.slice(0, 7) ? `${day(start, { month: "short", day: "numeric" })}–${day(end, { day: "numeric" })}` : `${day(start, { month: "short", day: "numeric" })}–${day(end, { month: "short", day: "numeric" })}`);

/**
 * How the report talks about its period: a 7-day period is a week ("Weekly", "vs 7 prior week", "WoW"), a monthly recap
 * or a whole calendar month a month, anything else a period. A weekly that isn't 7 days (an on-demand recap) is a period.
 */
export type Cadence = { word: "Weekly" | "Monthly" | null; prior: "week" | "month" | "period"; abbr: string; movement: string };
export function cadenceOf(kind: WeeklyInput["kind"], m: Pick<ReportMetrics, "main">): Cadence {
  const { start, end } = m.main;
  const days = Math.round((Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86_400_000) + 1;
  const next = new Date(Date.parse(`${end}T12:00:00Z`) + 86_400_000);
  const wholeMonth = start.endsWith("-01") && next.getUTCDate() === 1 && days >= 28;
  if (kind === "monthly" || (kind === "built" && wholeMonth)) return { word: "Monthly", prior: "month", abbr: "MoM", movement: "Month-over-month movement" };
  if (days === 7) return { word: "Weekly", prior: "week", abbr: "WoW", movement: "Week-over-week movement" };
  return { word: null, prior: "period", abbr: "vs prior", movement: "Change vs the prior period" };
}

/** "Weekly Paid Social Report", "Paid Search Report" (Google), "Monthly Paid Social Report" */
export const eyebrowOf = (c: Cadence, platform: WeeklyPart["platform"]) => `${c.word ? `${c.word} ` : ""}Paid ${platform === "google" ? "Search" : "Social"} Report`;

/**
 * The report's colours. Kaizen's report: Kaizen's red and near-black lead (the band, the accents), the client's colour is
 * the results bars. A white label client's: their own colours throughout (a quiet slate when they have none), no red.
 */
export type Look = { hero: string; heroEdge: string; heroSoft: string; primary: string; bars: string; barsText: string; barsSoft: string; line: string };
export function lookFor(input: Pick<WeeklyInput, "brand" | "whiteLabel">): Look {
  const client = paletteFor(input.brand?.color, { whiteLabel: input.whiteLabel });
  if (input.whiteLabel) return { hero: client.hero, heroEdge: client.heroEdge, heroSoft: client.heroSoft, primary: client.accent, bars: client.accent, barsText: client.accentText, barsSoft: client.soft, line: client.line };
  // A red client's bars beside Kaizen's red line would blur together: their cost line goes deep navy instead
  const rgb = parseHex(client.accent)!;
  const h = hue(rgb);
  const reddish = saturation(rgb) > 0.3 && (h < 22 || h > 335);
  return { hero: KAIZEN_DEEP, heroEdge: KAIZEN_EDGE, heroSoft: KAIZEN_SOFT, primary: KAIZEN_RED, bars: client.accent, barsText: client.accentText, barsSoft: client.soft, line: reddish ? "#1f3b5c" : KAIZEN_RED };
}

const toneOf = (m: Move) => (!m || m.tone === "flat" ? FLAT : m.tone === "good" ? GOOD : BAD);

/** The arrow on a change: up or down, drawn (Helvetica has no arrow glyphs) */
function Arrow({ up, color }: { up: boolean; color: string }) {
  return (
    <Svg width={5.5} height={4.5} viewBox="0 0 6 5">
      <Polygon points={up ? "3,0 6,5 0,5" : "0,0 6,0 3,5"} fill={color} />
    </Svg>
  );
}

/** A logo in the header: as it is, or on a dark chip when it's a white logo */
function Logo({ src, light, chip, height, maxWidth }: { src: string; light?: boolean; chip: string; height: number; maxWidth: number }) {
  /* eslint-disable jsx-a11y/alt-text -- a PDF image, no alt prop */
  const img = <Image src={src} style={{ height, maxWidth, objectFit: "contain" }} />;
  return light ? <View style={{ backgroundColor: chip, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 4 }}>{img}</View> : img;
  /* eslint-enable jsx-a11y/alt-text */
}

/** The header: the client's logo and Kaizen's (Kaizen's the larger mark), and which service this section reads */
function Masthead({ input, part, look }: { input: WeeklyInput; part: WeeklyPart; look: Look }) {
  const agency = !input.whiteLabel;
  const logo = input.brand?.logo;
  return (
    <View style={s.mast}>
      <View style={s.brandRow}>
        {logo ? <Logo src={logo} light={input.brand?.light} chip={look.hero} height={agency ? 24 : 30} maxWidth={agency ? 84 : 150} /> : <Text style={{ fontSize: agency ? 12 : 15, fontFamily: "Helvetica-Bold", color: agency ? INK : look.primary, letterSpacing: -0.3 }}>{input.client}</Text>}
        {agency ? (
          <>
            <View style={s.divider} />
            {input.brand?.agencyLogo ? <Logo src={input.brand.agencyLogo} chip={look.hero} height={26} maxWidth={110} /> : <Text style={{ fontSize: 17, fontFamily: "Helvetica-Bold", color: KAIZEN_RED, letterSpacing: -0.4 }}>kaizen</Text>}
          </>
        ) : null}
      </View>
      <Text style={s.topKicker}>Performance Intelligence / {platformName(part.platform)}</Text>
    </View>
  );
}

function Hero({ input, part, look, cad, joint }: { input: WeeklyInput; part: WeeklyPart; look: Look; cad: Cadence; joint: boolean }) {
  const m = part.metrics;
  const search = part.platform === "google";
  const long = input.client.length > 16;
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
        <Circle cx={INNER - 30} cy={HERO_H * 0.22} r={198} fill="none" stroke="#ffffff" strokeOpacity={0.04} strokeWidth={28} />
      </Svg>
      <View style={s.heroBody}>
        <View style={{ maxWidth: 300 }}>
          <Text style={[s.eyebrow, { color: look.heroSoft }]}>{eyebrowOf(cad, part.platform)}</Text>
          <Text style={[s.h1, long ? { fontSize: 20 } : {}]}>{input.client.length <= 11 ? `${input.client} Performance\nOverview` : `${input.client}\nPerformance Overview`}</Text>
          <Text style={s.heroSub}>
            {joint ? `${platformName(part.platform)}: k` : "K"}ey results, efficiency trends &amp; {search ? "campaign" : "creative"} performance
          </Text>
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

/** One tile: the label, the number, a green or red move and the prior value */
function Tile({ label, value, mv, before, size, prior, hot }: { label: string; value: string; mv: Move; before: string; size: number; prior: string; hot?: string | null }) {
  const c = toneOf(mv);
  return (
    <View style={s.tile}>
      <Text style={s.tileLabel}>{label}</Text>
      <Text style={[s.tileValue, { fontSize: size }]}>{value}</Text>
      <View style={s.moveRow}>
        {mv ? (
          <View style={[s.chip, { backgroundColor: c.bg }]}>
            {mv.tone !== "flat" || mv.pct !== "0.0%" ? <Arrow up={mv.up} color={c.fg} /> : null}
            <Text style={[s.chipText, { color: c.fg }]}>{mv.pct}</Text>
          </View>
        ) : (
          <View style={[s.chip, { backgroundColor: FLAT.bg }]}>
            <Text style={[s.chipText, { color: FLAT.fg }]}>New</Text>
          </View>
        )}
        <Text style={s.baseline}>{before === "–" ? "No prior number" : `vs ${before} prior ${prior}`}</Text>
      </View>
      <Hot href={hot} />
    </View>
  );
}

/** Results the team entered from the client's CRM: tiles of their own (no arrow without a prior number) and where they come from */
function ManualResults({ m, cad, hot }: { m: ReportMetrics; cad: Cadence; /** The studio's preview: the address of a result's label ("meta/text/manual-<id>"), by its place in the tiles */ hot?: (id: string) => string | null }) {
  const caption = manualCaption(m.manual);
  if (!caption) return null;
  const tiles = manualTiles(m);
  // The tiles are the lines that aren't the headline result, in the same order
  const ids = (m.manual?.lines ?? []).filter((l) => !l.main).map((l) => l.id);
  return (
    <View style={{ marginTop: 8 }}>
      {tiles.length ? (
        <View style={s.tiles}>
          {tiles.map((t, i) => (
            <View key={`${t.label}-${i}`} style={s.tile}>
              <View>
                <Text style={s.tileLabel}>{t.label}</Text>
                <Hot href={hot && ids[i] ? hot(ids[i]) : null} />
              </View>
              <Text style={[s.tileValue, { fontSize: 18 }]}>{t.value}</Text>
              {t.sub ? <Text style={s.baseline}>{t.sub}</Text> : null}
              <Text style={[s.baseline, { marginTop: 3 }]}>{t.before != null ? `${t.delta ? `${t.delta.text} ` : ""}vs ${t.before} prior ${cad.prior}` : "No prior number"}</Text>
            </View>
          ))}
        </View>
      ) : null}
      <Text style={[s.baseline, { marginTop: 6 }]}>{caption}</Text>
    </View>
  );
}

function Glance({ input, part, cad }: { input: WeeklyInput; part: WeeklyPart; cad: Cadence }) {
  const m = part.metrics;
  const keys = weeklyTileKeys(m, part.layout);
  const tiles = keys.map((k) => weeklyTile(m, k, m.main, m.compare));
  const support = supportKeys(m, keys, part.layout);
  // More tiles than four (the buyer added some): smaller numbers so each still fits its tile
  const size = tiles.length <= 4 ? 21 : tiles.length === 5 ? 16.5 : 13.5;
  return (
    <View style={s.section} wrap={false}>
      <View style={s.head}>
        <Text style={s.h2}>Performance at a glance</Text>
        <Text style={s.sub}>{cad.movement} · Green = favorable, red = unfavorable</Text>
      </View>
      <View style={s.tiles}>
        {tiles.map((t, i) => (
          <Tile key={`${t.key}-${i}`} label={t.label} value={t.value} mv={t.move} before={t.before} size={size} prior={cad.prior} hot={input.edit ? `${part.platform}/tile/${i}` : null} />
        ))}
      </View>
      <ManualResults m={m} cad={cad} hot={input.edit ? (id) => `${part.platform}/text/manual-${id}` : undefined} />
      <View style={s.support}>
        {support.map((k, i) => {
          const now = metricNumber(m.main, k);
          const mv = k === "spend" && now != null ? weeklyTile(m, k, m.main, m.compare).move : null;
          return (
            <View key={`${k}-${i}`}>
              <Text style={s.supportText}>
                {k === "spend" ? "Ad spend" : shortLabel(m, k)} <Text style={{ fontFamily: "Helvetica-Bold", color: INK }}>{weeklyValue(k, now)}</Text>
                {mv ? ` (${mv.up ? "+" : "-"}${mv.pct} ${cad.abbr})` : ""}
              </Text>
              <Hot href={input.edit ? `${part.platform}/row/${i}` : null} />
            </View>
          );
        })}
      </View>
    </View>
  );
}

/** Five weeks: results as bars on the left axis (the client's colour), their cost (or ROAS) as a line on the right, every value labelled */
function Trend({ part, look }: { part: WeeklyPart; look: Look }) {
  const m = part.metrics;
  const weeks = chartWeeks(m);
  if (weeks.length < 2) return null;
  const roas = m.roasKpi;
  const line = (w: (typeof weeks)[number]) => (roas ? w.roas : w.costPerResult);
  const lineName = roas ? "ROAS" : costLabel(m);
  const fmtLine = (v: number | null) => (v == null ? "" : roas ? `${v.toFixed(2)}x` : `$${v >= 1000 ? Math.round(v).toLocaleString("en-US") : v.toFixed(2)}`);
  const width = INNER - 26;
  const height = 200;
  const L = 30;
  const R = width - 40;
  const T = 26;
  const B = height - 22;
  const H = B - T;
  const barMax = niceMax(Math.max(...weeks.map((w) => w.results)), true);
  const lineMax = niceMax(Math.max(...weeks.map((w) => line(w) ?? 0)));
  const xs = weeks.map((_, i) => L + ((R - L) * (i + 0.5)) / weeks.length);
  const bw = Math.min(58, ((R - L) / weeks.length) * 0.42);
  const yBar = (v: number) => B - (H * v) / barMax;
  const yLine = (v: number) => B - (H * v) / lineMax;
  const pts = weeks.map((w, i) => ({ x: xs[i], v: line(w) })).filter((p): p is { x: number; v: number } => p.v != null);
  const d = pts.map((p, i) => `${i ? "L" : "M"} ${p.x.toFixed(1)} ${yLine(p.v).toFixed(1)}`).join(" ");
  const axis = { fontSize: 6.3, fontFamily: "Helvetica" };
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
            <View style={[s.dot, { backgroundColor: look.bars }]} />
            <Text style={{ fontSize: 7, color: MUTED }}>{m.conversion} · left axis</Text>
          </View>
          <View style={s.legendItem}>
            <View style={[s.dot, { backgroundColor: look.line }]} />
            <Text style={{ fontSize: 7, color: MUTED }}>
              {lineName}
              {roas ? "" : " (USD)"} · right axis
            </Text>
          </View>
        </View>
        <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ marginTop: 6 }}>
          <SvgText x={L} y={T - 12} fill="#7a8b99" style={{ fontSize: 5.8, fontFamily: "Helvetica" }}>
            {m.conversion.toUpperCase()}
          </SvgText>
          <SvgText x={R} y={T - 12} textAnchor="end" fill="#7a8b99" style={{ fontSize: 5.8, fontFamily: "Helvetica" }}>
            {roas ? "ROAS" : `${lineName.toUpperCase()} (USD)`}
          </SvgText>
          {[0, 1, 2, 3, 4].map((j) => {
            const y = B - (H * j) / 4;
            return (
              <Fragment key={j}>
                <Line x1={L} y1={y} x2={R} y2={y} stroke="#e9eef3" strokeWidth={0.8} />
                <SvgText x={L - 7} y={y + 2.2} textAnchor="end" fill="#7a8b99" style={axis}>
                  {tick((barMax * j) / 4, false)}
                </SvgText>
                <SvgText x={R + 7} y={y + 2.2} fill="#7a8b99" style={axis}>
                  {tick((lineMax * j) / 4, true)}
                </SvgText>
              </Fragment>
            );
          })}
          {weeks.map((w, i) => {
            const y = yBar(w.results);
            const last = i === weeks.length - 1;
            // The count sits above its bar, as in the reference; when the cost line's point is there, inside the bar's
            // top (a tall bar) or above the point (a short one)
            const lv = line(w);
            const ly = lv == null ? -100 : yLine(lv);
            const clash = Math.abs(ly - (y - 8)) < 11;
            const inside = clash && B - y >= 24 && Math.abs(ly - (y + 12)) >= 9;
            const at = !clash ? y - 5 : inside ? y + 12 : Math.min(y, ly) - 9;
            return (
              <Fragment key={w.start}>
                <Rect x={xs[i] - bw / 2} y={y} width={bw} height={Math.max(0.5, B - y)} rx={3} fill={look.bars} />
                <SvgText x={xs[i]} y={at} textAnchor="middle" fill={inside ? "#ffffff" : look.barsText} style={{ fontSize: 8, fontFamily: "Helvetica-Bold" }}>
                  {weeklyValue("results", w.results)}
                </SvgText>
                <SvgText x={xs[i]} y={B + 13} textAnchor="middle" fill={last ? INK : "#7a8b99"} style={{ fontSize: 6.8, fontFamily: last ? "Helvetica-Bold" : "Helvetica" }}>
                  {w.label}
                </SvgText>
              </Fragment>
            );
          })}
          {d ? <Path d={d} stroke={look.line} strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" /> : null}
          {pts.map((p, i) => {
            const y = yLine(p.v);
            // The value sits to the right of its point: below it when the line climbs from there (it would cross the
            // label above), else above, unless that runs off the chart
            const next = pts[i + 1];
            const climbs = next != null && yLine(next.v) < y - 4;
            const above = climbs ? y + 16 > B : y - 14 > T - 6;
            const label = fmtLine(p.v);
            return (
              <Fragment key={i}>
                <Circle cx={p.x} cy={y} r={3.6} fill="#ffffff" stroke={look.line} strokeWidth={1.8} />
                <Rect x={p.x + 5.5} y={(above ? y - 14 : y + 4) - 0.5} width={label.length * 3.5 + 6} height={10} rx={2.5} fill="#ffffff" fillOpacity={0.92} />
                <SvgText x={p.x + 8.5} y={above ? y - 6.6 : y + 11.4} fill={look.line} style={{ fontSize: 6.6, fontFamily: "Helvetica-Bold" }}>
                  {label}
                </SvgText>
              </Fragment>
            );
          })}
        </Svg>
        <Text style={s.note}>
          {roas ? "ROAS = attributed revenue ÷ spend." : `${costLabel(m)} = spend ÷ attributed ${m.conversion.toLowerCase()}.`} Spend by week: {weeks.map((w) => `${w.label} $${Math.round(w.spend).toLocaleString("en-US")}`).join(" · ")}.
        </Text>
      </View>
    </View>
  );
}

function Thumb({ src }: { src: string | null | undefined }) {
  // eslint-disable-next-line jsx-a11y/alt-text -- a PDF image, no alt prop
  return src ? <Image src={src} style={s.thumb} /> : <View style={s.thumbBlank} />;
}

/** Column widths: each wide enough for its values and for the longest word of its heading in small caps (5.6pt bold,
 * spaced: about 3.4pt a letter), so "APPLICATIONS" or "COST PER APPLICATION" never runs into the next column */
const COL_W: Record<string, number> = { results: 37, cost_per_result: 39, cpc: 29, ctr: 32, spend: 41, clicks: 27, roas: 29, revenue: 42, hook_rate: 34 };
const GUTTER = 5;
const colWidth = (k: string, head: string) => Math.max((COL_W[k] ?? 34) - 4, Math.ceil(Math.max(...head.split(/\s+/).map((w) => w.length)) * 3.4)) + GUTTER;

function Scorecard({ input, part, rows, images }: { input: WeeklyInput; part: WeeklyPart; rows: ScoreRow[]; images: (string | null)[] }) {
  const m = { ...part.metrics, conversion: platformConversion(part.metrics) };
  const cols = scoreColumns(m, part.layout);
  const google = part.platform === "google";
  const pictures = !google || rows.some((r) => r.img != null);
  const unit = google ? (rows[0]?.kind === "campaign" ? "Campaign" : "Campaign / ad group") : "Ad / creative";
  const lead = m.roasKpi ? "roas" : "results";
  return (
    <View style={[s.panel, { flex: 2.65 }]}>
      <View style={s.head}>
        <Text style={s.h3}>{google ? "Campaign scorecard" : "Creative scorecard"}</Text>
        <Text style={s.sub}>Best first, by {m.roasKpi ? "ROAS" : m.conversion.toLowerCase()}</Text>
      </View>
      <View style={s.th}>
        <Text style={[s.thText, { flex: 1 }]}>{unit}</Text>
        {cols.map((k, i) => (
          <View key={k} style={{ width: colWidth(k, scoreHead(m, k)) }}>
            <Text style={[s.thText, { paddingLeft: GUTTER, textAlign: "right", lineHeight: 1.25 }]}>{scoreHead(m, k)}</Text>
            <Hot href={input.edit ? `${part.platform}/col/${i}` : null} />
          </View>
        ))}
      </View>
      {rows.map((r, i) => (
        <View key={r.id} style={[s.tr, i === rows.length - 1 ? { borderBottomWidth: 0 } : {}]} wrap={false}>
          <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 7, paddingRight: 6 }}>
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
            <Text key={k} style={[s.td, { width: colWidth(k, scoreHead(m, k)), paddingLeft: GUTTER }, k === lead ? { fontFamily: "Helvetica-Bold" } : {}]}>
              {scoreValue(r, k)}
            </Text>
          ))}
          <Hot href={input.edit && r.kind === "campaign" ? `${part.platform}/camp/${encodeURIComponent(r.name)}` : null} />
        </View>
      ))}
    </View>
  );
}

/** What each ad (or campaign) brought, as bars in the client's colour, and the one-line read under them */
function Bars({ part, rows, look }: { part: WeeklyPart; rows: ScoreRow[]; look: Look }) {
  const m = { ...part.metrics, conversion: platformConversion(part.metrics) };
  const k = barMetric(m);
  const google = part.platform === "google";
  const say = sayable(rows);
  const list = rows
    .map((r) => ({ r, v: metricNumber(r, k) ?? 0 }))
    .filter((x) => x.v > 0)
    .sort((a, b) => b.v - a.v)
    .slice(0, 6);
  const max = Math.max(...list.map((x) => x.v), 0);
  const read = barsRead(m, rows);
  return (
    <View style={[s.panel, { flex: 1 }]}>
      <Text style={[s.h3, { marginBottom: 10 }]}>
        {k === "revenue" ? "Revenue" : m.conversion} by {google ? (rows[0]?.kind === "campaign" ? "campaign" : "group") : "creative"}
      </Text>
      {list.map(({ r, v }) => (
        <View key={r.id} style={s.barBlock}>
          <View style={s.barTop}>
            <Text style={s.barLabel}>{say(r)}</Text>
            <Text style={s.barValue}>{weeklyValue(k, v)}</Text>
          </View>
          <View style={[s.barTrack, { backgroundColor: look.barsSoft }]}>
            <View style={{ width: `${Math.max(3, (v / max) * 100)}%`, height: "100%", borderRadius: 4, backgroundColor: look.bars }} />
          </View>
        </View>
      ))}
      {read ? <Text style={[s.note, { marginTop: 2 }]}>{read}</Text> : null}
    </View>
  );
}

/** The ads behind the results, as the creative itself: the top three by the KPI, picture first */
function TopAds({ part, rows, images, look }: { part: WeeklyPart; rows: ScoreRow[]; images: (string | null)[]; look: Look }) {
  if (part.platform === "google") return null;
  const top = rows.slice(0, 3);
  if (!top.some((r) => r.img != null && images[r.img])) return null;
  const m = { ...part.metrics, conversion: platformConversion(part.metrics) };
  const cost = costLabel(m);
  return (
    <View style={{ marginTop: 9 }} wrap={false}>
      <View style={s.head}>
        <Text style={s.h3}>Top ads</Text>
        <Text style={s.sub}>The creative behind the results</Text>
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {top.map((r, i) => {
          const src = r.img != null ? images[r.img] : null;
          return (
            <View key={r.id} style={s.adCard}>
              <View>
                {/* eslint-disable-next-line jsx-a11y/alt-text -- a PDF image, no alt prop */}
                {src ? <Image src={src} style={s.adPic} /> : <View style={s.adPicBlank}><Text style={{ fontSize: 7, color: FAINT }}>No preview</Text></View>}
                <View style={{ position: "absolute", top: 7, left: 7, backgroundColor: i === 0 ? look.primary : INK, borderRadius: 4, paddingVertical: 2.5, paddingHorizontal: 5 }}>
                  <Text style={{ fontSize: 6.5, fontFamily: "Helvetica-Bold", color: "#ffffff" }}>#{i + 1}</Text>
                </View>
              </View>
              <View style={s.adBody}>
                <Text style={[s.adName, { fontSize: 8 }]}>{r.name}</Text>
                {r.detail ? <Text style={s.adMeta}>{r.detail}</Text> : null}
                <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 10.5, fontFamily: "Helvetica-Bold", color: look.barsText }}>{m.roasKpi ? multiple(r.roas) : count(r.results)}</Text>
                    <Text style={{ fontSize: 5.2, color: MUTED, marginTop: 1.5, textTransform: "uppercase", letterSpacing: 0.2, lineHeight: 1.25 }}>{m.roasKpi ? "ROAS" : m.conversion}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 10.5, fontFamily: "Helvetica-Bold" }}>{m.roasKpi ? money(r.revenue) : money(r.costPerResult)}</Text>
                    <Text style={{ fontSize: 5.2, color: MUTED, marginTop: 1.5, textTransform: "uppercase", letterSpacing: 0.2, lineHeight: 1.25 }}>{m.roasKpi ? "Revenue" : cost}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 10.5, fontFamily: "Helvetica-Bold" }}>{money(r.spend)}</Text>
                    <Text style={{ fontSize: 5.2, color: MUTED, marginTop: 1.5, textTransform: "uppercase", letterSpacing: 0.2, lineHeight: 1.25 }}>Spend</Text>
                  </View>
                </View>
              </View>
            </View>
          );
        })}
        {top.length < 3 ? Array.from({ length: 3 - top.length }, (_, i) => <View key={`gap-${i}`} style={{ flex: 1 }} />) : null}
      </View>
    </View>
  );
}

function Creative({ input, part, images, look }: { input: WeeklyInput; part: WeeklyPart; images: (string | null)[]; look: Look }) {
  const m = part.metrics;
  const hide = new Set(part.layout?.campaigns?.hide ?? []);
  const rows = scorecardRows(m).filter((r) => r.kind !== "campaign" || !hide.has(r.name));
  if (!rows.length) return null;
  const google = part.platform === "google";
  const bars = rows.some((r) => (metricNumber(r, barMetric(m)) ?? 0) > 0);
  return (
    <View style={s.section}>
      <View wrap={false}>
        <View style={s.head}>
          <Text style={s.h2}>{google ? "Campaign performance" : "Creative performance"}</Text>
          <Text style={s.sub}>
            {shortRange(m.main.start, m.main.end)} · {google ? (rows[0].kind === "campaign" ? "campaign level" : "campaign and ad group level") : "ad level"}
          </Text>
        </View>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
          <Scorecard input={input} part={part} rows={rows} images={images} />
          {bars ? <Bars part={part} rows={rows} look={look} /> : null}
        </View>
      </View>
      <TopAds part={part} rows={rows} images={images} look={look} />
    </View>
  );
}

function Takeaways({ input, part, items, look }: { input: WeeklyInput; part: WeeklyPart; items: Takeaway[]; look: Look }) {
  if (!items.length) return null;
  return (
    <View style={s.section} wrap={false}>
      <View style={s.head}>
        <Text style={s.h2}>Key takeaways</Text>
        <Text style={s.sub}>From this period&apos;s {platformName(part.platform)} numbers</Text>
      </View>
      <View style={s.insights}>
        {items.map((t, i) => (
          <View key={i} style={s.insight}>
            <View style={{ width: 14, height: 2.5, borderRadius: 2, backgroundColor: look.primary, marginBottom: 8 }} />
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

/** A trend the buyer asked for: its chart alone (what it means goes in the message) */
function Stories({ input, part, look }: { input: WeeklyInput; part: WeeklyPart; look: Look }) {
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
              <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, height: 110 }}>
                {pts.map((p, k) => (
                  <View key={k} style={{ flex: 1, alignItems: "center", justifyContent: "flex-end", height: "100%" }}>
                    <Text style={{ fontSize: 7, color: k === pts.length - 1 ? look.barsText : MUTED, fontFamily: k === pts.length - 1 ? "Helvetica-Bold" : "Helvetica", marginBottom: 3 }}>{weeklyValue(st.metric, p.value)}</Text>
                    <View style={{ width: "55%", height: `${Math.max(2, ((p.value ?? 0) / max) * 78)}%`, borderTopLeftRadius: 3, borderTopRightRadius: 3, backgroundColor: look.bars, opacity: k === pts.length - 1 ? 1 : 0.45 }} />
                    <Text style={{ fontSize: 6.5, color: MUTED, marginTop: 3 }}>{p.label}</Text>
                  </View>
                ))}
                <Hot href={hot(`story/${i}`)} />
              </View>
            </View>
          </View>
        );
      })}
    </>
  );
}

/** A built report's other date ranges for this service: the same tiles, each against its own comparison */
function OtherRanges({ part }: { part: WeeklyPart }) {
  if (!part.extra?.length) return null;
  return (
    <View style={s.section} wrap={false}>
      <View style={s.head}>
        <Text style={s.h2}>Other periods</Text>
        <Text style={s.sub}>Each against the period before it</Text>
      </View>
      {part.extra.map((m) => {
        const keys = weeklyTileKeys(m, part.layout).slice(0, 4);
        const c = cadenceOf("built", m);
        return (
          <View key={`${m.main.start}-${m.main.end}`} style={{ marginBottom: 9 }}>
            <Text style={[s.tileLabel, { marginBottom: 5, color: INK }]}>
              {fullRange(m.main.start, m.main.end)} <Text style={{ color: MUTED, fontFamily: "Helvetica" }}>vs {fullRange(m.compare.start, m.compare.end)}</Text>
            </Text>
            <View style={s.tiles}>
              {keys.map((k, i) => {
                const t = weeklyTile(m, k, m.main, m.compare);
                return <Tile key={`${k}-${i}`} label={t.label} value={t.value} mv={t.move} before={t.before} size={15} prior={c.prior} />;
              })}
            </View>
          </View>
        );
      })}
    </View>
  );
}

/** Several services in one report: each side by side first, a card each (its spend, results and their cost) */
function Account({ input, look }: { input: WeeklyInput; look: Look }) {
  const spend = input.parts.reduce((n, p) => n + p.metrics.main.spend, 0);
  const before = input.parts.reduce((n, p) => n + p.metrics.compare.spend, 0);
  return (
    <View style={s.section} wrap={false}>
      <View style={s.head}>
        <Text style={s.h2}>Across the account</Text>
        <Text style={s.sub}>
          {money(spend)} across {input.parts.length} services{before ? `, against ${money(before)} the period before` : ""}
        </Text>
      </View>
      <View style={s.tiles}>
        {input.parts.map((p, i) => {
          const m = p.metrics;
          const lead = m.roasKpi && m.main.roas != null;
          const stat = (value: string, label: string) => (
            <View>
              <Text style={{ fontSize: 11.5, fontFamily: "Helvetica-Bold" }}>{value}</Text>
              <Text style={[s.baseline, { marginTop: 2 }]}>{label}</Text>
            </View>
          );
          return (
            <View key={`${p.platform}-${i}`} style={[s.tile, { paddingVertical: 10 }]}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: look.primary }} />
                <Text style={s.tileLabel}>{platformName(p.platform)}</Text>
              </View>
              <View style={{ flexDirection: "row", gap: 11, marginTop: 7 }}>
                {stat(money(m.main.spend), "Spend")}
                {stat(count(m.main.results), m.conversion)}
                {stat(lead ? multiple(m.main.roas) : money(m.main.costPerResult), lead ? "ROAS" : costLabel(m))}
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

/** The monthly's ask: what we need from the client for next month's creative */
function Shots({ input, look }: { input: WeeklyInput; look: Look }) {
  const shots = input.shots;
  if (!shots?.items.length) return null;
  const url = shots.url && (!input.whiteLabel || !/kaizen/i.test(shots.url)) ? shots.url : null;
  return (
    <View style={s.section} wrap={false}>
      <View style={s.head}>
        <Text style={s.h2}>What we need from you for {shots.month}</Text>
      </View>
      <View style={[s.panel, { borderLeftWidth: 3, borderLeftColor: look.primary }]}>
        {shots.items.slice(0, 8).map((x, i) => (
          <View key={i} style={{ flexDirection: "row", marginBottom: 3 }}>
            <Text style={{ width: 9, color: look.primary, fontFamily: "Helvetica-Bold", fontSize: 8 }}>•</Text>
            <Text style={{ flex: 1, fontSize: 8, lineHeight: 1.4, color: "#33475b" }}>{x}</Text>
          </View>
        ))}
        {shots.items.length > 8 ? <Text style={s.note}>and {shots.items.length - 8} more</Text> : null}
        {url ? (
          <Link src={url} style={{ marginTop: 5, fontSize: 8, color: look.primary, fontFamily: "Helvetica-Bold", textDecoration: "none" }}>
            Send them on your shot list
          </Link>
        ) : null}
      </View>
    </View>
  );
}

/** The words of one part's write-up that go in "Our notes": its headline and summary, and what we did, are doing and will do */
export function notesOf(sections: Sections) {
  const list = (xs: string[] | undefined) => (Array.isArray(xs) ? xs.map((x) => String(x ?? "").trim()).filter(Boolean) : []);
  const groups = [
    { title: "What we did", items: list(sections.did) },
    { title: "What we're doing", items: list(sections.doing) },
    { title: "What's next", items: list(sections.next) },
  ].filter((g) => g.items.length);
  const headline = String(sections.headline ?? "").trim();
  const summary = String(sections.summary ?? "").trim();
  return { headline, summary, groups, empty: !headline && !summary && !groups.length };
}

/**
 * Our notes: the buyer's write-up, a last page (the copy kept in Drive only: the client's PDF never carries it). A section
 * per service on a joint report. Plain words only, no agency name, so it reads the same for a white label client.
 */
function Notes({ input, look }: { input: WeeklyInput; look: Look }) {
  if (!input.withNotes) return null;
  const parts = input.parts.map((p) => ({ p, n: notesOf(p.sections) })).filter((x) => !x.n.empty);
  if (!parts.length) return null;
  const joint = input.parts.length > 1;
  return (
    <View break>
      {parts.map(({ p, n }, i) => {
        // In the studio's preview every line is a click target; a point's place is its place in the buyer's own list
        // (blank ones are not printed, but still count), so the box that opens is the one for that line
        const hot = (x: string) => (input.edit ? `${p.platform}/text/${x}` : null);
        const places = { "What we did": "did", "What we're doing": "doing", "What's next": "next" } as const;
        return (
          <View key={`${p.platform}-${i}`} style={{ marginBottom: 18 }}>
            <View style={s.head}>
              <Text style={s.h2}>Our notes</Text>
              {joint ? <Text style={s.sub}>{platformName(p.platform)}</Text> : <Text style={s.sub}>{input.periodLabel}</Text>}
            </View>
            {n.headline || n.summary ? (
              <View style={[s.panel, { borderLeftWidth: 3, borderLeftColor: look.primary, marginBottom: 8 }]}>
                {n.headline ? (
                  <View style={{ marginBottom: n.summary ? 5 : 0 }}>
                    <Text style={{ fontSize: 11, fontFamily: "Helvetica-Bold", lineHeight: 1.3 }}>{n.headline}</Text>
                    <Hot href={hot("headline")} />
                  </View>
                ) : null}
                {n.summary ? (
                  <View>
                    <Text style={{ fontSize: 8.4, lineHeight: 1.5, color: "#33475b" }}>{n.summary}</Text>
                    <Hot href={hot("summary")} />
                  </View>
                ) : null}
              </View>
            ) : null}
            {n.groups.map((g) => {
              const key = places[g.title as keyof typeof places];
              const all = (Array.isArray(p.sections[key]) ? p.sections[key] : []).map((x) => String(x ?? "").trim());
              // each printed point, with its place in the full list
              let seen = -1;
              const at = g.items.map((text) => {
                seen = all.indexOf(text, seen + 1);
                return seen;
              });
              return (
                <View key={g.title} style={[s.panel, { marginBottom: 8 }]} wrap={false}>
                  <Text style={[s.h3, { marginBottom: 6 }]}>{g.title}</Text>
                  {g.items.map((x, j) => (
                    <View key={j} style={{ flexDirection: "row", marginBottom: 3 }}>
                      <Text style={{ width: 9, color: look.primary, fontFamily: "Helvetica-Bold", fontSize: 8 }}>•</Text>
                      <Text style={{ flex: 1, fontSize: 8, lineHeight: 1.45, color: "#33475b" }}>{x}</Text>
                      <Hot href={at[j] >= 0 ? hot(`${key}/${at[j]}`) : null} />
                    </View>
                  ))}
                </View>
              );
            })}
          </View>
        );
      })}
    </View>
  );
}

/** The data note in the footer: where the numbers come from and how they're counted */
function dataNote(parts: WeeklyPart[]) {
  const src = [...new Set(parts.map((p) => platformName(p.platform)))].join(", ");
  const how = parts.map((p) => (p.platform === "meta" ? "Meta attribution: 7-day click, 1-day view" : p.platform === "google" ? "Conversions as Google Ads counts them" : "TikTok attribution as reported"));
  return { left: `Data: ${src}, synced daily`, right: `Currency USD · CTR uses link clicks · ${[...new Set(how)].join(" · ")}` };
}

function Footer({ input }: { input: WeeklyInput }) {
  const note = dataNote(input.parts);
  return (
    <>
      <View style={s.footer} fixed>
        <Text style={[s.footText, { maxWidth: 250 }]}>
          {input.whiteLabel ? `Prepared for ${input.client}` : `Prepared for ${input.client} · Kaizen`} | {note.left}
        </Text>
        <Text style={[s.footText, { textAlign: "right", flex: 1 }]}>{note.right}</Text>
      </View>
      <Text style={s.pageNumber} fixed render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
    </>
  );
}

/** The whole report: one document, a section per platform. images: each part's pictures (the scorecard's img indexes) */
export function WeeklyReport({ input, images }: { input: WeeklyInput; images: (string | null)[][] }) {
  const look = lookFor(input);
  const joint = input.parts.length > 1;
  return (
    <Page size="A4" style={s.page}>
      <Footer input={input} />
      {input.parts.map((part, i) => {
        const items = takeawaysFor(part.metrics, part.sections.takeaways);
        const cad = cadenceOf(input.kind ?? "weekly", part.metrics);
        return (
          <View key={`${part.platform}-${i}`} break={i > 0}>
            <Masthead input={input} part={part} look={look} />
            <Hero input={input} part={part} look={look} cad={cad} joint={joint} />
            {joint && i === 0 ? <Account input={input} look={look} /> : null}
            <Glance input={input} part={part} cad={cad} />
            <Trend part={part} look={look} />
            <Creative input={input} part={part} images={images[i] ?? []} look={look} />
            <Takeaways input={input} part={part} items={items} look={look} />
            <OtherRanges part={part} />
            <Stories input={input} part={part} look={look} />
          </View>
        );
      })}
      <Shots input={input} look={look} />
      <Notes input={input} look={look} />
      {input.dashboard && !input.whiteLabel ? (
        <Link src={input.dashboard} style={{ fontSize: 8, color: look.primary, fontFamily: "Helvetica-Bold", textDecoration: "none", marginTop: 2 }}>
          See every number, any dates, on your live dashboard
        </Link>
      ) : null}
    </Page>
  );
}
