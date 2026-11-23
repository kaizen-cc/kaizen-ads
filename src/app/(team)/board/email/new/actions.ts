"use server";

import { requireStaff } from "@/lib/auth";
import { seesEmailBoard } from "@/lib/roles";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { EmailKind, Plan, StartData } from "@/lib/email-request";

// The email request form: where to start for a client (their own ideas, what worked for similar brands, the flows
// they're missing, copy drafted from their SOW), the Email Strategist's plan, the Copywriter's copy document from it,
// and what the one batched Asana request will hold. The copy document itself (edits, comments, approval into the
// client's HQ Drive, the Asana request) has its own actions (src/app/(team)/copy/actions.ts). AI-written requests
// skip a second review, and nothing about the client's sign-off or assets ever holds one back.

type Fail = { ok: false; error: string };
const fail = (e: unknown): Fail => ({ ok: false, error: e instanceof Error ? e.message : "Something went wrong." });
const NOT_EMAIL = "The email request form is for the email team and the executives.";

async function who() {
  const me = await requireStaff();
  if (!seesEmailBoard(me) || !adminConfigured()) throw new Error(NOT_EMAIL);
  return { me: { id: me.id, fullName: me.fullName, email: me.email ?? null }, db: await createClient(), admin: createAdminClient() };
}

/** Can this person see the client? (read through their own session) */
async function client(db: Awaited<ReturnType<typeof createClient>>, id: string) {
  const { data } = await db.from("clients").select("id, name").eq("id", id).maybeSingle();
  if (!data) throw new Error("Pick a client you work on.");
  return data as { id: string; name: string };
}

/** Where to start for one client */
export async function startFor(clientId: string): Promise<{ ok: true; data: StartData } | Fail> {
  try {
    const { db, admin } = await who();
    await client(db, clientId);
    const { emailStartData } = await import("@/lib/email-request");
    return { ok: true, data: await emailStartData(admin, db, clientId) };
  } catch (e) {
    return fail(e);
  }
}

const KINDS: EmailKind[] = ["campaign", "flow", "sms", "sms_flow"];
const PRIORITIES = ["urgent", "high", "normal", "low"];

/** The Email Strategist plans the emails (one line each), for the person to change before the copy is written */
export async function planRequest(input: { clientId: string; kind: EmailKind; count: number; idea: string; month: string | null; priority: string }): Promise<{ ok: true; plan: Plan } | Fail> {
  try {
    const { db, admin } = await who();
    await client(db, input.clientId);
    if (!KINDS.includes(input.kind)) return { ok: false, error: "Pick campaigns, a flow or texts." };
    const max = input.kind === "flow" || input.kind === "sms_flow" ? 6 : 5;
    const count = Math.max(1, Math.min(max, Math.round(input.count) || 1));
    const { planEmails } = await import("@/lib/email-request");
    return { ok: true, plan: await planEmails(admin, input.clientId, { kind: input.kind, count, idea: input.idea, month: input.month, priority: PRIORITIES.includes(input.priority) ? input.priority : "normal" }) };
  } catch (e) {
    return fail(e);
  }
}

/** The Copywriter writes the copy document from the agreed plan (or writes it again into the same document) */
export async function writeCopy(input: { clientId: string; kind: EmailKind; plan: Plan; priority: string; month: string | null; suggestionId: string | null; docId: string | null }): Promise<{ ok: true; docId: string } | Fail> {
  try {
    const { me, db, admin } = await who();
    await client(db, input.clientId);
    if (!input.plan.items.length) return { ok: false, error: "The plan needs at least one email." };
    const { writeRequestCopy } = await import("@/lib/email-request");
    const doc = await writeRequestCopy(admin, db, me, { clientId: input.clientId, kind: input.kind, plan: input.plan, priority: PRIORITIES.includes(input.priority) ? input.priority : "normal", month: input.month, docId: input.docId });
    if (input.suggestionId) await admin.from("email_suggestions").update({ status: "in_motion", status_by: me.id, status_at: new Date().toISOString() }).eq("id", input.suggestionId).eq("client_id", input.clientId);
    return { ok: true, docId: doc.id };
  } catch (e) {
    return fail(e);
  }
}

export type SendPreview = { name: string; project: string; column: string; fields: { name: string; value: string }[]; follower: string | null; folder: string; emails: number; counts: string };

