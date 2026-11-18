import { Fragment } from "react";
import { G, Image, Line, Rect, Svg, Text, View } from "@react-pdf/renderer";
import { docKit, type Look } from "@/lib/reports/weekly-doc";
import type { Sections } from "@/lib/reports/write";
import type { Move } from "@/lib/reports/weekly-core";
import {
  fitFont,
  int,
  moveOf,
  pct,
  priorWordOf,
  signed,
  takeawaysFor,
  type EmailMetrics,
} from "./core";
import {
  headlineSentence,
  LINK_KIND_LABEL,
  usualText,
  type Engagement,
  type EngagementCampaign,
  type LinkKind,
  type Measure,
} from "./email-engagement";
import { pdfText } from "./social-report";

// The engagement email report's pages (a client whose revenue can't be read), drawn under the shared masthead and hero
// (channel-doc.tsx) in the house style. Two pages, laid out on purpose, every section only when it has numbers:
//   1. The headline: reach, engagement, clicks to the site and the list, each against the period before and the account's
//      own usual; the month to date as one row; what people clicked; the takeaways with what we'll do next.
//   2. The detail: the best and the lowest email by click to open with their pictures and every email in one table, the
//      eight-week trend, the audience and list health in one card, and SMS when texts went out.
// No Kaizen grade or bar anywhere: the only yardsticks are the period before and the client's own usual.

const { s, Arrow, Hot, toneOf, INK, MUTED, FAINT, LINE, INNER, GOOD } =
  docKit;
const GAP = 8;
const AMBER = { fg: "#a1650f", bg: "#fdf1dc" };
const SLATE = { fg: "#5f6f80", bg: "#eef2f5" };
const KIND_HEX: Record<LinkKind, string> = {
  booking: "#c8102e",
  tickets: "#e0663a",
  events: "#24364d",
  menu: "#a1650f",
  social: "#7a5af8",
  directions: "#0e8a74",
  contact: "#3b82c4",
  jobs: "#8a6d3b",
  press: "#94a2b0",
  website: "#5d7184",
};

type HotOf = (what: string) => string | null;
type Images = Record<string, string | null>;

const label = {
  fontSize: 6.3,
  color: "#5f6f82",
  fontFamily: "Helvetica-Bold" as const,
  textTransform: "uppercase" as const,
  letterSpacing: 0.7,
  maxLines: 1,
  textOverflow: "ellipsis" as const,
};
const day = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
const weekday = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    timeZone: "UTC",
  });
