import { Suspense } from "react";
import { LogoLoader } from "@/components/logo-loader";
import type { Staff } from "@/lib/auth";
import { timed } from "@/lib/perf";
import { servicesOf } from "@/lib/services";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// The client page's heavier panels, each its own server component streamed in behind a skeleton, so the page shows
// the moment its core data is in and these fill in as they're ready (none of them hold the rest of the page up).

type Base = { id: string; slug: string; name: string };
const T = <V,>(label: string, work: Promise<V>) => timed("client page", label, work);

/** A panel-sized space with the little Kaizen character keeping busy, while the panel streams in */
export function PanelSkeleton({ h = "h-40" }: { h?: string }) {
  return (
    <div className={`${h} grid place-items-center overflow-hidden rounded-[18px] border border-line bg-surface`} aria-busy="true">
      <LogoLoader size="sm" />
    </div>
  );
}

export function Streamed({ children, h }: { children: React.ReactNode; h?: string }) {
  return <Suspense fallback={<PanelSkeleton h={h} />}>{children}</Suspense>;
}

/** A new client's onboarding guide, step by step */
export async function SetupStream({ client }: { client: Base & { status: string; services?: string[] | null; services_extra?: string[] | null; services_removed?: string[] | null } }) {
  if (client.status !== "onboarding" || !adminConfigured()) return null;
  const admin = createAdminClient();
  const [{ loadGuide, guideHas }, { data: o }, { data: launch }, { GuidePanel }] = await Promise.all([
    import("@/lib/onboarding-guide"),
    admin.from("client_onboarding").select("welcomed_at, call_prep, blockers").eq("client_id", client.id).maybeSingle(),
    admin.from("engagement_launches").select("status").eq("client_id", client.id).maybeSingle(),
    import("./guide-panel"),
  ]);
  const [guide, has] = await T("setup guide", Promise.all([loadGuide(admin, client.id), guideHas(admin, client.id)]));
  return <GuidePanel slug={client.slug} guide={guide} has={has} google={servicesOf(client).includes("google-ads")} welcomed={(o?.welcomed_at as string | null) ?? null} launch={(launch?.status as string | null) ?? null} prep={(o?.call_prep as never) ?? null} blockers={(o?.blockers as never) ?? []} />;
}

/** Every email they've had from us, and the one that fits where they are now */
export async function EmailsStream({ client }: { client: Base }) {
  if (!adminConfigured()) return null;
  const admin = createAdminClient();
  const { emailStage, kindName } = await import("@/lib/client-emails");
  const [stage, { data: rows }, { data: o }, { data: pres }, { EmailsPanel }] = await T(
    "emails",
    Promise.all([
      emailStage(admin, client.id),
      admin.from("client_emails").select("id, kind, subject, sent_to, manual, sent_at, profiles(full_name)").eq("client_id", client.id).order("sent_at", { ascending: false }).limit(40),
      admin.from("client_onboarding").select("welcomed_at").eq("client_id", client.id).maybeSingle(),
      admin.from("client_presentations").select("sent_at, sent_to").eq("client_id", client.id).maybeSingle(),
      import("./emails-panel"),
    ]),
  );
  const sent = (rows ?? []).map((r) => ({ id: r.id as string, kind: r.kind as string, name: kindName(r.kind as string), subject: r.subject as string, to: (r.sent_to as string[]) ?? [], manual: Boolean(r.manual), by: (r.profiles as unknown as { full_name: string } | null)?.full_name ?? null, at: r.sent_at as string }));
  // Sent by the flow before each email was kept: listed, without a preview
  if (o?.welcomed_at && !sent.some((x) => x.kind === "welcome")) sent.push({ id: null as unknown as string, kind: "welcome", name: kindName("welcome"), subject: `Welcome to Kaizen, ${client.name}: let's get you set up`, to: [], manual: false, by: null, at: o.welcomed_at as string });
  if (pres?.sent_at && !sent.some((x) => x.kind === "presentation")) sent.push({ id: null as unknown as string, kind: "presentation", name: kindName("presentation"), subject: "How we see you", to: ((pres.sent_to as string[] | null) ?? []).filter((x) => x.includes("@")), manual: false, by: null, at: pres.sent_at as string });
  sent.sort((a, b) => b.at.localeCompare(a.at));
  return <EmailsPanel clientId={client.id} slug={client.slug} stage={stage} sent={sent} />;
}

/** What works for businesses like this one, across every client of its kind */
export async function PatternsStream({ clientId }: { clientId: string }) {
  const supabase = await createClient();
  const [{ MODEL_NAMES, patternsForClient }, { ClientPatterns }] = await Promise.all([import("@/lib/patterns"), import("@/components/patterns-view")]);
  const pat = await T("patterns", patternsForClient(supabase, clientId).catch(() => null));
  return pat?.model && pat.patterns.length ? <ClientPatterns patterns={pat.patterns} label={MODEL_NAMES[pat.model]} clientId={clientId} /> : null;
}

