import type { ReactNode } from "react";
import { Circle, Defs, Document, Image, LinearGradient, Page, Rect, Stop, StyleSheet, Svg, Text, View } from "@react-pdf/renderer";
import { docKit, lookFor, KAIZEN_RED, type Look, type WeeklyBrand } from "@/lib/reports/weekly-doc";
import type { Slide, Tone } from "./deck-core";

// The deck Kaizen AI makes (make_deck), in the look of the client reports: Kaizen's red and near-black lead, the client's
// colour is the second voice, Helvetica throughout. 16:9 pages (960 by 540 points), one slide each. Body text is never
// below 14 points: deck-core.ts cuts what would not fit instead of shrinking the type.

export type DeckInput = { title: string; subtitle: string; client: string | null; brand: WeeklyBrand | null; slides: Slide[] };

const W = 960;
const H = 540;
const PAD = 56;
const { Logo, INK, MUTED, LINE, GOOD, BAD } = docKit;
const WATCH = { fg: "#8a5a00", bg: "#fff1d6" };
const SURFACE = "#f4f6f9";
const TONE: Record<Tone, { fg: string; bg: string; label: string }> = { good: { ...GOOD, label: "Good" }, watch: { ...WATCH, label: "Watch" }, bad: { ...BAD, label: "Bad" } };

const s = StyleSheet.create({
  page: { fontFamily: "Helvetica", color: INK, backgroundColor: SURFACE, paddingTop: 44, paddingBottom: 66, paddingHorizontal: PAD },
  kicker: { fontSize: 14, fontFamily: "Helvetica-Bold", letterSpacing: 1.6, textTransform: "uppercase", marginBottom: 10 },
  h1: { fontSize: 32, fontFamily: "Helvetica-Bold", letterSpacing: -0.6, lineHeight: 1.12, marginBottom: 20 },
  body: { fontSize: 19, lineHeight: 1.35 },
  panel: { backgroundColor: "#ffffff", borderWidth: 1, borderColor: LINE, borderRadius: 14 },
  footer: { position: "absolute", bottom: 22, left: PAD, right: PAD, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  footText: { fontSize: 14 },
});

/** The page: its background, and a footer with Kaizen's mark, the deck's title and the page number */
function Frame({ dark, look, input, children }: { dark?: boolean; look: Look; input: DeckInput; children: ReactNode }) {
  const mute = dark ? "#c9ced6" : MUTED;
  return (
    // One slide is one page, always: anything that would run over is cut, never carried onto a page of its own
    <Page wrap={false} size={{ width: W, height: H }} style={[s.page, dark ? { backgroundColor: look.hero } : {}]}>
      {dark ? (
        <View fixed style={{ position: "absolute", top: 0, left: 0, width: W, height: H }}>
        <Svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
          <Defs>
            <LinearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor={look.hero} />
              <Stop offset="1" stopColor={look.heroEdge} />
            </LinearGradient>
          </Defs>
          <Rect x={0} y={0} width={W} height={H} fill="url(#bg)" />
          <Circle cx={W - 90} cy={110} r={250} fill="none" stroke="#ffffff" strokeOpacity={0.1} strokeWidth={1} />
          <Circle cx={W - 90} cy={110} r={310} fill="none" stroke="#ffffff" strokeOpacity={0.06} strokeWidth={46} />
          <Circle cx={W - 90} cy={110} r={400} fill="none" stroke="#ffffff" strokeOpacity={0.04} strokeWidth={46} />
        </Svg>
        </View>
      ) : (
        <View style={{ position: "absolute", top: 0, left: 0, width: W, height: 6, backgroundColor: look.primary }} />
      )}
      {children}
      <View style={s.footer} fixed>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          {input.brand?.agencyLogo ? <Logo src={input.brand.agencyLogo} chip="#ffffff" height={18} maxWidth={80} light={dark} /> : <Text style={{ fontSize: 16, fontFamily: "Helvetica-Bold", color: dark ? "#ffffff" : KAIZEN_RED }}>kaizen</Text>}
          <Text style={[s.footText, { color: mute }]}>{input.title}</Text>
        </View>
        <Text style={[s.footText, { color: mute }]} render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
      </View>
    </Page>
  );
}

const Head = ({ slide, look, input }: { slide: { title: string }; look: Look; input: DeckInput }) => (
  <View>
    <Text style={[s.kicker, { color: look.primary }]}>{input.client ?? "Kaizen"}</Text>
    {slide.title ? <Text style={s.h1}>{slide.title}</Text> : null}
  </View>
);

/** A bullet: a small round marker in the accent colour, then the line */
function Bullets({ items, size, color, gap = 12 }: { items: string[]; size: number; color: string; gap?: number }) {
  return (
    <View style={{ gap }}>
      {items.map((b, i) => (
        <View key={i} style={{ flexDirection: "row", gap: 12 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color, marginTop: size * 0.5 - 3 }} />
          <Text style={{ flex: 1, fontSize: size, lineHeight: 1.32 }}>{b}</Text>
        </View>
      ))}
    </View>
  );
}

function Masthead({ input, look }: { input: DeckInput; look: Look }) {
  const b = input.brand;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 18 }}>
      {b?.logo ? <Logo src={b.logo} light={b.light} chip={look.hero} height={38} maxWidth={170} /> : input.client ? <Text style={{ fontSize: 22, fontFamily: "Helvetica-Bold", color: "#ffffff" }}>{input.client}</Text> : null}
      {(b?.logo || input.client) && b?.agencyLogo ? <View style={{ width: 1, height: 30, backgroundColor: "#ffffff", opacity: 0.35 }} /> : null}
      {b?.agencyLogo ? (
        <View style={{ backgroundColor: "#ffffff", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 }}>
          {/* eslint-disable-next-line jsx-a11y/alt-text -- a PDF image, no alt prop */}
          <Image src={b.agencyLogo} style={{ height: 24, maxWidth: 110, objectFit: "contain" }} />
        </View>
      ) : null}
    </View>
  );
}

