import "server-only";
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import type { Style } from "@react-pdf/types";
import { splitBible, kindOf } from "./bible-sections";

// The Brand Bible as a PDF: a dark cover, the "Read this first" page, then every section with its own page break.
// Markdown is drawn by hand (headings, paragraphs, lists, pipe tables, bold), in the same Helvetica-and-Kaizen-red look
// as the client reports.

const RED = "#c8102e";
const INK = "#0b0b0c";
const MUTED = "#55555c";
const FAINT = "#a1a1aa";
const LINE = "#e7e7ea";
const SOFT = "#f6f6f7";

const s = StyleSheet.create({
  page: { fontFamily: "Helvetica", fontSize: 9.5, color: INK, paddingTop: 48, paddingBottom: 60, paddingHorizontal: 48 },
  cover: { backgroundColor: INK, color: "#ffffff", padding: 56, justifyContent: "space-between" },
  coverRule: { width: 36, height: 4, backgroundColor: RED, marginBottom: 22 },
  coverEyebrow: { fontSize: 9, letterSpacing: 2, color: "#b4b4bb", textTransform: "uppercase", fontFamily: "Helvetica-Bold" },
  coverName: { fontSize: 40, fontFamily: "Helvetica-Bold", letterSpacing: -1, marginTop: 14, lineHeight: 1.1 },
  coverMeta: { fontSize: 11, color: "#b4b4bb", marginTop: 12 },
  coverFoot: { fontSize: 8.5, color: "#8a8a92", lineHeight: 1.5 },
  num: { fontSize: 8, letterSpacing: 1.5, color: RED, fontFamily: "Helvetica-Bold", marginBottom: 6 },
  h2: { fontSize: 18, fontFamily: "Helvetica-Bold", letterSpacing: -0.3, marginBottom: 14, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: LINE },
  h3: { fontSize: 11.5, fontFamily: "Helvetica-Bold", marginTop: 12, marginBottom: 6 },
  h4: { fontSize: 10, fontFamily: "Helvetica-Bold", marginTop: 8, marginBottom: 4 },
  p: { fontSize: 9.5, lineHeight: 1.55, color: "#2b2b30", marginBottom: 7 },
  li: { flexDirection: "row", marginBottom: 4, paddingRight: 6 },
  dot: { width: 14, color: RED, fontFamily: "Helvetica-Bold", fontSize: 9.5 },
  liText: { flex: 1, fontSize: 9.5, lineHeight: 1.5, color: "#2b2b30" },
  table: { borderWidth: 1, borderColor: LINE, borderRadius: 4, marginBottom: 10 },
  tr: { flexDirection: "row", borderTopWidth: 1, borderTopColor: LINE },
  th: { flexDirection: "row", backgroundColor: SOFT },
  cell: { flex: 1, paddingVertical: 5, paddingHorizontal: 6, fontSize: 7.5, lineHeight: 1.4, color: "#2b2b30" },
  headCell: { flex: 1, paddingVertical: 5, paddingHorizontal: 6, fontSize: 7, fontFamily: "Helvetica-Bold", color: MUTED, textTransform: "uppercase", letterSpacing: 0.4 },
  first: { backgroundColor: SOFT, borderLeftWidth: 3, borderLeftColor: RED, padding: 16, borderRadius: 4 },
  footer: { position: "absolute", bottom: 28, left: 48, right: 48, flexDirection: "row", justifyContent: "space-between", fontSize: 7.5, color: FAINT, borderTopWidth: 1, borderTopColor: LINE, paddingTop: 8 },
});

/** **bold** inside a line, drawn as nested Text */
function Inline({ text, style }: { text: string; style?: Style }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return (
    <Text style={style}>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") ? (
          <Text key={i} style={{ fontFamily: "Helvetica-Bold", color: INK }}>
            {p.slice(2, -2)}
          </Text>
        ) : (
          p.replace(/(^|\s)\*([^*\s][^*]*)\*/g, "$1$2")
        ),
      )}
    </Text>
  );
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

