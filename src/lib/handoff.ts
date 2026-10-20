import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson, clientContext, contextBlock } from "@/lib/ai";
import { LIVE } from "@/lib/live";

// Handing an account to a new media buyer. Whoever changes the buyer (on the client page, from the Account Overview
// sheet, from the team form), the account's work follows: the KPI, open tickets and the optimization sprint become
// the new buyer's. Then the strategist writes them a handoff: everything about the client up to now (dos and don'ts,
// what's in motion, what the client has said in the last 45 days, the Brand Bible and go-to-market, what to keep in
// mind, and similar accounts already on their list), which they read in the app or save as a PDF, and can ask
// questions about.

export type HandoffDoc = {
  headline: string;
  summary: string;
  dos: string[];
  donts: string[];
  learnings: string[];
  inMotion: { what: string; status: string }[];
  clientSaid: { what: string; when: string; where: string }[];
  brand: { voice: string; audience: string; rules: string[] };
  gtm: { stage: string; strategy: string; changed: string };
  keepInMind: string[];
  similar: { client: string; why: string; borrow: string }[];
  firstWeek: string[];
};

export type ChatTurn = { role: "user" | "assistant"; text: string; at: string; by?: string };

const S = { type: "string" };
const LIST = { type: "array", items: S };
const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const SCHEMA = obj({
  headline: S,
  summary: S,
  dos: LIST,
  donts: LIST,
  learnings: LIST,
  inMotion: { type: "array", items: obj({ what: S, status: S }) },
  clientSaid: { type: "array", items: obj({ what: S, when: S, where: S }) },
  brand: obj({ voice: S, audience: S, rules: LIST }),
  gtm: obj({ stage: S, strategy: S, changed: S }),
  keepInMind: LIST,
  similar: { type: "array", items: obj({ client: S, why: S, borrow: S }) },
  firstWeek: LIST,
});

const SYSTEM = `You write the handoff for a media buyer at Kaizen Marketing who is taking over a client's paid ads account. They have never worked on it. Give them everything they need to run it well from day one, from what you're given only; never invent. Plain, direct, specific: names of offers, products, audiences, numbers, dates. Refer to people by role ("the previous buyer", "the copywriter", "the client"), not by name, except the client's own contacts.
headline: where the account stands, in at most 14 words (no numbers beyond the one that matters most). summary: 3 to 5 sentences: who the client is, what they sell and to whom, how the account is doing against its KPI, and the single most important thing to know.
dos and donts: rules for this client's ads, creative and copy, from the client memory, Brand Bible and what the client has said (up to 8 each).
learnings: what has worked and what hasn't on this account, with evidence (up to 8).
inMotion: open tickets, the optimization sprint's open moves, promises from calls and anything else under way, each with its status and what the new buyer needs to do about it.
clientSaid: what the client asked for, liked, disliked, expected or complained about in the last 45 days, across every team (ads, email, organic, calls, Slack, email), newest first. when: the date. where: the channel ("call with the email team", "Slack").
brand: voice, audience, and the hard rules from the Brand Bible (banned claims, must-haves). Empty strings and no rules when there's no Brand Bible.
gtm: stage (where the go-to-market strategy is: draft, reviewed, in place, missing), strategy (its core in 2 or 3 sentences) and changed (what has changed or been decided recently). Say plainly when there's none.
keepInMind: the major things that could go wrong or that the client is sensitive about (up to 6).
similar: accounts already on the new buyer's list that are similar (same market or sub-vertical), with why they're alike and what to borrow from how that account is run. Only from the list you're given; empty if none is truly similar.
firstWeek: 3 to 6 concrete first moves for the new buyer, in order.`;

/** The account's work moves to the new buyer: its Meta KPI, open tickets they'd hold, and its optimization sprints. */
async function moveWork(admin: SupabaseClient, clientId: string, fromId: string | null, toId: string) {
  const moved = { kpis: 0, tickets: 0, held: 0, sprints: 0 };
  const { data: kpis } = await admin.from("kpi_targets").update({ owner_id: toId }).eq("client_id", clientId).eq("platform", "meta").eq("active", true).select("id");
  moved.kpis = kpis?.length ?? 0;
  const { data: tickets } = await admin.from("requests").update({ buyer_id: toId }).eq("client_id", clientId).neq("stage", "launched").is("deleted_at", null).select("id");
  moved.tickets = tickets?.length ?? 0;
  // A ticket the old buyer was holding (copy, launch) is now the new buyer's to hold
  if (fromId) {
    const { data: held } = await admin.from("requests").update({ assignee_id: toId }).eq("client_id", clientId).eq("assignee_id", fromId).neq("stage", "launched").is("deleted_at", null).select("id");
    moved.held = held?.length ?? 0;
  }
  const { data: sprints } = await admin.from("optimization_sprints").update({ buyer_id: toId }).eq("client_id", clientId).eq("status", "active").select("id");
  moved.sprints = sprints?.length ?? 0;
  return moved;
}

