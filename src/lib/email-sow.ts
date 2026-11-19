import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cleanScope, SOW_NAME, type SowScope } from "@/lib/email-allotment-core";

// A client's Scope of Work for email (owner, Nov 19 2026). Onboarding months are scoped per client in the SOW, so the
// email allotment for those months comes from it, not the package. The SOW is found in what Kaizen already reads about
// the client once they close (their Drive folder, Gmail, the client's documents, a SOW the assistant drew), or uploaded
// on the client page's Email tab (also to replace it when the scope changes). The AI reads the email work per month;
// those months become the allotment (email_scope_months), and the current month's requests are drafted, copy and all,
// for the client's Email Strategist to review. Nothing is deleted: a replaced SOW is kept, marked replaced.

type Db = SupabaseClient;

export type SowSource = { found_in: "drive" | "gmail" | "documents" | "kaizen_documents" | "upload"; external_id: string | null; name: string; url: string | null; bucket?: string | null; path?: string | null; mime?: string | null; text: string };

const firstOfMonth = (d = new Date()) => `${d.toISOString().slice(0, 7)}-01`;

/** The SOW in what Kaizen already has for the client, newest first: Drive docs, a drawn SOW, the documents, Gmail */
export async function findSow(admin: Db, clientId: string): Promise<SowSource | null> {
  const [drive, drawn, docs, mail] = await Promise.all([
    admin.from("context_items").select("external_id, title, body, url, occurred_at").eq("client_id", clientId).eq("source", "drive").order("occurred_at", { ascending: false }).limit(400),
    admin.from("kaizen_documents").select("id, title, content, path, bucket, file_name").eq("client_id", clientId).eq("kind", "sow").order("created_at", { ascending: false }).limit(1),
    admin.from("client_documents").select("id, name, title, text, url, path, mime").eq("client_id", clientId).order("created_at", { ascending: false }).limit(100),
    admin.from("context_items").select("external_id, title, body, url, occurred_at").eq("client_id", clientId).eq("source", "gmail").order("occurred_at", { ascending: false }).limit(400),
  ]);
  // Drive files named like a SOW (not pictures): read as the Drive user the catalogue reads with
  for (const f of (drive.data ?? []).filter((x) => SOW_NAME.test(String(x.title ?? "")) && !/\.(png|jpe?g|gif|mp4|mov|webp)$/i.test(String(x.title ?? "")))) {
    const text = String(f.body ?? "").length > 400 ? String(f.body) : await driveText(String(f.url ?? "")).catch(() => "");
    if (text.length >= 200) return { found_in: "drive", external_id: (f.external_id as string | null) ?? null, name: String(f.title), url: (f.url as string | null) ?? null, text };
  }
  const d = drawn.data?.[0];
  if (d) return { found_in: "kaizen_documents", external_id: d.id as string, name: String(d.title), url: null, bucket: (d.bucket as string | null) ?? null, path: (d.path as string | null) ?? null, mime: "application/pdf", text: JSON.stringify(d.content).slice(0, 60000) };
  for (const x of (docs.data ?? []).filter((x) => SOW_NAME.test(`${x.name ?? ""} ${x.title ?? ""}`))) {
    const text = String(x.text ?? "");
    if (text.length >= 200) return { found_in: "documents", external_id: x.id as string, name: String(x.title ?? x.name), url: (x.url as string | null) ?? null, path: (x.path as string | null) ?? null, mime: (x.mime as string | null) ?? null, bucket: "client-docs", text };
  }
  // A SOW sent by email: its body (the scope is often written in it, or the doc linked)
  for (const m of (mail.data ?? []).filter((x) => SOW_NAME.test(String(x.title ?? "")))) {
    const body = String(m.body ?? "");
    const link = body.match(/https:\/\/docs\.google\.com\/[^\s>)"]+/)?.[0];
    const text = link ? await driveText(link).catch(() => "") : "";
    if (text.length >= 200) return { found_in: "drive", external_id: link ?? null, name: String(m.title), url: link ?? null, text };
    if (body.length >= 300 && /\b(email|campaign|flow|klaviyo|sms)\b/i.test(body)) return { found_in: "gmail", external_id: (m.external_id as string | null) ?? null, name: String(m.title), url: (m.url as string | null) ?? null, text: body };
  }
  return null;
}

/** A Google Doc or Drive file's text, read as the Drive user the catalogue reads with */
async function driveText(url: string) {
  const who = process.env.GOOGLE_DRIVE_USER;
  if (!url || !who) return "";
  const { readGoogleFile } = await import("@/lib/assistant/read-file");
  const r = await readGoogleFile(who, url);
  return r.ok ? r.text : "";
}

const RANGE = (what: string) => ({ type: "integer", description: what });

const SCOPE_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "Two or three sentences: what the SOW covers for email and SMS" },
    email_in_scope: { type: "boolean" },
    start: { type: "string", description: "When the engagement starts (month 1), YYYY-MM (the month after the SOW's date when not said)" },
    setup: { type: "string", enum: ["three_month", "sprint", "none"], description: "three_month: the 3-Month Initial Setup; sprint: a 1- or 2-month sprint; none: straight into ongoing" },
    ongoing_tier: { type: "string", enum: ["basic", "silver", "gold", ""], description: "The ongoing tier it names or recommends after setup" },
    months: {
      type: "array",
      description: "One entry per month the SOW scopes (each setup or sprint month, in order). When the SOW offers options, the one it recommends or the client chose.",
      items: {
        type: "object",
        properties: {
          month: { type: "string", description: "YYYY-MM" },
          label: { type: "string", description: "Setup month 1: Foundation, Month 2: Expansion, Sprint" },
          campaigns: RANGE("Campaign emails that month (the top of a range); warming-only months are 0"),
          campaigns_min: RANGE("The bottom of the range (the same as campaigns when one number)"),
          sms: RANGE("SMS campaign messages that month (the top of a range)"),
          sms_min: RANGE("The bottom of the range"),
          flows: RANGE("Flows built (or a flow optimization) that month; each flow counts once"),
          flow_emails: RANGE("Emails across flows that month, new or optimization (the top: 'up to 15 emails across all flows' is 15)"),
          flow_emails_min: RANGE("The bottom of the range"),
          notes: { type: "string", description: "The flows it names and anything else that month, one line" },
          signed: { type: "boolean", description: "False when this month is only pitched (a roadmap beyond what the client signed or is moving forward with)" },
        },
        required: ["month", "label", "campaigns", "campaigns_min", "sms", "sms_min", "flows", "flow_emails", "flow_emails_min", "notes", "signed"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "email_in_scope", "start", "setup", "ongoing_tier", "months"],
  additionalProperties: false,
};

/** What the SOW scopes for email, month by month */
export async function readSowScope(admin: Db, clientId: string, s: Pick<SowSource, "name" | "text">): Promise<SowScope> {
  const { askJson } = await import("@/lib/ai");
  const today = new Date().toISOString().slice(0, 10);
  const out = await askJson<SowScope>({
    agent: "email_calendar",
    label: "email sow read",
    clientId,
    schema: SCOPE_SCHEMA,
    maxTokens: 4000,
    override: { model: "sonnet", effort: "low" },
    system: `You read a Kaizen Marketing Scope of Work (or the email that carries it) for the email and SMS work only, month by month: campaign emails, SMS campaign messages, flows built or optimized (a flow counts once), and emails across flows. Kaizen's standard 3-Month Initial Setup is: month 1 Foundation (3 core flows, up to 15 flow emails, no campaigns), month 2 Expansion (2 more flows, up to 10 flow emails, 3 campaigns, 2 SMS), month 3 Ongoing (1 new flow or optimization of 5 emails, 5 campaigns, 2 SMS); a SOW may change any of it, and what it says wins. Domain-warming sends aren't campaigns. When the SOW offers several options, read the one it recommends or the client chose. Every pool is read into its own number, never folded into another or left at 0 when the SOW states it: "plus 2 SMS campaign messages" is sms 2; "4 to 6 SMS" is sms_min 4, sms 6; "up to 8 flow emails" is flow_emails 8; "3 to 5 flow optimization emails" is flow_emails_min 3, flow_emails 5. A range keeps both ends (min and max), never only the low end. An SOW often pitches a longer roadmap (month 2, month 3, an ongoing tier) while the client signs only the sprint or month 1: when it says the client is only moving forward with part of it, or the price or signature covers only the sprint, the months beyond it are signed false (we're only on the hook for what was signed). Never invent numbers the SOW doesn't give; when email isn't in it, email_in_scope false and no months. Today: ${today}.`,
    prompt: `<sow name="${s.name.replace(/"/g, "'")}">\n${s.text.slice(0, 60000)}\n</sow>`,
  });
  return cleanScope(out);
}

/**
 * Keep a SOW for the client (the one before it marked replaced), read it, and set the months it scopes as the email
 * allotment. A month someone set by hand stays as it is. Returns the new row's id and what was read.
 */
export async function saveSow(admin: Db, clientId: string, s: SowSource, by: string | null): Promise<{ id: string; scope: SowScope | null; error?: string }> {
  const { data: before } = await admin.from("client_sows").select("id").eq("client_id", clientId).eq("line", "email").eq("status", "active");
  const { data: row, error } = await admin
    .from("client_sows")
    .insert({ client_id: clientId, line: "email", source: s.found_in === "upload" ? "upload" : "found", found_in: s.found_in, external_id: s.external_id, name: s.name.slice(0, 300), url: s.url, bucket: s.bucket ?? null, path: s.path ?? null, mime: s.mime ?? null, text: s.text.slice(0, 200000), uploaded_by: by })
    .select("id")
    .single();
  if (error || !row) throw new Error(error?.message ?? "The SOW didn't save.");
  const id = row.id as string;
  const old = (before ?? []).map((b) => b.id as string);
  if (old.length) await admin.from("client_sows").update({ status: "replaced", replaced_at: new Date().toISOString() }).in("id", old);
  let scope: SowScope | null = null;
  try {
    scope = await readSowScope(admin, clientId, s);
  } catch (e) {
    await admin.from("client_sows").update({ status: "unreadable", note: e instanceof Error ? e.message.slice(0, 300) : "Couldn't read it" }).eq("id", id);
    return { id, scope: null, error: "The SOW was saved, but the AI couldn't read its email scope. Try again in a minute." };
  }
  await admin.from("client_sows").update({ scope, read_at: new Date().toISOString() }).eq("id", id);
  await applyScope(admin, clientId, id, scope, old);
  // The ongoing tier it names becomes theirs when none is set yet
  if (scope.ongoing_tier) await admin.from("clients").update({ email_package_key: scope.ongoing_tier, email_package_set_by: by, email_package_set_at: new Date().toISOString() }).eq("id", clientId).is("email_package_key", null);
  return { id, scope };
}

/** The SOW's months as the allotment (hand-set months kept); months the old SOW scoped and the new one doesn't, from this month on, are dropped */
export async function applyScope(admin: Db, clientId: string, sowId: string, scope: SowScope, replaced: string[] = []) {
  // Months a person set (by hand, or marked not signed or removed, through the chat or the buttons) stay as they are
  const { data: kept } = await admin.from("email_scope_months").select("month").eq("client_id", clientId).or("source.eq.manual,status_at.not.is.null");
  const keep = new Set((kept ?? []).map((m) => String(m.month)));
  const rows = scope.months
    .filter((m) => !keep.has(m.month))
    .map((m) => ({ client_id: clientId, month: m.month, campaigns: m.campaigns, campaigns_min: m.campaigns_min, sms: m.sms, sms_min: m.sms_min, flows: m.flows, flow_emails: m.flow_emails, flow_emails_min: m.flow_emails_min, label: m.label || null, notes: m.notes || null, source: "sow", sow_id: sowId, status: m.signed ? "active" : "unsigned", status_note: m.signed ? null : "Pitched in the SOW, not signed", updated_at: new Date().toISOString() }));
  if (rows.length) await admin.from("email_scope_months").upsert(rows, { onConflict: "client_id,month" });
  if (replaced.length) {
    const months = new Set(scope.months.map((m) => m.month));
    const { data: prior } = await admin.from("email_scope_months").select("month").eq("client_id", clientId).eq("source", "sow").in("sow_id", replaced).gte("month", firstOfMonth());
    const gone = (prior ?? []).map((p) => String(p.month)).filter((m) => !months.has(m));
    if (gone.length) await admin.from("email_scope_months").delete().eq("client_id", clientId).eq("source", "sow").in("month", gone);
  }
}

// ─── Drafting the month's requests ──────────────────────────────────────────

/**
 * The scoped month the client is in now (their SOW's, or the 3-Month Setup's): what's left of it drafted, copy and
 * all, for the client's Email Strategist to review on the request form: campaigns and texts batched up to 5 per copy
 * document, each flow its own with its share of the flow emails. Once per client and month.
 */
export async function draftScopeMonth(admin: Db, clientId: string): Promise<{ drafted: number; reason?: string }> {
  const { data: a } = await admin.from("client_email_allotment").select("*").eq("client_id", clientId).maybeSingle();
  if (!a?.period_start || (a.cap_source !== "sow" && a.cap_source !== "setup")) return { drafted: 0, reason: "No SOW or setup month now" };
  const month = `${String(a.period_start).slice(0, 7)}-01`;
  // What's already asked this cycle counts first: only what's left is drafted (against the top of each range)
  const left = (max: unknown, used: unknown) => Math.max(0, (Number(max) || 0) - (Number(used) || 0));
  const campaigns = left(a.campaigns_per_month, a.campaigns_used);
  const sms = left(a.sms_per_month, a.sms_used);
  const flows = left(a.flows_per_month, a.flows_used);
  const flowEmails = left(a.flow_emails_per_month, a.flow_emails_used);
  // Claimed first, so two runs never draft the same month twice
  const key = `email-draft:${clientId}:${month}`;
  const { data: claimed } = await admin.from("sync_state").upsert({ source: key, last_run_at: new Date().toISOString(), last_result: {} }, { onConflict: "source", ignoreDuplicates: true }).select("source");
  if (!claimed?.length) return { drafted: 0, reason: "Already drafted" };
  await admin.from("email_scope_months").update({ drafted_at: new Date().toISOString() }).eq("client_id", clientId).eq("month", month);
  if (!campaigns && !sms && !flows) return { drafted: 0, reason: "Nothing left to draft" };
  const strategist = await strategistOf(admin, clientId);
  if (!strategist) return { drafted: 0, reason: "No Email Strategist on the client" };
  const me = { id: strategist.id, fullName: strategist.name, email: strategist.email };
  const { planEmails, writeRequestCopy } = await import("@/lib/email-request");
  const label = (a.scope_label as string | null) ?? "this month";
  const { data: m } = await admin.from("email_scope_months").select("notes").eq("client_id", clientId).eq("month", month).maybeSingle();
  const notes = (m?.notes as string | null) ?? (a.scope_notes as string | null) ?? null;
  const why = `${label} of their ${a.cap_source === "sow" ? "Scope of Work" : "3-Month Setup"}${notes ? `: ${notes}` : ""}`;
  const jobs: { kind: "campaign" | "sms" | "flow"; count: number; idea: string }[] = [];
  for (let n = campaigns; n > 0; n -= 5) jobs.push({ kind: "campaign", count: Math.min(5, n), idea: `The campaign emails scoped for ${why}. Keep the 80/20 rule: 80% story and product, 20% sales.` });
  for (let n = sms; n > 0; n -= 5) jobs.push({ kind: "sms", count: Math.min(5, n), idea: `The SMS messages scoped for ${why}.` });
  for (let i = 0; i < flows; i++) {
    const share = Math.max(1, Math.min(6, Math.round((flowEmails || flows * 3) / flows)));
    jobs.push({ kind: "flow", count: share, idea: `Flow ${i + 1} of ${flows} scoped for ${why}. Build the one it names next that isn't live yet (or optimize the weakest live one when it says optimization).` });
  }
  let drafted = 0;
  for (const j of jobs) {
    try {
      const plan = await planEmails(admin, clientId, { kind: j.kind, count: j.count, idea: j.idea, month, priority: "normal" });
      await writeRequestCopy(admin, admin, me, { clientId, kind: j.kind, plan, priority: "normal", month, from: "sow" });
      drafted++;
    } catch (e) {
      console.error("[email scope draft]", e instanceof Error ? e.message : e);
    }
  }
  await admin.from("sync_state").update({ last_result: { drafted, jobs: jobs.length } }).eq("source", key);
  if (drafted) {
    const { data: c } = await admin.from("clients").select("name, slug").eq("id", clientId).maybeSingle();
    const parts = [campaigns && `${campaigns} campaign${campaigns === 1 ? "" : "s"}`, sms && `${sms} SMS`, flows && `${flows} flow${flows === 1 ? "" : "s"}`].filter(Boolean).join(", ");
    await admin.from("notifications").upsert(
      {
        profile_id: strategist.id,
        kind: "email_request",
        client_id: clientId,
        title: `${c?.name ?? "A client"}: ${drafted} email request${drafted === 1 ? "" : "s"} drafted for ${label}`,
        body: `${parts}, copy written. Review, edit and send them to Asana.`,
        href: `/board/email/new?client=${c?.slug ?? ""}`,
        key: `asana_email:scope:${clientId}:${month}`,
        priority: "normal",
      },
      { onConflict: "profile_id,key", ignoreDuplicates: true },
    );
  }
  return { drafted };
}

async function strategistOf(admin: Db, clientId: string) {
  const { data } = await admin.from("client_assignments").select("profile_id, is_primary, created_at, profiles(full_name, email)").eq("client_id", clientId).eq("role", "email_strategist").order("is_primary", { ascending: false }).order("created_at").limit(1).maybeSingle();
  const p = data?.profiles as unknown as { full_name: string; email: string | null } | null;
  return data && p ? { id: data.profile_id as string, name: p.full_name, email: p.email } : null;
}

// ─── Reading again, adjusting with the AI, and months not signed ────────────

/** Read the client's current SOW again (a SOW read before the parser knew SMS and flow emails, or after a fix) */
export async function rereadSow(admin: Db, clientId: string): Promise<{ ok: true; scope: SowScope } | { ok: false; error: string }> {
  const { data: s } = await admin.from("client_sows").select("id, name, text").eq("client_id", clientId).eq("line", "email").neq("status", "replaced").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!s?.text) return { ok: false, error: "No SOW text to read. Upload it again." };
  const scope = await readSowScope(admin, clientId, { name: String(s.name), text: String(s.text) });
  await admin.from("client_sows").update({ scope, read_at: new Date().toISOString(), status: "active", note: null }).eq("id", s.id);
  await applyScope(admin, clientId, s.id as string, scope);
  return { ok: true, scope };
}

