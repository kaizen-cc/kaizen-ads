import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { loadReviews, myLines, rollup } from "@/lib/line-review/act";
import { REVIEW_LINE_LABEL, type ReviewLine } from "@/lib/line-review/core";
import { OverviewTabs } from "../pipeline/views/overview-tabs";
import { ReviewList, Rollup, RedraftAll } from "./reviews-view";

export const metadata: Metadata = { title: "Weekly reviews" };

// The weekly account review: drafted every Monday morning (New York) for each line head, one per client per line the
// client buys. The head reads it, edits the internal message, then approves and sends it (posted as them in the
// client's INTERNAL Slack channel) or skips it. Execs see every line and the company-wide rollup, worst first by
// retention risk, with a jump to each line's review. Tabs live in the address (?tab=). src/lib/line-review.

const fmtWeek = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export default async function ReviewsPage({ searchParams }: PageProps<"/reviews">) {
  const me = await requireStaff();
  const lines = myLines(me);
  if (!lines.length) redirect("/pipeline");
  const { client } = await searchParams;
  const db = await createClient();
  const { week, cards } = await loadReviews(db, { client: typeof client === "string" ? client : null });
  const mine = cards.filter((c) => lines.includes(c.line));
  const waiting = mine.filter((c) => c.status === "draft");
  const tabs = [
    ...(me.isExec ? [{ id: "rollup", label: "Rollup", count: rollup(mine).filter((r) => r.lines.some((l) => l.status === "draft")).length, tone: "brand" as const }] : []),
    ...lines.map((l: ReviewLine) => {
      const n = mine.filter((c) => c.line === l && c.status === "draft").length;
      return { id: l, label: REVIEW_LINE_LABEL[l], count: n, tone: "warn" as const };
    }),
    { id: "done", label: "Sent and skipped", count: mine.filter((c) => c.status !== "draft").length, tone: "quiet" as const },
  ];
  const panels: Record<string, React.ReactNode> = {};
  if (me.isExec) panels.rollup = <Rollup rows={rollup(mine)} />;
  for (const l of lines) panels[l] = <ReviewList cards={mine.filter((c) => c.line === l && c.status === "draft")} empty={`No ${REVIEW_LINE_LABEL[l]} reviews waiting this week.`} />;
  panels.done = <ReviewList cards={mine.filter((c) => c.status !== "draft")} empty="Nothing sent or skipped yet this week." />;
  return (
    <div className="mx-auto grid max-w-5xl gap-6 md:gap-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-brand-text">Weekly review · week of {fmtWeek(week)}</p>
          <h1 className="mt-1 font-heading text-[30px] leading-tight md:text-[34px]">{waiting.length ? `${waiting.length} review${waiting.length === 1 ? "" : "s"} to approve` : mine.length ? "Every review is handled" : "No reviews drafted yet"}</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-muted">
            Scope, budget pace, account changes, open commitments, results and health for every client on {me.isExec ? "every line" : `${REVIEW_LINE_LABEL[lines[0]]}`}. Each one posts as you, in the client&apos;s internal channel only.
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <Link href="/scorecard" className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[13px] hover:border-faint md:min-h-9">
            Scorecard
          </Link>
          {me.isExec && (
            <Link href="/economics" className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[13px] hover:border-faint md:min-h-9">
              Economics
            </Link>
          )}
          {me.isExec && <RedraftAll />}
        </div>
      </header>
      <OverviewTabs tabs={tabs} panels={panels} />
    </div>
  );
}
