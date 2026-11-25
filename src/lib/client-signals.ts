import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { nyClock } from "@/lib/routines-core";
import { PEOPLE_RULE } from "@/lib/people-matters";
import { automatedTemplates, isTeamAuthor, onHold, recurringDue, refsToIds, templateOf, type Recurring } from "@/lib/client-signals-core";

// What clients (and the team) said in shared client channels and email that changes the work (Nov 25 2026, the safety
// check of the OS against an exec's Claude runs), read every half hour with the floating sweep, each message once:
// - a cancellation ("no Black Friday this year") closes the related open reminders, drafts and promises across every
//   owner, with the client's words, and makes the work it implies for the line owners (unschedule the sends, confirm
//   nothing is queued, check before any ad runs)
// - a client ask with a date ("holiday event ads live by 11/30, off after 12/3") becomes a task with that deadline for
//   the line's owner, not only a reply being watched
// - a hold or crisis ("don't send anything until the relaunch is approved") pauses automated client sends: a task to
//   pause them, and any automated email that still goes out to that client becomes an item for its owner
// - a recurring reporting commitment ("daily registrations and cost per registration until 12/5") becomes the owner's
//   item on each day it's due, until its end
// Never a client's fee; people matters never become anything.

type Admin = SupabaseClient;
const DAY = 86_400_000;
const WINDOW_H = 72;

type Msg = { id: string; client_id: string; source: string; occurred_at: string; author: string | null; title: string | null; body: string | null; url: string | null };
type Task = { owner: string | null; title: string; due: string | null; detail: string };
type Signal = { kind: "cancel" | "dated_request" | "hold" | "resume" | "recurring"; topic: string; quote: string; kill: string[]; tasks: Task[]; recurring: { owner: string | null; what: string; cadence: "daily" | "weekdays" | "weekly"; weekday: number | null; until: string | null } | null };

const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          n: { type: "integer" },
          signals: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["cancel", "dated_request", "hold", "resume", "recurring"] },
                topic: { type: "string", description: "What it's about, a few words (\"Black Friday\", \"holiday event ads\")" },
                quote: { type: "string", description: "The exact words that say it, copied" },
                kill: { type: "array", items: { type: "string" }, description: "cancel/hold: the open items (A1…) and promises (P1…) this makes moot" },
                tasks: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { owner: { type: ["string", "null"], description: "The teammate's name from the client's team, by their seat" }, title: { type: "string", description: "Verb-first, under 12 words" }, due: { type: ["string", "null"], description: "YYYY-MM-DD" }, detail: { type: "string" } },
                    required: ["owner", "title", "due", "detail"],
                    additionalProperties: false,
                  },
                },
                recurring: {
                  anyOf: [
                    { type: "null" },
                    {
                      type: "object",
                      properties: { owner: { type: ["string", "null"] }, what: { type: "string" }, cadence: { type: "string", enum: ["daily", "weekdays", "weekly"] }, weekday: { type: ["integer", "null"] }, until: { type: ["string", "null"] } },
                      required: ["owner", "what", "cadence", "weekday", "until"],
                      additionalProperties: false,
                    },
                  ],
                },
              },
              required: ["kind", "topic", "quote", "kill", "tasks", "recurring"],
              additionalProperties: false,
            },
          },
        },
        required: ["n", "signals"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

/** Reads the new messages and acts on them; then the day's recurring items and the hold watch */
export async function runClientSignals(admin: Admin, opts: { clients?: number } = {}) {
  const tally = { read: 0, signals: 0, killed: 0, made: 0, recurring: 0, holdSends: 0 };
  const since = new Date(Date.now() - WINDOW_H * 3_600_000).toISOString();
  const [{ data: msgs }, { data: people }] = await Promise.all([
    admin.from("context_items").select("id, client_id, source, occurred_at, author, title, body, url").in("source", ["slack_external", "gmail"]).not("client_id", "is", null).gte("occurred_at", since).order("occurred_at").limit(600),
    admin.from("profiles").select("id, full_name, display_name, is_active").eq("is_active", true),
  ]);
  const team = (people ?? []).flatMap((p) => [p.full_name, p.display_name].filter((x): x is string => Boolean(x)));
  const ids = (msgs ?? []).map((m) => m.id as string);
  const seen = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await admin.from("client_signals").select("context_item_id").in("context_item_id", ids.slice(i, i + 200));
    for (const r of data ?? []) seen.add(r.context_item_id as string);
  }
  const todo = ((msgs ?? []) as Msg[]).filter((m) => !seen.has(m.id) && String(m.body ?? "").trim().length > 15);
  const byClient = new Map<string, Msg[]>();
  for (const m of todo) byClient.set(m.client_id, [...(byClient.get(m.client_id) ?? []), m]);
  const today = nyClock(new Date()).date;
  for (const [clientId, list] of [...byClient].slice(0, opts.clients ?? 10)) {
    const batch = list.slice(-14);
    const r = await readClient(admin, clientId, batch, team, today).catch((e) => {
      console.error("[client-signals]", clientId, e instanceof Error ? e.message : e);
      return null;
    });
    if (!r) continue;
    tally.read += batch.length;
    tally.signals += r.signals;
    tally.killed += r.killed;
    tally.made += r.made;
  }
  tally.recurring = await recurringToday(admin).catch(() => 0);
  tally.holdSends = await holdWatch(admin).catch(() => 0);
  return tally;
}

