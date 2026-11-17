"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireStaff, type Staff } from "@/lib/auth";
import { approvesEmailCopy, roleLabel, seesEmailBoard, type TeamRole } from "@/lib/roles";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { checkMove, EMAIL_STAGES, MAX_MESSAGES, nextStage, type EmailPriority, type EmailStage, type MessageChannel, type MoveCheck, type Route } from "@/lib/email-board-core";
import {
  advance,
  DESIGN_BUCKET,
  lite,
  logEvent,
  moveEmailTicket,
  reviewEmailDesign,
  routeClientComments,
  tellClientEmails,
  toComment,
  toMessage,
  toTicket,
  withDesignUrls,
  writeEmailCopy,
  type EmailComment,
  type EmailEvent,
  type EmailLink,
  type EmailTicket,
} from "@/lib/email-board";

export type Result = { ok: true } | { ok: false; error: string };

const done = (error?: string | null): Result => {
  revalidatePath("/board/email");
  return error ? { ok: false, error } : { ok: true };
};

/** Who's asking, that they work on the Email Board, and that they can see this ticket's client (their own rights) */
async function guard(ticketId: string) {
  const me = await requireStaff();
  if (!seesEmailBoard(me)) throw new Error("The Email Board is for the email team and the executives.");
  if (!adminConfigured()) throw new Error("Not set up here.");
  const db = await createClient();
  const { data: t } = await db.from("email_tickets").select("id, number, client_id, kind, stage, title, assignee_id").eq("id", ticketId).is("deleted_at", null).maybeSingle();
  if (!t) throw new Error("That ticket isn't on the board.");
  return { me, admin: createAdminClient(), t: t as { id: string; number: number; client_id: string; kind: "batch" | "flow"; stage: EmailStage; title: string; assignee_id: string | null } };
}

const actor = (me: Staff) => ({ id: me.id, name: me.fullName });
const fail = (e: unknown): Result => ({ ok: false, error: e instanceof Error ? e.message : "Something went wrong." });

async function guardMessage(messageId: string) {
  const me = await requireStaff();
  if (!adminConfigured()) throw new Error("Not set up here.");
  const db = await createClient();
  const { data: m } = await db.from("email_messages").select("id, ticket_id").eq("id", messageId).maybeSingle();
  if (!m) throw new Error("That message isn't on the board.");
  const g = await guard(m.ticket_id as string);
  return { ...g, me };
}

export type TicketDetail = { ticket: EmailTicket; comments: EmailComment[]; events: EmailEvent[]; canApprove: boolean };

/** One ticket, whole: its messages with their designs, the pinned comments and its history */
export async function loadEmailTicket(number: number): Promise<TicketDetail | null> {
  const me = await requireStaff();
  if (!seesEmailBoard(me)) return null;
  const db = await createClient();
  const { data: row } = await db.from("email_board").select("*").eq("number", number).maybeSingle();
  if (!row) return null;
  const [{ data: msgs }, { data: comments }, { data: events }] = await Promise.all([
    db.from("email_messages").select("*").eq("ticket_id", row.id).order("position"),
    db.from("email_comments").select("*").eq("ticket_id", row.id).order("created_at"),
    db.from("email_ticket_events").select("id, kind, from_stage, to_stage, actor_name, body, data, created_at, profiles:actor_id(full_name)").eq("ticket_id", row.id).order("created_at"),
  ]);
  const messages = adminConfigured() ? await withDesignUrls(createAdminClient(), (msgs ?? []).map(toMessage)) : (msgs ?? []).map(toMessage);
  return {
    ticket: toTicket(row, messages),
    comments: (comments ?? []).map(toComment),
    events: (events ?? []).map((e) => ({
      id: e.id as string,
      kind: e.kind as string,
      fromStage: (e.from_stage as string | null) ?? null,
      toStage: (e.to_stage as string | null) ?? null,
      actor: (e.profiles as unknown as { full_name: string } | null)?.full_name ?? (e.actor_name as string | null) ?? null,
      body: (e.body as string | null) ?? null,
      data: (e.data as Record<string, unknown>) ?? {},
      at: e.created_at as string,
    })),
    canApprove: approvesEmailCopy(me),
  };
}

/** Before a ticket moves by hand: what's missing, what to know, and what happens there */
export async function emailMoveCheck(ticketId: string, to: EmailStage): Promise<MoveCheck> {
  try {
    const { admin, t } = await guard(ticketId);
    const { data: m } = await admin.from("email_messages").select("*").eq("ticket_id", ticketId);
    return checkMove({ kind: t.kind, stage: t.stage }, (m ?? []).map(toMessage).map(lite), to);
  } catch (e) {
    return { backwards: false, blockers: [e instanceof Error ? e.message : "Couldn't check the move."], warnings: [], effects: [] };
  }
}

