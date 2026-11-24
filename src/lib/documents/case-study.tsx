import type { FC, ReactNode } from "react";
import { Circle, Document, G, Image, Line, Page, Path, Rect, StyleSheet, Svg, Text, View } from "@react-pdf/renderer";
import { logoBox } from "@/lib/reports/weekly-doc";
import { paletteFor, type CaseStudy, type CaseStudyChart, type CaseStudyPalette, type CaseStudyPoint } from "./case-study-core";

// A client case study in Kaizen's own look, apart from the SOW and proposal template: dark, high-contrast pages,
// oversized bold type, the accent only as a hard edge (thin rules, a bar, the numbers that matter) and charts drawn
// with Svg primitives. Every colour comes from paletteFor(cs.accent) so the look can change in one place. Pages: the
// cover with the top results, the story, the results with the charts (two at most per page), then the highlights and
// the quote. Anything empty is left out entirely, never drawn as an empty box. US Letter, portrait.

export type CaseStudyInput = {
  cs: CaseStudy;
  brand: { logo: string | null; agencyLogo: string | null };
};
export type ChartUnit = CaseStudyChart["unit"];

const W = 612;
const H = 792;
const PAD = 48;
const CONTENT = W - PAD * 2;
const CHART_H = 178;

// Pure helpers, exported for tests

const trim0 = (s: string) => s.replace(/\.0$/, "");

/** A big number in a few characters: 12.3k, 120k, 1.4M, 2.1B */
function compact(abs: number): string | null {
  if (abs >= 999_950_000) return `${trim0((abs / 1e9).toFixed(1))}B`;
  if (abs >= 999_950) return `${trim0((abs / 1e6).toFixed(1))}M`;
  if (abs >= 99_950) return `${Math.round(abs / 1e3)}k`;
  if (abs >= 10_000) return `${trim0((abs / 1e3).toFixed(1))}k`;
  return null;
}

/** A value as it reads on the page: $ with separators and k/M when big, % and x with one decimal */
export function formatValue(value: number, unit: ChartUnit): string {
  if (!Number.isFinite(value)) return "";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (unit === "%" || unit === "x") return `${sign}${abs.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}${unit}`;
  const big = compact(abs);
  const pre = unit === "$" ? "$" : "";
  if (big) return `${sign}${pre}${big}`;
  if (abs >= 100 || Number.isInteger(abs)) return `${sign}${pre}${Math.round(abs).toLocaleString("en-US")}`;
  // Small amounts keep their cents ($4.25); plain small numbers keep one decimal
  return unit === "$" ? `${sign}$${abs.toFixed(2)}` : `${sign}${trim0(abs.toFixed(1))}`;
}

// Steps whose halves still read cleanly with one decimal (no 2.5 that halves to 1.25)
const NICE = [1, 1.2, 1.6, 2, 3, 4, 5, 6, 8, 10];

/** The top of a chart's axis: a round number at or above the biggest value, never 0, with a mid tick */
export function chartScale(points: CaseStudyPoint[]): {
  max: number;
  ticks: number[];
} {
  const top = Math.max(0, ...points.map((p) => (Number.isFinite(p.value) ? p.value : 0)));
  if (top <= 0) return { max: 1, ticks: [0, 0.5, 1] };
  const mag = 10 ** Math.floor(Math.log10(top));
  const step = NICE.find((n) => n * mag >= top - 1e-9) ?? 10;
  const max = Number((step * mag).toPrecision(12));
  return { max, ticks: [0, Number((max / 2).toPrecision(12)), max] };
}

/** The centre of slot i when n points share a width */
export const slotCenter = (i: number, n: number, width: number) => (width / Math.max(1, n)) * (i + 0.5);

/** Vertical bars inside a width by height box (y grows down), one slot per point, negatives drawn flat */
export function barGeometry(points: CaseStudyPoint[], box: { width: number; height: number; max: number }): { x: number; y: number; w: number; h: number }[] {
  const n = points.length;
  const slot = box.width / Math.max(1, n);
  const w = Math.min(slot * 0.56, 46);
  return points.map((p, i) => {
    const h = box.max > 0 ? (Math.max(0, p.value) / box.max) * box.height : 0;
    return { x: slotCenter(i, n, box.width) - w / 2, y: box.height - h, w, h };
  });
}

/** The points of a line chart inside a width by height box, on the same slot centres as the bars */
export function linePoints(points: CaseStudyPoint[], box: { width: number; height: number; max: number }): { x: number; y: number }[] {
  return points.map((p, i) => ({
    x: slotCenter(i, points.length, box.width),
    y: box.height - (box.max > 0 ? (Math.max(0, p.value) / box.max) * box.height : 0),
  }));
}