async function readClient(admin: Admin, clientId: string, batch: Msg[], team: string[], today: string) {
  const { clientTeam } = await import("@/lib/assistant/routing-server");
  const [ct, { data: asks }, { data: promises }] = await Promise.all([
    clientTeam(admin, clientId),
    admin.from("agent_asks").select("id, title, owner_id, status, profiles!agent_asks_owner_id_fkey(full_name)").eq("client_id", clientId).eq("status", "open").order("created_at", { ascending: false }).limit(50),
    admin.from("message_promises").select("id, what, owner_id, status").eq("client_id", clientId).in("status", ["open", "overdue", "escalated", "in_motion"]).order("said_at", { ascending: false }).limit(40),
  ]);
  if (!ct) return null;
  const seats = ct.seats.map((s) => `${s.seat.replace(/_/g, " ")}: ${s.name}${s.primary === false ? " (second)" : ""}`).join("; ");
  const askRows = (asks ?? []) as unknown as { id: string; title: string; profiles: { full_name: string } | null }[];
  const promiseRows = (promises ?? []) as { id: string; what: string | null }[];
  const out = await askJson<{ items: { n: number; signals: Signal[] }[] }>({
    agent: "calls",
    label: "client signals",
    clientId,
    override: { model: "sonnet", effort: "low" },
    maxTokens: 4000,
    system: `You read new messages in a client's shared Slack channel and email with Kaizen, a paid ads, creative, email and social agency, and pick out only what changes the work. Most messages change nothing: return no signals for them.
cancel: the CLIENT calls off or drops something (a promotion, a send, a campaign, a meeting, an ask): kill the open items and promises it makes moot, and add the tasks it implies for the line owners (e.g. unschedule related sends, confirm nothing related is queued, check before any related ad runs).
dated_request: the CLIENT asks for work with a date or deadline (go live by, take down after, send on): one task per piece, due on that date (YYYY-MM-DD; this year unless said), for the owner of the line it belongs to; include the details given (offers, prices to their customers, dates on and off).
hold: anyone says the client is on hold, paused, in a dispute or crisis, or that nothing should go to them until something is approved: kill reminders and promises that would contact them, and one task for the account's owner to pause every automated send to the client (reports, check-ins, review emails, sequences) until it's lifted.
resume: a hold is lifted.
recurring: a TEAMMATE commits to a repeating deliverable ("I'll send registrations and cost per registration daily until 12/5"): owner (that teammate), what, cadence, weekday for weekly (0 Sunday), until (YYYY-MM-DD or null).
Owners are names from the client's team: ${seats || "none listed"}. Never state what Kaizen charges the client. ${PEOPLE_RULE} Today is ${today}.`,
    schema: SCHEMA,
    prompt: [
      `Client: ${ct.name}`,
      `Open items:\n${askRows.map((a, i) => `A${i + 1}. ${a.title}${a.profiles?.full_name ? ` (${a.profiles.full_name})` : ""}`).join("\n") || "none"}`,
      `Open promises:\n${promiseRows.map((p, i) => `P${i + 1}. ${p.what ?? ""}`).join("\n") || "none"}`,
      `New messages:\n${batch.map((m, i) => `${i + 1}. [${m.occurred_at.slice(0, 16)} · ${m.source === "gmail" ? "email" : "shared Slack"} · ${m.author ?? "someone"}${isTeamAuthor(m.author, team) ? " (Kaizen team)" : " (client)"}] ${m.title ? `${m.title}: ` : ""}${String(m.body ?? "").replace(/\s+/g, " ").slice(0, 900)}`).join("\n")}`,
    ].join("\n\n"),
  });
  const { createItemIfNew } = await import("@/lib/reality-check");
  const { blockedForPeople } = await import("@/lib/people-matters");
  const ownerOf = (name: string | null) => {
    const n = String(name ?? "").trim().toLowerCase();
    const hit = n ? ct.seats.find((s) => s.name.toLowerCase() === n || s.name.toLowerCase().split(" ")[0] === n.split(" ")[0]) : null;
    return hit ?? ct.seats.find((s) => s.primary !== false) ?? null;
  };
  const tally = { signals: 0, killed: 0, made: 0 };
  const verdict = new Map(out.items.map((i) => [i.n, i.signals ?? []]));
  for (const [i, m] of batch.entries()) {
    const sigs = (verdict.get(i + 1) ?? []).filter((s) => !blockedForPeople({ text: `${s.topic}\n${s.quote}` }));
    const outcome: { killed: string[]; made: string[]; recurring?: Recurring } = { killed: [], made: [] };
    for (const [k, s] of sigs.entries()) {
      tally.signals++;
      const when = new Date(m.occurred_at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
      const why = `${s.kind === "hold" ? "On hold" : "Client cancelled"} (${when}${m.author ? `, ${m.author.replace(/<[^>]*>/g, "").trim()}` : ""}): "${s.quote.slice(0, 300)}"`;
      if (s.kind === "cancel" || s.kind === "hold") {
        const kill = refsToIds(s.kill, askRows, promiseRows);
        for (const id of kill.asks) {
          const { data: it } = await admin.from("agent_asks").select("detail, status").eq("id", id).maybeSingle();
          if (!it || it.status !== "open") continue;
          await admin.from("agent_asks").update({ status: "dismissed", done_at: new Date().toISOString(), detail: `${String(it.detail ?? "").trim()}\n${why}${m.url ? ` ${m.url}` : ""}`.trim().slice(0, 4000) }).eq("id", id);
          outcome.killed.push(`ask:${id}`);
        }
        for (const id of kill.promises) {
          await admin.from("message_promises").update({ status: "dismissed", dismiss_reason: why.slice(0, 300), closed_at: new Date().toISOString() }).eq("id", id).in("status", ["open", "overdue", "escalated", "in_motion"]);
          outcome.killed.push(`said:${id}`);
        }
        tally.killed += kill.asks.length + kill.promises.length;
      }
      for (const [t, task] of s.tasks.slice(0, 5).entries()) {
        const owner = ownerOf(task.owner);
        if (!owner || blockedForPeople({ text: `${task.title}\n${task.detail}` })) continue;
        const due = task.due && /^\d{4}-\d{2}-\d{2}$/.test(task.due) ? task.due : null;
        const r = await createItemIfNew(admin, {
          owner_id: owner.profileId,
          client_id: clientId,
          title: `[Client ${today.slice(5, 7)}/${today.slice(8, 10)}] ${task.title}`.slice(0, 300),
          detail: `${task.detail}\n${s.kind === "dated_request" ? "Asked" : s.kind === "hold" ? "Hold" : "Cancelled"} by the client: "${s.quote.slice(0, 400)}"${m.url ? `\n${m.url}` : ""}\n(Created by Kaizen OS from the client's message.)`,
          due_on: due,
          urgent: Boolean(due && Date.parse(due) - Date.parse(today) <= 2 * DAY) || s.kind === "hold",
          source_ref: `signal:${m.id}:${k}:${t}`,
        });
        if (r.state === "new" && r.id) {
          outcome.made.push(`ask:${r.id}`);
          tally.made++;
        }
      }
      if (s.kind === "recurring" && s.recurring) {
        const owner = ownerOf(s.recurring.owner);
        if (owner) outcome.recurring = { ownerId: owner.profileId, owner: owner.name, what: s.recurring.what.slice(0, 200), cadence: s.recurring.cadence, weekday: s.recurring.weekday, until: s.recurring.until, from: m.occurred_at };
      }
    }
    const main = sigs.find((s) => s.kind === "hold" || s.kind === "resume")?.kind ?? sigs[0]?.kind ?? "none";
    await admin.from("client_signals").upsert({ context_item_id: m.id, client_id: clientId, said_at: m.occurred_at, kind: main, signals: sigs, outcome }, { onConflict: "context_item_id", ignoreDuplicates: true });
  }
  return tally;
}

/** Each recurring commitment's item for today, for its owner (once a day; the done-check closes it when it's sent) */
async function recurringToday(admin: Admin): Promise<number> {
  const { data } = await admin.from("client_signals").select("id, client_id, outcome").not("outcome->recurring", "is", null).gte("said_at", new Date(Date.now() - 60 * DAY).toISOString()).limit(200);
  const clock = nyClock(new Date());
  let made = 0;
  for (const s of data ?? []) {
    const r = (s.outcome as { recurring?: Recurring } | null)?.recurring;
    if (!r || !recurringDue(r, clock.date, clock.weekday)) continue;
    const ref = `recurring:${s.id}:${clock.date}`;
    const { data: have } = await admin.from("agent_asks").select("id").eq("source_ref", ref).limit(1).maybeSingle();
    if (have) continue;
    const { error } = await admin.from("agent_asks").insert({
      kind: "task",
      owner_id: r.ownerId,
      asked_by: r.ownerId,
      client_id: s.client_id,
      title: `[Client ${clock.date.slice(5, 7)}/${clock.date.slice(8, 10)}] Send today's ${r.what}`.slice(0, 300),
      detail: `A recurring commitment (${r.cadence}${r.until ? ` until ${r.until}` : ""}): ${r.what}.\n(Created by Kaizen OS each day it's due.)`,
      due_on: clock.date,
      source_ref: ref,
    });
    if (!error) made++;
  }
  return made;
}

/** A client on hold: any automated email still going to them becomes an item for the account's owner, once each */
async function holdWatch(admin: Admin): Promise<number> {
  const { data: rows } = await admin.from("client_signals").select("client_id, kind, said_at").in("kind", ["hold", "resume"]).gte("said_at", new Date(Date.now() - 45 * DAY).toISOString()).limit(500);
  const by = new Map<string, { kind: string; said_at: string }[]>();
  for (const r of rows ?? []) by.set(r.client_id as string, [...(by.get(r.client_id as string) ?? []), { kind: r.kind as string, said_at: r.said_at as string }]);
  const held = [...by].map(([c, rs]) => ({ clientId: c, hold: onHold(rs) })).filter((x): x is { clientId: string; hold: { since: string } } => Boolean(x.hold));
  if (!held.length) return 0;
  // The automated subjects: sent from the team's mailboxes to three or more clients in the last 60 days
  const { data: sent } = await admin.from("context_items").select("id, client_id, title, author, occurred_at, url, clients(name)").eq("source", "gmail").ilike("author", "%kaizenmarketing.agency%").gte("occurred_at", new Date(Date.now() - 60 * DAY).toISOString()).limit(3000);
  const rowsSent = (sent ?? []).map((s) => ({ ...s, client: (s.clients as unknown as { name: string } | null)?.name ?? "" }));
  const templates = automatedTemplates(rowsSent.map((s) => ({ client: s.client, title: String(s.title ?? "") })));
  const { clientTeam } = await import("@/lib/assistant/routing-server");
  let made = 0;
  for (const h of held) {
    const hits = rowsSent.filter((s) => s.client_id === h.clientId && String(s.occurred_at) > h.hold.since && templates.has(templateOf(String(s.title ?? ""), s.client)));
    if (!hits.length) continue;
    const ct = await clientTeam(admin, h.clientId);
    const owner = ct?.seats.find((s) => s.primary !== false);
    if (!owner) continue;
    // One item per automated email and hold (each later send of it lands on the same item)
    for (const s of [...new Map(hits.map((x) => [templateOf(String(x.title ?? ""), x.client), x])).values()].slice(0, 5)) {
      const ref = `holdsend:${h.clientId}:${h.hold.since.slice(0, 10)}:${templateOf(String(s.title ?? ""), s.client).slice(0, 60)}`;
      const { data: have } = await admin.from("agent_asks").select("id").eq("source_ref", ref).limit(1).maybeSingle();
      if (have) continue;
      const { error } = await admin.from("agent_asks").insert({
        kind: "task",
        owner_id: owner.profileId,
        asked_by: owner.profileId,
        client_id: h.clientId,
        title: `Pause automated emails to ${s.client} during the hold`.slice(0, 300),
        detail: `"${s.title}" still went to ${s.client} on ${String(s.occurred_at).slice(0, 10)} while they're on hold (since ${h.hold.since.slice(0, 10)}). Pause the automation that sends it (Zapier, a sequence) until the hold is lifted.${s.url ? `\n${s.url}` : ""}\n(Created by Kaizen OS.)`,
        due_on: nyClock(new Date()).date,
        urgent: true,
        source_ref: ref,
      });
      if (!error) made++;
    }
  }
  return made;
}
