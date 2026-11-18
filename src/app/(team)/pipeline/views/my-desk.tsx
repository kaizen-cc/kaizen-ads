import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { myReviewTodos } from "@/lib/csuite/load";
import { myDrafts } from "@/lib/email-drafts/server";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { EmailsReady, ReviewTodos } from "./emails-ready";

/**
 * On everyone's Overview, under the recap: emails to clients drafted for them from calls, notes, Slack and email
 * ("Emails ready to send"), and to-dos assigned to them in the executives' account review. Nothing shows when there's
 * nothing. Once a day the person's clients are read again for new emails in the background.
 */
export async function MyDesk({ db, me }: { db: SupabaseClient; me: Staff }) {
  const [drafts, todos] = await Promise.all([myDrafts(db, me.id).catch(() => []), myReviewTodos(db, me.id).catch(() => [])]);
  if (adminConfigured()) {
    after(async () => {
      const admin = createAdminClient();
      const { scannedRecently, scanForPerson } = await import("@/lib/email-drafts/server");
      if (await scannedRecently(admin, me.id).catch(() => true)) return;
      await scanForPerson(admin, me, { max: 10 }).catch((e) => console.error("[email drafts] daily scan", e instanceof Error ? e.message : e));
    });
  }
  if (!drafts.length && !todos.length) return null;
  return (
    <div className="grid gap-4">
      {todos.length > 0 && <ReviewTodos todos={todos.map((t) => ({ id: t.id, title: t.title, due: t.due_on, client: t.client?.name ?? null }))} />}
      {drafts.length > 0 && (
        <EmailsReady
          drafts={drafts.map((d) => ({ id: d.id, client: d.clients?.name ?? "A client", kind: d.kind, subject: d.subject, body: d.body, to: d.to_emails ?? [], reason: d.reason, opened: d.status === "opened" }))}
        />
      )}
    </div>
  );
}
