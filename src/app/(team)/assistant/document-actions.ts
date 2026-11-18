"use server";

import { requireStaff } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { toLoose, type DocContent } from "@/lib/documents/core";
import type { CallDocument } from "@/lib/agent-call/core";

// The document card's Edit (change the text and draw it again) and a drafted email's Open in Gmail (the PDF attached
// when the app may write drafts in their Gmail; else a prefilled compose that says which PDF to attach). Nothing here
// sends anything.

type Fail = { ok: false; error: string };

/** The editable text of a document: what the card's Edit sheet shows */
export type DocText = { title: string; subtitle: string; period: string; summary: string; sections: { heading: string; body: string; bullets: string }[]; inclusions: string; exclusions: string; nextSteps: string };

const lines = (v: string) =>
  v
    .split("\n")
    .map((x) => x.replace(/^\s*[-•*]\s*/, "").trim())
    .filter(Boolean);

export async function documentText(id: string): Promise<{ ok: true; text: DocText } | Fail> {
  await requireStaff();
  const db = await createClient();
  const { data } = await db.from("kaizen_documents").select("content").eq("id", id).maybeSingle();
  if (!data) return { ok: false, error: "That document isn't one you can open." };
  const d = data.content as DocContent;
  return {
    ok: true,
    text: {
      title: d.title ?? "",
      subtitle: d.subtitle ?? "",
      period: d.period ?? "",
      summary: d.summary ?? "",
      sections: (d.sections ?? []).map((s) => ({ heading: s.heading, body: s.body, bullets: (s.bullets ?? []).join("\n") })),
      inclusions: (d.inclusions ?? []).join("\n"),
      exclusions: (d.exclusions ?? []).join("\n"),
      nextSteps: (d.nextSteps ?? []).join("\n"),
    },
  };
}

/** The text changed: the same document drawn again as its next version (prices are guarded again) */
export async function redrawDocument(id: string, text: DocText): Promise<{ ok: true; document: CallDocument } | Fail> {
  const me = await requireStaff();
  const db = await createClient();
  const { data } = await db.from("kaizen_documents").select("id, client_id, content").eq("id", id).maybeSingle();
  if (!data) return { ok: false, error: "That document isn't one you can change." };
  const prior = data.content as DocContent & { service?: string; dataFigures?: number[] };
  let client: { id: string; name: string } | null = null;
  if (data.client_id) {
    const { data: c } = await db.from("clients").select("id, name").eq("id", data.client_id as string).maybeSingle();
    if (!c) return { ok: false, error: "That client isn't one you can see." };
    client = { id: c.id as string, name: c.name as string };
  }
  const loose = {
    ...toLoose(prior),
    title: text.title,
    subtitle: text.subtitle,
    period: text.period,
    summary: text.summary,
    sections: text.sections.map((s) => ({ heading: s.heading, body: s.body, bullets: lines(s.bullets) })),
    inclusions: lines(text.inclusions),
    exclusions: lines(text.exclusions),
    next_steps: lines(text.nextSteps),
  };
  try {
    const { makeDocument } = await import("@/lib/documents/server");
    const made = await makeDocument({ admin: createAdminClient(), me: { id: me.id, fullName: me.fullName }, client, loose, service: prior.service, dataFigures: prior.dataFigures ?? [], id });
    return { ok: true, document: { id: made.id, kind: made.kind, title: made.title, client: made.client, version: made.version, href: made.href, download: made.download, placeholders: made.placeholders } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "It couldn't be drawn again. Try once more." };
  }
}

/**
 * A drafted email on the call, opened in Gmail as a draft with its files attached (when the app may write drafts
 * there), else a prefilled compose with a line naming the PDF to attach. Only the call's own person.
 */
export async function openCallDraftInGmail(callId: string, draftId: string): Promise<{ ok: true; where: "gmail" | "link"; href: string } | Fail> {
  const me = await requireStaff();
  const admin = createAdminClient();
  const { data: call } = await admin.from("ai_role_calls").select("profile_id").eq("id", callId).maybeSingle();
  if (!call || call.profile_id !== me.id) return { ok: false, error: "That isn't your conversation." };
  const [{ getDraft, putDraft }, { attachNote, mailFiles }, { composeLinks }, { addressOf, rawEmail }] = await Promise.all([import("@/lib/assistant/handoff-server"), import("@/lib/documents/attach"), import("@/lib/email-drafts/core"), import("@/lib/assistant/messages")]);
  const d = await getDraft(admin, callId, draftId);
  if (!d?.email) return { ok: false, error: "That email draft isn't on this conversation any more." };
  const e = d.email;
  const files = d.attachments ?? [];
  const link = composeLinks({ to: [addressOf(e.to)], subject: e.subject, body: `${d.text}${attachNote(files)}` }).gmail;
  if (e.mailbox.toLowerCase() !== me.email.toLowerCase()) return { ok: true, where: "link", href: link };
  const { gmailComposeToken, googleConfigured, googlePost } = await import("@/lib/context/google");
  if (!googleConfigured()) return { ok: true, where: "link", href: link };
  try {
    const { attached, missing } = await mailFiles(admin, files);
    if (missing.length) throw new Error(`files missing: ${missing.join(", ")}`);
    const raw = rawEmail({ from: `${me.fullName} <${e.mailbox}>`, to: e.to, cc: e.cc ?? null, subject: e.subject, body: d.text, inReplyTo: e.inReplyTo ?? null, references: e.references ?? null, attachments: attached });
    const token = await gmailComposeToken(e.mailbox);
    const made = await googlePost<{ id: string; message?: { id: string } }>(token, "https://gmail.googleapis.com/gmail/v1/users/me/drafts", { message: { raw, ...(e.threadId ? { threadId: e.threadId } : {}) } });
    await putDraft(admin, callId, { ...d, sent: "gmail_draft" });
    if (d.clientDraftId) await admin.from("client_email_drafts").update({ status: "opened", gmail_draft_id: made.id, updated_at: new Date().toISOString() }).eq("id", d.clientDraftId).eq("owner_id", me.id);
    return { ok: true, where: "gmail", href: made.message?.id ? `https://mail.google.com/mail/u/0/#drafts?compose=${made.message.id}` : "https://mail.google.com/mail/u/0/#drafts" };
  } catch (err) {
    console.error("[call draft] gmail draft", err instanceof Error ? err.message : err);
    return { ok: true, where: "link", href: link };
  }
}
