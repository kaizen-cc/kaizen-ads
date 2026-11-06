"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireStaff, type Staff } from "@/lib/auth";
import { aiEnabled } from "@/lib/ai";
import { readGoogleIdea, type GoogleInsight } from "@/lib/google-ideas";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { DeployKind, DeployPlan, DeployTarget } from "@/lib/google-deploy";
import type { WriteStatus } from "@/lib/write-status-core";
import type { KeywordList, ListKeyword, Research } from "@/lib/keyword-research";

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
export async function deployTargets(id: string): Promise<{ ok: true; writes: boolean; write: WriteStatus | null; canSwitch: boolean; campaigns: { id: string; name: string }[]; adGroups: { id: string; name: string; campaignId: string; campaign: string }[] } | { ok: false; error: string }> {
  try {
    const { d, me } = await loadMine(id);
    const admin = createAdminClient();
    const [{ googleWritesOn }, { googleAccountOf }, { writeStatus }] = await Promise.all([import("@/lib/ad-changes"), import("@/lib/google-deploy"), import("@/lib/write-status")]);
    const account = await googleAccountOf(admin, d.client_id as string);
    const [writes, write] = await Promise.all([googleWritesOn(admin, account), writeStatus(admin, { clientId: d.client_id as string, account }, "google").catch(() => null)]);
    if (!account) return { ok: true, writes, write, canSwitch: me.isExec, campaigns: [], adGroups: [] };
    const { googleAdsConfigured, googleWritableSetup } = await import("@/lib/context/google-ads");
    if (!googleAdsConfigured()) return { ok: true, writes: false, write, canSwitch: me.isExec, campaigns: [], adGroups: [] };
    const s = await googleWritableSetup(account);
    return {
      ok: true,
      writes,
      write,
      canSwitch: me.isExec,
      campaigns: s.campaigns.filter((c) => c.type === "SEARCH").map((c) => ({ id: c.id, name: c.name })),
      adGroups: s.adGroups.filter((g) => s.campaigns.some((c) => c.id === g.campaignId && c.type === "SEARCH")).map((g) => ({ id: g.id, name: g.name, campaignId: g.campaignId, campaign: g.campaign })),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't read the account." };
  }
}

/** Pushes it to Google Ads, paused (only with live changes in Google Ads switched on for the client). */
export async function pushDeployAction(id: string, target: DeployTarget) {
  try {
    const { me, d, slug } = await loadMine(id);
    // Enabled only when an exec or lead chose it (now, or when it was picked in keyword research); otherwise paused
    const chose = (d.plan as DeployPlan | null)?.target?.status === "ENABLED";
    const safe: DeployTarget = { ...target, status: target.status === "ENABLED" && (me.isExec || me.isLead || chose) ? "ENABLED" : "PAUSED" };
    const { pushDeploy } = await import("@/lib/google-deploy");
    const r = await pushDeploy(createAdminClient(), id, safe);
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

/** Execs: read Google in the market now instead of waiting for Monday (Keyword Planner per industry, in the background) */
export async function readGoogleMarketNow(): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!me.isExec) return { ok: false, error: "Only execs can start a read." };
  if (!adminConfigured()) return { ok: false, error: "Not connected." };
  const { googleAdsConfigured } = await import("@/lib/context/google-ads");
  if (!googleAdsConfigured()) return { ok: false, error: "Google Ads isn't connected." };
  const admin = createAdminClient();
  after(async () => {
    const { updateGoogleMarket } = await import("@/lib/google-market");
    await updateGoogleMarket(admin).catch((e) => console.error("[google market] read now", e instanceof Error ? e.message : e));
    revalidatePath("/ideas");
  });
  return { ok: true };
}

// ─── Keyword research (In the market, for a client) ───

/** Who adds keywords to a client's account and keeps lists: the Google team, execs and leads (everyone else looks). */
const canAddKeywords = (me: Staff) => canDeploy(me) || me.isLead;

/** Keyword Planner ideas for a client (or seeds alone), in their places, sorted for relevance; cached 24 hours. */
export async function researchKeywords(input: { clientId: string | null; seeds: string[]; url: string | null; fresh?: boolean }): Promise<{ ok: true; research: Research; lists: KeywordList[] } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!adminConfigured()) return { ok: false, error: "Not connected." };
  const { googleAdsConfigured } = await import("@/lib/context/google-ads");
  if (!googleAdsConfigured()) return { ok: false, error: "Google Ads isn't connected." };
  if (input.clientId && !(await visible(input.clientId))) return { ok: false, error: "Not found." };
  try {
    const { research, loadLists } = await import("@/lib/keyword-research");
    const r = await research(createAdminClient(), me.id, { clientId: input.clientId, seeds: (input.seeds ?? []).slice(0, 20), url: input.url, fresh: Boolean(input.fresh) });
    const lists = input.clientId ? await loadLists(await createClient(), input.clientId) : [];
    return { ok: true, research: r, lists };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Keyword Planner didn't answer. Try again." };
  }
}

