"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { onReachedClient } from "@/lib/client-revision";
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
    after(() => onReachedClient(createAdminClient(), id));
  }
  // Ready to launch: Kaizen OS launches it (paused) now, rather than at the next scheduled pass
  if (!error && stage === "ready_for_launch" && adminConfigured()) {
    after(async () => {
      const { autoLaunch } = await import("@/lib/launcher");
      await autoLaunch(createAdminClient(), id).catch((e) => console.error("autoLaunch", id, e));
    });
  }
  return done(error);
}

export type MoveCheck = {
  backwards: boolean;
  /** Has to be done first (the move is refused without it); fix says what to do */
  blockers: { text: string; fix?: "upload" | "copy" }[];
  /** Worth knowing: moving anyway needs a note saying why */
  warnings: string[];
  /** What happens when it lands there */
  effects: string[];
};

const ORDER: Stage[] = ["requested", "in_production", "internal_review", "copy", "copy_review", "client_review", "client_revision", "ready_for_launch", "launched"];
// Where each stage sits in the flow (client changes is production again, after the client)
const RANK: Partial<Record<Stage, number>> = { requested: 0, in_production: 1, client_revision: 1, internal_review: 2, copy: 3, copy_review: 4, client_review: 5, ready_for_launch: 6, launched: 7 };

/**
 * Before a ticket is moved by hand (dragged across the board or picked in the ticket): does it have what that stage
 * needs? Creative for anything past production, approved copy for the client, and what each stage assumes happened.
 */
