import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { matchActor } from "@/lib/account-watch/core";
import { isHumanAuthor } from "@/lib/line-review/core";
import { servicesOf } from "@/lib/services";
import { TRACKING_KINDS } from "@/lib/watchdogs/core";
import { csRank, medianReplyHours, onboardingState, sentiment, type OnboardingState, type Sentiment } from "./support-core";

// The support positions' dashboards (read with the admin client after the Overview checked the role; none of it is
// money or an account's private numbers beyond what the role already sees):
//   tracking specialist   open tracking problems across accounts (the tracking watchdogs, lost access, integrations)
//   customer success      reply times in client channels, sentiment per client, quiet accounts; low sentiment first
//   onboarding specialist stuck onboardings: no intake (no delivery dates until it's in), no assets, no access, no
//                         weekly check-in, and days stuck

const DAY = 86_400_000;
const LIVE = ["active", "onboarding"];
const nyDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });

async function pages<T>(make: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, max = 30_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < max; from += 1000) {
    const { data, error } = await make(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export type TrackingIssue = { id: string; kind: string; client: string; slug: string; title: string; body: string | null; severity: string; openedAt: string };

export async function trackingBoard(admin: SupabaseClient): Promise<TrackingIssue[]> {
  const { data } = await admin
    .from("watch_flags")
    .select("id, kind, title, body, severity, opened_at, clients!inner(name, slug, archived_at)")
    .is("resolved_at", null)
    .is("clients.archived_at", null)
    .in("kind", [...TRACKING_KINDS, "access_lost", "integration_auth"])
    .order("opened_at", { ascending: false })
    .limit(300);
  const order: Record<string, number> = { critical: 0, warn: 1, info: 2 };
  return ((data ?? []) as unknown as { id: string; kind: string; title: string; body: string | null; severity: string; opened_at: string; clients: { name: string; slug: string } }[])
    .map((f) => ({ id: f.id, kind: f.kind, client: f.clients.name, slug: f.clients.slug, title: f.title, body: f.body, severity: f.severity, openedAt: f.opened_at }))
    .sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3) || b.openedAt.localeCompare(a.openedAt));
}

export type CsRow = { clientId: string; client: string; slug: string; replyHours: number | null; waiting: number; quietDays: number | null; sentiment: Sentiment; rank: number };

