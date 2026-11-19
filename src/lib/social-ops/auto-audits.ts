import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LIVE } from "@/lib/live";
import { servicesOf } from "@/lib/services";
import { loadSocialScores } from "@/lib/social-score-load";
import { needsSocialAutoAudit, type LastAudit, type SocialAuditResult } from "./audit-core";
import { requestSocialAudit, runSocialAudit, socialAuditTouched } from "./audit";
import { socialTeamFor, whoHearsSocial } from "./people";

// Social accounts in the red audit themselves, exactly like the email accounts (src/lib/email-ops/auto-audits.ts): a
// social score under 60 with no audit yet, or a last audit three days old nobody started on, runs a fresh one and the
// client's social media manager hears about it (the Head of Organic Social when nobody is seated). The finished audit
// opens its sprint by itself. A few per run, lowest scores first. Called hourly by the context cron (step=email_ops).

const PER_RUN = 3;

type Due = { clientId: string; name: string; score: number };

async function lastAudit(admin: SupabaseClient, clientId: string): Promise<LastAudit> {
  const { data } = await admin.from("social_audits").select("id, status, created_at, done").eq("client_id", clientId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!data) return null;
  const status = data.status as "running" | "ready" | "failed";
  return { status, createdAt: data.created_at as string, touched: status === "ready" ? await socialAuditTouched(admin, { id: data.id as string, done: data.done }) : false };
}

/** The linked social clients that are red and due an audit, lowest score first */
export async function dueSocialAudits(admin: SupabaseClient): Promise<Due[]> {
  const { error } = await admin.from("social_audits").select("id").limit(1);
  if (error) return [];
  const { data: clients } = await admin.from("clients").select("id, name, services, services_extra, services_removed, strategy_only").is("archived_at", null).in("status", [...LIVE]);
  const live = (clients ?? []).filter((c) => (servicesOf(c as Parameters<typeof servicesOf>[0]) as string[]).includes("social-media"));
  const scores = await loadSocialScores(admin, live.map((c) => c.id as string));
  const out: Due[] = [];
  for (const c of live) {
    const s = scores.get(c.id as string);
    if (!s) continue;
    if (needsSocialAutoAudit(s.score, await lastAudit(admin, c.id as string))) out.push({ clientId: c.id as string, name: (c.name as string) ?? "", score: s.score });
  }
  return out.sort((a, b) => a.score - b.score);
}

/** The scheduled step: audit the red accounts that need it, then tell each manager (or the Head of Organic Social) */
export async function autoSocialAudits(admin: SupabaseClient, budgetMs = 420_000) {
  const until = Date.now() + budgetMs;
  const list = await dueSocialAudits(admin);
  let ran = 0;
  for (const d of list.slice(0, PER_RUN)) {
    if (Date.now() > until - 240_000) break;
    const r = await requestSocialAudit(admin, admin, d.clientId, null, true);
    if ("error" in r || !r.running) continue;
    await runSocialAudit(admin, r.id);
    ran++;
    await tellTeam(admin, r.id, d).catch((e) => console.error("social audit notify", e));
  }
  return { due: list.length, ran };
}

async function tellTeam(admin: SupabaseClient, auditId: string, d: Due) {
  const { data: a } = await admin.from("social_audits").select("status, result, score").eq("id", auditId).single();
  if (a?.status !== "ready") return;
  const res = a.result as SocialAuditResult | null;
  const to = whoHearsSocial(await socialTeamFor(admin, d.clientId));
  if (!to.length) return;
  const first = (res?.actions ?? []).filter((x) => x.when === "now").slice(0, 3).map((x) => `· ${x.title}`);
  const { data: sprint } = await admin.from("social_sprints").select("id").eq("audit_id", auditId).eq("status", "active").maybeSingle();
  await admin.from("notifications").upsert(
    to.map((id) => ({
      profile_id: id,
      kind: "social_audit",
      title: `${d.name}'s social score is ${a.score ?? d.score}: the audit is ready`,
      body: [res?.verdict?.headline ?? "", first.length ? `To do first:\n${first.join("\n")}` : "", sprint ? "The sprint is open with these moves, and its checks follow the posts." : ""].filter(Boolean).join("\n\n").slice(0, 1000),
      href: sprint ? `/kpis/social-sprint/${sprint.id}` : `/kpis/social-audit/${auditId}`,
      client_id: d.clientId,
      key: `social-audit:${auditId}`,
      priority: "critical",
    })),
    { onConflict: "profile_id,key", ignoreDuplicates: true },
  );
}
