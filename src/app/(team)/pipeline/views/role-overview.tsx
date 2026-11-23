import { Suspense } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { TOPICS, type TodayItem, type TopicKey } from "@/lib/today";
import { BLOCK_ORDER } from "@/lib/today-counts";
import { todaySnapshot } from "@/lib/today-snapshot";
import type { ExecCard, ExecTab } from "@/lib/exec-overview-core";
import { AutoClosed } from "@/components/auto-closed";
import { Blocks, type BlockDef } from "./exec-home";
import { BLOCK_TONE, itemChips } from "./exec-blocks";
import { HiddenLog } from "./hidden-log";
import { PageHeader } from "./shared";
import { TodayHero, TodayHeroSkeleton } from "./today-hero";

// Everyone's Overview (owner, Nov 23 2026), the exec design for every role: the Wrapped hero, then designed blocks
// that open in place: their items (one owner each, living tasks), Next for me in Asana, and the panels their role
// already had (Clients, Ideas, Audits and sprints, Setup, Tracking, their board) as blocks of their own.

export type RoleKind = "maker" | "support" | "member" | "lead";

/** The item blocks each kind of role always shows (empty ones say so); any other block with items shows too */
const SETS: Record<RoleKind, TopicKey[]> = {
  maker: ["needs", "work", "asana"],
  support: ["needs", "work", "asana"],
  member: ["needs", "accounts", "briefs", "asana"],
  lead: ["needs", "team", "accounts", "work", "asana", "pulse"],
};

const LABEL: Partial<Record<TopicKey, string>> = { accounts: "My accounts", team: "My team", briefs: "Ideas" };
const EMPTY: Partial<Record<TopicKey, { title: string; line: string }>> = {
  needs: { title: "You're clear", line: "No replies, promises or new clients waiting on you." },
  work: { title: "Nothing late", line: "No tickets or tasks on you right now." },
  accounts: { title: "Your accounts are on track", line: "Nothing off target without someone on it." },
  team: { title: "Your team is moving", line: "Nothing has sat with a teammate for 48 hours." },
  briefs: { title: "No ideas waiting", line: "No briefs waiting on your call." },
  asana: { title: "Nothing open in Asana", line: "No open Asana tasks are assigned to you." },
  pulse: { title: "Quiet", line: "Nothing to report for your line." },
};

/** A recap item as a block card (an exec's and a lead's own linked items carry their card already) */
function cardOf(i: TodayItem): ExecCard {
  if (i.exec) return i.exec;
  const kind: ExecCard["kind"] = i.key.startsWith("lead:") ? "stuck" : /^owed/.test(i.key) ? "owed" : /^said/.test(i.key) ? "said" : "mine";
  // A saved recap from before an update can carry an item without its action: never let one item break the page
  const act = (i as Partial<TodayItem>).action;
  const href = act?.href ?? (i.clientSlug ? `/clients/${i.clientSlug}` : null);
  return {
    key: i.key,
    tab: i.topic as ExecTab,
    kind,
    client: i.client === "Team" ? null : i.client,
    clientId: i.clientId,
    clientSlug: i.clientSlug || null,
    title: i.title,
    detail: i.story,
    severity: i.tier === "critical" ? "critical" : i.tier === "high" ? "high" : "normal",
    due: i.due ?? null,
    action: { label: act?.label ?? "Open", href },
  };
}

export async function RoleOverview({ db, me, kind, base, subtitle, extras, panels, hidden }: { db: SupabaseClient; me: Staff; kind: RoleKind; base: { greeting: string; firstName: string; today: string }; subtitle: string; extras?: React.ReactNode; panels?: React.ReactNode; hidden: { key: string; how: string; label: string | null; href: string | null; hidden_at: string }[] }) {
  const snap = await todaySnapshot(db, me);
  const byTopic = new Map<TopicKey, TodayItem[]>();
  for (const i of snap.today.items) byTopic.set(i.topic, [...(byTopic.get(i.topic) ?? []), i]);
  const shown = [...new Set([...SETS[kind], ...[...byTopic.keys()].filter((t) => t !== "elsewhere" && t !== "system" && t !== "escalated")])].sort((a, b) => BLOCK_ORDER.indexOf(a) - BLOCK_ORDER.indexOf(b));
  const blocks: BlockDef[] = shown.map((t) => {
    const cards = (byTopic.get(t) ?? []).map(cardOf);
    return {
      id: t,
      label: LABEL[t] ?? TOPICS[t]?.label ?? t,
      blurb: TOPICS[t]?.blurb ?? "",
      tone: BLOCK_TONE[t] ?? BLOCK_TONE.panel,
      cards,
      // Pulse is a read, never a to-do count
      count: t === "pulse" ? undefined : cards.length,
      chips: itemChips(t, cards),
      empty: EMPTY[t],
      note: t === "pulse" ? "Your line at a glance. Nothing here is a to-do." : undefined,
    };
  });
  return (
    <div className="mx-auto grid max-w-6xl gap-6 md:gap-8">
      <PageHeader today={base.today} title={`${base.greeting}, ${base.firstName}`} subtitle={subtitle} />
      <Suspense fallback={<TodayHeroSkeleton />}>
        <TodayHero db={db} me={me} />
      </Suspense>
      {/* Closed automatically: Slack, email or call notes showed these done, each with its quote and Reopen */}
      <Suspense fallback={null}>
        <AutoClosed db={db} me={me} />
      </Suspense>
      {extras}
      <Blocks blocks={blocks} />
      {panels}
      <HiddenLog items={hidden.map((r) => ({ key: r.key, how: r.how as "done" | "dismissed", label: r.label, href: r.href, at: r.hidden_at }))} />
    </div>
  );
}
