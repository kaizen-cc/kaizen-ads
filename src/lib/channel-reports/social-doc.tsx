import { Fragment } from "react";
import { Circle, Defs, G, Image, Line, LinearGradient, Link, Path, Polyline, Rect, Stop, Svg, Text, View } from "@react-pdf/renderer";
import { docKit, type Look } from "@/lib/reports/weekly-doc";
import type { Sections } from "@/lib/reports/write";
import type { Move } from "@/lib/reports/weekly-core";
import { PLATFORM_LABEL, type SocialBand } from "@/lib/social-score";
import { int, moveOf, pct, priorWordOf, signed, socialName, type SocialMetrics, type SocialPostLite } from "./core";
import { columnKeys, tileViews, type ChannelLayout, type TileView } from "./layout";
import { againstBar, bestPostOf, captionText, engagementBarOf, followerChangeText, followersOf, FORMAT_WORD, mtdCells, pdfText, postKey, SCORE_BG, SCORE_HEX, SCORE_WORD, postFrame, socialInsights, trendRates, type Insight, type MtdCell, type ScoreReason } from "./social-report";

// The organic social report's pages, drawn under the shared masthead and hero (channel-doc.tsx), in the house style of
// the ads and email reports (weekly-doc.tsx's kit). Two full pages, laid out on purpose:
//   1. The headline: the social score with what lifts it and what weighs it down, the numbers at a glance (followers as
//      the net change, engagement against Kaizen's 5% target), the month to date as one row and the insight cards.
//   2. The detail: reach by week with the engagement rate over it, each platform as a card, and the best posts with
//      their pictures framed whole (social-pictures.ts).
// Every box has a fixed size and every text a line limit, so nothing overlaps whatever the numbers; each section is
// kept whole on a page. Captions and written words go through pdfText (no emoji the fonts can't draw).

const { s, Arrow, Hot, toneOf, INK, MUTED, FAINT, LINE, INNER, GOOD, BAD } = docKit;
const AMBER = { fg: "#a1650f", bg: "#fdf1dc" };
const GAP = 8;
const SLATE_BAR = "#cdd6e0";
const IG_HEX: [string, string] = ["#f58529", "#dd2a7b"];
const FB_HEX = "#1877f2";

type HotOf = (what: string) => string | null;
type Images = Record<string, string | null>;

const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const label = { fontSize: 6.3, color: "#5f6f82", fontFamily: "Helvetica-Bold" as const, textTransform: "uppercase" as const, letterSpacing: 0.7, maxLines: 1, textOverflow: "ellipsis" as const };
const fit = (text: string, width: number, max: number, min = 9) => Math.max(min, Math.min(max, Math.floor((width / (Math.max(1, text.length) * 0.58)) * 10) / 10));

const SvgTextRaw = Text as unknown as React.FC<{ x: number; y: number; fill?: string; textAnchor?: "start" | "middle" | "end"; style?: Record<string, unknown>; children: React.ReactNode }>;
function SvgText({ x, y, anchor = "middle", fill, size = 6.6, bold = true, children }: { x: number; y: number; anchor?: "start" | "middle" | "end"; fill: string; size?: number; bold?: boolean; children: React.ReactNode }) {
  return (
    <SvgTextRaw x={x} y={y} fill={fill} textAnchor={anchor} style={{ fontSize: size, fontFamily: bold ? "Helvetica-Bold" : "Helvetica" }}>
      {children}
    </SvgTextRaw>
  );
}

function Head({ title, sub }: { title: string; sub?: string }) {
  return (
    <View style={s.head}>
      <Text style={s.h2}>{title}</Text>
      {sub ? <Text style={[s.sub, { maxWidth: 320, textAlign: "right", maxLines: 1, textOverflow: "ellipsis" }]}>{sub}</Text> : null}
    </View>
  );
}

/** A move as a small chip: green when it's good for the client, red when it isn't */
function Chip({ mv, text }: { mv: Move; text?: string }) {
  if (!mv) return null;
  const c = toneOf(mv);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", height: 12, borderRadius: 3.5, paddingHorizontal: 4, backgroundColor: c.bg }}>
      <Arrow up={mv.up} color={c.fg} />
      <Text style={{ fontSize: 6.4, fontFamily: "Helvetica-Bold", color: c.fg, marginLeft: 2.5 }}>{text ?? mv.pct}</Text>
    </View>
  );
}

function Pill({ text, fg, bg, size = 6.6 }: { text: string; fg: string; bg: string; size?: number }) {
  return (
    <View style={{ height: size + 6, borderRadius: (size + 6) / 2, paddingHorizontal: 6, backgroundColor: bg, justifyContent: "center" }}>
      <Text style={{ fontSize: size, fontFamily: "Helvetica-Bold", color: fg }}>{text}</Text>
    </View>
  );
}

/** A platform's mark, drawn (no logos are fetched) */
function PlatformMark({ platform, size = 16 }: { platform: string; size?: number }) {
  if (platform === "instagram")
    return (
      <Svg width={size} height={size} viewBox="0 0 16 16">
        <Defs>
          <LinearGradient id="ig" x1="0" y1="1" x2="1" y2="0">
            <Stop offset="0" stopColor={IG_HEX[0]} />
            <Stop offset="1" stopColor={IG_HEX[1]} />
          </LinearGradient>
        </Defs>
        <Rect x={0} y={0} width={16} height={16} rx={4.5} fill="url(#ig)" />
        <Rect x={3.5} y={3.5} width={9} height={9} rx={2.8} fill="none" stroke="#ffffff" strokeWidth={1.3} />
        <Circle cx={8} cy={8} r={2.1} fill="none" stroke="#ffffff" strokeWidth={1.3} />
        <Circle cx={11.1} cy={4.9} r={0.7} fill="#ffffff" />
      </Svg>
    );
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16">
      <Circle cx={8} cy={8} r={8} fill={FB_HEX} />
      <Path d="M8.9 16V10.2h1.9l.3-2.2H8.9V6.6c0-.6.2-1.1 1.1-1.1h1.2V3.6c-.2 0-.9-.1-1.7-.1-1.7 0-2.9 1-2.9 2.9V8H4.7v2.2h1.9V16z" fill="#ffffff" />
    </Svg>
  );
}