/** What landing on a stage sets off: the AI reviews any design not reviewed yet, the client hears */
function onArrive(ticketId: string, to: EmailStage) {
  after(async () => {
    const admin = createAdminClient();
    if (to === "for_review") {
      const { data } = await admin.from("email_messages").select("id").eq("ticket_id", ticketId).not("design_path", "is", null).in("ai_review_status", ["none", "failed"]);
      for (const m of data ?? []) await reviewEmailDesign(admin, m.id as string);
    }
    if (to === "with_client") await tellClientEmails(admin, ticketId).catch((e) => console.error("[email board] tell client", e));
  });
}

/** Move a ticket to any stage (dragged, or picked in the ticket); a move that needs a reason carries the note */
export async function moveEmail(ticketId: string, to: EmailStage, note?: string): Promise<Result> {
  try {
    if (!EMAIL_STAGES.includes(to)) return { ok: false, error: "That isn't a stage." };
    const { me, admin, t } = await guard(ticketId);
    const { data: m } = await admin.from("email_messages").select("*").eq("ticket_id", ticketId);
    const check = checkMove({ kind: t.kind, stage: t.stage }, (m ?? []).map(toMessage).map(lite), to);
    if (check.blockers.length) return { ok: false, error: check.blockers[0] };
    if ((check.warnings.length || check.backwards) && !note?.trim()) return { ok: false, error: "Say why it's moving anyway." };
    await moveEmailTicket(admin, ticketId, to, actor(me), note?.trim() || null);
    onArrive(ticketId, to);
    return done();
  } catch (e) {
    return fail(e);
  }
}

/** The forward button: the ticket's next stage on its own path */
export async function advanceEmail(ticketId: string): Promise<Result & { to?: EmailStage }> {
  try {
    const { me, admin, t } = await guard(ticketId);
    const { data: m } = await admin.from("email_messages").select("*").eq("ticket_id", ticketId);
    const msgs = (m ?? []).map(toMessage);
    const to = nextStage({ kind: t.kind, stage: t.stage }, msgs.map(lite));
    const check = checkMove({ kind: t.kind, stage: t.stage }, msgs.map(lite), to);
    if (check.blockers.length) return { ok: false, error: check.blockers[0] };
    if (t.stage === "copy_review" && msgs.some((x) => !x.copyApproved)) return { ok: false, error: "Approve every message's copy first." };
    if ((t.stage === "copy_review" || t.stage === "ready_to_send") && !approvesEmailCopy(me)) return { ok: false, error: "The strategist, the Head of Email or an exec moves it on from here." };
    await advance(admin, ticketId, actor(me));
    onArrive(ticketId, to);
    revalidatePath("/board/email");
    return { ok: true, to };
  } catch (e) {
    return fail(e);
  }
}

export async function assignEmail(ticketId: string, profileId: string | null): Promise<Result> {
  try {
    const { me, admin, t } = await guard(ticketId);
    await admin.from("email_tickets").update({ assignee_id: profileId, updated_at: new Date().toISOString() }).eq("id", ticketId);
    await logEvent(admin, { ticketId, clientId: t.client_id, kind: "assign", actorId: me.id, data: { from: t.assignee_id, to: profileId } });
    return done();
  } catch (e) {
    return fail(e);
  }
}

export async function setEmailPriority(ticketId: string, priority: EmailPriority): Promise<Result> {
  try {
    if (!["normal", "high", "urgent"].includes(priority)) return { ok: false, error: "Pick a priority." };
    const { me, admin, t } = await guard(ticketId);
    await admin.from("email_tickets").update({ priority }).eq("id", ticketId);
    await logEvent(admin, { ticketId, clientId: t.client_id, kind: "priority", actorId: me.id, body: priority });
    return done();
  } catch (e) {
    return fail(e);
  }
}

/** The day it should be sent or live (YYYY-MM-DD), or none */
export async function setEmailDue(ticketId: string, dueOn: string | null): Promise<Result> {
  try {
    if (dueOn && !/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) return { ok: false, error: "Pick a valid date." };
    const { me, admin, t } = await guard(ticketId);
    await admin.from("email_tickets").update({ due_on: dueOn }).eq("id", ticketId);
    await logEvent(admin, { ticketId, clientId: t.client_id, kind: "due", actorId: me.id, body: dueOn ?? "no date" });
    return done();
  } catch (e) {
    return fail(e);
  }
}

