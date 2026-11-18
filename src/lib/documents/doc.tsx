import type { ReactNode } from "react";
import { Circle, Defs, Document, Image, LinearGradient, Page, Rect, Stop, StyleSheet, Svg, Text, View } from "@react-pdf/renderer";
import { docKit, lookFor, KAIZEN_RED, type Look, type WeeklyBrand } from "@/lib/reports/weekly-doc";
import { DOC_LABEL, type DocContent } from "./core";

// A Kaizen document (create_document) in the look of the client reports: a deep band with Kaizen's mark beside the
// client's logo, the kind and the period, then clean sections on a light page: the summary, results tiles, the
// sections, and tables for deliverables, cadence and the investment (a price that wasn't stored is drawn as an amber
// placeholder, never a number). US Letter, portrait. Text runs onto as many pages as it needs; tables never split a row.

export type DocInput = { doc: DocContent; brand: WeeklyBrand | null };

const W = 612;
const PAD = 44;
const { Logo, INK, MUTED, LINE, GOOD } = docKit;
const WATCH = { fg: "#8a5a00", bg: "#fff1d6" };
const SOFT = "#f4f6f9";
const BODY = "#2c3a4b";

const s = StyleSheet.create({
  page: { fontFamily: "Helvetica", color: INK, backgroundColor: "#ffffff", paddingTop: 40, paddingBottom: 54, fontSize: 10.5, lineHeight: 1.45 },
  body: { paddingHorizontal: PAD, paddingTop: 26 },
  kicker: { fontSize: 8.5, fontFamily: "Helvetica-Bold", letterSpacing: 1.4, textTransform: "uppercase" },
  h2: { fontSize: 14, fontFamily: "Helvetica-Bold", letterSpacing: -0.2, marginBottom: 8 },
  para: { fontSize: 10.5, color: BODY, lineHeight: 1.5 },
  section: { marginBottom: 20 },
  panel: { borderWidth: 1, borderColor: LINE, borderRadius: 10 },
  th: { fontSize: 8, fontFamily: "Helvetica-Bold", letterSpacing: 1, textTransform: "uppercase", color: MUTED },
  footer: { position: "absolute", bottom: 22, left: PAD, right: PAD, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: LINE, paddingTop: 8 },
  foot: { fontSize: 8, color: MUTED },
});

