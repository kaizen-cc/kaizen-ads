import "server-only";
import { activeEmailClients } from "@/lib/email-providers/which";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LIVE } from "@/lib/live";
import { auditTouched, requestEmailAudit, runEmailAudit } from "./audit";
import { needsAutoAudit, type EmailAuditResult, type LastAudit } from "./audit-core";
import { emailTeamFor, whoHears } from "./people";
import { emailScoreOf } from "./score";

// Email accounts in the red audit themselves, like the ads accounts do: when a client's email score is under 60 and it
// has no audit yet, or its last audit is three days old and nobody has started on it (no action ticked, no sprint move
// begun), a fresh one runs and the client's email strategist hears about it (the Head of Email when nobody is seated).
// The finished audit opens its sprint by itself (runEmailAudit), so the plan is followed and checked from the start.
// A few per run so the AI calls stay spread out; the lowest scores go first. Called hourly by the context cron
// (step=email_audits).

const PER_RUN = 3;

type Due = { clientId: string; name: string; score: number };

async function lastAudit(admin: SupabaseClient, clientId: string): Promise<LastAudit> {
  const { data } = await admin.from("email_audits").select("id, status, created_at, done").eq("client_id", clientId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!data) return null;
  const status = data.status as "running" | "ready" | "failed";
  return { status, createdAt: data.created_at as string, touched: status === "ready" ? await auditTouched(admin, { id: data.id as string, done: data.done }) : false };
}

/** The connected clients that are red and due an audit, lowest score first */
async function due(admin: SupabaseClient, until: number): Promise<Due[]> {
  const conns = await activeEmailClients(admin, LIVE);
  const out: Due[] = [];
  for (const c of conns) {
    if (Date.now() > until) break;
    const score = await emailScoreOf(admin, c.client_id).catch(() => null);
    if (!score) continue;
    if (needsAutoAudit(score.score, await lastAudit(admin, c.client_id))) out.push({ clientId: c.client_id, name: c.name ?? "", score: score.score });
  }
  return out.sort((a, b) => a.score - b.score);
}

/** The scheduled step: audit the red accounts that need it, then tell each strategist (or the Head of Email) */
export async function autoEmailAudits(admin: SupabaseClient, budgetMs = 600_000) {
  const until = Date.now() + budgetMs;
  const list = await due(admin, until - 300_000);
  let ran = 0;
  for (const d of list.slice(0, PER_RUN)) {
    if (Date.now() > until - 240_000) break;
    const r = await requestEmailAudit(admin, admin, d.clientId, null, true);
    if ("error" in r || !r.running) continue;
    await runEmailAudit(admin, r.id);
    ran++;
    await tellTeam(admin, r.id, d).catch((e) => console.error("email audit notify", e));
  }
  return { due: list.length, ran };
}

/** The team hears it ran, what it found, and the first moves */
async function tellTeam(admin: SupabaseClient, auditId: string, d: Due) {
  const { data: a } = await admin.from("email_audits").select("status, result, score").eq("id", auditId).single();
  if (a?.status !== "ready") return;
  const res = a.result as EmailAuditResult | null;
  const to = whoHears(await emailTeamFor(admin, d.clientId));
  if (!to.length) return;
  const first = (res?.actions ?? []).filter((x) => x.when === "now").slice(0, 3).map((x) => `· ${x.title}`);
  // The audit opened its sprint by itself (a red account): the link goes to the moves, which the checks follow
  const { data: sprint } = await admin.from("email_sprints").select("id").eq("audit_id", auditId).eq("status", "active").maybeSingle();
  await admin.from("notifications").upsert(
    to.map((id) => ({
      profile_id: id,
      kind: "email_audit",
      title: `${d.name}'s email score is ${a.score ?? d.score}: the audit is ready`,
      body: [res?.verdict?.headline ?? "", first.length ? `To do first:\n${first.join("\n")}` : "", sprint ? "The sprint is open with these moves, and its checks look in the account for them." : ""].filter(Boolean).join("\n\n").slice(0, 1000),
      href: sprint ? `/kpis/email-sprint/${sprint.id}` : `/kpis/email-audit/${auditId}`,
      client_id: d.clientId,
      key: `email-audit:${auditId}`,
      priority: "critical",
    })),
    { onConflict: "profile_id,key", ignoreDuplicates: true },
  );
}