const bandOf = (n: number): SocialBand => (n >= 80 ? "good" : n >= 60 ? "watch" : "bad");

// ─── 1. The social score ───────────────────────────────────────────────────

/** The score as a ring: the share of 100 drawn in its band's colour */
function Ring({ score, size = 78 }: { score: number; size?: number }) {
  const r = size / 2 - 6;
  const c = size / 2;
  const a = (Math.min(99.9, Math.max(0, score)) / 100) * Math.PI * 2;
  const x = c + r * Math.sin(a);
  const y = c - r * Math.cos(a);
  const hex = SCORE_HEX[bandOf(score)];
  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <Circle cx={c} cy={c} r={r} fill="none" stroke="#edf1f4" strokeWidth={7} />
        {score > 0 ? <Path d={`M ${c} ${c - r} A ${r} ${r} 0 ${a > Math.PI ? 1 : 0} 1 ${x} ${y}`} fill="none" stroke={hex} strokeWidth={7} strokeLinecap="round" /> : null}
      </Svg>
      <View style={{ position: "absolute", top: 0, left: 0, width: size, height: size, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ fontSize: 24, fontFamily: "Helvetica-Bold", color: hex, letterSpacing: -0.6, lineHeight: 1 }}>{score}</Text>
        <Text style={{ fontSize: 6, color: FAINT, marginTop: 2 }}>of 100</Text>
      </View>
    </View>
  );
}

function Reasons({ title, items, tone, width }: { title: string; items: ScoreReason[]; tone: "good" | "bad"; width: number }) {
  const hex = tone === "good" ? GOOD.fg : AMBER.fg;
  return (
    <View style={{ width }}>
      <Text style={[label, { color: hex, marginBottom: 6 }]}>{title}</Text>
      {items.length ? (
        items.slice(0, 3).map((r, i) => (
          <View key={i} style={{ flexDirection: "row", alignItems: "flex-start", marginBottom: 4.5 }}>
            <View style={{ width: 5, height: 5, borderRadius: 2.5, backgroundColor: hex, marginTop: 2.6, marginRight: 5 }} />
            <Text style={{ flex: 1, fontSize: 7.4, lineHeight: 1.3, color: "#33475b", maxLines: 2, textOverflow: "ellipsis" }}>{r.text}</Text>
          </View>
        ))
      ) : (
        <Text style={{ fontSize: 7.2, color: FAINT }}>{tone === "good" ? "Nothing at its bar yet" : "Every check is at its bar"}</Text>
      )}
    </View>
  );
}

const SCORE_H = 112;

function ScoreBand({ m }: { m: SocialMetrics }) {
  const sc = m.score;
  if (!sc) return null;
  const ringW = 150;
  const platW = sc.platforms.length > 1 ? 104 : 0;
  const rest = INNER - 2 - 28 - ringW - platW - (platW ? 14 : 0);
  return (
    <View style={s.section} wrap={false}>
      <View style={[s.panel, { flexDirection: "row", alignItems: "center", height: SCORE_H, paddingVertical: 12 }]}>
        <View style={{ width: ringW, flexDirection: "row", alignItems: "center" }}>
          <Ring score={sc.score} />
          <View style={{ marginLeft: 9, width: ringW - 87 }}>
            <Text style={label}>Social score</Text>
            <View style={{ marginTop: 5, alignSelf: "flex-start" }}>
              <Pill text={SCORE_WORD[sc.band]} fg={SCORE_HEX[sc.band]} bg={SCORE_BG[sc.band]} />
            </View>
            <Text style={{ fontSize: 5.8, color: MUTED, marginTop: 5, lineHeight: 1.3 }}>Last 30 days</Text>
          </View>
        </View>
        <View style={{ width: 1, alignSelf: "stretch", backgroundColor: "#edf1f4", marginHorizontal: 12 }} />
        <View style={{ flexDirection: "row", width: rest, gap: 12 }}>
          <Reasons title="What's lifting it" items={sc.lifting} tone="good" width={(rest - 12) / 2} />
          <Reasons title="What's weighing it down" items={sc.weighing} tone="bad" width={(rest - 12) / 2} />
        </View>
        {platW ? (
          <>
            <View style={{ width: 1, alignSelf: "stretch", backgroundColor: "#edf1f4", marginHorizontal: 7 }} />
            <View style={{ width: platW, gap: 7 }}>
              {sc.platforms.map((p) => (
                <View key={p.platform} style={{ flexDirection: "row", alignItems: "center", height: 26, borderRadius: 7, backgroundColor: "#f6f8fa", paddingHorizontal: 7 }}>
                  <PlatformMark platform={p.platform} size={13} />
                  <Text style={{ flex: 1, fontSize: 7.2, fontFamily: "Helvetica-Bold", marginLeft: 6 }}>{PLATFORM_LABEL[p.platform]}</Text>
                  <Text style={{ fontSize: 11, fontFamily: "Helvetica-Bold", color: SCORE_HEX[p.band] }}>{p.score}</Text>
                </View>
              ))}
              <Text style={{ fontSize: 5.6, color: FAINT, textAlign: "right" }}>Green 80+ · yellow 60 to 79</Text>
            </View>
          </>
        ) : null}
      </View>
    </View>
  );
}

// ─── 2. At a glance ────────────────────────────────────────────────────────

const TILE_H = 88;

function TileShell({ title, children, width, hot }: { title: string; children: React.ReactNode; width: number; hot: string | null }) {
  return (
    <View style={{ width, height: TILE_H, paddingHorizontal: 11, paddingVertical: 10 }}>
      <Text style={label}>{title}</Text>
      {children}
      <Hot href={hot} />
    </View>
  );
}

function BigValue({ value, width, color }: { value: string; width: number; color?: string }) {
  const size = fit(value, width, 21);
  return (
    <View style={{ height: 27, justifyContent: "center", marginTop: 3 }}>
      <Text style={{ fontSize: size, fontFamily: "Helvetica-Bold", letterSpacing: -0.5, color: color ?? INK, lineHeight: 1 }}>{value}</Text>
    </View>
  );
}