/** The band at the top of the first page: the marks, what the document is, its title and period */
function Band({ input, look }: { input: DocInput; look: Look }) {
  const { doc, brand } = input;
  const H = 236;
  return (
    <View style={{ height: H, position: "relative", marginTop: -40 }}>
      <View style={{ position: "absolute", top: 0, left: 0, width: W, height: H }}>
        <Svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
          <Defs>
            <LinearGradient id="band" x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor={look.hero} />
              <Stop offset="1" stopColor={look.heroEdge} />
            </LinearGradient>
          </Defs>
          <Rect x={0} y={0} width={W} height={H} fill="url(#band)" />
          <Circle cx={W - 40} cy={30} r={150} fill="none" stroke="#ffffff" strokeOpacity={0.09} strokeWidth={1} />
          <Circle cx={W - 40} cy={30} r={190} fill="none" stroke="#ffffff" strokeOpacity={0.05} strokeWidth={30} />
          <Rect x={0} y={H - 4} width={W} height={4} fill={look.primary} />
        </Svg>
      </View>
      <View style={{ paddingHorizontal: PAD, paddingTop: 30, flex: 1, justifyContent: "space-between", paddingBottom: 26 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          {brand?.logo ? <Logo src={brand.logo} light={brand.light} chip={look.hero} height={26} maxWidth={120} /> : doc.client ? <Text style={{ fontSize: 13, fontFamily: "Helvetica-Bold", color: "#ffffff" }}>{doc.client}</Text> : null}
          {(brand?.logo || doc.client) && <View style={{ width: 1, height: 20, backgroundColor: "#ffffff", opacity: 0.35 }} />}
          {brand?.agencyLogo ? (
            <View style={{ backgroundColor: "#ffffff", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 }}>
              {/* eslint-disable-next-line jsx-a11y/alt-text -- a PDF image, no alt prop */}
              <Image src={brand.agencyLogo} style={{ height: 16, maxWidth: 80, objectFit: "contain" }} />
            </View>
          ) : (
            <Text style={{ fontSize: 15, fontFamily: "Helvetica-Bold", color: "#ffffff", letterSpacing: -0.3 }}>kaizen</Text>
          )}
        </View>
        <View>
          <Text style={[s.kicker, { color: look.heroSoft, marginBottom: 8 }]}>
            {DOC_LABEL[doc.kind]}
            {doc.client ? ` / Prepared for ${doc.client}` : ""}
          </Text>
          <Text style={{ fontSize: doc.title.length > 48 ? 22 : 27, fontFamily: "Helvetica-Bold", color: "#ffffff", letterSpacing: -0.5, lineHeight: 1.12 }}>{doc.title}</Text>
          {doc.subtitle ? <Text style={{ fontSize: 11.5, color: "#dfe3e8", marginTop: 8, lineHeight: 1.4 }}>{doc.subtitle}</Text> : null}
          {doc.period ? (
            <View style={{ flexDirection: "row", marginTop: 12 }}>
              <Text style={{ fontSize: 9, fontFamily: "Helvetica-Bold", color: "#ffffff", backgroundColor: look.primary, borderRadius: 4, paddingHorizontal: 7, paddingVertical: 3, letterSpacing: 0.6 }}>{doc.period}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const Heading = ({ children, look }: { children: ReactNode; look: Look }) => (
  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }} minPresenceAhead={60}>
    <View style={{ width: 14, height: 3, borderRadius: 2, backgroundColor: look.primary }} />
    <Text style={[s.h2, { marginBottom: 0 }]}>{children}</Text>
  </View>
);

function Bullets({ items, color }: { items: string[]; color: string }) {
  return (
    <View style={{ gap: 5 }}>
      {items.map((b, i) => (
        <View key={i} style={{ flexDirection: "row", gap: 8 }} wrap={false}>
          <View style={{ width: 4.5, height: 4.5, borderRadius: 2.25, backgroundColor: color, marginTop: 5 }} />
          <Text style={[s.para, { flex: 1 }]}>{b}</Text>
        </View>
      ))}
    </View>
  );
}

/** A table: a header row and rows that never split across pages */
function Table({ cols, rows, widths, look, tone }: { cols: string[]; rows: ReactNode[][]; widths: number[]; look: Look; tone?: (i: number) => string | null }) {
  return (
    <View style={[s.panel, { overflow: "hidden" }]}>
      <View style={{ flexDirection: "row", backgroundColor: SOFT, paddingVertical: 7, paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: LINE }} fixed={false}>
        {cols.map((c, i) => (
          <Text key={i} style={[s.th, { flex: widths[i] }]}>
            {c}
          </Text>
        ))}
      </View>
      {rows.map((r, ri) => (
        <View key={ri} wrap={false} style={{ flexDirection: "row", paddingVertical: 8, paddingHorizontal: 10, borderBottomWidth: ri === rows.length - 1 ? 0 : 1, borderBottomColor: LINE, borderLeftWidth: tone?.(ri) ? 3 : 0, borderLeftColor: tone?.(ri) ?? look.primary }}>
          {r.map((cell, ci) => (
            <View key={ci} style={{ flex: widths[ci], paddingRight: 8 }}>
              {typeof cell === "string" ? <Text style={[s.para, ci === 0 ? { fontFamily: "Helvetica-Bold", color: INK } : {}]}>{cell}</Text> : cell}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

export function KaizenDocument({ input }: { input: DocInput }) {
  const { doc } = input;
  const look = lookFor({ brand: input.brand, whiteLabel: false });
  const anyQty = doc.deliverables.some((d) => d.qty);
  return (
    <Document title={`${doc.title}${doc.client ? ` · ${doc.client}` : ""}`} author="Kaizen Marketing" creator="Kaizen Marketing" producer="Kaizen Marketing" subject={DOC_LABEL[doc.kind]}>
      <Page size="LETTER" style={s.page}>
        <Band input={input} look={look} />
        <View style={s.body}>
          {doc.summary ? (
            <View style={[s.section, { flexDirection: "row", gap: 12 }]}>
              <View style={{ width: 3, borderRadius: 2, backgroundColor: look.bars }} />
              <Text style={[s.para, { flex: 1, fontSize: 11.5, color: INK, lineHeight: 1.5 }]}>{doc.summary}</Text>
            </View>
          ) : null}

          {doc.stats.length ? (
            <View style={[s.section, { flexDirection: "row", gap: 10 }]} wrap={false}>
              {doc.stats.map((t, i) => (
                <View key={i} style={[s.panel, { flex: 1, padding: 12, borderTopWidth: 3, borderTopColor: look.bars }]}>
                  <Text style={{ fontSize: t.value.length > 8 ? 16 : 21, fontFamily: "Helvetica-Bold", color: look.barsText, letterSpacing: -0.5 }}>{t.value}</Text>
                  <Text style={{ fontSize: 9.5, fontFamily: "Helvetica-Bold", marginTop: 4, lineHeight: 1.25 }}>{t.label}</Text>
                  {t.note ? <Text style={{ fontSize: 8.5, color: MUTED, marginTop: 3, lineHeight: 1.3 }}>{t.note}</Text> : null}
                </View>
              ))}
            </View>
          ) : null}

          {doc.sections.map((sec, i) => (
            <View key={i} style={s.section}>
              {sec.heading ? <Heading look={look}>{sec.heading}</Heading> : null}
              {sec.body
                ? sec.body.split(/\n\n+/).map((p, pi) => (
                    <Text key={pi} style={[s.para, { marginBottom: 6 }]}>
                      {p}
                    </Text>
                  ))
                : null}
              {sec.bullets.length ? <Bullets items={sec.bullets} color={look.bars} /> : null}
            </View>
          ))}

          {doc.deliverables.length ? (
            <View style={s.section}>
              <Heading look={look}>Deliverables</Heading>
              <Table cols={anyQty ? ["What", "How many", "Details"] : ["What", "Details"]} widths={anyQty ? [3, 1.4, 5] : [3, 6]} look={look} rows={doc.deliverables.map((d) => (anyQty ? [d.item, d.qty || "-", d.detail] : [d.item, d.detail]))} />
            </View>
          ) : null}

          {doc.cadence.length ? (
            <View style={s.section}>
              <Heading look={look}>Cadence</Heading>
              <Table cols={["What", "When"]} widths={[5, 4]} look={look} rows={doc.cadence.map((c) => [c.what, c.when])} />
            </View>
          ) : null}

          {doc.inclusions.length || doc.exclusions.length ? (
            <View style={[s.section, { flexDirection: "row", gap: 12 }]}>
              {doc.inclusions.length ? (
                <View style={[s.panel, { flex: 1, padding: 12, borderTopWidth: 3, borderTopColor: GOOD.fg }]}>
                  <Text style={[s.kicker, { color: GOOD.fg, marginBottom: 8 }]}>Included</Text>
                  <Bullets items={doc.inclusions} color={GOOD.fg} />
                </View>
              ) : null}
              {doc.exclusions.length ? (
                <View style={[s.panel, { flex: 1, padding: 12, borderTopWidth: 3, borderTopColor: MUTED }]}>
                  <Text style={[s.kicker, { color: MUTED, marginBottom: 8 }]}>Not included</Text>
                  <Bullets items={doc.exclusions} color={MUTED} />
                </View>
              ) : null}
            </View>
          ) : null}

          {doc.pricing.length ? (
            <View style={s.section} wrap={false}>
              <Heading look={look}>Investment</Heading>
              <Table
                cols={["Item", "Price", "Notes"]}
                widths={[4, 2.6, 4]}
                look={look}
                tone={(i) => (doc.pricing[i].placeholder ? WATCH.fg : null)}
                rows={doc.pricing.map((p) => [
                  p.item,
                  p.placeholder ? (
                    <Text style={{ fontSize: 9.5, fontFamily: "Helvetica-Bold", color: WATCH.fg, backgroundColor: WATCH.bg, borderRadius: 3, paddingHorizontal: 5, paddingVertical: 2 }}>{p.price}</Text>
                  ) : (
                    <Text style={[s.para, { fontFamily: "Helvetica-Bold", color: INK }]}>
                      {p.price}
                      {p.cadence ? <Text style={{ fontFamily: "Helvetica", color: MUTED }}> {p.cadence}</Text> : null}
                    </Text>
                  ),
                  p.note,
                ])}
              />
              {doc.pricing.some((p) => p.placeholder) ? <Text style={{ fontSize: 8.5, color: WATCH.fg, marginTop: 6 }}>Prices marked to confirm will be set with you before anything starts.</Text> : null}
            </View>
          ) : null}

          {doc.nextSteps.length ? (
            <View style={[s.section, { backgroundColor: SOFT, borderRadius: 10, padding: 14 }]} wrap={false}>
              <Text style={[s.kicker, { color: look.primary, marginBottom: 8 }]}>Next steps</Text>
              {doc.nextSteps.map((n, i) => (
                <View key={i} style={{ flexDirection: "row", gap: 8, marginBottom: 4 }}>
                  <Text style={{ fontSize: 10, fontFamily: "Helvetica-Bold", color: look.primary, width: 14 }}>{i + 1}.</Text>
                  <Text style={[s.para, { flex: 1 }]}>{n}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>

        <View style={s.footer} fixed>
          <Text style={[s.foot, { fontFamily: "Helvetica-Bold", color: KAIZEN_RED }]}>
            Kaizen Marketing<Text style={{ fontFamily: "Helvetica", color: MUTED }}>{doc.preparedBy ? `  ·  Prepared by ${doc.preparedBy}` : ""}</Text>
          </Text>
          <Text style={s.foot} render={({ pageNumber, totalPages }) => `${doc.client ? `${doc.client}  ·  ` : ""}${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
