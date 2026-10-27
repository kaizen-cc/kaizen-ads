import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { loadWatchList } from "@/lib/fatigue";
import { loadHome } from "@/lib/home";
import { loadOwedReplies } from "@/lib/owed-replies";
import { loadCallPromises, loadOnboarding, loadSuggestions, type OpenSuggestion } from "@/lib/suggestions";
import { assetsStale } from "@/lib/client-assets";
import { LIVE } from "@/lib/live";

// The daily recap: everything that needs an exec or lead today, one item at a time, most critical first. Critical
// means it can cost us the client: a promise we made and haven't kept, a new client waiting on us, an important
// account well off its target, work late on our side. Then what's important but not urgent, then the rest. Each
// person saves an item for later (their list for the day, and a reminder tomorrow), acts on it, or dismisses it; an
// item they saw that someone else has since acted on comes back once as "taken care of", with who and what.

export type Tier = "critical" | "high" | "normal";
export type TopicKey = "mine" | "promises" | "onboarding" | "accounts" | "work" | "briefs" | "ads" | "allotments";
export const TOPICS: Record<TopicKey, { label: string; blurb: string }> = {
  mine: { label: "Your work", blurb: "Tickets and tasks on you" },
  promises: { label: "Waiting on us", blurb: "Promised to clients, messages nobody answered" },
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
  action: { label: string; href?: string; suggestion?: OpenSuggestion };
  /** The other place to look: the client page, or the account on the KPI board */
  alt?: { label: string; href: string };
  /** What setting it aside means here, when it's more than "not for me" */
  dismiss?: string;
  state: "new" | "seen" | "saved"; // what this person has done with it so far
  carried: boolean; // came up on an earlier day and is still open
  image?: string | null;
};
export type Resolved = { key: string; topic: TopicKey; client: string; title: string; by: string | null; what: string };
export type Today = { items: TodayItem[]; resolved: Resolved[]; counts: Record<Tier, number> };

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
  if (me.isCoordinator) ["promises", "onboarding", "allotments"].forEach((k) => t.add(k as TopicKey));
  // Each lead sees their own line: no ad accounts for the Head of Creative, no Meta ads wearing out for the Head of Google
  if (me.role === "head_of_creative") t.delete("accounts");
  if (me.role === "head_of_google") t.delete("ads");
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
  return out;
}

