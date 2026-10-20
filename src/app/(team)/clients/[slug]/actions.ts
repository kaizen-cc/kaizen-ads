"use server";

import { revalidatePath } from "next/cache";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { detectIndustries, INDUSTRIES } from "@/lib/industry";
import { refreshBriefing } from "@/lib/context/briefing";
import { metaConfigured, syncClientMeta } from "@/lib/context/meta";
import { runFatigue } from "@/lib/fatigue";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { notLive } from "@/lib/live-guard";
import { askAboutClient, loadClientChat } from "@/lib/client-chat";
import type { ChatTurn } from "@/lib/handoff";

export type ActionResult = { ok: true } | { ok: false; error: string };

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" && v.trim() ? v.trim() : null;
};

function done(slug: string, error?: { message: string } | null): ActionResult {
  revalidatePath(`/clients/${slug}`);
  revalidatePath("/clients");
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Execs: status, IDs and channels. RLS enforces exec-only. */
export async function saveClientDetails(clientId: string, slug: string, form: FormData): Promise<ActionResult> {
  await requireStaff();
  const { data: was } = await (await createClient()).from("clients").select("archived_at").eq("id", clientId).maybeSingle();
  if (was?.archived_at) return { ok: false, error: "This client is archived. Restore them first." };
  const kaizenId = str(form, "kaizen_id");
  const supabase = await createClient();
  const { error } = await supabase
    .from("clients")
    .update({
      status: str(form, "status") ?? "active",
      client_type: str(form, "client_type") ?? "traditional",
      website: str(form, "website"),
      meta_ad_account_id: str(form, "meta_ad_account_id")?.replace(/^act_/, "") ?? null,
      slack_channel_id: str(form, "slack_channel_id"),
      internal_slack_channel_id: str(form, "internal_slack_channel_id"),
      // Accept a pasted folder link as well as a bare ID
      drive_folder_id: str(form, "drive_folder_id")?.match(/folders\/([\w-]+)/)?.[1] ?? str(form, "drive_folder_id"),
      kaizen_id: kaizenId && /^\d+$/.test(kaizenId) ? Number(kaizenId) : null,
    })
    .eq("id", clientId);
  return done(slug, error);
}

export async function addContact(clientId: string, slug: string, form: FormData): Promise<ActionResult> {
  await requireStaff();
  const supabase = await createClient();
  const { error } = await supabase.rpc("add_client_contact", {
    p_client: clientId,
    p_email: str(form, "email") ?? "",
    p_name: str(form, "name"),
  });
  return done(slug, error);
}

export async function removeContact(clientId: string, slug: string, contactId: string): Promise<ActionResult> {
  await requireStaff();
  const supabase = await createClient();
  const { error } = await supabase.rpc("remove_client_contact", { p_client: clientId, p_contact: contactId });
  return done(slug, error);
}

export async function addAngle(clientId: string, slug: string, form: FormData): Promise<ActionResult> {
  const me = await requireStaff();
  const name = str(form, "name");
  if (!name) return { ok: false, error: "Give the angle a name." };
  const supabase = await createClient();
  const { error } = await supabase.from("angles").insert({
    client_id: clientId,
    name,
    kind: str(form, "kind") === "avatar" ? "avatar" : "angle",
    description: str(form, "description"),
    created_by: me.id,
  });
  if (error?.code === "23505") return { ok: false, error: `"${name}" already exists for this client.` };
  return done(slug, error);
}

export async function setAngleStatus(slug: string, angleId: string, status: "active" | "archived"): Promise<ActionResult> {
  await requireStaff();
  const supabase = await createClient();
  const { error } = await supabase.from("angles").update({ status }).eq("id", angleId);
  return done(slug, error);
}

/** Execs and leads: monthly images / videos. */
export async function saveAllotment(clientId: string, slug: string, form: FormData): Promise<ActionResult> {
  const me = await requireStaff();
  const n = (k: string) => Math.max(0, Math.min(999, Number(form.get(k)) || 0));
  const supabase = await createClient();
  const { error } = await supabase
    .from("client_allotments")
    .upsert({ client_id: clientId, images_per_month: n("images"), videos_per_month: n("videos"), updated_by: me.id, updated_at: new Date().toISOString() });
  return done(slug, error);
}

/** Execs: put a client on a sprint package until a date (or change one). The database checks it's an exec. */
export async function setSprintPackage(clientId: string, slug: string, form: FormData): Promise<ActionResult> {
  await requireStaff();
  const until = str(form, "until");
  if (!until || !/^\d{4}-\d{2}-\d{2}$/.test(until)) return { ok: false, error: "Pick the day the sprint ends." };
  const pkg = str(form, "package");
  const custom = pkg === "custom";
  const n = (k: string) => Math.max(0, Math.min(999, Number(form.get(k)) || 0));
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_sprint_package", {
    p_client: clientId,
    p_until: until,
    p_package: custom ? null : pkg,
    p_images: custom ? n("images") : null,
    p_videos: custom ? n("videos") : null,
    p_note: str(form, "note"),
  });
  return done(slug, error);
}