export type MessagePatch = { name?: string; subject?: string | null; preheader?: string | null; body?: string | null; sendOn?: string | null; delayHours?: number | null; links?: EmailLink[]; providerRef?: string | null };

/** Edit one message (its copy, send day or delay, links and button positions); edited copy needs approving again */
export async function saveMessage(messageId: string, patch: MessagePatch): Promise<Result> {
  try {
    const { admin } = await guardMessage(messageId);
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.name !== undefined) row.name = patch.name.trim().slice(0, 120) || "Untitled";
    if (patch.subject !== undefined) row.subject = patch.subject?.slice(0, 200) ?? null;
    if (patch.preheader !== undefined) row.preheader = patch.preheader?.slice(0, 250) ?? null;
    if (patch.body !== undefined) row.body = patch.body?.slice(0, 8000) ?? null;
    if (patch.sendOn !== undefined) row.send_on = patch.sendOn && /^\d{4}-\d{2}-\d{2}$/.test(patch.sendOn) ? patch.sendOn : null;
    if (patch.delayHours !== undefined) row.delay_hours = patch.delayHours == null ? null : Math.max(0, Math.min(24 * 90, Math.round(patch.delayHours)));
    if (patch.providerRef !== undefined) row.provider_ref = patch.providerRef?.slice(0, 200) || null;
    if (patch.links !== undefined) {
      for (const l of patch.links) if (l.url && !/^https?:\/\//i.test(l.url)) return { ok: false, error: `"${l.label}" needs a full link starting with https://` };
      row.links = patch.links.slice(0, 8).map((l) => ({ label: l.label.slice(0, 60), url: l.url.slice(0, 1000), box: l.box }));
    }
    // New words: the copy needs approving again
    if (patch.subject !== undefined || patch.preheader !== undefined || patch.body !== undefined) {
      row.copy_approved_at = null;
      row.copy_approved_by = null;
    }
    await admin.from("email_messages").update(row).eq("id", messageId);
    return done();
  } catch (e) {
    return fail(e);
  }
}

/** Add an email or a text to a ticket (within its limit) */
export async function addMessage(ticketId: string, channel: MessageChannel): Promise<Result> {
  try {
    const { admin, t } = await guard(ticketId);
    const { data: m } = await admin.from("email_messages").select("position, send_on").eq("ticket_id", ticketId).order("position");
    const n = (m ?? []).length;
    if (n >= MAX_MESSAGES[t.kind]) return { ok: false, error: t.kind === "flow" ? `A flow holds up to ${MAX_MESSAGES.flow} messages.` : `A campaign batch holds up to ${MAX_MESSAGES.batch} emails.` };
    await admin.from("email_messages").insert({ ticket_id: ticketId, client_id: t.client_id, position: n, channel, name: `${channel === "sms" ? "Text" : "Email"} ${n + 1}`, delay_hours: t.kind === "flow" ? (n ? 24 : 0) : null });
    return done();
  } catch (e) {
    return fail(e);
  }
}

export async function removeMessage(messageId: string): Promise<Result> {
  try {
    const { admin } = await guardMessage(messageId);
    const { data: m } = await admin.from("email_messages").select("ticket_id").eq("id", messageId).single();
    const { count } = await admin.from("email_messages").select("id", { count: "exact", head: true }).eq("ticket_id", m!.ticket_id);
    if ((count ?? 0) <= 1) return { ok: false, error: "A ticket keeps at least one message." };
    await admin.from("email_messages").delete().eq("id", messageId);
    return done();
  } catch (e) {
    return fail(e);
  }
}

