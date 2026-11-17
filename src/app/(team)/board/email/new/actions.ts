"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { seesEmailBoard } from "@/lib/roles";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { MAX_MESSAGES, ownerFor, sizeProblem, type EmailKind, type EmailPriority, type MessageChannel } from "@/lib/email-board-core";

// The email request form: what to suggest for a client (their own campaign ideas, what worked for other clients, the
// flows every store should have), the AI writing the brief for a flow or a batch within the limits, and making the
// ticket. AI-written briefs go straight to the board (no second review), and nothing about the client's sign-off or
// assets ever holds a ticket back.

export type Idea = { id: string | null; source: "client" | "elsewhere" | "starter"; title: string; idea: string; why: string | null; sendOn: string | null; kind: EmailKind; subjects: string[] };

const STARTERS: Omit<Idea, "id" | "source" | "sendOn" | "subjects">[] = [
  { kind: "flow", title: "Welcome series", idea: "New subscribers get the brand story, the best sellers and a first-order reason to buy, over three to four emails.", why: "Usually the best earning flow per recipient" },
  { kind: "flow", title: "Abandoned checkout", idea: "People who started checkout and didn't finish get a reminder, then proof, then a nudge.", why: "Recovers revenue already in the cart" },
  { kind: "flow", title: "Browse abandonment", idea: "People who looked at a product and left see it again with reasons to buy.", why: "Catches intent before it fades" },
  { kind: "flow", title: "Post-purchase", idea: "Thanks, how to get the most from the product, a review ask, then the next thing to buy.", why: "Builds the second order" },
  { kind: "flow", title: "Winback", idea: "Customers who haven't bought in a while get a reason to come back, with a stronger offer at the end.", why: "Wakes up lapsed buyers" },
  { kind: "batch", title: "Text message flash sale", idea: "A short sale announced by text, with a reminder before it ends.", why: "Texts for a quick, urgent push" },
];

/** What to suggest for a client: their own ideas first, then what worked for other clients, then the standard flows */
export async function suggestionsFor(clientId: string): Promise<Idea[]> {
  const me = await requireStaff();
  if (!seesEmailBoard(me)) return [];
  const db = await createClient();
  const { data: own } = await db.from("email_suggestions").select("id, title, idea, why, send_on, subjects").eq("client_id", clientId).eq("status", "new").order("send_on", { ascending: true, nullsFirst: false }).limit(8);
  // What worked for other clients (no names: a pattern to borrow, not their campaign)
  const { data: worked } = adminConfigured() ? await createAdminClient().from("email_suggestions").select("id, title, idea, why, outcome_note").neq("client_id", clientId).eq("outcome", "worked").order("outcome_at", { ascending: false }).limit(6) : { data: [] };
  const { data: existing } = await db.from("email_tickets").select("title").eq("client_id", clientId).is("deleted_at", null).limit(200);
  const have = new Set((existing ?? []).map((t) => String(t.title).toLowerCase()));
  return [
    ...(own ?? []).map((s): Idea => ({ id: s.id as string, source: "client", title: s.title as string, idea: s.idea as string, why: (s.why as string | null) ?? null, sendOn: (s.send_on as string | null) ?? null, kind: "batch", subjects: ((s.subjects ?? []) as string[]).slice(0, 3) })),
    ...(worked ?? []).map((s): Idea => ({ id: null, source: "elsewhere", title: s.title as string, idea: s.idea as string, why: (s.outcome_note as string | null) ?? (s.why as string | null) ?? null, sendOn: null, kind: "batch", subjects: [] })),
    ...STARTERS.filter((s) => !have.has(s.title.toLowerCase())).map((s): Idea => ({ ...s, id: null, source: "starter", sendOn: null, subjects: [] })),
  ];
}

export type BriefDraft = {
  title: string;
  kind: EmailKind;
  goal: string;
  trigger: string;
  brief: string;
  messages: { channel: MessageChannel; name: string; sendOn: string | null; delayHours: number | null }[];
};

