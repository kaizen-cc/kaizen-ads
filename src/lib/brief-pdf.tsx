import "server-only";
import { Document, Link, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";

// A creative request as a Kaizen-branded PDF, to share outside the app (a freelancer, a client, a meeting): a cover band
// with the client and the title, the essentials at a glance, then the brief as written, references linked.

const RED = "#b21e2c";
const INK = "#0b0b0c";
const MUTED = "#55555c";
const FAINT = "#a1a1aa";
const LINE = "#e7e7ea";
const SOFT = "#f6f6f7";

const s = StyleSheet.create({
  page: { fontFamily: "Helvetica", fontSize: 10, color: INK, paddingBottom: 60 },
  band: { backgroundColor: INK, color: "#ffffff", paddingHorizontal: 48, paddingTop: 44, paddingBottom: 34 },
  rule: { width: 36, height: 4, backgroundColor: RED, marginBottom: 18 },
  eyebrow: { fontSize: 8.5, letterSpacing: 2, color: "#b4b4bb", textTransform: "uppercase", fontFamily: "Helvetica-Bold" },
  title: { fontSize: 26, fontFamily: "Helvetica-Bold", letterSpacing: -0.6, marginTop: 10, lineHeight: 1.15 },
  sub: { fontSize: 10.5, color: "#b4b4bb", marginTop: 8 },
  body: { paddingHorizontal: 48, paddingTop: 26 },
  grid: { flexDirection: "row", flexWrap: "wrap", borderWidth: 1, borderColor: LINE, borderRadius: 6, marginBottom: 22 },
  cell: { width: "50%", padding: 12, borderBottomWidth: 1, borderBottomColor: LINE },
  label: { fontSize: 7.5, letterSpacing: 1.2, color: MUTED, textTransform: "uppercase", fontFamily: "Helvetica-Bold", marginBottom: 4 },
  value: { fontSize: 10.5, lineHeight: 1.45, color: INK },
  h: { fontSize: 13, fontFamily: "Helvetica-Bold", marginBottom: 8, marginTop: 4, paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: LINE },
  p: { fontSize: 10, lineHeight: 1.6, color: "#2b2b30", marginBottom: 6 },
  link: { fontSize: 9.5, color: RED, marginBottom: 4 },
  note: { backgroundColor: SOFT, borderLeftWidth: 3, borderLeftColor: RED, padding: 12, borderRadius: 4, marginBottom: 18 },
  footer: { position: "absolute", bottom: 26, left: 48, right: 48, flexDirection: "row", justifyContent: "space-between", fontSize: 7.5, color: FAINT, borderTopWidth: 1, borderTopColor: LINE, paddingTop: 8 },
});

export type BriefPdfInput = {
  client: string;
  title: string;
  formats: { label: string; count: string }[];
  sizes: string[];
  priority: string;
  angle: string;
  audience: string;
  brief: string;
  refs: string[];
  landing: string | null;
  origin: string | null;
  by: string | null;
};

export async function briefPdf(b: BriefPdfInput) {
  const date = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York" });
  const paras = b.brief.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
  const doc = (
    <Document title={`${b.client} · ${b.title}`} author="Kaizen Marketing">
      <Page size="LETTER" style={s.page}>
        <View style={s.band}>
          <View style={s.rule} />
          <Text style={s.eyebrow}>Kaizen Marketing · Creative request</Text>
          <Text style={s.title}>{b.title || "Creative request"}</Text>
          <Text style={s.sub}>
            {b.client} · {date}
            {b.priority !== "normal" ? ` · ${b.priority.toUpperCase()}` : ""}
          </Text>
        </View>
        <View style={s.body}>
          <View style={s.grid}>
            <View style={s.cell}>
              <Text style={s.label}>What we&apos;re making</Text>
              <Text style={s.value}>{b.formats.map((f) => `${f.label}: ${f.count}`).join("\n") || "To decide"}</Text>
            </View>
            <View style={s.cell}>
              <Text style={s.label}>Sizes</Text>
              <Text style={s.value}>{b.sizes.join(" · ") || "4:5 · 9:16"}</Text>
            </View>
            <View style={s.cell}>
              <Text style={s.label}>Angle</Text>
              <Text style={s.value}>{b.angle || "–"}</Text>
            </View>
            <View style={s.cell}>
              <Text style={s.label}>Audience</Text>
              <Text style={s.value}>{b.audience || "–"}</Text>
            </View>
          </View>
          {b.origin && (
            <View style={s.note}>
              <Text style={s.label}>Built on</Text>
              <Text style={s.value}>{b.origin}</Text>
            </View>
          )}
          <Text style={s.h}>The brief</Text>
          {paras.map((p, i) => (
            <Text key={i} style={s.p}>
              {p}
            </Text>
          ))}
          {(b.refs.length > 0 || b.landing) && <Text style={[s.h, { marginTop: 14 }]}>Links</Text>}
          {b.landing && (
            <Link src={b.landing} style={s.link}>
              Landing page: {b.landing}
            </Link>
          )}
          {b.refs.map((r) => (
            <Link key={r} src={r} style={s.link}>
              {r}
            </Link>
          ))}
        </View>
        <View style={s.footer} fixed>
          <Text>Kaizen Marketing{b.by ? ` · briefed by ${b.by}` : ""}</Text>
          <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
  return new Uint8Array(await renderToBuffer(doc));
}
