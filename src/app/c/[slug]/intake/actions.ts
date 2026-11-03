"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getViewer } from "@/lib/auth";
import type { CallType, IntakeForm } from "@/lib/intake-questions";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// The client's side of their marketing intake: their questions (tailored the first time it opens), answers saved as
// they go, sent, and the onboarding call. A team member can do the same while testing (marked as such).

async function load(slug: string) {
  const viewer = await getViewer();
  if (!adminConfigured()) return { error: "The portal isn't set up yet." } as const;
  const admin = createAdminClient();
  const { data: client } = await admin.from("clients").select("id, name, slug, portal_live").eq("slug", slug).maybeSingle();
  if (!client || (viewer.kind === "contact" && (!client.portal_live || !viewer.brands.some((b) => b.slug === slug)))) return { error: "Not found." } as const;
  if (viewer.kind === "staff") {
    // The team's own access rules decide whether they may open it
    const { createClient } = await import("@/lib/supabase/server");
    const { data: mine } = await (await createClient()).from("clients").select("id").eq("id", client.id).maybeSingle();
    if (!mine) return { error: "Not found." } as const;
  }
  const by = viewer.kind === "contact" ? (viewer.fullName ?? viewer.email) : `${viewer.fullName} (team, testing)`;
  const lib = await import("@/lib/intake-form");
  return { admin, client, by, lib } as const;
}

/** The form, tailored the first time (half a minute or so), then kept */
export async function prepareIntake(slug: string): Promise<{ ok: true; form: IntakeForm; answers: Record<string, string> } | { ok: false; error: string }> {
  const l = await load(slug);
  if ("error" in l) return { ok: false, error: l.error! };
  try {
    const row = await l.lib.prepareIntakeForm(l.admin, l.client.id as string);
    return { ok: true, form: row.form!, answers: row.answers };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't open the form. Try again in a minute." };
  }
}

export async function saveIntake(slug: string, answers: Record<string, string>) {
  const l = await load(slug);
  if ("error" in l) return { ok: false as const, error: l.error! };
  return l.lib.saveIntakeAnswers(l.admin, l.client.id as string, answers);
}

/** Sent: kept and read like the old form, the team told after the answer, and the call they should book */
export async function sendIntake(slug: string, answers: Record<string, string>): Promise<{ ok: true; call: { type: CallType; reason: string } } | { ok: false; error: string; missing?: string[] }> {
  const l = await load(slug);
  if ("error" in l) return { ok: false, error: l.error! };
  const clientId = l.client.id as string;
  const saved = await l.lib.saveIntakeAnswers(l.admin, clientId, answers);
  if (!saved.ok && saved.error !== "Already sent: thank you!") return saved;
  const r = await l.lib.submitIntakeForm(l.admin, clientId, l.by);
  if (!r.ok) return r;
  const call = await l.lib.callTypeFor(l.admin, clientId);
  await l.admin.from("client_intake_forms").update({ call_type: call.type, call_reason: call.reason }).eq("client_id", clientId);
  if (r.intakeId) {
    const admin = l.admin;
    const intakeId = r.intakeId;
    after(() => l.lib.afterIntakeSubmitted(admin, clientId, intakeId));
  }
  revalidatePath(`/c/${slug}/intake`);
  revalidatePath(`/c/${slug}/start`);
  return { ok: true, call: { type: call.type, reason: call.reason } };
}

/** Apple or Windows (the one thing the call needs), and that they booked it (Calendly tells the page) */
export async function callDetails(slug: string, d: { computer?: "Apple" | "PC/Windows"; booked?: boolean }) {
  const l = await load(slug);
  if ("error" in l) return { ok: false as const, error: l.error! };
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (d.computer && ["Apple", "PC/Windows"].includes(d.computer)) patch.computer = d.computer;
  if (d.booked) patch.call_booked_at = new Date().toISOString();
  await l.admin.from("client_intake_forms").update(patch).eq("client_id", l.client.id);
  if (d.booked) {
    const { tellGuideTeam } = await import("@/lib/onboarding-guide");
    const { data: f } = await l.admin.from("client_intake_forms").select("call_type, computer").eq("client_id", l.client.id).maybeSingle();
    await tellGuideTeam(l.admin, l.client.id as string, "booked their onboarding call", `${l.by} booked a ${f?.call_type === "dfy" ? "done-for-you" : "done-with-you"} onboarding call${f?.computer ? ` (on ${f.computer})` : ""}. It's in the Calendly calendar.`, `call-booked:${l.client.id}`, "normal");
  }
  revalidatePath(`/c/${slug}/intake`);
  return { ok: true as const };
}