/**
 * A client's Meta buyer changed: move the work and open a handoff for the new buyer (written in the background by
 * writeHandoff). Nothing happens when the buyer didn't actually change or the slot was cleared.
 */
export async function handOff(admin: SupabaseClient, clientId: string, fromId: string | null, toId: string | null, byId: string | null, via: "app" | "sheet" | "form") {
  if (!toId || toId === fromId) return null;
  const moved = await moveWork(admin, clientId, fromId, toId);
  // No handoff for someone who hasn't signed in to Kaizen Ads yet (the team is still being onboarded): the work
  // still moves to them, but there's nobody to read a doc
  const { data: buyer } = await admin.from("profiles").select("auth_user_id").eq("id", toId).maybeSingle();
  if (!buyer?.auth_user_id) return null;
  const { data } = await admin.from("account_handoffs").insert({ client_id: clientId, from_id: fromId, to_id: toId, by_id: byId, via, moved }).select("id").single();
  return (data?.id as string | undefined) ?? null;
}

/** Everything the handoff and the account chat read beyond the client context: the last 45 days, what's open, peers. */
async function gather(admin: SupabaseClient, clientId: string, buyerId: string | null) {
  const since = new Date(Date.now() - 45 * 86_400_000).toISOString();
  const [{ data: c }, { data: items }, { data: tickets }, { data: sprints }, { data: promises }, { data: gtm }, { data: mine }] = await Promise.all([
    admin.from("clients").select("name, vertical_id").eq("id", clientId).single(),
    admin.from("context_items").select("source, occurred_at, author, title, body").eq("client_id", clientId).gte("occurred_at", since).order("occurred_at", { ascending: false }).limit(80),
    admin.from("requests").select("number, title, stage, stage_due_at").eq("client_id", clientId).neq("stage", "launched").is("deleted_at", null).order("created_at").limit(30),
    admin.from("optimization_sprints").select("id, started_at, sprint_actions(title, status, when, why)").eq("client_id", clientId).eq("status", "active").limit(2),
    admin.from("call_commitments").select("what, kind, due_at, status").eq("client_id", clientId).in("status", ["open", "briefed"]).limit(15),
    admin.from("client_gtm_strategies").select("status, version, read_this_first, open_items, generated_at, reviewed_at").eq("client_id", clientId).maybeSingle(),
    buyerId ? admin.from("client_assignments").select("client_id, clients(name, status, archived_at, vertical_id)").eq("profile_id", buyerId).eq("role", "meta_buyer") : Promise.resolve({ data: [] as { client_id: string; clients: unknown }[] }),
  ]);
  // The new buyer's other live accounts, same sub-vertical first, with what we've learned on each
  const peers = (mine ?? [])
    .map((m) => ({ id: m.client_id as string, ...(m.clients as unknown as { name: string; status: string; archived_at: string | null; vertical_id: string | null }) }))
    .filter((p) => p.id !== clientId && !p.archived_at && (LIVE as readonly string[]).includes(p.status))
    .sort((a, b) => Number(b.vertical_id === c?.vertical_id) - Number(a.vertical_id === c?.vertical_id))
    .slice(0, 12);
  const { data: peerMemory } = peers.length ? await admin.from("client_memory").select("client_id, kind, body").in("client_id", peers.map((p) => p.id)).eq("status", "active").limit(120) : { data: [] };
  const verticalIds = [...new Set([c?.vertical_id, ...peers.map((p) => p.vertical_id)].filter(Boolean))] as string[];
  const { data: verticals } = verticalIds.length ? await admin.from("verticals").select("id, name").in("id", verticalIds) : { data: [] };
  const vName = (id: string | null) => (verticals ?? []).find((v) => v.id === id)?.name ?? "not placed";

  const lines = [
    `<last_45_days>`,
    ...(items ?? []).map((i) => `- ${String(i.occurred_at).slice(0, 10)} [${i.source}${i.author ? `, ${i.author}` : ""}] ${i.title ?? ""}: ${(i.body ?? "").replace(/\s+/g, " ").slice(0, 600)}`),
    `</last_45_days>`,
    `<open_tickets>`,
    ...(tickets ?? []).map((t) => `- #${t.number} ${t.title}: ${t.stage}${t.stage_due_at ? `, due ${String(t.stage_due_at).slice(0, 10)}` : ""}`),
    `</open_tickets>`,
    `<optimization_sprint>`,
    ...(sprints ?? []).flatMap((s) => (s.sprint_actions as unknown as { title: string; status: string; when: string; why: string }[]).map((a) => `- [${a.status}] ${a.title} (${a.when}): ${a.why}`)),
    `</optimization_sprint>`,
    `<call_promises_open>`,
    ...(promises ?? []).map((p) => `- ${p.what} (${p.kind}, due ${String(p.due_at).slice(0, 10)}, ${p.status})`),
    `</call_promises_open>`,
    `<gtm_status>${gtm ? `${gtm.status}, version ${gtm.version}, written ${String(gtm.generated_at ?? "").slice(0, 10)}${gtm.reviewed_at ? `, reviewed ${String(gtm.reviewed_at).slice(0, 10)}` : ", not reviewed"}${gtm.open_items ? `\nOpen items: ${JSON.stringify(gtm.open_items).slice(0, 1500)}` : ""}` : "No go-to-market strategy yet"}</gtm_status>`,
    `<this_client_sub_vertical>${vName(c?.vertical_id ?? null)}</this_client_sub_vertical>`,
    ...(buyerId ? [`<new_buyers_other_accounts>`] : []),
    ...peers.map(
      (p) =>
        `- ${p.name} (sub-vertical: ${vName(p.vertical_id)})${(peerMemory ?? [])
          .filter((m) => m.client_id === p.id)
          .slice(0, 8)
          .map((m) => `\n    [${m.kind}] ${m.body}`)
          .join("")}`,
    ),
    ...(buyerId ? [`</new_buyers_other_accounts>`] : []),
  ];
  return { name: c?.name ?? "the client", extra: lines.join("\n") };
}

