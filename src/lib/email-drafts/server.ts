import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { aiEnabled, askJson } from "@/lib/ai";
import type { Staff } from "@/lib/auth";
import { clientRecipients } from "@/lib/client-emails";
import { LIVE } from "@/lib/live";
import { composeLinks, draftKey, parseDraftItems, pickOwner, type DraftItem, type SourceKind } from "./core";

// Client emails drafted from conversations: recent calls and meeting notes (Gemini's included), what was promised on
// them, and the client's Slack and email, read for anything that needs an email to the client (a promise, a follow-up,
// an apology or correction, an upsell offer, a requested report). Each is drafted in Kaizen's voice from the person
// responsible and listed on their Overview as "Emails ready to send". Opening one puts it in their Gmail as a draft when
// the gmail.compose scope is granted (else a prefilled compose link). Nothing is ever sent from here.

const DAY = 86_400_000;
const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export type EmailDraftRow = {
  id: string;
  client_id: string;
  owner_id: string;
  kind: string;
  subject: string;
  body: string;
  to_emails: string[];
  reason: string | null;
  source_kind: string;
  status: string;
  gmail_draft_id: string | null;
  created_at: string;
  clients?: { name: string; slug: string } | null;
  /** Kaizen documents that go with it (a Scope of Work PDF) */
  attachments?: { document_id: string; name: string }[] | null;
};

const SYSTEM = `You write emails from a Kaizen Marketing team member to one of the agency's clients. Kaizen's voice: warm, plain, confident and short; a real person writing, never a template. First name greeting, two to five short paragraphs, one clear next step, signed with the sender's first name. Never use em dashes. Never mention internal scores, criticality, ratings or anything about how the team judges the account. Never promise what the notes don't support; never invent numbers, dates or names. Refer to people by their role on the team ("your media buyer"), not by name, unless the sender is that person.`;

