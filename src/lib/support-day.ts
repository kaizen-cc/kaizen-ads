import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import type { TodayItem } from "@/lib/today";
import { onboardingBlockers, stuckCreative, keepForSupport, SUPPORT_TOPIC, type SupportRole } from "@/lib/support-day-core";

// The support positions' day (the owner's brief, Nov 20 2026), on the server. Each role sees only what it acts on, never
// anything creative (a change of direction, an ad that needs a new creative, a creative request sent, a Brand Bible to
// approve), critical first, then important, then worth a look:
// - Onboarding Specialist: the onboarding blockers (intake form, onboarding call, client assets) and Waiting on you.
// - Client Success Coordinator: the same blockers, Waiting on you, reports not sent across the company (each owner
//   gets a drafted nudge on the coordinator's Overview), and creatives stuck on the Asana Creative board.
// - Tracking Specialist: the tracking watchdogs (audits with tracking issues, platform vs store conversions, conversion
//   rate drops), tracking tasks sent to them, onboarded clients with no tracking set up, and Waiting on you.
// Pure rules in ./support-day-core.ts.

type Draft = Omit<TodayItem, "tier" | "state" | "carried">;
const DAY = 86_400_000;
const todayNY = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

/** Assets added to a new client's Drive asset folder: nothing in this many days is a blocker */
export const ASSET_QUIET_DAYS = 7;

export async function supportDay(db: SupabaseClient, me: Staff, gathered: Draft[]): Promise<Draft[]> {
  const role = me.role as SupportRole;
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();
  const kept = gathered.filter((d) => keepForSupport(role, d));
  const extra: Draft[] = [];
  if (role === "onboarding_specialist" || role === "customer_success") extra.push(...(await blockerItems(admin).catch(() => [])));
  if (role === "customer_success") extra.push(...(await reportItems(admin).catch(() => [])), ...(await stuckCreativeItems(admin).catch(() => [])));
  if (role === "tracking_specialist") extra.push(...(await trackingItems(admin, me).catch(() => [])));
  // Closed automatically when Slack, Gmail or call notes showed it done (src/lib/done-check.ts)
  const all = [...kept, ...extra];
  const { closedKeys } = await import("@/lib/done-check");
  const closed = await closedKeys(admin, all.map((d) => d.key)).catch(() => new Set<string>());
  // One list, critical first: everything sits in one topic so the review goes by urgency alone
  return all.filter((d) => !closed.has(d.key)).map((d) => ({ ...d, topic: SUPPORT_TOPIC }));
}

/** Every onboarding client's blockers: intake form, onboarding call, client assets */
async function blockerItems(admin: SupabaseClient): Promise<Draft[]> {
  const { data: clients } = await admin.from("clients").select("id, name, slug, created_at, reonboarded_at").is("archived_at", null).eq("status", "onboarding");
  const list = (clients ?? []) as { id: string; name: string; slug: string; created_at: string; reonboarded_at: string | null }[];
  if (!list.length) return [];
  const ids = list.map((c) => c.id);
  const [{ data: forms }, { data: intakes }, { data: calls }, { data: onboard }, { data: assets }] = await Promise.all([
    admin.from("client_intake_forms").select("client_id, submitted_at").in("client_id", ids),
    admin.from("client_intakes").select("client_id, received_at").in("client_id", ids),
    admin.from("client_calls").select("client_id, occurred_at").in("client_id", ids).limit(2000),
    admin.from("client_onboarding").select("client_id, call_checked_at, call_prep").in("client_id", ids),
    admin.from("client_assets").select("client_id, created_at").in("client_id", ids).order("created_at", { ascending: false }).limit(5000),
  ]);
  const out: Draft[] = [];
  const today = todayNY();
  for (const c of list) {
    const start = c.reonboarded_at ?? c.created_at;
    const intakeAt = ((forms ?? []).find((f) => f.client_id === c.id && f.submitted_at)?.submitted_at as string | undefined) ?? ((intakes ?? []).find((i) => i.client_id === c.id)?.received_at as string | undefined) ?? null;
    const o = (onboard ?? []).find((x) => x.client_id === c.id);
    const hadCall = (calls ?? []).some((x) => x.client_id === c.id && String(x.occurred_at) >= start) || Boolean(o?.call_checked_at);
    const callBooked = hadCall || Boolean(o?.call_prep);
    const lastAsset = (assets ?? []).find((a) => a.client_id === c.id && a.created_at && String(a.created_at) >= start)?.created_at as string | undefined;
    for (const b of onboardingBlockers({ start, today, intakeAt, callBooked, lastAssetAt: lastAsset ?? null, quietDays: ASSET_QUIET_DAYS }))
      out.push({
        key: `onboard:${c.id}:${b.kind}`,
        topic: SUPPORT_TOPIC,
        score: b.score,
        client: c.name,
        clientSlug: c.slug,
        clientId: c.id,
        stat: { value: String(b.days), label: b.days === 1 ? "day into onboarding" : "days into onboarding" },
        title: b.title,
        story: b.story,
        why: b.why,
        evidence: [],
        action: { label: "Open the client", href: `/clients/${c.slug}?tab=onboarding` },
      });
  }
  return out;
}