/** An Svg path through the points: M x y L x y ... */
export const linePath = (pts: { x: number; y: number }[]) => pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");

/** A font size that keeps a short run of bold digits inside a width */
export const fitSize = (text: string, width: number, max: number, min = 14) => Math.max(min, Math.min(max, Math.floor(width / (Math.max(1, text.length) * 0.6))));

/** Lists of charts in pages of two at most; the first page may carry one fewer when it shares the page */
export function chartPages(charts: CaseStudyChart[], firstSlots: number): CaseStudyChart[][] {
  const pages: CaseStudyChart[][] = [];
  let rest = charts;
  if (firstSlots > 0 && rest.length) {
    pages.push(rest.slice(0, firstSlots));
    rest = rest.slice(firstSlots);
  }
  for (let i = 0; i < rest.length; i += 2) pages.push(rest.slice(i, i + 2));
  return pages;
}

// The look

// The page sets no line height: one inherited by the footer's render-prop text throws it thousands of points off the page
const s = StyleSheet.create({
  page: { fontFamily: "Helvetica", fontSize: 10.5, paddingTop: PAD, paddingBottom: 72, paddingHorizontal: PAD },
  kicker: { fontSize: 8, fontFamily: "Helvetica-Bold", letterSpacing: 2.4, textTransform: "uppercase" },
  heading: { fontSize: 30, fontFamily: "Helvetica-Bold", letterSpacing: -1, lineHeight: 1.05 },
  body: { fontSize: 10.5, lineHeight: 1.55 },
  foot: { fontSize: 7.5, letterSpacing: 0.6 },
});

const SvgText = Text as unknown as FC<{
  x: number;
  y: number;
  fill?: string;
  textAnchor?: "start" | "middle" | "end";
  style?: Record<string, unknown>;
  children: ReactNode;
}>;

function Label({ x, y, anchor, fill, size, bold, children }: { x: number; y: number; anchor: "start" | "middle" | "end"; fill: string; size: number; bold?: boolean; children: ReactNode }) {
  return (
    <SvgText
      x={x}
      y={y}
      fill={fill}
      textAnchor={anchor}
      style={{
        fontSize: size,
        fontFamily: bold ? "Helvetica-Bold" : "Helvetica",
      }}
    >
      {children}
    </SvgText>
  );
}

/** The marks on every page: corner crop marks and the accent edge on the left */
function Marks({ p }: { p: CaseStudyPalette }) {
  const marks = [
    [22, 22],
    [W - 22, 22],
    [22, H - 22],
    [W - 22, H - 22],
  ];
  return (
    <View fixed style={{ position: "absolute", top: 0, left: 0, width: W, height: H }}>
      <Svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        {marks.map(([x, y], i) => (
          <Path key={i} d={`M${x - 5} ${y} L${x + 5} ${y} M${x} ${y - 5} L${x} ${y + 5}`} stroke={p.line} strokeWidth={0.8} />
        ))}
        <Rect x={0} y={PAD} width={4} height={64} fill={p.accent} />
      </Svg>
    </View>
  );
}

/** The footer on every page: who it is from, whose case study, and the page number */
function Footer({ p, client }: { p: CaseStudyPalette; client: string }) {
  return (
    <View
      fixed
      style={{
        position: "absolute",
        bottom: 30,
        left: PAD,
        right: PAD,
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        borderTopWidth: 0.75,
        borderTopColor: p.line,
        paddingTop: 9,
      }}
    >
      <Text style={[s.foot, { color: p.muted }]}>Kaizen Marketing · {client ? `${client} case study` : "Case study"}</Text>
      <Text style={[s.foot, { color: p.muted, fontFamily: "Helvetica-Bold" }]} render={({ pageNumber, totalPages }) => `${String(pageNumber).padStart(2, "0")} / ${String(totalPages).padStart(2, "0")}`} />
    </View>
  );
}

/** A logo on a light chip so dark marks read on the dark page */
function Chip({ src, p, height, maxWidth }: { src: string; p: CaseStudyPalette; height: number; maxWidth: number }) {
  const box = logoBox(src, height, maxWidth);
  return (
    <View
      style={{
        backgroundColor: p.ink,
        borderRadius: 2,
        paddingHorizontal: 8,
        paddingVertical: 5,
      }}
    >
      {/* eslint-disable-next-line jsx-a11y/alt-text -- a PDF image, no alt prop */}
      <Image src={src} style={{ width: box.width, height: box.height, objectFit: "contain" }} />
    </View>
  );
}

