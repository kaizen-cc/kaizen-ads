"use server";

import { requireStaff } from "@/lib/auth";
import { aiEnabled } from "@/lib/ai";
import { readGoogleIdea, type GoogleInsight } from "@/lib/google-ideas";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

/** The AI's read of one Google winner (written the first time someone points at it, then kept a week). */
export async function googleIdeaInsight(id: string): Promise<GoogleInsight | null> {
  await requireStaff();
  if (!adminConfigured() || !aiEnabled()) return null;
  try {
    return await readGoogleIdea(createAdminClient(), id);
  } catch (e) {
    console.error("[google ideas] insight failed:", e instanceof Error ? e.message : e);
    return null;
  }
}
