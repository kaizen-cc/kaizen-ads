"use server";

import { requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// How long an AI job usually takes, from its own recent runs (ai_runs): the 75th percentile of the last 60 days, so
// the countdown is honest on a slow day. Too few runs yet: the fallback the screen passed.

const cache = new Map<string, { ms: number; at: number }>();

/** label can name several jobs that run one after the other ("a+b"): their times add up. */
export async function aiEta(label: string, fallbackMs: number): Promise<number> {
  await requireStaff();
  if (label.includes("+")) {
    const parts = label.split("+").map((l) => l.trim()).filter(Boolean);
    const each = await Promise.all(parts.map((l) => one(l, Math.round(fallbackMs / parts.length))));
    return each.reduce((a, b) => a + b, 0);
  }
  return one(label, fallbackMs);
}

async function one(label: string, fallbackMs: number): Promise<number> {
  const hit = cache.get(label);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.ms;
  if (!adminConfigured()) return fallbackMs;
  const { data } = await createAdminClient()
    .from("ai_runs")
    .select("ms")
    .eq("label", label)
    .eq("ok", true)
    .gte("created_at", new Date(Date.now() - 60 * 86_400_000).toISOString())
    .order("created_at", { ascending: false })
    .limit(200);
  const ms = (data ?? []).map((r) => Number(r.ms)).filter((n) => n > 0).sort((a, b) => a - b);
  // A few seconds on top of the AI call itself: reading the client before, saving after
  const eta = ms.length >= 3 ? ms[Math.floor(ms.length * 0.75)] + 4000 : fallbackMs;
  cache.set(label, { ms: eta, at: Date.now() });
  return eta;
}
