import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// The Client Success Coordinator's extra boards (the owner's brief, Nov 20 2026): reports not sent across the
// company, by owner and client, and every client Slack channel's unanswered messages (from the owed-replies data).

const DAY = 86_400_000;
const todayNY = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

export type NotSent = { id: string; client: string; slug: string; owner: string; label: string; daysLate: number };

/** Reports 3 or more days past their period with nothing sent, oldest first */
export async function reportsNotSent(admin: SupabaseClient): Promise<NotSent[]> {
  const cutoff = new Date(Date.now() - 3 * DAY).toISOString().slice(0, 10);
  const { data } = await admin
    .from("reports")
    .select("id, kind, platform, period_end, clients!inner(name, slug, archived_at), owner:profiles!reports_owner_id_fkey(full_name)")
    .in("status", ["draft", "submitted"])
    .is("hidden_at", null)
    .is("clients.archived_at", null)
    .lte("period_end", cutoff)
    .order("period_end")
    .limit(300);
  const today = Date.parse(`${todayNY()}T12:00:00Z`);
  return ((data ?? []) as unknown as { id: string; kind: string; platform: string; period_end: string; clients: { name: string; slug: string }; owner: { full_name: string } | null }[]).map((r) => ({
    id: r.id,
    client: r.clients.name,
    slug: r.clients.slug,
    owner: r.owner?.full_name ?? "Nobody owns it",
    label: `${r.platform} ${r.kind}, period ended ${r.period_end}`,
    daysLate: Math.max(0, Math.round((today - Date.parse(`${r.period_end}T12:00:00Z`)) / DAY)),
  }));
}

export type Channel = { channel: string; client: string | null; oldestHours: number; messages: { id: string; from: string; gist: string; hours: number; owes: string; url: string | null }[] };

/** Every client Slack channel with messages waiting on us, the longest wait first */
export async function channelHealth(admin: SupabaseClient): Promise<Channel[]> {
  const { data } = await admin
    .from("owed_replies")
    .select("id, channel_name, from_name, gist, body, asked_at, url, from_team, clients(name, archived_at), target:profiles!owed_replies_target_id_fkey(full_name)")
    .eq("source", "slack")
    .eq("from_team", false)
    .in("status", ["watching", "nudged", "escalated"])
    .order("asked_at")
    .limit(500);
  const now = Date.now();
  const by = new Map<string, Channel>();
  for (const o of (data ?? []) as unknown as { id: string; channel_name: string | null; from_name: string; gist: string | null; body: string | null; asked_at: string; url: string | null; clients: { name: string; archived_at: string | null } | null; target: { full_name: string } | null }[]) {
    if (o.clients?.archived_at) continue;
    const ch = o.channel_name ?? "unknown";
    const c = by.get(ch) ?? { channel: ch, client: o.clients?.name ?? null, oldestHours: 0, messages: [] };
    const hours = (now - Date.parse(o.asked_at)) / 3_600_000;
    c.messages.push({ id: o.id, from: o.from_name, gist: (o.gist ?? o.body ?? "").replace(/\s+/g, " ").slice(0, 140), hours, owes: o.target?.full_name ?? "nobody yet", url: o.url });
    c.oldestHours = Math.max(c.oldestHours, hours);
    by.set(ch, c);
  }
  return [...by.values()].sort((a, b) => b.oldestHours - a.oldestHours);
}
