import "server-only";
import { mayEditSetup, SETUP_REFUSAL } from "@/lib/setup-access";
import { clientNamed } from "@/lib/client-named";
import type { Staff } from "@/lib/auth";
import { seesEmailBoard } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { emailAllotmentLine, emailPace, emailPools } from "@/lib/email-allotment-core";
import { assertMaySee } from "@/lib/ai-access";
import { accessFor } from "./access";
import { str, type AiTool } from "./types";

// The email allotment and Scope of Work, for the assistant, Kaizen AI and every agent on a call (registered in
// src/lib/kaizen-ai/extensions.ts):
//   email_allotment      a client's campaigns and flows this cycle (delivered and in motion count; a flow once), where
//                        the cap comes from (the SOW's month, a month set by hand, the package), the SOW and its months;
//                        or every email client behind or over pace
//   find_email_sow       look again for the client's SOW in what Kaizen reads (Drive, Gmail, documents) and read it
//   draft_sow_requests   draft this SOW month's requests now (copy and all) for the client's Email Strategist
//   adjust_email_scope   change the SOW's months from what the person says (only the sprint signed, another option)
//   send_client_sheet    a client who supplies their own content: their sheet straight to the designer
// The request form: open_screen place 'new email request'; the tab: the client page, Email, Allotment and SOW.

const emailAllotment: AiTool = {
  name: "email_allotment",
  description:
    "A client's email allotment this billing cycle, four pools each a range paced against its top: campaign emails, SMS messages, flows (each flow request counts once) and flow emails (new or optimization). Used (asked this cycle plus anything still in motion), what's in progress, where the cap comes from (a month set by hand, their Scope of Work's month, the 3-Month Initial Setup's month by its start date, or their tier: Basic, Silver, Gold or Custom; strategy-only clients hold no allotment), and their SOW with its month-by-month scope. Without a client: every email client grouped behind pace, on pace, over, or with no allotment set. Use it before planning email requests, and when asked what a client has left. To make a request: open_screen place 'new email request'.",
  input_schema: { type: "object", properties: { client: { type: "string", description: "A client name; leave out for every email client" } }, additionalProperties: false },
  lines: ["email"],
  run: async (user: Staff, input) => {
    const db = await createClient();
    const { emailAllotments } = await import("@/lib/email-request");
    if (str(input.client)) {
      const c = await clientNamed(db, input.client);
      await assertMaySee(await accessFor(user), c.id);
      const [all, { data: sow }, { data: months }] = await Promise.all([
        emailAllotments(db, [c.id]),
        db.from("client_sows").select("name, url, source, found_in, scope, status, created_at").eq("client_id", c.id).eq("line", "email").neq("status", "replaced").order("created_at", { ascending: false }).limit(1).maybeSingle(),
        db.from("email_scope_months").select("month, campaigns, flows, label, notes, source, drafted_at").eq("client_id", c.id).order("month").limit(24),
      ]);
      const a = all[c.id] ?? null;
      return {
        ok: true,
        client: c.name,
        allotment: a
          ? a.source === "strategy"
            ? { line: "Strategy only: no copy or design, so no allotment and no requests", from: "strategy" }
            : { line: emailAllotmentLine(a) ?? "No allotment set", pools: emailPools(a).map((p) => ({ pool: p.label, range: p.range, used: p.used, inProgress: p.progress, over: p.over })), from: a.source, label: a.label, monthNotes: a.notes, cycle: a.cycle, pace: emailPace(a).group }
          : null,
        sow: sow ? { name: sow.name, url: sow.url, how: sow.source === "upload" ? "uploaded" : `found in ${sow.found_in}`, summary: (sow.scope as { summary?: string } | null)?.summary ?? null, status: sow.status, at: String(sow.created_at).slice(0, 10) } : null,
        months: (months ?? []).map((m) => ({ month: String(m.month).slice(0, 7), campaigns: m.campaigns, flows: m.flows, label: m.label, notes: m.notes, from: m.source, drafted: Boolean(m.drafted_at) })),
        newRequest: `/board/email/new?client=${c.slug}`,
        clientPage: `/clients/${c.slug}`,
      };
    }
    const all = await emailAllotments(db);
    const { data: names } = await db.from("clients").select("id, name").in("id", Object.keys(all));
    const name = new Map((names ?? []).map((n) => [n.id as string, n.name as string]));
    const groups: Record<string, { client: string; line: string }[]> = { over: [], behind: [], pace: [], none: [] };
    for (const [id, a] of Object.entries(all)) {
      const line = emailAllotmentLine(a);
      const asked = a.campaigns.used + a.sms.used + a.flows.used;
      if (a.source === "strategy" || (!line && !asked)) continue;
      groups[emailPace(a).group].push({ client: name.get(id) ?? id, line: line ?? `No allotment set (${a.campaigns.used} campaigns, ${a.sms.used} SMS, ${a.flows.used} flows asked)` });
    }
    return { ok: true, ...groups };
  },
};

