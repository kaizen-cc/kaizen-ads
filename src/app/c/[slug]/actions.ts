"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getViewer } from "@/lib/auth";
import { amendCopy, learnFromClient } from "@/lib/client-revision";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// A client's decision on an ad, from the portal. Right: approved. Left: changes to the design (pins on the image or the
// video timeline, plus a note), the copy (notes), or both. A team member can do the same from the preview to test.

/** A note on a design: a pin (x, y), a box (x, y = top-left, w, h), or a moment in a video (tMs). */
export type Pin = { designId: string; version: number; fileId: string | null; x: number | null; y: number | null; w?: number | null; h?: number | null; tMs: number | null; body: string };
export type PieceDecision = "approved" | "changes";
export type Review = {
  requestId: string;
  designs: { designId: string; decision: PieceDecision; note: string; pins: Pin[] }[];
  ads: { index: number; decision: PieceDecision; note: string }[];
};

/**
 * The client's review of one ticket: a decision on every design and every copy ad still waiting on them. Approved
 * pieces are locked; if some are approved and others need changes, the approved ones split off to launch.
 */
export async function submitReview(slug: string, review: Review): Promise<{ ok: true; splitNumber: number | null } | { ok: false; error: string }> {
  const viewer = await getViewer();
  if (!adminConfigured()) return { ok: false, error: "The portal isn't set up yet." };
  const admin = createAdminClient();
  const { data: client } = await admin.from("clients").select("id, name, slug, portal_live").eq("slug", slug).maybeSingle();
  if (!client) return { ok: false, error: "Not found." };

  // Who's deciding: a contact of this brand (only once it's live), or a team member testing as the client
  let byContact: string | null = null;
  let byProfile: string | null = null;
  let byName: string;
  if (viewer.kind === "contact") {
    if (!client.portal_live || !viewer.brands.some((b) => b.slug === slug)) return { ok: false, error: "Not found." };
    byContact = viewer.id;
    byName = viewer.fullName ?? viewer.email;
  } else {
    byProfile = viewer.id;
    byName = `${viewer.fullName} (testing as the client)`;
  }

  const { data: r } = await admin.from("requests").select("id, client_id").eq("id", review.requestId).maybeSingle();
  if (!r || r.client_id !== client.id) return { ok: false, error: "Not found." };
  for (const d of review.designs) if (d.decision === "changes" && !d.pins.some((p) => p.body.trim()) && !d.note.trim()) return { ok: false, error: "Say what to change on each design you sent back." };
  for (const a of review.ads) if (a.decision === "changes" && !a.note.trim()) return { ok: false, error: "Say what to change in each copy you sent back." };

  const { data, error } = await admin.rpc("client_submit_review", {
    p_request: review.requestId,
    p_designs: review.designs.map((d) => ({ design_id: d.designId, decision: d.decision, note: d.note.trim() || (d.pins.length ? d.pins.map((p) => p.body.trim()).join("; ") : "") })),
    p_ads: review.ads.map((a) => ({ index: a.index, decision: a.decision, note: a.note.trim() })),
    p_by_contact: byContact,
    p_by_profile: byProfile,
    p_by_name: byName,
  });
  if (error) return { ok: false, error: error.message };
  const result = data as { split_number: number | null };

  // The pins on designs sent back, for the maker (and for the AI check that each was done)
  const pins = review.designs.filter((d) => d.decision === "changes").flatMap((d) => d.pins.filter((p) => p.body.trim()));
  if (pins.length)
    await admin.from("review_comments").insert(
      pins.map((p) => ({
        request_id: review.requestId,
        client_id: client.id,
        design_id: p.designId,
        version: p.version,
        file_id: p.fileId,
        x: p.x,
        y: p.y,
        w: p.w ?? null,
        h: p.h ?? null,
        t_ms: p.tMs,
        body: p.body.trim().slice(0, 2000),
        round: "client",
        author_id: byProfile,
        author_contact_id: byContact,
        author_name: byName,
      })),
    );

  const copyNotes = review.ads.filter((a) => a.decision === "changes").map((a) => `Ad ${a.index + 1}: ${a.note.trim()}`);
  after(async () => {
    // Copy: the AI amends only the ads sent back (copy review approves them again before they go back)
    if (copyNotes.length) {
      try {
        await amendCopy(admin, review.requestId, copyNotes.join("\n"));
      } catch (e) {
        console.error("[portal] copy revision failed:", e instanceof Error ? e.message : e);
      }
    }
    // What the notes say about this client from now on
    try {
      await learnFromClient(admin, client.id, [...pins.map((p) => p.body), ...review.designs.map((d) => d.note), ...review.ads.map((a) => a.note)], byProfile);
    } catch (e) {
      console.error("[portal] learning from client notes failed:", e instanceof Error ? e.message : e);
    }
  });

  revalidatePath(`/c/${slug}`);
  revalidatePath("/board");
  return { ok: true, splitNumber: result?.split_number ?? null };
}