const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["promise", "follow_up", "apology", "upsell", "report", "other"] },
          subject: { type: "string" },
          body: { type: "string" },
          reason: { type: "string", description: "Why this needs an email, one line, naming the source and date" },
          source_kind: { type: "string", enum: ["call", "commitment", "slack", "email", "upsell", "meeting", "assistant"] },
          source_id: { type: "string", description: "The id given with the source line, exactly" },
          line: { type: "string", enum: ["ads", "meta", "google", "tiktok", "email", "social", "creative", "account"] },
        },
        required: ["kind", "subject", "body", "reason", "source_kind", "line"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

type Seats = Record<string, string | null>;

async function seatsOf(admin: SupabaseClient, clientId: string): Promise<Seats> {
  const { data } = await admin.from("client_assignments").select("role, profile_id, is_primary").eq("client_id", clientId);
  const seats: Seats = {};
  for (const a of (data ?? []) as { role: string; profile_id: string; is_primary: boolean | null }[]) if (!seats[a.role] || a.is_primary) seats[a.role] = a.profile_id;
  return seats;
}

/** What the client said and was promised lately, as numbered source lines the AI cites back (ids kept exact) */
async function sourcesFor(admin: SupabaseClient, clientId: string, sinceDays: number) {
  const since = new Date(Date.now() - sinceDays * DAY).toISOString();
  const [calls, promises, ctx, owed] = await Promise.all([
    admin.from("client_calls").select("id, title, occurred_at, host, notes, summary").eq("client_id", clientId).gte("occurred_at", since).order("occurred_at", { ascending: false }).limit(6),
    admin.from("call_commitments").select("id, kind, what, why, due_at, status, call_id").eq("client_id", clientId).in("status", ["open", "in_motion", "briefed"]).gte("created_at", since).limit(20),
    admin.from("context_items").select("id, source, occurred_at, author, title, body").eq("client_id", clientId).in("source", ["slack", "gmail"]).gte("occurred_at", since).order("occurred_at", { ascending: false }).limit(30),
    admin.from("owed_replies").select("id, source, from_name, asked_at, gist, body, target_id").eq("client_id", clientId).eq("from_team", false).in("status", ["watching", "nudged", "escalated"]).limit(10),
  ]);
  const lines: string[] = [];
  const hosts = new Map<string, string | null>();
  for (const c of (calls.data ?? []) as { id: string; title: string; occurred_at: string; host: string | null; notes: string; summary: unknown }[]) {
    hosts.set(c.id, c.host);
    const sum = c.summary ? clip(JSON.stringify(c.summary), 1800) : "";
    lines.push(`[call id=${c.id}] ${c.occurred_at.slice(0, 10)} "${clip(c.title, 120)}"${c.host ? ` (notes by ${c.host})` : ""}: ${sum || clip(c.notes, 2400)}`);
  }
  for (const p of (promises.data ?? []) as { id: string; kind: string; what: string; why: string | null; due_at: string; status: string }[]) lines.push(`[commitment id=${p.id}] promised (${p.kind}, due ${p.due_at.slice(0, 10)}, ${p.status}): ${clip(p.what, 300)}${p.why ? ` because ${clip(p.why, 200)}` : ""}`);
  for (const x of (ctx.data ?? []) as { id: string; source: string; occurred_at: string; author: string | null; title: string | null; body: string | null }[]) lines.push(`[${x.source === "gmail" ? "email" : "slack"} id=${x.id}] ${x.occurred_at.slice(0, 10)} ${x.author ?? "someone"}${x.title ? ` "${clip(x.title, 100)}"` : ""}: ${clip(x.body, 500)}`);
  for (const o of (owed.data ?? []) as { id: string; source: string; from_name: string | null; asked_at: string; gist: string | null; body: string | null }[]) lines.push(`[${o.source === "gmail" ? "email" : "slack"} id=${o.id}] ${o.asked_at.slice(0, 10)} unanswered from ${o.from_name ?? "the client"}: ${clip(o.gist || o.body, 400)}`);
  return { lines, hosts };
}

/** Our team member behind a call's notes (by email or name), when it's one of us */
async function staffByHost(admin: SupabaseClient, host: string | null | undefined): Promise<string | null> {
  const h = clip(host, 120).toLowerCase();
  if (!h) return null;
  const { data } = await admin.from("profiles").select("id, email, full_name").eq("is_active", true);
  const hit = (data ?? []).find((p) => String(p.email ?? "").toLowerCase() === h || String(p.full_name ?? "").toLowerCase() === h);
  return (hit?.id as string | undefined) ?? null;
}

async function save(admin: SupabaseClient, clientId: string, items: DraftItem[], o: { seats: Seats; to: string[]; createdBy: string | null; ownerId?: string | null; hosts?: Map<string, string | null> }) {
  const rows = [];
  for (const d of items) {
    const host = d.sourceKind === "call" && d.sourceId ? o.hosts?.get(d.sourceId) : null;
    const speaker = o.ownerId ?? (host ? await staffByHost(admin, host) : null);
    const owner = pickOwner({ line: d.line, speakerId: speaker, seats: o.seats, fallbackId: o.createdBy });
    if (!owner) continue;
    rows.push({ client_id: clientId, owner_id: owner, kind: d.kind, subject: d.subject, body: d.body, to_emails: o.to, reason: d.reason || null, source_kind: d.sourceKind, source_id: d.sourceId, source_key: draftKey(clientId, d), created_by: o.createdBy });
  }
  if (!rows.length) return [];
  const { data } = await admin.from("client_email_drafts").upsert(rows, { onConflict: "source_key", ignoreDuplicates: true }).select("id, owner_id, subject");
  return (data ?? []) as { id: string; owner_id: string; subject: string }[];
}

/**
 * Reads one client's last two weeks and drafts the emails it needs (none when nothing does). Already-drafted items are
 * skipped by their key. Returns what was added.
 */
export async function scanClient(admin: SupabaseClient, clientId: string, o: { sinceDays?: number; createdBy?: string | null } = {}) {
  if (!aiEnabled()) return { added: 0, note: "AI is off" };
  const [{ data: c }, { lines, hosts }, seats, to] = await Promise.all([
    admin.from("clients").select("name").eq("id", clientId).maybeSingle(),
    sourcesFor(admin, clientId, o.sinceDays ?? 14),
    seatsOf(admin, clientId),
    clientRecipients(admin, clientId).then((r) => r.map((x) => x.email)).catch(() => [] as string[]),
  ]);
  if (!c || !lines.length) return { added: 0 };
  const { data: had } = await admin.from("client_email_drafts").select("subject, reason, source_id").eq("client_id", clientId).gte("created_at", new Date(Date.now() - 30 * DAY).toISOString()).limit(40);
  const prompt = [
    `Client: ${c.name}. Today: ${new Date().toISOString().slice(0, 10)}.`,
    "Find what needs an email to the client from the sources below: a promise we made that is due or done (tell them it's done or when), a follow-up we said we'd send, an apology or correction for something that went wrong, an upsell they showed interest in, or a report they asked for. Only what truly needs an email; zero items is a fine answer. Skip anything internal, anything already answered, and anything in the already-drafted list.",
    "Cite each item's source with its exact id. line: the service line it's about (account when general).",
    had?.length ? `Already drafted (don't repeat):\n${had.map((h) => `- ${h.subject}${h.reason ? ` (${h.reason})` : ""}`).join("\n")}` : "",
    `Sources:\n${lines.join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const out = await askJson<{ items: unknown[] }>({ agent: "calls", label: "client email drafts", system: SYSTEM, prompt, schema: SCHEMA, clientId, maxTokens: 6000 }).catch((e) => {
    console.error("[email drafts] scan", clientId, e instanceof Error ? e.message : e);
    return null;
  });
  const items = parseDraftItems(out, "call", 6);
  const saved = await save(admin, clientId, items, { seats, to, createdBy: o.createdBy ?? null, hosts });
  return { added: saved.length, drafts: saved };
}

/** Every client this person sits on (or every live client for an exec asking for all), scanned one at a time */
export async function scanForPerson(admin: SupabaseClient, me: Pick<Staff, "id" | "isExec">, o: { all?: boolean; max?: number } = {}) {
  const ids = o.all && me.isExec
    ? ((await admin.from("clients").select("id").is("archived_at", null).in("status", [...LIVE])).data ?? []).map((r) => r.id as string)
    : [...new Set(((await admin.from("client_assignments").select("client_id").eq("profile_id", me.id)).data ?? []).map((r) => r.client_id as string))];
  let added = 0;
  for (const id of ids.slice(0, o.max ?? 25)) added += (await scanClient(admin, id, { createdBy: me.id }).catch(() => ({ added: 0 }))).added;
  await admin.from("sync_state").upsert({ source: `email-drafts:${me.id}`, last_run_at: new Date().toISOString(), cursor_at: new Date().toISOString() });
  return { clients: Math.min(ids.length, o.max ?? 25), added };
}

/** Whether this person's clients were scanned in the last `hours` */
export async function scannedRecently(admin: SupabaseClient, profileId: string, hours = 20): Promise<boolean> {
  const { data } = await admin.from("sync_state").select("last_run_at").eq("source", `email-drafts:${profileId}`).maybeSingle();
  return Boolean(data?.last_run_at && Date.now() - Date.parse(data.last_run_at as string) < hours * 3_600_000);
}

/**
 * Drafts for several clients at once, on purpose (the assistant's "draft an email for each of these 12 upsell clients"):
 * what to say comes from `purpose` and each client's own `points` (an upsell's offer and why). The person asking owns
 * them unless `ownerId` says otherwise. Never sends.
 */
export async function draftBulk(admin: SupabaseClient, me: Pick<Staff, "id" | "fullName">, o: { clients: { id: string; name: string; points?: string[] }[]; kind: DraftItem["kind"]; purpose: string; ownerId?: string | null; sourceKind?: SourceKind }) {
  if (!aiEnabled()) return { drafted: [] as { id: string; client: string; subject: string }[], note: "AI is off" };
  const drafted: { id: string; client: string; subject: string }[] = [];
  for (const c of o.clients.slice(0, 25)) {
    const to = await clientRecipients(admin, c.id).then((r) => r.map((x) => x.email)).catch(() => [] as string[]);
    const prompt = [
      `Client: ${c.name}. Sender: ${me.fullName.split(" ")[0]} at Kaizen.`,
      `Write one email (kind: ${o.kind}). What it's for: ${clip(o.purpose, 800)}`,
      c.points?.length ? `Points for this client:\n${c.points.map((p) => `- ${clip(p, 300)}`).join("\n")}` : "",
      `source_kind: ${o.sourceKind ?? "assistant"}; source_id: leave empty; line: the service line it's about (account when general).`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const out = await askJson<{ items: unknown[] }>({ agent: "calls", label: "client email draft", system: SYSTEM, prompt, schema: SCHEMA, clientId: c.id, maxTokens: 2500 }).catch(() => null);
    const items = parseDraftItems(out, o.sourceKind ?? "assistant", 1).map((d) => ({ ...d, kind: o.kind, sourceKind: o.sourceKind ?? ("assistant" as const), sourceId: `${new Date().toISOString().slice(0, 10)}:${o.kind}` }));
    const saved = await save(admin, c.id, items, { seats: {}, to, createdBy: me.id, ownerId: o.ownerId ?? me.id });
    for (const s of saved) drafted.push({ id: s.id, client: c.name, subject: s.subject });
  }
  return { drafted };
}

/** This person's drafts waiting to go out, newest first */
export async function myDrafts(db: SupabaseClient, profileId: string, limit = 20): Promise<EmailDraftRow[]> {
  const cols = "id, client_id, owner_id, kind, subject, body, to_emails, reason, source_kind, status, gmail_draft_id, created_at, clients(name, slug)";
  const q = (c: string) => db.from("client_email_drafts").select(c).eq("owner_id", profileId).in("status", ["ready", "opened"]).order("created_at", { ascending: false }).limit(limit);
  let { data, error } = await q(`${cols}, attachments`);
  // Before the attachments column
  if (error) ({ data, error } = await q(cols));
  return (data ?? []) as unknown as EmailDraftRow[];
}

/**
 * Opens a draft for sending: into the person's own Gmail as a draft when the app may compose there, else a prefilled
 * compose link. Marks it opened. Never sends.
 */
export async function openDraft(admin: SupabaseClient, me: Pick<Staff, "id" | "email" | "fullName">, id: string): Promise<{ ok: true; where: "gmail" | "link"; href: string } | { ok: false; error: string }> {
  let { data: d } = await admin.from("client_email_drafts").select("id, owner_id, subject, body, to_emails, gmail_draft_id, attachments").eq("id", id).maybeSingle();
  // Before the attachments column
  if (!d) ({ data: d } = await admin.from("client_email_drafts").select("id, owner_id, subject, body, to_emails, gmail_draft_id").eq("id", id).maybeSingle());
  if (!d || d.owner_id !== me.id) return { ok: false, error: "That draft isn't yours." };
  // Files on it (a Scope of Work PDF): attached in Gmail; named at the bottom of a prefilled compose otherwise
  const { attachNote, mailFiles } = await import("@/lib/documents/attach");
  const files = (((d as { attachments?: unknown }).attachments ?? []) as { document_id?: string; name?: string }[]).filter((f) => f.document_id).map((f) => ({ documentId: String(f.document_id), name: String(f.name ?? "Kaizen document.pdf") }));
  const links = composeLinks({ to: (d.to_emails as string[]) ?? [], subject: d.subject as string, body: `${d.body as string}${attachNote(files)}` });
  const { gmailComposeToken, googleConfigured, googlePost } = await import("@/lib/context/google");
  if (googleConfigured()) {
    try {
      const { rawEmail } = await import("@/lib/assistant/messages");
      const { attached, missing } = await mailFiles(admin, files);
      if (missing.length) throw new Error(`files missing: ${missing.join(", ")}`);
      const raw = rawEmail({ from: `${me.fullName} <${me.email}>`, to: ((d.to_emails as string[]) ?? []).join(", "), subject: d.subject as string, body: d.body as string, attachments: attached });
      const token = await gmailComposeToken(me.email);
      const made = await googlePost<{ id: string; message?: { id: string } }>(token, "https://gmail.googleapis.com/gmail/v1/users/me/drafts", { message: { raw } });
      await admin.from("client_email_drafts").update({ status: "opened", gmail_draft_id: made.id, updated_at: new Date().toISOString() }).eq("id", id);
      return { ok: true, where: "gmail", href: made.message?.id ? `https://mail.google.com/mail/u/0/#drafts?compose=${made.message.id}` : "https://mail.google.com/mail/u/0/#drafts" };
    } catch (e) {
      console.error("[email drafts] gmail draft", e instanceof Error ? e.message : e);
    }
  }
  await admin.from("client_email_drafts").update({ status: "opened", updated_at: new Date().toISOString() }).eq("id", id);
  return { ok: true, where: "link", href: links.gmail };
}
