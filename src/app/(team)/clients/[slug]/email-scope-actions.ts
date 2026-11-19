"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { seesEmailBoard } from "@/lib/roles";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { SowScope } from "@/lib/email-allotment-core";

// The client page's Allotment and SOW tab (Email): the Scope of Work (found in
// what Kaizen reads, or uploaded here, also to replace it when the scope changes: the months follow it), a month set
// by hand, and drafting this month's requests from the SOW now. The email team and the executives use it.

type Fail = { ok: false; error: string };
const fail = (e: unknown): Fail => ({ ok: false, error: e instanceof Error ? e.message : "Something went wrong." });
const BUCKET = "client-docs";
const SOW_TYPES = ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain", "text/markdown"];

async function guard(clientId: string, opts: { package?: boolean } = {}) {
  const me = await requireStaff();
  if (!adminConfigured()) throw new Error("Not set up.");
  if (opts.package ? !(me.isExec || me.isLead) : !(seesEmailBoard(me) || me.isExec || me.isLead)) throw new Error(opts.package ? "Only an executive or a lead sets a client's package." : "The email team and the executives manage the email scope.");
  const db = await createClient();
  const { data: c } = await db.from("clients").select("id, slug").eq("id", clientId).maybeSingle();
  if (!c) throw new Error("That client isn't one you work on.");
  return { me, admin: createAdminClient(), slug: c.slug as string };
}

/** One month's allotment set by hand (kept over the SOW's for that month) */
export async function setScopeMonth(clientId: string, month: string, n: { campaigns: number; sms: number; flows: number; flowEmails: number }): Promise<{ ok: true } | Fail> {
  try {
    const { me, admin, slug } = await guard(clientId);
    if (!/^\d{4}-\d{2}-01$/.test(month)) return { ok: false, error: "Pick a month." };
    const w = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
    // Set by hand: one number per pool (the bottom of the range is the same)
    const c = w(n.campaigns, 60);
    const t = w(n.sms, 40);
    const fe = w(n.flowEmails, 60);
    await admin
      .from("email_scope_months")
      .upsert({ client_id: clientId, month, campaigns: c, campaigns_min: c, sms: t, sms_min: t, flows: w(n.flows, 20), flow_emails: fe, flow_emails_min: fe, source: "manual", updated_by: me.id, updated_at: new Date().toISOString() }, { onConflict: "client_id,month" });
    revalidatePath(`/clients/${slug}`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Where to upload the SOW file (straight to storage) */
export async function sowUploadSlot(clientId: string, name: string, mime: string, bytes: number): Promise<{ ok: true; path: string; token: string } | Fail> {
  try {
    const { admin } = await guard(clientId);
    const ext = name.toLowerCase().split(".").pop() ?? "";
    if (!SOW_TYPES.includes(mime) && !["pdf", "docx", "txt", "md"].includes(ext)) return { ok: false, error: "Upload the SOW as a PDF or a Word file (.docx)." };
    if (bytes > 25_000_000) return { ok: false, error: "That file is over 25 MB." };
    const safe = name.replace(/[^\w.-]+/g, "-").slice(-80) || "sow";
    const { data, error } = await admin.storage.from(BUCKET).createSignedUploadUrl(`sows/${clientId}/${Date.now()}-${safe}`);
    if (error || !data) return { ok: false, error: "Couldn't get the upload ready. Try again." };
    return { ok: true, path: data.path, token: data.token };
  } catch (e) {
    return fail(e);
  }
}

/** The uploaded SOW: read, kept (the one before it marked replaced), and its months set as the allotment */
export async function sowUploaded(clientId: string, path: string, name: string, mime: string): Promise<{ ok: true; scope: SowScope | null; note?: string } | Fail> {
  try {
    const { me, admin, slug } = await guard(clientId);
    if (!path.startsWith(`sows/${clientId}/`)) return { ok: false, error: "That upload isn't this client's." };
    const { data: blob, error } = await admin.storage.from(BUCKET).download(path);
    if (error || !blob) return { ok: false, error: "The upload didn't arrive. Try again." };
    const { fileText } = await import("@/lib/assistant/read-file");
    const read = await fileText(Buffer.from(await blob.arrayBuffer()), name, mime);
    if (read.text.length < 100) return { ok: false, error: read.note ? `${read.note}. Upload a PDF with text or a Word file.` : "There's no text in that file to read. Upload a PDF with text or a Word file." };
    const { saveSow } = await import("@/lib/email-sow");
    const r = await saveSow(admin, clientId, { found_in: "upload", external_id: null, name, url: null, bucket: BUCKET, path, mime, text: read.text }, me.id);
    revalidatePath(`/clients/${slug}`);
    return { ok: true, scope: r.scope, note: r.error };
  } catch (e) {
    return fail(e);
  }
}

/** Look for the SOW again in what Kaizen reads (Drive, Gmail, the client's documents) */
export async function findSowNow(clientId: string): Promise<{ ok: true; found: string | null } | Fail> {
  try {
    const { me, admin, slug } = await guard(clientId);
    const { findSow, saveSow } = await import("@/lib/email-sow");
    const s = await findSow(admin, clientId);
    if (!s) return { ok: true, found: null };
    await saveSow(admin, clientId, s, me.id);
    revalidatePath(`/clients/${slug}`);
    return { ok: true, found: s.name };
  } catch (e) {
    return fail(e);
  }
}

/** Draft this SOW month's requests now (copy and all), for the client's Email Strategist; runs after the answer */
export async function draftScopeNow(clientId: string): Promise<{ ok: true } | Fail> {
  try {
    await guard(clientId);
    after(async () => {
      const { draftScopeMonth } = await import("@/lib/email-sow");
      await draftScopeMonth(createAdminClient(), clientId).catch((e) => console.error("[email sow draft now]", e));
    });
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
