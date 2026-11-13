import Link from "next/link";
import { GoogleAdsMark, MetaMark } from "@/components/source-logo";
import { tintFor } from "@/lib/colors";
import type { Qa } from "@/lib/reports/write";
import { RegenerateButton } from "./regenerate-button";
import { RemoveGenerated } from "./remove-generated";
import { BringBack, SkipButton } from "./skip-report";

// The Reports page's line items: one card per report (or per joint report built by hand), with the client, what kind
// of report it is (the Monday weekly, the monthly recap, one built by hand) and its dates, whose it is and where it
// stands. Ready ones lead with what needs doing; sent ones with when they went.

export type Tag = { kind: "weekly" | "monthly" | "built"; label: string; dates: string };

const TAG: Record<Tag["kind"], { name: string; cls: string; dot: string }> = {
  weekly: { name: "Monday weekly", cls: "border-[#4f7cff]/30 bg-[#4f7cff]/10 text-[#7aa7ff]", dot: "bg-[#4f7cff]" },
  monthly: { name: "Monthly recap", cls: "border-brand/35 bg-brand-soft text-brand-text", dot: "bg-brand" },
  built: { name: "Built by hand", cls: "border-line bg-surface-2 text-muted", dot: "bg-faint" },
};

const initials = (n: string) =>
  n
    .replace(/[^A-Za-z0-9 ]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export function TagChip({ tag }: { tag: Tag }) {
  const t = TAG[tag.kind];
  return (
    <span className={`inline-flex max-w-full items-center gap-1.5 truncate rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${t.cls}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${t.dot}`} />
      {tag.label || t.name}
      {tag.dates && <span className="font-normal opacity-75">· {tag.dates}</span>}
    </span>
  );
}

function Avatar({ name }: { name: string }) {
  const tint = tintFor(name);
  return (
    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[13px] font-heading text-[13px] tracking-wide" style={{ background: `${tint}26`, color: tint, boxShadow: `inset 0 0 0 1px ${tint}33` }}>
      {initials(name) || "·"}
    </span>
  );
}

function Platform({ platform }: { platform: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      {platform === "google" ? <GoogleAdsMark size={11} /> : <MetaMark size={13} />}
      {platform === "google" ? "Google Ads" : platform === "tiktok" ? "TikTok" : "Meta"}
    </span>
  );
}

const STATE: Record<string, { label: string; tone: string; dot: string }> = {
  queued: { label: "Queued", tone: "text-faint", dot: "bg-faint" },
  drafting: { label: "Writing…", tone: "text-faint", dot: "bg-faint animate-pulse" },
  draft: { label: "Ready to review", tone: "text-fg", dot: "bg-ok" },
  submitted: { label: "Approved · waiting on the other buyer", tone: "text-warn", dot: "bg-warn" },
  posted: { label: "Sent", tone: "text-ok", dot: "bg-ok" },
  failed: { label: "Couldn't write it", tone: "text-bad", dot: "bg-bad" },
};

export type CardReport = { id: string; client: string; platform: string; status: string; qa: Qa | null; tag: Tag; owner: string | null; mine: boolean; viewedAt: string | null; postedAt: string | null };

// The corner of a card: its quick actions, on hover (always there on a phone), and kept open while one is asking
const CORNER = "absolute -right-1 -top-1 flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/card:opacity-100 has-[[role=dialog]]:opacity-100 max-md:opacity-100";

/** One report: the client, the kind and dates, the buyer (and whether they've opened it), the QA, the way in. */
export function ReportCard({ r, showOwner, removable = false }: { r: CardReport; showOwner: boolean; removable?: boolean }) {
  const s = STATE[r.status] ?? STATE.draft;
  const flags = r.status === "draft" ? (r.qa?.flags ?? []) : [];
  const fix = flags.filter((f) => f.severity === "fix").length;
  const alert = flags.filter((f) => f.severity === "alert").length;
  const sent = r.status === "posted";
  return (
    <li className="group/card relative">
      <Link
        href={`/reports/${r.id}`}
        className="relative grid h-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3.5 overflow-hidden rounded-[18px] border border-line bg-surface p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-faint/60 hover:shadow-[0_22px_48px_-28px_rgba(0,0,0,0.95)] active:bg-surface-2"
      >
        <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-[3px]" style={{ background: r.platform === "google" ? "#34c38f" : r.platform === "tiktok" ? "#e0508c" : "#4f7cff", opacity: 0.85 }} />
        <Avatar name={r.client} />
        <span className="grid min-w-0 gap-1.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-heading text-[16px] leading-tight">{r.client}</span>
            <Platform platform={r.platform} />
          </span>
          <TagChip tag={r.tag} />
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
            <span className={`inline-flex items-center gap-1.5 ${s.tone}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
              {sent && r.postedAt ? `Sent ${day(r.postedAt)}` : s.label}
            </span>
            {showOwner && r.owner && <span className="text-faint">· {r.mine ? "You" : r.owner}</span>}
            {showOwner && !r.mine && !sent && r.status !== "submitted" && (r.viewedAt ? <span className="text-faint">· opened {day(r.viewedAt)}</span> : <span className="text-warn">· not opened yet</span>)}
          </span>
        </span>
        <span className="flex flex-col items-end gap-1.5">
          {fix > 0 && <span className="rounded-full bg-bad-soft px-2 py-0.5 text-[11px] text-bad">{fix} to fix</span>}
          {alert > 0 && <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[11px] text-warn">{alert} alert{alert === 1 ? "" : "s"}</span>}
          {r.status === "draft" && !fix && !alert && <span className="rounded-full bg-ok-soft px-2 py-0.5 text-[11px] text-ok">QA clean</span>}
          <span className="text-faint transition-transform duration-200 group-hover/card:translate-x-0.5 group-hover/card:text-fg">→</span>
        </span>
      </Link>
      {(removable || !["queued", "drafting"].includes(r.status)) && (
        <span className={CORNER}>
          {["draft", "failed", "submitted"].includes(r.status) && <SkipButton id={r.id} title={`${r.client} · ${r.tag.label}`} variant="icon" />}
          {!["queued", "drafting"].includes(r.status) && <RegenerateButton kind="one" variant="icon" id={r.id} label={`${r.client} · ${r.tag.label}`} sent={sent} approved={r.status === "submitted"} />}
          {removable && <RemoveGenerated kind="report" id={r.id} sent={sent} />}
        </span>
      )}
    </li>
  );
}

export type CardBundle = {
  id: string;
  client: string;
  tag: Tag;
  status: string;
  sentAt: string | null;
  /** When it was built, and by whom ("you" for the person looking) */
  createdAt: string;
  createdBy: string | null;
  parts: { id: string; platform: string; status: string; owner: string | null; mine: boolean; viewedAt: string | null }[];
  href: string;
  /** A part this person can skip the report through (skipping a built report skips every part that hasn't gone out) */
  skipId: string | null;
  yourTurn: boolean;
  removable: boolean;
  /** The parts this person can regenerate (their own, approved or not; any still in review for an exec or lead) */
  regenIds: string[];
};

/** A report built by hand: one card, each service's part with its buyer and where it stands. */
export function BundleCard({ b, showOwner }: { b: CardBundle; showOwner: boolean }) {
  const sent = b.status === "sent";
  const state = sent ? { label: `Sent ${b.sentAt ? day(b.sentAt) : ""}`, tone: "text-ok" } : b.status === "failed" ? { label: "Didn't send", tone: "text-bad" } : b.yourTurn ? { label: "Your turn", tone: "text-warn" } : b.status === "waiting" ? { label: "Waiting on a part", tone: "text-warn" } : { label: "In progress", tone: "text-faint" };
  return (
    <li className="group/card relative">
      <Link
        href={b.href}
        className={`relative grid h-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3.5 overflow-hidden rounded-[18px] border bg-surface p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-faint/60 hover:shadow-[0_22px_48px_-28px_rgba(0,0,0,0.95)] ${b.yourTurn ? "border-warn/45" : "border-line"}`}
      >
        <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-[3px] bg-gradient-to-b from-[#4f7cff] to-[#34c38f] opacity-85" />
        <Avatar name={b.client} />
        <span className="grid min-w-0 gap-1.5">
          <span className="truncate font-heading text-[16px] leading-tight">{b.client}</span>
          <TagChip tag={b.tag} />
          <span className="text-[11.5px] text-faint">
            Built {new Date(b.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })} at{" "}
            {new Date(b.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}
            {b.createdBy ? ` by ${b.createdBy === "you" ? "you" : b.createdBy.split(" ")[0]}` : ""}
          </span>
          <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
            {b.parts.map((p) => (
              <span key={p.id} className={`inline-flex items-center gap-1.5 ${p.status === "submitted" || p.status === "posted" ? "text-ok" : "text-muted"}`}>
                {p.platform === "google" ? <GoogleAdsMark size={10} /> : <MetaMark size={12} />}
                {p.mine ? "You" : (p.owner ?? "Buyer")} · {p.status === "submitted" ? "approved" : p.status === "posted" ? "sent" : p.status === "drafting" ? "writing" : "to review"}
                {showOwner && !p.mine && !["submitted", "posted"].includes(p.status) && (p.viewedAt ? <span className="text-faint">· opened</span> : <span className="text-warn">· not opened</span>)}
              </span>
            ))}
          </span>
        </span>
        <span className={`text-xs ${state.tone}`}>{state.label} →</span>
      </Link>
      {(b.removable || sent || b.regenIds.length > 0 || (!sent && b.skipId)) && (
        <span className={CORNER}>
          {!sent && b.skipId && <SkipButton id={b.skipId} title={`${b.client} · ${b.tag.dates || b.tag.label}`} variant="icon" />}
          {(sent || b.regenIds.length > 0) && (
            <RegenerateButton
              kind="many"
              variant="icon"
              ids={b.regenIds}
              approvedToo
              sent={sent}
              label={`${b.client}'s report`}
              body={b.parts.length > 1 ? `Regenerate ${b.regenIds.length === 1 ? "this part" : "these parts"} with fresh data? Edits on ${b.regenIds.length === 1 ? "it" : "them"} will be replaced; the other parts stay as they are, approvals included.` : undefined}
            />
          )}
          {b.removable && <RemoveGenerated kind="bundle" id={b.id} sent={sent} />}
        </span>
      )}
    </li>
  );
}

