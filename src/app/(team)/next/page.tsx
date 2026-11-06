import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { greetingFor, todayLabel } from "@/lib/dates";
import { loadNextForMe } from "@/lib/next-for-me";
import { createClient } from "@/lib/supabase/server";
import { Suspense } from "react";
import { HandoffCallout } from "@/components/handoff-callout";
import { TodayHero, TodayHeroSkeleton } from "../pipeline/views/today-hero";
import { NextList } from "./next-list";
import { loadPatterns } from "@/lib/patterns";
import { PatternsPanel } from "@/components/patterns-view";

export const metadata: Metadata = { title: "Next for me" };
// Briefing a refresh from here has the strategist write and review a whole brief
export const maxDuration = 300;

/** Everything on you: tickets, decisions, your accounts. Team members and leads; execs have the Overview. */
export default async function NextForMe() {
  const me = await requireStaff();
  if (me.isExec) redirect("/pipeline");
  const db = await createClient();
  const [data, { data: mine }] = await Promise.all([loadNextForMe(db, me), db.from("client_assignments").select("client_id").eq("profile_id", me.id)]);
  // What works across businesses like the ones they work on: the same patterns the audits and refresh briefs build on
  const patterns = mine?.length ? await loadPatterns(db, [...new Set(mine.map((m) => m.client_id as string))]).catch(() => null) : null;
  // The Google team: ideas taken to their clients from Ideas › Google, waiting on a decision or to be applied
  const google = me.role === "google_buyer" || me.role === "head_of_google";
  const deploys =
    google && mine?.length
      ? (await import("@/lib/google-deploy").then(({ loadDeploys }) => loadDeploys(db, [...new Set(mine.map((m) => m.client_id as string))], { open: true })).catch(() => [])).filter((d) => d.status === "open" || d.status === "approved")
      : [];
  const now = new Date();
  const first = me.fullName.split(" ")[0];
  const n = data.now.length + data.decide.length;
  return (
    <div className="mx-auto grid max-w-4xl gap-6">
      <header className="grid gap-1.5">
        <p className="text-xs uppercase tracking-[0.18em] text-faint">{todayLabel(now)}</p>
        <h1 className="font-display text-3xl tracking-tight md:text-4xl">
          {greetingFor(now)}, {first}
        </h1>
        <p className="text-sm text-muted">{n ? `${n} ${n === 1 ? "thing needs" : "things need"} you. Here's everything that's next, in one place.` : "Here's everything that's next for you, in one place."}</p>
      </header>
      <Suspense fallback={<TodayHeroSkeleton />}>
        <TodayHero db={db} me={me} />
      </Suspense>
      <HandoffCallout db={db} me={me.id} />
      <NextList data={data} me={me.id} />
      {deploys.length > 0 && (
        <section className="grid gap-3">
          <div>
            <h2 className="font-heading text-[20px] tracking-tight">Google ideas for your clients</h2>
            <p className="text-sm text-muted">Winners from other accounts, written for your clients: approve, edit or decline, then apply.</p>
          </div>
          <ul className="grid gap-2">
            {deploys.map((d) => (
              <li key={d.id}>
                <a href={`/clients/${d.clientSlug}?service=google&tab=ideas&deploy=${d.id}`} className="flex min-h-14 items-center gap-3 rounded-[16px] border border-line bg-surface px-4 py-3 transition-colors hover:border-faint">
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="text-[12px] text-faint">
                      {d.client} · {d.kind === "copy" ? "Ad copy" : d.kind === "campaign" ? "Campaign" : "Keywords"}
                    </span>
                    <span className="truncate text-[14px]">{d.plan?.summary ?? "From a Google winner"}</span>
                  </span>
                  <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] ${d.status === "open" ? "bg-warn-soft text-warn" : "bg-ok-soft text-ok"}`}>{d.status === "open" ? "To decide" : "To apply"}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      {patterns && patterns.groups.length > 0 && (
        <section className="grid gap-3">
          <div>
            <h2 className="font-heading text-[20px] tracking-tight">What works for clients like yours</h2>
            <p className="text-sm text-muted">Proven across several of our clients in the same kind of business. The refresh briefs and audits for your accounts build on these.</p>
          </div>
          <PatternsPanel state={patterns} canBrief={me.isLead} canRefresh={false} />
        </section>
      )}
    </div>
  );
}
