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
        },
        required: ["month", "label", "campaigns", "campaigns_min", "sms", "sms_min", "flows", "flow_emails", "flow_emails_min", "notes"],
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
    system: `You read a Kaizen Marketing Scope of Work (or the email that carries it) for the email and SMS work only, month by month: campaign emails, SMS campaign messages, flows built or optimized (a flow counts once), and emails across flows. Kaizen's standard 3-Month Initial Setup is: month 1 Foundation (3 core flows, up to 15 flow emails, no campaigns), month 2 Expansion (2 more flows, up to 10 flow emails, 3 campaigns, 2 SMS), month 3 Ongoing (1 new flow or optimization of 5 emails, 5 campaigns, 2 SMS); a SOW may change any of it, and what it says wins. Domain-warming sends aren't campaigns. When the SOW offers several options, read the one it recommends or the client chose. Ranges ("3 to 5") give min and max. Never invent numbers the SOW doesn't give; when email isn't in it, email_in_scope false and no months. Today: ${today}.`,
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
  const { data: manual } = await admin.from("email_scope_months").select("month").eq("client_id", clientId).eq("source", "manual");
  const keep = new Set((manual ?? []).map((m) => String(m.month)));
  const rows = scope.months
    .filter((m) => !keep.has(m.month))
    .map((m) => ({ client_id: clientId, month: m.month, campaigns: m.campaigns, campaigns_min: m.campaigns_min, sms: m.sms, sms_min: m.sms_min, flows: m.flows, flow_emails: m.flow_emails, flow_emails_min: m.flow_emails_min, label: m.label || null, notes: m.notes || null, source: "sow", sow_id: sowId, updated_at: new Date().toISOString() }));
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
    if (Date.now() > deadline) break;
    const r = await draftScopeMonth(admin, id).catch(() => ({ drafted: 0 }));
    drafted += r.drafted;
  }
  return { clients: email.length, found, drafted };
}
