import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { bodyKeepDays } from "./workspace-retention-core";

/**
 * The daily trim (cron step workspace_retention): email bodies past the window cut to their gist, and the copies of
 * emails kept on owed replies dropped a month after they were answered or dismissed. Nothing is deleted outright: the
 * rows, dates, senders, subjects and gists stay, so history and counts read the same.
 */
export async function trimWorkspaceData(admin: SupabaseClient) {
  const keep = bodyKeepDays();
  const { data, error } = await admin.rpc("trim_workspace_bodies", {
    p_keep_days: keep,
    p_batch: 5000,
  });
  if (error) throw new Error(`trim_workspace_bodies: ${error.message}`);
  return { keep_days: keep, ...(data as Record<string, number>) };
}
