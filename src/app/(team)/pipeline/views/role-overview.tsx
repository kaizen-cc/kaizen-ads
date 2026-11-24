import { Suspense } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { TOPICS, type TodayItem, type TopicKey } from "@/lib/today";
import { BLOCK_ORDER } from "@/lib/today-counts";
import { todaySnapshot } from "@/lib/today-snapshot";
import type { ExecCard, ExecTab } from "@/lib/exec-overview-core";
import { Blocks, type BlockDef } from "./exec-home";
import { asanaLabel, BLOCK_TONE, itemChips } from "./exec-blocks";
import { HiddenLog } from "./hidden-log";
import { PageHeader } from "./shared";
import { TodayHero, TodayHeroSkeleton } from "./today-hero";
import { OverviewWidgets } from "./widgets";

// Everyone's Overview (owner, Nov 23 2026), the exec design for every role: the Wrapped hero, then designed blocks
// that open in place: their items (one owner each, living tasks), Next for me in Asana, and the panels their role
// already had (Clients, Ideas, Audits and sprints, Setup, Tracking, their board) as blocks of their own.

export type RoleKind = "maker" | "support" | "member" | "lead";

/** The item blocks each kind of role always shows (empty ones say so); any other block with items shows too */
export const SETS: Record<RoleKind, TopicKey[]> = {
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
  const kind: ExecCard["kind"] = i.key.startsWith("lead:") ? "stuck" : /^owed/.test(i.key) ? "owed" : /^said/.test(i.key) ? "said" : i.key.startsWith("draft:") ? "draft" : i.key.startsWith("todo:") ? "todo" : "mine";
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
    // The email drafted for it (its main action) and the conversation behind it
    emailDraft: i.emailDraft ?? null,
    context: i.context ?? null,
    subs: i.subs ?? null,
    subsTitle: i.subsTitle ?? null,
    source: i.source ?? null,
  };
}

/** At most this many blocks for anyone (owner, Nov 23 2026): everything else folds into them */
const MAX_BLOCKS = 6;

export async function RoleOverview({ db, me, kind, base, subtitle, folded = {}, ownList = false, own = [], hidden }: { db: SupabaseClient; me: Staff; kind: RoleKind; base: { greeting: string; firstName: string; today: string }; subtitle: string; /** My accounts holds the role's own client list (it stands for the items there) */ ownList?: boolean; /** What the role already had, inside the block it belongs to (their clients in My accounts, ideas in Ideas) */ folded?: Partial<Record<TopicKey, React.ReactNode>>; /** A block of the role's own (the support board, Tracking) */ own?: { id: string; label: string; blurb: string; node: React.ReactNode; count?: number }[]; hidden: { key: string; how: string; label: string | null; href: string | null; hidden_at: string }[] }) {
  const snap = await todaySnapshot(db, me);
  const byTopic = new Map<TopicKey, TodayItem[]>();
  for (const i of snap.today.items) byTopic.set(i.topic, [...(byTopic.get(i.topic) ?? []), i]);
  // The role's blocks, then any other block that has items (or something folded in), never more than six in all:
  // anything past that joins Needs me
  const extra = [...new Set([...byTopic.keys(), ...(Object.keys(folded) as TopicKey[])])].filter((t) => !SETS[kind].includes(t) && t !== "elsewhere" && t !== "system" && t !== "escalated");
  const room = Math.max(0, MAX_BLOCKS - SETS[kind].length - own.length);
  const shown = [...SETS[kind], ...extra.slice(0, room)].sort((a, b) => BLOCK_ORDER.indexOf(a) - BLOCK_ORDER.indexOf(b));
  const spill = extra.slice(room).flatMap((t) => byTopic.get(t) ?? []);
  const blocks: BlockDef[] = shown.map((t) => {
    const cards = [...(byTopic.get(t) ?? []), ...(t === "needs" ? spill : [])].map(cardOf);
    return {
      id: t,
      label: LABEL[t] ?? TOPICS[t]?.label ?? t,
      blurb: TOPICS[t]?.blurb ?? "",
      tone: BLOCK_TONE[t] ?? BLOCK_TONE.panel,
      cards,
      // Pulse is a read, never a to-do count
      count: t === "pulse" ? undefined : cards.length,
      ...asanaLabel(t, cards),
      chips: itemChips(t, cards),
      empty: EMPTY[t],
      note: t === "pulse" ? "Your line at a glance. Nothing here is a to-do." : undefined,
      panel: folded[t],
      // My accounts with the role's own client list folded in: that list is the one design shown
      cardsHidden: t === "accounts" && ownList,
    };
  });
  for (const o of own) blocks.push({ id: `p-${o.id}`, label: o.label, blurb: o.blurb, tone: BLOCK_TONE.panel, panel: o.node, ...(o.count != null ? { count: o.count } : {}) });
  return (
    <div className="mx-auto grid max-w-6xl gap-6 md:gap-8">
      <PageHeader today={base.today} title={`${base.greeting}, ${base.firstName}`} subtitle={subtitle} />
      <Suspense fallback={<TodayHeroSkeleton />}>
        <TodayHero db={db} me={me} />
      </Suspense>
      <Blocks blocks={blocks} />
      {/* Their own widgets under the blocks, and "Add widget" (./widgets.tsx) */}
      <Suspense fallback={null}>
        <OverviewWidgets me={me} />
      </Suspense>
      <HiddenLog items={hidden.map((r) => ({ key: r.key, how: r.how as "done" | "dismissed", label: r.label, href: r.href, at: r.hidden_at }))} />
    </div>
  );
}