const short = (n: number | null) =>
  n == null
    ? "–"
    : n >= 10_000
      ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`
      : Math.round(n).toLocaleString("en-US");
const SvgTextRaw = Text as unknown as React.FC<{
  x: number;
  y: number;
  fill?: string;
  textAnchor?: "start" | "middle" | "end";
  style?: Record<string, unknown>;
  children: React.ReactNode;
}>;
function SvgText({
  x,
  y,
  anchor = "middle",
  fill,
  size = 6.4,
  bold = true,
  children,
}: {
  x: number;
  y: number;
  anchor?: "start" | "middle" | "end";
  fill: string;
  size?: number;
  bold?: boolean;
  children: React.ReactNode;
}) {
  return (
    <SvgTextRaw
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
    </SvgTextRaw>
  );
}

function Head({ title, sub }: { title: string; sub?: string | null }) {
  return (
    <View style={s.head}>
      <Text style={s.h2}>{title}</Text>
      {sub ? (
        <Text style={[s.sub, { maxWidth: 330, textAlign: "right" }]}>
          {sub}
        </Text>
      ) : null}
    </View>
  );
}

function Chip({ mv }: { mv: Move }) {
  if (!mv) return null;
  const c = toneOf(mv);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        height: 12,
        borderRadius: 3.5,
        paddingHorizontal: 4,
        backgroundColor: c.bg,
        marginRight: 4,
      }}
    >
      {mv.pct !== "0.0%" ? (
        <View style={{ marginRight: 2.5 }}>
          <Arrow up={mv.up} color={c.fg} />
        </View>
      ) : null}
      <Text
        style={{ fontSize: 6.6, fontFamily: "Helvetica-Bold", color: c.fg }}
      >
        {mv.pct}
      </Text>
    </View>
  );
}

/** Against the client's own usual: green above, amber below, slate in line (flipped for what should stay low) */
function UsualPill({
  x,
  lowerIsBetter = false,
  compact = false,
}: {
  x: Pick<Measure, "word" | "vsUsual">;
  lowerIsBetter?: boolean;
  compact?: boolean;
}) {
  const t = usualText(x);
  if (!t) return null;
  const good =
    x.word === "in line" ? null : (x.word === "above") !== lowerIsBetter;
  const c = good == null ? SLATE : good ? GOOD : AMBER;
  return (
    <View
      style={{
        alignSelf: "flex-start",
        flexDirection: "row",
        alignItems: "center",
        height: compact ? 11 : 13,
        borderRadius: 6.5,
        paddingHorizontal: 6,
        backgroundColor: c.bg,
      }}
    >
      <View
        style={{
          width: 4,
          height: 4,
          borderRadius: 2,
          backgroundColor: c.fg,
          marginRight: 4,
        }}
      />
      <Text
        style={{
          fontSize: compact ? 5.8 : 6.4,
          fontFamily: "Helvetica-Bold",
          color: c.fg,
        }}
      >
        {(compact ? t.replace(" your usual", " usual") : t).replace(
          /^./,
          (ch) => ch.toUpperCase(),
        )}
      </Text>
    </View>
  );
}

// ─── The headline ──────────────────────────────────────────────────────────

const TileRule = () => <View style={{ width: 1, backgroundColor: "#edf1f4", marginVertical: 12 }} />;

function BigTile({
  title,
  value,
  second,
  sub,
  mv,
  before,
  beforeText,
  prior,
  usual,
  width,
  hot,
  lowerIsBetter,
}: {
  title: string;
  value: string;
  second?: string | null;
  sub?: string | null;
  mv: Move;
  before: string;
  beforeText?: string | null;
  prior: string;
  usual?: Pick<Measure, "word" | "vsUsual"> | null;
  width: number;
  hot?: string | null;
  lowerIsBetter?: boolean;
}) {
  const pad = 12;
  return (
    <View
      style={{
        width,
        height: 100,
        paddingHorizontal: pad,
        paddingTop: 10,
        paddingBottom: 8,
      }}
    >
      <Text style={label}>{title}</Text>
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-end",
          height: 25,
          marginTop: 4,
        }}
      >
        <Text
          style={{
            fontSize: fitFont(
              value,
              width - pad * 2 - (second ? 50 : 0),
              22,
              12,
            ),
            fontFamily: "Helvetica-Bold",
            letterSpacing: -0.6,
            color: INK,
            lineHeight: 1,
          }}
        >
          {value}
        </Text>
        {second ? (
          <Text
            style={{
              fontSize: 7.4,
              fontFamily: "Helvetica-Bold",
              color: MUTED,
              marginLeft: 5,
              marginBottom: 2,
            }}
          >
            {second}
          </Text>
        ) : null}
      </View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          height: 12,
          marginTop: 5,
        }}
      >
        <Chip mv={mv} />
        <Text
          style={{
            fontSize: 6.2,
            color: MUTED,
            maxLines: 1,
            textOverflow: "ellipsis",
            flexShrink: 1,
          }}
        >
          {beforeText ??
            (before === "–"
              ? "No prior number"
              : `vs ${before} prior ${prior}`)}
        </Text>
      </View>
      {sub ? (
        <Text
          style={{
            fontSize: 6.3,
            color: MUTED,
            marginTop: 4,
            lineHeight: 1.3,
            maxLines: 2,
            textOverflow: "ellipsis",
          }}
        >
          {sub}
        </Text>
      ) : null}
      <View style={{ position: "absolute", left: pad, bottom: 9 }}>
        {usual ? <UsualPill x={usual} lowerIsBetter={lowerIsBetter} /> : null}
      </View>
      <Hot href={hot ?? null} />
    </View>
  );
}

function Headline({
  m,
  e,
  hot,
  look,
}: {
  m: EmailMetrics;
  e: Engagement;
  hot: HotOf;
  look: Look;
}) {
  const prior = priorWordOf(m.kind);
  const l = e.list;
  const listValue = l.net != null ? signed(l.net) : int(l.size);
  const listTitle = l.net != null ? "List growth" : "Your list";
  const listSub =
    l.net != null
      ? [
          l.size != null
            ? `${int(l.size)} on ${l.name ? pdfText(l.name) : "your list"}`
            : null,
          `${int(l.unsubscribes)} unsubscribed${l.joined != null ? `, ${int(l.joined)} joined` : ""}`,
        ]
          .filter(Boolean)
          .join(" · ")
      : `Contacts on ${l.name ? pdfText(l.name) : "your list"}`;
  const w = (INNER - 2 - 3) / 4;
  return (
    <View style={s.section} wrap={false}>
      <Head
        title="How email performed"
        sub={`${m.main.label} · against the ${prior} before and your usual ${prior}${e.history ? ` (average of the ${Math.round(e.history.days / 7)} weeks before)` : ""}`}
      />
      <View
        style={{
          flexDirection: "row",
          backgroundColor: "#ffffff",
          borderWidth: 1,
          borderColor: LINE,
          borderRadius: 10,
          height: 102,
        }}
      >
        <BigTile
          title="People reached"
          value={int(e.reached.now)}
          sub={`${e.sends.now} ${e.sends.now === 1 ? "email" : "emails"} delivered`}
          mv={moveOf(e.reached.now, e.reached.before)}
          before={int(e.reached.before)}
          prior={prior}
          usual={e.reached}
          width={w}
          hot={hot("tile/0")}
        />
        <TileRule />
        <BigTile
          title="Engaged · opens"
          value={int(e.opens.now)}
          sub={
            e.clicks.basis === "total"
              ? `${int(e.clickers.now)} people clicked · ${pct(e.openRate.now, 0)} opened`
              : `${pct(e.openRate.now, 0)} of the people reached opened`
          }
          mv={moveOf(e.opens.now, e.opens.before)}
          before={int(e.opens.before)}
          prior={prior}
          usual={e.opens}
          width={w}
          hot={hot("tile/1")}
        />
        <TileRule />
        <BigTile
          title={
            e.clicks.basis === "total"
              ? "Clicks to your site"
              : "People who clicked"
          }
          value={int(e.clicks.now)}
          sub={`${pct(e.ctor.now, 1)} of openers clicked`}
          mv={moveOf(e.clicks.now, e.clicks.before)}
          before={int(e.clicks.before)}
          prior={prior}
          usual={e.clicks}
          width={w}
          hot={hot("tile/2")}
        />
        <TileRule />
        <BigTile
          title={listTitle}
          value={listValue}
          sub={listSub}
          mv={
            l.net != null
              ? moveOf(l.size, l.sizeBefore)
              : moveOf(l.unsubscribes, l.unsubscribesBefore, "down")
          }
          before={l.net != null ? int(l.sizeBefore) : int(l.unsubscribesBefore)}
          beforeText={
            l.net != null
              ? null
              : `${int(l.unsubscribes)} unsubscribed (${int(l.unsubscribesBefore)} prior)`
          }
          prior={prior}
          width={w}
          hot={hot("tile/3")}
        />
      </View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          marginTop: 8,
          paddingHorizontal: 2,
        }}
      >
        <View
          style={{
            width: 3,
            height: 12,
            borderRadius: 1.5,
            backgroundColor: look.primary,
            marginRight: 7,
          }}
        />
        <Text style={{ fontSize: 8.2, color: INK, lineHeight: 1.35, flex: 1 }}>
          {headlineSentence(e, m.kind)}
        </Text>
      </View>
      <MonthToDate e={e} />
    </View>
  );
}

/** A weekly's month to date as one slim row under the headline: sends, reach, clicks and list growth against the same days last month */
function MonthToDate({ e }: { e: Engagement }) {
  const x = e.mtd;
  if (!x) return null;
  const cells: { label: string; value: string; mv: Move; before: string }[] = [
    {
      label: "Emails sent",
      value: int(x.sends[0]),
      mv: moveOf(x.sends[0], x.sends[1], "none"),
      before: int(x.sends[1]),
    },
    {
      label: "People reached",
      value: int(x.reached[0]),
      mv: moveOf(x.reached[0], x.reached[1]),
      before: int(x.reached[1]),
    },
    {
      label:
        e.clicks.basis === "total"
          ? "Clicks to your site"
          : "People who clicked",
      value: int(x.clicks[0]),
      mv: moveOf(x.clicks[0], x.clicks[1]),
      before: int(x.clicks[1]),
    },
    ...(x.net[0] != null
      ? [
          {
            label: "List growth",
            value: signed(x.net[0]),
            mv: moveOf(x.net[0], x.net[1]),
            before: signed(x.net[1]),
          },
        ]
      : []),
  ];
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        marginTop: 9,
        backgroundColor: "#ffffff",
        borderWidth: 1,
        borderColor: LINE,
        borderRadius: 8,
        paddingVertical: 7,
        paddingHorizontal: 12,
      }}
    >
      <View style={{ width: 96 }}>
        <Text style={label}>Month to date</Text>
        <Text
          style={{ fontSize: 5.8, color: FAINT, marginTop: 2 }}
        >{`${x.window.label.replace(/^(\w{3})\w*/, "$1")} vs same days last month`}</Text>
      </View>
      {cells.map((c) => (
        <View
          key={c.label}
          style={{
            flex: 1,
            paddingLeft: 10,
            borderLeftWidth: 1,
            borderLeftColor: "#edf1f4",
          }}
        >
          <Text
            style={{
              fontSize: 5.6,
              color: "#6f7f92",
              fontFamily: "Helvetica-Bold",
              textTransform: "uppercase",
              letterSpacing: 0.4,
            }}
          >
            {c.label}
          </Text>
          <View
            style={{ flexDirection: "row", alignItems: "center", marginTop: 2 }}
          >
            <Text
              style={{
                fontSize: 10,
                fontFamily: "Helvetica-Bold",
                letterSpacing: -0.2,
                marginRight: 5,
              }}
            >
              {c.value}
            </Text>
            <Chip mv={c.mv} />
            <Text style={{ fontSize: 5.8, color: FAINT }}>
              {c.before === "–" ? "" : `vs ${c.before}`}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}

function WhatClicked({ e, look }: { e: Engagement; look: Look }) {
  const v = e.links;
  if (!v || !v.rows.length) return null;
  const leftW = INNER * 0.6;
  const rightW = INNER - leftW - GAP - 26;
  const max = Math.max(...v.rows.map((r) => r.clicks));
  const where = (url: string) =>
    pdfText(
      url
        .replace(/^https?:\/\/(www\.)?/i, "")
        .replace(/[?#].*$/, "")
        .replace(/\/$/, ""),
    ).slice(0, 52);
  return (
    <View style={s.section} wrap={false}>
      <Head
        title="What people clicked"
        sub={`${int(v.total)} link clicks across ${v.campaigns} ${v.campaigns === 1 ? "email" : "emails"} · where email sent people`}
      />
      <View style={[s.panel, { flexDirection: "row", paddingVertical: 11 }]}>
        <View
          style={{
            width: leftW,
            paddingRight: 14,
            borderRightWidth: 1,
            borderRightColor: "#edf1f4",
          }}
        >
          {v.rows.slice(0, 5).map((r, i) => (
            <View key={r.key} style={{ marginTop: i ? 7 : 0 }}>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <View
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: KIND_HEX[r.kind],
                    marginRight: 5,
                  }}
                />
                <Text
                  style={{
                    fontSize: 7.8,
                    fontFamily: "Helvetica-Bold",
                    color: INK,
                    maxLines: 1,
                  }}
                >
                  {pdfText(r.label)}
                </Text>
                <Text
                  style={{
                    flex: 1,
                    fontSize: 5.6,
                    color: FAINT,
                    marginLeft: 6,
                    maxLines: 1,
                    textOverflow: "ellipsis",
                  }}
                >
                  {where(r.url)}
                </Text>
                <Text
                  style={{
                    fontSize: 7.6,
                    fontFamily: "Helvetica-Bold",
                    color: INK,
                    marginLeft: 6,
                  }}
                >
                  {int(r.clicks)}
                  <Text
                    style={{ fontFamily: "Helvetica", color: MUTED }}
                  >{`  ${Math.round(r.share * 100)}%`}</Text>
                </Text>
              </View>
              <View
                style={{
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: "#eef2f5",
                  marginTop: 3.5,
                }}
              >
                <View
                  style={{
                    width: `${Math.max(3, (r.clicks / max) * 100)}%`,
                    height: 4,
                    borderRadius: 2,
                    backgroundColor: i === 0 ? look.primary : KIND_HEX[r.kind],
                  }}
                />
              </View>
            </View>
          ))}
        </View>
        <View style={{ width: rightW, paddingLeft: 14 }}>
          <Text style={label}>By destination</Text>
          <View
            style={{
              flexDirection: "row",
              height: 9,
              borderRadius: 4.5,
              overflow: "hidden",
              marginTop: 7,
              backgroundColor: "#eef2f5",
            }}
          >
            {v.byKind.map((k) => (
              <View
                key={k.kind}
                style={{
                  width: `${k.share * 100}%`,
                  backgroundColor: KIND_HEX[k.kind],
                }}
              />
            ))}
          </View>
          {v.byKind.slice(0, 6).map((k) => (
            <View
              key={k.kind}
              style={{
                flexDirection: "row",
                alignItems: "center",
                marginTop: 7,
              }}
            >
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 1.5,
                  backgroundColor: KIND_HEX[k.kind],
                  marginRight: 6,
                }}
              />
              <Text style={{ flex: 1, fontSize: 7.2, color: INK }}>
                {LINK_KIND_LABEL[k.kind]}
              </Text>
              <Text
                style={{
                  fontSize: 7.4,
                  fontFamily: "Helvetica-Bold",
                  color: INK,
                }}
              >{`${Math.round(k.share * 100)}%`}</Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

function Takeaways({
  m,
  sections,
  look,
  hot,
}: {
  m: EmailMetrics;
  sections: Sections;
  look: Look;
  hot: HotOf;
}) {
  const items = takeawaysFor(m, sections.takeaways) as {
    title: string;
    text: string;
    next?: string;
  }[];
  if (!items.length) return null;
  return (
    <View style={s.section} wrap={false}>
      <Head
        title="Key takeaways"
        sub="What the numbers say, and what we'll do next"
      />
      <View style={s.insights}>
        {items.map((t, i) => (
          <View
            key={i}
            style={[
              s.insight,
              {
                paddingTop: 10,
                paddingBottom: t.next ? 0 : 10,
                overflow: "hidden",
              },
            ]}
          >
            <View
              style={{
                width: 14,
                height: 2.5,
                borderRadius: 2,
                backgroundColor: look.primary,
                marginBottom: 6,
              }}
            />
            <View>
              <Text style={s.insightTitle}>{pdfText(t.title)}</Text>
              <Hot href={hot(`text/takeaway-${i}-title`)} />
            </View>
            <View style={{ flexGrow: 1 }}>
              <Text style={[s.insightText, { fontSize: 7.3, lineHeight: 1.4 }]}>
                {pdfText(t.text)}
              </Text>
              <Hot href={hot(`text/takeaway-${i}-text`)} />
            </View>
            {t.next?.trim() ? (
              <View
                style={{
                  marginTop: 7,
                  marginHorizontal: -12,
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  backgroundColor: look.barsSoft,
                  borderTopWidth: 1,
                  borderTopColor: LINE,
                }}
              >
                <Text
                  style={{
                    fontSize: 5.8,
                    fontFamily: "Helvetica-Bold",
                    color: look.primary,
                    letterSpacing: 0.6,
                    textTransform: "uppercase",
                  }}
                >
                  Next
                </Text>
                <Text
                  style={{
                    fontSize: 7.2,
                    color: INK,
                    lineHeight: 1.35,
                    marginTop: 2,
                  }}
                >
                  {pdfText(t.next)}
                </Text>
              </View>
            ) : null}
          </View>
        ))}
      </View>
    </View>
  );
}

// ─── The detail ────────────────────────────────────────────────────────────

const CARD_H = 176;
const PIC_W = 100;

function Pick({
  c,
  tone,
  why,
  pic,
  look,
  w,
}: {
  c: EngagementCampaign;
  tone: "best" | "lowest";
  why: string;
  pic: string | null | undefined;
  look: Look;
  w: number;
}) {
  const t = tone === "best" ? GOOD : AMBER;
  const stat = (k: string, v: string) => (
    <View style={{ width: "25%", marginTop: 7 }}>
      <Text style={[label, { fontSize: 5.2, letterSpacing: 0.3 }]}>{k}</Text>
      <Text
        style={{
          fontSize: 9,
          fontFamily: "Helvetica-Bold",
          color: INK,
          marginTop: 2,
          letterSpacing: -0.2,
        }}
      >
        {v}
      </Text>
    </View>
  );
  return (
    <View
      wrap={false}
      style={{
        width: w,
        height: CARD_H,
        flexDirection: "row",
        backgroundColor: "#ffffff",
        borderWidth: 1,
        borderColor: LINE,
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          width: PIC_W,
          height: CARD_H,
          borderRightWidth: 1,
          borderRightColor: LINE,
          backgroundColor: "#eef2f5",
        }}
      >
        {pic ? (
          // eslint-disable-next-line jsx-a11y/alt-text -- a PDF image, no alt prop
          <Image
            src={pic}
            style={{
              width: PIC_W,
              height: CARD_H,
              objectFit: "cover",
              objectPosition: "top",
            }}
          />
        ) : (
          <View
            style={{
              flex: 1,
              alignItems: "center",
              justifyContent: "center",
              paddingHorizontal: 10,
            }}
          >
            <Text
              style={{
                fontSize: 7.5,
                fontFamily: "Helvetica-Bold",
                color: MUTED,
                letterSpacing: 0.8,
              }}
            >
              EMAIL
            </Text>
            <Text
              style={{
                fontSize: 6.2,
                color: FAINT,
                marginTop: 3,
                textAlign: "center",
                lineHeight: 1.3,
              }}
            >
              {pdfText(c.subject ?? c.name).slice(0, 70)}
            </Text>
          </View>
        )}
      </View>
      <View
        style={{
          flex: 1,
          paddingHorizontal: 11,
          paddingTop: 10,
          paddingBottom: 9,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <View
            style={{
              height: 11,
              borderRadius: 3,
              paddingHorizontal: 5,
              backgroundColor: t.bg,
              justifyContent: "center",
              marginRight: 6,
            }}
          >
            <Text
              style={{
                fontSize: 5.8,
                fontFamily: "Helvetica-Bold",
                color: t.fg,
                letterSpacing: 0.5,
              }}
            >
              {tone === "best" ? "BEST EMAIL" : "LOWEST EMAIL"}
            </Text>
          </View>
          <Text
            style={{
              fontSize: 6,
              fontFamily: "Helvetica-Bold",
              color: look.primary,
              letterSpacing: 0.6,
              textTransform: "uppercase",
            }}
          >{`${weekday(c.date)} ${day(c.date)}`}</Text>
        </View>
        <Text
          style={{
            fontSize: 8.8,
            fontFamily: "Helvetica-Bold",
            color: INK,
            lineHeight: 1.22,
            marginTop: 5,
            maxLines: 2,
            textOverflow: "ellipsis",
          }}
        >
          {pdfText(c.subject ?? c.name)}
        </Text>
        <View
          style={{
            marginTop: 7,
            paddingTop: 6,
            borderTopWidth: 1,
            borderTopColor: "#edf1f4",
          }}
        >
          <Text
            style={{
              fontSize: 18,
              fontFamily: "Helvetica-Bold",
              color: tone === "best" ? GOOD.fg : AMBER.fg,
              letterSpacing: -0.5,
              lineHeight: 1,
            }}
          >
            {pct(c.ctor, 1)}
          </Text>
          <Text style={{ fontSize: 6.2, color: MUTED, marginTop: 2 }}>
            of the people who opened it clicked
          </Text>
        </View>
        <View style={{ flexDirection: "row" }}>
          {stat("Reached", int(c.delivered))}
          {stat("Opened", pct(c.openRate, 0))}
          {stat("Clicks", int(c.clicks))}
          {stat("Unsubs", int(c.unsubscribes))}
        </View>
        <Text
          style={{
            fontSize: 6.5,
            color: INK,
            lineHeight: 1.35,
            marginTop: 7,
            maxLines: 4,
            textOverflow: "ellipsis",
          }}
        >
          <Text style={{ fontFamily: "Helvetica-Bold", color: t.fg }}>
            Why:{" "}
          </Text>
          {pdfText(why)}
        </Text>
      </View>
    </View>
  );
}

function Campaigns({
  e,
  images,
  look,
}: {
  e: Engagement;
  images: Images;
  look: Look;
}) {
  const rows = e.campaigns;
  if (!rows.length) return null;
  const best = e.picks ? rows.find((c) => c.id === e.picks!.best.id) : null;
  const lowest = e.picks ? rows.find((c) => c.id === e.picks!.lowest.id) : null;
  const half = (INNER - GAP) / 2;
  const th = {
    fontSize: 5.4,
    color: "#6f7f92",
    fontFamily: "Helvetica-Bold" as const,
    textTransform: "uppercase" as const,
    letterSpacing: 0.25,
    textAlign: "right" as const,
  };
  const cols: {
    key: string;
    head: string;
    w: number;
    v: (c: EngagementCampaign) => string;
  }[] = [
    { key: "date", head: "Sent", w: 40, v: (c) => day(c.date) },
    { key: "reached", head: "Reached", w: 48, v: (c) => int(c.delivered) },
    { key: "open", head: "Opened", w: 40, v: (c) => pct(c.openRate, 0) },
    { key: "click", head: "Clicked", w: 40, v: (c) => pct(c.clickRate, 1) },
    { key: "ctor", head: "Click to open", w: 54, v: (c) => pct(c.ctor, 1) },
    { key: "clicks", head: "Clicks", w: 40, v: (c) => int(c.clicks) },
  ];
  const lines = rows.length > 8 ? 1 : 2;
  const topCtor = Math.max(
    ...rows.filter((c) => !c.small).map((c) => c.ctor ?? 0),
  );
  return (
    <View style={s.section}>
      <View wrap={false} minPresenceAhead={120}>
        <Head
          title="Your emails"
          sub={`${rows.length} ${rows.length === 1 ? "email" : "emails"} sent · click to open: of the people who opened, the share who clicked`}
        />
        {best && lowest ? (
          <View style={{ flexDirection: "row", gap: GAP }}>
            <Pick
              c={best}
              tone="best"
              why={e.picks!.best.why}
              pic={images[`shot:${best.id}`]}
              look={look}
              w={half}
            />
            <Pick
              c={lowest}
              tone="lowest"
              why={e.picks!.lowest.why}
              pic={images[`shot:${lowest.id}`]}
              look={look}
              w={half}
            />
          </View>
        ) : null}
      </View>
      <View
        style={[s.panel, { paddingVertical: 8, marginTop: GAP }]}
        wrap={rows.length > 18}
      >
        <View style={s.th}>
          <Text style={[th, { flex: 1, textAlign: "left" }]}>Email</Text>
          {cols.map((c) => (
            <Text key={c.key} style={[th, { width: c.w }]}>
              {c.head}
            </Text>
          ))}
        </View>
        {rows.map((r, i) => (
          <View
            key={r.id}
            wrap={false}
            style={[
              s.tr,
              {
                paddingVertical: 5,
                borderBottomWidth: i === rows.length - 1 ? 0 : 1,
              },
            ]}
          >
            <View style={{ flex: 1, paddingRight: 8 }}>
              <Text
                style={{
                  fontSize: 7.2,
                  fontFamily: r.small ? "Helvetica-Oblique" : "Helvetica-Bold",
                  color: r.small ? MUTED : INK,
                  lineHeight: 1.25,
                  maxLines: lines,
                  textOverflow: "ellipsis",
                }}
              >
                {pdfText(r.subject ?? r.name)}
              </Text>
              {r.topLink && !r.small ? (
                <Text
                  style={{
                    fontSize: 5.8,
                    color: MUTED,
                    marginTop: 1.5,
                    maxLines: 1,
                  }}
                >{`Most clicked: ${pdfText(r.topLink)}`}</Text>
              ) : r.small ? (
                <Text style={{ fontSize: 5.8, color: FAINT, marginTop: 1.5 }}>
                  A small or test send
                </Text>
              ) : null}
            </View>
            {cols.map((c) => (
              <Text
                key={c.key}
                style={{
                  width: c.w,
                  fontSize: 7.2,
                  textAlign: "right",
                  color: r.small
                    ? MUTED
                    : c.key === "ctor" && r.ctor === topCtor && !r.small
                      ? GOOD.fg
                      : INK,
                  fontFamily: c.key === "ctor" ? "Helvetica-Bold" : "Helvetica",
                }}
              >
                {c.v(r)}
              </Text>
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

function Trend({ e, look }: { e: Engagement; look: Look }) {
  const weeks = e.trend;
  if (weeks.filter((w) => w.sends).length < 2) return null;
  const W = INNER - 26;
  const H = 112;
  const left = 4;
  const top = 16;
  const base = H - 22;
  const max = Math.max(...weeks.map((w) => w.clicks), 1);
  const slot = (W - left) / weeks.length;
  const bar = Math.min(34, slot * 0.5);
  const y = (v: number) => base - (v / max) * (base - top);
  // The usual for one week: the period's usual clicks scaled to seven days
  const perWeek =
    e.clicks.usual != null
      ? (e.clicks.usual * 7) / Math.max(1, e.periodDays)
      : null;
  const usualLabel =
    perWeek != null && perWeek > 0 && perWeek <= max * 1.05
      ? `Your usual week: ${short(perWeek)}`
      : null;
  // Per email: the open rate and click to open each week, as two lines under the bars
  const LH = 62;
  const rates = weeks.map((w) =>
    w.sends ? { open: w.openRate, ctor: w.ctor } : null,
  );
  const hiRate = Math.max(
    0.05,
    ...rates.flatMap((r) => (r ? [r.open ?? 0, r.ctor ?? 0] : [])),
  );
  const ry = (v: number) => LH - 12 - (v / hiRate) * (LH - 24);
  const cx = (i: number) => left + i * slot + slot / 2;
  const series = (key: "open" | "ctor", color: string) => {
    const pts = rates.map((r, i) =>
      r && r[key] != null ? { x: cx(i), y: ry(r[key]!), v: r[key]! } : null,
    );
    const lines = pts.map((p, i) => {
      const prev = pts.slice(0, i).reverse().find(Boolean);
      return p && prev ? (
        <Line
          key={`${key}l${i}`}
          x1={prev.x}
          y1={prev.y}
          x2={p.x}
          y2={p.y}
          stroke={color}
          strokeWidth={1.3}
        />
      ) : null;
    });
    const dots = pts.map((p, i) =>
      p ? (
        <Rect
          key={`${key}d${i}`}
          x={p.x - 1.8}
          y={p.y - 1.8}
          width={3.6}
          height={3.6}
          rx={1.8}
          fill={color}
        />
      ) : null,
    );
    const labels = pts.map((p, i) =>
      p ? (
        <SvgText
          key={`${key}t${i}`}
          x={p.x}
          y={key === "open" ? p.y - 4.5 : p.y + 9}
          fill={color}
          size={5.4}
        >{`${Math.round(p.v * 100)}%`}</SvgText>
      ) : null,
    );
    return [...lines, ...dots, ...labels];
  };
  const open = "#24364d";
  return (
    <View style={s.section} wrap={false}>
      <Head
        title="Eight-week trend"
        sub={`${e.clicks.basis === "total" ? "Clicks to your site" : "People who clicked"} each week, with reach under each and how each week's emails were read`}
      />
      <View style={[s.panel, { paddingVertical: 10 }]}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            marginBottom: 2,
          }}
        >
          <Text style={[label, { flex: 1 }]}>
            {e.clicks.basis === "total"
              ? "Clicks to your site, each week"
              : "People who clicked, each week"}
          </Text>
          {usualLabel ? (
            <>
              <Svg
                width={14}
                height={4}
                viewBox="0 0 14 4"
                style={{ marginRight: 4 }}
              >
                <Line
                  x1={0}
                  y1={2}
                  x2={14}
                  y2={2}
                  stroke={MUTED}
                  strokeWidth={0.8}
                  strokeDasharray="3 2.5"
                />
              </Svg>
              <Text style={{ fontSize: 6.2, color: MUTED }}>{usualLabel}</Text>
            </>
          ) : null}
        </View>
        <Svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
          <Line
            x1={left}
            y1={base}
            x2={W}
            y2={base}
            stroke={LINE}
            strokeWidth={1}
          />
          {usualLabel ? (
            <Line
              x1={left}
              y1={y(perWeek!)}
              x2={W}
              y2={y(perWeek!)}
              stroke={MUTED}
              strokeWidth={0.7}
              strokeDasharray="3 2.5"
            />
          ) : null}
          {weeks.map((w, i) => {
            const x = left + i * slot + (slot - bar) / 2;
            const label = w.sends ? short(w.clicks) : "No email";
            const ly = w.clicks > 0 ? y(w.clicks) - 3 : base - 3;
            return (
              <G key={w.start}>
                {w.clicks > 0 ? (
                  <Rect
                    x={x}
                    y={y(w.clicks)}
                    width={bar}
                    height={Math.max(1, base - y(w.clicks))}
                    rx={2}
                    fill={w.inPeriod ? look.primary : "#c9d3de"}
                  />
                ) : null}
                {/* The value sits on a white chip so the usual line never runs through it */}
                <Rect
                  x={x + bar / 2 - label.length * 1.9 - 2}
                  y={ly - 6.2}
                  width={label.length * 3.8 + 4}
                  height={8}
                  rx={2}
                  fill="#ffffff"
                />
                <SvgText
                  x={x + bar / 2}
                  y={ly}
                  fill={w.clicks > 0 ? INK : FAINT}
                  size={6.2}
                >
                  {label}
                </SvgText>
                <SvgText
                  x={x + bar / 2}
                  y={base + 9}
                  fill={w.inPeriod ? INK : MUTED}
                  size={6}
                  bold={w.inPeriod}
                >
                  {w.label}
                </SvgText>
                <SvgText
                  x={x + bar / 2}
                  y={base + 18}
                  fill={FAINT}
                  size={5.4}
                  bold={false}
                >
                  {w.sends ? `${w.sends} sent · ${short(w.delivered)}` : ""}
                </SvgText>
              </G>
            );
          })}
        </Svg>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            marginTop: 4,
            paddingTop: 7,
            borderTopWidth: 1,
            borderTopColor: "#edf1f4",
          }}
        >
          <Text style={[label, { flex: 1 }]}>Per email, each week</Text>
          <View
            style={{
              width: 8,
              height: 2,
              backgroundColor: open,
              marginRight: 4,
            }}
          />
          <Text style={{ fontSize: 6.2, color: MUTED, marginRight: 12 }}>
            Open rate
          </Text>
          <View
            style={{
              width: 8,
              height: 2,
              backgroundColor: look.primary,
              marginRight: 4,
            }}
          />
          <Text style={{ fontSize: 6.2, color: MUTED }}>Click to open</Text>
        </View>
        <Svg width={W} height={LH} viewBox={`0 0 ${W} ${LH}`}>
          {series("open", open)}
          {series("ctor", look.primary)}
        </Svg>
      </View>
    </View>
  );
}