/** A section heading with its count and a note on the right. */
export function Group({ title, count, note, action, children }: { title: string; count: number; note?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="flex items-baseline gap-2 font-heading text-[19px]">
          {title} <span className="tabular text-sm text-faint">{count}</span>
        </h3>
        {(note || action) && (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {note && <span className="text-xs text-faint">{note}</span>}
            {action}
          </span>
        )}
      </div>
      <ul className="grid gap-2.5 lg:grid-cols-2">{children}</ul>
    </section>
  );
}

export function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="grid place-items-center gap-2 rounded-[22px] border border-dashed border-line px-6 py-14 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-full bg-ok-soft text-ok">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
          <path d="M5 12.5l4.5 4.5L19 7" />
        </svg>
      </span>
      <p className="font-heading text-lg">{title}</p>
      <p className="max-w-md text-sm text-muted">{body}</p>
    </div>
  );
}

export type SkippedItem = {
  /** The report to bring back (any part of a built report) */
  id: string;
  client: string;
  platform: string | null;
  tag: Tag;
  /** "Skipped by Dana · Nov 13 · Sent it the old way" */
  line: string;
  note: string | null;
  canBringBack: boolean;
  href: string;
};

/** Skipped reports for the current period: collapsed, with who skipped them, when and why, and a way back. */
export function SkippedGroup({ items }: { items: SkippedItem[] }) {
  if (!items.length) return null;
  return (
    <details className="group grid gap-3">
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-baseline justify-between gap-2 md:min-h-0">
        <h3 className="flex items-baseline gap-2 font-heading text-[19px] text-muted">
          <span aria-hidden className="text-sm transition-transform group-open:rotate-90">›</span>
          Skipped <span className="tabular text-sm text-faint">{items.length}</span>
        </h3>
        <span className="text-xs text-faint">Waiting for the next report · kept in the client&apos;s history</span>
      </summary>
      <ul className="mt-3 grid gap-2.5 lg:grid-cols-2">
        {items.map((x) => (
          <li key={x.id} className="grid gap-2 rounded-[18px] border border-line bg-surface p-4">
            <div className="flex min-w-0 items-center gap-3">
              <Avatar name={x.client} />
              <Link href={x.href} className="grid min-w-0 flex-1 gap-1">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-heading text-[16px] leading-tight">{x.client}</span>
                  {x.platform && <Platform platform={x.platform} />}
                </span>
                <TagChip tag={x.tag} />
              </Link>
              {x.canBringBack && <BringBack id={x.id} />}
            </div>
            <p className="text-xs text-muted">{x.line}</p>
            {x.note && <p className="text-xs text-faint">&ldquo;{x.note}&rdquo;</p>}
          </li>
        ))}
      </ul>
    </details>
  );
}