function Glance({ m, layout, hot }: { m: SocialMetrics; layout?: ChannelLayout | null; hot: HotOf }) {
  const tiles: TileView[] = tileViews(m, layout);
  const w = (INNER - 2 - (tiles.length - 1)) / Math.max(1, tiles.length);
  const inner = w - 22;
  const prior = priorWordOf(m.kind);
  const f = followersOf(m);
  const target = engagementBarOf(m);
  return (
    <View style={s.section} wrap={false}>
      <Head title="Performance at a glance" sub={`${m.main.label} against ${m.compare.label} · green = favorable, red = unfavorable`} />
      <View style={{ flexDirection: "row", backgroundColor: "#ffffff", borderWidth: 1, borderColor: LINE, borderRadius: 10, height: TILE_H }}>
        {tiles.map((t, i) => {
          const rule = i ? <View style={{ width: 1, backgroundColor: "#edf1f4", marginVertical: 11 }} /> : null;
          const at = hot(`tile/${i}`);
          if (t.key === "followers") {
            const mv: Move = f.change == null ? null : { pct: followerChangeText(f), up: f.change >= 0, tone: f.change > 0 ? "good" : f.change < 0 ? "bad" : "flat" };
            return (
              <Fragment key={t.key}>
                {rule}
                <TileShell title="Followers" width={w} hot={at}>
                  <BigValue value={int(f.total)} width={inner} />
                  <View style={{ flexDirection: "row", alignItems: "center", height: 13 }}>
                    {mv ? <Chip mv={mv} /> : <Text style={{ fontSize: 6.2, color: MUTED }}>No change read</Text>}
                    <Text style={{ fontSize: 6.2, color: MUTED, marginLeft: 4 }}>net this {prior}</Text>
                  </View>
                  <Text style={{ fontSize: 6, color: MUTED, marginTop: 3, maxLines: 1 }}>{f.prior != null ? `${int(f.prior)} at the end of last ${prior}` : "Across every linked account"}</Text>
                </TileShell>
              </Fragment>
            );
          }
          if (t.key === "rate") {
            const vs = againstBar(m.insightsRead ? m.now.rate : null, target);
            const hex = vs ? (vs.met ? GOOD.fg : BAD.fg) : INK;
            const fill = m.now.rate != null ? Math.min(1, m.now.rate / (target * 1.6)) : 0;
            const mark = 1 / 1.6;
            return (
              <Fragment key={t.key}>
                {rule}
                <TileShell title="Engagement rate" width={w} hot={at}>
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                    <BigValue value={m.insightsRead ? pct(m.now.rate) : "–"} width={inner - 40} color={hex} />
                    <Chip mv={moveOf(m.now.rate, m.before.rate)} />
                  </View>
                  <View style={{ height: 5, borderRadius: 2.5, backgroundColor: "#edf1f4", marginTop: 2 }}>
                    <View style={{ width: `${fill * 100}%`, height: 5, borderRadius: 2.5, backgroundColor: hex }} />
                    <View style={{ position: "absolute", left: `${mark * 100}%`, top: -2, width: 1.5, height: 9, backgroundColor: INK }} />
                  </View>
                  <Text style={{ fontSize: 6, color: MUTED, marginTop: 4, maxLines: 1 }}>{vs ? `${pct(target, 0)} target · ${vs.text}` : `${pct(target, 0)} target`}</Text>
                </TileShell>
              </Fragment>
            );
          }
          return (
            <Fragment key={t.key}>
              {rule}
              <TileShell title={t.label} width={w} hot={at}>
                <BigValue value={t.value} width={inner} />
                <View style={{ flexDirection: "row", alignItems: "center", height: 13 }}>
                  <Chip mv={t.move} />
                  <Text style={{ fontSize: 6.2, color: MUTED, marginLeft: t.move ? 4 : 0, maxLines: 1, textOverflow: "ellipsis", flexShrink: 1 }}>{t.before && t.before !== "–" ? `vs ${t.before} last ${prior}` : "No prior number"}</Text>
                </View>
                {t.sub ? <Text style={{ fontSize: 6, color: MUTED, marginTop: 3, maxLines: 1, textOverflow: "ellipsis" }}>{t.sub}</Text> : null}
              </TileShell>
            </Fragment>
          );
        })}
      </View>
    </View>
  );
}

// ─── 3. Month to date ──────────────────────────────────────────────────────

const MTD_H = 62;

function MonthToDate({ m }: { m: SocialMetrics }) {
  const x = m.mtd;
  const cells: MtdCell[] = mtdCells(m);
  if (!x || !cells.length) return null;
  const w = (INNER - 2 - (cells.length - 1)) / cells.length;
  return (
    <View style={s.section} wrap={false}>
      <Head title="Month to date" sub={`${x.window.label}, day ${x.elapsed} of ${x.daysInMonth} · against the same days last month`} />
      <View style={{ flexDirection: "row", backgroundColor: "#ffffff", borderWidth: 1, borderColor: LINE, borderRadius: 10, height: MTD_H }}>
        {cells.map((c, i) => (
          <Fragment key={c.key}>
            {i ? <View style={{ width: 1, backgroundColor: "#edf1f4", marginVertical: 10 }} /> : null}
            <View style={{ width: w, paddingHorizontal: 9, paddingVertical: 9 }}>
              <Text style={[label, { fontSize: 5.8 }]}>{c.label}</Text>
              <View style={{ flexDirection: "row", alignItems: "center", marginTop: 4, height: 15 }}>
                <Text style={{ fontSize: fit(c.value, w - 50, 13), fontFamily: "Helvetica-Bold", color: c.tone === "good" ? GOOD.fg : c.tone === "bad" ? BAD.fg : INK, letterSpacing: -0.3 }}>{c.value}</Text>
                {c.move && c.move.pct !== "0.0%" ? (
                  <View style={{ flexDirection: "row", alignItems: "center", marginLeft: 4 }}>
                    <Arrow up={c.move.up} color={toneOf(c.move).fg} />
                    <Text style={{ fontSize: 5.8, fontFamily: "Helvetica-Bold", color: toneOf(c.move).fg, marginLeft: 1.5 }}>{c.move.pct}</Text>
                  </View>
                ) : null}
              </View>
              <Text style={{ fontSize: 5.7, color: MUTED, marginTop: 3, maxLines: 1, textOverflow: "ellipsis" }}>{c.note ?? `was ${c.before}`}</Text>
            </View>
          </Fragment>
        ))}
      </View>
    </View>
  );
}

