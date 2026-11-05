import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { clearNotices, closeMoving, recheckPromise } from "@/lib/message-promises";
import { closeAnswered } from "@/lib/owed-replies";
import type { NoticeKind } from "@/lib/notice-links";

// Closing a chase from the notice itself: "It's handled", "Add context" (what's missing: "onboarding started Nov 2,
// the client is Crust Pizza Gleannloch"), or a reply to the email. Context is kept on the item, the follow-through
// reads it at once, and if it shows it's handled it closes: notices off the bell, the lead and execs told.

type Admin = SupabaseClient;
type Row = Record<string, unknown>;
type Note = { at: string; by: string; text: string; client?: string | null; via?: string; ref?: string };

const OPEN = { said: ["open", "overdue", "escalated"], owed: ["watching", "nudged", "escalated"] } as const;
const table = (k: NoticeKind) => (k === "said" ? "message_promises" : "owed_replies");
const keysOf = (k: NoticeKind, id: string) => (k === "said" ? [`said:${id}`, `said2:${id}`, `said-lead:${id}`] : [`owed:${id}`, `owed2:${id}`, `owed-lead:${id}`]);
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" });

export type NoticeView = {
  kind: NoticeKind;
  id: string;
  open: boolean;
  /** "You said you'd …" / "No reply yet to …", for the person looking */
  title: string;
  detail: string;
  closedAs: string | null;
  person: string;
  clientId: string | null;
  client: string | null;
  notes: Note[];
};

/** The item as the page shows it, worded for the person looking. */
export async function loadNotice(admin: Admin, kind: NoticeKind, id: string, viewerId: string): Promise<NoticeView | null> {
  const { data: r } = await admin.from(table(kind)).select("*").eq("id", id).maybeSingle();
  if (!r) return null;
  const ownerId = String(kind === "said" ? r.owner_id : r.target_id);
  const [{ data: person }, { data: client }] = await Promise.all([
    admin.from("profiles").select("full_name").eq("id", ownerId).maybeSingle(),
    r.client_id ? admin.from("clients").select("name").eq("id", r.client_id).maybeSingle() : Promise.resolve({ data: null as { name: string } | null }),
  ]);
  const name = String(person?.full_name ?? "Someone");
  const mine = ownerId === viewerId;
  const where = r.source === "gmail" ? `by email${r.subject ? ` ("${String(r.subject).slice(0, 60)}")` : ""}` : `in #${r.channel_name ?? "Slack"}`;
  const open = (OPEN[kind] as readonly string[]).includes(String(r.status));
  return {
    kind,
    id,
    open,
    title: kind === "said" ? `${mine ? "You" : name} said ${mine ? "you'd" : "they'd"} ${r.what ?? "do something"}` : `${mine ? "You haven't" : `${name} hasn't`} replied to ${r.from_name ?? "someone"}`,
    detail:
      kind === "said"
        ? `${r.asked_by ?? "They"} asked ${where} on ${day(String(r.said_at))}${r.ask ? `: ${r.ask}` : ""}`
        : `${String(r.gist ?? r.body ?? "").replace(/\s+/g, " ").slice(0, 160)}, ${where}, since ${day(String(r.asked_at))}`,
    closedAs: open ? null : String(r.evidence ?? r.dismiss_reason ?? (r.status === "answered" ? "Answered" : "Closed")),
    person: name,
    clientId: (r.client_id as string | null) ?? null,
    client: client?.name ?? null,
    notes: ((r.team_context ?? []) as Note[]).filter((n) => n?.text),
  };
}

/** Whoever it's on, anyone it went to (their lead, the execs), and any exec. */
export async function mayAct(admin: Admin, kind: NoticeKind, id: string, profileId: string) {
  const [{ data: r }, { data: me }, { data: got }] = await Promise.all([
    admin.from(table(kind)).select("*").eq("id", id).maybeSingle(),
    admin.from("profiles").select("role, is_active").eq("id", profileId).maybeSingle(),
    admin.from("notifications").select("id").eq("profile_id", profileId).in("key", keysOf(kind, id)).limit(1),
  ]);
  if (!r || !me?.is_active) return false;
  return (kind === "said" ? r.owner_id : r.target_id) === profileId || me.role === "executive" || Boolean(got?.length);
}

export type Resolution = { closed: boolean; message: string };

/**
 * Handled, or context added (with the client, when they picked one). Handled closes it straight away; context is
 * saved and the item checked again now, closing only if that shows it's been taken care of.
 */
