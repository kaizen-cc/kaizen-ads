"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { backInCycle } from "@/lib/reactivate";
import { clientReadiness, type Readiness } from "@/lib/readiness";
import { SERVICES } from "@/lib/services";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { detectIndustries, INDUSTRIES } from "@/lib/industry";
import { refreshBriefing } from "@/lib/context/briefing";
import { metaConfigured, syncClientMeta } from "@/lib/context/meta";
import { runFatigue } from "@/lib/fatigue";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { notLive } from "@/lib/live-guard";
import { askAboutClient, loadClientChat } from "@/lib/client-chat";
import { writeShotList } from "@/lib/shot-list";
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
  const me = await requireStaff();
  const { data: was } = await (await createClient()).from("clients").select("archived_at, status").eq("id", clientId).maybeSingle();
  if (was?.archived_at) return { ok: false, error: "This client is archived. Restore them first." };
  const status = str(form, "status") ?? "active";
  const wokeUp = was?.status === "paused" && status !== "paused";
  const kaizenId = str(form, "kaizen_id");
  const supabase = await createClient();
  const { error } = await supabase
    .from("clients")
    .update({
      status,
      client_type: str(form, "client_type") ?? "traditional",
      website: str(form, "website"),
      meta_ad_account_id: str(form, "meta_ad_account_id")?.replace(/^act_/, "") ?? null,
      slack_channel_id: str(form, "slack_channel_id"),
      internal_slack_channel_id: str(form, "internal_slack_channel_id"),
      // Accept a pasted folder link as well as a bare ID
      drive_folder_id: str(form, "drive_folder_id")?.match(/folders\/([\w-]+)/)?.[1] ?? str(form, "drive_folder_id"),
      kaizen_id: kaizenId && /^\d+$/.test(kaizenId) ? Number(kaizenId) : null,
      ...(wokeUp ? { reactivated_at: new Date().toISOString(), reactivated_by: me.id } : {}),
    })
    .eq("id", clientId);
  // Paused → active: straight back into the cycle (KPIs, reports, check-ins), not at the next scheduled run
  if (!error && wokeUp) wakeUp(clientId, me.id);
  return done(slug, error);
}

/** After the response: the client's KPIs, due reports and sprint check-ins start again. */
function wakeUp(clientId: string, byId: string) {
  if (!adminConfigured()) return;
  after(() => backInCycle(createAdminClient(), clientId, byId).catch((e) => console.error("backInCycle", clientId, e)));
  revalidatePath("/kpis");
  revalidatePath("/reports");
}

/** The readiness check on a client that just went live again: what's missing for the system to run them. */
export async function checkReadiness(clientId: string): Promise<Readiness | null> {
  await requireStaff();
  return clientReadiness(await createClient(), clientId);
}

/**
 * Fills what the readiness check found missing, all at once (ad account IDs, targets, a contact, channels, the
 * folder, the website), then brings everything up again: KPIs pulled, reports queued, check-ins on.
 */
export async function fillReadiness(clientId: string, slug: string, form: FormData): Promise<{ ok: true; readiness: Readiness } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!isExecOrLead(me)) return { ok: false, error: "Only execs and leads can set a client up." };
  const supabase = await createClient();
  const errors: string[] = [];

  const update: Record<string, string> = {};
  const meta = str(form, "meta_ad_account_id")?.replace(/^act_/, "").replace(/\D/g, "");
  if (meta) update.meta_ad_account_id = meta;
  for (const k of ["slack_channel_id", "internal_slack_channel_id", "website"] as const) {
    const v = str(form, k);
    if (v) update[k] = v;
  }
  const drive = str(form, "drive_folder_id");
  if (drive) update.drive_folder_id = drive.match(/folders\/([\w-]+)/)?.[1] ?? drive;
  if (Object.keys(update).length) {
    const { error } = await supabase.from("clients").update(update).eq("id", clientId);
    if (error) errors.push(error.message);
  }

  // A Google account comes in as a KPI row (Google's customer IDs are kept as 123-456-7890)
  const google = str(form, "google_customer_id")?.replace(/\D/g, "");
  if (google) {
    if (google.length !== 10) errors.push("A Google Ads customer ID has 10 digits.");
    else {
      const dashed = `${google.slice(0, 3)}-${google.slice(3, 6)}-${google.slice(6)}`;
      const { data: has } = await supabase.from("kpi_targets").select("id").eq("client_id", clientId).eq("platform", "google").eq("ad_account_id", dashed).maybeSingle();
      if (!has) {
        const { error } = await supabase.from("kpi_targets").insert({ client_id: clientId, platform: "google", ad_account_id: dashed, conversion: "conversions", updated_by: me.id });
        if (error) errors.push(error.message);
      }
    }
  }

  // Targets, one per account
  for (const [k, v] of form.entries()) {
    if (!k.startsWith("target:") || typeof v !== "string" || !v.trim()) continue;
    const n = Number(v.replace(/[$,\s]/g, ""));
    if (!Number.isFinite(n) || n <= 0) {
      errors.push("A target is a number above zero.");
      continue;
    }
    const { error } = await supabase.from("kpi_targets").update({ target: n, updated_by: me.id, updated_at: new Date().toISOString() }).eq("id", k.slice(7)).eq("client_id", clientId);
    if (error) errors.push(error.message);
  }

  const email = str(form, "contact_email");
  if (email) {
    const { error } = await supabase.rpc("add_client_contact", { p_client: clientId, p_email: email, p_name: str(form, "contact_name") });
    if (error) errors.push(error.message);
  }

  wakeUp(clientId, me.id);
  const readiness = await clientReadiness(supabase, clientId);
  revalidatePath(`/clients/${slug}`);
  revalidatePath("/clients");
  return errors.length ? { ok: false, error: errors.join(" ") } : { ok: true, readiness };
}

