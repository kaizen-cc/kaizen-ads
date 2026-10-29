import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isLive } from "@/lib/live";
import { askJson } from "@/lib/ai";
import { asanaSince } from "@/lib/calls";
import { slack } from "@/lib/context/slack";
import { addresses, gmailToken, google, plainText, withoutQuotes, type GmailMessage } from "@/lib/context/google";
import { LEAD_OF, notify, plain, workingHours, type Msg, type SlackWho } from "@/lib/owed-replies";
import { loadGroups, shadowedMessages, type PromiseGroup } from "@/lib/promise-groups";

// What the team said yes to in Slack or email, said any way people say it: "yes", but also "love it, let's run with
// that", "I'll get this over to design", "makes sense, will update tomorrow", or a 👍 on a clear ask. The scan hands
// over anything that sounds like taking something on; the AI reads it in its conversation and keeps only real
// commitments (ours to do), with what it is and when it was due. Then, like a promise on a call:
//   due and nothing shows it moving (a ticket or Asana task for it, or the thread: "sent", "it's live", "with design
//   now") → the person who said it hears; seen and still nothing → their lead and the execs, and a second notice.
// Movement closes it on its own; the person can also close it ("done, or not needed").

type Admin = SupabaseClient;
type Row = Record<string, unknown>;