function HealthRow({
  name,
  x,
  digits,
  lowerIsBetter = true,
  mv,
}: {
  name: string;
  x: Measure;
  digits: number;
  lowerIsBetter?: boolean;
  mv: Move;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        height: 22,
        borderTopWidth: 1,
        borderTopColor: "#f0f3f6",
      }}
    >
      <Text style={{ flex: 1, fontSize: 7.2, color: INK, maxLines: 1 }}>
        {name}
      </Text>
      <Text
        style={{
          width: 40,
          fontSize: 7.8,
          fontFamily: "Helvetica-Bold",
          color: INK,
          textAlign: "right",
          marginRight: 6,
        }}
      >
        {pct(x.now, digits)}
      </Text>
      <View style={{ width: 44, alignItems: "flex-end" }}>
        {mv ? (
          <Chip mv={mv} />
        ) : (
          <Text style={{ fontSize: 6, color: FAINT }}>–</Text>
        )}
      </View>
      <View style={{ width: 82, alignItems: "flex-end" }}>
        <UsualPill x={x} lowerIsBetter={lowerIsBetter} compact />
      </View>
    </View>
  );
}

function ListHealth({
  m,
  e,
  look,
}: {
  m: EmailMetrics;
  e: Engagement;
  look: Look;
}) {
  const l = e.list;
  const half = (INNER - 26) * 0.42;
  const hist = l.history.length >= 2 ? l.history : null;
  const prior = priorWordOf(m.kind);
  return (
    <View style={s.section} wrap={false}>
      <Head
        title="Audience and list health"
        sub={`${m.main.label} against the ${prior} before and your usual`}
      />
      <View style={[s.panel, { flexDirection: "row", paddingVertical: 12 }]}>
        <View
          style={{
            width: half,
            paddingRight: 9,
            borderRightWidth: 1,
            borderRightColor: "#edf1f4",
          }}
        >
          <Text style={label}>{l.name ? pdfText(l.name) : "Your list"}</Text>
          <View
            style={{
              flexDirection: "row",
              alignItems: "flex-end",
              marginTop: 5,
            }}
          >
            <Text
              style={{
                fontSize: 20,
                fontFamily: "Helvetica-Bold",
                letterSpacing: -0.5,
                lineHeight: 1,
              }}
            >
              {int(l.size)}
            </Text>
            <Text
              style={{
                fontSize: 6.6,
                color: MUTED,
                marginLeft: 5,
                marginBottom: 2,
              }}
            >
              {l.sizeAt ? `contacts on ${day(l.sizeAt)}` : "contacts"}
            </Text>
          </View>
          {hist ? (
            <Svg
              width={half - 9}
              height={30}
              viewBox={`0 0 ${half - 9} 30`}
              style={{ marginTop: 6 }}
            >
              {(() => {
                const lo = Math.min(...hist.map((h) => h.size));
                const hi = Math.max(...hist.map((h) => h.size));
                const sx = (i: number) =>
                  (i / (hist.length - 1)) * (half - 13) + 2;
                const sy = (v: number) =>
                  hi === lo ? 15 : 26 - ((v - lo) / (hi - lo)) * 22;
                return hist.map((h, i) =>
                  i ? (
                    <Line
                      key={h.date}
                      x1={sx(i - 1)}
                      y1={sy(hist[i - 1].size)}
                      x2={sx(i)}
                      y2={sy(h.size)}
                      stroke={look.primary}
                      strokeWidth={1.4}
                    />
                  ) : null,
                );
              })()}
            </Svg>
          ) : null}
          <View style={{ marginTop: hist ? 4 : 10 }}>
            {l.net != null ? (
              <Row
                k="Net change"
                v={signed(l.net)}
                mv={moveOf(l.net, l.netBefore)}
              />
            ) : null}
            {l.joined != null ? (
              <Row
                k="New contacts"
                v={int(l.joined)}
                mv={moveOf(l.joined, l.joinedBefore)}
              />
            ) : null}
            <Row
              k="Unsubscribed"
              v={int(l.unsubscribes)}
              mv={moveOf(l.unsubscribes, l.unsubscribesBefore, "down")}
            />
            <Row
              k="Emails sent"
              v={int(e.sends.now)}
              mv={moveOf(e.sends.now, e.sends.before, "none")}
            />
            {e.sends.now ? (
              <Row
                k="Reached per email"
                v={int(Math.round((e.reached.now ?? 0) / e.sends.now))}
                mv={moveOf(
                  (e.reached.now ?? 0) / e.sends.now,
                  e.sends.before
                    ? (e.reached.before ?? 0) / e.sends.before
                    : null,
                )}
              />
            ) : null}
          </View>
        </View>
        <View style={{ flex: 1, paddingLeft: 12 }}>
          <Text style={label}>Delivery</Text>
          <Text
            style={{
              fontSize: 6.2,
              color: MUTED,
              marginTop: 3,
              marginBottom: 6,
            }}
          >{`${int(e.reached.now)} delivered of ${int(e.recipients.now)} sent`}</Text>
          <HealthRow
            name="Bounce rate"
            x={e.bounceRate}
            digits={2}
            mv={moveOf(e.bounceRate.now, e.bounceRate.before, "down")}
          />
          <HealthRow
            name="Unsubscribe rate"
            x={e.unsubRate}
            digits={2}
            mv={moveOf(e.unsubRate.now, e.unsubRate.before, "down")}
          />
          <HealthRow
            name="Spam complaints"
            x={e.spamRate}
            digits={3}
            mv={moveOf(e.spamRate.now, e.spamRate.before, "down")}
          />
          <HealthRow
            name="Open rate"
            x={e.openRate}
            digits={1}
            lowerIsBetter={false}
            mv={moveOf(e.openRate.now, e.openRate.before)}
          />
        </View>
      </View>
    </View>
  );
}