/** Reports past their period with nothing sent, company-wide: one item per client report, with who owns sending it */
async function reportItems(admin: SupabaseClient): Promise<Draft[]> {
  const cutoff = new Date(Date.now() - 3 * DAY).toISOString().slice(0, 10);
  const { data } = await admin
    .from("reports")
    .select("id, kind, platform, period_end, owner_id, status, clients!inner(id, name, slug, archived_at), owner:profiles!reports_owner_id_fkey(full_name)")
    .in("status", ["draft", "submitted"])
    .is("hidden_at", null)
    .is("clients.archived_at", null)
    .lte("period_end", cutoff)
    .order("period_end")
    .limit(200);
  const rows = (data ?? []) as unknown as { id: string; kind: string; platform: string; period_end: string; owner_id: string | null; status: string; clients: { id: string; name: string; slug: string }; owner: { full_name: string } | null }[];
  return rows.map((r) => {
    const late = Math.max(0, Math.round((Date.parse(`${todayNY()}T12:00:00Z`) - Date.parse(`${r.period_end}T12:00:00Z`)) / DAY));
    const who = r.owner?.full_name ?? "Nobody owns it";
    return {
      key: `report:${r.id}`,
      topic: SUPPORT_TOPIC,
      score: late >= 7 ? 84 : 66,
      client: r.clients.name,
      clientSlug: r.clients.slug,
      clientId: r.clients.id,
      stat: { value: String(late), label: late === 1 ? "day since the period ended" : "days since the period ended" },
      title: `${r.platform} ${r.kind} report not sent (${who})`,
      story: `The ${r.kind} ${r.platform} report for the period ending ${r.period_end} hasn't gone to the client. ${who === "Nobody owns it" ? "Nobody owns sending it." : `${who} owns sending it: a nudge to them is drafted on your Overview.`}`,
      why: late >= 7 ? "A week late: the client notices." : "Past due: worth a nudge today.",
      evidence: [],
      action: { label: "Open the report", href: `/reports/${r.id}` },
    };
  });
}

/** Creatives stuck on the Asana Creative board: waiting on copy from the buyer, or with the client and no reply */
async function stuckCreativeItems(admin: SupabaseClient): Promise<Draft[]> {
  const { data } = await admin.from("asana_tasks").select("gid, name, url, stage, due_on, moves, assignee_name, asana_modified_at, clients(name, slug), client_id").eq("open", true).in("stage", ["copy", "client_review"]).limit(300);
  const out: Draft[] = [];
  for (const t of (data ?? []) as unknown as { gid: string; name: string; url: string | null; stage: string; due_on: string | null; moves: { to?: string; at?: string }[] | null; assignee_name: string | null; asana_modified_at: string | null; clients: { name: string; slug: string } | null; client_id: string | null }[]) {
    const s = stuckCreative({ stage: t.stage, moves: t.moves ?? [], modifiedAt: t.asana_modified_at, due: t.due_on, holder: t.assignee_name });
    if (!s) continue;
    out.push({
      key: `stuck:${t.gid}`,
      topic: SUPPORT_TOPIC,
      score: s.score,
      client: t.clients?.name ?? "Client",
      clientSlug: t.clients?.slug ?? "",
      clientId: t.client_id,
      stat: { value: String(Math.round(s.hours)), label: "hours waiting" },
      title: `${t.name}: ${s.what}`,
      story: s.line,
      why: s.why,
      evidence: [],
      action: { label: "Open in Asana", href: t.url ?? `https://app.asana.com/0/0/${t.gid}` },
    });
  }
  return out;
}