/** Words that take something on, or agree to it. Wide on purpose: the AI decides with the conversation in front of it. */
export const COMMIT =
  /\b(yes|yep|yeah|yup|sure|absolutely|definitely|of course|sounds (good|great|perfect)|love (it|this|that)|let'?s (do|go|run|try|get|make|move|test|launch)|go (for it|ahead)|will do|on it|i'?ll|we'?ll|i will|we will|i can|we can|happy to|no problem|makes sense|agreed|great (idea|call|point)|good (idea|call|point)|let me|going to|gonna|i'?m (on|working)|we'?re (on|working)|get (it|that|this|them) (done|going|started|over|out|up|live|set)|by (mon|tues|wednes|thurs|fri|satur|sun)day|by (tomorrow|eod|eow|end of)|approved?|works for (me|us)|count (me|us) in|consider it done|leave it with (me|us)|i got (it|you)|we got (it|you))\b/i;
/** A message that asks for something (worth a thumbs-up meaning yes) */
export const REQUESTISH = /\?|\b(can (you|we|u)|could (you|we)|would (you|we)|please|pls|let'?s|want to|wanna|need (to|you|a|an|the)|should we|how about|what if|thoughts on|mind (if|doing)|asap)\b/i;
export const APPROVE_EMOJI = new Set(["+1", "thumbsup", "white_check_mark", "heavy_check_mark", "ok_hand", "raised_hands", "saluting_face", "ballot_box_with_check", "100", "fire", "muscle", "on-it", "onit", "eyes_done"]);

export type Candidate = {
  source: "slack" | "gmail";
  message_key: string;
  owner_id: string;
  client_id: string | null;
  channel_id?: string | null;
  channel_name?: string | null;
  thread_ts?: string | null;
  message_ts?: string | null;
  mailbox?: string | null;
  gmail_thread_id?: string | null;
  url: string | null;
  channel_url?: string | null;
  said_at: string;
  /** What they said (or "reacted 👍") */
  said: string;
  /** The conversation up to it, one line per message, with who's on the team marked */
  before: string;
};

const nyDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" });

/** A moment plus some working hours (weekdays 9–6, New York). */
function addWorkingHours(from: Date, hours: number) {
  let t = from.getTime();
  let left = hours;
  const ny = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", hour12: false });
  while (left > 0 && t < from.getTime() + 30 * 86_400_000) {
    t += 15 * 60_000;
    const parts = ny.formatToParts(new Date(t));
    const wd = parts.find((p) => p.type === "weekday")?.value;
    const h = Number(parts.find((p) => p.type === "hour")?.value) % 24;
    if (wd !== "Sat" && wd !== "Sun" && h >= 9 && h < 18) left -= 0.25;
  }
  return new Date(t);
}

type Found = { n: number; promise: boolean; what: string; kind: "creative" | "copy" | "offer" | "launch" | "change" | "task"; dueDays: number; askedBy: string; askedTeam: boolean; ask: string };

const FOUND_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          n: { type: "integer" },
          promise: { type: "boolean" },
          what: { type: "string" },
          kind: { type: "string", enum: ["creative", "copy", "offer", "launch", "change", "task"] },
          dueDays: { type: "integer" },
          askedBy: { type: "string" },
          askedTeam: { type: "boolean" },
          ask: { type: "string" },
        },
        required: ["n", "promise", "what", "kind", "dueDays", "askedBy", "askedTeam", "ask"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

/** Read what the scan found (each message once), keep the real commitments, and start watching them. */
export async function recordPromises(admin: Admin, found: Candidate[], names: Map<string, string>) {
  const fresh = [...new Map(found.map((c) => [`${c.source}|${c.message_key}`, c])).values()];
  if (!fresh.length) return { read: 0, promises: 0 };
  // Already read ones (a reaction is seen on every run) aren't read again
  const seen = new Set<string>();
  for (let i = 0; i < fresh.length; i += 150) {
    const { data } = await admin.from("message_promises").select("source, message_key").in("message_key", fresh.slice(i, i + 150).map((c) => c.message_key));
    for (const r of data ?? []) seen.add(`${r.source}|${r.message_key}`);
  }
  const todo = fresh.filter((c) => !seen.has(`${c.source}|${c.message_key}`)).slice(0, 120);
  let promises = 0;
  for (let i = 0; i < todo.length; i += 12) {
    const batch = todo.slice(i, i + 12);
    let out: { items: Found[] };
    try {
      out = await askJson<{ items: Found[] }>({
        agent: "calls",
        label: "promises in messages",
        bare: true,
        maxTokens: 5000,
        system: `You read conversations at Kaizen, a paid ads and creative agency, and decide whether someone on the team took something on: agreed to do what a client or teammate asked or suggested, or offered to do it. People rarely say a flat "yes". "Love this, let's run with it", "makes sense, I'll update the budget tomorrow", "I'll get this over to design", "good call, we'll test that next week", "on it", and a 👍 on a clear request all count. A plain "yes" counts only when it answers a request to do something.
Not a commitment: answering a question with information, a yes to a question of fact, thanks or acknowledgements that take nothing on ("noted", "nice"), something done in the same message ("done, here it is"), approving someone else to go do it themselves ("looks good, go ahead and launch" to a teammate: that's on them), and anything vague with nothing to actually do.
promise: true only when it's a real commitment by the person named as saying it. what: what they said they'd do, in a short line a person would say ("send the updated landing page", "run a Black Friday offer"), no names. kind: creative (ads or designs to make), copy, offer (an offer or promotion to run), launch (ads to launch or turn on), change (a change in an ad account: budget, audience, pausing), task (anything else: send something, review, follow up, a report). dueDays: business days they gave themselves from the day it was said (today 0, tomorrow 1, "by Friday" counted from that day); none said: 1 for a quick thing (a reply, a send, a small change), 3 for making creative or copy, 2 otherwise. askedBy: who asked for it (a first name), askedTeam: whether that person is on the team, ask: what was asked, in a short line.`,
        schema: FOUND_SCHEMA,
        prompt: batch
          .map((c, n) => `${n + 1}. ${c.source === "gmail" ? "Email" : `Slack #${c.channel_name ?? "a channel"}`}, ${nyDay(c.said_at)}.\nConversation before:\n${c.before || "(nothing before it)"}\n${names.get(c.owner_id) ?? "A teammate"} (team) said: ${c.said}`)
          .join("\n\n"),
      });
    } catch (e) {
      console.error("[promises] reading messages failed:", e instanceof Error ? e.message : e);
      continue;
    }
    const verdict = new Map(out.items.map((v) => [v.n, v]));
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const rows = batch.map(({ before, ...c }, n) => {
      const v = verdict.get(n + 1);
      const real = Boolean(v?.promise && v.what.trim());
      const days = Math.max(0, Math.min(15, v?.dueDays ?? 2));
      return {
        ...c,
        status: real ? "open" : "not_promise",
        what: v?.what?.slice(0, 200) ?? null,
        kind: real ? v!.kind : null,
        ask: v?.ask?.slice(0, 200) ?? null,
        asked_by: v?.askedBy?.slice(0, 80) ?? null,
        asked_team: Boolean(v?.askedTeam),
        // Due by the end of the day they named (today: a few working hours, so it isn't chased the same hour)
        due_at: real ? addWorkingHours(new Date(c.said_at), days === 0 ? 4 : days * 9).toISOString() : null,
        said: c.said.slice(0, 1500),
      };
    });
    const { error } = await admin.from("message_promises").upsert(rows, { onConflict: "source,message_key", ignoreDuplicates: true });
    if (error) console.error("[promises] saving failed:", error.message);
    promises += rows.filter((r) => r.status === "open").length;
  }
  return { read: todo.length, promises };
}

// ─── Following through ──────────────────────────────────────────────────────

/** What's been said since, where it was promised. */
async function since(p: Row, who: SlackWho | null): Promise<string> {
  try {
    if (p.source === "slack" && who) {
      const ts = String(p.message_ts);
      const thread = (p.thread_ts as string | null) ?? ts;
      const { messages } = await slack<{ messages: Msg[] }>("conversations.replies", { channel: String(p.channel_id), ts: thread, limit: "200" });
      const after = messages.filter((x) => Number(x.ts) > Number(ts));
      if (!p.thread_ts) {
        const { messages: later } = await slack<{ messages: Msg[] }>("conversations.history", { channel: String(p.channel_id), oldest: ts, limit: "40" });
        after.push(...later.filter((x) => Number(x.ts) > Number(ts) && !after.some((a) => a.ts === x.ts)));
      }
      return after
        .sort((a, b) => Number(a.ts) - Number(b.ts))
        .slice(-14)
        .map((x) => `${nyDay(new Date(Number(x.ts) * 1000).toISOString())} ${who.nameOf.get(x.user ?? "") ?? "Someone"}${x.user && who.team.has(x.user) ? " (team)" : ""}: ${plain(x.text ?? "", who.nameOf).replace(/\s+/g, " ").slice(0, 300)}`)
        .join("\n");
    }
    if (p.source === "gmail") {
      const token = await gmailToken(String(p.mailbox));
      const t = await google<{ messages: GmailMessage[] }>(token, `https://gmail.googleapis.com/gmail/v1/users/me/threads/${p.gmail_thread_id}`, { format: "full" });
      const at = new Date(String(p.said_at)).getTime();
      return t.messages
        .filter((m) => Number(m.internalDate) > at)
        .slice(-6)
        .map((m) => {
          const from = m.payload.headers.find((h) => h.name.toLowerCase() === "from")?.value ?? "";
          return `${nyDay(new Date(Number(m.internalDate)).toISOString())} ${from.replace(/<[^>]+>/, "").trim() || addresses(from)[0]}: ${withoutQuotes(plainText(m.payload) ?? m.snippet ?? "").replace(/\s+/g, " ").slice(0, 400)}`;
        })
        .join("\n");
    }
  } catch {
    // Can't read it right now: judged on tickets and tasks alone
  }
  return "";
}

type Move = { n: number; state: "done" | "moving" | "nothing"; evidence: string; tickets: number[]; asana: number[] };
const MOVE_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { n: { type: "integer" }, state: { type: "string", enum: ["done", "moving", "nothing"] }, evidence: { type: "string" }, tickets: { type: "array", items: { type: "integer" } }, asana: { type: "array", items: { type: "integer" } } },
        required: ["n", "state", "evidence", "tickets", "asana"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

/**
 * What changed in the client's ad accounts from a little before it was said (people often do it, then say so) until
 * now: paused, renamed, budgets, new ads. A promise to change something in the account is kept there, not in a ticket.
 */
async function accountChangesSince(admin: Admin, clientId: string, at: string) {
  const { data: targets } = await admin.from("kpi_targets").select("platform, ad_account_id").eq("client_id", clientId).eq("active", true);
  const ids = [...new Set((targets ?? []).filter((t) => t.ad_account_id).map((t) => (t.platform === "google" ? String(t.ad_account_id).replace(/\D/g, "") : String(t.ad_account_id).replace(/^act_/, ""))))];
  if (!ids.length) return "";
  const from = new Date(Date.parse(at) - 3 * 3_600_000).toISOString();
  const { data } = await admin.from("ad_account_changes").select("at, who, what, object").in("ad_account_id", ids).gte("at", from).order("at").limit(40);
  return (data ?? []).map((c) => `${nyDay(String(c.at))} ${c.who ?? "someone"}: ${c.what}${c.object ? ` (${String(c.object).slice(0, 80)})` : ""}`).join(" | ");
}

/** For each promise: done, moving (a ticket, a task, the thread, or the ad account shows it), or nothing yet. */
async function movement(admin: Admin, list: Row[], who: SlackWho | null, names: Map<string, string>) {
  const blocks: string[] = [];
  const tasksOf = new Map<string, { gid: string }[]>();
  for (const [i, p] of list.entries()) {
    const after = await since(p, who);
    let work = "";
    if (p.client_id) {
      const [{ data: tickets }, tasks, changes] = await Promise.all([
        admin.from("requests").select("number, title, brief").eq("client_id", p.client_id).gte("created_at", p.said_at).is("deleted_at", null).limit(15),
        asanaSince(admin, String(p.client_id), String(p.said_at)),
        accountChangesSince(admin, String(p.client_id), String(p.said_at)),
      ]);
      tasksOf.set(String(p.id), tasks);
      work = `Tickets made since: ${(tickets ?? []).map((t) => `#${t.number} "${t.title}": ${String(t.brief ?? "").replace(/\s+/g, " ").slice(0, 160)}`).join(" | ") || "none"}\nAsana tasks made since: ${tasks.map((t, n) => `A${n + 1} "${t.name}"`).join(" | ") || "none"}\nChanges in their ad accounts around then and since (Meta and Google's own history): ${changes || "none"}`;
    }
    blocks.push(`${i + 1}. ${names.get(String(p.owner_id)) ?? "A teammate"} said on ${nyDay(String(p.said_at))} they'd: ${p.what} (asked by ${p.asked_by ?? "someone"}: ${p.ask ?? ""})\nSaid since, where it was promised:\n${after || "(nothing)"}${work ? `\n${work}` : ""}`);
  }
  try {
    const out = await askJson<{ items: Move[] }>({
      agent: "calls",
      label: "promise follow-through",
      bare: true,
      maxTokens: 4000,
      system:
        "You check whether something the team said they'd do has happened or is moving. done: the later messages show it delivered (sent, shared, live, launched, changed, \"here it is\"), or the ad accounts' own change history shows it done (ads or ad sets paused or their status changed for a pause, names changed for a rename, budgets changed for a budget change), whoever's name is on it, since people use their own Meta or Google names. moving: a ticket or Asana task makes substantially the same thing, or the messages show it started or handed on (\"with design now\", \"drafting it\", a new date agreed with the person who asked). nothing: no sign of either. The person who asked dropping it (\"never mind\", \"let's hold off\") counts as done. evidence: one short line saying what showed it (or \"nothing since\"). tickets: the ticket numbers that cover it; asana: the Asana task numbers without the A.",
      schema: MOVE_SCHEMA,
      prompt: blocks.join("\n\n"),
    });
    return new Map(out.items.filter((m) => list[m.n - 1]).map((m) => [String(list[m.n - 1].id), { ...m, asanaGids: m.asana.map((a) => tasksOf.get(String(list[m.n - 1].id))?.[a - 1]?.gid).filter((g): g is string => Boolean(g)) }]));
  } catch (e) {
    console.error("[promises] follow-through check failed:", e instanceof Error ? e.message : e);
    return new Map<string, Move & { asanaGids: string[] }>();
  }
}

const ESCALATE_SEEN = 4;
const ESCALATE_UNSEEN = 9;
const whereOf = (p: Row) => (p.source === "gmail" ? "by email" : `in #${p.channel_name}`);

/** Due ones checked; nothing moving → the person who said it; still nothing once they've seen that → lead and execs. */
export async function followPromises(admin: Admin, who: SlackWho | null) {
  const nowIso = new Date().toISOString();
  const [{ data: open }, { data: people }] = await Promise.all([
    admin.from("message_promises").select("*").in("status", ["open", "overdue", "escalated"]).lte("due_at", nowIso).order("due_at").limit(80),
    admin.from("profiles").select("id, full_name, role, is_active"),
  ]);
  const byId = new Map((people ?? []).map((p) => [p.id as string, p]));
  const names = new Map((people ?? []).map((p) => [p.id as string, String(p.full_name ?? "").split(" ")[0] || "them"]));
  const tally = { checked: 0, moving: 0, notified: 0, escalated: 0, sameAsAnother: 0 };
  if (!open?.length) return tally;
  // Said about the same thing as a call promise with its brief, or as another message: chased once, there
  const shadow = await shadowedMessages(admin, open);
  tally.sameAsAnother = shadow.size;

  // Seen: the first notice read in the bell, or the card opened in their day
  const keys = open.filter((p) => p.status === "overdue").map((p) => `said:${p.id}`);
  const [{ data: reads }, { data: views }] = keys.length
    ? await Promise.all([admin.from("notifications").select("key, read_at").in("key", keys).not("read_at", "is", null), admin.from("daily_items").select("key, updated_at").in("key", keys)])
    : [{ data: [] }, { data: [] }];
  const seenAt = new Map<string, string>();
  for (const r of [...(reads ?? []).map((x) => ({ key: x.key, at: x.read_at })), ...(views ?? []).map((x) => ({ key: x.key, at: x.updated_at }))]) {
    const cur = seenAt.get(String(r.key));
    if (!cur || String(r.at) < cur) seenAt.set(String(r.key), String(r.at));
  }

  // Which to look at this run: newly due, overdue ones ready to escalate, escalated ones every few working hours
  // (overdue and escalated ones every couple of working hours, so a ticket made since closes them)
  const look = open.filter((p) => !shadow.has(p.id) && byId.get(p.owner_id)?.is_active && (p.status === "open" || !p.checked_at || workingHours(new Date(p.checked_at)) >= 2));
  const moves = new Map<string, Move & { asanaGids: string[] }>();
  for (let i = 0; i < look.length; i += 8) for (const [k, v] of await movement(admin, look.slice(i, i + 8), who, names)) moves.set(k, v);

  const { data: execs } = await admin.from("profiles").select("id").eq("is_active", true).eq("role", "executive");
  for (const p of look) {
    tally.checked++;
    const m = moves.get(p.id);
    if (m && m.state !== "nothing") {
      await admin.from("message_promises").update({ status: m.state === "done" ? "done" : "in_motion", evidence: m.evidence.slice(0, 300), request_numbers: m.tickets, asana_gids: m.asanaGids, checked_at: nowIso, closed_at: nowIso }).eq("id", p.id);
      await clearNotices(admin, `said`, p.id);
      if (p.status === "escalated") {
        const lead = LEAD_OF[String(byId.get(p.owner_id)?.role ?? "")];
        const { data: leads } = lead ? await admin.from("profiles").select("id").eq("is_active", true).eq("role", lead) : { data: [] };
        await notify(admin, [...new Set([...(leads ?? []), ...(execs ?? [])].map((x) => x.id as string))].filter((id) => id !== p.owner_id), {
          key: `said-moving:${p.id}`,
          kind: "promise",
          title: `${byId.get(p.owner_id)?.full_name ?? "Someone"}'s promise is moving: ${p.what}`,
          body: m.evidence,
          href: p.url,
          clientId: p.client_id,
          priority: "normal",
        });
      }
      tally.moving++;
      continue;
    }
    if (p.status === "open") {
      await admin.from("message_promises").update({ status: "overdue", notified_at: nowIso, checked_at: nowIso }).eq("id", p.id);
      await notify(admin, [p.owner_id], {
        key: `said:${p.id}`,
        kind: "promise",
        title: `You said you'd ${p.what}`,
        body: `${p.asked_by ?? "They"} asked ${whereOf(p)} on ${nyDay(p.said_at)}, and nothing shows it's happened yet. Do it or give them a date, or mark it done in your day.`,
        href: p.url,
        clientId: p.client_id,
        priority: "normal",
      });
      tally.notified++;
      continue;
    }
    if (p.status === "overdue") {
      const seen = seenAt.get(`said:${p.id}`);
      const ready = seen ? workingHours(new Date(seen)) >= ESCALATE_SEEN : workingHours(new Date(p.notified_at ?? p.due_at)) >= ESCALATE_UNSEEN;
      if (!ready) {
        await admin.from("message_promises").update({ checked_at: nowIso }).eq("id", p.id);
        continue;
      }
      const person = byId.get(p.owner_id);
      const lead = LEAD_OF[String(person?.role ?? "")];
      const { data: leads } = lead ? await admin.from("profiles").select("id").eq("is_active", true).eq("role", lead) : { data: [] };
      const above = [...new Set([...(leads ?? []), ...(execs ?? [])].map((x) => x.id as string))].filter((id) => id !== p.owner_id);
      await admin.from("message_promises").update({ status: "escalated", escalated_at: nowIso, checked_at: nowIso }).eq("id", p.id);
      await notify(admin, [p.owner_id], {
        key: `said2:${p.id}`,
        kind: "promise",
        title: `Second notice: you said you'd ${p.what}`,
        body: `${p.asked_by ?? "They"} is still waiting (asked ${whereOf(p)} on ${nyDay(p.said_at)}). ${above.length ? "Your lead and the exec team have been told." : "The exec team has been told."}`,
        href: p.url,
        clientId: p.client_id,
        priority: "critical",
      });
      await notify(admin, above, {
        key: `said-lead:${p.id}`,
        kind: "promise",
        title: `${person?.full_name ?? "Someone"} said they'd ${p.what}, and it hasn't happened`,
        body: `Promised to ${p.asked_by ?? "someone"} ${whereOf(p)} on ${nyDay(p.said_at)}; they had a notice and nothing's moved.`,
        href: p.url,
        clientId: p.client_id,
        priority: "critical",
      });
      tally.escalated++;
      continue;
    }
    await admin.from("message_promises").update({ checked_at: nowIso }).eq("id", p.id);
  }
  // A month on, nobody's chasing it any more
  await admin.from("message_promises").update({ status: "dismissed", dismiss_reason: "A month old" }).in("status", ["open", "overdue"]).lt("said_at", new Date(Date.now() - 30 * 86_400_000).toISOString());
  return tally;
}

/** The person's unread notices about it come off the bell once it's resolved. */
export async function clearNotices(admin: Admin, prefix: "said" | "owed", id: string) {
  const keys = prefix === "said" ? [`said:${id}`, `said2:${id}`, `said-lead:${id}`] : [`owed:${id}`, `owed2:${id}`, `owed-lead:${id}`];
  await admin.from("notifications").update({ cleared_at: new Date().toISOString() }).in("key", keys).is("read_at", null).is("cleared_at", null);
}

// ─── Reading ────────────────────────────────────────────────────────────────

export type SaidPromise = {
  id: string;
  source: "slack" | "gmail";
  status: "overdue" | "escalated";
  ownerId: string;
  owner: string;
  what: string;
  ask: string | null;
  askedBy: string | null;
  said: string;
  saidAt: string;
  dueAt: string;
  where: string;
  url: string | null;
  channelUrl: string | null;
  kind: string | null;
  client: string | null;
  clientSlug: string | null;
  clientId: string | null;
  group: PromiseGroup | null;
};

/** Promises from messages past due with nothing moving: the person's own, and (leads, execs) escalated ones. */
export async function loadSaidPromises(db: SupabaseClient, me: { id: string; role: string; isExec: boolean; isLead: boolean }): Promise<SaidPromise[]> {
  const { data } = await db
    .from("message_promises")
    .select("id, source, status, owner_id, what, ask, asked_by, said, said_at, due_at, channel_name, url, channel_url, kind, client_id, group_id, clients(name, slug, status, archived_at), owner:profiles!message_promises_owner_id_fkey(full_name, role)")
    .in("status", ["overdue", "escalated"])
    .order("due_at")
    .limit(80);
  const shadow = await shadowedMessages(db, (data ?? []) as { id: string; group_id: string | null; due_at: string | null }[]);
  const groups = await loadGroups(db, (data ?? []).map((p) => p.group_id as string));
  return (data ?? [])
    .filter((p) => !shadow.has(p.id as string))
    // A paused or archived client's yeses aren't chased on the board
    .filter((p) => {
      const c = p.clients as unknown as { status?: string | null; archived_at?: string | null } | null;
      return !c || isLive(c);
    })
    .filter((p) => {
      if (p.owner_id === me.id) return true;
      if (!(me.isExec || me.isLead) || p.status !== "escalated") return false;
      if (me.isExec) return true;
      return LEAD_OF[(p.owner as unknown as { role: string } | null)?.role ?? ""] === me.role;
    })
    .map((p) => {
      const c = p.clients as unknown as { name: string; slug: string } | null;
      return {
        id: p.id as string,
        source: p.source as SaidPromise["source"],
        status: p.status as SaidPromise["status"],
        ownerId: p.owner_id as string,
        owner: (p.owner as unknown as { full_name: string } | null)?.full_name ?? "Someone",
        what: String(p.what ?? ""),
        ask: (p.ask as string | null) ?? null,
        askedBy: (p.asked_by as string | null) ?? null,
        said: String(p.said ?? ""),
        saidAt: p.said_at as string,
        dueAt: p.due_at as string,
        where: whereOf(p),
        url: (p.url as string | null) ?? null,
        channelUrl: (p.channel_url as string | null) ?? null,
        kind: (p.kind as string | null) ?? null,
        client: c?.name ?? null,
        clientSlug: c?.slug ?? null,
        clientId: (p.client_id as string | null) ?? null,
        group: p.group_id ? (groups.get(p.group_id as string) ?? null) : null,
      };
    });
}
