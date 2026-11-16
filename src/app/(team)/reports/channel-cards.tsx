import Link from "next/link";
import type { Qa } from "@/lib/reports/write";
import { RegenerateButton } from "./regenerate-button";
import { SkipButton } from "./skip-report";

// The email and social reports' line items on the Reports page: one card per report, with the client, the period, whose it
// is and where it stands. Ready ones lead with what needs doing; sent ones with when they went.

export type ChannelCardReport = { id: string; client: string; kind: "weekly" | "monthly"; period: string; status: string; qa: Qa | null; owner: string | null; mine: boolean; postedAt: string | null };

const STATE: Record<string, { label: string; tone: string; dot: string }> = {
  queued: { label: "Queued", tone: "text-faint", dot: "bg-faint" },
  drafting: { label: "Writing…", tone: "text-faint", dot: "bg-faint animate-pulse" },
  draft: { label: "Ready to review", tone: "text-fg", dot: "bg-ok" },
  submitted: { label: "Approved", tone: "text-warn", dot: "bg-warn" },
  posted: { label: "Sent", tone: "text-ok", dot: "bg-ok" },
  failed: { label: "Couldn't write it", tone: "text-bad", dot: "bg-bad" },
  skipped: { label: "Skipped", tone: "text-faint", dot: "bg-faint" },
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

export function ChannelCard({ r, showOwner, line }: { r: ChannelCardReport; showOwner: boolean; line: "email" | "social" }) {
  const s = STATE[r.status] ?? STATE.draft;
  const flags = r.status === "draft" ? (r.qa?.flags ?? []) : [];
  const fix = flags.filter((f) => f.severity === "fix").length;
  const alert = flags.filter((f) => f.severity === "alert").length;
  const sent = r.status === "posted";
  const title = `${r.client} · ${line === "email" ? "Email" : "Social"} ${r.period}`;
  return (
    <li className="group/card relative">
      <Link
        href={`/reports/${r.id}`}
        className="relative grid h-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3.5 overflow-hidden rounded-[18px] border border-line bg-surface p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-faint/60 active:bg-surface-2"
      >
        <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-[3px]" style={{ background: line === "email" ? "#4f7cff" : "#e0508c", opacity: 0.85 }} />
        <span aria-hidden className="grid h-10 w-10 place-items-center rounded-full bg-surface-2 text-[12px] font-semibold text-muted">
          {initials(r.client)}
        </span>
        <span className="grid min-w-0 gap-1.5">
          <span className="truncate font-heading text-[16px] leading-tight">{r.client}</span>
          <span className="truncate text-xs text-muted">
            {r.kind === "monthly" ? "Monthly report" : "Weekly report"} · {r.period}
          </span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
            <span className={`inline-flex items-center gap-1.5 ${s.tone}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
              {sent && r.postedAt ? `Sent ${day(r.postedAt)}` : s.label}
            </span>
            {showOwner && <span className="text-faint">· {r.owner ? (r.mine ? "You" : r.owner) : "No one seated"}</span>}
          </span>
        </span>
        <span className="flex flex-col items-end gap-1.5">
          {fix > 0 && <span className="rounded-full bg-bad-soft px-2 py-0.5 text-[11px] text-bad">{fix} to fix</span>}
          {alert > 0 && (
            <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[11px] text-warn">
              {alert} alert{alert === 1 ? "" : "s"}
            </span>
          )}
          {r.status === "draft" && !fix && !alert && <span className="rounded-full bg-ok-soft px-2 py-0.5 text-[11px] text-ok">QA clean</span>}
          <span className="text-faint transition-transform duration-200 group-hover/card:translate-x-0.5 group-hover/card:text-fg">→</span>
        </span>
      </Link>
      {!["queued", "drafting"].includes(r.status) && (
        <span className="absolute -right-1 -top-1 flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/card:opacity-100 has-[[role=dialog]]:opacity-100 max-md:opacity-100">
          {["draft", "failed", "submitted"].includes(r.status) && <SkipButton id={r.id} title={title} variant="icon" />}
          <RegenerateButton kind="one" variant="icon" id={r.id} label={title} sent={sent} approved={r.status === "submitted"} />
        </span>
      )}
    </li>
  );
}