function Body({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (!t || /^-{3,}$/.test(t)) {
      i++;
      continue;
    }
    const h = t.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      out.push(<Inline key={i} text={h[2]} style={h[1].length <= 3 ? s.h3 : s.h4} />);
      i++;
      continue;
    }
    if (t.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        if (!/^\|[\s:|-]+\|?$/.test(lines[i].trim())) rows.push(cells(lines[i]));
        i++;
      }
      const [head, ...body] = rows;
      out.push(
        <View key={`t${i}`} style={s.table}>
          <View style={s.th} wrap={false}>
            {head.map((c, j) => (
              <Inline key={j} text={c} style={s.headCell} />
            ))}
          </View>
          {body.map((r, k) => (
            <View key={k} style={s.tr} wrap={false}>
              {head.map((_, j) => (
                <Inline key={j} text={r[j] ?? ""} style={s.cell} />
              ))}
            </View>
          ))}
        </View>,
      );
      continue;
    }
    if (/^([-*•]|\d+[.)])\s+/.test(t)) {
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
        const raw = lines[i].trim();
        const n = raw.match(/^(\d+)[.)]/)?.[1];
        out.push(
          <View key={`l${i}`} style={s.li} wrap={false}>
            <Text style={s.dot}>{n ? `${n}.` : "•"}</Text>
            <Inline text={raw.replace(/^([-*•]|\d+[.)])\s+/, "")} style={s.liText} />
          </View>,
        );
        i++;
      }
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\||([-*•]|\d+[.)])\s)/.test(lines[i].trim())) para.push(lines[i++].trim());
    out.push(<Inline key={`p${i}`} text={para.join(" ")} style={s.p} />);
  }
  return <>{out}</>;
}

export async function renderBiblePdf(input: { client: string; version: string; status: string; generatedAt: string | null; markdown: string; readThisFirst: string }) {
  const date = input.generatedAt ? new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "long", day: "numeric", year: "numeric" }).format(new Date(input.generatedAt)) : "";
  const sections = splitBible(input.markdown).filter((x) => kindOf(x.title) !== "first");
  const footer = (
    <View style={s.footer} fixed>
      <Text>
        {input.client} · Brand Bible {input.version}
      </Text>
      <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
    </View>
  );
  const doc = (
    <Document title={`${input.client} Brand Bible`} author="Kaizen Marketing">
      <Page size="LETTER" style={s.cover}>
        <View>
          <View style={s.coverRule} />
          <Text style={s.coverEyebrow}>Kaizen Marketing · Brand Bible</Text>
          <Text style={s.coverName}>{input.client}</Text>
          <Text style={s.coverMeta}>
            {input.version}
            {date ? ` · ${date}` : ""}
            {input.status === "reviewed" ? " · Reviewed" : " · Draft"}
          </Text>
        </View>
        <Text style={s.coverFoot}>
          Audience profiles, voice, claims, reviews, look, competitors and the marketing calendar. Every fact carries its source. Internal: not for
          sharing outside Kaizen and the client.
        </Text>
      </Page>
      {input.readThisFirst.trim() && (
        <Page size="LETTER" style={s.page}>
          <Text style={s.num}>START HERE</Text>
          <Text style={s.h2}>Read this first</Text>
          <View style={s.first}>
            <Body text={input.readThisFirst} />
          </View>
          {footer}
        </Page>
      )}
      {sections.map((x) => (
        <Page key={x.id} size="LETTER" style={s.page}>
          <Text style={s.num}>{x.num ? `SECTION ${x.num.toUpperCase()}` : "BRAND BIBLE"}</Text>
          <Text style={s.h2}>{x.title}</Text>
          <Body text={x.body} />
          {footer}
        </Page>
      ))}
    </Document>
  );
  return new Uint8Array(await renderToBuffer(doc));
}
