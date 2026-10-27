import "server-only";
import { Document, Image, Link, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import sharp from "sharp";
import type { ReportMetrics, TopAd } from "./metrics";
import type { Sections } from "./write";
import { conversionTiles, count, headlineTiles, kpiRows, money, percent, multiple, platformName, singular, type Delta, type Tile } from "./format";

// The client report as a PDF: the weekly recap (one platform, a page or two) and the monthly recap (a cover, then each
// platform: the conversion summary, the KPI table, top ads, campaigns and the notes). Helvetica, lots of white, Kaizen
// red only where the eye should go. Ad images are fetched and turned into small JPEGs; one that fails is left out.

/** extra: a built report's other date ranges (the first range is metrics) */
export type ReportPart = { platform: "meta" | "google"; buyer: string | null; metrics: ReportMetrics; sections: Sections; extras: string | null; extra?: ReportMetrics[] | null };
/** built: a report from the report builder (a cover, the whole account when it covers more than one service, then each) */
export type ReportPdfInput = { client: string; kind: "weekly" | "monthly" | "built"; periodLabel: string; parts: ReportPart[] };

const RED = "#c8102e";
const INK = "#0b0b0c";
const MUTED = "#6b6b73";
const FAINT = "#a1a1aa";
const LINE = "#e7e7ea";
const SOFT = "#f6f6f7";
const GOOD = "#16794c";
const BAD = "#c8102e";

const s = StyleSheet.create({
  page: { fontFamily: "Helvetica", fontSize: 9.5, color: INK, paddingTop: 44, paddingBottom: 60, paddingHorizontal: 44 }, // no lineHeight here: it would reach the page numbers, and a render-prop Text with one is dropped
  band: { backgroundColor: INK, marginTop: -44, marginHorizontal: -44, paddingHorizontal: 44, paddingTop: 34, paddingBottom: 26, marginBottom: 26 },
  bandRule: { width: 28, height: 3, backgroundColor: RED, marginBottom: 14 },
  bandClient: { color: "#ffffff", fontSize: 22, fontFamily: "Helvetica-Bold", letterSpacing: -0.3, lineHeight: 1.2 },
  bandMeta: { color: "#b4b4bb", fontSize: 10, marginTop: 6 },
  eyebrow: { fontSize: 7.5, letterSpacing: 1.2, color: MUTED, textTransform: "uppercase", fontFamily: "Helvetica-Bold", marginBottom: 8 },
  headline: { fontSize: 15, fontFamily: "Helvetica-Bold", lineHeight: 1.3, letterSpacing: -0.2, marginBottom: 8 },
  summary: { fontSize: 10, color: "#3a3a40", lineHeight: 1.55, marginBottom: 20 },
  section: { marginBottom: 22 },
  tiles: { flexDirection: "row", gap: 8 },
  tile: { flex: 1, borderWidth: 1, borderColor: LINE, borderRadius: 6, paddingVertical: 12, paddingHorizontal: 12 },
  tileLabel: { fontSize: 7.5, color: MUTED, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6 },
  tileValue: { fontSize: 18, fontFamily: "Helvetica-Bold", letterSpacing: -0.4, lineHeight: 1.2 },
  tileSub: { fontSize: 8, color: MUTED, marginTop: 3 },
  tileDelta: { fontSize: 8, fontFamily: "Helvetica-Bold", marginTop: 7 },
  mtd: { backgroundColor: SOFT, borderRadius: 6, paddingVertical: 10, paddingHorizontal: 12, fontSize: 9, color: "#3a3a40", lineHeight: 1.5 },
  ad: { flexDirection: "row", gap: 12, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: LINE, alignItems: "center" },
  adImage: { width: 54, height: 54, borderRadius: 4, objectFit: "cover" },
  adBlank: { width: 54, height: 54, borderRadius: 4, backgroundColor: SOFT },
  adName: { fontSize: 9.5, fontFamily: "Helvetica-Bold", marginBottom: 4 },
  adMeta: { fontSize: 8.5, color: MUTED, lineHeight: 1.4 },
  link: { fontSize: 8.5, color: RED, textDecoration: "none", fontFamily: "Helvetica-Bold" },
  th: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: INK, paddingBottom: 5, marginBottom: 2 },
  thText: { fontSize: 7.5, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6, fontFamily: "Helvetica-Bold" },
  tr: { flexDirection: "row", paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: LINE },
  td: { fontSize: 9, lineHeight: 1.35 },
  noteHead: { fontSize: 10.5, fontFamily: "Helvetica-Bold", marginBottom: 6 },
  bullet: { flexDirection: "row", marginBottom: 4, paddingRight: 8 },
  dot: { width: 12, color: RED, fontFamily: "Helvetica-Bold" },
  bulletText: { flex: 1, fontSize: 9.5, lineHeight: 1.5 },
  footer: { position: "absolute", bottom: 26, left: 44, right: 44, flexDirection: "row", justifyContent: "space-between", fontSize: 7.5, color: FAINT, borderTopWidth: 1, borderTopColor: LINE, paddingTop: 8, lineHeight: 1.2 },
  pageNumber: { position: "absolute", bottom: 26, left: 44, width: 507, textAlign: "right", fontSize: 7.5, color: FAINT }, // no lineHeight: it drops a render-prop Text
  platformHead: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", borderBottomWidth: 2, borderBottomColor: RED, paddingBottom: 8, marginBottom: 18 },
  platformName: { fontSize: 18, fontFamily: "Helvetica-Bold", letterSpacing: -0.3, lineHeight: 1.2 },
  extras: { borderLeftWidth: 2, borderLeftColor: RED, paddingLeft: 12, fontSize: 9.5, color: "#3a3a40", lineHeight: 1.55 },
});