export type ScopeAction = "set" | "unsigned" | "removed" | "reopen";
export type ScopeChange = {
  month: string;
  action: ScopeAction;
  label?: string | null;
  campaigns?: number | null;
  campaigns_min?: number | null;
  sms?: number | null;
  sms_min?: number | null;
  flows?: number | null;
  flow_emails?: number | null;
  flow_emails_min?: number | null;
  notes?: string | null;
  /** Why, in a few words (shown beside the change) */
  why: string;
};
export type ScopeMonthRow = { month: string; label: string | null; campaigns: number | null; campaigns_min: number | null; sms: number | null; sms_min: number | null; flows: number | null; flow_emails: number | null; flow_emails_min: number | null; notes: string | null; status: string; status_note: string | null; source: string };
export type ScopeTurn = { role: "you" | "ai"; text: string };

const CHANGE_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string", description: "A short answer in plain words: what you'd change and why, or the one question you need answered" },
    note: { type: "string", description: "The dated note kept with the change: what the client signed or decided, in one or two sentences" },
    changes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          month: { type: "string", description: "YYYY-MM" },
          action: { type: "string", enum: ["set", "unsigned", "removed", "reopen"] },
          label: { type: "string" },
          campaigns: { type: "integer" },
          campaigns_min: { type: "integer" },
          sms: { type: "integer" },
          sms_min: { type: "integer" },
          flows: { type: "integer" },
          flow_emails: { type: "integer" },
          flow_emails_min: { type: "integer" },
          notes: { type: "string" },
          why: { type: "string" },
        },
        required: ["month", "action", "label", "campaigns", "campaigns_min", "sms", "sms_min", "flows", "flow_emails", "flow_emails_min", "notes", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["reply", "note", "changes"],
  additionalProperties: false,
};

