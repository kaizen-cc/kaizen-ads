import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { allotmentLine, allotmentPools } from "@/lib/allotment";
import { loadWatchList } from "@/lib/fatigue";
import { loadHome, recentlyWorked, workedOn } from "@/lib/home";
import { loadOwedReplies } from "@/lib/owed-replies";
import { loadSaidPromises } from "@/lib/message-promises";
import { loadCallPromises, loadOnboarding, loadSuggestions, type OpenSuggestion } from "@/lib/suggestions";
import { LIVE } from "@/lib/live";
import { isCreativeRole } from "@/lib/roles";
import { secondarySeatKeys } from "@/lib/buyer-seats";
import { INTAKE_WAIT_DAYS, addBusinessDays as addBizDays } from "@/lib/brand-bible";
import { countLooks, hideKeyOf, type Looks } from "@/lib/today-counts";

// The daily recap: everything that needs an exec or lead today, one item at a time, most critical first. Critical
// means it can cost us the client: a promise we made and haven't kept, a new client waiting on us, an important
// account well off its target, work late on our side. Then what's important but not urgent, then the rest. Each
// person saves an item for later (their list for the day, and a reminder tomorrow), acts on it, or dismisses it; an
// item they saw that someone else has since acted on comes back once as "taken care of", with who and what.

export type Tier = "critical" | "high" | "normal";
export type TopicKey = "mine" | "promises" | "onboarding" | "accounts" | "work" | "briefs" | "ads" | "allotments";
export const TOPICS: Record<TopicKey, { label: string; blurb: string }> = {
  mine: { label: "Your work", blurb: "Tickets and tasks on you" },
  promises: { label: "Waiting on us", blurb: "Promised, said yes to, or not answered" },
  onboarding: { label: "New clients", blurb: "First impressions" },
  accounts: { label: "Accounts", blurb: "Results against target" },
  work: { label: "Late work", blurb: "Work running late on our side" },
  briefs: { label: "Ideas", blurb: "Briefs the strategist suggests" },
  ads: { label: "Ads", blurb: "Ads ready for a refresh" },
  allotments: { label: "Allotments", blurb: "Clients behind on creative" },
};

export type TodayItem = {
  key: string;
  topic: TopicKey;
  tier: Tier;
  score: number; // higher first
  client: string;
  clientSlug: string;
  clientId: string | null;
  stat: { value: string; label: string };
  title: string;
  story: string;
  why: string; // why it's this critical
  evidence: string[];
  /** brief: a brief to start from here, its quick preview opening in place (the full brief only if they choose it) */
  action: { label: string; href?: string; suggestion?: OpenSuggestion; brief?: { source: import("@/lib/quick-brief").BriefSource; from: { kicker: string; label: string; thumb?: string | null; adId?: string | null } } };
  /** The other place to look: the client page, or the account on the KPI board */
  alt?: { label: string; href: string };
  /** What setting it aside means here, when it's more than "not for me" */
  dismiss?: string;
  /** A message waiting on this person: the reply drafted for them */
  reply?: { id: string; source: "slack" | "gmail"; url: string | null; draft: string | null; channel: string | null };
  state: "new" | "seen" | "saved"; // what this person has done with it so far
  carried: boolean; // came up on an earlier day and is still open
  image?: string | null;
};
export type Resolved = { key: string; topic: TopicKey; client: string; title: string; by: string | null; what: string };
/** counts: items by tier (kept for older readers); looks: what every screen shows, counted by client (src/lib/today-counts.ts) */
export type Today = { items: TodayItem[]; resolved: Resolved[]; counts: Record<Tier, number>; looks: Looks };