/** Every item for this person right now, scored. */
async function gather(db: SupabaseClient, me: Staff): Promise<Draft[]> {
  const topics = topicsFor(me);
  const manager = me.isExec || me.isLead;
  const callPromises = manager || me.isBuyer || me.isCoordinator;
  const [promises, onboarding, suggestions, fatigue, home, own, owed] = await Promise.all([
    callPromises ? loadCallPromises(db).catch(() => []) : [],
    topics.has("onboarding") ? loadOnboarding(db).catch(() => null) : null,
    topics.has("briefs") ? loadSuggestions(db).catch(() => null) : null,
    topics.has("ads") ? loadWatchList(db, manager ? { limit: 20 } : { buyerId: me.id, limit: 20 }).catch(() => []) : [],
    topics.has("work") || topics.has("allotments") ? loadHome(db, me).catch(() => null) : null,
    mine(db, me).catch(() => []),
    loadOwedReplies(db, me).catch(() => []),
  ]);
  const out: Draft[] = [...own];

  // Messages nobody answered: the person's own after a first notice, and (for leads and execs) ones that were escalated
  for (const o of owed) {
    const waited = Math.max(1, bizDays(o.askedAt));
    const mineToo = o.targetId === me.id;
    const second = o.status === "escalated";
    const where = o.source === "gmail" ? "Open the email" : "Open in Slack";
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
      action: { label: where, href: o.url ?? o.channelUrl ?? "/today" },
      ...(o.channelUrl ? { alt: { label: "Open the channel", href: o.channelUrl } } : {}),
      ...(mineToo ? { dismiss: "Doesn't need a reply" } : {}),
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
      title: p.what,
      story: `We said this on "${p.callTitle}" (${day(p.callAt)}). Nothing is in production for it yet.`,
      why: "The client heard us promise it",
      evidence: [],
      action: p.suggestion ? { label: "Review the brief", suggestion: p.suggestion } : { label: "Open the client", href: `/clients/${p.clientSlug}` },
    });
  }

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
        story: c.firstRound.draft.title ? `"${c.firstRound.draft.title}". Approve it to put their first creative into production.` : "Approve it to put their first creative into production.",
        why: "A new client's first impression",
        evidence: c.firstRound.evidence.slice(0, 3),
        action: { label: "Review the first round", suggestion: c.firstRound },
      });
    } else if (manager || me.isCoordinator ? !c.intake || c.intake.status === "unmatched" : false) {
      const waited = bizDays(c.since);
      if (waited >= 3)
        out.push({
          key: `intake:${c.clientId}`,
          topic: "onboarding",
          score: 58 + Math.min(10, waited),
          client: c.name,
          clientSlug: c.slug,
          clientId: c.clientId,
          stat: { value: String(waited), label: "days waiting on their intake form" },
          title: `${c.name} hasn't sent their intake form`,
          story: c.setup?.notes ? `From the onboarding checklist: ${c.setup.notes.slice(0, 220)}` : "Their first round can't be written well without it. A nudge from their account manager usually does it.",
          why: "Onboarding stalls without it",
          evidence: [],
          action: { label: "Open the client", href: `/clients/${c.slug}` },
        });
    }
  }

  // Accounts off target, weighted by how far off, how much is spent and how important the account is
  // Each service line on its own, for the people on it: execs both, the Head of Meta Meta, the Head of Google Google,
  // a buyer only the accounts they own
  let kq = db.from("kpi_targets").select("id, label, platform, conversion, target, monthly_budget, sheet, client_id, clients!inner(name, slug, archived_at)").eq("active", true).is("clients.archived_at", null);
  if (!manager) kq = kq.eq("owner_id", me.id);
  else if (me.role === "head_of_meta") kq = kq.eq("platform", "meta");
  else if (me.role === "head_of_google") kq = kq.eq("platform", "google");
  const { data: targets } = topics.has("accounts") ? await kq : { data: [] };
  const ids = (targets ?? []).map((t) => t.id as string);
  const { data: snaps } = ids.length ? await db.from("kpi_snapshots").select("target_id, status, deviation, windows, budget").in("target_id", ids) : { data: [] };
  for (const t of targets ?? []) {
    const s = (snaps ?? []).find((x) => x.target_id === t.id);
    if (!s || !["off", "close"].includes(s.status as string)) continue;
    const c = t.clients as unknown as { name: string; slug: string };
    const dev = Number(s.deviation ?? 0);
    const d7 = (s.windows as { d7?: { spend?: number; value?: number | null; results?: number } } | null)?.d7;
    const priority = String((t.sheet as { priority?: string } | null)?.priority ?? "").toLowerCase();
    const budget = Number(t.monthly_budget ?? 0);
    const roas = t.conversion === "roas";
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
      title: `${c.name} · ${t.platform === "google" ? "Google" : "Meta"}${t.label ? ` ${t.label}` : ""} is ${s.status === "off" ? "off" : "close to"} target`,
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

  // Clients with nothing new on Drive in 45 days and no shot list sent lately: ask them for fresh footage
  if (topics.has("briefs")) {
    const [{ data: pkg }, { data: media }, { data: sent }] = await Promise.all([
      db.from("clients").select("id, name, slug").eq("creative_package", true).is("archived_at", null).in("status", [...LIVE]),
      db.from("client_assets").select("client_id, created_at").in("kind", ["image", "video"]).order("created_at", { ascending: false }).limit(5000),
      db.from("shot_lists").select("client_id, created_at").gte("created_at", new Date(Date.now() - 30 * 86_400_000).toISOString()),
    ]);
    const newest = new Map<string, string>();
    for (const m of media ?? []) if (!newest.has(m.client_id)) newest.set(m.client_id, m.created_at);
    const asked = new Set((sent ?? []).map((s) => s.client_id));
    for (const c of pkg ?? []) {
      const last = newest.get(c.id) ?? null;
      if (asked.has(c.id) || !assetsStale(last)) continue;
      const days = last ? Math.round((Date.now() - Date.parse(last)) / 86_400_000) : null;
      out.push({
        key: `assets:${c.id}:${new Date().toISOString().slice(0, 7)}`,
        topic: "briefs",
        score: 50,
        client: c.name,
        clientSlug: c.slug,
        clientId: c.id,
        stat: { value: days == null ? "None" : `${days}d`, label: days == null ? "photos or video on Drive" : "since new footage landed on Drive" },
        title: `Ask ${c.name} for fresh footage`,
        story: `${days == null ? "There's nothing on their Drive to make creative from." : `Nothing new has landed on their Drive in ${days} days.`} A shot list for next month tells them exactly what to film, from what's planned and what's winning.`,
        why: "Fresh creative needs fresh footage",
        evidence: [],
        action: { label: "Write the shot list", href: `/clients/${c.slug}#shot-list` },
      });
    }
  }

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
      story: `${r.client}'s ad is ${r.severity === "tired" ? "worn out and ready to replace" : "starting to slip"}.${r.briefId ? " A refresh brief is written and ready." : ""}`,
      why: r.severity === "tired" ? "Results slipping on a live ad" : "Early signs of wear",
      evidence: [],
      action: { label: "Client page", href: `/clients/${r.clientSlug}` },
      alt: { label: "KPI board", href: `/kpis?client=${r.clientSlug}` },
      image: r.thumbnail,
    });
  }

  // Allotments: the risk is a client getting less than they pay for (nothing made a third of the way in, or far
  // behind). A client getting extra isn't a problem to flag.
  const elapsed = home?.monthElapsed ?? 0;
  for (const c of topics.has("allotments") ? (home?.clients ?? []) : []) {
    if (!c.allotment) continue;
    if (c.note === "Nothing delivered yet" || c.note === "Behind on creative")
      out.push({
        key: `allot-behind:${c.slug}`,
        topic: "allotments",
        score: c.note === "Nothing delivered yet" ? 74 : 61,
        client: c.name,
        clientSlug: c.slug,
        clientId: null,
        stat: { value: `${c.used}/${c.allotment}`, label: "creatives this month" },
        title: c.note === "Nothing delivered yet" ? `Nothing made for ${c.name} yet this month` : `${c.name} is behind on creative`,
        story: `${c.used} of ${c.allotment} made with ${Math.round(elapsed * 100)}% of the month gone. They're paying for more than they're getting.`,
        why: "Under-delivering on what they pay for",
        evidence: [],
        action: { label: "New request", href: `/requests/new` },
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
  const [drafts, { data: mine }] = await Promise.all([gather(db, me), db.from("daily_items").select("key, status, snapshot, first_seen_at").eq("profile_id", me.id)]);
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
  return { items, resolved, counts };
}