/**
 * Execs and leads: switch a service on or off for a client. Kaizen Track's services can't be switched off here (Track
 * is where a sale is recorded, and the hourly mirror would put them back); the rest are kept beside Track's.
 */
export async function setClientService(clientId: string, slug: string, service: string, on: boolean): Promise<ActionResult> {
  const me = await requireStaff();
  if (!isExecOrLead(me)) return { ok: false, error: "Only execs and leads can change a client's services." };
  if (!SERVICES.some((s) => s.slug === service)) return { ok: false, error: "Unknown service." };
  if (!adminConfigured()) return { ok: false, error: "Can't save here." };
  const admin = createAdminClient();
  const { data: c } = await admin.from("clients").select("services, services_extra").eq("id", clientId).maybeSingle();
  if (!c) return { ok: false, error: "Client not found." };
  if (!on && (c.services ?? []).includes(service)) return { ok: false, error: "This one comes from Kaizen Track: end it there." };
  const extra = new Set((c.services_extra ?? []) as string[]);
  if (on) extra.add(service);
  else extra.delete(service);
  const { error } = await admin.from("clients").update({ services_extra: [...extra] }).eq("id", clientId);
  return done(slug, error);
}

/** Execs and leads: the tier a client is on for a service (email, web, social…); null clears it. */
export async function setServiceTier(clientId: string, slug: string, service: string, tierId: string | null): Promise<ActionResult> {
  const me = await requireStaff();
  if (!isExecOrLead(me)) return { ok: false, error: "Only execs and leads can set a tier." };
  const supabase = await createClient();
  const { error } = tierId
    ? await supabase.from("client_service_tiers").upsert({ client_id: clientId, service, tier_id: tierId, set_by: me.id, set_at: new Date().toISOString() })
    : await supabase.from("client_service_tiers").delete().eq("client_id", clientId).eq("service", service);
  return done(slug, error);
}

/** Execs and leads: a new tier for a service, as it's sold (e.g. Email "Growth: 4 campaigns + 2 flows a month"). */
export async function addServiceTier(service: string, label: string, includes: string): Promise<{ ok: true; tier: { id: string; label: string; includes: string | null } } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!isExecOrLead(me)) return { ok: false, error: "Only execs and leads can add a tier." };
  if (!label.trim()) return { ok: false, error: "Name the tier." };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("service_tiers")
    .insert({ service, label: label.trim().slice(0, 40), includes: includes.trim().slice(0, 200) || null, created_by: me.id })
    .select("id, label, includes")
    .single();
  if (error) return { ok: false, error: error.code === "23505" ? "That tier already exists." : error.message };
  revalidatePath("/clients", "layout");
  return { ok: true, tier: data };
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
  if (!error) wakeUp(clientId, me.id);
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
export async function askClientAi(clientId: string, question: string, goDeep = false): Promise<{ ok: true; chat: ChatTurn[] } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!question.trim()) return { ok: false, error: "Ask something first." };
  const { data: c } = await (await createClient()).from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!c) return { ok: false, error: "Client not found." };
  try {
    return { ok: true, chat: await askAboutClient(createAdminClient(), clientId, me.id, question, goDeep) };
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

/** Writes next month's shot list for the client (what to ask them to film and photograph). */
export async function writeClientShotList(clientId: string, slug: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  const { data: c } = await (await createClient()).from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!c) return { ok: false, error: "Client not found." };
  try {
    await writeShotList(createAdminClient(), clientId, me.id);
    revalidatePath(`/clients/${slug}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't write it just now." };
  }
}

/** The shot list went to the client. */
export async function markShotListSent(id: string, slug: string) {
  await requireStaff();
  const { data } = await (await createClient()).from("shot_lists").select("id").eq("id", id).maybeSingle();
  if (!data) return;
  await createAdminClient().from("shot_lists").update({ sent_at: new Date().toISOString() }).eq("id", id);
  revalidatePath(`/clients/${slug}`);
}

/** Starts the thread over. */
export async function clearClientAi(clientId: string) {
  const me = await requireStaff();
  await createAdminClient().from("client_chats").delete().eq("client_id", clientId).eq("profile_id", me.id);
}
