import type { ReactNode } from "react";
import {
  int,
  moveOf,
  pct,
  signed,
  takeawaysFor,
  type EmailMetrics,
} from "@/lib/channel-reports/core";
import {
  headlineSentence,
  LINK_KIND_LABEL,
  usualText,
  type Engagement,
  type LinkKind,
  type Measure,
} from "@/lib/channel-reports/email-engagement";
import type { Sections } from "@/lib/reports/write";
import type { Move } from "@/lib/reports/weekly-core";
import { AdImage } from "./ad-image";

// The engagement email report on the live page (/r/<token>) for a client whose revenue can't be read: the same view the
// PDF draws (email-engagement.ts) in the page's light look, mobile first. Reach, engagement, clicks to the site and the
// list against the period before and the client's own usual; what people clicked; takeaways with what we'll do next; the
// best and the lowest email; the eight-week trend; list health; SMS when texts went out. Sections with nothing are left out.

const KIND_BG: Record<LinkKind, string> = {
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
const dayText = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
const moveTone = (mv: Move) =>
  !mv || mv.tone === "flat"
    ? "text-muted"
    : mv.tone === "good"
      ? "text-ok"
      : "text-bad";

function Block({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: string | null;
  children: ReactNode;
}) {
  return (
    <section className="break-inside-avoid">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-[11px] font-medium tracking-[0.12em] text-muted uppercase">
          {title}
        </h2>
        {sub && <p className="text-[12px] text-faint">{sub}</p>}
      </div>
      {children}
    </section>
  );
}

function MoveText({
  mv,
  before,
  prior,
}: {
  mv: Move;
  before: string;
  prior: string;
}) {
  if (!mv)
    return (
      <span className="text-faint">
        {before === "–" ? "No prior number" : `${before} prior ${prior}`}
      </span>
    );
  return (
    <span>
      <span
        className={`font-medium ${moveTone(mv)}`}
      >{`${mv.up ? "+" : "-"}${mv.pct}`}</span>
      <span className="text-faint">{` vs ${before} prior ${prior}`}</span>
    </span>
  );
}

function Usual({
  x,
  lowerIsBetter = false,
}: {
  x: Pick<Measure, "word" | "vsUsual">;
  lowerIsBetter?: boolean;
}) {
  const t = usualText(x);
  if (!t) return null;
  const good =
    x.word === "in line" ? null : (x.word === "above") !== lowerIsBetter;
  const cls =
    good == null
      ? "bg-surface-2 text-muted"
      : good
        ? "bg-ok-soft text-ok"
        : "bg-warn-soft text-warn";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium ${cls}`}
    >
      {t.replace(/^./, (c) => c.toUpperCase())}
    </span>
  );
}

function Tile({
  title,
  value,
  sub,
  mv,
  before,
  prior,
  usual,
  lowerIsBetter,
}: {
  title: string;
  value: string;
  sub?: string | null;
  mv: Move;
  before: string;
  prior: string;
  usual?: Pick<Measure, "word" | "vsUsual"> | null;
  lowerIsBetter?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-xl border border-line bg-surface p-4 sm:p-5">
      <p className="text-[11px] tracking-[0.08em] text-muted uppercase">
        {title}
      </p>
      <p className="mt-2 font-heading text-[26px] tracking-tight tabular-nums [overflow-wrap:anywhere] sm:text-3xl">
        {value}
      </p>
      <p className="mt-1 text-[13px] tabular-nums">
        <MoveText mv={mv} before={before} prior={prior} />
      </p>
      {sub && <p className="mt-1 text-[13px] text-muted">{sub}</p>}
      {usual && usualText(usual) ? (
        <div className="mt-auto pt-3">
          <Usual x={usual} lowerIsBetter={lowerIsBetter} />
        </div>
      ) : null}
    </div>
  );
}

export function EngagementRecap({
  m,
  sections,
  shots,
}: {
  m: EmailMetrics & { engagement: Engagement };
  sections: Sections;
  shots: Record<string, string>;
}) {
  const e = m.engagement;
  const prior =
    m.kind === "monthly" ? "month" : m.kind === "weekly" ? "week" : "period";
  const l = e.list;
  const takeaways = takeawaysFor(m, sections.takeaways) as {
    title: string;
    text: string;
    next?: string;
  }[];
  const best = e.picks
    ? e.campaigns.find((c) => c.id === e.picks!.best.id)
    : null;
  const lowest = e.picks
    ? e.campaigns.find((c) => c.id === e.picks!.lowest.id)
    : null;
  const max = Math.max(1, ...e.trend.map((w) => w.clicks));
  const perWeek =
    e.clicks.usual != null
      ? (e.clicks.usual * 7) / Math.max(1, e.periodDays)
      : null;
  const total = e.clicks.basis === "total";
  return (
    <>
      <Block
        title="How email performed"
        sub={`Against the ${prior} before and your usual ${prior}`}
      >
        <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4">
          <Tile
            title="People reached"
            value={int(e.reached.now)}
            sub={`${e.sends.now} ${e.sends.now === 1 ? "email" : "emails"} delivered`}
            mv={moveOf(e.reached.now, e.reached.before)}
            before={int(e.reached.before)}
            prior={prior}
            usual={e.reached}
          />
          <Tile
            title="Engaged · opens"
            value={int(e.opens.now)}
            sub={
              total
                ? `${int(e.clickers.now)} people clicked · ${pct(e.openRate.now, 0)} opened`
                : `${pct(e.openRate.now, 0)} of the people reached opened`
            }
            mv={moveOf(e.opens.now, e.opens.before)}
            before={int(e.opens.before)}
            prior={prior}
            usual={e.opens}
          />
          <Tile
            title={total ? "Clicks to your site" : "People who clicked"}
            value={int(e.clicks.now)}
            sub={`${pct(e.ctor.now, 1)} of openers clicked`}
            mv={moveOf(e.clicks.now, e.clicks.before)}
            before={int(e.clicks.before)}
            prior={prior}
            usual={e.clicks}
          />
          <Tile
            title={l.net != null ? "List growth" : "Your list"}
            value={l.net != null ? signed(l.net) : int(l.size)}
            sub={
              l.net != null
                ? `${int(l.size)} on ${l.name ?? "your list"} · ${int(l.unsubscribes)} unsubscribed`
                : `Contacts on ${l.name ?? "your list"} · ${int(l.unsubscribes)} unsubscribed`
            }
            mv={
              l.net != null
                ? moveOf(l.size, l.sizeBefore)
                : moveOf(l.unsubscribes, l.unsubscribesBefore, "down")
            }
            before={
              l.net != null
                ? int(l.sizeBefore)
                : `${int(l.unsubscribesBefore)} unsubscribed`
            }
            prior={prior}
          />
        </div>
        <p className="mt-4 border-l-[3px] border-brand pl-3 text-[15px] leading-relaxed">
          {headlineSentence(e, m.kind)}
        </p>
        {e.mtd && (
          <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border border-line bg-surface p-4 sm:grid-cols-4">
            <p className="col-span-2 text-[11px] tracking-[0.08em] text-muted uppercase sm:col-span-4">{`Month to date · ${e.mtd.window.label} vs the same days last month`}</p>
            {[
              ["Emails sent", e.mtd.sends[0], e.mtd.sends[1], "none"] as const,
              [
                "People reached",
                e.mtd.reached[0],
                e.mtd.reached[1],
                "up",
              ] as const,
              [
                total ? "Clicks to your site" : "People who clicked",
                e.mtd.clicks[0],
                e.mtd.clicks[1],
                "up",
              ] as const,
              ...(e.mtd.net[0] != null
                ? [["List growth", e.mtd.net[0], e.mtd.net[1], "up"] as const]
                : []),
            ].map(([k, a, b, better]) => {
              const mv = moveOf(a, b, better);
              return (
                <div key={k} className="min-w-0">
                  <p className="text-[11px] text-faint">{k}</p>
                  <p className="mt-0.5 font-heading text-lg tabular-nums">
                    {k === "List growth" ? signed(a) : int(a)}{" "}
                    {mv && (
                      <span
                        className={`text-[12px] font-medium ${moveTone(mv)}`}
                      >{`${mv.up ? "+" : "-"}${mv.pct}`}</span>
                    )}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </Block>

      {e.links && e.links.rows.length > 0 && (
        <Block
          title="What people clicked"
          sub={`${int(e.links.total)} link clicks across ${e.links.campaigns} ${e.links.campaigns === 1 ? "email" : "emails"}`}
        >
          <div className="grid gap-4 rounded-xl border border-line bg-surface p-4 sm:p-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <ul className="grid gap-3">
              {e.links.rows.map((r, i) => (
                <li key={r.key} className="min-w-0">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="min-w-0 truncate text-[14px] font-medium">
                      <span
                        className="mr-2 inline-block size-2 rounded-full"
                        style={{ background: KIND_BG[r.kind] }}
                      />
                      {r.label}
                    </p>
                    <p className="shrink-0 text-[13px] tabular-nums">
                      <span className="font-medium">{int(r.clicks)}</span>{" "}
                      <span className="text-faint">
                        {Math.round(r.share * 100)}%
                      </span>
                    </p>
                  </div>
                  <div className="mt-1.5 h-1.5 rounded-full bg-surface-2">
                    <div
                      className={`h-1.5 rounded-full ${i === 0 ? "bg-brand" : ""}`}
                      style={{
                        width: `${Math.max(3, (r.clicks / e.links!.rows[0].clicks) * 100)}%`,
                        ...(i === 0 ? {} : { background: KIND_BG[r.kind] }),
                      }}
                    />
                  </div>
                  <p className="mt-1 truncate text-[11px] text-faint">
                    {r.url
                      .replace(/^https?:\/\/(www\.)?/i, "")
                      .replace(/[?#].*$/, "")}
                  </p>
                </li>
              ))}
            </ul>
            <div className="min-w-0 lg:border-l lg:border-line lg:pl-5">
              <p className="text-[11px] tracking-[0.08em] text-muted uppercase">
                By destination
              </p>
              <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-surface-2">
                {e.links.byKind.map((k) => (
                  <span
                    key={k.kind}
                    style={{
                      width: `${k.share * 100}%`,
                      background: KIND_BG[k.kind],
                    }}
                  />
                ))}
              </div>
              <ul className="mt-3 grid gap-2 text-[13px]">
                {e.links.byKind.map((k) => (
                  <li
                    key={k.kind}
                    className="flex items-center justify-between gap-3"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="size-2 rounded-sm"
                        style={{ background: KIND_BG[k.kind] }}
                      />
                      {LINK_KIND_LABEL[k.kind]}
                    </span>
                    <span className="font-medium tabular-nums">
                      {Math.round(k.share * 100)}%
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Block>
      )}

      {takeaways.length > 0 && (
        <Block title="Key takeaways">
          <div className="grid gap-4 sm:grid-cols-3">
            {takeaways.map((t, i) => (
              <div
                key={i}
                className="flex flex-col overflow-hidden rounded-xl border border-line bg-surface"
              >
                <div className="flex-1 p-5">
                  <div className="mb-3 h-[3px] w-6 bg-brand" />
                  <p className="font-heading text-base">{t.title}</p>
                  <p className="mt-2 text-[14px] leading-relaxed text-muted">
                    {t.text}
                  </p>
                </div>
                {t.next?.trim() && (
                  <div className="border-t border-line bg-brand-soft px-5 py-3">
                    <p className="text-[10px] font-medium tracking-[0.12em] text-brand-text uppercase">
                      Next
                    </p>
                    <p className="mt-1 text-[14px]">{t.next}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Block>
      )}

      {e.campaigns.length > 0 && (
        <Block
          title={`Your emails · ${e.campaigns.length} sent`}
          sub="Click to open: of the people who opened, the share who clicked"
        >
          {best && lowest && (
            <div className="mb-4 grid gap-4 lg:grid-cols-2">
              {[
                { c: best, tone: "best" as const, why: e.picks!.best.why },
                {
                  c: lowest,
                  tone: "lowest" as const,
                  why: e.picks!.lowest.why,
                },
              ].map(({ c, tone, why }) => (
                <article
                  key={c.id}
                  className="grid grid-cols-[96px_minmax(0,1fr)] overflow-hidden rounded-xl border border-line bg-surface sm:grid-cols-[140px_minmax(0,1fr)]"
                >
                  <div className="relative aspect-[2/3] w-full overflow-hidden border-r border-line bg-surface-2">
                    <AdImage src={shots[c.id] ?? null} top />
                    {!shots[c.id] && (
                      <span className="absolute inset-0 grid place-items-center p-2 text-center text-[11px] text-faint">
                        {c.subject ?? c.name}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 p-4 sm:p-5">
                    <p className="text-[11px] font-medium tracking-[0.1em] uppercase">
                      <span
                        className={tone === "best" ? "text-ok" : "text-warn"}
                      >
                        {tone === "best" ? "Best email" : "Lowest email"}
                      </span>
                      <span className="text-brand-text">{` · ${dayText(c.date)}`}</span>
                    </p>
                    <p className="mt-1 line-clamp-2 font-heading text-base leading-snug [overflow-wrap:anywhere]">
                      {c.subject ?? c.name}
                    </p>
                    <p
                      className={`mt-3 font-heading text-3xl tabular-nums ${tone === "best" ? "text-ok" : "text-warn"}`}
                    >
                      {pct(c.ctor, 1)}
                    </p>
                    <p className="text-[12px] text-muted">
                      of the people who opened it clicked
                    </p>
                    <dl className="mt-3 grid grid-cols-4 gap-2 text-[13px] tabular-nums">
                      {[
                        ["Reached", int(c.delivered)],
                        ["Opened", pct(c.openRate, 0)],
                        ["Clicks", int(c.clicks)],
                        ["Unsubs", int(c.unsubscribes)],
                      ].map(([k, v]) => (
                        <div key={k} className="min-w-0">
                          <dt className="truncate text-[10px] tracking-[0.06em] text-faint uppercase">
                            {k}
                          </dt>
                          <dd className="font-medium">{v}</dd>
                        </div>
                      ))}
                    </dl>
                    <p className="mt-3 text-[13px] leading-relaxed text-muted">
                      <span
                        className={`font-medium ${tone === "best" ? "text-ok" : "text-warn"}`}
                      >
                        Why:{" "}
                      </span>
                      {why}
                    </p>
                  </div>
                </article>
              ))}
            </div>
          )}
          <div className="overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full min-w-[560px] text-[13px] tabular-nums">
              <thead>
                <tr className="border-b border-line text-left text-[10px] tracking-[0.08em] text-faint uppercase">
                  <th className="px-4 py-2.5 font-medium">Email</th>
                  <th className="px-3 py-2.5 text-right font-medium">Sent</th>
                  <th className="px-3 py-2.5 text-right font-medium">
                    Reached
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium">Opened</th>
                  <th className="px-3 py-2.5 text-right font-medium">
                    Clicked
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium">
                    Click to open
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">Clicks</th>
                </tr>
              </thead>
              <tbody>
                {e.campaigns.map((c) => (
                  <tr
                    key={c.id}
                    className={`border-b border-line last:border-0 ${c.small ? "text-muted" : ""}`}
                  >
                    <td className="max-w-[260px] px-4 py-2.5">
                      <p className="truncate font-medium">
                        {c.subject ?? c.name}
                      </p>
                      {c.small ? (
                        <p className="text-[11px] text-faint">
                          A small or test send
                        </p>
                      ) : c.topLink ? (
                        <p className="truncate text-[11px] text-faint">{`Most clicked: ${c.topLink}`}</p>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      {dayText(c.date).replace(/^\w+, /, "")}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {int(c.delivered)}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {pct(c.openRate, 0)}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {pct(c.clickRate, 1)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-medium">
                      {pct(c.ctor, 1)}
                    </td>
                    <td className="px-4 py-2.5 text-right">{int(c.clicks)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Block>
      )}

      {e.trend.filter((w) => w.sends).length >= 2 && (
        <Block
          title="Eight-week trend"
          sub={
            perWeek != null
              ? `Dashed line: your usual week, ${int(perWeek)}`
              : null
          }
        >
          <div className="rounded-xl border border-line bg-surface p-4 sm:p-5">
            <p className="text-[11px] tracking-[0.08em] text-muted uppercase">
              {total
                ? "Clicks to your site, each week"
                : "People who clicked, each week"}
            </p>
            <div className="relative mt-6 flex h-40 items-end gap-2 sm:gap-4">
              {perWeek != null && perWeek <= max && (
                <div
                  className="absolute inset-x-0 border-t border-dashed border-fg/30"
                  style={{ bottom: `${(perWeek / max) * 100}%` }}
                />
              )}
              {e.trend.map((w) => (
                <div
                  key={w.start}
                  className="flex h-full min-w-0 flex-1 flex-col items-center justify-end"
                >
                  <span className="mb-1 text-[11px] font-medium tabular-nums">
                    {w.sends ? int(w.clicks) : "–"}
                  </span>
                  <div
                    className={`w-full max-w-10 rounded-t ${w.inPeriod ? "bg-brand" : "bg-surface-2"}`}
                    style={{ height: `${(w.clicks / max) * 100}%` }}
                  />
                </div>
              ))}
            </div>
            <div className="mt-2 flex gap-2 sm:gap-4">
              {e.trend.map((w) => (
                <div key={w.start} className="min-w-0 flex-1 text-center">
                  <p
                    className={`truncate text-[11px] ${w.inPeriod ? "font-medium" : "text-muted"}`}
                  >
                    {w.label}
                  </p>
                  <p className="truncate text-[10px] text-faint">
                    {w.sends ? `${w.sends} sent` : "No email"}
                  </p>
                  <p className="truncate text-[10px] text-faint">
                    {w.openRate != null && w.sends
                      ? `${Math.round(w.openRate * 100)}% opened`
                      : ""}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </Block>
      )}

      <Block title="Audience and list health">
        <div className="grid gap-4 rounded-xl border border-line bg-surface p-4 sm:p-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <div className="min-w-0">
            <p className="text-[11px] tracking-[0.08em] text-muted uppercase">
              {l.name ?? "Your list"}
            </p>
            <p className="mt-1 font-heading text-3xl tabular-nums">
              {int(l.size)}{" "}
              <span className="text-[13px] font-normal text-muted">
                {l.sizeAt
                  ? `contacts on ${dayText(l.sizeAt).replace(/^\w+, /, "")}`
                  : "contacts"}
              </span>
            </p>
            <dl className="mt-3 grid gap-2 text-[13px] tabular-nums">
              {l.net != null && (
                <Row
                  k="Net change"
                  v={signed(l.net)}
                  mv={moveOf(l.net, l.netBefore)}
                />
              )}
              {l.joined != null && (
                <Row
                  k="New contacts"
                  v={int(l.joined)}
                  mv={moveOf(l.joined, l.joinedBefore)}
                />
              )}
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
            </dl>
          </div>
          <div className="min-w-0 lg:border-l lg:border-line lg:pl-5">
            <p className="text-[11px] tracking-[0.08em] text-muted uppercase">
              Delivery
            </p>
            <p className="mt-1 text-[13px] text-muted">{`${int(e.reached.now)} delivered of ${int(e.recipients.now)} sent`}</p>
            <dl className="mt-3 grid gap-2 text-[13px] tabular-nums">
              {(
                [
                  ["Bounce rate", e.bounceRate, 2, true],
                  ["Unsubscribe rate", e.unsubRate, 2, true],
                  ["Spam complaints", e.spamRate, 3, true],
                  ["Open rate", e.openRate, 1, false],
                ] as const
              ).map(([k, x, d, low]) => (
                <div
                  key={k}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-line pt-2"
                >
                  <dt>{k}</dt>
                  <dd className="flex items-center gap-3">
                    <span className="font-medium">{pct(x.now, d)}</span>
                    <Usual x={x} lowerIsBetter={low} />
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </Block>

      {e.sms && (
        <Block
          title={`SMS · ${e.sms.campaigns} ${e.sms.campaigns === 1 ? "campaign" : "campaigns"}`}
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile
              title="Texts sent"
              value={int(e.sms.sent)}
              mv={moveOf(e.sms.sent, e.sms.before.sent, "none")}
              before={int(e.sms.before.sent)}
              prior={prior}
            />
            <Tile
              title="Delivered"
              value={int(e.sms.delivered)}
              mv={moveOf(e.sms.delivered, e.sms.before.delivered)}
              before={int(e.sms.before.delivered)}
              prior={prior}
            />
            {(e.sms.clicks > 0 || e.sms.before.clicks > 0) && (
              <Tile
                title="Clicks"
                value={int(e.sms.clicks)}
                mv={moveOf(e.sms.clicks, e.sms.before.clicks)}
                before={int(e.sms.before.clicks)}
                prior={prior}
              />
            )}
            <Tile
              title="Opt-outs"
              value={int(e.sms.optOuts)}
              mv={moveOf(e.sms.optOuts, e.sms.before.optOuts, "down")}
              before={int(e.sms.before.optOuts)}
              prior={prior}
            />
          </div>
        </Block>
      )}

      <p className="text-[12px] leading-relaxed text-faint">{e.measures}</p>
    </>
  );
}

function Row({ k, v, mv }: { k: string; v: string; mv: Move }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line pt-2">
      <dt>{k}</dt>
      <dd className="flex items-center gap-3">
        <span className="font-medium">{v}</span>
        {mv && (
          <span
            className={`text-[12px] font-medium ${moveTone(mv)}`}
          >{`${mv.up ? "+" : "-"}${mv.pct}`}</span>
        )}
      </dd>
    </div>
  );
}
