"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getViewer } from "@/lib/auth";
import { amendCopy, learnFromClient } from "@/lib/client-revision";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// A client's decision on an ad, from the portal. Right: approved. Left: changes to the design (pins on the image or the
// video timeline, plus a note), the copy (notes), or both. A team member can do the same from the preview to test.

export type Pin = { designId: string; version: number; fileId: string | null; x: number | null; y: number | null; tMs: number | null; body: string };
export type Decision =
  | { requestId: string; decision: "approved" }
  | { requestId: string; decision: "revise"; targets: ("design" | "copy")[]; pins: Pin[]; designNote: string; copyNotes: string };

export async function decide(slug: string, d: Decision): Promise<{ ok: true } | { ok: false; error: string }> {
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

  const { data: r } = await admin.from("requests").select("id, client_id, stage").eq("id", d.requestId).maybeSingle();
  if (!r || r.client_id !== client.id) return { ok: false, error: "Not found." };

  if (d.decision === "revise") {
    if (!d.targets.length) return { ok: false, error: "Pick what needs changes." };
    if (d.targets.includes("design") && !d.pins.length && !d.designNote.trim()) return { ok: false, error: "Mark what to change on the design, or add a note." };
    if (d.targets.includes("copy") && !d.copyNotes.trim()) return { ok: false, error: "Say what to change in the copy." };
  }

  const { error } = await admin.rpc("client_decide", {
    p_request: d.requestId,
    p_decision: d.decision,
    p_targets: d.decision === "revise" ? d.targets : [],
    p_copy_notes: d.decision === "revise" ? d.copyNotes : null,
    p_design_note: d.decision === "revise" ? d.designNote : null,
    p_by_contact: byContact,
    p_by_profile: byProfile,
    p_by_name: byName,
  });
  if (error) return { ok: false, error: error.message };

  if (d.decision === "revise") {
    // The pins, for the maker (and for the AI check that the changes were made)
    const pins = d.targets.includes("design") ? d.pins.filter((p) => p.body.trim()) : [];
    if (pins.length)
      await admin.from("review_comments").insert(
        pins.map((p) => ({
          request_id: d.requestId,
          client_id: client.id,
          design_id: p.designId,
          version: p.version,
          file_id: p.fileId,
          x: p.x,
          y: p.y,
          t_ms: p.tMs,
          body: p.body.trim().slice(0, 2000),
          round: "client",
          author_id: byProfile,
          author_contact_id: byContact,
          author_name: byName,
        })),
      );

    after(async () => {
      // Copy: the AI amends it (copy review approves it again before it goes back)
      if (d.targets.includes("copy")) {
        try {
          await amendCopy(admin, d.requestId, d.copyNotes);
        } catch (e) {
          console.error("[portal] copy revision failed:", e instanceof Error ? e.message : e);
        }
      }
      // What the notes say about this client from now on
      try {
        await learnFromClient(admin, client.id, [...pins.map((p) => p.body), d.designNote, d.copyNotes], byProfile);
      } catch (e) {
        console.error("[portal] learning from client notes failed:", e instanceof Error ? e.message : e);
      }
    });
  }

  revalidatePath(`/c/${slug}`);
  revalidatePath("/board");
  return { ok: true };
}