/** What the Asana request will hold, before it's made: its name, column, every field, the strategist following */
export async function sendPreview(docId: string): Promise<{ ok: true; preview: SendPreview } | Fail> {
  try {
    const { db, admin } = await who();
    const { loadCopyDoc, clientFacts } = await import("@/lib/copy-docs/server");
    const d = await loadCopyDoc(db, docId);
    if (!d?.clientId) return { ok: false, error: "That copy isn't one you can request." };
    const [{ EMAIL_LINE }, { kindOf }, { purposeText }] = await Promise.all([import("@/lib/deliverables/lines/email"), import("@/lib/deliverables/engine"), import("@/lib/copy-docs/core")]);
    const facts = await clientFacts(admin, d.clientId, "email");
    const kind = kindOf(EMAIL_LINE, d.content.kind) ?? EMAIL_LINE.kinds[0];
    const pr = String(d.origin?.priority ?? "normal");
    const input = {
      client: { name: facts.name, kaizenId: facts.kaizenId, website: facts.website, hqUrl: facts.hqUrl, figma: facts.figma, platform: facts.platform },
      kind,
      shortName: d.content.shortName || d.content.title,
      count: d.content.emails.length,
      docUrl: d.docUrl ?? "(the Google Doc, made when you approve)",
      purpose: purposeText(d.content),
      urgency: (["urgent", "high", "normal", "low"].includes(pr) ? pr : "normal") as "urgent" | "high" | "normal" | "low",
    };
    const { data: seat } = await admin.from("client_assignments").select("profiles(full_name)").eq("client_id", d.clientId).eq("role", "email_strategist").order("is_primary", { ascending: false }).limit(1).maybeSingle();
    const n = d.content.emails.length;
    return {
      ok: true,
      preview: {
        name: EMAIL_LINE.asana.taskName(input),
        project: "Email Marketing",
        column: EMAIL_LINE.asana.section,
        fields: EMAIL_LINE.asana.fields(input).map((f) => ({ name: f.name, value: f.value })),
        follower: (seat?.profiles as unknown as { full_name: string } | null)?.full_name ?? null,
        folder: `Clients › ${facts.kaizenId ?? "ID"}-${facts.name} › ${facts.name}-Headquarters › Email Marketing`,
        emails: d.content.emails.length,
        counts: d.content.kind === "flow" ? `1 flow, ${n} flow email${n === 1 ? "" : "s"}` : `${n} ${d.content.kind === "sms" ? "text" : "campaign"}${n === 1 ? "" : "s"}`,
      },
    };
  } catch (e) {
    return fail(e);
  }
}

// ─── Client supplies the content ─────────────────────────────────────────────

/** Read the client's own campaign sheet: the emails in it, for the ticket's summary and the count */
export async function readClientSheet(clientId: string, url: string): Promise<{ ok: true; sheet: Extract<import("@/lib/email-supplied").SheetRead, { ok: true }> } | Fail> {
  try {
    const { me, db } = await who();
    await client(db, clientId);
    if (!/^https:\/\/(docs|drive)\.google\.com\//.test(url.trim())) return { ok: false, error: "Paste the Google Sheet's link." };
    const { readSuppliedSheet } = await import("@/lib/email-supplied");
    const r = await readSuppliedSheet(clientId, url.trim(), me.email);
    return r.ok ? { ok: true, sheet: r } : { ok: false, error: r.say };
  } catch (e) {
    return fail(e);
  }
}

/** Send the client's sheet straight to their email designer: one Asana task in Ready for Design, every field filled */
export async function sendClientSheet(input: { clientId: string; url: string; count: number; channel: "email" | "sms"; name: string; note: string; priority: string; emails: { name: string; send: string; subject: string; cta: string }[]; summary: string | null }): Promise<{ ok: true; task: { name: string; url: string }; designer: string | null; note: string | null } | Fail> {
  try {
    const { me, db, admin } = await who();
    await client(db, input.clientId);
    if (!/^https:\/\/(docs|drive)\.google\.com\//.test(input.url.trim())) return { ok: false, error: "Paste the Google Sheet's link." };
    const { createSuppliedRequest } = await import("@/lib/deliverables/server");
    const { sheetLines } = await import("@/lib/email-supplied");
    const urgency = (["urgent", "high", "normal", "low"] as const).find((u) => u === input.priority) ?? "normal";
    const r = await createSuppliedRequest(admin, me, {
      clientId: input.clientId,
      sheetUrl: input.url.trim(),
      count: input.count,
      channel: input.channel,
      shortName: input.name.trim().slice(0, 80) || "Weekly campaigns",
      note: input.note.trim().slice(0, 1000) || null,
      urgency,
      emailsText: input.emails.length ? sheetLines(input.emails) : null,
      summary: input.summary,
    });
    if (!r.ok) return r;
    return { ok: true, task: { name: r.task.name, url: r.task.url }, designer: r.designer, note: r.designerMissing ?? r.task.followerMissing };
  } catch (e) {
    return fail(e);
  }
}
