"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { summarizeRevision, writeClientSummary } from "@/lib/client-revision";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import type { Priority, Stage } from "@/lib/stages";
import { createClient } from "@/lib/supabase/server";

export type ActionResult = { ok: true } | { ok: false; error: string };

const done = (error?: { message: string } | null): ActionResult => {
  revalidatePath("/board");
  revalidatePath("/pipeline");
  return error ? { ok: false, error: error.message } : { ok: true };
};

export async function moveTicket(id: string, stage: Stage, note?: string): Promise<ActionResult> {
  await requireStaff();
  const supabase = await createClient();
  const { error } = await supabase.rpc("move_request", { p_request: id, p_stage: stage, p_note: note ?? null });
  // A revised ad going back to the client: write what they asked and what changed, for the "revised" tag
  if (!error && stage === "client_review" && adminConfigured()) {
    after(async () => {
      const admin = createAdminClient();
      try {
        await writeClientSummary(admin, id);
      } catch (e) {
        console.error("[portal] client summary failed:", e instanceof Error ? e.message : e);
      }
      try {
        await summarizeRevision(admin, id);
      } catch (e) {
        console.error("[portal] revision summary failed:", e instanceof Error ? e.message : e);
      }
    });
  }
  return done(error);
}

export async function assignTicket(id: string, profileId: string | null): Promise<ActionResult> {
  await requireStaff();
  const supabase = await createClient();
  const { error } = await supabase.rpc("assign_request", { p_request: id, p_profile: profileId });
  return done(error);
}

export async function setTicketDue(id: string, dueIso: string): Promise<ActionResult> {
  await requireStaff();
  if (Number.isNaN(Date.parse(dueIso))) return { ok: false, error: "Pick a valid date and time." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_request_due", { p_request: id, p_due: dueIso });
  return done(error);
}

export async function setTicketPriority(id: string, priority: Priority): Promise<ActionResult> {
  await requireStaff();
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_request_priority", { p_request: id, p_priority: priority });
  return done(error);
}

export async function commentTicket(id: string, body: string): Promise<ActionResult> {
  await requireStaff();
  const supabase = await createClient();
  const { error } = await supabase.rpc("comment_request", { p_request: id, p_body: body });
  return done(error);
}

export type TicketEvent = {
  id: string;
  kind: "created" | "stage" | "assign" | "due" | "priority" | "comment" | "upload" | "review" | "copy";
  fromStage: Stage | null;
  toStage: Stage | null;
  actor: string | null;
  body: string | null;
  data: Record<string, string | null>;
  at: string;
};

/** The ticket's history, newest last, with names filled in. */
export async function ticketHistory(id: string): Promise<TicketEvent[]> {
  const me = await requireStaff();
  const supabase = await createClient();
  const { data } = await supabase
    .from("request_events")
    .select("id, kind, from_stage, to_stage, body, data, created_at, profiles(full_name)")
    .eq("request_id", id)
    .order("created_at");
  const ids = new Set<string>();
  for (const e of data ?? []) {
    const d = e.data as Record<string, string | null>;
    if (e.kind === "assign") [d.from, d.to].forEach((x) => x && ids.add(x));
  }
  const names = new Map<string, string>();
  if (ids.size) {
    const { data: people } = await supabase.from("profiles").select("id, full_name").in("id", [...ids]);
    people?.forEach((p) => names.set(p.id, p.full_name));
  }
  // Sending work on past the AI review is between the maker and their lead
  const lead = isExecOrLead(me);
  const visible = (data ?? []).filter((e) => lead || !(e.kind === "review" && ["past_ai_fixes", "skipped_ai"].includes((e.data as { action?: string } | null)?.action ?? "")));
  return visible.map((e) => {
    const d = { ...(e.data as Record<string, string | null>) };
    if (e.kind === "assign") {
      d.fromName = d.from ? (names.get(d.from) ?? "someone") : null;
      d.toName = d.to ? (names.get(d.to) ?? "someone") : null;
    }
    return {
      id: e.id,
      kind: e.kind as TicketEvent["kind"],
      fromStage: e.from_stage as Stage | null,
      toStage: e.to_stage as Stage | null,
      actor: (e.profiles as unknown as { full_name: string } | null)?.full_name ?? null,
      body: e.body,
      data: d,
      at: e.created_at,
    };
  });
}
