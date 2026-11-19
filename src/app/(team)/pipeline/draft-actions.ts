"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { aiEnabled } from "@/lib/ai";
import { requireStaff } from "@/lib/auth";
import { createAdminClient, adminConfigured } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { markItem, reviewsChanged } from "@/lib/item-state";

// The drafted briefs (src/lib/brief-drafting.ts): approve (lands in Asana), swap one in for a piece not made yet, see
// what it could replace, and ask the drafter to look at one client now. Rejecting is declineSuggestion (the reason
// feeds the strategist), editing is saveSuggestion (suggestion-actions.ts).

type Fail = { ok: false; error: string };

/** Approve a drafted brief: the ticket and its Asana task are made */
export async function approveDraftedBrief(id: string) {
  const me = await requireStaff();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, error: "That brief isn't there." } as Fail;
  if (!adminConfigured()) return { ok: false, error: "Not connected here." } as Fail;
  const db = await createClient();
  const { approveDrafted } = await import("@/lib/brief-drafting");
  const r = await approveDrafted(db, createAdminClient(), me, id);
  if (!r.ok) return r;
  const { data: s } = await db.from("creative_suggestions").select("client_id").eq("id", id).maybeSingle();
  await markItem(db, me.id, `brief:${id}`, "done", { topic: "briefs", clientId: (s?.client_id as string | undefined) ?? undefined });
  await reviewsChanged();
  revalidatePath("/pipeline");
  revalidatePath("/requests/new");
  revalidatePath("/board");
  return r;
}

/** What a drafted brief could take the slot of, for the swap panel */
export async function draftSwapOptions(id: string) {
  await requireStaff();
  const db = await createClient();
  const { data: s } = await db.from("creative_suggestions").select("client_id").eq("id", id).maybeSingle();
  if (!s) return { ok: false, error: "That brief isn't one you can see." } as Fail;
  const { swapOptions } = await import("@/lib/brief-drafting");
  return { ok: true as const, ...(await swapOptions(db, s.client_id as string, id)) };
}

/** Swap a drafted brief in for a piece not made yet (or, forced by a lead, adapt one in production) */
export async function swapDraftedBrief(id: string, target: { kind: "draft" | "request" | "asana"; ref: string }, forced: boolean, reason: string | null) {
  const me = await requireStaff();
  if (!adminConfigured()) return { ok: false, error: "Not connected here." } as Fail;
  const { swapIn } = await import("@/lib/brief-drafting");
  const r = await swapIn(await createClient(), createAdminClient(), me, id, target, forced, reason?.trim() || null);
  if (r.ok) {
    revalidatePath("/pipeline");
    revalidatePath("/requests/new");
    revalidatePath("/board");
  }
  return r;
}

/** Look at one client now (the leads, the executives): drafts a brief if there's a reason, in the background */
export async function draftForClientNow(clientId: string) {
  const me = await requireStaff();
  const { canForceSwap } = await import("@/lib/brief-drafting-core");
  if (!canForceSwap(me) && me.role !== "head_of_meta") return { ok: false, error: "The creative leads, the head of Meta and the executives can ask for a draft." } as Fail;
  if (!aiEnabled() || !adminConfigured()) return { ok: false, error: "The AI isn't connected here." } as Fail;
  const admin = createAdminClient();
  after(async () => {
    const { runDrafting } = await import("@/lib/brief-drafting");
    await runDrafting(admin, { clientId, max: 1 }).catch((e) => console.error("[drafting] one client", e instanceof Error ? e.message : e));
    revalidatePath("/requests/new");
  });
  return { ok: true as const };
}

/** Approve every drafted brief given (the Clients tab's "Approve all ready"): each to Asana, one after another */
export async function approveAllDraftedBriefs(ids: string[]) {
  const me = await requireStaff();
  if (!adminConfigured()) return { ok: false, error: "Not connected here." } as Fail;
  const db = await createClient();
  const admin = createAdminClient();
  const { approveDrafted } = await import("@/lib/brief-drafting");
  const done: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const id of ids.filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 40)) {
    const r = await approveDrafted(db, admin, me, id);
    if (r.ok) {
      done.push(id);
      await markItem(db, me.id, `brief:${id}`, "done", { topic: "briefs" });
    } else failed.push({ id, error: r.error });
  }
  if (done.length) {
    await reviewsChanged();
    revalidatePath("/pipeline");
    revalidatePath("/board");
  }
  return { ok: true as const, approved: done.length, failed };
}
