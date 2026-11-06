import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/email";
import { openableLink } from "@/lib/context/slack";
import { noticeItem, noticeLink, replyAddress } from "@/lib/notice-links";

// Notifications are made by the database where things happen (see the notifications migration). This file reads
// them for the bell, reminds people who haven't been through their daily recap, and emails the critical ones that
// sit unread.

export type Notice = { id: string; kind: string; title: string; body: string | null; href: string | null; priority: "critical" | "normal"; createdAt: string; read: boolean; actor: string | null; key: string | null };

/**
 * Alerts the creative team can't act on: accounts off target, optimization sprints and connections are the buyers' and
 * execs'. They're left off a designer's, editor's or the Head of Creative's bell (still on record, as every notice is).
 */
export const NOT_FOR_CREATIVE = ["kpi", "sprint", "connection"];

export async function loadNotifications(db: SupabaseClient, limit = 40, opts: { skipKinds?: string[] } = {}): Promise<{ items: Notice[]; unread: number }> {
  const skip = opts.skipKinds?.length ? `(${opts.skipKinds.join(",")})` : null;
  let list = db.from("notifications").select("id, kind, title, body, href, priority, created_at, read_at, key, actor:profiles!notifications_actor_id_fkey(full_name)").eq("alert", true).is("cleared_at", null);
  let unread = db.from("notifications").select("id", { count: "exact", head: true }).eq("alert", true).is("read_at", null).is("cleared_at", null);
  if (skip) {
    list = list.not("kind", "in", skip);
    unread = unread.not("kind", "in", skip);
  }
  const [{ data }, { count }] = await Promise.all([
    // Only alerts: something on this person to act on. Updates are kept but left to the daily review and the Overview
    list.order("created_at", { ascending: false }).limit(limit),
    unread,
  ]);
  // Slack links get our workspace's address, so a click opens the message itself
  const hrefs = await Promise.all((data ?? []).map((n) => openableLink((n.href as string | null) ?? null)));
  return {
    unread: count ?? 0,
    items: (data ?? []).map((n, i) => ({
      id: n.id as string,
      kind: n.kind as string,
      title: n.title as string,
      body: (n.body as string | null) ?? null,
      href: hrefs[i],
      priority: n.priority as Notice["priority"],
      createdAt: n.created_at as string,
      read: Boolean(n.read_at),
      actor: (n.actor as unknown as { full_name: string } | null)?.full_name ?? null,
      key: (n.key as string | null) ?? null,
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
  { key: "leadership", label: "Across the agency", about: "New clients starting, first rounds ready for review, and connections about to stop working", managersOnly: true },
  { key: "recap", label: "Daily recap reminders", about: "A nudge at 11am and 3pm if you haven't been through today's recap" },
];
export const KIND_GROUP: Record<string, GroupKey> = { assigned: "on_you", contradiction: "on_you", handoff: "on_you", reply: "on_you", client: "on_you", ticket: "work", promise: "clients", fatigue: "clients", kpi: "clients", sprint: "clients", onboarding: "leadership", newclient: "leadership", connection: "leadership", recap: "recap" };

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
    .select("id, profile_id, kind, title, body, href, priority, key, profiles!notifications_profile_id_fkey(email, full_name)")
    .is("read_at", null)
    .is("cleared_at", null)
    .is("emailed_at", null)
    // Alerts only: updates never email
    .eq("alert", true)
    .lte("created_at", cutoff)
    .gte("created_at", new Date(Date.now() - 24 * 3_600_000).toISOString())
    .order("created_at")
    .limit(300);
  if (!data?.length) return { sent: 0 };
  const ids = [...new Set(data.map((n) => n.profile_id as string))];
  const { data: prefs } = await admin.from("notification_prefs").select("profile_id, settings").in("profile_id", ids);
  const prefOf = (id: string) => withDefaults(prefs?.find((p) => p.profile_id === id)?.settings);
  const base = process.env.NEXT_PUBLIC_SITE_URL || "https://ads.kaizenmarketing.agency";
  const opened = new Map(await Promise.all(data.map(async (n) => [n.id as string, await openableLink((n.href as string | null) ?? null)] as const)));
  for (const n of data) n.href = opened.get(n.id as string) ?? n.href;
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
      // A promise or an unanswered message: two buttons to close it from here, signed for this person and this item
      const actions = (n: (typeof send)[number]) => {
        const item = noticeItem(n.key as string | null);
        if (!item) return null;
        try {
          return { done: noticeLink(base, { ...item, profileId: id }, "done"), context: noticeLink(base, { ...item, profileId: id }, "context") };
        } catch {
          return null;
        }
      };
      const rows = send
        .map((n) => {
          const a = actions(n);
          const buttons = a
            ? `<div style="padding:0 0 14px"><a href="${a.done}" style="display:inline-block;margin:0 8px 0 0;padding:9px 14px;border-radius:5px;background:#17131a;color:#ffffff;font-size:13px;font-weight:600;text-decoration:none">It's handled</a><a href="${a.context}" style="display:inline-block;padding:8px 13px;border-radius:5px;border:1px solid #d9d4d6;color:#17131a;font-size:13px;text-decoration:none">Add context</a></div>`
            : "";
          return `<div style="border-top:1px solid #eee"><a href="${linkOf(n.href as string | null)}" style="display:block;text-decoration:none;color:#17131a;padding:14px 0 ${a ? "10px" : "14px"}"><span style="font-size:15px;font-weight:600">${n.priority === "critical" ? '<span style="color:#c8102e">● </span>' : ""}${esc(n.title as string)}</span>${n.body ? `<br><span style="font-size:13px;color:#6b6470">${esc(n.body as string)}</span>` : ""}</a>${buttons}</div>`;
        })
        .join("");
      // One promise or message in the email: a reply to it is read as context (when receiving is set up)
      const item = one ? noticeItem(one.key as string | null) : null;
      let replyTo: string | undefined;
      try {
        replyTo = item ? (replyAddress(item.kind, item.id) ?? undefined) : undefined;
      } catch {
        replyTo = undefined;
      }
      const r = await sendEmail({
        to: p.email,
        subject,
        replyTo,
        text: send
          .map((n) => {
            const a = actions(n);
            return `${n.title}\n${n.body ?? ""}\n${linkOf(n.href as string | null)}${a ? `\nIt's handled: ${a.done}\nAdd context: ${a.context}` : ""}`;
          })
          .join("\n\n"),
        html: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#17131a"><p style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#c8102e;margin:0 0 14px">Kaizen Ads</p>${rows}${replyTo ? `<p style="font-size:12px;color:#8a8189;margin-top:16px">Or reply to this email with what happened: it's read, and closes this if it's handled.</p>` : ""}<p style="font-size:12px;color:#8a8189;margin-top:20px">Change what you get by email in Kaizen Ads: Notifications → Settings.</p></div>`,
      });
      if (r.ok) sent++;
    }
    // Each looked at once, sent or not (a group set to no email doesn't come back next run)
    await admin.from("notifications").update({ emailed_at: new Date().toISOString() }).in("id", mine.map((n) => n.id as string));
  }
  return { sent };
}
