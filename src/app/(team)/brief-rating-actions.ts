"use server";

import { after } from "next/server";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isCreativeLead } from "@/lib/lead-creative-core";

// The creative leads (the Head of Creative, the lead video editor, the lead graphic designer) rate each auto-drafted
// brief: good or needs work, with one line why. Kept with the brief's other corrections (brief_corrections, kind
// 'rating', one per person per brief) and fed to the brief writer as a lesson, like every correction.

export type BriefRating = "good" | "needs_work";

export async function rateDraftedBrief(suggestionId: string, rating: BriefRating, why: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!isCreativeLead(me.role) && !me.isExec) return { ok: false, error: "Rating drafted briefs is for the creative leads." };
  if (me.viewAs) return { ok: false, error: "Not while viewing as someone." };
  if (rating !== "good" && rating !== "needs_work") return { ok: false, error: "Good or needs work?" };
  const line = why.replace(/\s+/g, " ").trim().slice(0, 300);
  if (rating === "needs_work" && !line) return { ok: false, error: "Say in one line what it needs." };
  const { data: s } = await (await createClient()).from("creative_suggestions").select("id, client_id, draft").eq("id", suggestionId).maybeSingle();
  if (!s) return { ok: false, error: "That brief isn't there any more." };
  const admin = createAdminClient();
  // One rating per person per brief: a second one replaces the first
  await admin.from("brief_corrections").delete().eq("suggestion_id", suggestionId).eq("profile_id", me.id).eq("kind", "rating");
  const { data: row, error } = await admin.from("brief_corrections").insert({ client_id: s.client_id, suggestion_id: suggestionId, profile_id: me.id, kind: "rating", rating, reason: line || null }).select("id").single();
  if (error || !row) return { ok: false, error: "It didn't save. Try again." };
  const title = String((s.draft as { title?: string } | null)?.title ?? "a drafted brief").slice(0, 160);
  const id = row.id as string;
  after(async () => {
    const { recordLearning } = await import("@/lib/learnings");
    await recordLearning(admin, {
      table: "brief_corrections",
      id,
      clientId: s.client_id as string,
      agent: "strategist",
      text: rating === "good" ? `A creative lead rated the auto-drafted brief "${title}" good${line ? `: ${line}` : ""}. Keep writing briefs like it.` : `A creative lead rated the auto-drafted brief "${title}" as needing work: ${line}`,
    });
  });
  return { ok: true };
}
