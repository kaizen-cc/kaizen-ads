"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { folderIdOf } from "@/lib/creative-drive-paths";
import type { ClientDriveSummary } from "@/lib/creative-drive";

type Fail = { ok: false; error: string };

/** Whether this person works on the client (RLS decides) */
async function seen(clientId: string) {
  const { data } = await (await createClient()).from("clients").select("id").eq("id", clientId).maybeSingle();
  return Boolean(data);
}

/** The client's creative in Drive at a glance: the Ad Creative folder and how many files are there, on their way, stuck */
export async function adCreativeDrive(clientId: string): Promise<ClientDriveSummary | null> {
  await requireStaff();
  if (!adminConfigured() || !(await seen(clientId))) return null;
  const { clientDriveSummary } = await import("@/lib/creative-drive");
  return clientDriveSummary(createAdminClient(), clientId);
}

/**
 * The Ad Creative folder set by hand (a pasted link), when it isn't found by name in their Drive folder. Anyone on the
 * client can: it's what the ticket's "No Ad Creative folder found" points to. Files that stopped for it go again.
 */
export async function setAdCreativeFolder(clientId: string, slug: string, link: string): Promise<{ ok: true } | Fail> {
  await requireStaff();
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  if (!(await seen(clientId))) return { ok: false, error: "Client not found." };
  const id = link.trim() ? folderIdOf(link) : null;
  if (id && !/^[\w-]{10,}$/.test(id)) return { ok: false, error: "Paste the folder's Drive link." };
  const lib = await import("@/lib/creative-drive");
  if (id) {
    const ok = await lib.checkFolder(id);
    if (!ok.ok) return ok;
  }
  const admin = createAdminClient();
  const { error } = await admin
    .from("clients")
    .update({ ad_creative_folder_id: id, ad_creative_folder_source: id ? "set" : null })
    .eq("id", clientId);
  if (error) return { ok: false, error: error.message };
  await lib.retryErrors(admin, clientId);
  after(() => lib.processDriveQueue(createAdminClient(), { clientId, budgetMs: 240_000 }).then(() => undefined, (e) => console.error("[creative-drive] after folder set", e)));
  revalidatePath(`/clients/${slug}`);
  return { ok: true };
}

/** Execs: every file already on this client's tickets (or every client's) copied into Drive, in the background */
export async function syncExistingToDrive(clientId: string | null): Promise<{ ok: true } | Fail> {
  const me = await requireStaff();
  if (!me.isExec) return { ok: false, error: "Only execs can sync existing files." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const lib = await import("@/lib/creative-drive");
  if (!lib.driveWriteConfigured()) return { ok: false, error: "Drive isn't connected: set GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_DRIVE_USER." };
  // All in the background: every design lined up, the first batch copied now, and the schedule carries on every
  // 10 minutes until the queue is empty
  after(async () => {
    try {
      const admin = createAdminClient();
      await lib.queueBackfill(admin, clientId);
      await lib.processDriveQueue(admin, { clientId: clientId ?? undefined, limit: 150, budgetMs: 540_000 });
    } catch (e) {
      console.error("[creative-drive] backfill", e);
    }
  });
  return { ok: true };
}
