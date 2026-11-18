"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { cleanDraftText } from "@/lib/email-drafts/core";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// "Emails ready to send" on the Overview: open one (into their Gmail as a draft, or a prefilled compose link), edit it,
// dismiss it, or look for more. Nothing here sends an email.

type Result = { ok: true } | { ok: false; error: string };

export async function openEmailDraft(id: string): Promise<{ ok: true; href: string; where: "gmail" | "link" } | { ok: false; error: string }> {
  const me = await requireStaff();
  const { openDraft } = await import("@/lib/email-drafts/server");
  const r = await openDraft(createAdminClient(), me, id);
  revalidatePath("/pipeline");
  return r;
}

export async function editEmailDraft(id: string, subject: string, body: string): Promise<Result> {
  await requireStaff();
  const s = cleanDraftText(subject, 200).replace(/\s+/g, " ");
  const b = cleanDraftText(body, 8000);
  if (!s || !b) return { ok: false, error: "A subject and a message, please." };
  const db = await createClient();
  const { error } = await db.from("client_email_drafts").update({ subject: s, body: b, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) return { ok: false, error: "It didn't save." };
  revalidatePath("/pipeline");
  return { ok: true };
}

export async function dismissEmailDraft(id: string, status: "dismissed" | "sent" = "dismissed"): Promise<Result> {
  await requireStaff();
  const db = await createClient();
  const { error } = await db.from("client_email_drafts").update({ status, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) return { ok: false, error: "It didn't save." };
  revalidatePath("/pipeline");
  return { ok: true };
}

export async function scanForEmails(): Promise<{ ok: true; added: number } | { ok: false; error: string }> {
  const me = await requireStaff();
  try {
    const { scanForPerson } = await import("@/lib/email-drafts/server");
    const r = await scanForPerson(createAdminClient(), me, { max: 15 });
    revalidatePath("/pipeline");
    return { ok: true, added: r.added };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "It couldn't look right now." };
  }
}
