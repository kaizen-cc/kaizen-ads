import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AgentOffline, AiPaused, AiUnavailable, askJson } from "@/lib/ai";
import { notLive } from "@/lib/live-guard";
import { emailBrief } from "@/lib/email-ops/chat";
import { SOCIAL_AUDIT_SCHEMA, SOCIAL_AUDIT_SYSTEM, socialRuleFindings, socialSnapshotOf, type SocialAuditResult } from "./audit-core";
import { readSocialAccount } from "./chat";

// The social audit: one client's organic social accounts read the way a senior social strategist would, against the
// social score per platform, the posts and when they went up, and the client's shared context (Brand Bible, memory,
// calls; never the paid-ads brief). It says why the account is where it is and writes the plan the team ticks off; a
// sprint then follows the plan to done. It runs through the Social Strategist (the social_audit skill). Read only.

const STALE_MS = 15 * 60_000;

export type SocialAuditStart = { id: string; running: boolean } | { error: string };

/** Starts an audit row for a client (one at a time per client), or says why not. The caller runs it with runSocialAudit. */
export async function requestSocialAudit(db: SupabaseClient, admin: SupabaseClient, clientId: string, by: string | null, auto = false): Promise<SocialAuditStart> {
  const why = await notLive(db, clientId);
  if (why) return { error: why };
  const { data: link } = await admin.from("social_accounts").select("page_id, ig_id").eq("client_id", clientId).maybeSingle();
  if (!link?.page_id && !link?.ig_id) return { error: "Link the client's Page or Instagram account first: an audit reads its numbers." };
  const { data: running } = await admin.from("social_audits").select("id, created_at").eq("client_id", clientId).eq("status", "running").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (running && Date.now() - Date.parse(running.created_at as string) < STALE_MS) return { id: running.id as string, running: false };
  const { data, error } = await admin.from("social_audits").insert({ client_id: clientId, created_by: by, auto, step: "Starting", progress: 2 }).select("id").single();
  if (error || !data) return { error: error?.message ?? "Couldn't start the audit." };
  return { id: data.id as string, running: true };
}

async function progress(admin: SupabaseClient, id: string, step: string, pct: number) {
  await admin.from("social_audits").update({ step, progress: pct }).eq("id", id);
}

/** Reads the accounts and writes the audit. Never throws: a failure is kept on the row, in plain words. */
export async function runSocialAudit(admin: SupabaseClient, auditId: string) {
  const { data: row } = await admin.from("social_audits").select("client_id").eq("id", auditId).maybeSingle();
  if (!row) return;
  const clientId = row.client_id as string;
  try {
    await progress(admin, auditId, "Reading Instagram and Facebook", 10);
    const read = await readSocialAccount(admin, clientId);
    if (!read) throw new Error("There are no social numbers for this client yet: the first read has not finished.");
    await progress(admin, auditId, "Reading the client's context", 30);
    const ctx = await emailBrief(admin, clientId).catch(() => null);
    const { data: c } = await admin.from("clients").select("industry, industry_detail").eq("id", clientId).maybeSingle();
    const floor = socialRuleFindings(read.score);
    await progress(admin, auditId, "Writing the audit", 50);
    const result = await askJson<SocialAuditResult>({
      agent: "social_audit",
      label: "social account audit",
      clientId,
      system: SOCIAL_AUDIT_SYSTEM,
      schema: SOCIAL_AUDIT_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 16000,
      onText: (t) => void progress(admin, auditId, "Writing the audit", Math.min(90, 50 + Math.round(t.length / 250))),
      prompt: `${read.digest}\n\n<industry>${(c?.industry_detail as string | null) ?? (c?.industry as string | null) ?? "not set"} (no industry benchmark is read for organic social: do not invent one)</industry>\n\n<what_the_numbers_prove note="rule-based, from the score">\n${floor.map((f) => `- [${f.severity}] ${f.title}: ${f.evidence.join(" ")}`).join("\n") || "(nothing under its bar)"}\n</what_the_numbers_prove>\n\n${ctx?.text ?? ""}\n\nAudit ${read.name}'s organic social today. Say in the diagnosis whether the account is being posted to steadily, from the posts given.`,
    });
    // The verdict's status always follows the real score, whatever the AI said
    result.verdict.status = read.score.band === "bad" ? "red" : read.score.band === "watch" ? "watch" : "good";
    await admin
      .from("social_audits")
      .update({ status: "ready", step: "Done", progress: 100, result, score: read.score.score, band: read.score.band, inputs: { snapshot: socialSnapshotOf(read.score), posts: read.posts.length, platforms: read.score.platforms.map((p) => p.platform) }, finished_at: new Date().toISOString(), error: null })
      .eq("id", auditId);
    // A red account's plan becomes its sprint straight away, so it is followed and checked
    if (read.score.band === "bad") await import("./sprint").then((m) => m.autoSocialSprint(admin, auditId)).catch((e) => console.error("[social audit] auto sprint:", e instanceof Error ? e.message : e));
  } catch (e) {
    const message = e instanceof AgentOffline || e instanceof AiUnavailable ? (e as Error).message : e instanceof Error ? e.message : "The audit failed.";
    await admin.from("social_audits").update({ status: "failed", step: e instanceof AiPaused ? "Paused, will try again" : "Failed", error: message.slice(0, 400), finished_at: new Date().toISOString() }).eq("id", auditId);
  }
}

/** Whether anyone has acted on an audit: an action ticked, or a sprint move begun */
export async function socialAuditTouched(admin: SupabaseClient, audit: { id: string; done: unknown }): Promise<boolean> {
  if (Object.keys((audit.done ?? {}) as object).length) return true;
  const { data: sprints } = await admin.from("social_sprints").select("id").eq("audit_id", audit.id);
  const ids = (sprints ?? []).map((s) => s.id as string);
  if (!ids.length) return false;
  const { count } = await admin.from("social_sprint_actions").select("id", { count: "exact", head: true }).in("sprint_id", ids).neq("status", "todo");
  return Boolean(count);
}