function Row({ k, v, mv }: { k: string; v: string; mv: Move }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        height: 20,
        borderTopWidth: 1,
        borderTopColor: "#f0f3f6",
      }}
    >
      <Text style={{ flex: 1, fontSize: 7.2, color: INK }}>{k}</Text>
      <Text
        style={{
          fontSize: 7.8,
          fontFamily: "Helvetica-Bold",
          color: INK,
          marginRight: 6,
        }}
      >
        {v}
      </Text>
      <View style={{ width: 46, alignItems: "flex-end" }}>
        {mv ? (
          <Chip mv={mv} />
        ) : (
          <Text style={{ fontSize: 6, color: FAINT }}>–</Text>
        )}
      </View>
    </View>
  );
}

function Sms({ m, e }: { m: EmailMetrics; e: Engagement }) {
  const x = e.sms;
  if (!x) return null;
  const prior = priorWordOf(m.kind);
  const cells = [
    {
      k: "Texts sent",
      v: int(x.sent),
      mv: moveOf(x.sent, x.before.sent, "none"),
    },
    {
      k: "Delivered",
      v: int(x.delivered),
      mv: moveOf(x.delivered, x.before.delivered),
    },
    ...(x.clicks || x.before.clicks
      ? [
          {
            k: "Clicks",
            v: int(x.clicks),
            mv: moveOf(x.clicks, x.before.clicks),
          },
        ]
      : []),
    {
      k: "Opt-outs",
      v: int(x.optOuts),
      mv: moveOf(x.optOuts, x.before.optOuts, "down"),
    },
  ];
  return (
    <View style={s.section} wrap={false}>
      <Head
        title="SMS"
        sub={`${x.campaigns} text ${x.campaigns === 1 ? "campaign" : "campaigns"} · against the ${prior} before`}
      />
      <View style={[s.panel, { flexDirection: "row", paddingVertical: 10 }]}>
        {cells.map((c, i) => (
          <View
            key={c.k}
            style={{
              flex: 1,
              paddingLeft: i ? 12 : 0,
              borderLeftWidth: i ? 1 : 0,
              borderLeftColor: "#edf1f4",
            }}
          >
            <Text style={label}>{c.k}</Text>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                marginTop: 4,
              }}
            >
              <Text
                style={{
                  fontSize: 13,
                  fontFamily: "Helvetica-Bold",
                  marginRight: 6,
                }}
              >
                {c.v}
              </Text>
              <Chip mv={c.mv} />
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

/** The engagement report's body: every section only when it has something to show */
export function EngagementBody({
  m,
  images,
  look,
  hot,
  sections,
}: {
  m: EmailMetrics;
  images: Images;
  look: Look;
  hot: HotOf;
  sections: Sections;
}) {
  const e = m.engagement!;
  return (
    <Fragment>
      <Headline m={m} e={e} hot={hot} look={look} />
      <WhatClicked e={e} look={look} />
      <Takeaways m={m} sections={sections} look={look} hot={hot} />
      <Campaigns e={e} images={images} look={look} />
      <Trend e={e} look={look} />
      <ListHealth m={m} e={e} look={look} />
      <Sms m={m} e={e} />
    </Fragment>
  );
}