/** The full business audit: the latest one, the pushback on it, and whether this person may push back */
export async function BusinessAuditStream({ clientId, meId }: { clientId: string; meId: string }) {
  if (!adminConfigured()) return null;
  const admin = createAdminClient();
  const supabase = await createClient();
  const [{ data: ba }, { auditRebuttals, rebutRightsOf }, { BusinessAuditPanel }] = await Promise.all([
    supabase.from("business_audits").select("id, status, step, error, result, created_at, profiles(full_name)").eq("client_id", clientId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    import("@/lib/audit-rebuttals"),
    import("./business-audit-panel"),
  ]);
  const { whyCounts } = await import("@/lib/audit-why");
  const [pushback, rights, asked] = await T(
    "business audit",
    Promise.all([ba ? auditRebuttals(admin, ba.id as string) : Promise.resolve({} as Awaited<ReturnType<typeof auditRebuttals>>), rebutRightsOf(admin, meId), ba ? whyCounts(supabase, [ba.id as string]).catch(() => ({}) as Record<string, number>) : Promise.resolve({} as Record<string, number>)]),
  );
  return (
    <BusinessAuditPanel
      clientId={clientId}
      latest={ba ? { id: ba.id as string, status: ba.status as "running" | "ready" | "failed", step: (ba.step as string | null) ?? null, error: (ba.error as string | null) ?? null, result: (ba.result as never) ?? null, at: ba.created_at as string, by: (ba.profiles as unknown as { full_name: string } | null)?.full_name ?? null } : null}
      pushback={pushback}
      rights={rights}
      asked={asked}
    />
  );
}

/** Their store and CRM: the real customers and lead outcomes, and the team's connections */
export async function BusinessStream({ clientId }: { clientId: string }) {
  if (!adminConfigured()) return null;
  const admin = createAdminClient();
  const supabase = await createClient();
  const [{ data: conns }, { businessSummary }, { businessModelOf }, { IntegrationsPanel }] = await Promise.all([
    supabase.from("client_integrations").select("id, kind, account, label, status, last_synced_at, last_error").eq("client_id", clientId).order("created_at"),
    import("@/lib/integrations"),
    import("@/lib/business-model"),
    import("./integrations-panel"),
  ]);
  const [summary, model] = await T("store & CRM", Promise.all([businessSummary(supabase, clientId).catch(() => null), businessModelOf(admin, clientId).catch(() => null)]));
  return (
    <IntegrationsPanel
      clientId={clientId}
      connections={(conns ?? []).map((c) => ({ id: c.id as string, kind: c.kind as never, account: c.account as string, label: (c.label as string | null) ?? null, status: c.status as string, lastSyncedAt: (c.last_synced_at as string | null) ?? null, lastError: (c.last_error as string | null) ?? null }))}
      summary={summary}
      suggest={model?.model === "ecommerce" ? "shopify" : "gohighlevel"}
    />
  );
}

/** The plan after approval: Slack messages, the final execution plan and its tasks (new-flow clients, or any with a plan) */
export async function ExecutionStream({ client, me }: { client: Base & { slack_channel_id: string | null }; me: Staff }) {
  if (!adminConfigured()) return null;
  const admin = createAdminClient();
  const supabase = await createClient();
  const [{ loadPlan, loadTasks, planGate }, { loadKickoff, loadSlackMessages, kickoffGate }, { inNewFlow }, { data: seat }, { data: cr }] = await Promise.all([
    import("@/lib/execution-plan"),
    import("@/lib/kickoff"),
    import("@/lib/presentation-types"),
    supabase.from("client_assignments").select("role").eq("client_id", client.id).eq("profile_id", me.id).in("role", ["meta_buyer", "google_buyer", "tiktok_buyer"]).limit(1).maybeSingle(),
    supabase.from("clients").select("created_at, reonboarded_at").eq("id", client.id).single(),
  ]);
  const [plan, tasks, kickoff, messages, gate] = await T("execution", Promise.all([loadPlan(supabase, client.id), loadTasks(supabase, client.id), loadKickoff(supabase, client.id), loadSlackMessages(supabase, client.id), planGate(admin, client.id)]));
  if (!(plan || tasks.length || kickoff || messages.length || (cr && inNewFlow(cr as never)))) return null;
  // Before anything's drafted, say what the roadmap message waits on
  const shownKickoff = kickoff ?? { status: "waiting" as const, missing: (await kickoffGate(admin, client.id)).missing, text: "", error: null, draftedAt: null, sentAt: null, sentBy: null, sentAs: null, forced: false };
  const { ExecutionPanel } = await import("./execution-panel");
  return <ExecutionPanel clientId={client.id} meId={me.id} plan={plan} gate={gate.missing} tasks={tasks} kickoff={shownKickoff} messages={messages} can={{ decide: Boolean(seat) || me.isExec || me.isLead, lead: me.isExec || me.isLead }} hasChannel={Boolean(client.slack_channel_id)} />;
}