// ─── 4. Insight cards ──────────────────────────────────────────────────────

const INSIGHT_TONE: Record<Insight["tone"], string> = { good: GOOD.fg, bad: BAD.fg, neutral: "#4b6584" };

/**
 * The cards' grid and height: with a next line they fill the room (the line sits at the foot); without one (a report
 * written before the next lines) they're only as tall as their words.
 */
function insightGrid(items: Insight[], room: number) {
  const cols = items.length === 4 ? 2 : Math.max(1, items.length);
  const rows = Math.ceil(items.length / cols);
  const w = (INNER - GAP * (cols - 1)) / cols;
  const fill = (room - GAP * (rows - 1)) / rows;
  const words = (t: Insight) => {
    const perLine = Math.max(10, (w - 24) / (8.2 * 0.5));
    return 28 + Math.min(2, Math.ceil(t.title.length / ((w - 24) / 5.4))) * 12.5 + Math.ceil(t.text.length / perLine) * 11.9;
  };
  const next = items.some((t) => t.next);
  const h = next ? fill : Math.min(fill, Math.max(0, ...items.map(words)) + 8);
  return { cols, rows, w, h, next, total: items.length ? h * rows + GAP * (rows - 1) : 0 };
}

function Insights({ items, look, hot, room }: { items: Insight[]; look: Look; hot: HotOf; room: number }) {
  if (!items.length) return null;
  const { w, h, next } = insightGrid(items, room);
  const lines = next ? Math.max(2, Math.floor((h - 70) / 12)) : 12;
  return (
    <View style={s.section} wrap={false}>
      <Head title="Key takeaways" sub="What the numbers say, and what we'll do next" />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: GAP }}>
        {items.map((t, i) => (
          <View key={i} style={{ width: w, height: h, backgroundColor: "#ffffff", borderWidth: 1, borderColor: LINE, borderRadius: 10, paddingVertical: 11, paddingHorizontal: 12, borderTopWidth: 3, borderTopColor: t.tone === "neutral" ? look.primary : INSIGHT_TONE[t.tone] }}>
            <View>
              <Text style={{ fontSize: 10, fontFamily: "Helvetica-Bold", lineHeight: 1.25, maxLines: 2, textOverflow: "ellipsis" }}>{t.title}</Text>
              <Hot href={hot(`text/takeaway-${i}-title`)} />
            </View>
            <View style={{ marginTop: 4 }}>
              <Text style={{ fontSize: 8.2, color: "#5d7184", lineHeight: 1.45, maxLines: lines, textOverflow: "ellipsis" }}>{t.text}</Text>
              <Hot href={hot(`text/takeaway-${i}-text`)} />
            </View>
            {t.next ? (
              <View style={{ position: "absolute", left: 12, right: 12, bottom: 10, flexDirection: "row", alignItems: "flex-start", paddingTop: 6, borderTopWidth: 1, borderTopColor: "#edf1f4" }}>
                <Text style={{ fontSize: 6, fontFamily: "Helvetica-Bold", color: look.primary, textTransform: "uppercase", letterSpacing: 0.6, marginRight: 5, marginTop: 1 }}>Next</Text>
                <Text style={{ flex: 1, fontSize: 7.6, color: INK, lineHeight: 1.35, maxLines: 2, textOverflow: "ellipsis" }}>{t.next}</Text>
              </View>
            ) : null}
          </View>
        ))}
      </View>
    </View>
  );
}

// ─── 5. Reach by week, with engagement ─────────────────────────────────────

const CHART_H = 128;