const BRIEF_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    goal: { type: "string" },
    trigger: { type: "string" },
    brief: { type: "string" },
    messages: {
      type: "array",
      items: {
        type: "object",
        properties: { channel: { type: "string", enum: ["email", "sms"] }, name: { type: "string" }, send_on: { type: "string" }, delay_hours: { type: "integer" } },
        required: ["channel", "name", "send_on", "delay_hours"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "goal", "trigger", "brief", "messages"],
  additionalProperties: false,
};

/** The AI strategist writes the brief for a flow or a batch, inside the limits, from the client's own email results */
export async function writeEmailBrief(input: { clientId: string; kind: EmailKind; idea: string; count: number | null; dueOn: string | null; texts: boolean }): Promise<{ ok: true; draft: BriefDraft } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!seesEmailBoard(me) || !adminConfigured()) return { ok: false, error: "The email request form is for the email team and the executives." };
  const db = await createClient();
  const { data: c } = await db.from("clients").select("id, name").eq("id", input.clientId).maybeSingle();
  if (!c) return { ok: false, error: "Pick a client you work on." };
  if (!input.idea.trim()) return { ok: false, error: "Say what it's for, or pick a suggestion." };
  const admin = createAdminClient();
  const max = MAX_MESSAGES[input.kind];
  const count = input.count ? Math.max(1, Math.min(max, input.count)) : null;
  try {
    const { askJson } = await import("@/lib/ai");
    const { emailBrief, emailDeskBlock } = await import("@/lib/email-ops/chat");
    const [ctx, account] = await Promise.all([emailBrief(admin, c.id as string), emailDeskBlock(admin, c.id as string).catch(() => "")]);
    const today = new Date().toISOString().slice(0, 10);
    const out = await askJson<{ title: string; goal: string; trigger: string; brief: string; messages: { channel: MessageChannel; name: string; send_on: string; delay_hours: number }[] }>({
      agent: "email_calendar",
      label: "email board brief",
      clientId: c.id as string,
      system: `You are Kaizen Marketing's email strategist writing the brief for one email request: a campaign batch (separate sends, up to ${MAX_MESSAGES.batch}) or a flow (a sequence on a trigger, up to ${MAX_MESSAGES.flow} messages, texts allowed). Build it on what has worked for this client (subject styles, send days, offers) and on the client's calendar and what they said lately. The brief says the goal, who it's for, the offer and the angle, the proof to use, and what each message does, in short plain paragraphs the copywriter and designer work from. Name each message plainly. For a batch give each a send day (YYYY-MM-DD, on or after today and before the due date when there is one) and delay_hours 0; for a flow give the trigger, send_on "" and each message's wait in hours after the one before (the first usually 0). Only use text messages (sms) when asked or when the idea is a text. Refer to people by role, never by name. No em dashes.`,
      schema: BRIEF_SCHEMA,
      maxTokens: 6000,
      prompt: `Client: ${ctx.name}. Today: ${today}.${input.dueOn ? ` Due: ${input.dueOn}.` : ""}\n\n${ctx.text.slice(0, 20000)}\n\n${account.slice(0, 12000)}\n\n<request kind="${input.kind}"${count ? ` messages="${count}"` : ""} texts="${input.texts ? "yes" : "no"}">\n${input.idea.trim().slice(0, 3000)}\n</request>\n\nWrite the brief${count ? ` with exactly ${count} messages` : ` with the number of messages it needs (at most ${max})`}.`,
    });
    const messages = out.messages.slice(0, max).map((m, i) => ({
      channel: (m.channel === "sms" ? "sms" : "email") as MessageChannel,
      name: m.name.trim().slice(0, 120) || `Message ${i + 1}`,
      sendOn: input.kind === "batch" && /^\d{4}-\d{2}-\d{2}$/.test(m.send_on) ? m.send_on : null,
      delayHours: input.kind === "flow" ? Math.max(0, Math.min(24 * 90, Math.round(m.delay_hours || 0))) : null,
    }));
    return { ok: true, draft: { title: out.title.slice(0, 200), kind: input.kind, goal: out.goal.slice(0, 600), trigger: input.kind === "flow" ? out.trigger.slice(0, 300) : "", brief: out.brief.slice(0, 12000), messages: messages.length ? messages : [{ channel: "email", name: "Email 1", sendOn: null, delayHours: input.kind === "flow" ? 0 : null }] } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "The AI couldn't write the brief." };
  }
}