export async function csBoard(admin: SupabaseClient, now = new Date()): Promise<CsRow[]> {
  const since = new Date(now.getTime() - 28 * DAY).toISOString();
  const [{ data: clients }, { data: team }, owed, chatter] = await Promise.all([
    admin.from("clients").select("id, name, slug").is("archived_at", null).in("status", LIVE),
    admin.from("profiles").select("id, full_name, display_name, email, platform_aliases"),
    pages<{ client_id: string | null; asked_at: string; answered_at: string | null; status: string }>((a, z) => admin.from("owed_replies").select("client_id, asked_at, answered_at, status").gte("asked_at", since).not("status", "eq", "not_needed").order("asked_at").range(a, z), 10_000),
    pages<{ client_id: string; author: string | null; occurred_at: string; body: string | null }>((a, z) => admin.from("context_items").select("client_id, author, occurred_at, body").in("source", ["slack_external", "gmail"]).gte("occurred_at", since).order("occurred_at", { ascending: false }).range(a, z)),
  ]);
  const people = (team ?? []) as { id: string; full_name: string; display_name: string | null; email: string | null; platform_aliases: string[] | null }[];
  const isTeam = (a: string | null) => Boolean(a) && (/@kaizenmarketing\.agency/i.test(a!) || Boolean(matchActor(a!.replace(/<[^>]*>/g, "").trim(), people)));
  const today = nyDay(now);
  const rows: CsRow[] = [];
  for (const c of (clients ?? []) as { id: string; name: string; slug: string }[]) {
    const o = owed.filter((x) => x.client_id === c.id);
    const msgs = chatter.filter((m) => m.client_id === c.id && isHumanAuthor(m.author));
    const lastTeam = msgs.find((m) => isTeam(m.author))?.occurred_at ?? null;
    const quietDays = lastTeam ? Math.max(0, Math.floor((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${nyDay(new Date(lastTeam))}T12:00:00Z`)) / DAY)) : null;
    const s = sentiment(msgs.filter((m) => !isTeam(m.author)).map((m) => ({ at: m.occurred_at, text: m.body })), now.getTime());
    const row = { clientId: c.id, client: c.name, slug: c.slug, replyHours: medianReplyHours(o), waiting: o.filter((x) => ["watching", "nudged", "escalated"].includes(x.status)).length, quietDays, sentiment: s, rank: 0 };
    row.rank = csRank(row);
    rows.push(row);
  }
  return rows.sort((a, b) => b.rank - a.rank || a.client.localeCompare(b.client));
}

export type OnboardRow = { clientId: string; client: string; slug: string; state: OnboardingState };

export async function onboardingBoard(admin: SupabaseClient, now = new Date()): Promise<OnboardRow[]> {
  const { data: clients } = await admin.from("clients").select("id, name, slug, created_at, reonboarded_at, services, services_extra, services_removed").is("archived_at", null).eq("status", "onboarding");
  const list = (clients ?? []) as { id: string; name: string; slug: string; created_at: string; reonboarded_at: string | null; services: string[] | null; services_extra: string[] | null; services_removed: string[] | null }[];
  if (!list.length) return [];
  const ids = list.map((c) => c.id);
  const [{ data: forms }, { data: onboard }, { data: targets }, { data: team }, { data: msgs }] = await Promise.all([
    admin.from("client_intake_forms").select("client_id, submitted_at").in("client_id", ids),
    admin.from("client_onboarding").select("client_id, assets").in("client_id", ids),
    admin.from("kpi_targets").select("client_id, platform").in("client_id", ids).eq("active", true).not("ad_account_id", "is", null),
    admin.from("profiles").select("id, full_name, display_name, email, platform_aliases"),
    admin.from("context_items").select("client_id, author, occurred_at").in("client_id", ids).eq("source", "slack_external").gte("occurred_at", new Date(now.getTime() - 45 * DAY).toISOString()).order("occurred_at", { ascending: false }).limit(1000),
  ]);
  const people = (team ?? []) as { id: string; full_name: string; display_name: string | null; email: string | null; platform_aliases: string[] | null }[];
  const today = nyDay(now);
  const rows: OnboardRow[] = list.map((c) => {
    const svc = servicesOf(c);
    const needsAccess = svc.includes("facebook-ads") || svc.includes("google-ads");
    const assets = (onboard ?? []).find((o) => o.client_id === c.id)?.assets;
    const lastCheckIn = (msgs ?? []).find((m) => m.client_id === c.id && isHumanAuthor(m.author as string) && (/@kaizenmarketing\.agency/i.test(String(m.author)) || Boolean(matchActor(String(m.author), people))))?.occurred_at ?? null;
    return {
      clientId: c.id,
      client: c.name,
      slug: c.slug,
      state: onboardingState({
        createdAt: (c.reonboarded_at ?? c.created_at).slice(0, 10),
        today,
        intakeAt: ((forms ?? []).find((f) => f.client_id === c.id)?.submitted_at as string | null) ?? null,
        assets: Boolean(assets && typeof assets === "object" && Object.keys(assets as object).length),
        needsAccess,
        access: (targets ?? []).some((t) => t.client_id === c.id),
        lastCheckIn: lastCheckIn ? nyDay(new Date(lastCheckIn as string)) : null,
      }),
    };
  });
  return rows.sort((a, b) => Number(b.state.stuck) - Number(a.state.stuck) || b.state.blockers.length - a.state.blockers.length || b.state.daysIn - a.state.daysIn);
}
