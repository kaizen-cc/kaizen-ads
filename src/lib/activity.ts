import type { SupabaseClient } from "@supabase/supabase-js";
import { stageInfo } from "@/lib/stages";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// The team's activity record, for execs: when each person was last on, how much they use Kaizen Ads (minutes in use,
// from the heartbeat in src/components/activity-tracker.tsx), and a log of what they did: sign-ins, pages opened,
// every ticket move, review, copy pass and upload (the ticket history), and reports sent.

const DAY = 86_400_000;

/** "6h 20m", "45m" */
export const duration = (minutes: number) => (minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}` : `${minutes}m`);

/** "now" (in the last 3 minutes), "12m ago", "3h ago", "yesterday", "Oct 24" */
export function ago(iso: string | null) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 3 * 60_000) return "now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 20 * 3_600_000) return `${Math.round(ms / 3_600_000)}h ago`;
  if (ms < 2 * DAY) return "yesterday";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
}

const nyDate = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });

/** Monday of this week in New York, as YYYY-MM-DD */
function weekStart() {
  const today = new Date(`${nyDate(new Date())}T12:00:00Z`);
  const back = (today.getUTCDay() + 6) % 7;
  return nyDate(new Date(today.getTime() - back * DAY));
}

type Prof = { id: string; last_active_at?: string | null; last_sign_in_at?: string | null };

/**
 * Each person's usage: last active, last sign-in, the average a week (the last four weeks, or since the record began
 * for them if that's shorter) and this week so far.
 */
export async function usageOf(db: SupabaseClient, people: Prof[]) {
  const since = nyDate(new Date(Date.now() - 28 * DAY));
  const { data } = await db.from("activity_minutes").select("profile_id, day, minutes").gte("day", since);
  const monday = weekStart();
  const out = new Map<string, { lastActive: string | null; lastSignIn: string | null; perWeek: string | null; thisWeek: string | null }>();
  for (const p of people) {
    const rows = (data ?? []).filter((r) => r.profile_id === p.id);
    const total = rows.reduce((n, r) => n + (r.minutes as number), 0);
    const first = rows.map((r) => r.day as string).sort()[0];
    const weeks = first ? Math.min(4, Math.max(1, Math.ceil((Date.now() - new Date(`${first}T12:00:00Z`).getTime() + DAY) / (7 * DAY)))) : 0;
    const week = rows.filter((r) => (r.day as string) >= monday).reduce((n, r) => n + (r.minutes as number), 0);
    out.set(p.id, {
      lastActive: ago(p.last_active_at ?? null),
      lastSignIn: ago(p.last_sign_in_at ?? null),
      perWeek: weeks && total ? duration(Math.round(total / weeks)) : null,
      thisWeek: week ? duration(week) : null,
    });
  }
  return out;
}

export type ActivityEntry = { at: string; kind: "sign_in" | "page" | "click" | "search" | "submit" | "decision" | "ticket" | "report"; what: string; detail: string | null; href: string | null };

const TICKET: Record<string, string> = { review: "Reviewed", copy: "Worked the copy on", upload: "Uploaded files to", created: "Created", priority: "Changed the priority of" };

/** One person's log, newest first, from `before` back `days` days. */
export async function activityLog(db: SupabaseClient, profileId: string, before: Date, days = 7) {
  const from = new Date(before.getTime() - days * DAY).toISOString();
  const to = before.toISOString();
  // What they did with items in their day and on their Overview is private to them: read with the server key (execs only
  // reach this page)
  const own = adminConfigured() ? createAdminClient() : db;
  const [{ data: events }, { data: tickets }, { data: reports }, { data: minutes }, { data: decided }, { data: cleared }] = await Promise.all([
    db.from("activity_events").select("at, kind, path, label").eq("profile_id", profileId).gte("at", from).lt("at", to).order("at", { ascending: false }).limit(3000),
    db
      .from("request_events")
      .select("created_at, kind, from_stage, to_stage, body, requests(number, title, clients(name))")
      .eq("actor_id", profileId)
      .gte("created_at", from)
      .lt("created_at", to)
      .order("created_at", { ascending: false })
      .limit(300),
    db.from("reports").select("id, kind, posted_at, platform, clients(name)").eq("posted_by", profileId).gte("posted_at", from).lt("posted_at", to).limit(100),
    db.from("activity_minutes").select("day, minutes").eq("profile_id", profileId).gte("day", nyDate(new Date(before.getTime() - days * DAY))).lte("day", nyDate(before)),
    own.from("daily_items").select("key, status, snapshot, updated_at").eq("profile_id", profileId).in("status", ["done", "dismissed", "saved"]).gte("updated_at", from).lt("updated_at", to).limit(500),
    own.from("hidden_items").select("key, how, label, href, hidden_at").eq("profile_id", profileId).gte("hidden_at", from).lt("hidden_at", to).limit(500),
  ]);
  const DECIDED: Record<string, string> = { done: "Marked done in their day", dismissed: "Set aside in their day", saved: "Saved for later in their day" };
  const log: ActivityEntry[] = [
    ...(events ?? []).map((e): ActivityEntry => ({
      at: e.at as string,
      kind: e.kind as ActivityEntry["kind"],
      what: e.kind === "sign_in" ? "Signed in" : e.kind === "page" ? `Opened ${e.label ?? e.path}` : String(e.label ?? ""),
      detail: e.kind === "sign_in" ? null : (e.path as string),
      href: e.kind === "sign_in" ? null : (e.path as string),
    })),
    ...(decided ?? []).map((d): ActivityEntry => {
      const s = (d.snapshot ?? {}) as { client?: string; title?: string };
      return { at: d.updated_at as string, kind: "decision", what: `${DECIDED[d.status as string]}: ${[s.client, s.title].filter(Boolean).join(" · ") || d.key}`, detail: null, href: null };
    }),
    ...(cleared ?? []).map((h): ActivityEntry => ({
      at: h.hidden_at as string,
      kind: "decision",
      what: `${h.how === "done" ? "Marked done" : "Dismissed"} on their Overview: ${h.label ?? h.key}`,
      detail: null,
      href: (h.href as string | null) ?? null,
    })),
    ...(tickets ?? []).map((t): ActivityEntry => {
      const r = t.requests as unknown as { number: number; title: string; clients: { name: string } | null } | null;
      const ticket = r ? `#${r.number} ${r.title}${r.clients ? ` (${r.clients.name})` : ""}` : "a ticket";
      const what =
        t.kind === "stage"
          ? `Moved ${ticket} to ${stageInfo(t.to_stage as never)?.label ?? t.to_stage}`
          : `${TICKET[t.kind as string] ?? "Updated"} ${ticket}`;
      return { at: t.created_at as string, kind: "ticket", what, detail: t.body ? String(t.body).replace(/\s+/g, " ").slice(0, 180) : null, href: r ? `/board?t=${r.number}` : null };
    }),
    ...(reports ?? []).map((r): ActivityEntry => ({
      at: r.posted_at as string,
      kind: "report",
      what: `Sent the ${r.kind === "custom" ? "on-demand" : r.kind} ${r.platform === "google" ? "Google" : "Meta"} report for ${(r.clients as unknown as { name: string } | null)?.name ?? "a client"}`,
      detail: null,
      href: `/reports/${r.id}`,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const perDay = new Map((minutes ?? []).map((m) => [m.day as string, m.minutes as number]));
  return { log, perDay };
}