/** Execs: take a client off their creative package now. */
export async function endCreativePackage(clientId: string, slug: string): Promise<ActionResult> {
  await requireStaff();
  const supabase = await createClient();
  const { error } = await supabase.rpc("end_creative_package", { p_client: clientId });
  return done(slug, error);
}

/** Something the team learned about this client. The AI uses it for suggestions and the request review. */
export async function addMemory(clientId: string, slug: string, form: FormData): Promise<ActionResult> {
  const me = await requireStaff();
  const body = str(form, "body");
  if (!body) return { ok: false, error: "Write what the AI should know." };
  const kind = str(form, "kind");
  const supabase = await createClient();
  const { error } = await supabase.from("client_memory").insert({
    client_id: clientId,
    kind: kind === "avoid" || kind === "prefer" ? kind : "note",
    body: body.slice(0, 1000),
    source: str(form, "source") === "client" ? "client" : "team",
    created_by: me.id,
  });
  return done(slug, error);
}

export async function archiveMemory(slug: string, memoryId: string): Promise<ActionResult> {
  await requireStaff();
  const supabase = await createClient();
  const { error } = await supabase.from("client_memory").update({ status: "archived" }).eq("id", memoryId);
  return done(slug, error);
}

/** Rebuild this client's briefing now instead of waiting for the next 12pm or 6pm run. */
export async function refreshClientBriefing(clientId: string, slug: string): Promise<ActionResult> {
  { const why = await notLive(await createClient(), clientId); if (why) return { ok: false, error: why }; }
  await requireStaff();
  // Only people who can see the client can refresh it; the write itself needs the server's rights
  const supabase = await createClient();
  const { data: visible } = await supabase.from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!visible) return { ok: false, error: "You don't work on this client." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  try {
    await refreshBriefing(createAdminClient(), clientId, true);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't refresh the briefing." };
  }
  return done(slug);
}

/** Pull this client's Meta numbers now instead of waiting for the next 12pm or 6pm run. */
export async function syncMetaNow(clientId: string, slug: string): Promise<ActionResult> {
  { const why = await notLive(await createClient(), clientId); if (why) return { ok: false, error: why }; }
  await requireStaff();
  const supabase = await createClient();
  const { data: c } = await supabase.from("clients").select("meta_ad_account_id").eq("id", clientId).maybeSingle();
  if (!c) return { ok: false, error: "You don't work on this client." };
  if (!c.meta_ad_account_id) return { ok: false, error: "Add the ad account ID and save first." };
  if (!metaConfigured() || !adminConfigured()) return { ok: false, error: "Meta isn't connected on the server." };
  try {
    await syncClientMeta(createAdminClient(), clientId, c.meta_ad_account_id);
    await runFatigue(createAdminClient(), [clientId]);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't reach Meta." };
  }
  return done(slug);
}

/**
 * Execs: switch a client's portal live (or off). Until it's live their contacts can't get a sign-in link, the portal
 * shows them nothing, and nothing is sent to them.
 */
