import type { SupabaseClient } from "@supabase/supabase-js";
import type { SuggestionView } from "@/app/(team)/clients/[slug]/email-ops-suggestions";
import type { EmailAuditResult } from "./audit-core";

// Reads for the pages: a client's latest audit and sprint, and campaign suggestions for one client or many. They read
// through the person's own session, so a person only ever gets the clients they can see.

export type AuditCard = {
  id: string;
  status: "running" | "ready" | "failed";
  score: number | null;
  band: "good" | "watch" | "bad" | null;
  headline: string | null;
  createdAt: string;
  auto: boolean;
  actions: number;
  done: number;
  error: string | null;
};
export type SprintCard = { id: string; auditId: string | null; score: number | null; baseline: number | null; moves: number; done: number; nextCheckAt: string };

type Row = Record<string, unknown>;

const toAudit = (a: Row): AuditCard => {
  const r = a.result as EmailAuditResult | null;
  return {
    id: a.id as string,
    status: a.status as AuditCard["status"],
    score: (a.score as number | null) ?? null,
    band: (a.band as AuditCard["band"]) ?? null,
    headline: r?.verdict?.headline ?? null,
    createdAt: a.created_at as string,
    auto: Boolean(a.auto),
    actions: r?.actions?.length ?? 0,
    done: Object.keys((a.done ?? {}) as object).length,
    error: (a.error as string | null) ?? null,
  };
};

/** The latest audit of each client given (clients with none are absent) */
export async function latestAudits(db: SupabaseClient, clientIds: string[]): Promise<Map<string, AuditCard>> {
  const out = new Map<string, AuditCard>();
  if (!clientIds.length) return out;
  const { data } = await db.from("email_audits").select("id, client_id, status, score, band, result, done, auto, error, created_at").in("client_id", clientIds).order("created_at", { ascending: false }).limit(Math.max(50, clientIds.length * 3));
  for (const a of (data ?? []) as Row[]) if (!out.has(a.client_id as string)) out.set(a.client_id as string, toAudit(a));
  return out;
}

/** The live sprint of each client given */
export async function activeSprints(db: SupabaseClient, clientIds: string[]): Promise<Map<string, SprintCard>> {
  const out = new Map<string, SprintCard>();
  if (!clientIds.length) return out;
  const { data } = await db.from("email_sprints").select("id, client_id, audit_id, baseline, latest, next_check_at, email_sprint_actions(status)").in("client_id", clientIds).eq("status", "active");
  for (const s of (data ?? []) as Row[]) {
    const acts = (s.email_sprint_actions ?? []) as { status: string }[];
    out.set(s.client_id as string, {
      id: s.id as string,
      auditId: (s.audit_id as string | null) ?? null,
      score: (s.latest as { score?: number } | null)?.score ?? null,
      baseline: (s.baseline as { score?: number } | null)?.score ?? null,
      moves: acts.length,
      done: acts.filter((x) => x.status === "done").length,
      nextCheckAt: s.next_check_at as string,
    });
  }
  return out;
}

/** Suggestions for the clients given, open ones first then the rest, newest first */
export async function loadSuggestions(db: SupabaseClient, clientIds: string[], limit = 60): Promise<SuggestionView[]> {
  if (!clientIds.length) return [];
  const { data } = await db
    .from("email_suggestions")
    .select("id, client_id, origin, title, idea, why, evidence, subjects, send_on, source_quote, source_url, source_at, status, outcome, outcome_note, created_at, clients(name)")
    .in("client_id", clientIds)
    .order("created_at", { ascending: false })
    .limit(limit);
  const rows = ((data ?? []) as Row[]).map(
    (r): SuggestionView => ({
      id: r.id as string,
      clientId: r.client_id as string,
      clientName: (r.clients as { name: string } | null)?.name,
      origin: r.origin as SuggestionView["origin"],
      title: r.title as string,
      idea: r.idea as string,
      why: (r.why as string | null) ?? null,
      evidence: ((r.evidence ?? []) as string[]) ?? [],
      subjects: ((r.subjects ?? []) as string[]) ?? [],
      sendOn: (r.send_on as string | null) ?? null,
      sourceQuote: (r.source_quote as string | null) ?? null,
      sourceUrl: (r.source_url as string | null) ?? null,
      sourceAt: (r.source_at as string | null) ?? null,
      status: r.status as SuggestionView["status"],
      outcome: (r.outcome as SuggestionView["outcome"]) ?? null,
      outcomeNote: (r.outcome_note as string | null) ?? null,
    }),
  );
  // Soonest send day first among the open ones, so what is coming up is on top
  const rank = (s: SuggestionView) => (s.status === "new" || s.status === "in_motion" ? 0 : 1);
  return rows.sort((a, b) => rank(a) - rank(b) || (a.sendOn ?? "9999").localeCompare(b.sendOn ?? "9999"));
}
