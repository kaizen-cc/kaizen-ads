"use server";

import { requireStaff } from "@/lib/auth";
import type { EmailAuditResult } from "@/lib/email-ops/audit-core";
import type { SocialAuditResult } from "@/lib/social-ops/audit-core";
import { changeReadState, loadAccountChanges, type AccountChange } from "@/lib/email-ops/changes";
import { loadSuggestions } from "@/lib/email-ops/load";
import { earliestDay, type EmailDay, type SentCampaign } from "@/lib/email-ops/windows";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { SuggestionView } from "../clients/[slug]/email-ops-suggestions";

// What an email account's sheet on the KPI board reads when it opens (the board itself carries only the scores): the
// days and campaigns behind every window, the latest audit, the sprint with its moves and checks, the campaign ideas
// and the change history. Read through the person's own session, so it holds only clients they can see.

export type SheetAudit = {
  id: string;
  status: "running" | "ready" | "failed";
  step: string | null;
  progress: number;
  score: number | null;
  band: "good" | "watch" | "bad" | null;
  createdAt: string;
  auto: boolean;
  by: string | null;
  error: string | null;
  /** The email audit's result, or the social audit's on the Social sheet (the same shape, social's areas and owners) */
  result: EmailAuditResult | SocialAuditResult | null;
  done: Record<string, { by: string; at: string }>;
};

export type SheetMove = { id: string; auditIndex: number | null; title: string; owner: string | null; when: string | null; steps: string[]; why: string | null; impact: string | null; status: "todo" | "doing" | "done" | "skipped"; note: string | null; aiNote: string | null };

export type SheetSprint = {
  id: string;
  auditId: string | null;
  startedAt: string;
  baseline: number | null;
  latest: number | null;
  nextCheckAt: string;
  lastCheckAt: string | null;
  moves: SheetMove[];
  checks: { verdict: string; message: string; at: string }[];
};

export type EmailSheet = {
  today: string;
  /** When it was read (ms), so how long ago things happened is worked out from one clock */
  now: number;
  /** The first day the account has numbers for (windows before it are partial) */
  dataFrom: string | null;
  days: EmailDay[];
  campaigns: SentCampaign[];
  audit: SheetAudit | null;
  sprint: SheetSprint | null;
  suggestions: SuggestionView[];
  changes: AccountChange[];
  /** When the change history was last read, and what went wrong if it did (null: never read) */
  changesRead: { readAt: string | null; error: string | null };
};

const num = (v: unknown) => Number(v ?? 0) || 0;
const etDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

export async function loadEmailSheet(clientId: string): Promise<{ ok: true; sheet: EmailSheet } | { ok: false; error: string }> {
  await requireStaff();
  const db = await createClient();
  const { data: c } = await db.from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!c) return { ok: false, error: "You don't work on this client." };
  const today = etDay(new Date().toISOString());
  const from = earliestDay(today);
  const [days, camps, audit, sprint, suggestions, changes, read] = await Promise.all([
    db.from("klaviyo_daily").select("date, revenue, campaign_revenue, flow_revenue, campaign_recipients, flow_recipients, conversions, store_revenue").eq("client_id", clientId).gte("date", from).lte("date", today).order("date").limit(400),
    db.from("klaviyo_campaigns").select("send_time, channel, recipients, delivered, opens_unique, clicks_unique").eq("client_id", clientId).gte("send_time", `${from}T00:00:00Z`).not("send_time", "is", null).limit(1000),
    db.from("email_audits").select("id, status, step, progress, score, band, result, done, auto, error, created_at, profiles(full_name)").eq("client_id", clientId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("email_sprints").select("id, audit_id, started_at, baseline, latest, next_check_at, last_check_at, email_sprint_actions(id, audit_index, title, owner, \"when\", steps, why, impact, status, note, ai_note, sort_order), email_sprint_checks(verdict, message, created_at)").eq("client_id", clientId).eq("status", "active").maybeSingle(),
    loadSuggestions(db, [clientId], 40),
    loadAccountChanges(db, clientId, { limit: 80 }),
    adminConfigured() ? changeReadState(createAdminClient(), clientId).catch(() => ({ readAt: null, error: null })) : Promise.resolve({ readAt: null, error: null }),
  ]);

  const dayRows: EmailDay[] = (days.data ?? []).map((d) => ({
    d: d.date as string,
    revenue: num(d.revenue),
    campaignRevenue: num(d.campaign_revenue),
    flowRevenue: num(d.flow_revenue),
    recipients: num(d.campaign_recipients) + num(d.flow_recipients),
    orders: num(d.conversions),
    storeRevenue: d.store_revenue == null ? null : num(d.store_revenue),
  }));
  const campaigns: SentCampaign[] = (camps.data ?? [])
    .filter((x) => (x.channel ?? "email") !== "sms" && x.send_time && Date.parse(x.send_time as string) <= Date.now())
    .map((x) => ({ d: etDay(x.send_time as string), recipients: num(x.recipients), delivered: num(x.delivered), opens: num(x.opens_unique), clicks: num(x.clicks_unique) }));

  const a = audit.data as Record<string, unknown> | null;
  const s = sprint.data as Record<string, unknown> | null;
  return {
    ok: true,
    sheet: {
      today,
      now: Date.now(),
      dataFrom: dayRows[0]?.d ?? null,
      days: dayRows,
      campaigns,
      audit: a
        ? {
            id: a.id as string,
            status: a.status as SheetAudit["status"],
            step: (a.step as string | null) ?? null,
            progress: num(a.progress),
            score: (a.score as number | null) ?? null,
            band: (a.band as SheetAudit["band"]) ?? null,
            createdAt: a.created_at as string,
            auto: Boolean(a.auto),
            by: (a.profiles as { full_name?: string } | null)?.full_name ?? null,
            error: (a.error as string | null) ?? null,
            result: (a.result as EmailAuditResult | null) ?? null,
            done: (a.done ?? {}) as SheetAudit["done"],
          }
        : null,
      sprint: s
        ? {
            id: s.id as string,
            auditId: (s.audit_id as string | null) ?? null,
            startedAt: s.started_at as string,
            baseline: (s.baseline as { score?: number } | null)?.score ?? null,
            latest: (s.latest as { score?: number } | null)?.score ?? null,
            nextCheckAt: s.next_check_at as string,
            lastCheckAt: (s.last_check_at as string | null) ?? null,
            moves: ((s.email_sprint_actions ?? []) as Record<string, unknown>[])
              .sort((x, y) => num(x.sort_order) - num(y.sort_order))
              .map((m) => ({
                id: m.id as string,
                auditIndex: (m.audit_index as number | null) ?? null,
                title: m.title as string,
                owner: (m.owner as string | null) ?? null,
                when: (m.when as string | null) ?? null,
                steps: (m.steps ?? []) as string[],
                why: (m.why as string | null) ?? null,
                impact: (m.impact as string | null) ?? null,
                status: m.status as SheetMove["status"],
                note: (m.note as string | null) ?? null,
                aiNote: (m.ai_note as string | null) ?? null,
              })),
            checks: ((s.email_sprint_checks ?? []) as Record<string, unknown>[])
              .map((k) => ({ verdict: k.verdict as string, message: k.message as string, at: k.created_at as string }))
              .sort((x, y) => y.at.localeCompare(x.at))
              .slice(0, 3),
          }
        : null,
      suggestions,
      changes,
      changesRead: read,
    },
  };
}