function SlideView({ slide, look, input, images }: { slide: Slide; look: Look; input: DeckInput; images: Map<string, string> }) {
  switch (slide.kind) {
    case "cover":
      return (
        <Frame dark look={look} input={input}>
          <View style={{ flex: 1, justifyContent: "space-between" }}>
            <Masthead input={input} look={look} />
            <View style={{ maxWidth: 700 }}>
              <Text style={[s.kicker, { color: look.heroSoft }]}>{input.client ? "Prepared for" : "Kaizen Marketing"}</Text>
              <Text style={{ fontSize: slide.title.length > 40 ? 40 : 48, fontFamily: "Helvetica-Bold", color: "#ffffff", lineHeight: 1.1, letterSpacing: -0.8 }}>{slide.title}</Text>
              {slide.text ? <Text style={{ fontSize: 22, color: "#dfe3e8", marginTop: 16, lineHeight: 1.35 }}>{slide.text}</Text> : null}
              {input.client ? <Text style={{ fontSize: 18, fontFamily: "Helvetica-Bold", color: look.heroSoft, marginTop: 22 }}>{input.client}</Text> : null}
            </View>
          </View>
        </Frame>
      );
    case "section":
      return (
        <Frame dark look={look} input={input}>
          <View style={{ flex: 1, justifyContent: "center", maxWidth: 720 }}>
            <View style={{ width: 56, height: 5, backgroundColor: look.primary, borderRadius: 3, marginBottom: 26 }} />
            <Text style={{ fontSize: 46, fontFamily: "Helvetica-Bold", color: "#ffffff", lineHeight: 1.1, letterSpacing: -0.8 }}>{slide.title}</Text>
            {slide.text ? <Text style={{ fontSize: 21, color: "#dfe3e8", marginTop: 16, lineHeight: 1.35 }}>{slide.text}</Text> : null}
          </View>
        </Frame>
      );
    case "bullets":
      return (
        <Frame look={look} input={input}>
          <Head slide={slide} look={look} input={input} />
          <View style={[s.panel, { padding: 22 }]}>
            <Bullets items={slide.bullets} size={slide.bullets.length > 4 ? 18 : slide.bullets.length > 3 ? 20 : 22} color={look.bars} gap={12} />
          </View>
        </Frame>
      );
    case "two_column":
      return (
        <Frame look={look} input={input}>
          <Head slide={slide} look={look} input={input} />
          <View style={{ flexDirection: "row", gap: 20 }}>
            {[slide.left, slide.right].map((c, i) => (
              <View key={i} style={[s.panel, { flex: 1, padding: 22, borderTopWidth: 4, borderTopColor: i === 0 ? look.bars : look.primary }]}>
                {c.heading ? <Text style={{ fontSize: 20, fontFamily: "Helvetica-Bold", marginBottom: 12 }}>{c.heading}</Text> : null}
                <Bullets items={c.bullets} size={17} color={i === 0 ? look.bars : look.primary} gap={10} />
              </View>
            ))}
          </View>
        </Frame>
      );
    case "stats":
      return (
        <Frame look={look} input={input}>
          <Head slide={slide} look={look} input={input} />
          <View style={{ flexDirection: "row", gap: 16 }}>
            {slide.stats.map((t, i) => (
              <View key={i} style={[s.panel, { flex: 1, padding: 22, borderTopWidth: 4, borderTopColor: look.bars }]}>
                <Text style={{ fontSize: t.value.length > 7 ? 30 : t.value.length > 5 ? 38 : 52, fontFamily: "Helvetica-Bold", letterSpacing: -1, color: look.barsText }}>{t.value}</Text>
                <Text style={{ fontSize: 17, fontFamily: "Helvetica-Bold", marginTop: 10, lineHeight: 1.25 }}>{t.label}</Text>
                {t.note ? <Text style={{ fontSize: 14, color: MUTED, marginTop: 8, lineHeight: 1.35 }}>{t.note}</Text> : null}
              </View>
            ))}
          </View>
          {slide.text ? <Text style={[s.body, { marginTop: 24, color: "#3d4b5c" }]}>{slide.text}</Text> : null}
        </Frame>
      );
    case "quote":
      return (
        <Frame dark look={look} input={input}>
          <View style={{ flex: 1, justifyContent: "center" }}>
            {slide.title ? <Text style={[s.kicker, { color: look.heroSoft }]}>{slide.title}</Text> : null}
            <View style={{ flexDirection: "row", gap: 24 }}>
              <View style={{ width: 5, backgroundColor: look.primary, borderRadius: 3 }} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: slide.text.length > 160 ? 28 : 34, fontFamily: "Helvetica-Bold", color: "#ffffff", lineHeight: 1.28, letterSpacing: -0.4 }}>{slide.text}</Text>
                {slide.by ? <Text style={{ fontSize: 18, color: look.heroSoft, marginTop: 20 }}>{slide.by}</Text> : null}
              </View>
            </View>
          </View>
        </Frame>
      );
    case "image_notes": {
      const pic = slide.image ? images.get(slide.image) : null;
      return (
        <Frame look={look} input={input}>
          <Head slide={slide} look={look} input={input} />
          <View style={{ flexDirection: "row", gap: 28 }}>
            <View style={{ width: 380 }}>
              <View style={[s.panel, { height: 290, padding: 8, alignItems: "center", justifyContent: "center", overflow: "hidden" }]}>
                {/* eslint-disable-next-line jsx-a11y/alt-text -- a PDF image, no alt prop */}
                {pic ? <Image src={pic} style={{ width: "100%", height: "100%", objectFit: "contain" }} /> : <Text style={{ fontSize: 14, color: MUTED }}>Picture not available</Text>}
              </View>
              {slide.caption ? <Text style={{ fontSize: 14, color: MUTED, marginTop: 8 }}>{slide.caption}</Text> : null}
            </View>
            <View style={{ flex: 1 }}>
              <Bullets items={slide.bullets} size={17} color={look.primary} gap={12} />
            </View>
          </View>
        </Frame>
      );
    }
    case "scorecard":
      return (
        <Frame look={look} input={input}>
          <Head slide={slide} look={look} input={input} />
          <View style={{ gap: 8 }}>
            {slide.rows.map((r, i) => {
              const t = TONE[r.tone];
              return (
                <View key={i} style={[s.panel, { flexDirection: "row", alignItems: "center", gap: 16, paddingVertical: 8, paddingHorizontal: 16, borderLeftWidth: 5, borderLeftColor: t.fg }]}>
                  <View style={{ width: 74, backgroundColor: t.bg, borderRadius: 6, paddingVertical: 4, alignItems: "center" }}>
                    <Text style={{ fontSize: 14, fontFamily: "Helvetica-Bold", color: t.fg }}>{t.label}</Text>
                  </View>
                  <Text style={{ width: 230, fontSize: 19, fontFamily: "Helvetica-Bold", lineHeight: 1.2 }}>{r.label}</Text>
                  <Text style={{ flex: 1, fontSize: 16, color: "#3d4b5c", lineHeight: 1.3 }}>{r.note}</Text>
                </View>
              );
            })}
          </View>
        </Frame>
      );
    case "table": {
      const size = slide.cells.length > 6 || slide.columns.length > 5 ? 14 : 16;
      return (
        <Frame look={look} input={input}>
          <Head slide={slide} look={look} input={input} />
          <View style={[s.panel, { overflow: "hidden" }]}>
            <View style={{ flexDirection: "row", backgroundColor: look.hero, paddingVertical: 9, paddingHorizontal: 14 }}>
              {slide.columns.map((c, i) => (
                <Text key={i} style={{ flex: i === 0 ? 1.6 : 1, fontSize: 14, fontFamily: "Helvetica-Bold", color: "#ffffff", textAlign: i === 0 ? "left" : "right" }}>{c}</Text>
              ))}
            </View>
            {slide.cells.map((row, ri) => (
              <View key={ri} style={{ flexDirection: "row", paddingVertical: 8, paddingHorizontal: 14, backgroundColor: ri % 2 ? SURFACE : "#ffffff", borderTopWidth: ri ? 1 : 0, borderTopColor: LINE }}>
                {row.map((cell, i) => (
                  <Text key={i} style={{ flex: i === 0 ? 1.6 : 1, fontSize: size, fontFamily: i === 0 ? "Helvetica-Bold" : "Helvetica", textAlign: i === 0 ? "left" : "right" }}>{cell}</Text>
                ))}
              </View>
            ))}
          </View>
          {slide.note ? <Text style={{ fontSize: 15, color: MUTED, marginTop: 14, lineHeight: 1.35 }}>{slide.note}</Text> : null}
        </Frame>
      );
    }
    case "bars": {
      const max = Math.max(...slide.bars.map((b) => Math.abs(b.value)), 0) || 1;
      const h = slide.bars.length > 5 ? 26 : 34;
      return (
        <Frame look={look} input={input}>
          <Head slide={slide} look={look} input={input} />
          <View style={[s.panel, { padding: 22, gap: slide.bars.length > 5 ? 10 : 14 }]}>
            {slide.bars.map((b, i) => {
              const color = b.tone ? TONE[b.tone].fg : i === 0 ? look.bars : look.primary;
              return (
                <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
                  <Text style={{ width: 190, fontSize: 16, fontFamily: "Helvetica-Bold" }}>{b.label}</Text>
                  <View style={{ flex: 1, height: h, backgroundColor: SURFACE, borderRadius: 6 }}>
                    <View style={{ width: `${Math.max(2, (Math.abs(b.value) / max) * 100)}%`, height: h, backgroundColor: color, borderRadius: 6 }} />
                  </View>
                  <Text style={{ width: 92, fontSize: 17, fontFamily: "Helvetica-Bold", textAlign: "right" }}>{b.display}</Text>
                </View>
              );
            })}
          </View>
          {slide.note ? <Text style={{ fontSize: 15, color: MUTED, marginTop: 14, lineHeight: 1.35 }}>{slide.note}</Text> : null}
        </Frame>
      );
    }
  }
}

/** The deck. images: the attached pictures the slides name, as data URIs, by the name the slide used */
export function DeckDocument({ input, images }: { input: DeckInput; images: Map<string, string> }) {
  const look = lookFor({ brand: input.brand, whiteLabel: false });
  return (
    <Document title={input.title} author="Kaizen Marketing" creator="Kaizen Marketing" producer="Kaizen Marketing">
      {input.slides.map((slide, i) => (
        <SlideView key={i} slide={slide} look={look} input={input} images={images} />
      ))}
    </Document>
  );
}