/** A section's opening: its number in the accent, a hairline, the kicker and a big heading */
function SectionHead({ n, kicker, title, p }: { n: number; kicker: string; title: string; p: CaseStudyPalette }) {
  return (
    <View style={{ marginBottom: 26 }} minPresenceAhead={120}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          marginBottom: 14,
        }}
      >
        <Text style={[s.kicker, { color: p.accent }]}>{String(n).padStart(2, "0")}</Text>
        <View style={{ width: 28, height: 0.75, backgroundColor: p.accent }} />
        <Text style={[s.kicker, { color: p.muted }]}>{kicker}</Text>
      </View>
      <Text style={[s.heading, { color: p.ink }]}>{title}</Text>
    </View>
  );
}

/** A label in the narrow left column and its content on the right: the editorial grid of the story page */
function Row({ label, p, children, last }: { label: string; p: CaseStudyPalette; children: ReactNode; last?: boolean }) {
  return (
    <View
      style={{
        flexDirection: "row",
        gap: 20,
        paddingVertical: 16,
        borderTopWidth: 0.75,
        borderTopColor: p.line,
        marginBottom: last ? 0 : 2,
      }}
    >
      <Text style={[s.kicker, { color: p.muted, width: 110, paddingTop: 2 }]}>{label}</Text>
      <View style={{ flex: 1 }}>{children}</View>
    </View>
  );
}

