"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { LINE_SEAT_ROLES, METRIC, SERVICE, canSetTarget, parseRateTarget, parseRevenueTarget, type Line } from "@/lib/channel-kpis/calc";
import { servicesOf } from "@/lib/services";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Set a client's monthly email or social target. Allowed for an exec, a lead, the line's head, or someone seated on
 * that client in that line (checked here: the table has no write policy). The row is replaced, never deleted, and
 * remembers who set it and when. The client must be one this person can see and must buy the line's service.
 */
export async function setChannelTarget(clientId: string, line: Line, form: FormData): Promise<ActionResult> {
  if (line !== "email" && line !== "social") return { ok: false, error: "Unknown line." };
  const me = await requireStaff();
  if (!adminConfigured()) return { ok: false, error: "Not set up here." };
  const db = await createClient();
  const [{ data: client }, { data: seats }] = await Promise.all([
    db.from("clients").select("id, slug, services, services_extra, services_removed").eq("id", clientId).maybeSingle(),
    db.from("client_assignments").select("role").eq("client_id", clientId).eq("profile_id", me.id).in("role", LINE_SEAT_ROLES[line]),
  ]);
  if (!client) return { ok: false, error: "You don't work on this client." };
  if (!(servicesOf(client as Parameters<typeof servicesOf>[0]) as string[]).includes(SERVICE[line])) return { ok: false, error: `This client doesn't buy ${line === "email" ? "email marketing" : "social media"}.` };
  if (!canSetTarget(me, line, (seats ?? []).map((s) => s.role as string))) return { ok: false, error: `Setting this target is for the ${line} team, leads and execs.` };

  const raw = String(form.get("target") ?? "").trim();
  const target = line === "email" ? parseRevenueTarget(raw) : parseRateTarget(raw);
  if (target == null) return { ok: false, error: line === "email" ? "Enter the month's revenue target, like 12000 or $12k." : "Enter the engagement rate target, like 3.5 or 3.5%." };
  const notes = String(form.get("notes") ?? "").trim().slice(0, 500) || null;

  const admin = createAdminClient();
  // The first person to set it owns it; later edits keep the owner and update who changed it
  const { data: before } = await admin.from("channel_targets").select("owner_id").eq("client_id", clientId).eq("line", line).maybeSingle();
  const { error } = await admin.from("channel_targets").upsert(
    { client_id: clientId, line, metric: METRIC[line], target, notes, owner_id: (before?.owner_id as string | null) ?? me.id, updated_by: me.id, updated_at: new Date().toISOString() },
    { onConflict: "client_id,line" },
  );
  if (error) return { ok: false, error: "Couldn't save the target. Try again in a moment." };
  revalidatePath("/kpis");
  revalidatePath("/pipeline");
  revalidatePath(`/clients/${client.slug as string}`);
  return { ok: true };
}
