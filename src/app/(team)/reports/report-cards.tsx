import Link from "next/link";
import { GoogleAdsMark, MetaMark } from "@/components/source-logo";
import { tintFor } from "@/lib/colors";
import type { Qa } from "@/lib/reports/write";
import { RemoveGenerated } from "./remove-generated";

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
      {platform === "google" ? "Google Ads" : "Meta"}
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
        <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-[3px]" style={{ background: r.platform === "google" ? "#34c38f" : "#4f7cff", opacity: 0.85 }} />
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
      {removable && (
        <span className="absolute -right-1 -top-1 opacity-0 transition-opacity group-hover/card:opacity-100 max-md:opacity-100">
          <RemoveGenerated kind="report" id={r.id} sent={sent} />
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
  parts: { id: string; platform: string; status: string; owner: string | null; mine: boolean; viewedAt: string | null }[];
  href: string;
  yourTurn: boolean;
  removable: boolean;
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
      {b.removable && (
        <span className="absolute -right-1 -top-1 opacity-0 transition-opacity group-hover/card:opacity-100 max-md:opacity-100">
          <RemoveGenerated kind="bundle" id={b.id} sent={sent} />
        </span>
      )}
    </li>
  );
}

/** A section heading with its count and a note on the right. */
export function Group({ title, count, note, children }: { title: string; count: number; note?: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="flex items-baseline gap-2 font-heading text-[19px]">
          {title} <span className="tabular text-sm text-faint">{count}</span>
        </h3>
        {note && <span className="text-xs text-faint">{note}</span>}
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