/** Make the ticket: it lands in Copy for review with the strategist, and the AI starts writing the copy at once */
export async function createEmailTicket(input: { clientId: string; draft: BriefDraft; priority: EmailPriority; dueOn: string | null; suggestionId: string | null }): Promise<{ ok: true; number: number } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!seesEmailBoard(me) || !adminConfigured()) return { ok: false, error: "The email request form is for the email team and the executives." };
  const db = await createClient();
  const { data: c } = await db.from("clients").select("id").eq("id", input.clientId).maybeSingle();
  if (!c) return { ok: false, error: "Pick a client you work on." };
  const d = input.draft;
  const size = sizeProblem(d.kind, d.messages.length);
  if (size) return { ok: false, error: size };
  if (!d.title.trim()) return { ok: false, error: "Give it a title." };
  const admin = createAdminClient();
  const { seatsOf, dueFor, logEvent, writeEmailCopy } = await import("@/lib/email-board");
  const { data: prov } = await admin.from("brevo_connections").select("client_id").eq("client_id", input.clientId).maybeSingle().then((r) => r, () => ({ data: null }));
  const { data: cio } = prov ? { data: null } : await admin.from("customerio_connections").select("client_id").eq("client_id", input.clientId).maybeSingle().then((r) => r, () => ({ data: null }));
  const provider = prov ? "brevo" : cio ? "customerio" : "klaviyo";
  const seats = await seatsOf(admin, input.clientId);
  const { data: t, error } = await admin
    .from("email_tickets")
    .insert({
      client_id: input.clientId,
      kind: d.kind,
      title: d.title.trim().slice(0, 200),
      brief: d.brief.trim().slice(0, 12000) || null,
      goal: d.goal.trim().slice(0, 600) || null,
      trigger: d.kind === "flow" ? d.trigger.trim().slice(0, 300) || null : null,
      provider,
      stage: "copy_review",
      priority: input.priority,
      assignee_id: ownerFor("copy_review", seats),
      stage_due_at: await dueFor(admin, "copy_review"),
      due_on: input.dueOn && /^\d{4}-\d{2}-\d{2}$/.test(input.dueOn) ? input.dueOn : null,
      copy_status: "writing",
      suggestion_id: input.suggestionId,
      created_by: me.id,
    })
    .select("id, number")
    .single();
  if (error || !t) return { ok: false, error: error?.message ?? "Couldn't make the ticket." };
  await admin.from("email_messages").insert(d.messages.map((m, i) => ({ ticket_id: t.id, client_id: input.clientId, position: i, channel: m.channel, name: m.name.slice(0, 120), send_on: d.kind === "batch" ? m.sendOn : null, delay_hours: d.kind === "flow" ? (m.delayHours ?? 0) : null })));
  await logEvent(admin, { ticketId: t.id as string, clientId: input.clientId, kind: "created", actorId: me.id, body: `${d.kind === "flow" ? "Flow" : "Campaign batch"} of ${d.messages.length}.` });
  if (input.suggestionId) await admin.from("email_suggestions").update({ status: "in_motion", status_by: me.id, status_at: new Date().toISOString() }).eq("id", input.suggestionId).eq("client_id", input.clientId);
  after(() => writeEmailCopy(createAdminClient(), t.id as string));
  revalidatePath("/board/email");
  return { ok: true, number: t.number as number };
}
