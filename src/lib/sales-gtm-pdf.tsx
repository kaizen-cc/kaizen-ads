import { Document, Font, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import type { GtmContent, Stat, Table } from "./sales-gtm-core";

// The go-to-market strategy as a client-facing PDF, in the gold-standard structure: a dark cover, then one page per
// section (01 to 09) with the short name and "Confidential · Prepared for" up top and who prepared it at the foot.
// Kaizen's look by default (near-black, Kaizen red, light gray cards, table headers with a red rule); a white-label
// partner's colors and name instead, with nothing of Kaizen's anywhere.

Font.registerHyphenationCallback((word) => [word]);

export type GtmBrand = { preparedBy: string; dark: string; accent: string; accentSoft: string; highlight: string; ink: string; muted: string };

export const KAIZEN_BRAND: GtmBrand = { preparedBy: "Kaizen Marketing", dark: "#060606", accent: "#B21E2C", accentSoft: "#F2F2F2", highlight: "#E0505C", ink: "#060606", muted: "#5B5B63" };

export function brandFor(partner: { prepared_by: string; brand: Record<string, string> } | null): GtmBrand {
  if (!partner) return KAIZEN_BRAND;
  const b = partner.brand ?? {};
  return { preparedBy: partner.prepared_by, dark: b.dark ?? "#0F1F2E", accent: b.accent ?? "#178F92", accentSoft: b.accent_soft ?? "#EEF5F5", highlight: b.highlight ?? b.accent ?? "#5CCFD6", ink: b.ink ?? "#0F1F2E", muted: b.muted ?? "#5B6470" };
}

const SOFT = "#F2F3F5";
const LINE = "#E3E5E8";

function styles(b: GtmBrand) {
  return StyleSheet.create({
    page: { fontFamily: "Helvetica", fontSize: 9.6, color: b.ink, paddingTop: 54, paddingBottom: 56, paddingHorizontal: 50, backgroundColor: "#FFFFFF" },
    head: { position: "absolute", top: 22, left: 50, right: 50, flexDirection: "row", justifyContent: "space-between", fontSize: 7, color: b.muted, letterSpacing: 0.6, textTransform: "uppercase", borderBottomWidth: 0.6, borderBottomColor: LINE, paddingBottom: 6 },
    foot: { position: "absolute", bottom: 24, left: 50, right: 50, flexDirection: "row", justifyContent: "space-between", fontSize: 7.5, color: b.muted, borderTopWidth: 0.6, borderTopColor: LINE, paddingTop: 7 },
    num: { fontSize: 8, color: b.accent, fontFamily: "Helvetica-Bold", letterSpacing: 1, textTransform: "uppercase", marginBottom: 6 },
    h1: { fontSize: 22, fontFamily: "Helvetica-Bold", letterSpacing: -0.5, marginBottom: 8, lineHeight: 1.15 },
    lede: { fontSize: 11, color: "#33363C", lineHeight: 1.5, marginBottom: 14 },
    h3: { fontSize: 11.5, fontFamily: "Helvetica-Bold", marginTop: 12, marginBottom: 6 },
    p: { fontSize: 9.6, lineHeight: 1.55, color: "#2B2E33", marginBottom: 6 },
    li: { flexDirection: "row", marginBottom: 5 },
    dot: { width: 12, color: b.accent, fontFamily: "Helvetica-Bold" },
    liText: { flex: 1, fontSize: 9.6, lineHeight: 1.5, color: "#2B2E33" },
    bold: { fontFamily: "Helvetica-Bold", color: b.ink },
    stats: { flexDirection: "row", marginBottom: 14, marginTop: 2 },
    stat: { flex: 1, backgroundColor: SOFT, borderTopWidth: 3, borderTopColor: b.accent, padding: 11, marginRight: 8 },
    statLast: { flex: 1, backgroundColor: SOFT, borderTopWidth: 3, borderTopColor: b.accent, padding: 11 },
    statValue: { fontSize: 20, fontFamily: "Helvetica-Bold", color: b.accent, marginBottom: 4 },
    statLabel: { fontSize: 8.2, lineHeight: 1.4, color: "#33363C" },
    table: { marginTop: 4, marginBottom: 8 },
    th: { flexDirection: "row", borderBottomWidth: 1.4, borderBottomColor: b.accent, paddingBottom: 5 },
    thCell: { flex: 1, fontSize: 8, color: b.accent, fontFamily: "Helvetica-Bold", paddingRight: 6 },
    tr: { flexDirection: "row", borderBottomWidth: 0.6, borderBottomColor: LINE, paddingVertical: 6 },
    trAlt: { flexDirection: "row", borderBottomWidth: 0.6, borderBottomColor: LINE, paddingVertical: 6, backgroundColor: "#F7F8F9" },
    cell: { flex: 1, fontSize: 8.4, lineHeight: 1.42, color: "#2B2E33", paddingRight: 6 },
    cellFirst: { flex: 1, fontSize: 8.4, lineHeight: 1.42, color: b.ink, fontFamily: "Helvetica-Bold", paddingRight: 6 },
    note: { fontSize: 7.4, color: b.muted, lineHeight: 1.4, marginTop: 2, marginBottom: 8 },
    callout: { backgroundColor: b.accentSoft, borderLeftWidth: 3, borderLeftColor: b.accent, padding: 12, marginTop: 10, marginBottom: 6 },
    calloutTitle: { fontSize: 10.5, color: b.accent, fontFamily: "Helvetica-Bold", marginBottom: 4 },
    two: { flexDirection: "row", marginTop: 10 },
    card: { flex: 1, backgroundColor: SOFT, padding: 12, marginRight: 10 },
    cardLast: { flex: 1, backgroundColor: SOFT, padding: 12 },
    cardTitle: { fontSize: 10.5, fontFamily: "Helvetica-Bold", marginBottom: 5 },
    cover: { backgroundColor: b.dark, color: "#FFFFFF", paddingHorizontal: 56, paddingTop: 110, paddingBottom: 56, justifyContent: "space-between" },
    coverEyebrow: { fontSize: 8.5, letterSpacing: 1.2, color: "#C2C7CE", textTransform: "uppercase" },
    coverRule: { width: 36, height: 3, backgroundColor: b.accent, marginTop: 12, marginBottom: 40 },
    coverHead: { fontSize: 32, fontFamily: "Helvetica-Bold", lineHeight: 1.15, letterSpacing: -0.6 },
    coverHi: { fontSize: 32, fontFamily: "Helvetica-Bold", lineHeight: 1.15, letterSpacing: -0.6, color: b.highlight },
    coverSub: { fontSize: 12, color: "#C2C7CE", marginTop: 18 },
    coverMetaRow: { flexDirection: "row", borderTopWidth: 0.6, borderTopColor: "#3A4049", paddingTop: 18 },
    coverLabel: { fontSize: 7.2, color: "#9CA3AD", letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 4 },
    coverValue: { fontSize: 11.5, color: "#FFFFFF" },
    coverSmall: { fontSize: 8.5, color: "#C2C7CE", marginTop: 3 },
  });
}

type S = ReturnType<typeof styles>;

function Stats({ s, items }: { s: S; items: Stat[] }) {
  if (!items.length) return null;
  return (
    <View style={s.stats}>
      {items.map((x, i) => (
        <View key={i} style={i === items.length - 1 ? s.statLast : s.stat}>
          <Text style={s.statValue}>{x.value}</Text>
          <Text style={s.statLabel}>{x.label}</Text>
        </View>
      ))}
    </View>
  );
}

function T({ s, t, widths }: { s: S; t: Table; widths?: number[] }) {
  if (!t.rows.length) return null;
  const w = (i: number) => (widths?.[i] ? { flex: widths[i] } : {});
  return (
    <View style={s.table}>
      {t.head.length > 0 && (
        <View style={s.th} fixed={false}>
          {t.head.map((h, i) => (
            <Text key={i} style={[s.thCell, w(i)]}>
              {h}
            </Text>
          ))}
        </View>
      )}
      {t.rows.map((r, ri) => (
        <View key={ri} style={ri % 2 ? s.trAlt : s.tr} wrap={false}>
          {r.map((c, ci) => (
            <Text key={ci} style={[ci === 0 ? s.cellFirst : s.cell, w(ci)]}>
              {c}
            </Text>
          ))}
        </View>
      ))}
      {t.note ? <Text style={s.note}>{t.note}</Text> : null}
    </View>
  );
}

function Bullets({ s, items }: { s: S; items: { lead?: string; text: string }[] }) {
  return (
    <View>
      {items.map((x, i) => (
        <View key={i} style={s.li}>
          <Text style={s.dot}>•</Text>
          <Text style={s.liText}>
            {x.lead ? <Text style={s.bold}>{x.lead}: </Text> : null}
            {x.text}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Callout({ s, title, text }: { s: S; title: string; text: string }) {
  if (!text) return null;
  return (
    <View style={s.callout} wrap={false}>
      <Text style={s.calloutTitle}>{title}</Text>
      <Text style={s.p}>{text}</Text>
    </View>
  );
}

function Section({ s, b, short, prepFor, n, eyebrow, title, lede, children }: { s: S; b: GtmBrand; short: string; prepFor: string; n: string; eyebrow: string; title: string; lede?: string; children: React.ReactNode }) {
  return (
    <Page size="LETTER" style={s.page}>
      <View style={s.head} fixed>
        <Text>{short} · Go-to-market strategy</Text>
        <Text>Confidential · Prepared for {prepFor}</Text>
      </View>
      <Text style={s.num}>
        {n} · {eyebrow}
      </Text>
      <Text style={s.h1}>{title}</Text>
      {lede ? <Text style={s.lede}>{lede}</Text> : null}
      {children}
      <View style={s.foot} fixed>
        <Text>{b.preparedBy}</Text>
        <Text render={({ pageNumber }) => `${pageNumber}`} />
      </View>
    </Page>
  );
}

export function GtmDoc({ c, brand, prospect }: { c: GtmContent; brand: GtmBrand; prospect: { name: string; short: string } }) {
  const s = styles(brand);
  const sec = { s, b: brand, short: prospect.short, prepFor: prospect.name };
  return (
    <Document title={`${prospect.name} · Go-to-market strategy`} author={brand.preparedBy} creator={brand.preparedBy} producer={brand.preparedBy}>
      <Page size="LETTER" style={s.cover}>
        <View>
          <Text style={s.coverEyebrow}>{c.cover.eyebrow}</Text>
          <View style={s.coverRule} />
          <Text style={s.coverHead}>{c.cover.headline}</Text>
          {c.cover.highlight ? <Text style={s.coverHi}>{c.cover.highlight}</Text> : null}
          {c.cover.subtitle ? <Text style={s.coverSub}>{c.cover.subtitle}</Text> : null}
        </View>
        <View>
          <View style={s.coverMetaRow}>
            <View style={{ flex: 1 }}>
              <Text style={s.coverLabel}>Prepared for</Text>
              <Text style={s.coverValue}>{prospect.name}</Text>
              <Text style={s.coverSmall}>{[c.cover.location, c.cover.site].filter(Boolean).join(" · ")}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.coverLabel}>Date</Text>
              <Text style={s.coverValue}>{c.cover.date}</Text>
            </View>
          </View>
          <View style={{ marginTop: 22 }}>
            <Text style={s.coverLabel}>Prepared by</Text>
            <Text style={s.coverValue}>{brand.preparedBy}</Text>
          </View>
        </View>
      </Page>

      <Section {...sec} n="01" eyebrow="Executive summary" title="The short version" lede={c.exec.lede}>
        <Stats s={s} items={c.exec.stats} />
        <Text style={s.h3}>The opportunity</Text>
        <Text style={s.p}>{c.exec.opportunity}</Text>
        <Text style={s.h3}>What we recommend</Text>
        <Bullets s={s} items={c.exec.recommend} />
        <Callout s={s} title="Why now" text={c.exec.why_now} />
      </Section>

      <Section {...sec} n="02" eyebrow={`Who ${prospect.short} is`} title={c.who.title || `Who ${prospect.short} is`} lede={c.who.lede}>
        <T s={s} t={c.who.table} />
        {c.who.sources ? <Text style={s.note}>Sources: {c.who.sources}</Text> : null}
      </Section>

      <Section {...sec} n="03" eyebrow="Digital footprint" title={c.footprint.title || "Where the pipeline is leaking today"} lede={c.footprint.lede}>
        <T s={s} t={c.footprint.table} widths={[0.8, 1.4, 1.6]} />
        <Callout s={s} title="The bottom line" text={c.footprint.bottom_line} />
      </Section>

      <Section {...sec} n="04" eyebrow="The market" title={c.market.title || "The market"} lede={c.market.lede}>
        <Stats s={s} items={c.market.stats} />
        {c.market.avatar ? (
          <>
            <Text style={s.h3}>Who&apos;s buying</Text>
            <Text style={s.p}>{c.market.avatar}</Text>
          </>
        ) : null}
        {c.market.tam ? <Text style={s.p}>{c.market.tam}</Text> : null}
        {c.market.implications.length > 0 && (
          <>
            <Text style={s.h3}>What this means for {prospect.short}</Text>
            <Bullets s={s} items={c.market.implications} />
          </>
        )}
        {c.market.competitors.rows.length > 0 && (
          <>
            <Text style={s.h3}>The competitive landscape</Text>
            <T s={s} t={c.market.competitors} />
          </>
        )}
        {c.market.trends.rows.length > 0 && (
          <>
            <Text style={s.h3}>Search demand and trends</Text>
            <T s={s} t={c.market.trends} />
          </>
        )}
        {c.market.sources ? <Text style={s.note}>Sources: {c.market.sources}</Text> : null}
      </Section>

      <Section {...sec} n="05" eyebrow="Positioning & offer" title={c.positioning.title || "Positioning & offer"} lede={c.positioning.lede}>
        <T s={s} t={c.positioning.services} widths={[1.4, 1.2, 0.8, 0.8, 1.1]} />
        <Callout s={s} title="Core positioning" text={c.positioning.core} />
        <View style={s.two} wrap={false}>
          <View style={s.card}>
            <Text style={s.cardTitle}>The front-door offer</Text>
            <Text style={[s.p, s.bold]}>{c.positioning.offer.name}</Text>
            <Text style={s.p}>{c.positioning.offer.text}</Text>
            {c.positioning.offer.why ? <Text style={s.p}>Why it works: {c.positioning.offer.why}</Text> : null}
          </View>
          <View style={s.cardLast}>
            <Text style={s.cardTitle}>Messaging pillars</Text>
            {c.positioning.pillars.map((x, i) => (
              <Text key={i} style={s.p}>
                <Text style={s.bold}>
                  {i + 1}. {x.lead}:{" "}
                </Text>
                {x.text}
              </Text>
            ))}
          </View>
        </View>
      </Section>

      <Section {...sec} n="06" eyebrow="Channel plan" title={c.channels.title || "How the channels work together"} lede={c.channels.lede}>
        {c.channels.google.rows.length > 0 && (
          <>
            <Text style={s.h3}>Google Ads: capture intent</Text>
            <T s={s} t={c.channels.google} widths={[1, 2, 1]} />
            {c.channels.google_note ? <Text style={s.note}>{c.channels.google_note}</Text> : null}
          </>
        )}
        {c.channels.meta.rows.length > 0 && (
          <>
            <Text style={s.h3}>Meta (Facebook + Instagram): create demand</Text>
            <T s={s} t={c.channels.meta} widths={[0.9, 1.8, 1.4]} />
          </>
        )}
        <Callout s={s} title={c.channels.creative.title} text={c.channels.creative.text} />
      </Section>

      <Section {...sec} n="07" eyebrow="Investment & projections" title={c.investment.title || "Recommended investment"} lede={c.investment.lede}>
        <T s={s} t={c.investment.tiers} />
        {c.investment.assumptions ? <Text style={s.note}>{c.investment.assumptions}</Text> : null}
        {c.investment.benchmarks.rows.length > 0 && (
          <>
            <Text style={s.h3}>Industry benchmarks</Text>
            <T s={s} t={c.investment.benchmarks} />
            {c.investment.benchmarks_note ? <Text style={s.note}>{c.investment.benchmarks_note}</Text> : null}
          </>
        )}
        <Callout s={s} title="The math that matters" text={c.investment.math} />
      </Section>

      <Section {...sec} n="08" eyebrow="90-day launch plan" title={c.plan.title || `What happens after ${prospect.short} says yes`}>
        <T s={s} t={c.plan.ninety} widths={[0.8, 2.2, 1.4]} />
        {c.plan.calendar.rows.length > 0 && (
          <>
            <Text style={s.h3}>The 12-month calendar</Text>
            <T s={s} t={c.plan.calendar} widths={[0.8, 1.3, 2]} />
          </>
        )}
      </Section>

      <Section {...sec} n="09" eyebrow="Measurement & next steps" title={c.measure.title || "How we'll judge success"}>
        <T s={s} t={c.measure.table} widths={[0.6, 1.5, 1.8]} />
        {c.measure.note ? <Text style={s.note}>{c.measure.note}</Text> : null}
        <View style={s.two} wrap={false}>
          <View style={s.card}>
            <Text style={s.cardTitle}>What we need from {prospect.short}</Text>
            {c.measure.needs.map((x, i) => (
              <Text key={i} style={s.p}>
                • {x}
              </Text>
            ))}
          </View>
          <View style={[s.cardLast, { backgroundColor: brand.accentSoft }]}>
            <Text style={s.cardTitle}>Next steps</Text>
            {c.measure.next.map((x, i) => (
              <Text key={i} style={s.p}>
                <Text style={s.bold}>
                  {i + 1}. {x.lead}
                </Text>
                {x.lead ? ": " : ""}
                {x.text}
              </Text>
            ))}
          </View>
        </View>
        <Callout s={s} title="The opportunity in one line" text={c.measure.one_line} />
        {c.sources.length > 0 && (
          <View style={{ marginTop: 10 }}>
            <Text style={[s.note, s.bold]}>Sources</Text>
            {c.sources.map((x, i) => (
              <Text key={i} style={s.note}>
                {x}
              </Text>
            ))}
          </View>
        )}
      </Section>
    </Document>
  );
}

/** The PDF's bytes */
export async function renderGtmPdf(c: GtmContent, brand: GtmBrand, prospect: { name: string; short: string }): Promise<Buffer> {
  return renderToBuffer(<GtmDoc c={c} brand={brand} prospect={prospect} />);
}
