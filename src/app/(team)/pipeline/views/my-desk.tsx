import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

/**
 * Emails to clients drafted for the person (from calls, notes, Slack and email) and their to-dos from the executives'
 * account review are items in their Needs me now (src/lib/today.ts withDesk), never a section of their own. This only
 * keeps the daily read: once a day the person's clients are read again for new emails to draft, in the background.
 */
export async function MyDesk({ db, me }: { db: SupabaseClient; me: Staff }) {
  void db;
  // Never while the owner views as them (lib/view-as-core.ts): nothing is done for a real person
  if (adminConfigured() && !me.viewAs) {
    after(async () => {
      const admin = createAdminClient();
      const { scannedRecently, scanForPerson } = await import("@/lib/email-drafts/server");
      if (await scannedRecently(admin, me.id).catch(() => true)) return;
      await scanForPerson(admin, me, { max: 10 }).catch((e) => console.error("[email drafts] daily scan", e instanceof Error ? e.message : e));
    });
  }
  return null;
}
