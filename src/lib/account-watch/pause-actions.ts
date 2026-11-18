"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { endPause, pauseService } from "./act";

// "Pause email for this client": a lead or exec sets a service paused until a date with a reason (public.watch_pauses,
// the account watch's own table). The recap, the Overview and the KPI board skip that line until the date; nothing is
// deleted, and the pause can be ended early.

type Done = { ok: true; message: string } | { ok: false; error: string };

export type LinePause = { id: string; until: string; reason: string; by: string | null };

/** The pause on a client's service today (if any) and whether this person may change it */
export async function linePauseState(clientId: string, service: string): Promise<{ pause: LinePause | null; canManage: boolean }> {
  const me = await requireStaff();
  const canManage = me.isExec || me.isLead;
  const db = await createClient();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const { data, error } = await db.from("watch_pauses").select("id, until, reason, profiles:set_by(full_name)").eq("client_id", clientId).eq("service", service).is("cleared_at", null).gte("until", today).order("until", { ascending: false }).limit(1).maybeSingle();
  if (error || !data) return { pause: null, canManage };
  return { pause: { id: data.id as string, until: String(data.until), reason: String(data.reason ?? ""), by: (data.profiles as unknown as { full_name: string } | null)?.full_name ?? null }, canManage };
}

export async function pauseLine(clientId: string, service: string, until: string, reason: string): Promise<Done> {
  const me = await requireStaff();
  if (!adminConfigured()) return { ok: false, error: "Not set up here." };
  const { data } = await (await createClient()).from("clients").select("id, slug").eq("id", clientId).maybeSingle();
  if (!data) return { ok: false, error: "You don't work on this client." };
  const r = await pauseService(createAdminClient(), me, { clientId, service, until, reason });
  if (r.ok) for (const p of ["/pipeline", "/today", "/kpis", "/reports", `/clients/${data.slug}`]) revalidatePath(p);
  return r;
}

export async function resumeLine(pauseId: string): Promise<Done> {
  const me = await requireStaff();
  if (!adminConfigured()) return { ok: false, error: "Not set up here." };
  const r = await endPause(createAdminClient(), me, pauseId);
  if (r.ok) for (const p of ["/pipeline", "/today", "/kpis"]) revalidatePath(p);
  return r;
}
