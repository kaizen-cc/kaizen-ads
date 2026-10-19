import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/email";

// Notifications are made by the database where things happen (see the notifications migration). This file reads
// them for the bell, reminds people who haven't been through their daily recap, and emails the critical ones that
// sit unread.

export type Notice = { id: string; kind: string; title: string; body: string | null; href: string | null; priority: "critical" | "normal"; createdAt: string; read: boolean; actor: string | null };

export async function loadNotifications(db: SupabaseClient, limit = 40): Promise<{ items: Notice[]; unread: number }> {
  const [{ data }, { count }] = await Promise.all([
    db.from("notifications").select("id, kind, title, body, href, priority, created_at, read_at, actor:profiles!notifications_actor_id_fkey(full_name)").order("created_at", { ascending: false }).limit(limit),
    db.from("notifications").select("id", { count: "exact", head: true }).is("read_at", null),
  ]);
  return {
    unread: count ?? 0,
    items: (data ?? []).map((n) => ({
      id: n.id as string,
      kind: n.kind as string,
      title: n.title as string,
      body: (n.body as string | null) ?? null,
      href: (n.href as string | null) ?? null,
      priority: n.priority as Notice["priority"],
      createdAt: n.created_at as string,
      read: Boolean(n.read_at),
      actor: (n.actor as unknown as { full_name: string } | null)?.full_name ?? null,
    })),
  };
}

const nyToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

/** Late morning and mid-afternoon on weekdays: a nudge for anyone who hasn't been through today's recap. */
export async function remindRecaps(admin: SupabaseClient) {
  const today = nyToday();
  const hour = Number(new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }));
  const { data: people } = await admin.from("profiles").select("id, recap_seen_on").eq("is_active", true).not("joined_at", "is", null);
  const due = (people ?? []).filter((p) => p.recap_seen_on !== today);
  for (const p of due) {
    await admin.from("notifications").upsert(
      {
        profile_id: p.id,
        kind: "recap",
        title: hour < 13 ? "Your day is ready" : "You haven't been through today's recap yet",
        body: hour < 13 ? "What's critical across your clients today, most urgent first. A few minutes, one card at a time." : "Anything critical you haven't seen is still waiting. Save what can wait for tomorrow.",
        href: "/today",
        key: `recap:${today}:${hour < 13 ? "am" : "pm"}`,
        priority: "normal",
      },
      { onConflict: "profile_id,key", ignoreDuplicates: true },
    );
  }
  return { reminded: due.length };
}

/** Critical notifications still unread after a few minutes go out by email too, once. */
export async function emailCritical(admin: SupabaseClient) {
  const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
  const { data } = await admin
    .from("notifications")
    .select("id, title, body, href, profiles!notifications_profile_id_fkey(email, full_name)")
    .eq("priority", "critical")
    .is("read_at", null)
    .is("emailed_at", null)
    .lte("created_at", cutoff)
    .gte("created_at", new Date(Date.now() - 24 * 3_600_000).toISOString())
    .limit(50);
  const base = process.env.NEXT_PUBLIC_SITE_URL || "https://ads.kaizenmarketing.agency";
  let sent = 0;
  for (const n of data ?? []) {
    const p = n.profiles as unknown as { email: string | null; full_name: string } | null;
    if (!p?.email) continue;
    const link = n.href ? (n.href.startsWith("http") ? n.href : `${base}${n.href}`) : base;
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const r = await sendEmail({
      to: p.email,
      subject: n.title as string,
      text: `${n.title}\n\n${n.body ?? ""}\n\nOpen it: ${link}`,
      html: `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#17131a"><p style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#c8102e;margin:0 0 8px">Kaizen Ads</p><h1 style="font-size:20px;line-height:1.3;margin:0 0 10px">${esc(n.title as string)}</h1>${n.body ? `<p style="font-size:15px;line-height:1.55;color:#4d464f;margin:0 0 20px">${esc(n.body as string)}</p>` : ""}<a href="${link}" style="display:inline-block;background:#c8102e;color:#fff;text-decoration:none;padding:12px 20px;border-radius:999px;font-size:14px;font-weight:600">Open it</a></div>`,
    });
    // Marked either way, so a failing address doesn't retry forever
    await admin.from("notifications").update({ emailed_at: new Date().toISOString() }).eq("id", n.id);
    if (r.ok) sent++;
  }
  return { sent };
}
