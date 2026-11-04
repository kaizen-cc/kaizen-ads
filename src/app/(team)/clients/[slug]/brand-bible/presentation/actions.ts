"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// The team's side of the client presentation: the client's media buyer or a lead sends it (or holds it, so it doesn't
// go out on its own), asks for a change, or writes it again.

type Result = { ok: true; note?: string } | { ok: false; error: string };

async function allowed(clientId: string) {
  const me = await requireStaff();
  if (!adminConfigured()) return { error: "Server key missing." } as const;
  const { data: mine } = await (await createClient()).from("clients").select("id, slug").eq("id", clientId).maybeSingle();
  if (!mine) return { error: "You don't work on this client." } as const;
  const admin = createAdminClient();
  if (!isExecOrLead(me)) {
    const { data: buyer } = await admin.from("client_assignments").select("profile_id").eq("client_id", clientId).eq("role", "meta_buyer").eq("profile_id", me.id).maybeSingle();
    if (!buyer) return { error: "Only the client's media buyer or a lead can do this." } as const;
  }
  return { me, admin, slug: mine.slug as string } as const;
}

const refresh = (slug: string) => {
  revalidatePath(`/clients/${slug}/brand-bible/presentation`);
  revalidatePath(`/c/${slug}/plan`);
};

export async function sendPresentationNow(clientId: string): Promise<Result> {
  const a = await allowed(clientId);
  if ("error" in a) return { ok: false, error: a.error! };
  const { sendPresentation } = await import("@/lib/presentation");
  const r = await sendPresentation(a.admin, clientId, a.me.id);
  refresh(a.slug);
  return r.ok ? { ok: true, note: `Sent to ${r.sent.join(", ")}` } : r;
}

/** Hold: it won't go out on its own. Resume: back on the 24-hour clock from now. */
export async function holdPresentation(clientId: string, hold: boolean): Promise<Result> {
  const a = await allowed(clientId);
  if ("error" in a) return { ok: false, error: a.error! };
  const { error } = await a.admin
    .from("client_presentations")
    .update(hold ? { status: "held" } : { status: "draft", error: null, send_after: (await import("@/lib/brand-bible")).addBusinessDays(new Date(), 1).toISOString() })
    .eq("client_id", clientId)
    .in("status", hold ? ["draft"] : ["held"]);
  refresh(a.slug);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Write it (again), from the Bible; with a change, the current one is revised to match. Runs in the background. */
export async function rewritePresentation(clientId: string, change: string): Promise<Result> {
  const a = await allowed(clientId);
  if ("error" in a) return { ok: false, error: a.error! };
  const { data: p } = await a.admin.from("client_presentations").select("status").eq("client_id", clientId).maybeSingle();
  const { data: b } = await a.admin.from("client_brand_bibles").select("markdown, version").eq("client_id", clientId).maybeSingle();
  if (!b?.markdown) return { ok: false, error: "There's no Brand Bible to build it from yet." };
  // Already with the client: a new version is drafted beside it (theirs stays exactly as it is)
  const withClient = p && ["sent", "approved"].includes(p.status as string);
  if (withClient) {
    const { data: busy } = await a.admin.from("client_presentation_versions").select("id").eq("client_id", clientId).eq("status", "writing").gte("started_at", new Date(Date.now() - 30 * 60_000).toISOString()).limit(1);
    if (busy?.length) return { ok: true, note: "A new version is already being written." };
  } else await a.admin.from("client_presentations").upsert({ client_id: clientId, status: "writing", started_at: new Date().toISOString(), error: null });
  const { writePresentation } = await import("@/lib/presentation");
  after(() => writePresentation(a.admin, clientId, change.trim() || undefined).then(() => refresh(a.slug)));
  refresh(a.slug);
  return { ok: true, note: withClient ? "Writing a new version: the one they have stays as it is." : undefined };
}
