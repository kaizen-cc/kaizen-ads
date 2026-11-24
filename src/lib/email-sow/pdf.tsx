import type { ReactNode } from "react";
import { Document, Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { EmailSow, Lead, Stat, Table } from "./core";

// The email SOW as a PDF, drawn to match the Word file (src/lib/email-sow/docx.ts): a cover page with Kaizen's mark
// beside the client's logo, red eyebrows over each section, red stat tiles, black-headed zebra tables, grey callouts
// with a red rule, bullets with a bold lead, a signature block and a footer on every page. US Letter, Helvetica.

const RED = "#B21E2C";
const BLACK = "#060606";
const GREY = "#F2F2F2";
const RULE = "#D9D9D9";
const BODY = "#333333";

const s = StyleSheet.create({
  page: { fontFamily: "Helvetica", color: BODY, fontSize: 10.5, lineHeight: 1.5, paddingTop: 64, paddingBottom: 64, paddingHorizontal: 64 },
  h1: { fontSize: 21, fontFamily: "Helvetica-Bold", color: BLACK, lineHeight: 1.25, marginBottom: 6 },
  eyebrow: { fontSize: 8.5, fontFamily: "Helvetica-Bold", color: RED, letterSpacing: 0.8, lineHeight: 1.3, marginBottom: 16 },
  h2: { fontSize: 13.5, fontFamily: "Helvetica-Bold", color: BLACK, marginTop: 14, marginBottom: 7 },
  p: { marginBottom: 8 },
  bulletRow: { flexDirection: "row", marginBottom: 4, paddingLeft: 6 },
  dot: { width: 12, color: RED, fontFamily: "Helvetica-Bold" },
  bold: { fontFamily: "Helvetica-Bold", color: BLACK },
  footer: { position: "absolute", bottom: 30, left: 64, right: 64, fontSize: 8, color: "#888888", textAlign: "right" },
});

function H1({ text, eyebrow }: { text: string; eyebrow: string | null }) {
  return (
    <View wrap={false} style={{ marginBottom: eyebrow ? 0 : 10 }}>
      <Text style={s.h1}>{text}</Text>
      {eyebrow ? <Text style={s.eyebrow}>{eyebrow}</Text> : null}
    </View>
  );
}

const H2 = ({ text }: { text: string }) => (
  <Text style={s.h2} minPresenceAhead={60}>
    {text}
  </Text>
);
const P = ({ text }: { text: string }) => (text ? <Text style={s.p}>{text}</Text> : null);

function Bullet({ lead, text }: { lead?: string; text: string }) {
  return (
    <View style={s.bulletRow} wrap={false}>
      <Text style={s.dot}>•</Text>
      <Text style={{ flex: 1 }}>
        {lead ? <Text style={s.bold}>{lead} </Text> : null}
        {text}
      </Text>
    </View>
  );
}
const Leads = ({ items }: { items: Lead[] }) => (
  <View style={{ marginBottom: 6 }}>
    {items.map((l, i) => (
      <Bullet key={i} lead={l.lead} text={l.text} />
    ))}
  </View>
);

function DataTable({ t }: { t: Table }) {
  const cols = t.head.length;
  const first = cols > 3 ? 30 : 40;
  const w = (i: number) => `${i === 0 ? first : (100 - first) / Math.max(1, cols - 1)}%`;
  const row = (cells: string[], o: { head?: boolean; fill?: string; bold?: boolean }, key: string) => (
    <View key={key} wrap={false} style={{ flexDirection: "row", backgroundColor: o.head ? BLACK : (o.fill ?? "#ffffff") }}>
      {cells.map((c, i) => (
        <Text key={i} style={{ width: w(i), paddingVertical: 5, paddingHorizontal: 6, fontSize: o.head ? 8.5 : 9, fontFamily: o.head || o.bold ? "Helvetica-Bold" : "Helvetica", color: o.head ? "#ffffff" : BODY, borderRightWidth: i < cells.length - 1 ? 0.5 : 0, borderRightColor: RULE }}>
          {c}
        </Text>
      ))}
    </View>
  );
  return (
    <View style={{ borderWidth: 0.5, borderColor: RULE, marginBottom: 10 }}>
      {row(t.head, { head: true }, "h")}
      {t.rows.map((r, n) => row(r, { fill: n % 2 ? GREY : "#ffffff" }, `r${n}`))}
      {t.total ? row(t.total, { fill: t.rows.length % 2 ? GREY : "#ffffff", bold: true }, "t") : null}
    </View>
  );
}

function Callout({ text }: { text: string }) {
  if (!text) return null;
  const at = text.indexOf(":");
  const split = at > 0 && at < 50;
  return (
    <View wrap={false} style={{ backgroundColor: GREY, borderLeftWidth: 3, borderLeftColor: RED, paddingVertical: 9, paddingHorizontal: 12, marginBottom: 12 }}>
      <Text>
        {split ? <Text style={s.bold}>{text.slice(0, at + 1)}</Text> : null}
        {split ? text.slice(at + 1) : text}
      </Text>
    </View>
  );
}

function Tiles({ stats }: { stats: Stat[] }) {
  return (
    <View wrap={false} style={{ flexDirection: "row", gap: 4, marginVertical: 10 }}>
      {stats.map((t, i) => (
        <View key={i} style={{ flex: 1, backgroundColor: RED, paddingVertical: 12, paddingHorizontal: 6, alignItems: "center" }}>
          <Text style={{ fontSize: 17, fontFamily: "Helvetica-Bold", color: "#ffffff" }}>{t.value}</Text>
          <Text style={{ fontSize: 8, color: "#ffffff", textAlign: "center", marginTop: 3, lineHeight: 1.3 }}>{t.label}</Text>
        </View>
      ))}
    </View>
  );
}

/** One section of the document on its own page(s), with the footer on every page */
function Section({ client, children }: { client: string; children: ReactNode }) {
  return (
    <Page size="LETTER" style={s.page}>
      <Text style={s.footer} fixed render={({ pageNumber }) => `Kaizen Marketing Agency  |  ${client}  |  ${pageNumber}`} />
      {children}
    </Page>
  );
}

export type SowPdfInput = { sow: EmailSow; agencyLogo: string | null; clientLogo: string | null };

export function EmailSowPdf({ input }: { input: SowPdfInput }) {
  const d = input.sow;
  const sec = (k: number) => k + (d.recap ? 1 : 0) + (d.numbers ? 1 : 0);
  const s4 = d.scope;
  return (
    <Document title={`Kaizen x ${d.client}: ${d.title}`} author="Kaizen Marketing Agency">
      <Page size="LETTER" style={s.page}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 18, marginTop: 40, marginBottom: 80, height: 40 }}>
          {/* eslint-disable-next-line jsx-a11y/alt-text -- a PDF image, no alt prop */}
          {input.agencyLogo ? <Image src={input.agencyLogo} style={{ height: 34, maxWidth: 140, objectFit: "contain" }} /> : <Text style={{ fontSize: 22, fontFamily: "Helvetica-Bold", color: BLACK }}>kaizen</Text>}
          {/* eslint-disable-next-line jsx-a11y/alt-text -- a PDF image, no alt prop */}
          {input.clientLogo ? <Image src={input.clientLogo} style={{ height: 34, maxWidth: 140, objectFit: "contain" }} /> : null}
        </View>
        <Text style={{ fontSize: 10.5, fontFamily: "Helvetica-Bold", color: RED, letterSpacing: 1.2, marginBottom: 14 }}>KAIZEN x {d.client.toUpperCase()}</Text>
        <Text style={{ fontSize: 31, fontFamily: "Helvetica-Bold", color: BLACK, lineHeight: 1.15 }}>Sprint Recap &</Text>
        <Text style={{ fontSize: 31, fontFamily: "Helvetica-Bold", color: BLACK, lineHeight: 1.15, marginBottom: 12 }}>Ongoing Management SOW</Text>
        <Text style={{ fontSize: 14, color: "#555555", marginBottom: 120 }}>{d.subtitle}</Text>
        <Text style={{ marginBottom: 3 }}>
          <Text style={s.bold}>Prepared for: </Text>
          {d.contact}, {d.client}
        </Text>
        <Text style={{ marginBottom: 3 }}>
          <Text style={s.bold}>Prepared by: </Text>Kaizen Marketing Agency
        </Text>
        <Text>{d.dated}</Text>
      </Page>

        {d.recap ? (
          <Section client={d.client}>
            <H1 text={d.recap.heading} eyebrow="SECTION 1 | SPRINT WRAP-UP" />
            {d.recap.paragraphs.map((p, i) => (
              <P key={i} text={p} />
            ))}
            {d.recap.stats.length ? <Tiles stats={d.recap.stats} /> : null}
            {d.recap.built.length ? (
              <View>
                <H2 text="What We Built Together" />
                <Leads items={d.recap.built} />
              </View>
            ) : null}
          </Section>
        ) : null}

        {d.numbers ? (
          <Section client={d.client}>
            <H1 text="The Numbers" eyebrow={`SECTION ${d.recap ? 2 : 1} | REVENUE & PERFORMANCE`} />
            <P text={d.numbers.intro} />
            <H2 text={d.numbers.totalHeading} />
            <P text={d.numbers.totalText} />
            {d.numbers.sources ? <DataTable t={d.numbers.sources} /> : null}
            <H2 text="What Kaizen's Sends Drove" />
            <P text={d.numbers.sendsText} />
            {d.numbers.campaigns ? <DataTable t={d.numbers.campaigns} /> : null}
            <Callout text={d.numbers.campaignsCallout} />
            {d.numbers.channels || d.numbers.channelsCallout ? <H2 text="Performance by Channel" /> : null}
            {d.numbers.channels ? <DataTable t={d.numbers.channels} /> : null}
            <Callout text={d.numbers.channelsCallout} />
          </Section>
        ) : null}

        {d.deliverability ? (
          <Section client={d.client}>
            <H1 text="Where Deliverability Stands" eyebrow={`SECTION ${sec(1)} | THE HONEST PICTURE`} />
            {d.deliverability.paragraphs.map((p, i) => (
              <P key={i} text={p} />
            ))}
            {d.deliverability.metrics ? <DataTable t={d.deliverability.metrics} /> : null}
            {d.deliverability.levers.length ? (
              <View>
                <H2 text="What Moves the Score" />
                <Leads items={d.deliverability.levers} />
              </View>
            ) : null}
          </Section>
        ) : null}

        <Section client={d.client}>
          <H1 text="Building on the Momentum" eyebrow={`SECTION ${sec(d.deliverability ? 2 : 1)} | ONGOING MANAGEMENT SCOPE OF WORK`} />
          <P text={s4.intro} />
          <H2 text={s4.startHeading} />
          <P text={s4.startText} />
          <DataTable t={s4.pricing} />
          <Text style={[s.bold, { marginBottom: 6 }]}>{s4.startLine}</Text>
          {s4.included.map((b, i) => (
            <View key={i}>
              <H2 text={b.heading} />
              <P text={b.intro} />
              {b.bullets.map((x, j) => (
                <Bullet key={j} text={x} />
              ))}
            </View>
          ))}
          <H2 text="Ongoing Management Tiers" />
          <DataTable t={s4.tiers} />
          {s4.tiersNote ? <Text style={[s.p, { fontFamily: "Helvetica-Oblique" }]}>{s4.tiersNote}</Text> : null}
          {s4.nextTier ? (
            <View>
              <H2 text={`The Path to ${s4.nextTier}`} />
              <P text={s4.pathText} />
              {s4.triggers ? <DataTable t={s4.triggers} /> : null}
              <Callout text={s4.triggersCallout} />
            </View>
          ) : null}
          {s4.ninetyDays ? (
            <View>
              <H2 text="What Success Looks Like: First 90 Days" />
              <DataTable t={s4.ninetyDays} />
            </View>
          ) : null}
          {s4.needs.length ? (
            <View>
              <H2 text={`What Kaizen Needs From ${d.client}`} />
              <Leads items={s4.needs} />
            </View>
          ) : null}
          {s4.outOfScope.length ? (
            <View>
              <H2 text="Out of Scope" />
              {s4.outOfScope.map((x, i) => (
                <Bullet key={i} text={x} />
              ))}
            </View>
          ) : null}
          {s4.roadmap.length ? (
            <View>
              <H2 text="Future Automation Roadmap" />
              <P text={s4.roadmapIntro} />
              <Leads items={s4.roadmap} />
            </View>
          ) : null}
        </Section>

        <Section client={d.client}>
          <H1 text={d.closing.heading} eyebrow={null} />
          <P text={d.closing.paragraph} />
          <H2 text="Next Steps" />
          {d.closing.nextSteps.map((x, i) => (
            <Bullet key={i} text={x} />
          ))}
          <View wrap={false} style={{ flexDirection: "row", gap: 30, marginTop: 50 }}>
            {[d.client, "Kaizen Marketing Agency"].map((who) => (
              <View key={who} style={{ flex: 1, borderTopWidth: 1, borderTopColor: BLACK, paddingTop: 6 }}>
                <Text style={s.bold}>{who}</Text>
                <Text style={{ fontSize: 9, color: "#777777" }}>Name, title and date</Text>
              </View>
            ))}
          </View>
        </Section>
    </Document>
  );
}