const toneColor = (d: Delta | null) => (!d ? FAINT : d.tone === "good" ? GOOD : d.tone === "bad" ? BAD : MUTED);

/** An ad image as a small JPEG, or null when it can't be fetched (expired CDN links are common). */
async function adImage(url: string | null): Promise<Buffer | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const raw = Buffer.from(await res.arrayBuffer());
    return await sharp(raw).resize(240, 240, { fit: "cover" }).jpeg({ quality: 82 }).toBuffer();
  } catch {
    return null;
  }
}

function Footer({ client }: { client: string }) {
  return (
    <>
      {/* The page number sits on its own: a render-prop Text inside an absolute View drops the whole View */}
      <View style={s.footer} fixed>
        <Text>Kaizen Marketing · {client}</Text>
      </View>
      <Text style={s.pageNumber} fixed render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
    </>
  );
}

function Tiles({ tiles }: { tiles: Tile[] }) {
  return (
    <View style={s.tiles}>
      {tiles.map((t) => (
        <View key={t.label} style={s.tile}>
          <Text style={s.tileLabel}>{t.label}</Text>
          <Text style={s.tileValue}>{t.value}</Text>
          {t.sub ? <Text style={s.tileSub}>{t.sub}</Text> : null}
          <Text style={[s.tileDelta, { color: toneColor(t.delta) }]}>{t.delta ? t.delta.text : "No comparison"}</Text>
        </View>
      ))}
    </View>
  );
}

