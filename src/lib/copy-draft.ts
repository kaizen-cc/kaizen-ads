import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AGENCY_SYSTEM, AiUnavailable, askJson, clientContext, contextBlock, COPY_GUARD_SCHEMA, COPY_GUARD_SYSTEM, COPY_LESSONS_SCHEMA, COPY_LESSONS_SYSTEM, COPY_SCHEMA, getAgent, type CopyLesson, type CopyViolation } from "@/lib/ai";
import { currentCreative } from "@/lib/creative-review";
import { CTA_BUTTONS, type Ad } from "@/lib/copy";
import { readReferences, referencesBlock } from "@/lib/references";

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
    .select("id, client_id, angle_id, angle_name, title, format, audience, brief, sizes, refs, stage, new_count, variation_count, landing_url")
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
    .upsert(
      { request_id: requestId, client_id: r.client_id, angle_id: r.angle_id, status: "drafting", error: null, progress: { written: 0, total: 5, label: "Reading the brief, the creative and the client's voice" }, updated_at: new Date().toISOString() },
      { onConflict: "request_id" },
    );

  // Real progress: the ads are counted as they're written (the answer streams in)
  let shown = -1;
  let last = 0;
  const onText = (soFar: string) => {
    const started = (soFar.match(/"primaryText"/g) ?? []).length;
    if (started === shown || Date.now() - last < 800) return;
    shown = started;
    last = Date.now();
    const label = started === 0 ? "Picking a formula for each ad" : `Writing ad ${started} of 5 · ${started <= 3 ? "short-form" : "long-form"}`;
    // A query builder only runs when awaited or then-ed: fire it without holding up the stream
    admin.from("copy_sets").update({ progress: { written: Math.max(0, started - 1), total: 5, label } }).eq("request_id", requestId).then(() => undefined, () => undefined);
  };

  try {
    const [{ sources, model }, refs, creative] = await Promise.all([getAgent("copy"), readReferences(r.refs ?? []), creativeImages(admin, requestId)]);
    const out = await askJson<{ ads: Ad[]; notes: string }>({
      agent: "copy",
      label: `copy ${ctx.name}`,
      system: AGENCY_SYSTEM,
      schema: COPY_SCHEMA,
      images: [...creative, ...refs.images].slice(0, 8),
      onText,
      prompt: `${contextBlock(ctx, undefined, sources)}
${referencesBlock(refs.reads)}

<ticket>
Title: ${r.title}
Format: ${r.format} · ${r.new_count} net new, ${r.variation_count} variations
Angle: ${r.angle_name ?? "not set"}
Audience: ${r.audience ?? "not set"}
Landing page: ${r.landing_url ?? "not set"} (where the ad sends people: the CTA and the promise should match it)
Brief:
${r.brief ?? "(no brief)"}
Designs: ${(designs ?? []).map((d) => `D${d.position} ${d.name}${d.is_variation ? " (variation)" : ""}`).join("; ") || "none listed"}${creative.length ? `\nThe first ${creative.length} picture${creative.length === 1 ? " is" : "s are"} the approved creative this copy runs with: write to what's on it (don't repeat its on-image text word for word).` : ""}
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
      .update({ status: "review", ads, ai_ads: ads, notes: out.notes, model, progress: {}, version: (existing?.version ?? 0) + 1, updated_by: actorId, updated_at: new Date().toISOString(), approved_at: null, approved_by: null })
      .eq("request_id", requestId);

    // Carousels: each card's headline and description too, written to the cards themselves
    if (r.format === "carousel") {
      await admin.from("copy_sets").update({ progress: { written: 5, total: 5, label: "Writing the carousel cards" } }).eq("request_id", requestId);
      await (await import("@/lib/carousel-cards")).draftCards(admin, requestId).catch((e) => console.error("carousel cards", e));
      await admin.from("copy_sets").update({ progress: {} }).eq("request_id", requestId);
    }

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
    await admin.from("copy_sets").update({ status: "failed", progress: {}, error: e instanceof AiUnavailable ? e.message : "The copy draft didn't finish." }).eq("request_id", requestId);
    throw e;
  }
}

/** Small pictures of the creative (one per design, up to 3), so the copy is written to what's actually on it. */
async function creativeImages(admin: SupabaseClient, requestId: string) {
  const { designs } = await currentCreative(admin, requestId);
  const out: { mediaType: "image/webp"; data: string }[] = [];
  for (const d of designs.filter((x) => !x.is_variation).slice(0, 3)) {
    const f = d.files.find((x) => x.aspect === "4x5" && x.thumb_path) ?? d.files.find((x) => x.thumb_path);
    if (!f?.thumb_path) continue;
    const { data } = await admin.storage.from("creative").download(f.thumb_path);
    if (data) out.push({ mediaType: "image/webp", data: Buffer.from(await data.arrayBuffer()).toString("base64") });
  }
  return out;
}

/**
 * After copy review approves a set they edited: what the edits say about this client's copy becomes client memory
 * (source "copy"), so every later draft (and every other agent) writes that way.
 */
export async function learnFromCopy(admin: SupabaseClient, requestId: string, actorId: string | null) {
  const { data: set } = await admin.from("copy_sets").select("client_id, ads, ai_ads").eq("request_id", requestId).maybeSingle();
  if (!set) return [];
  const ai = (set.ai_ads ?? []) as Ad[];
  const fin = (set.ads ?? []) as Ad[];
  const pairs: string[] = [];
  fin.forEach((f, i) => {
    const a = ai[i];
    if (!a) return;
    for (const k of ["primaryText", "headline", "linkDescription", "cta"] as const)
      if ((a[k] ?? "").trim() !== (f[k] ?? "").trim()) pairs.push(`Ad ${i + 1} ${k}\n  AI wrote: "${clip(a[k], 600)}"\n  Approved: "${clip(f[k], 600)}"`);
  });
  if (!pairs.length) return [];
  const { data: memory } = await admin.from("client_memory").select("kind, body").eq("client_id", set.client_id).eq("status", "active").limit(60);
  const out = await askJson<{ lessons: CopyLesson[] }>({
    agent: "copy",
    label: "copy lessons",
    system: COPY_LESSONS_SYSTEM,
    schema: COPY_LESSONS_SCHEMA,
    prompt: `<client_memory>\n${(memory ?? []).map((m) => `- [${m.kind}] ${m.body}`).join("\n") || "(none yet)"}\n</client_memory>\n\n<edits>\n${pairs.slice(0, 20).join("\n")}\n</edits>`,
  });
  const lessons = out.lessons.filter((l) => l.body.trim()).slice(0, 3);
  if (lessons.length) await admin.from("client_memory").insert(lessons.map((l) => ({ client_id: set.client_id, kind: l.kind, body: l.body.trim().slice(0, 1000), source: "copy", created_by: actorId })));
  return lessons;
}

/**
 * Before copy is approved: does it say anything the client explicitly told us not to? Only that blocks approval.
 * No "avoid" memory and no reviewed brand bible = nothing to check against.
 */
export async function checkAgainstClient(admin: SupabaseClient, clientId: string, ads: Ad[]): Promise<CopyViolation[]> {
  const [{ data: memory }, { data: bible }] = await Promise.all([
    admin.from("client_memory").select("body").eq("client_id", clientId).eq("status", "active").eq("kind", "avoid").limit(80),
    admin.from("client_brand_bibles").select("read_this_first").eq("client_id", clientId).eq("status", "reviewed").maybeSingle(),
  ]);
  if (!memory?.length && !bible?.read_this_first) return [];
  const out = await askJson<{ violations: CopyViolation[] }>({
    agent: "copy",
    label: "copy check against client",
    system: COPY_GUARD_SYSTEM,
    schema: COPY_GUARD_SCHEMA,
    prompt: `<client_said_avoid>
${(memory ?? []).map((m) => `- ${m.body}`).join("\n") || "(nothing)"}
</client_said_avoid>
${bible?.read_this_first ? `<brand_bible>\n${bible.read_this_first.slice(0, 6000)}\n</brand_bible>\n` : ""}
<copy>
${ads.map((a, i) => `Ad ${i + 1}\nprimaryText: ${a.primaryText}\nheadline: ${a.headline}\nlinkDescription: ${a.linkDescription}\ncta: ${a.cta}`).join("\n\n")}
</copy>`,
  });
  // Only what's really in the copy now
  return out.violations.filter((v) => {
    const ad = ads[v.ad - 1];
    if (!ad || !v.quote.trim()) return false;
    const hay = [ad.primaryText, ad.headline, ad.linkDescription, ad.cta].join(" ").toLowerCase();
    return hay.includes(v.quote.trim().toLowerCase());
  });
}
