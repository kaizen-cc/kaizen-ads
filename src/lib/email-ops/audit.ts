import "server-only";
import { forProvider } from "@/lib/email-providers/core";
import { emailConnection, emailSourceName } from "@/lib/email-providers/which";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AgentOffline, AiPaused, AiUnavailable, askJson } from "@/lib/ai";
import { notLive } from "@/lib/live-guard";
import { clientKlaviyo } from "@/lib/klaviyo/store";
import { loadSegmentReport } from "@/lib/klaviyo/segments";
import { segmentDigest } from "@/lib/klaviyo/segments-core";
import { emailBrief } from "./chat";
import { auditDigest, moneyFor, EMAIL_AUDIT_SCHEMA, EMAIL_AUDIT_SYSTEM, ruleFindings, type EmailAuditResult } from "./audit-core";
import { emailScoreOf } from "./score";
import { snapshotOf } from "./sprint-core";

// The email audit: one client's Klaviyo account read the way a senior email strategist would, against the seven-check
// email score, its own last 90 days and the client's full context (Brand Bible, memory, calls). It says why the
// account is where it is and writes the plan the team ticks off; a sprint then follows the plan to done. It runs
// through the Email Strategist agent (the email_audit skill). Read only: nothing is sent, edited or scheduled in Klaviyo.

const STALE_MS = 15 * 60_000; // a "running" audit older than this has timed out and does not block a new one

const nyToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

export type AuditStart = { id: string; running: boolean } | { error: string };

/** Starts an audit row for a client (one at a time per client), or says why not. The caller runs it with runEmailAudit. */
export async function requestEmailAudit(db: SupabaseClient, admin: SupabaseClient, clientId: string, by: string | null, auto = false): Promise<AuditStart> {
  // A person asking: only an exec, the head of email or the client's email strategist (the system's own audits run as itself)
  if (!auto && by) {
    const { mayAuditOn } = await import("@/lib/line-actions-server");
    const may = await mayAuditOn(admin, by, clientId, "email");
    if (!may.ok) return { error: may.reason };
  }
  const why = await notLive(db, clientId);
  if (why) return { error: why };
  const conn = await emailConnection(admin, clientId);
  if (!conn) return { error: "Connect the client's email provider first: an audit reads its numbers." };
  const { data: running } = await admin.from("email_audits").select("id, created_at").eq("client_id", clientId).eq("status", "running").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (running && Date.now() - Date.parse(running.created_at as string) < STALE_MS) return { id: running.id as string, running: false };
  const { data, error } = await admin.from("email_audits").insert({ client_id: clientId, created_by: by, auto, step: "Starting", progress: 2 }).select("id").single();
  if (error || !data) return { error: error?.message ?? "Couldn't start the audit." };
  return { id: data.id as string, running: true };
}

// A real promise (the query builder only runs when awaited), so it can be fired from the stream callback too
async function progress(admin: SupabaseClient, id: string, step: string, pct: number) {
  await admin.from("email_audits").update({ step, progress: pct }).eq("id", id);
}

