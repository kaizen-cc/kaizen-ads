import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { canRebut, rebutRights, type RebutPlatform, type RebutProfile, type RebutRights } from "@/lib/rebut-permission";

// Pushing back on an audit: a person allowed to (src/lib/rebut-permission.ts) disagrees with one finding and says why. It's kept on the
// audit, every later audit of the client reads it (so the same conclusion isn't drawn again without new evidence), and
// it goes into client memory, which every agent reads.

export type Rebuttal = { id: string; itemKey: string; finding: string; reason: string; by: string; at: string };

/** The fields the pushback rule reads (src/lib/rebut-permission.ts) */
export async function rebutProfile(admin: SupabaseClient, profileId: string): Promise<RebutProfile> {
  const { data } = await admin.from("profiles").select("can_rebut_audits, role").eq("id", profileId).maybeSingle();
  return data ? { can_rebut_audits: Boolean(data.can_rebut_audits), role: (data.role as string | null) ?? null } : null;
}

/**
 * Whether this person may push back on an audit item about this platform: the per-person permission, or the head of
 * that platform (Google: the Head of Google; Meta: the Head of Meta; both: either)
 */
export async function mayRebut(admin: SupabaseClient, profileId: string, platform: RebutPlatform) {
  return canRebut(await rebutProfile(admin, profileId), platform);
}

/** What this person may push back on, per platform (for a page with items about several) */
export async function rebutRightsOf(admin: SupabaseClient, profileId: string): Promise<RebutRights> {
  return rebutRights(await rebutProfile(admin, profileId));
}

/** The pushback on one audit, by finding */
export async function auditRebuttals(admin: SupabaseClient, auditId: string): Promise<Record<string, Rebuttal[]>> {
  const { data } = await admin.from("audit_rebuttals").select("id, item_key, finding, reason, created_at, profiles(full_name)").eq("audit_id", auditId).order("created_at");
  const out: Record<string, Rebuttal[]> = {};
  for (const r of data ?? [])
    (out[r.item_key as string] ??= []).push({ id: r.id as string, itemKey: r.item_key as string, finding: r.finding as string, reason: r.reason as string, by: (r.profiles as unknown as { full_name: string } | null)?.full_name ?? "The team", at: r.created_at as string });
  return out;
}

/**
 * What senior buyers taught the audits by pushing back on findings, as conditional learnings: only the few that fit
 * this client (and, once three clients back one, their sub-vertical or kind of business), each with when it holds.
 * The audit doesn't draw the same conclusion again unless the data has clearly changed.
 */
export async function rebuttalsBlock(admin: SupabaseClient, clientId: string, task?: string) {
  const { learningsBlock } = await import("@/lib/learnings");
  return learningsBlock(admin, ["auditor", "google_auditor"], clientId, task);
}

/** Save one pushback, and teach it to client memory */
export async function saveRebuttal(
  admin: SupabaseClient,
  r: { clientId: string; kind: "account" | "business"; auditId: string; itemKey: string; finding: string; reason: string; by: string; /** The ad platform the finding is about: a Google one teaches the Google auditor */ platform?: RebutPlatform },
) {
  const finding = r.finding.trim().slice(0, 600);
  const reason = r.reason.trim().slice(0, 1500);
  const { data, error } = await admin
    .from("audit_rebuttals")
    .insert({ client_id: r.clientId, audit_kind: r.kind, audit_id: r.auditId, item_key: r.itemKey, finding, reason, created_by: r.by })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  await admin.from("client_memory").insert({
    client_id: r.clientId,
    kind: "note",
    source: "audit",
    created_by: r.by,
    body: `A senior buyer disagreed with an audit finding ("${finding.slice(0, 200)}"): ${reason}`.replace(/\s*—\s*/g, ", ").slice(0, 1000),
  });
  // A conditional learning for the audits, classified after the answer
  const id = data.id as string;
  const { after } = await import("next/server");
  after(async () => {
    const { recordLearning } = await import("@/lib/learnings");
    await recordLearning(admin, { table: "audit_rebuttals", id, clientId: r.clientId, agent: r.platform === "google" ? "google_auditor" : "auditor", text: `Finding pushed back on (${r.platform === "google" ? "Google " : r.platform === "meta" ? "Meta " : ""}${r.kind} audit): "${finding}" · why: ${reason}` });
  });
  return id;
}

/**
 * A lesson taught from the Why chat on a Google idea plan (no audit behind it): into client memory, and a conditional
 * learning for the Google launcher that wrote it, kept on the chat message it came from
 */
export async function saveDeployLesson(admin: SupabaseClient, r: { clientId: string; messageId: string; finding: string; reason: string; by: string }) {
  const finding = r.finding.trim().slice(0, 600);
  const reason = r.reason.trim().slice(0, 1500);
  await admin.from("client_memory").insert({
    client_id: r.clientId,
    kind: "note",
    source: "audit",
    created_by: r.by,
    body: `A senior Google buyer disagreed with a Google idea plan ("${finding.slice(0, 200)}"): ${reason}`.replace(/\s*—\s*/g, ", ").slice(0, 1000),
  });
  const { after } = await import("next/server");
  after(async () => {
    const { recordLearning } = await import("@/lib/learnings");
    await recordLearning(admin, { table: "audit_item_messages", id: r.messageId, clientId: r.clientId, agent: "google_launcher", text: `Google idea plan pushed back on: "${finding}" · why: ${reason}` });
  });
}
