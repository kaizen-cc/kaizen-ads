import Link from "next/link";
import { Section } from "@/components/ui";

// Every report made for this client, newest first: weekly reports, monthly recaps, built reports (a joint one is one
// row, with every service in it). What it said in a line, who made it, whether it went out, and the PDF.

export type HistoryReport = {
  id: string; // the part to open (the viewer's own when they have one)
  kind: "weekly" | "monthly" | "custom" | "built";
  period: string;
  start: string;
  services: ("meta" | "google")[];
  by: string[];
  headline: string | null;
  status: "sent" | "in_progress" | "skipped" | "failed";
  sentAt: string | null;
  whole: boolean; // a built report with more than one service: its PDF is the whole thing
  link: string | null; // the client's own link, once it's gone out
};

const KIND: Record<HistoryReport["kind"], string> = { weekly: "Weekly report", monthly: "Monthly recap", custom: "Recap", built: "Report" };
const when = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
const COLOR = { meta: "#4f7cff", google: "#34c38f" } as const;

export function ReportsHistory({ reports, slug }: { reports: HistoryReport[]; slug: string }) {
  const sent = reports.filter((r) => r.status === "sent").length;
  return (
    <Section
      title="Reports"
      description={`Every report made for this client${sent ? `, ${sent} sent` : ""}. Open one to read it again or pull its PDF.`}
      action={
        <Link href={`/reports?client=${slug}`} className="inline-flex h-9 items-center rounded-full bg-fg px-4 text-sm text-bg max-md:h-11">
          Build a report
        </Link>
      }
    >
      {reports.length ? (
        <ol className="relative grid gap-2.5">
          {reports.map((r) => (
            <li key={r.id} className={`grid gap-2 rounded-[14px] border border-line bg-surface-2/50 px-4 py-3.5 ${r.status === "skipped" ? "opacity-50" : ""}`}>
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="grid min-w-0 gap-1">
                  <span className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{KIND[r.kind]}</span>
                    <span className="text-muted">· {r.period}</span>
                    {r.services.map((s) => (
                      <span key={s} className="inline-flex items-center gap-1 rounded-full bg-bg px-2 py-0.5 text-[11px] text-muted">
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: COLOR[s] }} />
                        {s === "google" ? "Google" : "Meta"}
                      </span>
                    ))}
                  </span>
                  {r.headline && <span className="line-clamp-2 text-[13px] leading-relaxed text-muted">{r.headline}</span>}
                  <span className="text-[11px] text-faint">
                    {r.by.length ? r.by.join(" and ") : "Kaizen"}
                    {r.status === "sent" && r.sentAt ? ` · sent ${when(r.sentAt)}` : r.status === "in_progress" ? " · in progress" : r.status === "failed" ? " · didn't send" : " · skipped"}
                  </span>
                </div>
                <span className="flex shrink-0 flex-wrap gap-1.5">
                  {r.status === "sent" ? (
                    <span className="rounded-full bg-ok-soft px-2.5 py-1 text-[11px] font-medium text-ok">Sent</span>
                  ) : r.status === "in_progress" ? (
                    <span className="rounded-full bg-warn-soft px-2.5 py-1 text-[11px] font-medium text-warn">In progress</span>
                  ) : null}
                </span>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                <Link href={`/reports/${r.id}`} className="text-muted hover:text-fg max-md:min-h-9 max-md:py-2">
                  Open →
                </Link>
                <a href={`/api/reports/${r.id}/pdf${r.whole ? "?whole=1" : ""}`} target="_blank" rel="noreferrer" className="text-muted hover:text-fg max-md:min-h-9 max-md:py-2">
                  PDF ↗
                </a>
                {r.link && (
                  <a href={r.link} target="_blank" rel="noreferrer" className="text-muted hover:text-fg max-md:min-h-9 max-md:py-2">
                    What the client sees ↗
                  </a>
                )}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-faint">No reports yet. Weekly ones are drafted on Mondays for accounts that spent; build one any time.</p>
      )}
    </Section>
  );
}
