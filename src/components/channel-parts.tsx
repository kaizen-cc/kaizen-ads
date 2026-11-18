import Link from "next/link";
import { BAND_TONE } from "@/components/email-score-parts";
import { KlaviyoKeyInline } from "@/components/klaviyo-key-inline";
import { STATUS_LABEL, gapWords, moneyShort, pctText, type ChannelStatus } from "@/lib/channel-kpis/calc";
import type { ChannelRow } from "@/lib/channel-kpis/types";
import { providerName } from "@/lib/email-providers/core";

// The pieces the Email and Social boards and the email and social Overview share: the status colors, how the main
// number reads, and what to do when the data isn't connected. Server-safe (no hooks), theme tokens only.

/** Colors per status: the ads board's, plus neutral for the ones with nothing to judge */
export const TONE: Record<ChannelStatus, { text: string; pill: string; bar: string; css: string }> = {
  excellent: { text: "text-ok", pill: "bg-ok text-bg", bar: "bg-ok", css: "var(--ok)" },
  good: { text: "text-ok", pill: "bg-ok-soft text-ok", bar: "bg-ok", css: "var(--ok)" },
  close: { text: "text-warn", pill: "bg-warn-soft text-warn", bar: "bg-warn", css: "var(--warn)" },
  off: { text: "text-bad", pill: "bg-bad-soft text-bad", bar: "bg-bad", css: "var(--bad)" },
  unset: { text: "text-fg", pill: "border border-dashed border-faint/60 bg-surface-2 text-muted", bar: "bg-faint", css: "var(--fg-faint)" },
  setup: { text: "text-muted", pill: "bg-surface-2 text-muted", bar: "bg-faint", css: "var(--fg-faint)" },
  early: { text: "text-fg", pill: "bg-surface-2 text-muted", bar: "bg-faint", css: "var(--fg-faint)" },
};

/** Email statuses are the score's band (green, yellow, red), so they read as that and not as a target */
export const EMAIL_STATUS_LABEL: Partial<Record<ChannelStatus, string>> = { good: BAND_TONE.good.word, close: BAND_TONE.watch.word, off: BAND_TONE.bad.word };

export function ChannelStatusPill({ status, line }: { status: ChannelStatus; line?: "email" | "social" }) {
  const label = ((line === "email" || line === "social") && EMAIL_STATUS_LABEL[status]) || STATUS_LABEL[status];
  return <span className={`inline-flex h-6 items-center whitespace-nowrap rounded-full px-2.5 text-[11px] font-medium ${TONE[status].pill}`}>{label}</span>;
}

/** The main number as text: email revenue this month, social engagement rate */
export function mainText(r: ChannelRow): string {
  return r.line === "email" ? (r.score ? String(r.score.score) : "n/a") : pctText(r.value);
}

export function targetText(r: ChannelRow): string | null {
  if (r.target == null) return null;
  return r.line === "email" ? moneyShort(r.target, r.currency) : pctText(r.target);
}

/** What the main number is a number of, in a few words */
export function mainCaption(r: ChannelRow): string {
  if (r.line === "email") return "account score";
  return r.basis === "month" ? "engagement this month" : "engagement, last 30 days";
}

/** One line on where it's heading: the pace for email, the gap for social */
export function paceLine(r: ChannelRow): string | null {
  if (r.status === "setup") return null;
  // A source with no revenue has no pace to show
  if (r.line === "email" && r.revenueMeasured === false) return null;
  // Email: the pace against the optional monthly revenue target, as a supporting line under the score
  if (r.line === "email") {
    if (r.projected == null) return null;
    if (r.target == null) return `Revenue on pace for ${moneyShort(r.projected, r.currency)} this month`;
    return `Revenue ${moneyShort(r.projected, r.currency)} at this pace · ${gapWords(r.ratio)?.toLowerCase() ?? ""}`.replace(/ · $/, "");
  }
  if (r.target == null) return null;
  return gapWords(r.ratio);
}

export type Connect = { title: string; body: string; href: string; label: string };

/** What to do about missing or broken data: the one next step, and where to take it */
export function connectStep(r: Pick<ChannelRow, "line" | "slug" | "data" | "problem" | "status"> & { provider?: ChannelRow["provider"] }): Connect | null {
  const email = r.line === "email";
  const name = providerName(r.provider);
  const failing = r.data === "failing";
  if (r.data === "missing")
    return email
      ? { title: "Email isn't connected", body: "Pick the client's email provider (Klaviyo, Brevo or Customer.io) and paste its read-only key; the numbers start filling in. A lead or an exec can do it right here; everyone else on the client's email card.", href: `/clients/${r.slug}?tab=team`, label: "Open the email card" }
      : { title: "Social isn't linked", body: "Share their Facebook Page and Instagram account to Kaizen's Business Manager, or pick the Page on the client's Social tab.", href: `/clients/${r.slug}?service=social`, label: "Open their Social tab" };
  if (failing) return { title: email ? `${name} isn't reading` : "Social isn't reading", body: [r.problem?.message, r.problem?.fix].filter(Boolean).join(". ") || "The last read failed.", href: email ? `/clients/${r.slug}?tab=team` : `/clients/${r.slug}?service=social`, label: email ? `Fix the ${name} key` : "Fix the link" };
  if (r.data === "pending") return { title: "First read in progress", body: "Connected. The first 90 days are being read; numbers show here once they're in.", href: `/clients/${r.slug}${email ? "?service=email" : "?service=social"}`, label: "Open the client" };
  if (r.status === "setup") return { title: email ? "No numbers yet" : "Meta isn't giving reach yet", body: r.problem?.fix ?? "It can take a day after connecting.", href: `/clients/${r.slug}${email ? "?service=email" : "?service=social"}`, label: "Open the client" };
  return null;
}

