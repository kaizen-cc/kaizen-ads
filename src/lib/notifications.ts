import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/email";

// Notifications are made by the database where things happen (see the notifications migration). This file reads
// them for the bell, reminds people who haven't been through their daily recap, and emails the critical ones that
// sit unread.

export type Notice = { id: string; kind: string; title: string; body: string | null; href: string | null; priority: "critical" | "normal"; createdAt: string; read: boolean; actor: string | null };

export async function loadNotifications(db: SupabaseClient, limit = 40): Promise<{ items: Notice[]; unread: number }> {
  const [{ data }, { count }] = await Promise.all([
    db.from("notifications").select("id, kind, title, body, href, priority, created_at, read_at, actor:profiles!notifications_actor_id_fkey(full_name)").is("cleared_at", null).order("created_at", { ascending: false }).limit(limit),
    db.from("notifications").select("id", { count: "exact", head: true }).is("read_at", null).is("cleared_at", null),
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

// ─── Settings ───────────────────────────────────────────────────────────────

export type GroupKey = "on_you" | "work" | "clients" | "leadership" | "recap";
export type EmailMode = "off" | "critical" | "all";
export type NoticePrefs = { groups: Record<GroupKey, { app: boolean; email: EmailMode }>; popups: boolean };

export const GROUPS: { key: GroupKey; label: string; about: string; managersOnly?: boolean }[] = [
  { key: "on_you", label: "Assigned to you", about: "Tickets and Asana tasks put on you, clients you're added to, handoffs, messages you haven't replied to" },
  { key: "work", label: "Your work", about: "Tickets you're on moving, comments, reviews, new copy and uploads, client changes" },
  { key: "clients", label: "Your clients", about: "Promises made on calls, ads worn out, accounts going off target, sprint check-ins" },
  { key: "leadership", label: "Across the agency", about: "New clients starting and first rounds ready for review", managersOnly: true },
  { key: "recap", label: "Daily recap reminders", about: "A nudge at 11am and 3pm if you haven't been through today's recap" },
];
export const KIND_GROUP: Record<string, GroupKey> = { assigned: "on_you", handoff: "on_you", reply: "on_you", client: "on_you", ticket: "work", promise: "clients", fatigue: "clients", kpi: "clients", sprint: "clients", onboarding: "leadership", newclient: "leadership", recap: "recap" };

export const DEFAULT_PREFS: NoticePrefs = {
  groups: {
    on_you: { app: true, email: "critical" },
    work: { app: true, email: "critical" },
    clients: { app: true, email: "critical" },
    leadership: { app: true, email: "critical" },
    recap: { app: true, email: "off" },
  },
  popups: true,
};

/** Someone's settings over the defaults (a group they never touched keeps its default). */
export function withDefaults(raw: unknown): NoticePrefs {
  const r = (raw ?? {}) as Partial<NoticePrefs>;
  const groups = { ...DEFAULT_PREFS.groups };
  for (const g of Object.keys(groups) as GroupKey[]) groups[g] = { ...groups[g], ...(r.groups?.[g] ?? {}) };
  return { groups, popups: r.popups ?? DEFAULT_PREFS.popups };
}

const nyToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

/** Late morning and mid-afternoon on weekdays: a nudge for anyone who hasn't been through today's recap. */
export async function remindRecaps(admin: SupabaseClient) {
  const today = nyToday();
  const hour = Number(new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }));
  const [{ data: people }, { data: prefs }] = await Promise.all([
    admin.from("profiles").select("id, recap_seen_on").eq("is_active", true).not("joined_at", "is", null),
    admin.from("notification_prefs").select("profile_id, settings"),
  ]);
  const off = new Set((prefs ?? []).filter((p) => !withDefaults(p.settings).groups.recap.app).map((p) => p.profile_id as string));
  const due = (people ?? []).filter((p) => p.recap_seen_on !== today && !off.has(p.id as string));
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

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Every 10 minutes: notifications still unread a few minutes after they arrived go out by email, by each person's
 * settings (critical only by default, everything, or nothing, per group). One email per person per run, so a busy
 * stretch is a short list rather than a flood. Each notification is looked at once.
 */
export async function emailNotifications(admin: SupabaseClient) {
  const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
  const { data } = await admin
    .from("notifications")
    .select("id, profile_id, kind, title, body, href, priority, profiles!notifications_profile_id_fkey(email, full_name)")
    .is("read_at", null)
    .is("cleared_at", null)
    .is("emailed_at", null)
    .lte("created_at", cutoff)
    .gte("created_at", new Date(Date.now() - 24 * 3_600_000).toISOString())
    .order("created_at")
    .limit(300);
  if (!data?.length) return { sent: 0 };
  const ids = [...new Set(data.map((n) => n.profile_id as string))];
  const { data: prefs } = await admin.from("notification_prefs").select("profile_id, settings").in("profile_id", ids);
  const prefOf = (id: string) => withDefaults(prefs?.find((p) => p.profile_id === id)?.settings);
  const base = process.env.NEXT_PUBLIC_SITE_URL || "https://ads.kaizenmarketing.agency";
  const linkOf = (href: string | null) => (href ? (href.startsWith("http") ? href : `${base}${href}`) : base);
  let sent = 0;
  for (const id of ids) {
    const mine = data.filter((n) => n.profile_id === id);
    const pref = prefOf(id);
    const send = mine.filter((n) => {
      const mode = pref.groups[KIND_GROUP[n.kind as string] ?? "work"].email;
      return mode === "all" || (mode === "critical" && n.priority === "critical");
    });
    const p = mine[0].profiles as unknown as { email: string | null; full_name: string } | null;
    if (send.length && p?.email) {
      const one = send.length === 1 ? send[0] : null;
      const subject = one ? (one.title as string) : `${send.length} updates in Kaizen Ads${send.some((n) => n.priority === "critical") ? ", including something critical" : ""}`;
      const rows = send
        .map(
          (n) =>
            `<a href="${linkOf(n.href as string | null)}" style="display:block;text-decoration:none;color:#17131a;padding:14px 0;border-top:1px solid #eee"><span style="font-size:15px;font-weight:600">${n.priority === "critical" ? '<span style="color:#c8102e">● </span>' : ""}${esc(n.title as string)}</span>${n.body ? `<br><span style="font-size:13px;color:#6b6470">${esc(n.body as string)}</span>` : ""}</a>`,
        )
        .join("");
      const r = await sendEmail({
        to: p.email,
        subject,
        text: send.map((n) => `${n.title}\n${n.body ?? ""}\n${linkOf(n.href as string | null)}`).join("\n\n"),
        html: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#17131a"><p style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#c8102e;margin:0 0 14px">Kaizen Ads</p>${rows}<p style="font-size:12px;color:#8a8189;margin-top:20px">Change what you get by email in Kaizen Ads: Notifications → Settings.</p></div>`,
      });
      if (r.ok) sent++;
    }
    // Each looked at once, sent or not (a group set to no email doesn't come back next run)
    await admin.from("notifications").update({ emailed_at: new Date().toISOString() }).in("id", mine.map((n) => n.id as string));
  }
  return { sent };
}
