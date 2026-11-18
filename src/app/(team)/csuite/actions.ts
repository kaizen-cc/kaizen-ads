"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { addTodo, endMeeting, markItem, mayRunReview, setStep, setTodoStatus, startMeeting } from "@/lib/csuite/server";
import type { ItemState } from "@/lib/csuite/core";

// The account review's buttons. Execs run it; the person a to-do is assigned to may close their own.

type Result = { ok: true } | { ok: false; error: string };
const fail = (e: unknown): { ok: false; error: string } => ({ ok: false, error: e instanceof Error ? e.message : "Something went wrong. Try again." });

async function exec() {
  const me = await requireStaff();
  if (!mayRunReview(me)) throw new Error("The account review is for executives.");
  return { me, db: await createClient() };
}

export async function startReview(): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    const { me, db } = await exec();
    const { loadReview } = await import("@/lib/csuite/load");
    const review = await loadReview(db, createAdminClient()).catch(() => null);
    const r = await startMeeting(db, me, review);
    revalidatePath("/kpis");
    return { ok: true, id: r.id };
  } catch (e) {
    return fail(e);
  }
}

export async function goToStep(meetingId: string, step: number): Promise<Result> {
  try {
    const { db } = await exec();
    await setStep(db, meetingId, step);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function markReviewItem(meetingId: string, key: string, state: ItemState | null, note?: string | null): Promise<Result> {
  try {
    const { db } = await exec();
    await markItem(db, meetingId, key, state, note);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function addReviewTodo(input: { meetingId: string | null; title: string; assigneeId: string; dueOn: string | null; clientId?: string | null; itemKey?: string | null; detail?: string | null }): Promise<Result> {
  try {
    const { me, db } = await exec();
    await addTodo(db, createAdminClient(), me, input);
    if (input.itemKey && input.meetingId) await markItem(db, input.meetingId, input.itemKey, "discuss", `Assigned: ${input.title}`);
    revalidatePath("/kpis");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function closeReviewTodo(id: string, status: "open" | "done" | "dismissed"): Promise<Result> {
  try {
    await requireStaff();
    await setTodoStatus(await createClient(), id, status);
    revalidatePath("/kpis");
    revalidatePath("/pipeline");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function finishReview(meetingId: string, notes: string | null): Promise<Result> {
  try {
    const { db } = await exec();
    await endMeeting(db, meetingId, notes);
    revalidatePath("/kpis");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Drafts the upsell email for one client (it lands in "Emails ready to send" on the person's Overview; never sent) */
export async function draftUpsellEmail(clientId: string, service: string): Promise<Result> {
  try {
    const { me, db } = await exec();
    const admin = createAdminClient();
    const [{ loadReview }, { draftBulk }] = await Promise.all([import("@/lib/csuite/load"), import("@/lib/email-drafts/server")]);
    const review = await loadReview(db, admin);
    const u = review.upsells.find((x) => x.clientId === clientId && x.service === service);
    if (!u) return { ok: false, error: "That upsell isn't on the list any more." };
    const r = await draftBulk(admin, me, { clients: [{ id: clientId, name: u.client, points: [u.offer, ...u.why.filter((w) => w.startsWith("They asked"))] }], kind: "upsell", purpose: "Offer the next service that fits, warmly and briefly, built on what's going well for them and anything they asked about. Suggest a short call. Never mention internal scores.", sourceKind: "upsell" });
    if (!r.drafted.length) return { ok: false, error: "The draft didn't come back. Try again." };
    revalidatePath("/pipeline");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
