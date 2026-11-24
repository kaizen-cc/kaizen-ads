import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { mark, STEPS, type ItemState, type Marks } from "./core";
import type { Review } from "./load";

// The account review's writes, shared by the page and the assistant (so "let's do the account review" on a call does
// exactly what the buttons do): start a meeting, move through the steps, mark an item discuss or done, capture a to-do
// for a person with a due date (it lands on their Overview and rings their bell), close the meeting. Execs only; the
// person's own session writes, so the database checks it too.

export const mayRunReview = (me: Pick<Staff, "isExec">) => Boolean(me.isExec);

/** The open meeting, or a new one with the scorecard as it stands now */
export async function startMeeting(db: SupabaseClient, me: Pick<Staff, "id" | "isExec">, review?: Pick<Review, "scorecard" | "critical"> | null): Promise<{ id: string; created: boolean }> {
  if (!mayRunReview(me)) throw new Error("The account review is for executives.");
  const { data: open } = await db.from("csuite_meetings").select("id").eq("status", "open").order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (open) return { id: open.id as string, created: false };
  const snapshot = review ? { lineRatio: review.scorecard.lineRatio, clientRatio: review.scorecard.clientRatio, inRed: review.scorecard.inRed, critical: review.critical, lines: review.scorecard.lines } : null;
  const title = `Account review, ${new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })}`;
  const { data, error } = await db.from("csuite_meetings").insert({ title, started_by: me.id, snapshot }).select("id").single();
  if (error || !data) throw new Error("The meeting couldn't start. Try again.");
  return { id: data.id as string, created: true };
}

export async function setStep(db: SupabaseClient, meetingId: string, step: number) {
  const s = Math.max(0, Math.min(STEPS.length - 1, Math.trunc(step)));
  await db.from("csuite_meetings").update({ step: s, updated_at: new Date().toISOString() }).eq("id", meetingId);
  return s;
}

/** Marks an agenda item discuss or done (or clears it), with an optional note; returns the meeting's marks */
export async function markItem(db: SupabaseClient, meetingId: string, key: string, state: ItemState | null, note?: string | null): Promise<Marks> {
  const { data } = await db.from("csuite_meetings").select("items").eq("id", meetingId).maybeSingle();
  if (!data) throw new Error("That meeting isn't there.");
  const items = mark((data.items ?? {}) as Marks, key.slice(0, 200), state, note ?? null);
  await db.from("csuite_meetings").update({ items, updated_at: new Date().toISOString() }).eq("id", meetingId);
  return items;
}

export async function endMeeting(db: SupabaseClient, meetingId: string, notes?: string | null) {
  await db.from("csuite_meetings").update({ status: "closed", ended_at: new Date().toISOString(), ...(notes != null ? { notes: notes.slice(0, 8000) } : {}), updated_at: new Date().toISOString() }).eq("id", meetingId);
}

export type TodoInput = { meetingId?: string | null; title: string; detail?: string | null; assigneeId: string; dueOn?: string | null; clientId?: string | null; itemKey?: string | null };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A decision or to-do for a person: saved with the meeting, on their Overview, and in their bell */
export async function addTodo(db: SupabaseClient, admin: SupabaseClient, me: Pick<Staff, "id" | "fullName" | "isExec">, t: TodoInput): Promise<{ id: string }> {
  if (!mayRunReview(me)) throw new Error("To-dos from the account review are set by executives.");
  const title = t.title.replace(/\s+/g, " ").trim().slice(0, 240);
  if (!title) throw new Error("What's the to-do?");
  const due = t.dueOn && DAY.test(t.dueOn) ? t.dueOn : null;
  const { data, error } = await db
    .from("csuite_todos")
    .insert({ meeting_id: t.meetingId ?? null, title, detail: t.detail?.slice(0, 2000) ?? null, assignee_id: t.assigneeId, due_on: due, client_id: t.clientId ?? null, item_key: t.itemKey ?? null, created_by: me.id })
    .select("id")
    .single();
  if (error || !data) throw new Error("The to-do didn't save. Try again.");
  if (t.assigneeId !== me.id) {
    const when = due ? ` by ${new Date(`${due}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}` : "";
    await admin
      .from("notifications")
      .upsert({ profile_id: t.assigneeId, kind: "assistant", title: `From the account review: ${title}`, body: `${me.fullName.split(" ")[0]} assigned this to you${when}.`, href: `/pipeline?block=needs&item=todo%3A${data.id}`, client_id: t.clientId ?? null, key: `review-todo:${data.id}`, priority: "normal", actor_id: me.id }, { onConflict: "profile_id,key", ignoreDuplicates: true })
      .then(
        () => undefined,
        () => undefined,
      );
  }
  return { id: data.id as string };
}

/** Done, dismissed or open again: the person it's assigned to, or an exec */
export async function setTodoStatus(db: SupabaseClient, id: string, status: "open" | "done" | "dismissed") {
  const { error } = await db.from("csuite_todos").update({ status, done_at: status === "open" ? null : new Date().toISOString() }).eq("id", id);
  if (error) throw new Error("It didn't save.");
}

/** A teammate by name (active staff), for "assign it to the head of email" or a first name */
export async function personNamed(db: SupabaseClient, who: string): Promise<{ id: string; name: string } | { error: string }> {
  const q = who.replace(/[%_,()]/g, " ").trim();
  if (!q) return { error: "Who should own it?" };
  const { data } = await db.from("profiles").select("id, full_name, display_name, role").eq("is_active", true);
  const all = (data ?? []) as { id: string; full_name: string; display_name: string | null; role: string }[];
  const low = q.toLowerCase();
  const role = low.replace(/^the\s+/, "").replace(/\s+/g, "_");
  const hits = all.filter((p) => p.full_name.toLowerCase() === low || (p.display_name ?? "").toLowerCase() === low);
  const loose = hits.length ? hits : all.filter((p) => p.full_name.toLowerCase().includes(low) || (p.display_name ?? "").toLowerCase().includes(low) || p.role === role);
  if (!loose.length) return { error: `No teammate called ${q}.` };
  if (loose.length > 1) return { error: `More than one fits: ${loose.slice(0, 5).map((p) => p.full_name).join(", ")}. Which one?` };
  return { id: loose[0].id, name: loose[0].full_name };
}