const tierOf = (score: number): Tier => (score >= 80 ? "critical" : score >= 60 ? "high" : "normal");
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
const bizDays = (from: string) => {
  let n = 0;
  const d = new Date(from);
  const end = new Date();
  while (d < end) {
    d.setDate(d.getDate() + 1);
    if (d <= end && d.getDay() % 6 !== 0) n++;
  }
  return n;
};
const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 })}`;
const PRIORITY_BOOST: Record<string, number> = { high: 10, medium: 4, low: 0 };

type Draft = Omit<TodayItem, "tier" | "state" | "carried">;

/** Which topics a person's day covers. Everyone has their own work; managers see across their clients. */
export function topicsFor(me: Staff): Set<TopicKey> {
  const manager = me.isExec || me.isLead;
  // Everyone has messages they could owe a reply to; promises from calls are for the people who run accounts
  const t = new Set<TopicKey>(["mine", "promises"]);
  if (manager) ["promises", "onboarding", "accounts", "work", "briefs", "ads", "allotments"].forEach((k) => t.add(k as TopicKey));
  if (me.isBuyer) ["promises", "accounts", "ads", "allotments"].forEach((k) => t.add(k as TopicKey));
  // Google buyers: their accounts and promises (no Meta ads wearing out, no creative allotments)
  if (me.role === "google_buyer") ["promises", "accounts"].forEach((k) => t.add(k as TopicKey));
  if (me.isCoordinator) ["promises", "onboarding", "allotments"].forEach((k) => t.add(k as TopicKey));
  // Each lead sees their own line: no ad accounts for the Head of Creative, no Meta ads wearing out for the Head of Google
  if (me.role === "head_of_creative") t.delete("accounts");
  // The Head of Google: Google only (Meta ads wearing out, creative briefs and allotments aren't theirs)
  if (me.role === "head_of_google") ["ads", "briefs", "allotments"].forEach((k) => t.delete(k as TopicKey));
  return t;
}

/** Tickets and Asana tasks on this person that are late or due today. */
async function mine(db: SupabaseClient, me: Staff): Promise<Draft[]> {
  const out: Draft[] = [];
  const endOfToday = new Date(new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }) + "T23:59:59-05:00").toISOString();
  const [{ data: tickets }, { data: tasks }] = await Promise.all([
    db.from("board_requests").select("id, number, title, client_name, client_slug, client_id, stage, stage_due_at, minutes_over").eq("assignee_id", me.id).neq("stage", "launched").lte("stage_due_at", endOfToday).limit(30),
    db.from("asana_tasks").select("gid, name, url, due_on, section, client_id, clients(name, slug)").eq("profile_id", me.id).eq("open", true).is("request_id", null).not("due_on", "is", null).lte("due_on", endOfToday.slice(0, 10)).limit(30),
  ]);
  for (const r of tickets ?? []) {
    const late = Number(r.minutes_over ?? 0) > 0;
    const hours = Math.round(Number(r.minutes_over ?? 0) / 60);
    out.push({
      key: `mine:ticket:${r.id}`,
      topic: "mine",
      score: late ? Math.min(90, 70 + Math.min(16, hours / 3)) : 58,
      client: r.client_name as string,
      clientSlug: r.client_slug as string,
      clientId: r.client_id as string,
      stat: late ? { value: String(Math.max(1, hours)), label: `${hours === 1 ? "hour" : "hours"} past its turnaround` } : { value: "Today", label: "due today" },
      title: `#${r.number} ${r.title}`,
      story: late ? "It's waiting on you and running late. The client feels this one." : "It's on you and due by the end of today.",
      why: late ? "Late work on your plate" : "Due today",
      evidence: [],
      action: { label: "Open the ticket", href: `/board?t=${r.number}` },
    });
  }
  for (const t of tasks ?? []) {
    const c = t.clients as unknown as { name: string; slug: string } | null;
    const late = String(t.due_on) < new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    out.push({
      key: `mine:asana:${t.gid}`,
      topic: "mine",
      score: late ? 72 : 56,
      client: c?.name ?? "Asana",
      clientSlug: c?.slug ?? "",
      clientId: (t.client_id as string | null) ?? null,
      stat: late ? { value: day(String(t.due_on) + "T12:00:00Z"), label: "was due (in Asana)" } : { value: "Today", label: "due today (in Asana)" },
      title: t.name as string,
      story: `In Asana's ${t.section ?? "board"} column, assigned to you.`,
      why: late ? "Overdue in Asana" : "Due today",
      evidence: [],
      action: { label: "Open in Asana", href: (t.url as string) ?? "/board" },
    });
  }
  // Plan tasks on this person: above all the ones holding someone else up
  const { myTasks } = await import("@/lib/execution-plan");
  const todayIso = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  for (const t of await myTasks(db, me.id).catch(() => [])) {
    if (t.status === "blocked") continue;
    const late = Boolean(t.dueOn && t.dueOn < todayIso);
    const holding = t.holdingUp.length;
    if (!holding && !late && t.dueOn !== todayIso) continue;
    out.push({
      key: `mine:task:${t.id}`,
      topic: "mine",
      score: holding ? (late ? 86 : 76) : late ? 70 : 56,
      client: t.client,
      clientSlug: t.clientSlug,
      clientId: t.clientId,
      stat: holding ? { value: String(holding), label: `${holding === 1 ? "step is" : "steps are"} waiting on you` } : late ? { value: day(`${t.dueOn}T12:00:00Z`), label: "was due" } : { value: "Today", label: "due today" },
      title: t.title,
      story: holding ? `You're holding up ${t.holdingUp.map((h) => `${h.title} (${h.who})`).join(", ")}. Nothing moves on those until this is done.` : "A step in their plan, on you.",
      why: holding ? "Others are waiting on this" : late ? "Late on their plan" : "Due today",
      evidence: [],
      action: { label: "Open the plan", href: `/clients/${t.clientSlug}?tab=plan` },
    });
  }
  return out;
}

// The creative team's day: what's on them and what they can act on (ads wearing out, late or stuck tickets, first
// rounds, briefs, clients behind on creative, promises with a brief to make) can be urgent. Anything else (someone
// else's escalation, a footage nudge) stays in the day as information, never an alarm.
const CREATIVE_ACTIONABLE = new Set(["mine", "owed", "owed2", "said", "said2", "fatigue", "attention", "onboarding", "allot-behind", "promise", "brief"]);
export function forCreative<T extends { key: string; score: number }>(items: T[]): T[] {
  return items.map((d) => (CREATIVE_ACTIONABLE.has(d.key.split(":")[0]) ? d : { ...d, score: Math.min(d.score, 59) }));
}

