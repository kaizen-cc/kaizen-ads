"use server";

import { requireStaff } from "@/lib/auth";
import { loadSegmentReport } from "@/lib/klaviyo/segments";
import type { SegmentReport } from "@/lib/klaviyo/segments-core";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Segment performance for one client's email account: first a check through the person's own session (so only a client
// they can open), then the numbers, with the similar clients' patterns read with the server's rights (aggregated, never named).

export async function segmentReportFor(clientId: string, days = 90): Promise<{ ok: true; report: SegmentReport | null } | { ok: false; error: string }> {
  await requireStaff();
  const db = await createClient();
  const { data: c } = await db.from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!c) return { ok: false, error: "You don't work on this client." };
  const window = days === 30 || days === 120 ? days : 90;
  try {
    const admin = adminConfigured() ? createAdminClient() : null;
    return { ok: true, report: await loadSegmentReport(admin ?? db, clientId, { days: window, peerDb: admin }) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't read the segments." };
  }
}