/** The client context plus the last 45 days and what's open; with a buyer, also their other accounts (for a handoff). */
export async function accountBrief(admin: SupabaseClient, clientId: string, buyerId: string | null) {
  const ctx = await clientContext(admin, clientId);
  if (!ctx) throw new Error("Client not found");
  const g = await gather(admin, clientId, buyerId);
  return { name: g.name, text: `${contextBlock(ctx)}\n\n${g.extra}` };
}

/** Writes the handoff doc. Safe to run again (a retry, or "Write it again"). */
export async function writeHandoff(admin: SupabaseClient, id: string) {
  const { data: h } = await admin.from("account_handoffs").select("client_id, to_id, from_id, moved").eq("id", id).single();
  if (!h) return;
  await admin.from("account_handoffs").update({ status: "writing", error: null }).eq("id", id);
  try {
    const b = await accountBrief(admin, h.client_id, h.to_id);
    const doc = await askJson<HandoffDoc>({
      agent: "strategist",
      label: "account handoff",
      system: SYSTEM,
      schema: SCHEMA,
      maxTokens: 24000,
      onText: () => {},
      prompt: `${b.text}\n\nWrite the handoff for the media buyer taking over ${b.name}${h.from_id ? " from the previous buyer" : ""}.`,
    });
    await admin.from("account_handoffs").update({ status: "ready", doc, ready_at: new Date().toISOString() }).eq("id", id);
  } catch (e) {
    await admin.from("account_handoffs").update({ status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 300) }).eq("id", id);
  }
}

const CHAT_SYSTEM = `You answer a Kaizen media buyer's questions about one client account they're running. Use only what you're given (the client context, the last 45 days, what's open, the handoff); when it isn't there, say so plainly and say who or where to ask (the client page, the previous buyer's notes, the client). Be brief and specific, like a colleague who knows the account: 1 to 6 sentences or a short list. Say where a fact comes from when it matters ("the client said on the Oct 9 call"). Plain text, no markdown (no asterisks or headings); start list lines with "- ". No emojis.`;

/** One question about the account, answered from everything the system knows; the thread is kept on the handoff. */
export async function askAboutAccount(admin: SupabaseClient, handoffId: string, question: string, by: string) {
  const { data: h } = await admin.from("account_handoffs").select("client_id, to_id, doc, chat").eq("id", handoffId).single();
  if (!h) throw new Error("Handoff not found");
  const b = await accountBrief(admin, h.client_id, h.to_id);
  const chat = (h.chat ?? []) as ChatTurn[];
  const out = await askJson<{ answer: string }>({
    agent: "strategist",
    label: "account question",
    system: CHAT_SYSTEM,
    schema: obj({ answer: S }),
    maxTokens: 6000,
    prompt: `${b.text}\n\n<handoff>\n${JSON.stringify(h.doc ?? {}).slice(0, 12000)}\n</handoff>\n\n<conversation>\n${chat
      .slice(-12)
      .map((t) => `${t.role === "user" ? "Buyer" : "You"}: ${t.text}`)
      .join("\n")}\n</conversation>\n\nThe buyer asks: ${question.trim().slice(0, 2000)}`,
  });
  const now = new Date().toISOString();
  const next: ChatTurn[] = [...chat, { role: "user", text: question.trim().slice(0, 2000), at: now, by }, { role: "assistant", text: out.answer, at: now }];
  await admin.from("account_handoffs").update({ chat: next.slice(-60) }).eq("id", handoffId);
  return next;
}
