"use server";

import { requireStaff } from "@/lib/auth";
import { locationBreakdown, locationWindow, type LocationBreakdown, type LocationRange, isLocationRange } from "@/lib/klaviyo/locations";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// The location breakdown inside an opened account on the Email board, for the dates picked: read when the sheet opens.
// The rows and campaigns come through the person's session (only clients they can see); the connection's setting is
// read with the server's rights, since the connection row holds the encrypted key.

const todayET = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const etDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

export async function loadLocationBreakdown(clientId: string, range: LocationRange): Promise<{ ok: true; flagged: false } | { ok: true; flagged: true; breakdown: LocationBreakdown | null; window: { start: string; end: string }; currency: string | null } | { ok: false; error: string }> {
  await requireStaff();
  if (!adminConfigured()) return { ok: true, flagged: false };
  const db = await createClient();
  const { data: mine } = await db.from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!mine) return { ok: false, error: "You don't work on this client." };
  const { locationConfig, readLocationRows } = await import("@/lib/klaviyo/location-store");
  const admin = createAdminClient();
  const cfg = await locationConfig(admin, clientId);
  if (!cfg) return { ok: true, flagged: false };
  const w = locationWindow(isLocationRange(range) ? range : "month", todayET());
  const [{ data: camps, error }, { data: conn }] = await Promise.all([
    db.from("klaviyo_campaigns").select("campaign_id, name, send_time, recipients").eq("client_id", clientId).gte("send_time", `${w.start}T00:00:00Z`).lte("send_time", `${w.end}T23:59:59Z`).gt("recipients", 0).limit(300),
    admin.from("klaviyo_connections").select("currency").eq("client_id", clientId).maybeSingle(),
  ]);
  if (error) return { ok: false, error: "Couldn't read this account's campaigns." };
  const campaigns = (camps ?? []).map((c) => ({ id: c.campaign_id as string, name: (c.name as string | null) ?? "(untitled)", sendDay: etDay(c.send_time as string) })).filter((c) => c.sendDay >= w.start && c.sendDay <= w.end);
  const rows = await readLocationRows(db, clientId, cfg.metrics.map((m) => m.id), campaigns.map((c) => c.id), w.start);
  if (rows == null) return { ok: false, error: "Couldn't read the orders by location." };
  return { ok: true, flagged: true, window: w, currency: (conn?.currency as string | null) ?? null, breakdown: locationBreakdown({ metrics: cfg.metrics, rows, campaigns, maxColumns: 8, currency: (conn?.currency as string | null) ?? null }) };
}
