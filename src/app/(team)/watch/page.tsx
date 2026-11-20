import type { Metadata } from "next";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { loadMismatches, loadWatch, WATCH_GROUP } from "@/lib/account-watch/load";
import { OverviewTabs } from "../pipeline/views/overview-tabs";
import { WatchList, MismatchList, PauseList, RunNow } from "./watch-view";

export const metadata: Metadata = { title: "Account watch" };

// Account watch: what Kaizen OS caught on the accounts. Billed but idle first (a client paying for a service with
// nothing happening on it), then the ad accounts (neglected, overtouched, spend jumping, dropping or over budget), the
// creative line (behind pace, quiet, a sprint worth asking for), people in change history nobody recognizes, and the
// Stripe check (services here vs what Stripe bills). Tabs live in the address (?tab=). The daily run is in
// src/lib/account-watch/run.ts.

export default async function WatchPage({ searchParams }: PageProps<"/watch">) {
  const me = await requireStaff();
  const { client } = await searchParams;
  const db = await createClient();
  const decider = me.isExec || me.isLead;
  const [watch, mismatches, { data: team }] = await Promise.all([
    loadWatch(db, me),
    decider ? loadMismatches(db) : Promise.resolve(null),
    decider ? db.from("profiles").select("id, full_name").eq("is_active", true).order("full_name") : Promise.resolve({ data: [] }),
  ]);
  const only = typeof client === "string" && client ? client : null;
  const flags = only ? watch.flags.filter((f) => f.slug === only) : watch.flags;
  const group = (g: string) => flags.filter((f) => WATCH_GROUP[f.kind] === g);
  const idle = group("idle");
  const accounts = group("accounts");
  const creative = group("creative");
  const people = group("people");
  const dogs = group("dogs");
  const critical = (xs: typeof flags) => xs.some((f) => f.severity === "critical");
  const tabs = [
    { id: "idle", label: "Billed but idle", count: idle.length, tone: critical(idle) ? ("bad" as const) : ("warn" as const) },
    { id: "dogs", label: "Watchdogs", count: dogs.length, tone: critical(dogs) ? ("bad" as const) : ("warn" as const) },
    { id: "accounts", label: "Accounts", count: accounts.length, tone: critical(accounts) ? ("bad" as const) : ("warn" as const) },
    { id: "creative", label: "Creative", count: creative.length, tone: "warn" as const },
    ...(decider ? [{ id: "people", label: "People", count: people.length, tone: "bad" as const }] : []),
    ...(mismatches ? [{ id: "billing", label: "Stripe check", count: mismatches.rows.length, tone: "warn" as const }] : []),
    { id: "paused", label: "Paused", count: watch.pauses.length, tone: "quiet" as const },
  ];
  const opts = { canDecide: watch.canDecide, team: (team ?? []).map((p) => ({ id: p.id as string, name: p.full_name as string })) };
  return (
    <div className="mx-auto grid max-w-5xl gap-6 md:gap-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-brand-text">Account watch</p>
          <h1 className="mt-1 font-heading text-[30px] leading-tight md:text-[34px]">{idle.length ? `${idle.length} billed with nothing happening` : "Every billed service is moving"}</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-muted">
            Checked every morning against Stripe, spend, deliveries, sends and posts, and Meta and Google change history.{only ? ` Showing ${flags[0]?.client ?? only} only.` : ""}
          </p>
        </div>
        {me.isExec && <RunNow />}
      </header>
      <OverviewTabs
        tabs={tabs}
        panels={{
          idle: <WatchList flags={idle} {...opts} empty="Nothing billed is sitting idle. Every billed service had activity in the last 7 days, or is paused on purpose." />,
          dogs: <WatchList flags={dogs} {...opts} empty="Nothing caught today: no client pauses, access or payment problems, quiet channels, stuck creative or ads past their date." />,
          accounts: <WatchList flags={accounts} {...opts} empty="Every spending account was touched lately, nothing overtouched, and spend is steady." />,
          creative: <WatchList flags={creative} {...opts} empty="Creative is on pace on every package." />,
          people: <WatchList flags={people} {...opts} empty="Every name in change history is someone we know." />,
          billing: mismatches ? <MismatchList rows={only ? mismatches.rows.filter((m) => m.slug === only) : mismatches.rows} syncedAt={mismatches.syncedAt} /> : null,
          paused: <PauseList pauses={watch.pauses} canDecide={watch.canDecide} />,
        }}
      />
    </div>
  );
}
