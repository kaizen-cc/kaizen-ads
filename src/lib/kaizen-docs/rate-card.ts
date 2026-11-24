import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Kaizen's rate card: the starting prices every proposal, quote and SOW quotes, per service line and tier, one-time
// or monthly. The executives keep it (Settings › Rate card, or the assistant's set_rate_card); a different price
// agreed with one client is relationship pricing, confirmed in the conversation, never written back here.

export const RATE_SERVICES = ["meta", "google", "paid_ads", "full_stack", "tiktok", "social", "creative", "email", "web", "crm", "a_la_carte", "tracking", "other"] as const;
export type RateRow = { id: string; service: string; tier: string | null; label: string; cadence: "one_time" | "month"; amount: number; note: string | null; sort_order: number };

const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Adds, changes or removes one price (the caller checked it's an executive; row-level security checks again) */
export async function setRate(db: SupabaseClient, by: string, input: Record<string, unknown>): Promise<{ ok: true; id: string; removed?: boolean } | { ok: false; error: string }> {
  const id = /^[0-9a-f-]{36}$/i.test(String(input.id ?? "")) ? String(input.id) : null;
  if (input.remove === true) {
    if (!id) return { ok: false, error: "Which price? Give its id (from rate_card)." };
    const { error } = await db.from("rate_card").update({ active: false, updated_by: by, updated_at: new Date().toISOString() }).eq("id", id);
    return error ? { ok: false, error: error.message } : { ok: true, id, removed: true };
  }
  const service = clip(input.service, 30).toLowerCase();
  const label = clip(input.label, 120);
  const amount = Number(String(input.amount ?? "").replace(/[$,\s]/g, ""));
  const cadence = input.cadence === "one_time" ? "one_time" : input.cadence === "month" ? "month" : null;
  if (!service || !label || !cadence || !Number.isFinite(amount) || amount <= 0) return { ok: false, error: "A price needs the service line, what it is, one_time or month, and an amount above 0." };
  const row = { service, tier: clip(input.tier, 40) || null, label, cadence, amount: Math.round(amount * 100) / 100, note: clip(input.note, 300) || null, updated_by: by, updated_at: new Date().toISOString() };
  if (id) {
    const { error } = await db.from("rate_card").update(row).eq("id", id);
    return error ? { ok: false, error: error.message } : { ok: true, id };
  }
  const { data, error } = await db.from("rate_card").insert({ ...row, sort_order: Number(input.sort_order ?? 0) || 0 }).select("id").single();
  return error || !data ? { ok: false, error: error?.message ?? "It couldn't be saved." } : { ok: true, id: data.id as string };
}