/** Reads the account and writes the audit. Never throws: a failure is kept on the row, in plain words. */
export async function runEmailAudit(admin: SupabaseClient, auditId: string) {
  const { data: row } = await admin.from("email_audits").select("client_id").eq("id", auditId).maybeSingle();
  if (!row) return;
  const clientId = row.client_id as string;
  try {
    await progress(admin, auditId, `Reading the ${await emailSourceName(admin, clientId)} account`, 10);
    const [{ data: client }, k, score] = await Promise.all([admin.from("clients").select("name").eq("id", clientId).maybeSingle(), clientKlaviyo(admin, clientId), emailScoreOf(admin, clientId)]);
    if (!k) throw new Error("There are no email numbers for this client yet: the first sync has not finished.");
    if (!score) throw new Error("The email score could not be worked out: there is nothing to measure yet.");
    const today = nyToday();
    const name = (client?.name as string | null) ?? "the client";

    await progress(admin, auditId, "Reading the client's context", 30);
    // The shared context only (Brand Bible, memory, the last 45 days of Slack, email and calls): never the paid-ads brief, which the email team does not see
    // Who the campaigns went to and how each segment did, with the rules' advice and what works for similar clients
    const [ctx, changes, segments] = await Promise.all([emailBrief(admin, clientId).catch(() => null), import("./changes").then((c) => c.changesBlock(admin, clientId, 30)).catch(() => ""), loadSegmentReport(admin, clientId, { days: 90, peerDb: admin }).catch(() => null)]);
    const digest = auditDigest(name, score, k, today);
    const floor = ruleFindings(score, k.keyFlows.map((f) => ({ label: f.label, state: f.state, critical: f.id === "welcome" || f.id === "abandoned" })));

    await progress(admin, auditId, "Writing the audit", 50);
    let shown = 50;
    const result = await askJson<EmailAuditResult>({
      agent: "email_audit",
      label: "email account audit",
      clientId,
      system: forProvider(EMAIL_AUDIT_SYSTEM, k.providerName),
      schema: EMAIL_AUDIT_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 16000,
      // One write per point of progress (at most ~40), never one per streamed chunk: that was ~1,000 writes an audit and slowed the whole app
      onText: (t) => {
        const pct = Math.min(90, 50 + Math.round(t.length / 250));
        if (pct > shown) {
          shown = pct;
          void progress(admin, auditId, "Writing the audit", pct);
        }
      },
      prompt: `${digest}\n\n<what_the_numbers_prove note="rule-based, from the score and the key flows">\n${floor.map((f) => `- [${f.severity}] ${f.title}: ${f.evidence.join(" ")}`).join("\n") || "(nothing under its bar)"}\n</what_the_numbers_prove>\n\n${changes ? `${changes}\n\n` : ""}${segments ? `<segments note="who the campaigns went to and how each list and segment did, with advice from the rules and from similar clients">\n${segmentDigest(segments, moneyFor(k.currency))}\n</segments>\n\n` : ""}${ctx?.text ?? ""}\n\nAudit ${name}'s email account today. Say in the diagnosis whether anyone has been working in the account lately, from the changes given.`,
    });
    // The verdict's status always follows the real score, whatever the AI said
    result.verdict.status = score.band === "bad" ? "red" : score.band === "watch" ? "watch" : "good";
    await admin
      .from("email_audits")
      .update({ status: "ready", step: "Done", progress: 100, result, score: score.score, band: score.band, inputs: { snapshot: snapshotOf(score), campaigns: k.campaigns.length, flows: k.flows.length, through: k.through, segments: segments ? { campaigns: segments.withAudiences, read: segments.segments.length, flagged: segments.segments.filter((s) => s.flags.length).length, advice: segments.advice.length } : null }, finished_at: new Date().toISOString(), error: null })
      .eq("id", auditId);
    // A red account's plan becomes its sprint straight away (today's and this week's moves), so it is followed and checked
    if (score.band === "bad") await import("./sprint").then((m) => m.autoEmailSprint(admin, auditId)).catch((e) => console.error("[email audit] auto sprint:", e instanceof Error ? e.message : e));
  } catch (e) {
    const offline = e instanceof AgentOffline;
    const message = offline || e instanceof AiUnavailable ? (e as Error).message : e instanceof Error ? e.message : "The audit failed.";
    await admin.from("email_audits").update({ status: "failed", step: e instanceof AiPaused ? "Paused, will try again" : "Failed", error: message.slice(0, 400), finished_at: new Date().toISOString() }).eq("id", auditId);
  }
}

/** Whether anyone has acted on an audit: an action ticked, or a sprint move begun */
export async function auditTouched(admin: SupabaseClient, audit: { id: string; done: unknown }): Promise<boolean> {
  if (Object.keys((audit.done ?? {}) as object).length) return true;
  const { data: sprints } = await admin.from("email_sprints").select("id").eq("audit_id", audit.id);
  const ids = (sprints ?? []).map((s) => s.id as string);
  if (!ids.length) return false;
  const { count } = await admin.from("email_sprint_actions").select("id", { count: "exact", head: true }).in("sprint_id", ids).neq("status", "todo");
  return Boolean(count);
}
