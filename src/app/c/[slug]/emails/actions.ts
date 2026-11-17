"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getViewer } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// A client's answer on emails waiting for them, from the portal: each email or text approved, or sent back with notes
// (pinned on the design, or a note). A team member can do the same to test. Any sent back puts the ticket in
// Revisions with each note routed to copy or design; all approved moves it on to the build (or the final check).

export type EmailDecision = { messageId: string; decision: "approved" | "changes"; note: string; pins: { box: { x: number; y: number; w: number; h: number }; body: string }[] };

export async function submitEmailReview(slug: string, ticketId: string, decisions: EmailDecision[]): Promise<{ ok: true; to: string } | { ok: false; error: string }> {
  const viewer = await getViewer();
  if (!adminConfigured()) return { ok: false, error: "The portal isn't set up yet." };
  const admin = createAdminClient();
  const { data: client } = await admin.from("clients").select("id, portal_live").eq("slug", slug).maybeSingle();
  if (!client) return { ok: false, error: "Not found." };
  let contactId: string | null = null;
  let byName: string;
  if (viewer.kind === "contact") {
    if (!client.portal_live || !viewer.brands.some((b) => b.slug === slug)) return { ok: false, error: "Not found." };
    contactId = viewer.id;
    byName = viewer.fullName ?? viewer.email;
  } else {
    byName = `${viewer.fullName} (testing as the client)`;
  }
  const { data: t } = await admin.from("email_tickets").select("id, client_id, stage").eq("id", ticketId).is("deleted_at", null).maybeSingle();
  if (!t || t.client_id !== client.id) return { ok: false, error: "Not found." };
  if (t.stage !== "with_client") return { ok: false, error: "These emails aren't waiting on you any more." };
  const { data: msgs } = await admin.from("email_messages").select("id, design_version, client_status").eq("ticket_id", ticketId);
  const waiting = (msgs ?? []).filter((m) => m.client_status !== "approved");
  for (const m of waiting) if (!decisions.some((d) => d.messageId === m.id)) return { ok: false, error: "Approve or comment on every one first." };
  for (const d of decisions) if (d.decision === "changes" && !d.note.trim() && !d.pins.some((p) => p.body.trim())) return { ok: false, error: "Say what to change on each one you sent back." };
  const now = new Date().toISOString();
  for (const d of decisions) {
    const m = (msgs ?? []).find((x) => x.id === d.messageId);
    if (!m || m.client_status === "approved") continue;
    await admin.from("email_messages").update({ client_status: d.decision, client_note: d.note.trim().slice(0, 4000) || null, client_by: byName, client_at: now }).eq("id", m.id);
    if (d.decision === "changes") {
      const rows = [
        ...d.pins.filter((p) => p.body.trim()).map((p) => ({ box: p.box, body: p.body.trim() })),
        ...(d.note.trim() ? [{ box: null, body: d.note.trim() }] : []),
      ];
      if (rows.length) await admin.from("email_comments").insert(rows.map((r) => ({ ticket_id: ticketId, message_id: m.id, client_id: client.id, author_kind: "client", contact_id: contactId, author_name: byName, body: r.body.slice(0, 4000), box: r.box, design_version: m.design_version })));
    }
  }
  const { logEvent, advance, routeClientComments } = await import("@/lib/email-board");
  const changes = decisions.filter((d) => d.decision === "changes").length;
  await logEvent(admin, { ticketId, clientId: client.id as string, kind: "client", actorName: byName, body: changes ? `Approved ${decisions.length - changes}, asked for changes on ${changes}.` : "Approved everything.", data: { testing: viewer.kind !== "contact" } });
  const r = await advance(admin, ticketId, { id: null, name: byName });
  if (r.stage === "revisions") after(() => routeClientComments(createAdminClient(), ticketId));
  revalidatePath(`/c/${slug}/emails`);
  revalidatePath("/board/email");
  return { ok: true, to: r.stage };
}