function niceTop(max: number): number {
  if (max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  const n = max / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}
const short = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

/**
 * Eight weeks of reach as bars (this period's in the client's colour, the rest a quiet slate), and under them a strip with
 * each week's engagement rate against the target, so the two never fight for the same space.
 */
function Trend({ m, look }: { m: SocialMetrics; look: Look }) {
  const pts = m.trend;
  if (!pts.length || pts.every((p) => !p.value)) return null;
  const rates = trendRates(m);
  const target = engagementBarOf(m);
  const W = INNER - 28;
  const H = CHART_H;
  const left = 34;
  const right = 8;
  const top = 14;
  const base = 70;
  const plotW = W - left - right;
  const max = niceTop(Math.max(...pts.map((p) => p.value), 1));
  const slot = plotW / pts.length;
  const bar = Math.min(32, slot * 0.58);
  // The engagement strip: its own scale, the target always inside it
  const sTop = 96;
  const sBase = H - 6;
  const known = rates.filter((r): r is number => r != null);
  const lo = Math.max(0, Math.min(target, ...known) * 0.75);
  const hi = Math.max(target, ...known) * 1.12;
  const yR = (r: number) => sBase - ((r - lo) / Math.max(1e-6, hi - lo)) * (sBase - sTop);
  const cx = (i: number) => left + i * slot + slot / 2;
  const line = rates.map((r, i) => (r != null ? `${cx(i)},${yR(r)}` : null)).filter(Boolean).join(" ");
  const ty = yR(target);
  const thisWord = m.kind === "weekly" ? "This week" : null;
  return (
    <View style={s.section} wrap={false}>
      <View style={s.head}>
        <Text style={s.h2}>Reach by week</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: look.bars }} />
            <Text style={s.sub}>Reach</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <View style={{ width: 10, height: 2, backgroundColor: look.line }} />
            <Text style={s.sub}>Engagement rate</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Svg width={12} height={2}>
              <Line x1={0} y1={1} x2={12} y2={1} stroke={GOOD.fg} strokeWidth={1} strokeDasharray="2,1.5" />
            </Svg>
            <Text style={s.sub}>{pct(target, 0)} target</Text>
          </View>
        </View>
      </View>
      <View style={[s.panel, { paddingVertical: 10, paddingHorizontal: 14 }]}>
        <Svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
          {[0, 0.5, 1].map((f) => (
            <G key={f}>
              <Line x1={left} y1={base - f * (base - top)} x2={W - right} y2={base - f * (base - top)} stroke={f ? "#eef2f5" : LINE} strokeWidth={f ? 0.8 : 1} />
              <SvgText x={left - 5} y={base - f * (base - top) + 2.2} anchor="end" fill={FAINT} bold={false} size={6}>
                {short(max * f)}
              </SvgText>
            </G>
          ))}
          {pts.map((p, i) => {
            const h = (p.value / max) * (base - top);
            const x = cx(i) - bar / 2;
            const last = i === pts.length - 1;
            return (
              <G key={p.start}>
                <Rect x={x} y={base - h} width={bar} height={Math.max(h, 1)} rx={2.5} fill={last ? look.bars : SLATE_BAR} />
                <SvgText x={cx(i)} y={base - h - 4} anchor="middle" fill={last ? INK : "#4a5a6c"} size={last ? 7 : 6.4}>
                  {short(p.value)}
                </SvgText>
                <SvgText x={cx(i)} y={base + 11} anchor="middle" fill={last ? INK : MUTED} bold={last} size={6.4}>
                  {last && thisWord ? thisWord : p.label}
                </SvgText>
              </G>
            );
          })}
          <Rect x={left} y={sTop - 13} width={plotW} height={sBase - sTop + 19} rx={5} fill="#f7f9fb" />
          <SvgText x={left - 5} y={sTop - 4} anchor="end" fill={FAINT} bold={false} size={5.6}>
            Engage.
          </SvgText>
          <Line x1={left + 4} y1={ty} x2={W - right - 4} y2={ty} stroke={GOOD.fg} strokeWidth={0.8} strokeDasharray="3,2" />
          <SvgText x={left - 5} y={ty + 2} anchor="end" fill={GOOD.fg} size={5.8}>
            {pct(target, 0)}
          </SvgText>
          {line ? <Polyline points={line} fill="none" stroke={look.line} strokeWidth={1.5} /> : null}
          {rates.map((r, i) => {
            if (r == null) return null;
            const last = i === rates.length - 1;
            const y = yR(r);
            const met = r >= target;
            return (
              <G key={`r${i}`}>
                <Circle cx={cx(i)} cy={y} r={last ? 2.8 : 2} fill={last ? look.line : "#ffffff"} stroke={look.line} strokeWidth={1.3} />
                <SvgText x={cx(i)} y={Math.abs(y - 5 - ty) < 5 ? y + 9 : y - 5} anchor="middle" fill={met ? GOOD.fg : last ? INK : "#4a5a6c"} size={last ? 6.6 : 5.9}>
                  {pct(r, 1)}
                </SvgText>
              </G>
            );
          })}
        </Svg>
      </View>
    </View>
  );
}

// ─── 6. By platform ────────────────────────────────────────────────────────

type PlatformRow = SocialMetrics["platforms"][number];

function PlatformCell({ title, value, children, width, color, hot }: { title: string; value: string; children?: React.ReactNode; width: number; color?: string; hot?: string | null }) {
  return (
    <View style={{ width, height: 44, paddingRight: 6 }}>
      <Hot href={hot} />
      <Text style={[label, { fontSize: 5.6 }]}>{title}</Text>
      <Text style={{ fontSize: fit(value, width - 8, 13.5), fontFamily: "Helvetica-Bold", color: color ?? INK, marginTop: 3.5, letterSpacing: -0.3 }}>{value}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", height: 12, marginTop: 2.5 }}>{children}</View>
    </View>
  );
}

const PLATFORM_H = 196;

/**
 * One platform as a card: its handle and score, then the numbers the report's columns pick (followers with the net change,
 * reach, views, engagement against the target, posts; interactions always), what lifts and weighs on its score, and its
 * best post. Each picked number is the column's click target in the preview.
 */
