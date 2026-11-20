import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HEAD_LINE, REVIEW_LINE_LABEL, weekStartOf } from "@/lib/line-review/core";

// On a line head's (and an exec's) Overview, under Today: this week's weekly account reviews still waiting for their
// approval, the riskiest first, one tap to the Weekly reviews page. Nothing shows once every review is sent or skipped.

const nyToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

export async function ReviewsCallout({ db, me }: { db: SupabaseClient; me: { role: string; isExec: boolean } }) {
  const line = HEAD_LINE[me.role];
  if (!me.isExec && !line) return null;
  let q = db.from("line_reviews").select("id, line, risk, clients!inner(name)").eq("week_start", weekStartOf(nyToday())).eq("status", "draft").order("risk", { ascending: false }).limit(200);
  if (!me.isExec) q = q.eq("line", line);
  const { data } = await q;
  const rows = (data ?? []) as unknown as { id: string; line: keyof typeof REVIEW_LINE_LABEL; risk: number; clients: { name: string } }[];
  if (!rows.length) return null;
  const top = rows.slice(0, 4);
  return (
    <section className="grid gap-3 rounded-[20px] border border-line bg-surface p-5 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="grid gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-brand-text">Weekly review</span>
          <h2 className="font-heading text-xl">
            {rows.length} review{rows.length === 1 ? "" : "s"} waiting for your approval
          </h2>
        </div>
        <Link href={me.isExec ? "/reviews" : `/reviews?tab=${line}`} className="inline-flex min-h-11 items-center rounded-full bg-fg px-4 text-[13px] font-medium text-bg hover:opacity-90 md:min-h-9">
          Open reviews
        </Link>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {top.map((r) => (
          <Link key={r.id} href={`/reviews?tab=${r.line}#r-${r.id}`} className="flex min-h-11 items-center justify-between gap-3 rounded-[14px] border border-line px-4 py-2.5 transition-colors hover:border-faint">
            <span className="truncate font-medium">{r.clients.name}</span>
            <span className={`shrink-0 text-[11px] ${r.risk >= 50 ? "text-bad" : r.risk >= 25 ? "text-warn" : "text-muted"}`}>{me.isExec ? REVIEW_LINE_LABEL[r.line] : r.risk >= 50 ? "High risk" : r.risk >= 25 ? "Watch" : "Steady"} →</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