function Cover({ input, p }: { input: CaseStudyInput; p: CaseStudyPalette }) {
  const { cs, brand } = input;
  const top = cs.results.slice(0, 3);
  const titleSize = cs.title.length <= 30 ? 50 : cs.title.length <= 55 ? 42 : cs.title.length <= 80 ? 34 : 29;
  const colW = top.length ? (CONTENT - (top.length - 1) * 22) / top.length : CONTENT;
  const meta = [
    ["Client", cs.client],
    ["Industry", cs.industry],
    ["Period", cs.period],
  ].filter(([, v]) => v);
  return (
    <View style={{ flex: 1, justifyContent: "space-between" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        {brand.agencyLogo ? (
          <Chip src={brand.agencyLogo} p={p} height={18} maxWidth={96} />
        ) : (
          <Text
            style={{
              fontSize: 15,
              fontFamily: "Helvetica-Bold",
              color: p.ink,
              letterSpacing: 3,
            }}
          >
            KAIZEN
          </Text>
        )}
        {brand.logo ? (
          <>
            <Text style={{ fontSize: 10, color: p.muted }}>×</Text>
            <Chip src={brand.logo} p={p} height={22} maxWidth={120} />
          </>
        ) : null}
      </View>

      <View>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            marginBottom: 18,
          }}
        >
          <View style={{ width: 36, height: 3, backgroundColor: p.accent }} />
          <Text style={[s.kicker, { color: p.accent, fontSize: 9, letterSpacing: 4 }]}>Case study</Text>
        </View>
        <Text
          style={{
            fontSize: titleSize,
            fontFamily: "Helvetica-Bold",
            color: p.ink,
            letterSpacing: -titleSize * 0.03,
            lineHeight: 1.02,
          }}
        >
          {cs.title}
        </Text>
        {cs.subtitle ? (
          <Text
            style={{
              fontSize: 13,
              color: p.muted,
              marginTop: 16,
              lineHeight: 1.45,
              maxWidth: 440,
            }}
          >
            {cs.subtitle}
          </Text>
        ) : null}
        {meta.length ? (
          <View style={{ flexDirection: "row", gap: 28, marginTop: 26 }}>
            {meta.map(([k, v]) => (
              <View key={k}>
                <Text style={[s.kicker, { color: p.muted, fontSize: 7, marginBottom: 4 }]}>{k}</Text>
                <Text
                  style={{
                    fontSize: 10.5,
                    fontFamily: "Helvetica-Bold",
                    color: p.ink,
                  }}
                >
                  {v}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>

      {top.length ? (
        <View style={{ flexDirection: "row", gap: 22, marginBottom: 14 }}>
          {top.map((r, i) => (
            <View
              key={i}
              style={{
                width: colW,
                borderTopWidth: 0.75,
                borderTopColor: p.line,
                paddingTop: 12,
              }}
            >
              <View
                style={{
                  width: 22,
                  height: 2,
                  backgroundColor: p.accent,
                  marginTop: -13,
                  marginBottom: 12,
                }}
              />
              <Text
                style={{
                  fontSize: fitSize(r.value, colW, top.length === 1 ? 84 : 58, 22),
                  fontFamily: "Helvetica-Bold",
                  color: i === 0 ? p.accent : p.ink,
                  letterSpacing: -1.5,
                  lineHeight: 1,
                }}
              >
                {r.value}
              </Text>
              <Text
                style={{
                  fontSize: 9.5,
                  fontFamily: "Helvetica-Bold",
                  color: p.ink,
                  marginTop: 8,
                  lineHeight: 1.3,
                }}
              >
                {r.label}
              </Text>
            </View>
          ))}
        </View>
      ) : (
        <View />
      )}
    </View>
  );
}

function Story({ cs, p }: { cs: CaseStudy; p: CaseStudyPalette }) {
  const rows: { label: string; node: ReactNode }[] = [];
  if (cs.challenge)
    rows.push({
      label: "The challenge",
      node: <Text style={[s.body, { color: p.ink }]}>{cs.challenge}</Text>,
    });
  if (cs.approach.length)
    rows.push({
      label: "The approach",
      node: (
        <View style={{ gap: 12 }}>
          {cs.approach.map((a, i) => (
            <View key={i} style={{ flexDirection: "row", gap: 14 }} wrap={false}>
              <Text
                style={{
                  fontSize: 16,
                  fontFamily: "Helvetica-Bold",
                  color: p.accent,
                  width: 26,
                  lineHeight: 1,
                  marginTop: -1,
                }}
              >
                {String(i + 1).padStart(2, "0")}
              </Text>
              <Text style={[s.body, { color: p.ink, flex: 1 }]}>{a}</Text>
            </View>
          ))}
        </View>
      ),
    });
  return (
    <>
      {cs.summary ? (
        <Text
          style={{
            fontSize: 16,
            color: p.ink,
            lineHeight: 1.45,
            letterSpacing: -0.2,
            marginBottom: 28,
          }}
        >
          {cs.summary}
        </Text>
      ) : null}
      {rows.map((r, i) => (
        <Row key={r.label} label={r.label} p={p} last={i === rows.length - 1}>
          {r.node}
        </Row>
      ))}
    </>
  );
}

function Stats({ cs, p }: { cs: CaseStudy; p: CaseStudyPalette }) {
  const n = cs.results.length;
  const cols = n === 1 ? 1 : n === 3 ? 3 : 2;
  const gap = 20;
  const colW = (CONTENT - (cols - 1) * gap) / cols;
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        columnGap: gap,
        rowGap: 22,
        marginBottom: 30,
      }}
      wrap={false}
    >
      {cs.results.map((r, i) => (
        <View
          key={i}
          style={{
            width: colW,
            borderTopWidth: 0.75,
            borderTopColor: p.line,
            paddingTop: 12,
          }}
        >
          <View
            style={{
              width: 22,
              height: 2,
              backgroundColor: p.accent,
              marginTop: -13,
              marginBottom: 12,
            }}
          />
          <Text
            style={{
              fontSize: fitSize(r.value, colW, cols === 1 ? 64 : 40, 20),
              fontFamily: "Helvetica-Bold",
              color: p.accent,
              letterSpacing: -1,
              lineHeight: 1,
            }}
          >
            {r.value}
          </Text>
          <Text
            style={{
              fontSize: 10.5,
              fontFamily: "Helvetica-Bold",
              color: p.ink,
              marginTop: 8,
            }}
          >
            {r.label}
          </Text>
          {r.note ? (
            <Text
              style={{
                fontSize: 9,
                color: p.muted,
                marginTop: 4,
                lineHeight: 1.4,
              }}
            >
              {r.note}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

/** One chart: the title, the drawing and its note */
function Chart({ chart, p }: { chart: CaseStudyChart; p: CaseStudyPalette }) {
  const padL = 44;
  const padR = 10;
  const padT = 24;
  const padB = 22;
  const plotW = CONTENT - padL - padR;
  const plotH = CHART_H - padT - padB;
  const { max, ticks } = chartScale(chart.points);
  const n = chart.points.length;
  const dense = n > 8;
  const box = { width: plotW, height: plotH, max };
  const yOf = (v: number) => padT + plotH - (Math.max(0, v) / max) * plotH;
  const fmt = (v: number) => formatValue(v, chart.unit);
  const last = n - 1;
  const showLabel = (i: number) => !dense || (last - i) % 2 === 0;

  let marks: ReactNode;
  if (chart.kind === "bar") {
    const bars = barGeometry(chart.points, box);
    marks = bars.map((b, i) => (
      <G key={i}>
        <Rect x={padL + b.x} y={padT + b.y} width={b.w} height={Math.max(b.h, 0.75)} fill={i === last ? p.accent : p.muted} fillOpacity={i === last ? 1 : 0.32} />
        <Label x={padL + b.x + b.w / 2} y={padT + b.y - 5} anchor="middle" fill={i === last ? p.accent : p.ink} size={dense ? 6 : 7.5} bold>
          {fmt(chart.points[i].value)}
        </Label>
      </G>
    ));
  } else {
    const pts = linePoints(chart.points, box).map((q) => ({
      x: q.x + padL,
      y: q.y + padT,
    }));
    const base = padT + plotH;
    const area = `${linePath(pts)} L${pts[last].x.toFixed(2)} ${base} L${pts[0].x.toFixed(2)} ${base} Z`;
    const end = pts[last];
    const callout = fmt(chart.points[last].value);
    const cw = callout.length * 5.6 + 12;
    const cx = Math.max(padL, Math.min(end.x - cw / 2, CONTENT - cw));
    const cy = Math.max(0, end.y - 26);
    marks = (
      <>
        <Path d={area} fill={p.accent} fillOpacity={0.1} />
        <Path d={linePath(pts)} stroke={p.accent} strokeWidth={2} fill="none" />
        {pts.map((q, i) => (i === last ? null : <Circle key={i} cx={q.x} cy={q.y} r={2.6} fill={p.bg} stroke={p.accent} strokeWidth={1.4} />))}
        <Circle cx={end.x} cy={end.y} r={4.2} fill={p.accent} />
        <Rect x={cx} y={cy} width={cw} height={15} fill={p.accent} />
        <Label x={cx + cw / 2} y={cy + 10.5} anchor="middle" fill={p.bg} size={8} bold>
          {callout}
        </Label>
        {n > 2 ? (
          <Label x={pts[0].x} y={pts[0].y - 8} anchor="middle" fill={p.muted} size={7} bold>
            {fmt(chart.points[0].value)}
          </Label>
        ) : null}
      </>
    );
  }

  return (
    <View style={{ marginBottom: 28 }} wrap={false}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <Text
          style={{
            fontSize: 12.5,
            fontFamily: "Helvetica-Bold",
            color: p.ink,
            letterSpacing: -0.2,
            flex: 1,
          }}
        >
          {chart.title}
        </Text>
        <Text style={[s.kicker, { color: p.muted, fontSize: 6.5 }]}>{chart.kind === "bar" ? "Bar" : "Trend"}</Text>
      </View>
      <Svg width={CONTENT} height={CHART_H} viewBox={`0 0 ${CONTENT} ${CHART_H}`}>
        {ticks.map((t, i) => (
          <G key={`t${i}`}>
            <Line x1={padL} y1={yOf(t)} x2={CONTENT - padR} y2={yOf(t)} stroke={p.line} strokeWidth={i === 0 ? 1 : 0.6} strokeDasharray={i === 0 ? undefined : "2 3"} />
            <Label x={padL - 8} y={yOf(t) + 2.5} anchor="end" fill={p.muted} size={6.5}>
              {fmt(t)}
            </Label>
          </G>
        ))}
        {marks}
        {chart.points.map((pt, i) =>
          showLabel(i) ? (
            <Label key={`x${i}`} x={padL + slotCenter(i, n, plotW)} y={CHART_H - 6} anchor="middle" fill={i === last ? p.ink : p.muted} size={dense ? 6 : 7} bold={i === last}>
              {pt.label}
            </Label>
          ) : null,
        )}
      </Svg>
      {chart.note ? (
        <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
          <View style={{ width: 2, backgroundColor: p.accent }} />
          <Text style={{ fontSize: 9, color: p.muted, lineHeight: 1.4, flex: 1 }}>{chart.note}</Text>
        </View>
      ) : null}
    </View>
  );
}

function Closing({ cs, p, brand }: { cs: CaseStudy; p: CaseStudyPalette; brand: CaseStudyInput["brand"] }) {
  return (
    <View style={{ flex: 1, justifyContent: "space-between" }}>
      <View>
        {cs.highlights.length ? (
          <View style={{ marginBottom: 34 }}>
            {cs.highlights.map((h, i) => (
              <View
                key={i}
                wrap={false}
                style={{
                  flexDirection: "row",
                  gap: 16,
                  paddingVertical: 12,
                  borderTopWidth: 0.75,
                  borderTopColor: p.line,
                }}
              >
                <View
                  style={{
                    width: 10,
                    height: 2,
                    backgroundColor: p.accent,
                    marginTop: 7,
                  }}
                />
                <Text
                  style={{
                    fontSize: 12,
                    color: p.ink,
                    lineHeight: 1.45,
                    flex: 1,
                  }}
                >
                  {h}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
        {cs.quote ? (
          <View
            wrap={false}
            style={{
              borderLeftWidth: 3,
              borderLeftColor: p.accent,
              paddingLeft: 22,
              paddingVertical: 4,
            }}
          >
            <Text
              style={{
                fontSize: 54,
                fontFamily: "Helvetica-Bold",
                color: p.accent,
                lineHeight: 0.8,
                marginBottom: 4,
              }}
            >
              “
            </Text>
            <Text
              style={{
                fontSize: cs.quote.text.length > 180 ? 15 : 19,
                fontFamily: "Helvetica-Bold",
                color: p.ink,
                lineHeight: 1.35,
                letterSpacing: -0.3,
              }}
            >
              {cs.quote.text}
            </Text>
            {cs.quote.by ? <Text style={[s.kicker, { color: p.muted, marginTop: 14 }]}>{cs.quote.by}</Text> : null}
          </View>
        ) : null}
      </View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          marginTop: 30,
        }}
        wrap={false}
      >
        {brand.agencyLogo ? <Chip src={brand.agencyLogo} p={p} height={16} maxWidth={84} /> : null}
        <Text style={[s.kicker, { color: p.ink }]}>Kaizen Marketing</Text>
      </View>
    </View>
  );
}

export function CaseStudyDocument({ input }: { input: CaseStudyInput }) {
  const { cs } = input;
  const p = paletteFor(cs.accent);
  const page = [s.page, { backgroundColor: p.bg, color: p.ink }];
  const hasStory = Boolean(cs.summary || cs.challenge || cs.approach.length);
  const hasResults = cs.results.length > 0;
  // The results page carries the first chart under the stat blocks; the rest go two to a page
  const charts = chartPages(cs.charts, hasResults ? 1 : 0);
  const hasClosing = Boolean(cs.highlights.length || cs.quote);
  let n = 0;
  const storyN = hasStory ? ++n : 0;
  const resultsN = hasResults || charts.length ? ++n : 0;
  const closingN = hasClosing ? ++n : 0;
  const marks = <Marks p={p} />;
  // The crop marks sit under everything on each page and the footer is drawn last
  const footer = <Footer p={p} client={cs.client} />;

  return (
    <Document title={`${cs.client ? `${cs.client} case study` : "Case study"}${cs.title ? `: ${cs.title}` : ""}`} author="Kaizen Marketing" creator="Kaizen Marketing" producer="Kaizen Marketing" subject="Case study">
      <Page size="LETTER" style={page}>
        {marks}
        <Cover input={input} p={p} />
        {footer}
      </Page>

      {hasStory ? (
        <Page size="LETTER" style={page}>
          {marks}
          <SectionHead n={storyN} kicker="The story" title={cs.client ? `How ${cs.client} got here` : "How we got here"} p={p} />
          <Story cs={cs} p={p} />
          {footer}
        </Page>
      ) : null}

      {hasResults ? (
        <Page size="LETTER" style={page}>
          {marks}
          <SectionHead n={resultsN} kicker="The results" title="What changed" p={p} />
          <Stats cs={cs} p={p} />
          {(charts[0] ?? []).map((c, i) => (
            <Chart key={i} chart={c} p={p} />
          ))}
          {footer}
        </Page>
      ) : null}

      {charts.slice(hasResults ? 1 : 0).map((group, gi) => (
        <Page key={`c${gi}`} size="LETTER" style={page}>
          {marks}
          <SectionHead n={resultsN} kicker="The results" title="In the numbers" p={p} />
          {group.map((c, i) => (
            <Chart key={i} chart={c} p={p} />
          ))}
          {footer}
        </Page>
      ))}

      {hasClosing ? (
        <Page size="LETTER" style={page}>
          {marks}
          <SectionHead n={closingN} kicker={cs.highlights.length ? "Highlights" : "The client"} title={cs.highlights.length ? "What stood out" : "In their words"} p={p} />
          <Closing cs={cs} p={p} brand={input.brand} />
          {footer}
        </Page>
      ) : null}
    </Document>
  );
}