/** Every item for this person right now, scored. */
async function gather(db: SupabaseClient, me: Staff): Promise<Draft[]> {
  const out = await gatherAll(db, me);
  return isCreativeRole(me.role) ? forCreative(out) : out;
}

async function gatherAll(db: SupabaseClient, me: Staff): Promise<Draft[]> {
  const creative = isCreativeRole(me.role);
  const topics = topicsFor(me);
  const manager = me.isExec || me.isLead;
  const callPromises = manager || me.isBuyer || me.isCoordinator;
  const [promises, onboarding, suggestions, fatigue, home, own, owed, said] = await Promise.all([
    // The creative team: only the call promises with a brief to make (the rest are the buyers' and account managers')
    callPromises ? loadCallPromises(db).then((ps) => (creative ? ps.filter((p) => p.suggestion) : ps)).catch(() => []) : [],
    topics.has("onboarding") ? loadOnboarding(db).catch(() => null) : null,
    topics.has("briefs") ? loadSuggestions(db, (await import("@/lib/creative-formats")).formatsFor(me)).catch(() => null) : null,
    topics.has("ads") ? loadWatchList(db, manager ? { limit: 20 } : { buyerId: me.id, limit: 20 }).catch(() => []) : [],
    topics.has("work") || topics.has("allotments") ? loadHome(db, me).catch(() => null) : null,
    mine(db, me).catch(() => []),
    loadOwedReplies(db, me).catch(() => []),
    loadSaidPromises(db, me).catch(() => []),
  ]);
  const out: Draft[] = [...own];

  // What someone said yes to in Slack or email, past when it was due with nothing moving
  for (const p of said) {
    const late = Math.max(0, bizDays(p.dueAt));
    const mineToo = p.ownerId === me.id;
    const second = p.status === "escalated";
    // An email opens only in its owner's inbox (anyone else gets Gmail's error page): theirs gets the link, a lead the client
    const otherInbox = p.source === "gmail" && !mineToo;
    const open = otherInbox ? "Open the client" : p.source === "gmail" ? "Open the email" : "Open in Slack";
    const link = otherInbox ? (p.clientSlug ? `/clients/${p.clientSlug}` : null) : p.url;
    const make = ["creative", "copy", "offer"].includes(p.kind ?? "") && p.clientSlug;
    out.push({
      key: mineToo ? `${second ? "said2" : "said"}:${p.id}` : `said-lead:${p.id}`,
      topic: "promises",
      score: mineToo ? (second ? 95 : Math.min(90, 78 + late * 4)) : 85,
      client: p.client ?? p.askedBy ?? "Team",
      clientSlug: p.clientSlug ?? "",
      clientId: p.clientId,
      stat: late ? { value: String(late), label: `business ${late === 1 ? "day" : "days"} past when it was due` } : { value: "Due", label: `was due ${day(p.dueAt)}` },
      title: mineToo ? `You said you'd ${p.group?.title ?? p.what}` : `${p.owner} said they'd ${p.group?.title ?? p.what}`,
      story: `${p.askedBy ?? "Someone"} asked ${p.where} on ${day(p.saidAt)}${p.ask ? ` (${p.ask})` : ""}. ${mineToo ? "You" : p.owner.split(" ")[0]} said: "${p.said.replace(/\s+/g, " ").slice(0, 200)}${p.said.length > 200 ? "…" : ""}". Nothing since shows it's happened.`,
      why: mineToo ? (second ? "Second notice: your lead and the exec team have been told" : "You said yes, and it's past due") : "They had a notice and nothing's moved",
      evidence: p.group && p.group.sources.length > 1 ? p.group.sources.map((s) => `${s.label}, ${day(s.at)}`) : [],
      action:
        make && p.clientId
          ? {
              label: "Brief it",
              brief: {
                source: { kind: "idea", label: `Promised in ${p.source === "gmail" ? "email" : "Slack"}: ${p.group?.title ?? p.what}`.slice(0, 200), text: [`We said we'd: ${p.group?.title ?? p.what}`, p.ask ? `They asked: ${p.ask}` : "", `What was said: "${p.said.replace(/\s+/g, " ").slice(0, 600)}"`, "Keep it to exactly what was promised."].filter(Boolean).join("\n") },
                from: { kicker: "Promised in a message", label: p.group?.title ?? p.what },
              },
            }
          : { label: open, href: link ?? p.channelUrl ?? "/today" },
      ...(make && link ? { alt: { label: open, href: link } } : p.channelUrl ? { alt: { label: "Open the channel", href: p.channelUrl } } : {}),
      ...(mineToo ? { dismiss: "Done, or not needed" } : {}),
    });
  }

  // Messages nobody answered: the person's own after a first notice, and (for leads and execs) ones that were escalated
  for (const o of owed) {
    const waited = Math.max(1, bizDays(o.askedAt));
    const mineToo = o.targetId === me.id;
    const second = o.status === "escalated";
    // Someone else's email opens only in their inbox: a lead gets the client (or the recap) instead of Gmail's error page
    const otherInbox = o.source === "gmail" && !mineToo;
    const where = otherInbox ? (o.clientSlug ? "Open the client" : "Open the recap") : o.source === "gmail" ? "Open the email" : "Open in Slack";
    const link = otherInbox ? (o.clientSlug ? `/clients/${o.clientSlug}` : null) : o.url;
    out.push({
      key: mineToo ? `${second ? "owed2" : "owed"}:${o.id}` : `owed-lead:${o.id}`,
      topic: "promises",
      score: mineToo ? (second ? 94 : Math.min(88, 74 + waited * 4)) : 84,
      client: o.client ?? (o.fromTeam ? "Team" : o.from),
      clientSlug: o.clientSlug ?? "",
      clientId: o.clientId,
      stat: { value: String(waited), label: `business ${waited === 1 ? "day" : "days"} without a reply` },
      title: mineToo ? `${o.from} is waiting on you: ${o.gist}` : `${o.target} hasn't replied to ${o.from}: ${o.gist}`,
      story: `${o.from} wrote ${o.where} on ${day(o.askedAt)}: "${o.body.replace(/\s+/g, " ").slice(0, 220)}${o.body.length > 220 ? "…" : ""}"`,
      why: mineToo ? (second ? "Second notice: your lead and the exec team have been told" : "Nobody's answered it yet") : "They had a notice and still haven't answered",
      evidence: [],
      action: { label: where, href: link ?? o.channelUrl ?? "/today" },
      ...(o.channelUrl ? { alt: { label: "Open the channel", href: o.channelUrl } } : {}),
      ...(mineToo ? { dismiss: "Doesn't need a reply", reply: { id: o.id, source: o.source, url: o.url, draft: o.draft, channel: o.channelName } } : {}),
    });
  }

  // Promises we made on calls and haven't started: the client was told, so it's their trust on the line
  for (const p of promises) {
    const late = Math.max(0, bizDays(p.dueAt));
    out.push({
      key: `promise:${p.commitmentId}`,
      topic: "promises",
      score: Math.min(98, 82 + late * 3),
      client: p.client,
      clientSlug: p.clientSlug,
      clientId: p.suggestion?.clientId ?? null,
      stat: { value: late ? String(late) : "Due", label: late ? `business ${late === 1 ? "day" : "days"} past what we promised` : `due ${day(p.dueAt)}` },
      title: p.group?.title ?? p.what,
      story: p.group && p.group.sources.length > 1 ? `We said this ${p.group.sources.length} times, first on ${day(p.group.sources[0].at)}. Nothing is in production for it yet.${p.group.context ? ` ${p.group.context}` : ""}` : `We said this on "${p.callTitle}" (${day(p.callAt)}). Nothing is in production for it yet.${p.group?.context ? ` ${p.group.context}` : ""}`,
      why: "The client heard us promise it",
      evidence: p.group && p.group.sources.length > 1 ? p.group.sources.map((s) => `${s.label}, ${day(s.at)}`) : [],
      action: p.suggestion ? { label: "Review the brief", suggestion: p.suggestion } : { label: "Open the client", href: `/clients/${p.clientSlug}` },
    });
  }

  // New clients without their intake form: where their Brand Bible and presentation stand, so the item says what
  // happens next (a countdown to the Bible being built without it, then to the presentation going out for approval)
  const noIntake = (onboarding?.clients ?? []).filter((c) => !c.intake || c.intake.status === "unmatched").map((c) => c.clientId);
  const [{ data: bibleRows }, { data: deckRows }] = noIntake.length
    ? await Promise.all([
        db.from("client_brand_bibles").select("client_id, status, generated_at").in("client_id", noIntake),
        db.from("client_presentations").select("client_id, status, send_after, sent_at, approved_at").in("client_id", noIntake),
      ])
    : [{ data: [] }, { data: [] }];
  const bibleOf = new Map((bibleRows ?? []).map((r) => [r.client_id as string, r]));
  const deckOf = new Map((deckRows ?? []).map((r) => [r.client_id as string, r]));

  // New clients: a first round waiting on us is their first impression
  for (const c of onboarding?.clients ?? []) {
    if (c.firstRound && manager) {
      const waited = bizDays(c.firstRound.createdAt);
      out.push({
        key: `onboarding:${c.clientId}`,
        topic: "onboarding",
        score: Math.min(95, 80 + waited * 4),
        client: c.name,
        clientSlug: c.slug,
        clientId: c.clientId,
        stat: { value: String(waited), label: `${waited === 1 ? "day" : "days"} their first round has waited on you` },
        title: `${c.name}'s first round is written`,
        story:
          c.round.length > 1
            ? `${c.round.length} concepts, one brief and one ticket each: ${c.round.map((r) => `"${r.draft.title}"`).join(", ")}. Approve them (all on the Overview, or one at a time) to put their first creative into production.`
            : c.firstRound.draft.title
              ? `"${c.firstRound.draft.title}". Approve it to put their first creative into production.`
              : "Approve it to put their first creative into production.",
        why: "A new client's first impression",
        evidence: c.firstRound.evidence.slice(0, 3),
        action: { label: c.round.length > 1 ? `Review concept 1 of ${c.round.length}` : "Review the first round", suggestion: c.firstRound },
      });
    } else if ((manager && !creative) || me.isCoordinator ? !c.intake || c.intake.status === "unmatched" : false) {
      // Chasing an intake form is the account manager's (and the buyers' and execs'), never the creative team's. It
      // reads as what comes next, not just a problem: the Bible is built without it after INTAKE_WAIT_DAYS business
      // days, and its presentation goes to the client for approval a business day after that
      const waited = bizDays(c.since);
      const bible = bibleOf.get(c.clientId);
      const deck = deckOf.get(c.clientId);
      const built = Boolean(bible?.generated_at);
      const nudge = "Their intake form still makes everything sharper (the Bible is rebuilt the moment it arrives), so a nudge from their account manager is worth it.";
      const next: Pick<TodayItem, "stat" | "title" | "story"> | null =
        deck?.status === "approved"
          ? null
          : deck?.status === "sent"
            ? {
                stat: { value: String(bizDays(deck.sent_at as string)), label: "business days their Brand Bible has waited on their approval" },
                title: `${c.name}'s Brand Bible is with them for approval`,
                story: `Built without their intake form and sent ${deck.sent_at ? day(deck.sent_at as string) : "already"}; it's waiting on their approval in the portal. ${nudge}`,
              }
            : deck?.status === "held"
              ? {
                  stat: { value: "Held", label: "their Brand Bible presentation is on hold" },
                  title: `${c.name}'s Brand Bible is ready, and held`,
                  story: `Built without their intake form. Its presentation is held, so it won't go to them for approval until someone sends it from the presentation page. ${nudge}`,
                }
              : built && deck?.send_after
                ? (() => {
                    const left = Math.max(0, Math.ceil((Date.parse(deck.send_after as string) - Date.now()) / 86_400_000));
                    return {
                      stat: { value: left ? String(left) : "Today", label: left ? `${left === 1 ? "day" : "days"} until their Brand Bible goes for their approval` : "their Brand Bible goes for their approval" },
                      title: `${c.name}'s Brand Bible goes to them for approval ${left ? day(deck.send_after as string) : "today"}`,
                      story: `Built without their intake form. Its presentation goes out on its own ${day(deck.send_after as string)} for their approval, unless someone holds it. Check it before then on the presentation page. ${nudge}`,
                    };
                  })()
                : waited < INTAKE_WAIT_DAYS
                  ? (() => {
                      const left = INTAKE_WAIT_DAYS - waited;
                      return {
                        stat: { value: String(left), label: `business ${left === 1 ? "day" : "days"} until we build their Brand Bible without it` },
                        title: `${c.name}'s intake form isn't in yet`,
                        story: `If it isn't in by ${day(addBizDays(c.since, INTAKE_WAIT_DAYS).toISOString())}, their Brand Bible is built anyway from their calls, emails, website and our research, and its presentation goes to them for approval a business day later. ${nudge}`,
                      };
                    })()
                  : {
                      stat: { value: "Now", label: "their Brand Bible is being built without it" },
                      title: `${c.name}'s Brand Bible is being built without their intake form`,
                      story: `${INTAKE_WAIT_DAYS} business days passed without it, so it's built from their calls, emails, website and our research. Its presentation then goes to them for approval a business day later. ${nudge}`,
                    };
      if (next && waited >= 1)
        out.push({
          key: `intake:${c.clientId}`,
          topic: "onboarding",
          score: 52 + Math.min(14, waited * 2),
          client: c.name,
          clientSlug: c.slug,
          clientId: c.clientId,
          ...next,
          ...(c.setup?.notes ? { story: `${next.story} From the onboarding checklist: ${c.setup.notes.slice(0, 220)}` } : {}),
          why: "Onboarding: what happens next without their intake form",
          evidence: [],
          action: built ? { label: "See their Brand Bible", href: `/clients/${c.slug}/brand-bible${deck && deck.status !== "sent" ? "/presentation" : ""}` } : { label: "Open the client", href: `/clients/${c.slug}` },
          ...(built ? { alt: { label: "Open the client", href: `/clients/${c.slug}` } } : {}),
        });
    }
  }

  // Accounts off target, weighted by how far off, how much is spent and how important the account is
  // Each service line on its own, for the people on it: execs both, the Head of Meta Meta, the Head of Google Google,
  // a buyer only the accounts they own (and the ones they're a secondary buyer on)
  let kq = db.from("kpi_targets").select("id, label, platform, ad_account_id, conversion, target, monthly_budget, sheet, owner_id, client_id, clients!inner(name, slug, archived_at, status)").eq("active", true).is("clients.archived_at", null).in("clients.status", LIVE);
  const co = !manager && topics.has("accounts") ? await secondarySeatKeys(db, me.id) : new Set<string>();
  const coClients = [...new Set([...co].map((k) => k.split(":")[0]))];
  if (!manager) kq = coClients.length ? kq.or(`owner_id.eq.${me.id},client_id.in.(${coClients.join(",")})`) : kq.eq("owner_id", me.id);
  else if (me.role === "head_of_meta") kq = kq.eq("platform", "meta");
  else if (me.role === "head_of_google") kq = kq.eq("platform", "google");
  const { data: found } = topics.has("accounts") ? await kq : { data: [] };
  const targets = (found ?? []).filter((t) => manager || t.owner_id === me.id || co.has(`${t.client_id}:${t.platform === "google" ? "google" : "meta"}`));
  const ids = (targets ?? []).map((t) => t.id as string);
  const [{ data: snaps }, worked] = await Promise.all([
    ids.length ? db.from("kpi_snapshots").select("target_id, status, deviation, windows, budget").in("target_id", ids) : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    recentlyWorked(db, (targets ?? []) as { platform: string; ad_account_id: string | null }[]),
  ]);
  for (const t of targets ?? []) {
    const s = (snaps ?? []).find((x) => x.target_id === t.id);
    // No KPI set: never off target, whatever an older snapshot says
    if (!s || t.target == null || !["off", "close"].includes(s.status as string)) continue;
    // Changed in the last few days: someone's on it, so it's given time before it comes back as an item
    if (workedOn(worked, t as { platform: string; ad_account_id: string | null })) continue;
    const c = t.clients as unknown as { name: string; slug: string };
    const dev = Number(s.deviation ?? 0);
    const d7 = (s.windows as { d7?: { spend?: number; value?: number | null; results?: number } } | null)?.d7;
    const priority = String((t.sheet as { priority?: string } | null)?.priority ?? "").toLowerCase();
    const budget = Number(t.monthly_budget ?? 0);
    const roas = t.conversion === "roas" || t.conversion === "tiktok_roas";
    const score = Math.round((s.status === "off" ? 62 : 45) + Math.min(18, dev * 20) + (PRIORITY_BOOST[priority] ?? 2) + (budget >= 5000 ? 6 : budget >= 2000 ? 3 : 0));
    const what = String(t.conversion ?? "result").replace(/_/g, " ").replace(/s$/, "");
    out.push({
      key: `kpi:${t.id}`,
      topic: "accounts",
      score: Math.min(92, score),
      client: c.name,
      clientSlug: c.slug,
      clientId: t.client_id as string,
      stat: { value: `${Math.round(dev * 100)}%`, label: roas ? "below its ROAS target" : `over target per ${what}` },
      title: `${c.name} · ${t.platform === "google" ? "Google" : t.platform === "tiktok" ? "TikTok" : "Meta"}${t.label ? ` ${t.label}` : ""} is ${s.status === "off" ? "off" : "close to"} target`,
      story:
        d7 && d7.results
          ? `Last 7 days: ${roas ? `${Number(d7.value ?? 0).toFixed(2)}x ROAS` : `${money(Number(d7.value ?? 0))} per ${what}`} against a ${roas ? `${t.target}x` : money(Number(t.target))} target, on ${money(Number(d7.spend ?? 0))} spent.`
          : `No ${what}s in the last 7 days on ${money(Number(d7?.spend ?? 0))} spent, against a ${money(Number(t.target))} target.`,
      why: priority === "high" ? "A high-priority account, off target" : budget >= 5000 ? "A big budget, off target" : "Off its KPI target",
      evidence: [(t.sheet as { problem?: string } | null)?.problem ? `#1 problem (sheet): ${(t.sheet as { problem: string }).problem}` : "", (s.budget as { status?: string } | null)?.status === "over" ? "Spending ahead of its monthly budget" : ""].filter(Boolean).slice(0, 2),
      action: { label: "Open on the KPI board", href: `/kpis?target=${t.id}` },
      alt: { label: "Client page", href: `/clients/${c.slug}` },
    });
  }

  // Work late on our side (the client isn't waiting on themselves): their experience of us
  for (const a of topics.has("work") ? (home?.attention ?? []) : []) {
    if (a.kind === "Allotment") continue; // allotments have their own topic
    const ours = a.kind === "Behind" || a.kind === "Revisions";
    out.push({
      key: `attention:${a.id}`,
      topic: "work",
      score: a.tone === "bad" ? (ours ? 78 : 66) : ours ? 60 : 52,
      client: a.client,
      clientSlug: "",
      clientId: null,
      stat: { value: a.kind, label: a.owner ? `with ${a.owner}` : "" },
      title: `${a.client}: ${a.title}`,
      story: a.detail,
      why: a.kind === "No response" ? "Waiting on the client" : "Running late on our side",
      evidence: [],
      action: { label: "Open it", href: a.href ?? "/board" },
    });
  }

  // Briefs the strategist wrote: decisions, not emergencies
  for (const sg of suggestions?.open ?? []) {
    out.push({
      key: `brief:${sg.id}`,
      topic: "briefs",
      // Ideas, never alarms: they stay below the "Important" tier
      score: sg.kind === "fatigue" ? 56 : 52,
      client: sg.client,
      clientSlug: sg.clientSlug,
      clientId: sg.clientId,
      stat: { value: String(sg.draft.formats.reduce((n, f) => n + f.new + f.variations, 0)), label: "pieces in the brief" },
      title: sg.draft.title,
      story: sg.signal,
      why: "An idea for this client",
      evidence: sg.evidence.slice(0, 3),
      action: { label: "Review the brief", suggestion: sg },
      image: sg.source?.thumbnail ?? null,
    });
  }

  // (Clients with nothing new on Drive aren't a to-do here: that list would be every client. The client page's shot
  // list panel still says when it's time to ask for fresh footage.)

  // Ads wearing out
  for (const r of fatigue.filter((x) => x.state === "open")) {
    out.push({
      key: `fatigue:${r.clientId}:${r.adId}`,
      topic: "ads",
      score: r.severity === "tired" ? 58 : 46,
      client: r.client,
      clientSlug: r.clientSlug,
      clientId: r.clientId,
      stat: { value: r.severity === "tired" ? "Tired" : "Tiring", label: "against its last three weeks" },
      title: r.headline ?? r.adName,
      story: `${r.client}'s ad is ${r.severity === "tired" ? "worn out and ready to replace" : "starting to slip"}.${r.briefId ? " A refresh is sketched and ready to preview." : ""}`,
      why: r.severity === "tired" ? "Results slipping on a live ad" : "Early signs of wear",
      evidence: [],
      // A refresh, its quick preview right here (a brief already sketched shows at once); the client page is a click away
      action: { label: r.briefId ? "Preview the refresh" : "Brief a refresh", brief: { source: r.briefId ? { kind: "suggestion", id: r.briefId } : { kind: "refresh", adId: r.adId }, from: { kicker: "Refresh a tiring ad", label: r.headline ?? r.adName, thumb: r.thumbnail, adId: r.adId } } },
      alt: { label: "Client page", href: `/clients/${r.clientSlug}` },
      image: r.thumbnail,
    });
  }

  // Allotments: the risk is a client getting less than they pay for (nothing made a third of the way in, or far
  // behind). A client getting extra isn't a problem to flag.
  const elapsed = home?.monthElapsed ?? 0;
  for (const c of topics.has("allotments") ? (home?.clients ?? []) : []) {
    // Per pool, never summed: the stat is the pool furthest behind, the story every pool
    const pools = allotmentPools(c.counts).filter((p) => p.cap > 0);
    if (!pools.length) continue;
    const worst = pools.reduce((a, b) => (b.used / b.cap < a.used / a.cap ? b : a));
    if (c.note === "Nothing delivered yet" || c.note === "Behind on creative")
      out.push({
        key: `allot-behind:${c.slug}`,
        topic: "allotments",
        score: c.note === "Nothing delivered yet" ? 74 : 61,
        client: c.name,
        clientSlug: c.slug,
        clientId: null,
        stat: { value: `${worst.used}/${worst.cap}`, label: `${worst.label.toLowerCase()} this billing cycle` },
        title: c.note === "Nothing delivered yet" ? `Nothing made for ${c.name} yet this billing cycle` : `${c.name} is behind on creative`,
        story: `${allotmentLine(c.counts)} made with ${Math.round((c.elapsed ?? elapsed) * 100)}% of their billing cycle gone. They're paying for more than they're getting.`,
        why: "Under-delivering on what they pay for",
        evidence: [],
        action: { label: "New request", href: `/requests/new?client=${c.slug}` },
      });
  }
  return out;
}