function PlatformCard({ p, m, width, cols, keys, hot }: { p: PlatformRow; m: SocialMetrics; width: number; cols: number; keys: string[]; hot: HotOf }) {
  const target = engagementBarOf(m);
  const sc = m.score?.platforms.find((x) => x.platform === p.platform) ?? null;
  const vs = againstBar(m.insightsRead ? p.now.rate : null, target);
  const best = bestPostOf(m, p.platform);
  const cw = (width - 26) / cols;
  const col = (...ks: string[]) => {
    const i = keys.findIndex((k) => ks.includes(k));
    return i >= 0 ? hot(`col/${i}`) : null;
  };
  const picked = (...ks: string[]) => ks.some((k) => keys.includes(k));
  const all = [
    picked("followers", "change") && <PlatformCell key="f" title="Followers" value={int(p.now.followers)} width={cw} hot={col("followers", "change")}>
      {p.now.followerChange != null ? <Text style={{ fontSize: 6.4, fontFamily: "Helvetica-Bold", color: p.now.followerChange < 0 ? BAD.fg : p.now.followerChange > 0 ? GOOD.fg : MUTED }}>{signed(p.now.followerChange)} net</Text> : null}
    </PlatformCell>,
    picked("reach") && <PlatformCell key="r" title="Reach" value={int(p.now.reach)} width={cw} hot={col("reach")}>
      <Chip mv={moveOf(p.now.reach, p.before.reach)} />
    </PlatformCell>,
    picked("views") && <PlatformCell key="v" title="Views" value={int(p.now.views)} width={cw} hot={col("views")}>
      <Chip mv={moveOf(p.now.views, p.before.views)} />
    </PlatformCell>,
    picked("rate") && <PlatformCell key="e" title="Engagement" value={m.insightsRead ? pct(p.now.rate) : "–"} width={cw} color={vs ? (vs.met ? GOOD.fg : BAD.fg) : INK} hot={col("rate")}>
      <Text style={{ fontSize: 6.2, color: MUTED, maxLines: 1 }}>{vs ? `${pct(target, 0)} target · ${vs.text}` : `${pct(target, 0)} target`}</Text>
    </PlatformCell>,
    <PlatformCell key="i" title="Interactions" value={int(p.now.interactions)} width={cw}>
      <Chip mv={moveOf(p.now.interactions, p.before.interactions)} />
    </PlatformCell>,
    picked("posts") && <PlatformCell key="p" title="Posts" value={int(p.now.posts)} width={cw} hot={col("posts")}>
      <Text style={{ fontSize: 6.2, color: MUTED }}>{int(p.before.posts)} last {priorWordOf(m.kind)}</Text>
    </PlatformCell>,
  ];
  const cells = all.filter(Boolean);
  const reasons = sc ? [...sc.lifting.slice(0, 1).map((r) => ({ ...r, good: true })), ...sc.weighing.slice(0, 1).map((r) => ({ ...r, good: false }))] : [];
  return (
    <View style={{ width, height: sc ? PLATFORM_H : PLATFORM_H - 36, backgroundColor: "#ffffff", borderWidth: 1, borderColor: LINE, borderRadius: 10, padding: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <PlatformMark platform={p.platform} size={20} />
        <View style={{ flex: 1, marginLeft: 8 }}>
          <Text style={{ fontSize: 10, fontFamily: "Helvetica-Bold" }}>{socialName(p.platform)}</Text>
          <Text style={{ fontSize: 6.6, color: MUTED, marginTop: 1.5, maxLines: 1, textOverflow: "ellipsis" }}>{pdfText(p.name) || "Linked account"}</Text>
        </View>
        {sc ? (
          <View style={{ alignItems: "flex-end" }}>
            <View style={{ flexDirection: "row", alignItems: "flex-end" }}>
              <Text style={{ fontSize: 17, fontFamily: "Helvetica-Bold", color: SCORE_HEX[sc.band], lineHeight: 1 }}>{sc.score}</Text>
              <Text style={{ fontSize: 6, color: FAINT, marginLeft: 2, marginBottom: 1.5 }}>/100</Text>
            </View>
            <Text style={{ fontSize: 5.6, fontFamily: "Helvetica-Bold", color: SCORE_HEX[sc.band], marginTop: 2, textTransform: "uppercase", letterSpacing: 0.5 }}>Social score</Text>
          </View>
        ) : null}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 9, paddingTop: 8, borderTopWidth: 1, borderTopColor: "#edf1f4", rowGap: 2 }}>{cells}</View>
      <View style={{ position: "absolute", left: 12, right: 12, bottom: 11 }}>
        {reasons.map((r) => (
          <View key={r.key} style={{ flexDirection: "row", alignItems: "center", marginBottom: 3 }}>
            <View style={{ width: 4.5, height: 4.5, borderRadius: 2.25, backgroundColor: r.good ? GOOD.fg : AMBER.fg, marginRight: 5 }} />
            <Text style={{ flex: 1, fontSize: 6.6, color: "#33475b", maxLines: 1, textOverflow: "ellipsis" }}>{r.text}</Text>
          </View>
        ))}
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: 3, paddingTop: 6, borderTopWidth: 1, borderTopColor: "#edf1f4" }}>
          <Text style={{ fontSize: 5.8, fontFamily: "Helvetica-Bold", color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, marginRight: 5 }}>Best post</Text>
          <Text style={{ flex: 1, fontSize: 6.8, color: INK, maxLines: 1, textOverflow: "ellipsis" }}>{best ? `${captionText(best.caption, 44) || FORMAT_WORD[best.format] || best.format} · ${int(best.interactions)} interactions` : "No posts this period"}</Text>
        </View>
      </View>
    </View>
  );
}

function Platforms({ m, keys, hot }: { m: SocialMetrics; keys: string[]; hot: HotOf }) {
  if (!m.platforms.length) return null;
  const n = m.platforms.length;
  const w = n === 1 ? INNER : (INNER - GAP) / 2;
  return (
    <View style={s.section} wrap={false}>
      <Head title="By platform" sub={`${m.main.label} against ${m.compare.label}`} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: GAP }}>
        {m.platforms.map((p) => (
          <PlatformCard key={p.platform} p={p} m={m} width={w} cols={n === 1 ? 6 : 3} keys={keys} hot={hot} />
        ))}
      </View>
    </View>
  );
}

// ─── 7. Top posts ──────────────────────────────────────────────────────────

const POST_TALL_H = 254;
const POST_WIDE_H = 186;

function FormatBadge({ p }: { p: SocialPostLite }) {
  const word = FORMAT_WORD[p.format] ?? p.format;
  return (
    <View style={{ position: "absolute", top: 7, left: 7, height: 13, borderRadius: 6.5, paddingHorizontal: 6, backgroundColor: "#14202e", opacity: 0.82, justifyContent: "center" }}>
      <Text style={{ fontSize: 6, fontFamily: "Helvetica-Bold", color: "#ffffff", textTransform: "uppercase", letterSpacing: 0.5 }}>{word}</Text>
    </View>
  );
}

function Picture({ p, pic, width, height }: { p: SocialPostLite; pic: string | null | undefined; width: number; height: number }) {
  return (
    <View style={{ width, height, backgroundColor: "#eef2f5", overflow: "hidden" }}>
      {/* eslint-disable-next-line jsx-a11y/alt-text -- a PDF image, no alt prop */}
      {pic ? <Image src={pic} style={{ width, height, objectFit: "cover" }} /> : (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <PlatformMark platform={p.platform} size={22} />
          <Text style={{ fontSize: 6.6, color: FAINT, marginTop: 6 }}>No preview</Text>
        </View>
      )}
      <FormatBadge p={p} />
    </View>
  );
}

const plural = (n: number | null | undefined, one: string, many: string) => `${int(n)} ${n === 1 ? one : many}`;