export async function moveCheck(id: string, stage: Stage): Promise<MoveCheck> {
  await requireStaff();
  const supabase = await createClient();
  const [{ data: r }, { data: designs }, { data: copy }, { data: approved }, { data: ai }] = await Promise.all([
    supabase.from("requests").select("stage, format, new_count, variation_count").eq("id", id).maybeSingle(),
    supabase.from("designs").select("is_variation, client_status, current_version, design_versions(version, design_files(id))").eq("request_id", id),
    supabase.from("copy_sets").select("status").eq("request_id", id).maybeSingle(),
    supabase.from("request_events").select("id").eq("request_id", id).eq("kind", "review").eq("data->>decision", "approve").limit(1),
    supabase.from("creative_ai_reviews").select("status, content").eq("request_id", id).order("started_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const out: MoveCheck = { backwards: false, blockers: [], warnings: [], effects: [] };
  if (!r) return { ...out, blockers: [{ text: "Ticket not found." }] };
  out.backwards = (RANK[stage] ?? ORDER.indexOf(stage)) < (RANK[r.stage as Stage] ?? ORDER.indexOf(r.stage as Stage));
  type D = { is_variation: boolean; client_status: string | null; current_version: number; design_versions: { version: number; design_files: { id: string }[] }[] };
  const made = ((designs ?? []) as unknown as D[]).filter((d) => d.design_versions.find((v) => v.version === d.current_version)?.design_files.length);
  const net = made.filter((d) => !d.is_variation).length;
  const vars = made.filter((d) => d.is_variation).length;
  const rank = RANK[stage] ?? 0;
  const what = r.format === "video" ? "video" : r.format === "carousel" ? "carousel" : "creative";

  if (rank >= 2 && stage !== "client_revision") {
    if (!made.length) out.blockers.push({ text: `No ${what} is uploaded. Upload the ${rank >= 5 ? "approved " : ""}${what} first.`, fix: "upload" });
    else if (net < r.new_count || vars < r.variation_count) out.warnings.push(`Only ${net} of ${r.new_count} new${r.variation_count ? ` and ${vars} of ${r.variation_count} variations` : ""} are uploaded.`);
  }
  if (rank >= 3 && stage !== "client_revision" && !approved?.length) out.warnings.push("The creative hasn't been approved in creative review.");
  if (rank === 2 || (rank === 3 && !approved?.length)) {
    const notes = (ai?.content as { verdict?: string } | null)?.verdict;
    if (!ai || ai.status !== "done") out.warnings.push("There's no AI review of this creative yet.");
    else if (notes === "fix") out.warnings.push("The last AI review found things to fix.");
  }
  if (stage === "copy_review" && !copy) out.warnings.push("No copy has been written yet. It'll need drafting in Copy.");
  if (stage === "client_review" && copy && copy.status !== "approved") out.blockers.push({ text: "The copy isn't approved yet. It goes to the client together with the creative.", fix: "copy" });
  if (stage === "client_review" && !copy) out.warnings.push("There's no copy on this ticket (fine if the angle's copy was approved on another ticket).");
  if (stage === "ready_for_launch") {
    const ok = made.filter((d) => d.client_status === "approved").length;
    if (made.length && ok < made.length) out.warnings.push(`The client has approved ${ok} of ${made.length} designs.`);
    if (copy && copy.status !== "approved") out.warnings.push("The copy isn't approved.");
    out.effects.push("Kaizen OS creates the ads in Meta right away, paused, for the buyer to turn on.");
  }
  if (stage === "client_review") out.effects.push("It shows in the client's portal for their approval.");
  if (stage === "copy") out.effects.push("The AI drafts the copy if there isn't any yet.");
  if (out.backwards) out.effects.push("The turnaround for that stage starts again, and it goes to that stage's owner.");
  return out;
}

/**
 * Who it's with, changed on the ticket like Asana (owner, Nov 26 2026): only whoever moves it today (an exec, a lead,
 * the person it's with). Logged on the timeline and "#N is on you" to the new person by the database; the linked Asana
 * task's assignee follows.
 */
export async function assignTicket(id: string, profileId: string | null): Promise<ActionResult> {
  const me = await requireStaff();
  if (me.viewAs) return { ok: false, error: "Not while viewing as someone." };
  const supabase = await createClient();
  const { data: r } = await supabase.from("requests").select("assignee_id").eq("id", id).maybeSingle();
  if (!r) return { ok: false, error: "That ticket isn't there any more." };
  const { mayEditTicket } = await import("@/lib/ticket-edit-core");
  if (!mayEditTicket(me, (r.assignee_id as string | null) ?? null)) return { ok: false, error: "Only a lead, an exec or the person it's with can change who it's with." };
  if ((r.assignee_id ?? null) === profileId) return { ok: true };
  const { error } = await supabase.rpc("assign_request", { p_request: id, p_profile: profileId });
  if (!error && adminConfigured()) after(() => import("@/lib/ticket-edit").then(({ asanaFollow }) => asanaFollow(createAdminClient(), me, id, { assignee: profileId })));
  return done(error);
}

/** The due date, on the ticket like Asana: the same people as above; cleared with null; the Asana task follows */
export async function setTicketDue(id: string, dueIso: string | null): Promise<ActionResult> {
  const me = await requireStaff();
  if (me.viewAs) return { ok: false, error: "Not while viewing as someone." };
  if (dueIso !== null && Number.isNaN(Date.parse(dueIso))) return { ok: false, error: "Pick a valid date and time." };
  const supabase = await createClient();
  const { data: r } = await supabase.from("requests").select("assignee_id").eq("id", id).maybeSingle();
  if (!r) return { ok: false, error: "That ticket isn't there any more." };
  const { mayEditTicket } = await import("@/lib/ticket-edit-core");
  if (!mayEditTicket(me, (r.assignee_id as string | null) ?? null)) return { ok: false, error: "Only a lead, an exec or the person it's with can change the due date." };
  const { error } = await supabase.rpc("set_request_due", { p_request: id, p_due: dueIso });
  if (!error && adminConfigured()) after(() => import("@/lib/ticket-edit").then(({ asanaFollow }) => asanaFollow(createAdminClient(), me, id, { due: dueIso })));
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
  kind: "created" | "stage" | "assign" | "due" | "priority" | "comment" | "upload" | "review" | "copy" | "client_notice";
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

/** Execs and leads: delete a ticket (it can be restored from Settings → Deleted). */
export async function deleteTicket(id: string, reason: string): Promise<ActionResult> {
  await requireStaff();
  const supabase = await createClient();
  const { error } = await supabase.rpc("delete_request", { p_request: id, p_reason: reason });
  revalidatePath("/settings");
  return done(error);
}

/** Execs and leads: bring a deleted ticket back exactly as it was. */
export async function restoreTicket(id: string): Promise<ActionResult> {
  await requireStaff();
  const supabase = await createClient();
  const { error } = await supabase.rpc("restore_request", { p_request: id });
  revalidatePath("/settings");
  return done(error);
}

/**
 * An Asana task dragged to another column on the board: moved there in Asana itself (the board mirrors Asana, so a move
 * made only here would snap back on the next sync), and the mirror updated at once. The person it's assigned to, a lead
 * or an exec, like migrating it. The column is Asana's own one for that stage (the first, in the board's order).
 */
export async function moveAsanaTask(gid: string, stage: Stage): Promise<ActionResult> {
  const me = await requireStaff();
  if (!/^\d{5,30}$/.test(gid)) return { ok: false, error: "That task isn't on the board." };
  if (!adminConfigured()) return { ok: false, error: "Not set up here." };
  const admin = createAdminClient();
  const { data: task } = await admin.from("asana_tasks").select("gid, profile_id, section, stage, moves, open, request_id").eq("gid", gid).maybeSingle();
  if (!task || !task.open || task.request_id) return { ok: false, error: "That task isn't on the board any more." };
  if (!isExecOrLead(me) && task.profile_id !== me.id) return { ok: false, error: "Only the person it's assigned to, a lead or an exec can move it." };
  if (task.stage === stage) return { ok: true };
  const { asana, asanaConfigured, asanaWrite, projectGid, stageForColumn } = await import("@/lib/asana");
  if (!asanaConfigured()) return { ok: false, error: "Asana isn't connected here." };
  try {
    const project = await projectGid(admin);
    const { data: sections } = await asana<{ gid: string; name: string }[]>(`/projects/${project}/sections`, { opt_fields: "name" });
    const to = sections.find((x) => stageForColumn(x.name) === stage);
    if (!to) return { ok: false, error: `The Creative board in Asana has no column for ${stage.replace(/_/g, " ")}.` };
    // As the person who dragged it (their own Asana), never the shared connection
    const { asanaAsPerson } = await import("@/lib/asana-user");
    await asanaAsPerson(admin, me.id, () => asanaWrite(`/sections/${to.gid}/addTask`, { task: gid }));
    const moves = [...((task.moves ?? []) as { from: string | null; to: string | null; at: string }[]), { from: task.section as string | null, to: to.name, at: new Date().toISOString() }].slice(-30);
    await admin.from("asana_tasks").update({ section: to.name, stage, moves, synced_at: new Date().toISOString() }).eq("gid", gid);
    return done();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.replace(/^Asana: /, "Asana said: ") : "Asana didn't take the move." };
  }
}
