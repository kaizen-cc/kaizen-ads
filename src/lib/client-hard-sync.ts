import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { refreshClientKpis } from "@/lib/kpi/sync";
import { metaConfigured, syncClientMeta } from "@/lib/context/meta";
import { readChannel, slackConfigured } from "@/lib/context/slack";
import { collectDrive, collectGmail, gmailMailboxes, googleConfigured } from "@/lib/context/google";
import { getCursor, saveItems, setCursor } from "@/lib/context/shared";
import { pool } from "@/lib/context/run";
import { runFatigue } from "@/lib/fatigue";
import { refreshBriefing } from "@/lib/context/briefing";

// A client back from a pause or the archive: everything about them is read again now, from the day they went quiet,
// instead of whenever each scheduled sync gets to them. While they were away the regular syncs skipped them (and moved
// on: the mailboxes' and Drive's places are shared by every client), so this reads their part directly: the ad
// accounts (numbers, campaigns, ads, activity), both Slack channels, every mailbox for mail with their contacts,
// their Drive folder in full, then the fatigue watch and the briefing on top of all of it.

const MAX_BACK = 120; // days: a long absence reads the last four months, enough to know where things stood

/** One part of the sync, given its time; a part that fails or runs long is noted and the rest carry on. */
async function part(out: Record<string, string>, name: string, ms: number, run: () => Promise<unknown>) {
  try {
    await Promise.race([run(), new Promise((_, no) => setTimeout(() => no(new Error("took too long; the next scheduled sync finishes it")), ms))]);
    out[name] = "done";
  } catch (e) {
    out[name] = (e instanceof Error ? e.message : String(e)).slice(0, 200);
  }
}

export async function hardSyncClient(admin: SupabaseClient, clientId: string, awaySince: Date | null) {
  const floor = new Date(Date.now() - MAX_BACK * 86_400_000);
  const since = awaySince && awaySince > floor ? new Date(awaySince.getTime() - 14 * 86_400_000) : floor;
  const { data: c } = await admin.from("clients").select("meta_ad_account_id, slack_channel_id, internal_slack_channel_id, drive_folder_id").eq("id", clientId).maybeSingle();
  if (!c) return {};
  const out: Record<string, string> = {};

  // The ad accounts first: fresh numbers are what everything after reads
  await part(out, "kpis", 240_000, () => refreshClientKpis(admin, clientId, true));
  await Promise.all([
    c.meta_ad_account_id && metaConfigured() ? part(out, "meta ads", 240_000, () => syncClientMeta(admin, clientId, c.meta_ad_account_id!)) : null,
    slackConfigured()
      ? part(out, "slack", 180_000, async () => {
          for (const [channel, source] of [
            [c.internal_slack_channel_id, "slack_internal"],
            [c.slack_channel_id, "slack_external"],
          ] as const) {
            if (!channel) continue;
            const key = `slack:${channel}`;
            const started = new Date();
            const cursor = await getCursor(admin, key, MAX_BACK);
            await saveItems(admin, await readChannel(channel, cursor < since ? cursor : since, clientId, source));
            await setCursor(admin, key, new Date(started.getTime() - 5 * 60_000), { ok: true, reread: "client back" });
          }
        })
      : null,
    googleConfigured()
      ? part(out, "email", 180_000, async () => {
          const { data: links } = await admin.from("contact_clients").select("contacts(email)").eq("client_id", clientId);
          const contacts = new Map<string, string[]>();
          for (const l of links ?? []) {
            const email = (l.contacts as unknown as { email: string } | null)?.email?.toLowerCase();
            if (email) contacts.set(email, [clientId]);
          }
          if (!contacts.size) return;
          // Every mailbox, for mail with their contacts only; the mailboxes' own places don't move
          await pool(await gmailMailboxes(), 6, async (m) => saveItems(admin, (await collectGmail(m, since, contacts)).items));
        })
      : null,
    googleConfigured() && c.drive_folder_id ? part(out, "drive", 180_000, async () => collectDrive(admin, await getCursor(admin, "drive"), undefined, new Set([c.drive_folder_id!]))) : null,
  ]);
  // On top of everything just read: which ads are wearing out, and the briefing
  await Promise.all([part(out, "fatigue", 120_000, () => runFatigue(admin, [clientId])), part(out, "briefing", 240_000, () => refreshBriefing(admin, clientId, true))]);
  return out;
}
