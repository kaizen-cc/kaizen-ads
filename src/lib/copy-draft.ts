import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AGENCY_SYSTEM, AiUnavailable, askJson, clientContext, contextBlock, COPY_SCHEMA, getAgent } from "@/lib/ai";
import { CTA_BUTTONS, type Ad } from "@/lib/copy";

// The Copywriter drafts Kaizen's copy set for a ticket. Learning loop: approved sets for this client, and the pairs of
// (AI draft → the approved final) where copy review changed something, go into every new draft as the house style to follow.

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

async function learning(admin: SupabaseClient, clientId: string, angleId: string | null) {
  const { data } = await admin
    .from("copy_sets")
    .select("angle_id, ads, ai_ads, approved_at")
    .eq("client_id", clientId)
    .eq("status", "approved")
    .order("approved_at", { ascending: false })
    .limit(6);
  const sets = data ?? [];
  const edits: string[] = [];
  for (const s of sets) {
    const ai = (s.ai_ads ?? []) as Ad[];
    const fin = (s.ads ?? []) as Ad[];
    fin.forEach((f, i) => {
      const a = ai[i];
      if (!a) return;
      for (const field of ["primaryText", "headline", "linkDescription"] as const)
        if (a[field] && f[field] && a[field].trim() !== f[field].trim() && edits.length < 12)
          edits.push(`- ${field} · AI wrote: "${clip(a[field], 300)}"\n  Copy review changed it to: "${clip(f[field], 300)}"`);
    });
  }
  const sameAngle = sets.find((s) => angleId && s.angle_id === angleId);
  const approved = (sameAngle ? [sameAngle] : sets.slice(0, 2)).flatMap((s) =>
    ((s.ads ?? []) as Ad[]).slice(0, 3).map((a) => `- [${a.kind}] ${clip(a.primaryText, 400)} | Headline: ${a.headline}`),
  );
  return { edits, approved };
}

/** Draft (or redraft) the copy set for a ticket and hand it to copy review. Uses the server's rights; callers check access. */
export async function draftCopy(admin: SupabaseClient, requestId: string, actorId: string | null, note?: string) {
  const { data: r } = await admin
    .from("board_requests")
    .select("id, client_id, angle_id, angle_name, title, format, audience, brief, sizes, stage, new_count, variation_count")
    .eq("id", requestId)
    .maybeSingle();
  if (!r) throw new AiUnavailable("Ticket not found.");
  const [ctx, { data: designs }, learned, { data: existing }] = await Promise.all([
    clientContext(admin, r.client_id),
    admin.from("designs").select("position, name, is_variation").eq("request_id", requestId).order("position"),
    learning(admin, r.client_id, r.angle_id),
    admin.from("copy_sets").select("id, version").eq("request_id", requestId).maybeSingle(),
  ]);
  if (!ctx) throw new AiUnavailable("Client not found.");

  await admin
    .from("copy_sets")
    .upsert({ request_id: requestId, client_id: r.client_id, angle_id: r.angle_id, status: "drafting", error: null, updated_at: new Date().toISOString() }, { onConflict: "request_id" });

  try {
    const { sources, model } = await getAgent("copy");
    const out = await askJson<{ ads: Ad[]; notes: string }>({
      agent: "copy",
      label: `copy ${ctx.name}`,
      system: AGENCY_SYSTEM,
      schema: COPY_SCHEMA,
      prompt: `${contextBlock(ctx, undefined, sources)}

<ticket>
Title: ${r.title}
Format: ${r.format} · ${r.new_count} net new, ${r.variation_count} variations
Angle: ${r.angle_name ?? "not set"}
Audience: ${r.audience ?? "not set"}
Brief:
${r.brief ?? "(no brief)"}
Designs: ${(designs ?? []).map((d) => `D${d.position} ${d.name}${d.is_variation ? " (variation)" : ""}`).join("; ") || "none listed"}
</ticket>
${learned.approved.length ? `\n<approved_copy_for_this_client>\nCopy the client approved before. Match this voice.\n${learned.approved.join("\n")}\n</approved_copy_for_this_client>\n` : ""}${
        learned.edits.length
          ? `\n<copy_review_edits>\nHow Kaizen's copy review rewrote earlier AI drafts for this client. Write the way they edit.\n${learned.edits.join("\n")}\n</copy_review_edits>\n`
          : ""
      }${note?.trim() ? `\n<change_requested_in_copy_review>\n${note.trim()}\n</change_requested_in_copy_review>\n` : ""}
Write the copy set for this angle: exactly 5 ads in this order, 3 with kind "short" then 2 with kind "long".
- formula: the copywriting formula you used (different for each ad). angle: the one-line angle or emotional lead.
- primaryText: short = 50-125 characters (never over 300); long = 300-800 words. Line breaks as \\n. No links.
- headline: max 40 characters. linkDescription: max 30 characters.
- cta: one of ${CTA_BUTTONS.join(", ")}.
- notes: 1-3 sentences for copy review: what you went for, and anything you changed from the brief for policy.
Count characters and words before answering; these are hard limits.`,
    });
    const ads = out.ads.slice(0, 5).map((a) => ({ ...a, cta: CTA_BUTTONS.includes(a.cta as (typeof CTA_BUTTONS)[number]) ? a.cta : "Learn More" }));
    await admin
      .from("copy_sets")
      .update({ status: "review", ads, ai_ads: ads, notes: out.notes, model, version: (existing?.version ?? 0) + 1, updated_by: actorId, updated_at: new Date().toISOString(), approved_at: null, approved_by: null })
      .eq("request_id", requestId);

    // Straight to copy review: copy → copy review
    if (r.stage === "copy") {
      const { data: camille } = await admin.from("profiles").select("id").eq("role", "copywriter").eq("is_active", true).order("created_at").limit(1).maybeSingle();
      const now = new Date().toISOString();
      // Copy review is a same-day turnaround
      const { data: due } = await admin.rpc("end_of_business_day", { p_ts: now });
      await admin.from("requests").update({ stage: "copy_review", stage_entered_at: now, stage_due_at: due ?? null, assignee_id: camille?.id ?? null }).eq("id", requestId);
      await admin.from("request_events").insert({ request_id: requestId, kind: "copy", from_stage: "copy", to_stage: "copy_review", actor_id: actorId, data: { action: "drafted", model } });
    } else {
      await admin.from("request_events").insert({ request_id: requestId, kind: "copy", actor_id: actorId, body: note?.trim() || null, data: { action: "redrafted", model } });
    }
    return ads;
  } catch (e) {
    await admin.from("copy_sets").update({ status: "failed", error: e instanceof AiUnavailable ? e.message : "The copy draft didn't finish." }).eq("request_id", requestId);
    throw e;
  }
}
