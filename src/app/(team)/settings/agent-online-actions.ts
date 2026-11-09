"use server";

import { revalidatePath } from "next/cache";
import { requireExec } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// Execs: bring an offline agent (the TikTok Ads Buyer, shipped as a shell) online, or take it back offline. Offline,
// its skills are never called by any AI path (src/lib/ai.ts checks before every call); it can still be trained.

export async function setAgentOnline(roleKey: string, online: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireExec();
  // Only the agents that ship offline can be switched (the rest are always on)
  if (roleKey !== "tiktok_buyer") return { ok: false, error: "This agent can't be taken offline." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const admin = createAdminClient();
  const { error } = await admin.from("ai_roles").update({ offline: !online }).eq("key", roleKey);
  if (error) return { ok: false, error: error.message };
  // Its skills run in the app only when it's online
  const { ROLE_SKILLS } = await import("@/lib/agent-access");
  const skills = (ROLE_SKILLS[roleKey] ?? []).filter((k) => k !== "tiktok_launcher"); // TikTok launches stay off either way
  if (skills.length) await admin.from("ai_agents").update({ live: online }).in("key", skills);
  revalidatePath("/settings");
  return { ok: true };
}
