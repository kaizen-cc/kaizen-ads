import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toSocialAllotment, type SocialAllotment, type SocialAllotmentRow } from "./social-allotment-core";

// Each client's social allotment this billing cycle, from the database view client_social_allotment (its rule:
// src/lib/social-allotment-core.ts). Pass a person's session (RLS limits it to their clients) or the server client for
// every client. Never throws: before the migration it reads as none.

export async function socialAllotments(db: SupabaseClient, clientIds?: string[]): Promise<Record<string, SocialAllotment>> {
  let q = db.from("client_social_allotment").select("*");
  if (clientIds?.length) q = q.in("client_id", clientIds);
  const { data, error } = await q;
  if (error) return {};
  const out: Record<string, SocialAllotment> = {};
  for (const r of (data ?? []) as SocialAllotmentRow[]) out[r.client_id] = toSocialAllotment(r);
  return out;
}