const findSow: AiTool = {
  name: "find_email_sow",
  description: "Look again for a client's Scope of Work in what Kaizen reads (their Drive, Gmail, their documents, a SOW drawn in Kaizen OS) and read its email scope month by month as their allotment. When nothing is found, say they can upload it on the client page (Email, Allotment and SOW).",
  input_schema: { type: "object", properties: { client: { type: "string" } }, required: ["client"], additionalProperties: false },
  lines: ["email"],
  run: async (user: Staff, input) => {
    // The client's scope is Team & setup: executives and team leads (the head of email among them)
    if (!mayEditSetup(user)) return { ok: false, error: SETUP_REFUSAL };
    const db = await createClient();
    const c = await clientNamed(db, input.client);
    await assertMaySee(await accessFor(user), c.id);
    const admin = createAdminClient();
    const { findSow, saveSow } = await import("@/lib/email-sow");
    const s = await findSow(admin, c.id);
    if (!s) return { ok: true, found: false, say: `No SOW for ${c.name} in their Drive, emails or documents yet. Upload it on the client page: Email, Allotment and SOW.`, page: `/clients/${c.slug}` };
    const r = await saveSow(admin, c.id, s, user.id);
    return { ok: true, found: true, name: s.name, scope: r.scope, note: r.error ?? null };
  },
};

const draftSow: AiTool = {
  name: "draft_sow_requests",
  description: "Draft this SOW month's email requests now for a client (campaigns batched up to 5 per copy doc, each flow its own, copy written), for their Email Strategist to review on the request form. Only for a client whose current month comes from their SOW. Say what you'll draft and ask first.",
  input_schema: { type: "object", properties: { client: { type: "string" } }, required: ["client"], additionalProperties: false },
  lines: ["email"],
  run: async (user: Staff, input) => {
    if (!seesEmailBoard(user) && !user.isLead) return { ok: false, error: "The email team and the executives draft email requests." };
    const db = await createClient();
    const c = await clientNamed(db, input.client);
    await assertMaySee(await accessFor(user), c.id);
    const { draftScopeMonth } = await import("@/lib/email-sow");
    const r = await draftScopeMonth(createAdminClient(), c.id);
    return r.drafted ? { ok: true, drafted: r.drafted, review: `/board/email/new?client=${c.slug}` } : { ok: false, error: r.reason ?? "Nothing to draft." };
  },
};

