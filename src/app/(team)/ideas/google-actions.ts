"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireStaff, type Staff } from "@/lib/auth";
import { aiEnabled } from "@/lib/ai";
import { readGoogleIdea, type GoogleInsight } from "@/lib/google-ideas";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { DeployKind, DeployPlan } from "@/lib/google-deploy";

/** The AI's read of one Google winner (written the first time someone points at it, then kept a week). */
export async function googleIdeaInsight(id: string): Promise<GoogleInsight | null> {
  await requireStaff();
  if (!adminConfigured() || !aiEnabled()) return null;
  try {
    return await readGoogleIdea(createAdminClient(), id);
  } catch (e) {
    console.error("[google ideas] insight failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

// ─── Use it on a client ───

/** Google buyers, the Head of Google and execs take Google ideas to clients (Meta roles keep the brief flow). */
const canDeploy = (me: Staff) => me.isExec || me.role === "google_buyer" || me.role === "head_of_google";

/** Only clients the person can see, through their own access rules. */
async function visible(clientId: string) {
  const { data } = await (await createClient()).from("clients").select("id, slug").eq("id", clientId).maybeSingle();
  return data;
}

export async function deployIdea(ideaId: string, clientId: string, kind: DeployKind, note: string): Promise<{ ok: true; id: string; slug: string } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!canDeploy(me)) return { ok: false, error: "Google buyers, the Head of Google and execs take Google ideas to clients." };
  if (!["copy", "campaign", "keywords"].includes(kind)) return { ok: false, error: "Pick what to make." };
  if (!adminConfigured() || !aiEnabled()) return { ok: false, error: "The AI isn't set up here." };
  const c = await visible(clientId);
  if (!c) return { ok: false, error: "Not found." };
  const admin = createAdminClient();
  try {
    const { createDeploy, draftDeploy } = await import("@/lib/google-deploy");
    const id = await createDeploy(admin, { ideaId, clientId, kind, note, by: me.id });
    after(() => draftDeploy(admin, id).catch((e) => console.error("[google deploy] draft", e instanceof Error ? e.message : e)));
    revalidatePath(`/clients/${c.slug}`);
    return { ok: true, id, slug: c.slug as string };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't start it." };
  }
}

/** Where a deploy stands (polled while it's being written). */
export async function deployState(id: string) {
  await requireStaff();
  const { data } = await (await createClient()).from("google_deploys").select("*, clients(name, slug)").eq("id", id).maybeSingle();
  if (!data) return null;
  const { toDeploy } = await import("@/lib/google-deploy");
  return toDeploy(data);
}

async function loadMine(id: string) {
  const me = await requireStaff();
  const { data } = await (await createClient()).from("google_deploys").select("id, client_id, status, plan, clients(slug)").eq("id", id).maybeSingle();
  if (!data) throw new Error("Not found.");
  if (!canDeploy(me) && !me.isLead) throw new Error("Only the Google team and execs act on these.");
  return { me, d: data, slug: (data.clients as unknown as { slug: string } | null)?.slug ?? "" };
}

export async function decideDeploy(id: string, decision: "approve" | "decline", reason = ""): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { me, d, slug } = await loadMine(id);
    if (!["open", "failed"].includes(d.status as string)) return { ok: false, error: "It's already been decided." };
    if (decision === "decline" && !reason.trim()) return { ok: false, error: "Say why, so it learns." };
    const now = new Date().toISOString();
    await createAdminClient()
      .from("google_deploys")
      .update({ status: decision === "approve" ? "approved" : "declined", decided_by: me.id, decided_at: now, decline_reason: decision === "decline" ? reason.trim().slice(0, 1000) : null, updated_at: now })
      .eq("id", id);
    revalidatePath(`/clients/${slug}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't save it." };
  }
}

/** The buyer's own edits to the plan, kept as written (within Google's limits). */
export async function editDeploy(id: string, plan: DeployPlan): Promise<{ ok: true; plan: DeployPlan } | { ok: false; error: string }> {
  try {
    const { d, slug } = await loadMine(id);
    if (!["open", "approved", "failed"].includes(d.status as string)) return { ok: false, error: "It can't be edited now." };
    const { tidyPlan } = await import("@/lib/google-deploy");
    const clean = tidyPlan(plan);
    await createAdminClient().from("google_deploys").update({ plan: clean, updated_at: new Date().toISOString() }).eq("id", id);
    revalidatePath(`/clients/${slug}`);
    return { ok: true, plan: clean };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't save it." };
  }
}

/** Has the AI rewrite it from a note. */
export async function rewriteDeploy(id: string, note: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { d } = await loadMine(id);
    if (!note.trim()) return { ok: false, error: "Say what to change." };
    if (!["open", "failed"].includes(d.status as string)) return { ok: false, error: "It's already been decided." };
    const admin = createAdminClient();
    await admin.from("google_deploys").update({ status: "drafting", updated_at: new Date().toISOString() }).eq("id", id);
    const { draftDeploy } = await import("@/lib/google-deploy");
    after(() => draftDeploy(admin, id, note.trim().slice(0, 1000)).catch(() => null));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't start the rewrite." };
  }
}

/** Marks it applied by hand from the checklist. */
export async function markDeployApplied(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { me, d, slug } = await loadMine(id);
    if (!["approved", "partial", "failed"].includes(d.status as string)) return { ok: false, error: "Approve it first." };
    const now = new Date().toISOString();
    await createAdminClient()
      .from("google_deploys")
      .update({ status: "applied", applied: { target: {}, results: [{ what: `Applied by hand by ${me.fullName}`, ok: true, error: null }] }, applied_at: now, updated_at: now })
      .eq("id", id);
    revalidatePath(`/clients/${slug}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't save it." };
  }
}