/**
 * The tracking specialist's, tiered by age (src/lib/tracking-health-core.ts): every flagged potential issue and open
 * tracking request is important from the start and critical at 2 weeks; tracking not set up is worth a look the first
 * week after onboarding, important after it, critical at 2 weeks.
 */
async function trackingItems(admin: SupabaseClient, me: Staff): Promise<Draft[]> {
  const [{ trackingHealth }, { daysSince, flagTier, notSetUpTier, TIER_SCORE }] = await Promise.all([import("@/lib/tracking-health"), import("@/lib/tracking-health-core")]);
  const [rows, { data: asks }] = await Promise.all([
    trackingHealth(admin).catch(() => []),
    admin.from("agent_asks").select("id, title, detail, due_on, created_at, urgent, clients(name, slug), client_id, asker:profiles!agent_asks_asked_by_fkey(full_name)").eq("owner_id", me.id).eq("status", "open").or(`asked_by.neq.${me.id},source_ref.like.trk:%`).limit(80),
  ]);
  const out: Draft[] = [];
  for (const r of rows) {
    for (const f of r.flags) {
      const d = daysSince(f.openedAt);
      const tier = flagTier(d);
      out.push({
        key: `dog:${f.id}`,
        topic: SUPPORT_TOPIC,
        score: TIER_SCORE[tier] + Math.min(6, d / 3),
        client: r.client,
        clientSlug: r.slug,
        clientId: r.clientId,
        stat: { value: d ? `${d}d` : "Today", label: "since the watchdog flagged it" },
        title: f.title,
        story: f.body ?? f.title,
        why: tier === "critical" ? "Open 2 weeks or more: every decision on this account rests on tracking." : "A potential tracking issue: check it before it skews the numbers.",
        evidence: [],
        action: { label: "Open tracking health", href: `/pipeline?tab=tracking&client=${r.slug}` },
      });
    }
    if (r.health.status === "not_set_up") {
      const d = r.health.daysOnboarded;
      const tier = notSetUpTier(d);
      out.push({
        key: `notrack:${r.clientId}`,
        topic: SUPPORT_TOPIC,
        score: TIER_SCORE[tier] + Math.min(6, d / 3),
        client: r.client,
        clientSlug: r.slug,
        clientId: r.clientId,
        stat: { value: String(d), label: d === 1 ? "day since onboarding" : "days since onboarding" },
        title: "Tracking not set up",
        story: `${r.client} runs paid ads with us but their orders, bookings or leads aren't confirmed as tracked, ${d} ${d === 1 ? "day" : "days"} after onboarding.`,
        why: tier === "critical" ? "Two weeks without tracking: the ad accounts optimize blind." : tier === "high" ? "Over a week without tracking." : "Set it up in their first week.",
        evidence: [],
        action: { label: "Open tracking health", href: `/pipeline?tab=tracking&client=${r.slug}` },
      });
    }
  }
  for (const a of (asks ?? []) as unknown as { id: string; title: string; detail: string | null; due_on: string | null; created_at: string; urgent: boolean | null; clients: { name: string; slug: string } | null; client_id: string | null; asker: { full_name: string } | null }[]) {
    const d = daysSince(a.created_at);
    const tier = a.urgent ? (d >= 14 ? "critical" : "high") : flagTier(d);
    const picked = Boolean(a.detail?.startsWith("Asked in"));
    out.push({
      key: `ask:${a.id}`,
      topic: SUPPORT_TOPIC,
      score: TIER_SCORE[tier] + Math.min(6, d / 3),
      client: a.clients?.name ?? "Tracking",
      clientSlug: a.clients?.slug ?? "",
      clientId: a.client_id,
      stat: { value: d ? `${d}d` : "Today", label: "since it was asked" },
      title: a.title,
      story: a.detail || a.title,
      why: picked ? "A tracking request picked up from a message, a task, a call or meeting notes" : `From ${a.asker?.full_name ?? "a teammate"}${a.urgent ? ", marked urgent" : ""}`,
      evidence: [],
      // The client's page, else its own sheet on the Overview (the old Next for me list is gone)
      action: a.clients?.slug ? { label: "Open the client", href: `/clients/${a.clients.slug}` } : { label: "Open it", href: `/pipeline?block=work&item=ask%3A${a.id}` },
    });
  }
  return out;
}
