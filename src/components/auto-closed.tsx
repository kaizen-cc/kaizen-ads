import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { recentAutoClosed } from "@/lib/done-check";
import { AutoClosedList } from "./auto-closed-list";

// What closed itself lately on this person's day (Slack, Gmail or call notes showed it done), each with its quote and a
// one-tap Reopen. Rendering also checks, in the background, any item of theirs not checked for an hour.

const CHECKABLE = /^(notrack|dog|ask|onboard|stuck|mine:asana):/;

export async function AutoClosed({ db, me }: { db: SupabaseClient; me: Staff }) {
  const items = await recentAutoClosed(db, { id: me.id, role: me.role, isExec: me.isExec }).catch(() => []);
  // Non-blocking: their own open items not checked for an hour are checked after the page is sent
  if (!me.viewAs)
    after(async () => {
      const { todaySnapshot } = await import("@/lib/today-snapshot");
      const keys = (await todaySnapshot(db, me).catch(() => null))?.today.items.map((i) => i.key).filter((k) => CHECKABLE.test(k)) ?? [];
      if (!keys.length) return;
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const admin = createAdminClient();
      const { data } = await admin.from("done_checks").select("key, checked_at").in("key", keys);
      const fresh = new Set((data ?? []).filter((r) => r.checked_at && Date.now() - Date.parse(r.checked_at as string) < 3_600_000).map((r) => r.key as string));
      const stale = keys.filter((k) => !fresh.has(k));
      if (stale.length) await (await import("@/lib/done-check")).runDoneChecks(admin, { onlyKeys: stale, budget: 4 }).catch(() => null);
    });
  if (!items.length) return null;
  return <AutoClosedList items={items} />;
}