export async function resolveNotice(admin: Admin, a: { kind: NoticeKind; id: string; profileId: string; how: "done" | "context"; text?: string | null; clientId?: string | null; via?: "page" | "email" | "app" | "reply"; ref?: string }): Promise<Resolution> {
  const { data: r } = await admin.from(table(a.kind)).select("*").eq("id", a.id).maybeSingle();
  if (!r) return { closed: false, message: "It isn't there any more." };
  if (!(OPEN[a.kind] as readonly string[]).includes(String(r.status))) return { closed: true, message: "It was already closed." };
  const { data: me } = await admin.from("profiles").select("full_name").eq("id", a.profileId).maybeSingle();
  const by = String(me?.full_name ?? "Someone");
  const text = (a.text ?? "").trim().slice(0, 1500);
  const now = new Date().toISOString();

  let clientName: string | null = null;
  if (a.clientId) {
    const { data: c } = await admin.from("clients").select("id, name").eq("id", a.clientId).maybeSingle();
    clientName = c?.name ?? null;
  }
  const notes = [...((r.team_context ?? []) as Note[])];
  // The same email delivered twice (webhooks retry) is read once
  if (a.ref && notes.some((n) => n.ref === a.ref)) return { closed: false, message: "Already read." };
  if (text || clientName) notes.push({ at: now, by, text: text || `It's about ${clientName}`, client: clientName, via: a.via ?? "page", ...(a.ref ? { ref: a.ref } : {}) });
  await admin
    .from(table(a.kind))
    .update({ team_context: notes.slice(-20), ...(clientName ? (a.kind === "said" ? { client_id: a.clientId, client_match: "person", client_matched_at: now } : { client_id: a.clientId }) : {}) })
    .eq("id", a.id);

  if (a.kind === "said") {
    if (a.how === "done") {
      await closeMoving(admin, { ...r, client_id: clientName ? a.clientId : r.client_id }, { state: "done", evidence: `Marked handled by ${by}${text ? `: ${text}` : ""}` }, await ownerName(admin, String(r.owner_id)));
      return { closed: true, message: r.status === "escalated" ? "Closed. Their lead and the execs have been told it's handled." : "Closed." };
    }
    const check = await recheckPromise(admin, a.id);
    if (check.state === "done" || check.state === "moving" || check.state === "closed")
      return { closed: true, message: `Closed: ${check.evidence}.${r.status === "escalated" ? " Their lead and the execs have been told." : ""}` };
    return { closed: false, message: check.state === "unknown" ? "Saved. It couldn't be checked just now; the next pass reads your note." : `Saved, and it's still open: ${check.evidence}. Add more, or mark it handled.` };
  }

  // An owed reply
  if (a.how === "done") {
    await closeAnswered(admin, r as Row, now, "handled");
    await admin.from("owed_replies").update({ dismiss_reason: `Handled (${by})${text ? `: ${text}` : ""}`.slice(0, 300) }).eq("id", a.id);
    await clearNotices(admin, "owed", a.id, true);
    return { closed: true, message: r.status === "escalated" ? "Closed. Their lead and the execs have been told it's taken care of." : "Closed." };
  }
  if (!text) return { closed: false, message: "Saved." };
  const v = await owedContextCheck(r as Row, text);
  if (!v) return { closed: false, message: "Saved. It couldn't be checked just now: mark it handled if it is." };
  if (!v.handled) return { closed: false, message: `Saved, and it's still open: ${v.why}. Mark it handled if it is.` };
  await closeAnswered(admin, r as Row, now, "handled");
  await admin.from("owed_replies").update({ dismiss_reason: `Handled (${by}): ${v.why}`.slice(0, 300) }).eq("id", a.id);
  await clearNotices(admin, "owed", a.id, true);
  return { closed: true, message: `Closed: ${v.why}.${r.status === "escalated" ? " Their lead and the execs have been told." : ""}` };
}

async function ownerName(admin: Admin, id: string) {
  const { data } = await admin.from("profiles").select("full_name").eq("id", id).maybeSingle();
  return String(data?.full_name ?? "Someone");
}

/** Does what they told us mean the message is taken care of (answered elsewhere, on a call, nothing to answer)? */
async function owedContextCheck(o: Row, text: string): Promise<{ handled: boolean; why: string } | null> {
  try {
    return await askJson<{ handled: boolean; why: string }>({
      agent: "calls",
      label: "owed reply context",
      clientId: (o.client_id as string | null) ?? null,
      maxTokens: 800,
      system:
        "Someone at Kaizen was chased for a message nobody on the team had answered. They've told us what happened. handled: true when it says the message was answered or acted on another way (a call, in person, another thread, already done), or that it never needed a reply; false when it only explains a delay or says they'll do it later. why: one short line saying what took care of it, or what's still missing.",
      schema: { type: "object", properties: { handled: { type: "boolean" }, why: { type: "string" } }, required: ["handled", "why"], additionalProperties: false },
      prompt: `The message from ${o.from_name ?? "someone"} (${o.source === "gmail" ? "email" : "Slack"}): ${String(o.body ?? "").replace(/\s+/g, " ").slice(0, 1000)}\n\nWhat they told us: ${text}`,
    });
  } catch {
    return null;
  }
}