/** The campaigns and ad groups it could go into, for the push picker. */
export async function deployTargets(id: string): Promise<{ ok: true; writes: boolean; campaigns: { id: string; name: string }[]; adGroups: { id: string; name: string; campaignId: string; campaign: string }[] } | { ok: false; error: string }> {
  try {
    const { d } = await loadMine(id);
    const admin = createAdminClient();
    const [{ googleWritesOn }, { googleAccountOf }] = await Promise.all([import("@/lib/ad-changes"), import("@/lib/google-deploy")]);
    const writes = await googleWritesOn(admin);
    const account = await googleAccountOf(admin, d.client_id as string);
    if (!account) return { ok: true, writes, campaigns: [], adGroups: [] };
    const { googleAdsConfigured, googleWritableSetup } = await import("@/lib/context/google-ads");
    if (!googleAdsConfigured()) return { ok: true, writes: false, campaigns: [], adGroups: [] };
    const s = await googleWritableSetup(account);
    return {
      ok: true,
      writes,
      campaigns: s.campaigns.filter((c) => c.type === "SEARCH").map((c) => ({ id: c.id, name: c.name })),
      adGroups: s.adGroups.filter((g) => s.campaigns.some((c) => c.id === g.campaignId && c.type === "SEARCH")).map((g) => ({ id: g.id, name: g.name, campaignId: g.campaignId, campaign: g.campaign })),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't read the account." };
  }
}

/** Pushes it to Google Ads, paused (only with Google writes switched on). */
export async function pushDeployAction(id: string, target: { campaignId: string | null; adGroupId: string | null; campaign: string | null; adGroup: string | null }) {
  try {
    const { slug } = await loadMine(id);
    const { pushDeploy } = await import("@/lib/google-deploy");
    const r = await pushDeploy(createAdminClient(), id, target);
    revalidatePath(`/clients/${slug}`);
    return { ok: true as const, ...r };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "Google refused it." };
  }
}

/** Rebuilds one sub-vertical's Google playbook (execs). */
export async function rebuildGooglePlaybook(subId: string): Promise<{ ok: true; built: boolean } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!me.isExec) return { ok: false, error: "Execs rebuild playbooks." };
  if (!adminConfigured() || !aiEnabled()) return { ok: false, error: "The AI isn't set up here." };
  const admin = createAdminClient();
  const { buildGooglePlaybook } = await import("@/lib/google-playbooks");
  after(() => buildGooglePlaybook(admin, subId).catch((e) => console.error("[google playbook]", e instanceof Error ? e.message : e)));
  return { ok: true, built: true };
}