/** The client's search campaigns and ad groups (for where keywords go), and whether live changes are on for them. */
export async function keywordTargets(clientId: string): Promise<{ ok: true; writes: boolean; account: string | null; website: string | null; campaigns: { id: string; name: string; status: string }[]; adGroups: { id: string; name: string; campaignId: string; campaign: string; status: string }[] } | { ok: false; error: string }> {
  await requireStaff();
  const c = await visible(clientId);
  if (!c || !adminConfigured()) return { ok: false, error: "Not found." };
  try {
    const admin = createAdminClient();
    const [{ googleWritesOn }, { googleAccountOf }, { data: site }] = await Promise.all([import("@/lib/ad-changes"), import("@/lib/google-deploy"), admin.from("clients").select("website").eq("id", clientId).maybeSingle()]);
    const website = site?.website ? (/^https?:\/\//i.test(String(site.website)) ? String(site.website) : `https://${site.website}`) : null;
    const account = await googleAccountOf(admin, clientId);
    if (!account) return { ok: true, writes: false, account: null, website, campaigns: [], adGroups: [] };
    const writes = await googleWritesOn(admin, account);
    const { googleAdsConfigured, googleWritableSetup } = await import("@/lib/context/google-ads");
    if (!googleAdsConfigured()) return { ok: true, writes: false, account, website, campaigns: [], adGroups: [] };
    const s = await googleWritableSetup(account);
    const search = new Set(s.campaigns.filter((x) => x.type === "SEARCH").map((x) => x.id));
    return {
      ok: true,
      writes,
      account,
      website,
      campaigns: s.campaigns.filter((x) => search.has(x.id)).map((x) => ({ id: x.id, name: x.name, status: x.status })),
      adGroups: s.adGroups.filter((g) => search.has(g.campaignId)).map((g) => ({ id: g.id, name: g.name, campaignId: g.campaignId, campaign: g.campaign, status: g.status })),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't read their account." };
  }
}

/**
 * Picked keywords to a client: saved in their "Ideas to use" (approved, with a checklist), and pushed to Google Ads
 * right away when asked and live changes are on for them. Paused unless an exec or lead chose enabled.
 */
export async function addKeywordsToClient(input: { clientId: string; keywords: ListKeyword[]; finalUrl: string; target: DeployTarget; push: boolean; listName?: string | null; seeds: string[] }): Promise<{ ok: true; id: string; slug: string; status: string; results: { what: string; ok: boolean; error: string | null }[]; error: string | null } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!canAddKeywords(me)) return { ok: false, error: "The Google team, execs and leads add keywords to clients." };
  const c = await visible(input.clientId);
  if (!c || !adminConfigured()) return { ok: false, error: "Not found." };
  const target: DeployTarget = {
    campaignId: input.target.campaignId || null,
    adGroupId: input.target.adGroupId || null,
    campaign: input.target.campaign || null,
    adGroup: input.target.adGroup || null,
    newAdGroup: input.target.newAdGroup?.trim().slice(0, 120) || null,
    status: input.target.status === "ENABLED" ? "ENABLED" : "PAUSED",
  };
  if (target.status === "ENABLED" && !(me.isExec || me.isLead)) return { ok: false, error: "Only execs and leads add keywords enabled; they go in paused." };
  if (target.newAdGroup && !target.campaignId) return { ok: false, error: "Pick the campaign the new ad group goes into." };
  const finalUrl = input.finalUrl.trim();
  if (finalUrl && !/^https?:\/\/[^\s]+\.[^\s]+/i.test(finalUrl)) return { ok: false, error: "The landing page needs to be a full link (https://…)." };
  const admin = createAdminClient();
  try {
    const { createResearchDeploy } = await import("@/lib/keyword-research");
    const id = await createResearchDeploy(admin, { clientId: input.clientId, keywords: input.keywords, finalUrl, target, by: me.id, listName: input.listName ?? null, seeds: input.seeds ?? [] });
    let status = "approved";
    let results: { what: string; ok: boolean; error: string | null }[] = [];
    let error: string | null = null;
    if (input.push) {
      try {
        const { pushDeploy } = await import("@/lib/google-deploy");
        const r = await pushDeploy(admin, id, target);
        status = r.status;
        results = r.results;
      } catch (e) {
        // Saved anyway: it waits in their Ideas to use
        error = e instanceof Error ? e.message : "Google refused it.";
      }
    }
    revalidatePath(`/clients/${c.slug}`);
    return { ok: true, id, slug: c.slug as string, status, results, error };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't save it." };
  }
}

/** A named list of keywords kept on the client ("BBQ season"), to come back to; with an id, it's updated. */
export async function saveKeywordList(input: { clientId: string; name: string; keywords: ListKeyword[]; id?: string | null }): Promise<{ ok: true; list: KeywordList } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!canAddKeywords(me)) return { ok: false, error: "The Google team, execs and leads keep keyword lists." };
  const c = await visible(input.clientId);
  if (!c || !adminConfigured()) return { ok: false, error: "Not found." };
  const name = input.name.trim().slice(0, 80);
  if (!name) return { ok: false, error: "Name the list." };
  const { cleanKeywords, toList } = await import("@/lib/keyword-research");
  const keywords = cleanKeywords(input.keywords);
  if (!keywords.length) return { ok: false, error: "Pick some keywords first." };
  const admin = createAdminClient();
  const now = new Date().toISOString();
  const q = input.id
    ? admin.from("client_keyword_lists").update({ name, keywords, updated_at: now }).eq("id", input.id).eq("client_id", input.clientId).select("*").single()
    : admin.from("client_keyword_lists").insert({ client_id: input.clientId, name, keywords, created_by: me.id, created_at: now, updated_at: now }).select("*").single();
  const { data, error } = await q;
  if (error || !data) return { ok: false, error: error?.message ?? "Couldn't save the list." };
  revalidatePath(`/clients/${c.slug}`);
  return { ok: true, list: toList(data) };
}

export async function deleteKeywordList(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!canAddKeywords(me)) return { ok: false, error: "The Google team, execs and leads keep keyword lists." };
  const { data: l } = await (await createClient()).from("client_keyword_lists").select("id, client_id, clients(slug)").eq("id", id).maybeSingle();
  if (!l || !adminConfigured()) return { ok: false, error: "Not found." };
  await createAdminClient().from("client_keyword_lists").delete().eq("id", id);
  revalidatePath(`/clients/${(l.clients as unknown as { slug: string } | null)?.slug ?? ""}`);
  return { ok: true };
}