/** The post's numbers as label-and-value rows, so long labels never crowd each other */
function PostStats({ p, target }: { p: SocialPostLite; target: number }) {
  const vs = p.rateBasis === "reach" ? againstBar(p.rate, target) : null;
  const row = (t: string, v: string, color?: string) => (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", height: 13 }}>
      <Text style={{ fontSize: 6.6, color: MUTED }}>{t}</Text>
      <Text style={{ fontSize: 8, fontFamily: "Helvetica-Bold", color: color ?? INK }}>{v}</Text>
    </View>
  );
  return (
    <View>
      {row("Interactions", int(p.interactions))}
      {row("Reach", int(p.reach))}
      {row(p.rateBasis === "followers" ? "Engagement (of followers)" : "Engagement", pct(p.rate), vs ? (vs.met ? GOOD.fg : BAD.fg) : INK)}
    </View>
  );
}

function PostMeta({ p }: { p: SocialPostLite }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      <PlatformMark platform={p.platform} size={9} />
      <Text style={{ fontSize: 6.4, color: MUTED, marginLeft: 4, maxLines: 1 }}>
        {socialName(p.platform)}
        {p.postedAt ? ` · ${day(p.postedAt.slice(0, 10))}` : ""}
      </Text>
    </View>
  );
}

function PostFoot({ p, look, max = 2 }: { p: SocialPostLite; look: Look; max?: number }) {
  const bits = [p.shares ? plural(p.shares, "share", "shares") : null, p.saves ? plural(p.saves, "save", "saves") : null, p.comments ? plural(p.comments, "comment", "comments") : null].filter(Boolean).slice(0, max);
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingTop: 6, borderTopWidth: 1, borderTopColor: "#edf1f4" }}>
      <Text style={{ fontSize: 6.2, color: MUTED, maxLines: 1, flex: 1 }}>{bits.join(" · ") || " "}</Text>
      {p.permalink ? (
        <Link src={p.permalink} style={{ fontSize: 6.8, color: look.primary, fontFamily: "Helvetica-Bold", textDecoration: "none", marginLeft: 6 }}>
          View post
        </Link>
      ) : null}
    </View>
  );
}

function Rank({ n, left }: { n: number; left: number }) {
  return (
    <View style={{ position: "absolute", top: 7, left, width: 17, height: 17, borderRadius: 8.5, backgroundColor: "#ffffff", alignItems: "center", justifyContent: "center" }}>
      <Text style={{ fontSize: 7.5, fontFamily: "Helvetica-Bold", color: INK }}>{n}</Text>
    </View>
  );
}

/** The post's numbers side by side, for a narrow card */
function PostCells({ p, target }: { p: SocialPostLite; target: number }) {
  const vs = p.rateBasis === "reach" ? againstBar(p.rate, target) : null;
  const cell = (t: string, v: string, color?: string) => (
    <View style={{ flex: 1 }}>
      <Text style={{ fontSize: 5.6, color: MUTED }}>{t}</Text>
      <Text style={{ fontSize: 9, fontFamily: "Helvetica-Bold", color: color ?? INK, marginTop: 1.5 }}>{v}</Text>
    </View>
  );
  return (
    <View style={{ flexDirection: "row", gap: 4 }}>
      {cell("Interactions", int(p.interactions))}
      {cell("Reach", int(p.reach))}
      {cell("Engagement", pct(p.rate), vs ? (vs.met ? GOOD.fg : BAD.fg) : INK)}
    </View>
  );
}

/**
 * What was published: the posts against the period before, the formats, and the interactions a post drew on average.
 * Drawn above the posts when two or fewer are shown (their cards are shorter), so page two ends full.
 */
function ContentMix({ m, look }: { m: SocialMetrics; look: Look }) {
  if (!m.postsTotal) return null;
  const total = m.formats.reduce((n, f) => n + f.count, 0) || 1;
  // The format whose posts engaged best (of the posts the report kept, all from the period)
  const byFormat = new Map<string, { reach: number; interactions: number }>();
  for (const p of m.posts) {
    if (!p.reach || p.interactions == null) continue;
    const x = byFormat.get(p.format) ?? { reach: 0, interactions: 0 };
    byFormat.set(p.format, { reach: x.reach + p.reach, interactions: x.interactions + p.interactions });
  }
  const best = [...byFormat.entries()].map(([format, x]) => ({ format, rate: x.interactions / x.reach })).sort((a, b) => b.rate - a.rate)[0] ?? null;
  const shades = [look.bars, "#4b6584", "#94a2b0", "#cdd6e0", "#e3e8ee"];
  return (
    <View style={s.section} wrap={false}>
      <Head title="What we published" sub={`${m.main.label} against ${m.compare.label}`} />
      <View style={[s.panel, { flexDirection: "row", alignItems: "center", height: 48, paddingVertical: 8 }]}>
        <View style={{ width: 110 }}>
          <Text style={label}>Posts</Text>
          <View style={{ flexDirection: "row", alignItems: "center", marginTop: 4 }}>
            <Text style={{ fontSize: 16, fontFamily: "Helvetica-Bold", letterSpacing: -0.3 }}>{int(m.now.posts)}</Text>
            <Text style={{ fontSize: 6.4, color: MUTED, marginLeft: 6 }}>{int(m.before.posts)} last {priorWordOf(m.kind)}</Text>
          </View>
        </View>
        <View style={{ width: 1, alignSelf: "stretch", backgroundColor: "#edf1f4", marginHorizontal: 12 }} />
        <View style={{ flex: 1 }}>
          <Text style={label}>Formats</Text>
          <View style={{ flexDirection: "row", height: 6, borderRadius: 3, overflow: "hidden", marginTop: 6, backgroundColor: "#edf1f4" }}>
            {m.formats.map((f, i) => (
              <View key={f.format} style={{ width: `${(f.count / total) * 100}%`, backgroundColor: shades[i % shades.length] }} />
            ))}
          </View>
          <View style={{ flexDirection: "row", gap: 10, marginTop: 5 }}>
            {m.formats.slice(0, 5).map((f, i) => (
              <View key={f.format} style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                <View style={{ width: 6, height: 6, borderRadius: 1.5, backgroundColor: shades[i % shades.length] }} />
                <Text style={{ fontSize: 6.6, color: INK }}>
                  {FORMAT_WORD[f.format] ?? f.format} {f.count}
                </Text>
              </View>
            ))}
          </View>
        </View>
        <View style={{ width: 1, alignSelf: "stretch", backgroundColor: "#edf1f4", marginHorizontal: 12 }} />
        <View style={{ width: 120 }}>
          <Text style={label}>Best format</Text>
          <View style={{ flexDirection: "row", alignItems: "center", marginTop: 4 }}>
            <Text style={{ fontSize: 13, fontFamily: "Helvetica-Bold", letterSpacing: -0.3 }}>{best ? (FORMAT_WORD[best.format] ?? best.format) : "–"}</Text>
            {best ? <Text style={{ fontSize: 6.6, color: best.rate >= engagementBarOf(m) ? GOOD.fg : MUTED, marginLeft: 6, fontFamily: "Helvetica-Bold" }}>{pct(best.rate)} engaged</Text> : null}
          </View>
        </View>
      </View>
    </View>
  );
}