function TopAds({ ads, images, conversion }: { ads: TopAd[]; images: (Buffer | null)[]; conversion: string }) {
  if (!ads.length) return null;
  const one = singular(conversion);
  return (
    <View style={s.section} wrap={false}>
      <Text style={s.eyebrow}>Top ads</Text>
      {ads.map((a, i) => (
        <View key={a.id} style={s.ad}>
          {/* eslint-disable-next-line jsx-a11y/alt-text -- a PDF image, no alt prop */}
          {images[i] ? <Image style={s.adImage} src={{ data: images[i]!, format: "jpg" }} /> : <View style={s.adBlank} />}
          <View style={{ flex: 1 }}>
            <Text style={s.adName}>{a.name}</Text>
            <Text style={s.adMeta}>
              {count(a.results)} {conversion.toLowerCase()} · {money(a.costPerResult)} per {one} · {money(a.spend)} spent{a.ctr != null ? ` · ${percent(a.ctr)} CTR` : ""}
            </Text>
          </View>
          {a.link ? (
            <Link src={a.link} style={s.link}>
              View ad
            </Link>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function Campaigns({ m, limit }: { m: ReportMetrics; limit: number }) {
  const rows = m.campaigns.slice(0, limit);
  if (!rows.length) return null;
  const roas = rows.some((c) => c.roas != null);
  const cols = roas ? [{ w: "40%" }, { w: "15%" }, { w: "13%" }, { w: "16%" }, { w: "16%" }] : [{ w: "50%" }, { w: "16%" }, { w: "14%" }, { w: "20%" }, { w: "0%" }];
  return (
    <View style={s.section} wrap={false}>
      <Text style={s.eyebrow}>Campaigns</Text>
      <View style={s.th}>
        <Text style={[s.thText, { width: cols[0].w }]}>Campaign</Text>
        <Text style={[s.thText, { width: cols[1].w, textAlign: "right" }]}>Spend</Text>
        <Text style={[s.thText, { width: cols[2].w, textAlign: "right" }]}>{m.conversion}</Text>
        <Text style={[s.thText, { width: cols[3].w, textAlign: "right" }]}>Cost per {singular(m.conversion)}</Text>
        {roas ? <Text style={[s.thText, { width: cols[4].w, textAlign: "right" }]}>ROAS</Text> : null}
      </View>
      {rows.map((c) => (
        <View key={c.name} style={s.tr}>
          <Text style={[s.td, { width: cols[0].w, paddingRight: 8 }]}>{c.name}</Text>
          <Text style={[s.td, { width: cols[1].w, textAlign: "right" }]}>{money(c.spend)}</Text>
          <Text style={[s.td, { width: cols[2].w, textAlign: "right" }]}>{count(c.results)}</Text>
          <Text style={[s.td, { width: cols[3].w, textAlign: "right" }]}>{money(c.costPerResult)}</Text>
          {roas ? <Text style={[s.td, { width: cols[4].w, textAlign: "right" }]}>{multiple(c.roas)}</Text> : null}
        </View>
      ))}
    </View>
  );
}

function KpiTable({ m }: { m: ReportMetrics }) {
  const w = ["28%", "18%", "18%", "14%", "22%"];
  return (
    <View style={s.section} wrap={false}>
      <Text style={s.eyebrow}>Key metrics</Text>
      <View style={s.th}>
        <Text style={[s.thText, { width: w[0] }]}>Metric</Text>
        <Text style={[s.thText, { width: w[1], textAlign: "right" }]}>{m.main.label}</Text>
        <Text style={[s.thText, { width: w[2], textAlign: "right" }]}>{m.compare.label}</Text>
        <Text style={[s.thText, { width: w[3], textAlign: "right" }]}>Change</Text>
        <Text style={[s.thText, { width: w[4], textAlign: "right" }]}>Target</Text>
      </View>
      {kpiRows(m).map((r) => (
        <View key={r.label} style={s.tr}>
          <Text style={[s.td, { width: w[0], fontFamily: "Helvetica-Bold" }]}>{r.label}</Text>
          <Text style={[s.td, { width: w[1], textAlign: "right" }]}>{r.now}</Text>
          <Text style={[s.td, { width: w[2], textAlign: "right", color: MUTED }]}>{r.before}</Text>
          <Text style={[s.td, { width: w[3], textAlign: "right", color: toneColor(r.delta), fontFamily: "Helvetica-Bold" }]}>{r.delta?.text ?? "–"}</Text>
          <Text style={[s.td, { width: w[4], textAlign: "right", color: MUTED }]}>{r.target}</Text>
        </View>
      ))}
    </View>
  );
}

function Notes({ sections }: { sections: Sections }) {
  const groups = [
    { title: "What we did", items: sections.did },
    { title: "What we're doing", items: sections.doing },
    { title: "What's next", items: sections.next },
  ].filter((g) => g.items?.length);
  if (!groups.length) return null;
  return (
    <View style={s.section}>
      {groups.map((g) => (
        <View key={g.title} style={{ marginBottom: 14 }} wrap={false}>
          <Text style={s.noteHead}>{g.title}</Text>
          {g.items.map((x, i) => (
            <View key={i} style={s.bullet}>
              <Text style={s.dot}>•</Text>
              <Text style={s.bulletText}>{x}</Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

function Mtd({ m }: { m: ReportMetrics }) {
  if (!m.mtd) return null;
  const a = m.mtd;
  const b = m.mtdCompare;
  const one = singular(m.conversion);
  const line = (p: NonNullable<ReportMetrics["mtd"]>) => `${money(p.spend)} spent, ${count(p.results)} ${m.conversion.toLowerCase()}${p.costPerResult != null ? ` at ${money(p.costPerResult)} per ${one}` : ""}${p.revenue > 0 ? `, ${multiple(p.roas)} ROAS` : ""}`;
  return (
    <View style={s.section} wrap={false}>
      <Text style={s.eyebrow}>Month to date</Text>
      <Text style={s.mtd}>
        <Text style={{ fontFamily: "Helvetica-Bold", color: INK }}>{a.label}: </Text>
        {line(a)}
        {b ? <Text style={{ color: MUTED }}>{`   vs ${b.label}: ${line(b)}`}</Text> : null}
      </Text>
    </View>
  );
}

function Band({ client, title, period }: { client: string; title: string; period: string }) {
  return (
    <View style={s.band}>
      <View style={s.bandRule} />
      <Text style={s.bandClient}>{client}</Text>
      <Text style={s.bandMeta}>
        {title} · {period}
      </Text>
    </View>
  );
}

function Weekly({ input, part, images }: { input: ReportPdfInput; part: ReportPart; images: (Buffer | null)[] }) {
  const m = part.metrics;
  return (
    <Page size="A4" style={s.page}>
      <Footer client={input.client} />
      <Band client={input.client} title={`Weekly report · ${platformName(part.platform)}`} period={input.periodLabel} />
      <Text style={s.headline}>{part.sections.headline}</Text>
      {part.sections.summary ? <Text style={s.summary}>{part.sections.summary}</Text> : null}
      <View style={s.section}>
        <Text style={s.eyebrow}>Last 7 days vs the week before</Text>
        <Tiles tiles={headlineTiles(m)} />
      </View>
      <Mtd m={m} />
      <TopAds ads={m.topAds.slice(0, 3)} images={images} conversion={m.conversion} />
      <Campaigns m={m} limit={6} />
      <Notes sections={part.sections} />
      {part.buyer ? <Text style={{ fontSize: 9, color: MUTED }}>Prepared by {part.buyer}, Kaizen Marketing</Text> : null}
    </Page>
  );
}

/** A built report covering several services: the whole account first, each service side by side, for every range. */
function Overview({ input }: { input: ReportPdfInput }) {
  const ranges = [input.parts[0].metrics, ...(input.parts[0].extra ?? [])].map((m) => m.main.label);
  const w = ["30%", "17.5%", "17.5%", "17.5%", "17.5%"];
  return (
    <Page size="A4" style={s.page}>
      <Footer client={input.client} />
      <Band client={input.client} title="The whole account" period={input.periodLabel} />
      {ranges.map((label, ri) => {
        const rows = input.parts.map((p) => ({ p, m: ri === 0 ? p.metrics : p.extra?.[ri - 1] })).filter((x): x is { p: ReportPart; m: ReportMetrics } => Boolean(x.m));
        const spend = rows.reduce((n, x) => n + x.m.main.spend, 0);
        const before = rows.reduce((n, x) => n + x.m.compare.spend, 0);
        return (
          <View key={label} style={s.section} wrap={false}>
            <Text style={s.eyebrow}>{label}</Text>
            <Text style={{ fontSize: 10, color: "#3a3a40", marginBottom: 10 }}>
              {money(spend)} across {rows.length} services{before ? `, against ${money(before)} the period before` : ""}.
            </Text>
            <View style={s.th}>
              <Text style={[s.thText, { width: w[0] }]}>Service</Text>
              <Text style={[s.thText, { width: w[1], textAlign: "right" }]}>Spend</Text>
              <Text style={[s.thText, { width: w[2], textAlign: "right" }]}>Results</Text>
              <Text style={[s.thText, { width: w[3], textAlign: "right" }]}>Per result</Text>
              <Text style={[s.thText, { width: w[4], textAlign: "right" }]}>ROAS</Text>
            </View>
            {rows.map(({ p, m }) => (
              <View key={p.platform} style={s.tr}>
                <Text style={[s.td, { width: w[0], fontFamily: "Helvetica-Bold" }]}>
                  {platformName(p.platform)} <Text style={{ color: MUTED, fontFamily: "Helvetica" }}>· {m.conversion}</Text>
                </Text>
                <Text style={[s.td, { width: w[1], textAlign: "right" }]}>{money(m.main.spend)}</Text>
                <Text style={[s.td, { width: w[2], textAlign: "right" }]}>{count(m.main.results)}</Text>
                <Text style={[s.td, { width: w[3], textAlign: "right" }]}>{money(m.main.costPerResult)}</Text>
                <Text style={[s.td, { width: w[4], textAlign: "right" }]}>{m.main.roas != null ? multiple(m.main.roas) : "–"}</Text>
              </View>
            ))}
          </View>
        );
      })}
      <View style={s.section}>
        <Text style={s.eyebrow}>In short</Text>
        {input.parts.map((p) => (
          <View key={p.platform} style={s.bullet}>
            <Text style={s.dot}>•</Text>
            <Text style={s.bulletText}>
              <Text style={{ fontFamily: "Helvetica-Bold" }}>{platformName(p.platform)}: </Text>
              {p.sections.headline}
            </Text>
          </View>
        ))}
      </View>
    </Page>
  );
}

/** A built report's other date ranges for one service, each with its headline tiles against its own comparison. */
function Ranges({ part }: { part: ReportPart }) {
  if (!part.extra?.length) return null;
  return (
    <>
      {part.extra.map((m) => (
        <View key={m.main.label} style={s.section} wrap={false}>
          <Text style={s.eyebrow}>
            {m.main.label} vs {m.compare.label}
          </Text>
          <Tiles tiles={headlineTiles(m)} />
        </View>
      ))}
    </>
  );
}

function Cover({ input }: { input: ReportPdfInput }) {
  const buyers = [...new Set(input.parts.map((p) => p.buyer).filter(Boolean))];
  return (
    <Page size="A4" style={[s.page, { backgroundColor: INK, color: "#ffffff", justifyContent: "space-between", paddingTop: 72, paddingBottom: 56 }]}>
      <Text style={{ fontSize: 10, fontFamily: "Helvetica-Bold", letterSpacing: 2, color: "#ffffff" }}>KAIZEN MARKETING</Text>
      <View>
        <View style={{ width: 40, height: 4, backgroundColor: RED, marginBottom: 22 }} />
        <Text style={{ fontSize: 40, fontFamily: "Helvetica-Bold", letterSpacing: -1, lineHeight: 1.1 }}>{input.client}</Text>
        <Text style={{ fontSize: 16, color: "#b4b4bb", marginTop: 12 }}>
          {input.kind === "built" ? "Report" : "Monthly recap"} · {input.periodLabel}
        </Text>
        <Text style={{ fontSize: 10, color: "#7a7a82", marginTop: 26 }}>{input.parts.map((p) => platformName(p.platform)).join("  ·  ")}</Text>
      </View>
      <Text style={{ fontSize: 9, color: "#7a7a82" }}>{buyers.length ? `Prepared by ${buyers.join(" and ")}` : "Prepared by Kaizen Marketing"}</Text>
    </Page>
  );
}

function MonthlyPart({ input, part, images }: { input: ReportPdfInput; part: ReportPart; images: (Buffer | null)[] }) {
  const m = part.metrics;
  return (
    <Page size="A4" style={s.page}>
      <Footer client={input.client} />
      <View style={s.platformHead}>
        <Text style={s.platformName}>{platformName(part.platform)}</Text>
        <Text style={{ fontSize: 9, color: MUTED }}>
          {m.main.label} vs {m.compare.label}
        </Text>
      </View>
      <Text style={s.headline}>{part.sections.headline}</Text>
      {part.sections.summary ? <Text style={s.summary}>{part.sections.summary}</Text> : null}
      <View style={s.section}>
        <Text style={s.eyebrow}>{input.kind === "built" ? `${m.main.label} vs ${m.compare.label}` : "Conversions"}</Text>
        <Tiles tiles={input.kind === "built" ? headlineTiles(m) : conversionTiles(m)} />
      </View>
      <Ranges part={part} />
      <KpiTable m={m} />
      {part.platform === "meta" ? <TopAds ads={m.topAds.slice(0, 3)} images={images} conversion={m.conversion} /> : null}
      <Campaigns m={m} limit={8} />
      <Notes sections={part.sections} />
      {part.extras?.trim() ? (
        <View style={s.section} wrap={false}>
          <Text style={s.eyebrow}>{input.kind === "built" ? "Also" : "Also this month"}</Text>
          <Text style={s.extras}>{part.extras.trim()}</Text>
        </View>
      ) : null}
    </Page>
  );
}

/** The report as a PDF. Weekly: one part. Monthly: one or two parts (Meta, Google) after a cover page. */
export async function renderReportPdf(input: ReportPdfInput): Promise<Uint8Array> {
  // Meta's image links are signed and expire within days, so each PDF asks for fresh ones; the saved link is the fallback
  const ids = input.parts.flatMap((p) => (p.platform === "meta" ? p.metrics.topAds.slice(0, 3).map((a) => a.id) : []));
  const { adPreviews, metaConfigured } = await import("@/lib/context/meta");
  const fresh = ids.length && metaConfigured() ? await adPreviews(ids).catch(() => new Map<string, { image: string | null }>()) : new Map<string, { image: string | null }>();
  const imageOf = async (a: { id: string; image: string | null }) => (await adImage(fresh.get(a.id)?.image ?? null)) ?? (await adImage(a.image));
  const images = await Promise.all(input.parts.map((p) => (p.platform === "meta" ? Promise.all(p.metrics.topAds.slice(0, 3).map(imageOf)) : Promise.resolve([]))));
  const title = `${input.client} · ${input.kind === "weekly" ? "Weekly report" : input.kind === "built" ? "Report" : "Monthly recap"} · ${input.periodLabel}`;
  const doc = (
    <Document title={title} author="Kaizen Marketing" creator="Kaizen Marketing" producer="Kaizen Marketing">
      {input.kind === "weekly" ? (
        input.parts.map((p, i) => <Weekly key={i} input={input} part={p} images={images[i]} />)
      ) : (
        <>
          <Cover input={input} />
          {input.kind === "built" && input.parts.length > 1 ? <Overview input={input} /> : null}
          {input.parts.map((p, i) => (
            <MonthlyPart key={i} input={input} part={p} images={images[i]} />
          ))}
        </>
      )}
    </Document>
  );
  return new Uint8Array(await renderToBuffer(doc));
}
