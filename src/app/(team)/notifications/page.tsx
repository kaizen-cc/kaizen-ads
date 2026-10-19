import type { Metadata } from "next";
import { requireStaff } from "@/lib/auth";
import { GROUPS, withDefaults } from "@/lib/notifications";
import { createClient } from "@/lib/supabase/server";
import { NoticeSettings } from "./notice-settings";

export const metadata: Metadata = { title: "Notifications" };

/** Each person's notification settings: per group, in the app and by email; and pop-ups for critical ones. */
export default async function NotificationsPage() {
  const me = await requireStaff();
  const db = await createClient();
  const { data } = await db.from("notification_prefs").select("settings").eq("profile_id", me.id).maybeSingle();
  const groups = GROUPS.filter((g) => !g.managersOnly || me.isExec || me.isLead).map(({ key, label, about }) => ({ key, label, about }));
  return (
    <div className="mx-auto grid max-w-3xl gap-8">
      <header className="grid gap-1.5">
        <p className="text-xs uppercase tracking-[0.18em] text-faint">Settings</p>
        <h1 className="font-display text-3xl tracking-tight md:text-4xl">Notifications</h1>
        <p className="max-w-xl text-sm text-muted">Choose what reaches you and how. Changes save as you make them. Email goes out only for what&apos;s still unread a few minutes after it arrives, in one short note.</p>
      </header>
      <NoticeSettings initial={withDefaults(data?.settings)} groups={groups} email={me.email ?? null} />
    </div>
  );
}