const noCaption = (p: SocialPostLite) => `${FORMAT_WORD[p.format] ?? p.format} with no caption`;

function TopPosts({ m, images, look }: { m: SocialMetrics; images: Images; look: Look }) {
  const top = m.posts.slice(0, 3);
  if (!top.length) return null;
  const target = engagementBarOf(m);
  const sub = `${m.postsTotal} published · best by engagement`;
  if (top.length === 3) {
    const w = (INNER - GAP * 2) / 3;
    const frame = postFrame(3);
    const ph = Math.round(((w - 2) * frame.h) / frame.w);
    return (
      <View style={[s.section, { marginBottom: 10 }]} wrap={false}>
        <Head title="Top posts" sub={sub} />
        <View style={{ flexDirection: "row", gap: GAP }}>
          {top.map((p, i) => (
            <View key={postKey(p)} style={{ width: w, height: POST_TALL_H, backgroundColor: "#ffffff", borderWidth: 1, borderColor: LINE, borderRadius: 10, overflow: "hidden" }}>
              <Picture p={p} pic={images[postKey(p)]} width={w - 2} height={ph} />
              <Rank n={i + 1} left={w - 26} />
              <View style={{ paddingHorizontal: 10, paddingTop: 7 }}>
                <PostMeta p={p} />
                <Text style={{ fontSize: 7, lineHeight: 1.35, color: "#33475b", marginTop: 4, height: 19, maxLines: 2, textOverflow: "ellipsis" }}>{captionText(p.caption, 62) || noCaption(p)}</Text>
                <View style={{ marginTop: 5 }}>
                  <PostCells p={p} target={target} />
                </View>
              </View>
              <View style={{ position: "absolute", left: 10, right: 10, bottom: 7 }}>
                <PostFoot p={p} look={look} />
              </View>
            </View>
          ))}
        </View>
      </View>
    );
  }
  const w = top.length === 1 ? INNER : (INNER - GAP) / 2;
  const pw = Math.round(((POST_WIDE_H - 2) * 4) / 5);
  return (
    <View style={[s.section, { marginBottom: 10 }]} wrap={false}>
      <Head title="Top posts" sub={sub} />
      <View style={{ flexDirection: "row", gap: GAP }}>
        {top.map((p, i) => (
          <View key={postKey(p)} style={{ width: w, height: POST_WIDE_H, flexDirection: "row", backgroundColor: "#ffffff", borderWidth: 1, borderColor: LINE, borderRadius: 10, overflow: "hidden" }}>
            <Picture p={p} pic={images[postKey(p)]} width={pw} height={POST_WIDE_H - 2} />
            <Rank n={i + 1} left={pw - 24} />
            <View style={{ flex: 1, padding: 11 }}>
              <PostMeta p={p} />
              <Text style={{ fontSize: 7.3, lineHeight: 1.38, color: "#33475b", marginTop: 6, height: 61, maxLines: 6, textOverflow: "ellipsis" }}>{captionText(p.caption, top.length === 1 ? 300 : 150) || noCaption(p)}</Text>
              <View style={{ position: "absolute", left: 11, right: 11, bottom: 10 }}>
                <PostStats p={p} target={target} />
                <View style={{ marginTop: 5 }}>
                  <PostFoot p={p} look={look} max={1} />
                </View>
              </View>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

// ─── The pages ─────────────────────────────────────────────────────────────

/** The page's height under the padding, and what page one already holds above the body (the masthead and the hero) */
const PAGE_H = 841.89 - 24 - 56;
const ABOVE = 44 + 128 + 20;
const HEAD = 22;
const SECTION = 18;

/**
 * The social report's body under the masthead and hero. Page one is the headline (score, glance, month to date and the
 * takeaways sized to fill what's left); page two the detail (the chart, the platforms, the posts).
 */
export function SocialBody({ m, images, look, layout, hot, sections }: { m: SocialMetrics; images: Images; look: Look; layout?: ChannelLayout | null; hot: HotOf; sections: Sections }) {
  const used = ABOVE + (m.score ? SCORE_H + SECTION : 0) + HEAD + TILE_H + SECTION + (m.mtd && mtdCells(m).length ? HEAD + MTD_H + SECTION : 0) + HEAD + 2;
  // The takeaways fill page one (never smaller than a readable card, never taller than they need)
  const room = PAGE_H - used - 20;
  const insights = Math.max(150, Math.min(260, room));
  const items = socialInsights(m, sections);
  // When the cards leave room enough for the chart (a report from before the score and the next lines), it joins page one
  const left = room - (items.length ? insightGrid(items, insights).total + SECTION : -HEAD);
  const chartFirst = left >= HEAD + CHART_H + 22;
  return (
    <>
      <ScoreBand m={m} />
      <Glance m={m} layout={layout} hot={hot} />
      <MonthToDate m={m} />
      <Insights items={items} look={look} hot={hot} room={insights} />
      {chartFirst ? <Trend m={m} look={look} /> : null}
      <View break />
      {chartFirst ? null : <Trend m={m} look={look} />}
      <Platforms m={m} keys={columnKeys("social", layout)} hot={hot} />
      {m.posts.length < 3 ? <ContentMix m={m} look={look} /> : null}
      <TopPosts m={m} images={images} look={look} />
    </>
  );
}