/** A row needing a connection step (not connected, failing, first read pending, or connected with nothing readable) */
export const needsConnecting = (r: Pick<ChannelRow, "line" | "slug" | "data" | "problem" | "status"> & { provider?: ChannelRow["provider"] }) => connectStep(r) != null;

/** A linked call to action, the same look everywhere */
export function ConnectCta({ r, compact = false }: { r: Pick<ChannelRow, "line" | "slug" | "data" | "problem" | "status" | "clientId" | "canConnect"> & { provider?: ChannelRow["provider"] }; compact?: boolean }) {
  const c = connectStep(r);
  if (!c) return null;
  // A lead or an exec pastes (or replaces) the Klaviyo key right here, through the client card's own action; everyone else gets the link
  const inline = r.line === "email" && r.canConnect && (r.data === "missing" || r.data === "failing");
  return (
    <div className={`grid gap-2 rounded-[12px] border border-dashed border-line bg-surface-2/60 ${compact ? "p-3" : "p-4"}`}>
      <p className="text-sm font-medium">{c.title}</p>
      <p className="text-xs leading-relaxed text-muted">{c.body}</p>
      {inline ? (
        <KlaviyoKeyInline clientId={r.clientId} replace={r.data === "failing"} provider={r.data === "failing" ? (r.provider ?? null) : null} />
      ) : (
        <Link href={c.href} className="inline-flex min-h-11 w-fit items-center rounded-full bg-fg px-4 text-xs font-medium text-bg md:min-h-9">
          {c.label}
        </Link>
      )}
    </div>
  );
}

export const num = (x: number | null | undefined) => (x == null ? "n/a" : Math.round(x).toLocaleString("en-US"));
export const signed = (x: number | null | undefined) => (x == null ? "n/a" : `${x > 0 ? "+" : x < 0 ? "-" : ""}${Math.abs(Math.round(x)).toLocaleString("en-US")}`);

/** A thin gauge: how far the main number is toward its target (email: the month's pace marks where it should be) */
export function Gauge({ r }: { r: ChannelRow }) {
  // Email: the score out of 100, with a tick at the green line (80)
  if (r.line === "email") {
    if (!r.score) return null;
    return (
      <div className="relative h-1.5 rounded-full bg-surface-2" role="img" aria-label={`Score ${r.score.score} out of 100`}>
        <div className={`h-full rounded-full ${TONE[r.status].bar}`} style={{ width: `${r.score.score}%` }} />
        <span aria-hidden className="absolute -top-1 h-3.5 w-px bg-fg/40" style={{ left: "80%" }} title="Green from 80" />
      </div>
    );
  }
  if (r.target == null || r.value == null) return null;
  const fill = Math.min(1, r.value / r.target);
  const mark = r.projected != null ? Math.min(1, r.projected / r.target) : null;
  return (
    <div className="relative h-1.5 rounded-full bg-surface-2" role="img" aria-label={`${Math.round(fill * 100)}% of target`}>
      <div className={`h-full rounded-full ${TONE[r.status].bar}`} style={{ width: `${fill * 100}%` }} />
      {mark != null && r.status !== "early" && <span aria-hidden className="absolute -top-1 h-3.5 w-px bg-fg/60" style={{ left: `${mark * 100}%` }} title="Where the month lands at this pace" />}
    </div>
  );
}

/** The few supporting numbers a card shows under the chart */
export function SupportChips({ r }: { r: ChannelRow }) {
  const items =
    r.line === "email" && r.email
      ? [
          ["Revenue", moneyShort(r.value, r.currency)],
          ["Open", pctText(r.email.openRate)],
          ["Click", pctText(r.email.clickRate)],
        ]
      : r.social
        ? [
            ["Followers", signed(r.social.followersChange)],
            ["Reach", num(r.social.reach)],
            ["Posts", String(r.social.posts)],
          ]
        : [];
  return (
    <dl className="grid grid-cols-3 gap-2 border-t border-line pt-2.5">
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-[10.5px] text-faint">{k}</dt>
          <dd className="tabular truncate text-[13px] text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
