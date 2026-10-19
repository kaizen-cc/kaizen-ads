import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { CTA_BUTTONS, type Ad } from "@/lib/copy";

// Copy written somewhere else (a ticket migrated from Asana) brought in as the ticket's copy set: split into ads with
// the words exactly as they were. Approved when it was already past copy review, so the client portal can show it.

const SCHEMA = {
  type: "object",
  properties: {
    ads: {
      type: "array",
      items: {
        type: "object",
        properties: { kind: { type: "string", enum: ["short", "long"] }, primaryText: { type: "string" }, headline: { type: "string" }, linkDescription: { type: "string" }, cta: { type: "string" } },
        required: ["kind", "primaryText", "headline", "linkDescription", "cta"],
        additionalProperties: false,
      },
    },
  },
  required: ["ads"],
  additionalProperties: false,
};

export async function importCopy(admin: SupabaseClient, requestId: string, text: string, approved: boolean, by: string) {
  const { data: r } = await admin.from("requests").select("client_id, angle_id").eq("id", requestId).single();
  if (!r) return;
  const out = await askJson<{ ads: Omit<Ad, "formula" | "angle">[] }>({
    agent: "copy",
    label: "copy import",
    system: `You split ad copy that was already written and approved into separate Meta ads, without changing a word. Each ad: primaryText, headline, linkDescription (empty if there isn't one), cta (one of ${CTA_BUTTONS.join(", ")}; "Learn More" if none is given), kind short (under 300 characters of primary text) or long. Copy the text exactly, including line breaks and emojis. Never rewrite, shorten, fix or add anything. Up to 5 ads; if it's one block of copy, it's one ad.`,
    schema: SCHEMA,
    maxTokens: 8000,
    prompt: text.trim().slice(0, 15000),
  });
  const ads: Ad[] = out.ads.slice(0, 5).map((a) => ({ ...a, formula: "From Asana", angle: "", cta: CTA_BUTTONS.includes(a.cta as (typeof CTA_BUTTONS)[number]) ? a.cta : "Learn More" }));
  if (!ads.length) return;
  const now = new Date().toISOString();
  await admin.from("copy_sets").upsert(
    {
      request_id: requestId,
      client_id: r.client_id,
      angle_id: r.angle_id,
      status: approved ? "approved" : "review",
      ads,
      ai_ads: ads,
      notes: "Brought over from Asana as it stood.",
      version: 1,
      updated_by: by,
      updated_at: now,
      ...(approved ? { approved_by: by, approved_at: now } : {}),
    },
    { onConflict: "request_id" },
  );
}