export async function setPortalLive(clientId: string, slug: string, live: boolean): Promise<ActionResult> {
  const me = await requireStaff();
  if (!me.isExec) return { ok: false, error: "Only an exec can switch a client's portal live." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const { error } = await createAdminClient()
    .from("clients")
    .update({ portal_live: live, portal_live_at: live ? new Date().toISOString() : null, portal_live_by: live ? me.id : null })
    .eq("id", clientId);
  return done(slug, error);
}

/** Execs and leads: set the client's industry by hand (the AI never overwrites it), or hand it back to the AI ("auto"). */
export async function setClientIndustry(clientId: string, slug: string, industry: string, detail: string): Promise<ActionResult> {
  const me = await requireStaff();
  if (!isExecOrLead(me)) return { ok: false, error: "Only execs and leads can change a client's industry." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const admin = createAdminClient();
  if (industry === "auto") {
    await admin.from("clients").update({ industry_source: null }).eq("id", clientId);
    try {
      await detectIndustries(admin, { ids: [clientId], force: true });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "The AI couldn't tell this time." };
    }
    return done(slug);
  }
  if (!INDUSTRIES.some(([k]) => k === industry)) return { ok: false, error: "Pick an industry." };
  const { error } = await admin
    .from("clients")
    .update({ industry, industry_detail: detail.trim().slice(0, 80) || null, industry_source: "team", industry_set_at: new Date().toISOString() })
    .eq("id", clientId);
  return done(slug, error);
}

/**
 * Execs and leads: archive a client. Everything inside stays (tickets, files, copy, memory, briefings, the Brand
 * Bible); the client just leaves the board, Home and every list. Restore, or the client enrolling again, brings it back.
 */
export async function archiveClient(clientId: string, slug: string, reason: string): Promise<ActionResult> {
  const me = await requireStaff();
  if (!isExecOrLead(me)) return { ok: false, error: "Only execs and leads can archive a client." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("archive_client", { p_client: clientId, p_reason: reason });
  revalidatePath("/pipeline");
  revalidatePath("/board");
  return done(slug, error);
}

export async function restoreClient(clientId: string, slug: string): Promise<ActionResult> {
  const me = await requireStaff();
  if (!isExecOrLead(me)) return { ok: false, error: "Only execs and leads can restore a client." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("restore_client", { p_client: clientId });
  revalidatePath("/pipeline");
  revalidatePath("/board");
  return done(slug, error);
}

/** Onboarding is done: the client leaves the onboarding callout on Home. Execs, leads, and the client's own team. */
export async function markOnboarded(clientId: string, slug: string): Promise<ActionResult> {
  await requireStaff();
  const { data: mine } = await (await createClient()).from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!mine) return { ok: false, error: "You don't work on this client." };
  if (!adminConfigured()) return { ok: false, error: "Can't save here." };
  const { error } = await createAdminClient().from("clients").update({ status: "active" }).eq("id", clientId).eq("status", "onboarding");
  revalidatePath("/pipeline");
  return done(slug, error);
}

/** The AI chat on the client page: one message in your own thread about this client. RLS decides who sees the client. */
export async function askClientAi(clientId: string, question: string): Promise<{ ok: true; chat: ChatTurn[] } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!question.trim()) return { ok: false, error: "Ask something first." };
  const { data: c } = await (await createClient()).from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!c) return { ok: false, error: "Client not found." };
  try {
    return { ok: true, chat: await askAboutClient(createAdminClient(), clientId, me.id, question) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't answer that just now." };
  }
}

/** My thread about this client, for the chat opened from elsewhere (the KPI board): the same thread as the client page. */
export async function loadClientAi(clientId: string): Promise<ChatTurn[]> {
  const me = await requireStaff();
  const { data: c } = await (await createClient()).from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!c) return [];
  return loadClientChat(createAdminClient(), clientId, me.id);
}

/** Starts the thread over. */
export async function clearClientAi(clientId: string) {
  const me = await requireStaff();
  await createAdminClient().from("client_chats").delete().eq("client_id", clientId).eq("profile_id", me.id);
}
