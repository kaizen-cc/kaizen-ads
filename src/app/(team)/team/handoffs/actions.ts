"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireStaff, type Staff } from "@/lib/auth";
import { mayTransferAny } from "@/lib/seat-transfer-core";
import { createAdminClient } from "@/lib/supabase/admin";

// The Handoffs page's buttons: approve, change who takes it, or drop each move, and approve a whole plan at once.
// Every one checks on the server who may move the seat (executives any seat, a head their own line's).

type Result = { ok: true } | { ok: false; error: string };

const asker = (me: Staff) => ({ id: me.id, fullName: me.fullName, role: me.role, isExec: me.isExec });

async function gate(): Promise<{ me: Staff } | { error: string }> {
  const me = await requireStaff();
  if (!mayTransferAny(me)) return { error: "Moving accounts is for the executives and the line heads." };
  return { me };
}

function refresh() {
  revalidatePath("/team/handoffs");
  revalidatePath("/clients", "layout");
  revalidatePath("/team");
  revalidatePath("/kpis");
}

export async function approveMove(id: string): Promise<Result> {
  const g = await gate();
  if ("error" in g) return { ok: false, error: g.error };
  const admin = createAdminClient();
  const { applyMove } = await import("@/lib/seat-transfer");
  const r = await applyMove(admin, asker(g.me), id);
  if (!r.ok) return r;
  if (r.writeHandoff && r.handoffId) {
    const hid = r.handoffId;
    after(async () => (await import("@/lib/handoff")).writeHandoff(admin, hid));
  }
  refresh();
  return { ok: true };
}

/** Approves every waiting move in a plan that has someone to take it, one after another; says which didn't go */
export async function approveAll(transferId: string): Promise<{ ok: true; done: number; failed: { id: string; error: string }[] } | { ok: false; error: string }> {
  const g = await gate();
  if ("error" in g) return { ok: false, error: g.error };
  const admin = createAdminClient();
  const { applyMove } = await import("@/lib/seat-transfer");
  const { mayTransferSeat } = await import("@/lib/seat-transfer-core");
  const { data } = await admin.from("seat_transfer_moves").select("id, role, to_id").eq("transfer_id", transferId).in("status", ["planned", "failed"]).not("to_id", "is", null);
  const failed: { id: string; error: string }[] = [];
  const handoffs: string[] = [];
  let done = 0;
  for (const m of (data ?? []).filter((x) => mayTransferSeat(g.me, x.role as string))) {
    const r = await applyMove(admin, asker(g.me), m.id as string);
    if (r.ok) {
      done++;
      if (r.writeHandoff && r.handoffId) handoffs.push(r.handoffId);
    } else failed.push({ id: m.id as string, error: r.error });
  }
  if (handoffs.length) after(async () => {
    const { writeHandoff } = await import("@/lib/handoff");
    for (const h of handoffs) await writeHandoff(admin, h).catch(() => undefined);
  });
  refresh();
  return { ok: true, done, failed };
}

export async function changeMovePerson(id: string, toId: string): Promise<Result> {
  const g = await gate();
  if ("error" in g) return { ok: false, error: g.error };
  const admin = createAdminClient();
  const { setMovePerson, writeMoveDocs } = await import("@/lib/seat-transfer");
  try {
    const r = await setMovePerson(admin, asker(g.me), id, toId);
    if (r.writeDoc) after(() => writeMoveDocs(admin, r.transferId));
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  refresh();
  return { ok: true };
}

export async function dropPlannedMove(id: string): Promise<Result> {
  const g = await gate();
  if ("error" in g) return { ok: false, error: g.error };
  const { dropMove } = await import("@/lib/seat-transfer");
  try {
    await dropMove(createAdminClient(), asker(g.me), id);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  refresh();
  return { ok: true };
}

/** A handoff that didn't get written: write it again */
export async function rewriteMoveDoc(id: string): Promise<Result> {
  const g = await gate();
  if ("error" in g) return { ok: false, error: g.error };
  const admin = createAdminClient();
  const { data } = await admin.from("seat_transfer_moves").select("transfer_id, role, to_id, status").eq("id", id).maybeSingle();
  const { mayTransferSeat } = await import("@/lib/seat-transfer-core");
  if (!data || !mayTransferSeat(g.me, data.role as string)) return { ok: false, error: "That move isn't one you can change." };
  if (!data.to_id) return { ok: false, error: "Pick who takes it first." };
  await admin.from("seat_transfer_moves").update({ doc_status: "writing", doc: null }).eq("id", id);
  const { writeMoveDocs } = await import("@/lib/seat-transfer");
  after(() => writeMoveDocs(admin, data.transfer_id as string));
  refresh();
  return { ok: true };
}