/** Move a message up or down in a flow's sequence (or a batch's list) */
export async function moveMessage(messageId: string, dir: -1 | 1): Promise<Result> {
  try {
    const { admin } = await guardMessage(messageId);
    const { data: m } = await admin.from("email_messages").select("ticket_id").eq("id", messageId).single();
    const { data: all } = await admin.from("email_messages").select("id, position").eq("ticket_id", m!.ticket_id).order("position");
    const list = (all ?? []).map((x) => x.id as string);
    const i = list.indexOf(messageId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return { ok: true };
    [list[i], list[j]] = [list[j], list[i]];
    await Promise.all(list.map((id, k) => admin.from("email_messages").update({ position: k }).eq("id", id)));
    return done();
  } catch (e) {
    return fail(e);
  }
}

/**
 * The strategist approves a message's copy (or every message's at once). With every one approved, a ticket still in
 * Copy for review moves on by itself: to the designer, or straight to the client for texts.
 */
export async function approveCopy(ticketId: string, messageId: string | null): Promise<Result & { moved?: EmailStage }> {
  try {
    const { me, admin, t } = await guard(ticketId);
    if (!approvesEmailCopy(me)) return { ok: false, error: "The strategist, the Head of Email or an exec approves the copy." };
    const now = new Date().toISOString();
    let q = admin.from("email_messages").update({ copy_approved_at: now, copy_approved_by: me.id }).eq("ticket_id", ticketId).is("copy_approved_at", null);
    if (messageId) q = q.eq("id", messageId);
    await q;
    await logEvent(admin, { ticketId, clientId: t.client_id, kind: "copy", actorId: me.id, body: messageId ? "Approved a message's copy." : "Approved the copy." });
    if (t.stage === "copy_review") {
      const { data: m } = await admin.from("email_messages").select("*").eq("ticket_id", ticketId);
      const msgs = (m ?? []).map(toMessage);
      if (msgs.every((x) => x.copyApproved)) {
        const r = await advance(admin, ticketId, actor(me), "Copy approved");
        onArrive(ticketId, r.stage);
        revalidatePath("/board/email");
        return { ok: true, moved: r.stage };
      }
    }
    return done();
  } catch (e) {
    return fail(e);
  }
}

/** The AI rewrites the copy not approved yet, with the strategist's note */
export async function rewriteCopy(ticketId: string, note: string): Promise<Result> {
  try {
    const { admin } = await guard(ticketId);
    await admin.from("email_tickets").update({ copy_status: "writing" }).eq("id", ticketId);
    after(() => writeEmailCopy(createAdminClient(), ticketId, note.trim().slice(0, 1500) || null));
    return done();
  } catch (e) {
    return fail(e);
  }
}

const DESIGN_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"];

/** A signed upload for a message's design (the whole email as one image or a PDF), straight to storage */
export async function designUploadSlot(messageId: string, name: string, mime: string, bytes: number): Promise<{ ok: true; path: string; token: string } | { ok: false; error: string }> {
  try {
    const { admin } = await guardMessage(messageId);
    if (!DESIGN_TYPES.includes(mime)) return { ok: false, error: "Upload the design as a PNG, JPG, WebP, GIF or PDF." };
    if (bytes > 40_000_000) return { ok: false, error: "That file is over 40 MB." };
    const safe = name.replace(/[^\w.-]+/g, "-").slice(-80) || "design";
    const { data: m } = await admin.from("email_messages").select("ticket_id, design_version").eq("id", messageId).single();
    const path = `email/${m!.ticket_id}/${messageId}/v${((m!.design_version as number) ?? 0) + 1}-${Date.now()}-${safe}`;
    const { data, error } = await admin.storage.from(DESIGN_BUCKET).createSignedUploadUrl(path);
    if (error || !data) return { ok: false, error: "Couldn't get the upload ready. Try again." };
    return { ok: true, path: data.path, token: data.token };
  } catch (e) {
    return fail(e) as { ok: false; error: string };
  }
}

/** The design is up: a new version on the message, and the AI reviews it and pins its notes */
export async function designUploaded(messageId: string, path: string, mime: string): Promise<Result> {
  try {
    const { me, admin, t } = await guardMessage(messageId);
    if (!path.startsWith(`email/${t.id}/${messageId}/`)) return { ok: false, error: "That upload isn't for this email." };
    const { data: m } = await admin.from("email_messages").select("design_version, name").eq("id", messageId).single();
    const version = ((m!.design_version as number) ?? 0) + 1;
    await admin.from("email_messages").update({ design_path: path, design_mime: mime, design_version: version, design_at: new Date().toISOString(), ai_review_status: "running", ai_review: null }).eq("id", messageId);
    await logEvent(admin, { ticketId: t.id, clientId: t.client_id, kind: "design", actorId: me.id, body: `Uploaded the design for ${m!.name} (version ${version}).`, data: { messageId, version } });
    after(() => reviewEmailDesign(createAdminClient(), messageId));
    return done();
  } catch (e) {
    return fail(e);
  }
}

export async function rerunReview(messageId: string): Promise<Result> {
  try {
    const { admin } = await guardMessage(messageId);
    await admin.from("email_messages").update({ ai_review_status: "running" }).eq("id", messageId);
    after(() => reviewEmailDesign(createAdminClient(), messageId));
    return done();
  } catch (e) {
    return fail(e);
  }
}

/** A team comment, pinned on a design or on the ticket */
export async function commentEmail(ticketId: string, messageId: string | null, body: string, box: EmailComment["box"]): Promise<Result> {
  try {
    if (!body.trim()) return { ok: false, error: "Write the comment first." };
    const { me, admin, t } = await guard(ticketId);
    const { data: m } = messageId ? await admin.from("email_messages").select("design_version, ticket_id").eq("id", messageId).maybeSingle() : { data: null };
    if (messageId && m?.ticket_id !== ticketId) return { ok: false, error: "That message isn't on this ticket." };
    await admin.from("email_comments").insert({ ticket_id: ticketId, message_id: messageId, client_id: t.client_id, author_kind: "team", author_id: me.id, author_name: me.fullName, body: body.trim().slice(0, 4000), box, design_version: (m?.design_version as number | null) ?? null });
    await logEvent(admin, { ticketId, clientId: t.client_id, kind: "comment", actorId: me.id, body: body.trim().slice(0, 500) });
    return done();
  } catch (e) {
    return fail(e);
  }
}

/** The team overrides where a client comment went (copy to the strategist, design to the designer) */
export async function setRoute(commentId: string, route: Route): Promise<Result> {
  try {
    const me = await requireStaff();
    const db = await createClient();
    const { data: c } = await db.from("email_comments").select("ticket_id").eq("id", commentId).maybeSingle();
    if (!c) return { ok: false, error: "That comment isn't here." };
    const { admin, t } = await guard(c.ticket_id as string);
    const { ownerFor } = await import("@/lib/email-board-core");
    const { seatsOf } = await import("@/lib/email-board");
    const to = ownerFor("revisions", await seatsOf(admin, t.client_id), [route]);
    await admin.from("email_comments").update({ route, routed_by: "team", routed_to: to }).eq("id", commentId);
    await logEvent(admin, { ticketId: t.id, clientId: t.client_id, kind: "route", actorId: me.id, body: `Sent a client comment to ${route}.` });
    return done();
  } catch (e) {
    return fail(e);
  }
}

export async function resolveComment(commentId: string, resolved: boolean): Promise<Result> {
  try {
    const db = await createClient();
    const { data: c } = await db.from("email_comments").select("ticket_id").eq("id", commentId).maybeSingle();
    if (!c) return { ok: false, error: "That comment isn't here." };
    const { admin } = await guard(c.ticket_id as string);
    await admin.from("email_comments").update({ resolved_at: resolved ? new Date().toISOString() : null }).eq("id", commentId);
    return done();
  } catch (e) {
    return fail(e);
  }
}

/**
 * The builder marks a message built in the email platform (with its campaign or flow reference, when noted). With
 * every message built, a ticket in Ready for build moves on to the strategist's final check.
 */
export async function markBuilt(messageId: string, built: boolean, ref?: string | null): Promise<Result> {
  try {
    const { me, admin, t } = await guardMessage(messageId);
    await admin.from("email_messages").update({ built_at: built ? new Date().toISOString() : null, built_by: built ? me.id : null, ...(ref !== undefined ? { provider_ref: ref?.slice(0, 200) || null } : {}) }).eq("id", messageId);
    await logEvent(admin, { ticketId: t.id, clientId: t.client_id, kind: "built", actorId: me.id, body: built ? "Marked a message built." : "Marked a message not built." });
    if (built && t.stage === "ready_for_build") {
      const { data: m } = await admin.from("email_messages").select("built_at").eq("ticket_id", t.id);
      if ((m ?? []).every((x) => x.built_at)) await moveEmailTicket(admin, t.id, "ready_to_send", actor(me), "Every message built");
    }
    return done();
  } catch (e) {
    return fail(e);
  }
}

/** The strategist's final step: each message scheduled or set live; with all of them, the ticket leaves the board */
export async function markLive(messageId: string, live: boolean): Promise<Result> {
  try {
    const { me, admin, t } = await guardMessage(messageId);
    if (!approvesEmailCopy(me)) return { ok: false, error: "The strategist, the Head of Email or an exec does the final check." };
    await admin.from("email_messages").update({ live_at: live ? new Date().toISOString() : null, live_by: live ? me.id : null }).eq("id", messageId);
    await logEvent(admin, { ticketId: t.id, clientId: t.client_id, kind: "live", actorId: me.id, body: live ? "Scheduled or set a message live." : "Took a message back from live." });
    if (live && t.stage === "ready_to_send") {
      const { data: m } = await admin.from("email_messages").select("live_at").eq("ticket_id", t.id);
      if ((m ?? []).every((x) => x.live_at)) await moveEmailTicket(admin, t.id, "live", actor(me), "Every message scheduled or live");
    }
    return done();
  } catch (e) {
    return fail(e);
  }
}

/** Execs and the Head of Email: take a ticket off the board (kept, with its history) */
export async function deleteEmailTicket(ticketId: string, reason: string): Promise<Result> {
  try {
    const { me, admin, t } = await guard(ticketId);
    if (!me.isExec && me.role !== "head_of_email") return { ok: false, error: "Only an exec or the Head of Email can delete a ticket." };
    await admin.from("email_tickets").update({ deleted_at: new Date().toISOString() }).eq("id", ticketId);
    await logEvent(admin, { ticketId, clientId: t.client_id, kind: "stage", actorId: me.id, body: `Deleted: ${reason.trim() || "no reason given"}` });
    return done();
  } catch (e) {
    return fail(e);
  }
}

/** The people the board can assign to: the email team and the execs */
export async function emailPeople() {
  await requireStaff();
  const db = await createClient();
  const { data } = await db.from("profiles").select("id, full_name, role, is_exec").eq("is_active", true).order("full_name");
  return (data ?? []).filter((p) => p.is_exec || ["head_of_email", "email_strategist", "email_designer", "email_builder"].includes(p.role as string)).map((p) => ({ id: p.id as string, name: p.full_name as string, role: roleLabel(p.role as TeamRole) }));
}

/** Re-sort the client's open comments on a ticket (after the client answered, or on the team's ask) */
export async function rerouteComments(ticketId: string): Promise<Result> {
  try {
    await guard(ticketId);
    after(() => routeClientComments(createAdminClient(), ticketId));
    return done();
  } catch (e) {
    return fail(e);
  }
}

/**
 * An Asana email task dragged to another column: moved there in Asana itself (the board mirrors Asana, so a move made
 * only here would snap back on the next sync). The person it's assigned to, the Head of Email or an exec.
 */
export async function moveEmailAsana(gid: string, stage: EmailStage): Promise<Result> {
  try {
    const me = await requireStaff();
    if (!seesEmailBoard(me)) return { ok: false, error: "The Email Board is for the email team and the executives." };
    if (!/^\d{5,30}$/.test(gid) || !adminConfigured()) return { ok: false, error: "That task isn't on the board." };
    const admin = createAdminClient();
    const { data: task } = await admin.from("email_asana_tasks").select("profile_id, stage, open, ticket_id").eq("gid", gid).maybeSingle();
    if (!task || !task.open || task.ticket_id) return { ok: false, error: "That task isn't on the board any more." };
    if (!me.isExec && me.role !== "head_of_email" && task.profile_id !== me.id) return { ok: false, error: "Only the person it's assigned to, the Head of Email or an exec can move it." };
    if (task.stage === stage) return { ok: true };
    const { asanaConfigured } = await import("@/lib/asana");
    if (!asanaConfigured()) return { ok: false, error: "Asana isn't connected here." };
    const { moveEmailTaskInAsana } = await import("@/lib/asana-email");
    await moveEmailTaskInAsana(admin, gid, stage);
    return done();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.replace(/^Asana: /, "Asana said: ") : "Asana didn't take the move." };
  }
}

/** Move an Asana email task into Kaizen as a ticket, with its history and comments; returns the new ticket's number */
export async function migrateEmailAsana(gid: string): Promise<{ ok: true; number: number | null } | { ok: false; error: string }> {
  try {
    const me = await requireStaff();
    if (!seesEmailBoard(me) || !adminConfigured()) return { ok: false, error: "The Email Board is for the email team and the executives." };
    const admin = createAdminClient();
    const { data: task } = await admin.from("email_asana_tasks").select("profile_id").eq("gid", gid).maybeSingle();
    if (!task) return { ok: false, error: "That task isn't on the board." };
    if (!me.isExec && me.role !== "head_of_email" && task.profile_id !== me.id) return { ok: false, error: "Only the person it's assigned to, the Head of Email or an exec can move it over." };
    const { migrateEmailTask } = await import("@/lib/asana-email");
    const r = await migrateEmailTask(admin, gid, { id: me.id, name: me.fullName });
    revalidatePath("/board/email");
    return { ok: true, number: r.number };
  } catch (e) {
    return fail(e) as { ok: false; error: string };
  }
}