/** What happened to items this person saw that are no longer open: who acted, and what they did. */
async function whatHappened(db: SupabaseClient, keys: { key: string; snapshot: { client?: string; title?: string; topic?: TopicKey } }[]): Promise<Resolved[]> {
  const out: Resolved[] = [];
  const name = async (id: string | null) => (id ? ((await db.from("profiles").select("full_name").eq("id", id).maybeSingle()).data?.full_name ?? null) : null);
  for (const { key, snapshot } of keys.slice(0, 12)) {
    const [kind, ...rest] = key.split(":");
    const base = { key, topic: snapshot.topic ?? "work", client: snapshot.client ?? "", title: snapshot.title ?? "" };
    if (kind === "brief" || kind === "onboarding") {
      const q = kind === "brief" ? db.from("creative_suggestions").select("status, decided_by, request_numbers, decline_reason").eq("id", rest[0]) : db.from("creative_suggestions").select("status, decided_by, request_numbers, decline_reason").eq("client_id", rest[0]).eq("kind", "onboarding").neq("status", "open").order("decided_at", { ascending: false }).limit(1);
      const { data } = await q.maybeSingle();
      if (!data) continue;
      const nums = (data.request_numbers ?? []) as number[];
      out.push({ ...base, by: await name(data.decided_by as string | null), what: data.status === "approved" ? `approved it${nums.length ? `; it's in production as ${nums.map((n) => `#${n}`).join(", ")}` : ""}` : data.status === "declined" ? `declined it${data.decline_reason ? `: ${data.decline_reason}` : ""}` : "closed it" });
    } else if (kind === "promise") {
      const { data } = await db.from("call_commitments").select("status, request_numbers, asana_gids, dismissed_by, dismiss_reason, suggestion_id").eq("id", rest[0]).maybeSingle();
      if (!data) continue;
      const nums = (data.request_numbers ?? []) as number[];
      // Who pushed its brief through, or who closed it
      const { data: brief } = data.suggestion_id ? await db.from("creative_suggestions").select("decided_by").eq("id", data.suggestion_id).maybeSingle() : { data: null };
      const by = (brief?.decided_by as string | null) ?? (data.dismissed_by as string | null);
      out.push({ ...base, by: await name(by), what: data.status === "in_motion" ? `put it in motion${nums.length ? ` as ${nums.map((n) => `#${n}`).join(", ")}` : (data.asana_gids ?? []).length ? " in Asana" : ""}` : `closed it${data.dismiss_reason ? `: ${data.dismiss_reason}` : ""}` });
    } else if (kind === "fatigue") {
      const { data } = await db.from("ad_fatigue").select("state, dismissed_by, dismiss_reason, request_numbers").eq("client_id", rest[0]).eq("ad_id", rest[1]).maybeSingle();
      if (!data) continue;
      const nums = (data.request_numbers ?? []) as number[];
      out.push({ ...base, by: await name(data.dismissed_by as string | null), what: data.state === "refreshing" ? `started a refresh${nums.length ? ` (${nums.map((n) => `#${n}`).join(", ")})` : ""}` : `set it aside${data.dismiss_reason ? `: ${data.dismiss_reason}` : ""}` });
    } else if (kind === "kpi") {
      const { data } = await db.from("account_audits").select("created_by, created_at").eq("target_id", rest[0]).order("created_at", { ascending: false }).limit(1).maybeSingle();
      out.push({ ...base, by: await name((data?.created_by as string | null) ?? null), what: data ? "ran an audit; an optimization sprint is under way" : "it's back on target" });
    } else if (kind === "said" || kind === "said2" || kind === "said-lead") {
      const { data } = await db.from("message_promises").select("status, owner_id, dismissed_by, evidence").eq("id", rest[0]).maybeSingle();
      if (!data) continue;
      out.push({ ...base, by: await name((data.dismissed_by ?? data.owner_id) as string | null), what: data.status === "dismissed" ? "closed it" : `it's moving${data.evidence ? `: ${data.evidence}` : ""}` });
    } else if (kind === "owed" || kind === "owed2" || kind === "owed-lead") {
      const { data } = await db.from("owed_replies").select("status, target_id, dismissed_by").eq("id", rest[0]).maybeSingle();
      if (!data) continue;
      out.push({ ...base, by: await name((data.status === "dismissed" ? data.dismissed_by : data.target_id) as string | null), what: data.status === "answered" ? "replied" : "marked it as not needing a reply" });
    } else out.push({ ...base, by: null, what: "it's been taken care of" });
  }
  return out;
}

/** Today's recap for this person: open items most critical first (with what they've done with each), and what got resolved. */
export async function loadToday(db: SupabaseClient, me: Staff): Promise<Today> {
  const [all, { data: mine }, { data: hiddenRows }] = await Promise.all([
    gather(db, me),
    db.from("daily_items").select("key, status, snapshot, first_seen_at").eq("profile_id", me.id),
    db.from("hidden_items").select("key").eq("profile_id", me.id),
  ]);
  // What they cleared off their Overview (Done or Dismiss there) leaves their day too, so the counts match
  const hidden = new Set((hiddenRows ?? []).map((h) => h.key as string));
  const asHidden = (key: string) => {
    const as = hideKeyOf(key);
    return Boolean(as && hidden.has(as));
  };
  const drafts = all.filter((d) => !asHidden(d.key));
  const state = new Map((mine ?? []).map((m) => [m.key as string, m]));
  const startOfDay = new Date(new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }) + "T04:00:00Z").toISOString();
  const items: TodayItem[] = drafts
    .filter((d) => !["done", "dismissed"].includes((state.get(d.key)?.status as string) ?? ""))
    .map((d) => {
      const s = state.get(d.key);
      const carried = Boolean(s && (s.first_seen_at as string) < startOfDay);
      // Something saved and carried over to a new day gets a nudge up: it's the reminder
      const score = d.score + (s?.status === "saved" && carried ? 4 : 0);
      return { ...d, score, tier: tierOf(score), state: ((s?.status as "seen" | "saved") ?? "new") as TodayItem["state"], carried };
    })
    .map((i) => (i.alt || !i.clientSlug || i.action.href?.startsWith(`/clients/${i.clientSlug}`) ? i : { ...i, alt: { label: "Client page", href: `/clients/${i.clientSlug}` } }))
    .sort((a, b) => b.score - a.score);
  // Seen or saved before, not acted on by this person, and gone now: someone else took care of it
  const live = new Set(drafts.map((d) => d.key));
  const gone = (mine ?? []).filter((m) => ["seen", "saved"].includes(m.status as string) && !live.has(m.key as string));
  const resolved = await whatHappened(db, gone.map((g) => ({ key: g.key as string, snapshot: g.snapshot as { client?: string; title?: string; topic?: TopicKey } })));
  const counts = { critical: 0, high: 0, normal: 0 };
  for (const i of items) counts[i.tier]++;
  return { items, resolved, counts, looks: countLooks(items) };
}