/** The client's scoped months, as stored */
export async function scopeMonths(admin: Db, clientId: string): Promise<ScopeMonthRow[]> {
  const { data } = await admin.from("email_scope_months").select("month, label, campaigns, campaigns_min, sms, sms_min, flows, flow_emails, flow_emails_min, notes, status, status_note, source").eq("client_id", clientId).order("month").limit(36);
  return (data ?? []) as ScopeMonthRow[];
}

/**
 * The AI proposes changes to the scoped months from what the person says ("they only signed the 1-month sprint",
 * "they picked Option B", "December is 5 campaigns"), reading the SOW, the months as they stand and the notes kept so
 * far. Nothing is written: the person sees the changes and applies them.
 */
export async function proposeScopeChanges(admin: Db, clientId: string, turns: ScopeTurn[]): Promise<{ reply: string; note: string; changes: ScopeChange[] }> {
  const [{ askJson }, months, { data: sow }, { data: notes }, { data: c }] = await Promise.all([
    import("@/lib/ai"),
    scopeMonths(admin, clientId),
    admin.from("client_sows").select("name, text, scope").eq("client_id", clientId).eq("line", "email").neq("status", "replaced").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    admin.from("email_scope_notes").select("note, created_at").eq("client_id", clientId).order("created_at", { ascending: false }).limit(12),
    admin.from("clients").select("name").eq("id", clientId).maybeSingle(),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const out = await askJson<{ reply: string; note: string; changes: ScopeChange[] }>({
    agent: "email_calendar",
    label: "email sow adjust",
    clientId,
    schema: CHANGE_SCHEMA,
    maxTokens: 3000,
    system: `You help Kaizen's email team keep a client's email scope right, month by month: campaign emails, SMS messages, flows (each counts once) and flow emails, each a range (min to max). The person tells you what the client actually signed or decided; you propose changes to the months and they apply them.
Actions: "set" changes a month's numbers (or adds a month), "unsigned" marks a month pitched but not signed (it holds no allotment, stays visible and can be reopened), "removed" takes a month off (also reopenable), "reopen" brings an unsigned or removed month back as it was.
The common case: the SOW pitches a longer roadmap (month 2, month 3, an ongoing tier) but the client is only moving forward with the sprint or month 1. Then we're only on the hook for what they signed: the other months are "unsigned", never deleted. "They picked Option B" means the months follow Option B's numbers in the SOW.
Every number you change must come from what the person said or from the SOW; keep the rest of a month as it is (repeat its current numbers in a "set"). A range keeps both ends. Months are YYYY-MM. If you can't tell which month or what number, ask one short question and propose nothing. No em dashes. Today: ${today}.`,
    prompt: [
      `Client: ${c?.name ?? "the client"}.`,
      `<months_now>\n${JSON.stringify(months.map((m) => ({ ...m, month: String(m.month).slice(0, 7) })))}\n</months_now>`,
      notes?.length ? `<notes_so_far>\n${notes.map((n) => `${String(n.created_at).slice(0, 10)}: ${n.note}`).join("\n")}\n</notes_so_far>` : "",
      sow ? `<sow name="${String(sow.name).replace(/"/g, "'")}">\n${String(sow.text ?? "").slice(0, 40000)}\n</sow>` : "No SOW on file.",
      `<conversation>\n${turns.map((t) => `${t.role === "you" ? "Person" : "You"}: ${t.text}`).join("\n")}\n</conversation>`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
  const changes = (out.changes ?? [])
    .filter((x) => /^\d{4}-\d{2}/.test(String(x.month)) && ["set", "unsigned", "removed", "reopen"].includes(x.action))
    .map((x) => ({ ...x, month: `${String(x.month).slice(0, 7)}-01` }))
    .slice(0, 24);
  return { reply: String(out.reply ?? "").slice(0, 1500), note: String(out.note ?? "").slice(0, 600), changes };
}

/** Apply changes to the scoped months (from the chat or the month buttons), keeping a dated note of why. Never deletes. */
export async function applyScopeChanges(admin: Db, clientId: string, changes: ScopeChange[], note: string, by: string | null, via: "chat" | "hand") {
  const before = new Map((await scopeMonths(admin, clientId)).map((m) => [String(m.month).slice(0, 10), m]));
  const now = new Date().toISOString();
  const w = (v: unknown, max: number) => (v == null ? null : Math.max(0, Math.min(max, Math.round(Number(v) || 0))));
  const log: { month: string; action: ScopeAction; before: unknown; after: unknown }[] = [];
  for (const c of changes) {
    const month = `${String(c.month).slice(0, 7)}-01`;
    const was = before.get(month) ?? null;
    if (c.action === "set") {
      const pair = (max: unknown, min: unknown, cap: number, prior: number | null | undefined, priorMin: number | null | undefined) => {
        const hi = w(max, cap) ?? prior ?? 0;
        const lo = w(min, cap) ?? priorMin ?? hi;
        return [Math.min(lo, hi), hi] as const;
      };
      const [cMin, cMax] = pair(c.campaigns, c.campaigns_min, 60, was?.campaigns, was?.campaigns_min);
      const [sMin, sMax] = pair(c.sms, c.sms_min, 40, was?.sms, was?.sms_min);
      const [fMin, fMax] = pair(c.flow_emails, c.flow_emails_min, 60, was?.flow_emails, was?.flow_emails_min);
      const row = { client_id: clientId, month, campaigns: cMax, campaigns_min: cMin, sms: sMax, sms_min: sMin, flows: w(c.flows, 20) ?? was?.flows ?? 0, flow_emails: fMax, flow_emails_min: fMin, label: c.label || was?.label || null, notes: c.notes || was?.notes || null, source: "manual", status: "active", status_note: c.why || null, status_at: now, updated_by: by, updated_at: now };
      await admin.from("email_scope_months").upsert(row, { onConflict: "client_id,month" });
      log.push({ month, action: "set", before: was, after: row });
    } else {
      if (!was) continue;
      const status = c.action === "reopen" ? "active" : c.action;
      await admin.from("email_scope_months").update({ status, status_note: c.why || null, status_at: now, updated_by: by, updated_at: now }).eq("client_id", clientId).eq("month", month);
      log.push({ month, action: c.action, before: { status: was.status }, after: { status } });
    }
  }
  if (log.length) await admin.from("email_scope_notes").insert({ client_id: clientId, note: note.trim().slice(0, 600) || "Scope adjusted", changes: log, via, profile_id: by });
  return log.length;
}

// ─── The daily pass ─────────────────────────────────────────────────────────

/**
 * Every email client without a SOW read yet looks for one in what Kaizen already has (new clients first), and every
 * client in a SOW month gets that month's requests drafted. Time-boxed; the rest waits for tomorrow.
 */
export async function sowPass(admin: Db, deadline: number) {
  const { data: clients } = await admin.from("clients").select("id, services, services_extra, services_removed, strategy_only, created_at").is("archived_at", null).in("status", ["active", "onboarding"]).order("created_at", { ascending: false });
  const { servicesOf } = await import("@/lib/services");
  // Strategy-only email clients hold no allotment: nothing to find or draft
  const email = (clients ?? []).filter((c) => (servicesOf(c) as string[]).includes("email-marketing") && !((c.strategy_only ?? []) as string[]).includes("email-marketing"));
  const { data: have } = await admin.from("client_sows").select("client_id, created_at").eq("line", "email");
  const tried = new Map((have ?? []).map((h) => [h.client_id as string, h.created_at as string]));
  const { data: looked } = await admin.from("sync_state").select("source, last_run_at").like("source", "sow:%");
  const lookedAt = new Map((looked ?? []).map((l) => [String(l.source).slice(4), String(l.last_run_at)]));
  let found = 0;
  let drafted = 0;
  for (const c of email) {
    if (Date.now() > deadline) break;
    const id = c.id as string;
    // A client with no SOW yet: look again at most once a week
    if (!tried.has(id) && Date.now() - Date.parse(lookedAt.get(id) ?? "1970-01-01") > 7 * 86_400_000) {
      await admin.from("sync_state").upsert({ source: `sow:${id}`, last_run_at: new Date().toISOString(), cursor_at: new Date().toISOString(), last_result: {} });
      const s = await findSow(admin, id).catch(() => null);
      if (s) {
        await saveSow(admin, id, s, null).catch(() => null);
        found++;
      }
    }
    // A SOW read by the first parser (no SMS, flow emails or signed months): read again once
    if (tried.has(id) && Date.now() < deadline) {
      const { data: old } = await admin.from("client_sows").select("id, scope").eq("client_id", id).eq("line", "email").eq("status", "active").order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (old && !("setup" in ((old.scope ?? {}) as object))) await rereadSow(admin, id).catch(() => null);
    }
    if (Date.now() > deadline) break;
    const r = await draftScopeMonth(admin, id).catch(() => ({ drafted: 0 }));
    drafted += r.drafted;
  }
  return { clients: email.length, found, drafted };
}