const adjustScope: AiTool = {
  name: "adjust_email_scope",
  description:
    "Adjust a client's email scope (their SOW months) from what the person says: \"they only signed the 1-month sprint, months 2 and 3 were just pitched\" (those months marked not signed, holding no allotment, reopenable), \"they picked Option B\", \"December is 5 campaigns, not 3\". First call without confirmed: it returns the proposed changes; say them and ask. Call again with confirmed: true and the same words to apply them (a dated note of why is kept). Never deletes a month.",
  input_schema: { type: "object", properties: { client: { type: "string" }, what_changed: { type: "string" }, confirmed: { type: "boolean" } }, required: ["client", "what_changed"], additionalProperties: false },
  lines: ["email"],
  run: async (user: Staff, input) => {
    // The client's scope is Team & setup: executives and team leads (the head of email among them)
    if (!mayEditSetup(user)) return { ok: false, error: SETUP_REFUSAL };
    const db = await createClient();
    const c = await clientNamed(db, input.client);
    await assertMaySee(await accessFor(user), c.id);
    const said = str(input.what_changed);
    if (!said) return { ok: false, error: "Say what changed." };
    const admin = createAdminClient();
    const { proposeScopeChanges, applyScopeChanges } = await import("@/lib/email-sow");
    const p = await proposeScopeChanges(admin, c.id, [{ role: "you", text: said }]);
    if (!p.changes.length) return { ok: true, applied: 0, reply: p.reply };
    if (input.confirmed !== true) return { ok: true, proposed: p.changes.map((x) => ({ month: x.month.slice(0, 7), action: x.action, campaigns: x.campaigns, sms: x.sms, flows: x.flows, flow_emails: x.flow_emails, why: x.why })), note: p.note, ask: "Say these changes and ask before applying (call again with confirmed: true)." };
    const applied = await applyScopeChanges(admin, c.id, p.changes, p.note, user.id, "chat");
    return { ok: true, applied, note: p.note, page: `/clients/${c.slug}` };
  },
};

const sendClientSheet: AiTool = {
  name: "send_client_sheet",
  description:
    "For a client whose team supplies the content (images, copy and CTA links in their Google Sheet): send the sheet straight to the client's email designer as one Asana task in Ready for Design, every field filled, counting against the allotment. No plan, brief or copy. First call without confirmed: it reads the sheet and returns the emails in it; say them and ask. Call again with confirmed: true to send. sheet_url: their Google Sheet (leave out to reuse last week's); count: emails in it when the sheet can't be read; note: anything for the designer.",
  input_schema: { type: "object", properties: { client: { type: "string" }, sheet_url: { type: "string" }, count: { type: "integer" }, note: { type: "string" }, priority: { type: "string", enum: ["low", "normal", "high", "urgent"] }, confirmed: { type: "boolean" } }, required: ["client"], additionalProperties: false },
  lines: ["email"],
  run: async (user: Staff, input) => {
    if (!seesEmailBoard(user)) return { ok: false, error: "Email requests are for the email team and the executives." };
    const db = await createClient();
    const c = await clientNamed(db, input.client);
    const admin = createAdminClient();
    const { suppliesContent, readSuppliedSheet, sheetLines } = await import("@/lib/email-supplied");
    const sup = await suppliesContent(admin, c.id);
    const url = str(input.sheet_url) ?? sup.sheet;
    if (!url) return { ok: false, error: "Ask for their Google Sheet's link." };
    const read = await readSuppliedSheet(c.id, url, user.email ?? null).catch(() => null);
    const emails = read?.ok ? read.emails : [];
    const count = Math.max(1, Math.min(5, Number(input.count) || emails.length || 1));
    if (input.confirmed !== true)
      return { ok: true, client: c.name, supplies_content: sup.on, sheet: url, read: read?.ok ? { title: read.title, summary: read.summary, emails } : { error: read && !read.ok ? read.say : "Couldn't read it" }, count, ask: "Say what's in the sheet and ask before sending (call again with confirmed: true)." };
    const { createSuppliedRequest } = await import("@/lib/deliverables/server");
    const r = await createSuppliedRequest(admin, { id: user.id, fullName: user.fullName, email: user.email ?? null }, {
      clientId: c.id,
      sheetUrl: url,
      count,
      channel: read?.ok && read.channel === "sms" ? "sms" : "email",
      shortName: (read?.ok && read.title ? read.title : "Weekly campaigns").slice(0, 80),
      note: str(input.note) ?? null,
      urgency: (["low", "normal", "high", "urgent"] as const).find((p) => p === input.priority) ?? "normal",
      emailsText: emails.length ? sheetLines(c.name, emails) : null,
      summary: read?.ok ? read.summary : null,
    });
    return r.ok ? { ok: true, task: r.task.name, url: r.task.url, designer: r.designer, note: r.designerMissing } : r;
  },
};

export const tools: AiTool[] = [emailAllotment, findSow, draftSow, adjustScope, sendClientSheet];
