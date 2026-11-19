import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CallCopyDoc } from "@/lib/agent-call/core";
import { findOrCreateFolder, folderIdOf } from "@/lib/creative-drive-paths";
import { changedLines, copyLines, COPY_SCHEMA, docKindsFor, copyDocHtml, copyDocName, EMAIL_FOLDER, normalizeCopy, setCopyLine, toLooseCopy, type CopyComment, type CopyContent, type CopyStatus } from "./core";

// Copy documents on the server: saved (each change a new version, the old ones kept), read through the person's own
// session, revised by the AI copywriter from a note or the open comments, approved into a Google Doc in the client's
// headquarters Drive folder (the line's folder, "Email Marketing" for email, made when missing) as the person approving.
// The requests themselves are the deliverable flow's (src/lib/deliverables/server.ts).

type Admin = SupabaseClient;
export type Me = { id: string; fullName: string; email: string | null };

export type CopyDoc = {
  id: string;
  clientId: string | null;
  client: string | null;
  clientSlug: string | null;
  content: CopyContent;
  version: number;
  versions: { version: number; content: CopyContent; at: string; by: string; why: string | null }[];
  comments: CopyComment[];
  status: CopyStatus;
  docUrl: string | null;
  asanaUrl: string | null;
  approvedAt: string | null;
  createdBy: string;
  updatedAt: string;
  /** Where it came from: the email request form (with its priority and plan) or a client's SOW month */
  origin: { kind?: string; month?: string; priority?: string } | null;
};

const COLS = "id, client_id, created_by, kind, title, content, version, versions, comments, status, approved_at, doc_url, asana_url, updated_at, origin, clients(name, slug)";

function rowToDoc(r: Record<string, unknown>): CopyDoc {
  const c = r.clients as { name: string; slug: string } | null;
  return {
    id: r.id as string,
    clientId: (r.client_id as string | null) ?? null,
    client: c?.name ?? null,
    clientSlug: c?.slug ?? null,
    content: normalizeCopy(toLooseCopy(r.content as CopyContent)),
    version: Number(r.version ?? 1),
    versions: ((r.versions ?? []) as CopyDoc["versions"]) ?? [],
    comments: ((r.comments ?? []) as CopyComment[]) ?? [],
    status: (r.status as CopyStatus) ?? "draft",
    docUrl: (r.doc_url as string | null) ?? null,
    asanaUrl: (r.asana_url as string | null) ?? null,
    approvedAt: (r.approved_at as string | null) ?? null,
    createdBy: r.created_by as string,
    updatedAt: r.updated_at as string,
    origin: (r.origin as CopyDoc["origin"]) ?? null,
  };
}

/** A copy document the person may see (their session decides), or null */
export async function loadCopyDoc(db: SupabaseClient, id: string): Promise<CopyDoc | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data } = await db.from("copy_docs").select(COLS).eq("id", id).maybeSingle();
  return data ? rowToDoc(data as unknown as Record<string, unknown>) : null;
}

/**
 * The newest copy document for a line not yet requested, for a request asked for on a later call or chat that never
 * saw the doc's id: the client's when named, else the person's own. Read through the person's session.
 */
export async function latestCopyDoc(db: SupabaseClient, p: { line: string; clientId?: string | null; createdBy: string }): Promise<CopyDoc | null> {
  let q = db.from("copy_docs").select(COLS).in("kind", docKindsFor(p.line)).neq("status", "requested");
  q = p.clientId ? q.eq("client_id", p.clientId) : q.eq("created_by", p.createdBy);
  const { data } = await q.order("updated_at", { ascending: false }).limit(1).maybeSingle();
  return data ? rowToDoc(data as unknown as Record<string, unknown>) : null;
}

/** The card a call or chat shows for it */
export function copyCard(d: CopyDoc): CallCopyDoc {
  return {
    id: d.id,
    kind: d.content.kind,
    title: d.content.title,
    client: d.client,
    version: d.version,
    status: d.status,
    href: `/copy/${d.id}`,
    emails: d.content.emails.map((e) => ({ name: e.name, subject: e.subject, preview: e.preview, sections: e.sections, cta: e.cta?.label ?? null, designNotes: e.designNotes })),
    docUrl: d.docUrl,
    asanaUrl: d.asanaUrl,
  };
}

/**
 * A new copy document, or the next version of one (the earlier version kept, with why it changed). An approved one
 * that changes goes back to a draft: the new words need approving again.
 */
export async function saveCopyDoc(admin: Admin, db: SupabaseClient, me: Me, p: { client: { id: string } | null; loose: Record<string, unknown>; id?: string | null; why?: string | null; callId?: string | null; origin?: Record<string, unknown> | null }): Promise<CopyDoc> {
  const content = normalizeCopy(p.loose);
  if (!content.emails.length) throw new Error("Write at least one email (subject, preview text, sections, button).");
  const now = new Date().toISOString();
  if (p.id) {
    const prior = await loadCopyDoc(db, p.id);
    if (!prior) throw new Error("That copy isn't one you can change.");
    const versions = [...prior.versions, { version: prior.version, content: prior.content, at: prior.updatedAt, by: me.id, why: p.why ?? null }].slice(-30);
    const { data, error } = await admin
      .from("copy_docs")
      .update({ kind: content.kind, title: content.title, content, version: prior.version + 1, versions, status: prior.status === "requested" ? "requested" : "draft", ...(prior.status === "approved" ? { approved_at: null, approved_by: null } : {}), updated_at: now })
      .eq("id", p.id)
      .select(COLS)
      .single();
    if (error || !data) throw new Error("The new version didn't save. Try again.");
    return rowToDoc(data as unknown as Record<string, unknown>);
  }
  const { data, error } = await admin
    .from("copy_docs")
    .insert({ client_id: p.client?.id ?? null, created_by: me.id, kind: content.kind, title: content.title, content, call_id: p.callId && /^[0-9a-f-]{36}$/i.test(p.callId) ? p.callId : null, origin: p.origin ?? null })
    .select(COLS)
    .single();
  if (error || !data) throw new Error("The copy didn't save. Try again.");
  return rowToDoc(data as unknown as Record<string, unknown>);
}

/** What changed in the latest version (anchors), for the view's highlights */
export const latestChanges = (d: CopyDoc) => changedLines(d.versions.at(-1)?.content ?? null, d.content);

// ─── Comments ───────────────────────────────────────────────────────────────

export async function addCopyComment(admin: Admin, db: SupabaseClient, me: Me, id: string, c: { anchor: string; quote: string; text: string }) {
  const d = await loadCopyDoc(db, id);
  if (!d) throw new Error("That copy isn't one you can open.");
  const text = c.text.replace(/\s+/g, " ").trim().slice(0, 2000);
  if (!text) throw new Error("Write the comment first.");
  const comment: CopyComment = { id: crypto.randomUUID().slice(0, 12), anchor: c.anchor.slice(0, 40), quote: c.quote.slice(0, 300), text, by: me.id, byName: me.fullName, at: new Date().toISOString(), resolved: false };
  const comments = [...d.comments, comment].slice(-200);
  await admin.from("copy_docs").update({ comments, updated_at: new Date().toISOString() }).eq("id", id);
  return comments;
}

export async function resolveCopyComment(admin: Admin, db: SupabaseClient, id: string, commentId: string, resolved = true) {
  const d = await loadCopyDoc(db, id);
  if (!d) throw new Error("That copy isn't one you can open.");
  const comments = d.comments.map((c) => (c.id === commentId ? { ...c, resolved } : c));
  await admin.from("copy_docs").update({ comments }).eq("id", id);
  return comments;
}

// ─── The strategist's own edits, and the learning loop ──────────────────────

/** A strategist rewrites one line themselves: the next version (the earlier one kept), the edit kept to learn from */
export async function editCopyLine(admin: Admin, db: SupabaseClient, me: Me, id: string, anchor: string, text: string) {
  const d = await loadCopyDoc(db, id);
  if (!d) throw new Error("That copy isn't one you can change.");
  const line = copyLines(d.content).find((l) => l.anchor === anchor);
  if (!line) throw new Error("That line isn't in this copy any more.");
  if (!text.trim()) throw new Error("Write the line first.");
  if (text.trim() === line.text.trim()) return { doc: d, feedbackId: null as string | null };
  const next = setCopyLine(d.content, anchor, text);
  if (!next) throw new Error("That line can't be edited.");
  const doc = await saveCopyDoc(admin, db, me, { client: d.clientId ? { id: d.clientId } : null, loose: toLooseCopy(next), id, why: `${me.fullName.split(" ")[0]} edited ${line.label}` });
  const { data } = await admin.from("copy_feedback").insert({ copy_doc_id: id, client_id: d.clientId, kind: "edit", anchor, before: line.text.slice(0, 4000), after: text.trim().slice(0, 4000), profile_id: me.id }).select("id").maybeSingle();
  return { doc, feedbackId: (data?.id as string | undefined) ?? null };
}

/** A comment on a line, kept to learn from (the comment itself is on the copy) */
export async function keepCopyComment(admin: Admin, d: { id: string; clientId: string | null }, me: Me, c: { anchor: string; quote: string; text: string }) {
  const { data } = await admin.from("copy_feedback").insert({ copy_doc_id: d.id, client_id: d.clientId, kind: "comment", anchor: c.anchor.slice(0, 40), before: c.quote.slice(0, 1000), text: c.text.slice(0, 2000), profile_id: me.id }).select("id").maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

/**
 * What the copywriter learns from one edit or comment: a lesson for this client, or (about the craft) for every
 * client's copy at once (src/lib/learnings.ts, source copy_feedback). Never throws; run it after the response.
 */
export async function learnFromCopyFeedback(admin: Admin, feedbackId: string) {
  const { data: f } = await admin.from("copy_feedback").select("id, copy_doc_id, client_id, kind, anchor, before, after, text").eq("id", feedbackId).maybeSingle();
  if (!f?.client_id) return;
  const { data: doc } = await admin.from("copy_docs").select("kind").eq("id", f.copy_doc_id).maybeSingle();
  const what = String(f.anchor ?? "").replace(/^e(\d+)\./, (_m, n: string) => `email ${Number(n) + 1} `);
  const text =
    f.kind === "edit"
      ? `The strategist rewrote a line of the ${doc?.kind ?? "email"} copy (${what}). Copywriter wrote: "${String(f.before ?? "").slice(0, 400)}". Strategist changed it to: "${String(f.after ?? "").slice(0, 400)}".`
      : `The strategist commented on a line of the ${doc?.kind ?? "email"} copy (${what}): "${String(f.before ?? "").slice(0, 300)}". Comment: ${String(f.text ?? "").slice(0, 600)}`;
  const { recordLearning } = await import("@/lib/learnings");
  await recordLearning(admin, { table: "copy_feedback", id: f.id as string, clientId: f.client_id as string, text });
}

// ─── Revising with the AI copywriter ────────────────────────────────────────

const REVISE_SYSTEM = `You are Kaizen Marketing's email copywriter, working with the Email Strategist. You revise campaign, flow and SMS copy for the email team (never a message to a person): keep what works, change exactly what's asked, and keep the client's voice and rules (claims, discounts, words to avoid, imagery rules like real photos only).
Each email: a subject under 55 characters, preview text that adds to the subject, the body as short sections written to be designed (a hero headline and line, then short sections), one button, and design notes for the designer. Texts: body only, under 160 characters, the brand name first, one {link}.
Return the whole document, every email, changed or not. Roles, never names. No em dashes. No emojis unless the client's own emails use them.`;

/** The AI copywriter's next version: from a note ("make the subject punchier"), the open comments, or both */
export async function reviseCopyDoc(admin: Admin, db: SupabaseClient, me: Me, id: string, p: { note: string; anchors?: string[] }) {
  const d = await loadCopyDoc(db, id);
  if (!d) throw new Error("That copy isn't one you can change.");
  const open = d.comments.filter((c) => !c.resolved && (!p.anchors?.length || p.anchors.includes(c.anchor)));
  const note = p.note.trim().slice(0, 2000);
  if (!note && !open.length) throw new Error("Say what to change, or comment on a line first.");
  const { askJson } = await import("@/lib/ai");
  const brief = d.clientId ? await import("@/lib/email-ops/chat").then((m) => m.emailBrief(admin, d.clientId!)).catch(() => null) : null;
  const out = await askJson<Record<string, unknown>>({
    agent: "email_copy",
    label: "copy doc revision",
    clientId: d.clientId,
    system: REVISE_SYSTEM,
    schema: COPY_SCHEMA,
    maxTokens: 12000,
    prompt: [
      brief ? `Client: ${brief.name}.\n\n${brief.text}` : "",
      `<copy kind="${d.content.kind}">\n${JSON.stringify(toLooseCopy(d.content))}\n</copy>`,
      open.length ? `<comments on lines>\n${open.map((c) => `- on "${c.quote}" (${c.anchor}): ${c.text}`).join("\n")}\n</comments>` : "",
      note ? `What to change: ${note}` : "Address every comment.",
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
  const next = await saveCopyDoc(admin, db, me, { client: d.clientId ? { id: d.clientId } : null, loose: { ...out, kind: d.content.kind }, id, why: note || `${open.length} comment${open.length === 1 ? "" : "s"}` });
  // The comments it answered are resolved (still kept)
  if (open.length) {
    const done = new Set(open.map((c) => c.id));
    await admin.from("copy_docs").update({ comments: next.comments.map((c) => (done.has(c.id) ? { ...c, resolved: true } : c)) }).eq("id", id);
  }
  return next;
}

// ─── Approve: the Google Doc in the client's HQ Drive folder ────────────────

export type ClientFacts = {
  id: string;
  name: string;
  kaizenId: number | null;
  website: string | null;
  /** The HQ folder as stored (the account sheet's link, else the client's folder): checked in Drive before anything is put there */
  hqFolder: string | null;
  hqUrl: string | null;
  /** The stored HQ links, best first (this line's sheet tab, the other lines' tabs, the mirror's last tasks) */
  hqLinks: string[];
  /** The client's own folder (clients.drive_folder_id) */
  clientFolder: string | null;
  figma: string | null;
  platform: string | null;
};

/**
 * Everything we know about the client for a request: first the Account Overview sheet's tab for the line (client ID,
 * HQ assets link, Figma, website), then the client's own fields, then the Asana mirror's last tasks for that client;
 * the email platform from their connection.
 */
export async function clientFacts(admin: Admin, clientId: string, line = "email"): Promise<ClientFacts> {
  const [{ data: c }, { data: past }] = await Promise.all([
    admin.from("clients").select("id, name, kaizen_id, website, drive_folder_id, channel_sheet").eq("id", clientId).single(),
    admin.from("email_asana_tasks").select("fields").eq("client_id", clientId).order("asana_created_at", { ascending: false }).limit(25),
  ]);
  if (!c) throw new Error("Client not found.");
  const fieldOf = (re: RegExp) => {
    for (const r of past ?? []) {
      const f = (r.fields ?? {}) as Record<string, string>;
      const hit = Object.entries(f).find(([k, v]) => re.test(k) && String(v ?? "").trim());
      if (hit) return String(hit[1]).trim();
    }
    return null;
  };
  const tabs = (c.channel_sheet ?? {}) as Record<string, unknown>;
  const sheet = (tabs[`${line}_details`] ?? {}) as Partial<Record<"clientId" | "hq" | "figma" | "website", string | null>>;
  const hqField = sheet.hq ?? fieldOf(/client\s*hq|assets/i);
  const isDrive = (v: unknown): v is string => typeof v === "string" && /drive\.google\.com/.test(v);
  // The HQ links we hold, this line's first: the account sheet's Email and Organic tabs, then the mirror's last tasks
  const hqLinks = [...new Set([sheet.hq, ...["email", "social"].map((l) => ((tabs[`${l}_details`] ?? {}) as { hq?: string | null }).hq), fieldOf(/client\s*hq|assets/i)].filter(isDrive))];
  const clientFolder = c.drive_folder_id ? folderIdOf(c.drive_folder_id as string) : null;
  const hqFolder = (hqLinks[0] ? folderIdOf(hqLinks[0]) : null) ?? clientFolder;
  let platform: string | null = null;
  try {
    const { emailConnections } = await import("@/lib/email-providers/which");
    const { providerName } = await import("@/lib/email-providers/core");
    const conn = (await emailConnections(admin, [clientId])).get(clientId);
    platform = conn ? providerName(conn.provider) : null;
  } catch {
    platform = null;
  }
  return {
    id: c.id as string,
    name: c.name as string,
    kaizenId: sheet.clientId && /^\d+$/.test(sheet.clientId) ? Number(sheet.clientId) : ((c.kaizen_id as number | null) ?? null),
    website: sheet.website ?? (c.website as string | null) ?? fieldOf(/website/i),
    hqFolder,
    hqUrl: hqField && /^https?:/i.test(hqField) ? hqField : (hqLinks[0] ?? hqField ?? null),
    hqLinks,
    clientFolder,
    figma: sheet.figma ?? fieldOf(/figma/i),
    platform: platform ?? fieldOf(/platform/i),
  };
}

export type ApproveResult = { ok: true; docUrl: string; folder: string; asPerson: boolean; already: boolean; hqUrl?: string } | { ok: false; error: string; fixHref?: string; askForLink?: boolean };

/**
 * Approves the copy: a Google Doc of it in the client's Headquarters folder, inside "Email Marketing" (or the line's
 * folder; found whatever its case or numbering, made when missing), made as the person approving. The Headquarters is
 * found, never made (src/lib/copy-docs/hq-path.ts): a pasted link, the stored HQ links, the client's folder, then the
 * Clients root; when none leads there, it asks for the link. Approved again after a change: a new Doc.
 */
export async function approveCopyDoc(admin: Admin, db: SupabaseClient, me: Me, id: string, opts: { folder?: string; line?: string; hqLink?: string | null } = {}): Promise<ApproveResult> {
  const folderName = opts.folder ?? EMAIL_FOLDER;
  const d = await loadCopyDoc(db, id);
  if (!d) return { ok: false, error: "That copy isn't one you can approve." };
  if (d.status !== "draft" && d.docUrl) return { ok: true, docUrl: d.docUrl, folder: folderName, asPerson: true, already: true };
  if (!d.clientId) return { ok: false, error: "This copy has no client, so there's no Drive folder to put it in." };
  const facts = await clientFacts(admin, d.clientId, opts.line);
  const fixHref = d.clientSlug ? `/clients/${d.clientSlug}` : undefined;
  const { driveFor } = await import("./drive");
  const { findHq, lineFolderStep } = await import("./hq-path");
  const root = process.env.GOOGLE_SHARED_DRIVE_ID ?? null;
  const pasted = opts.hqLink && /drive\.google\.com|^[\w-]{20,}$/.test(opts.hqLink.trim()) ? opts.hqLink.trim() : null;
  const probe = [pasted, ...facts.hqLinks, facts.clientFolder, root].map((x) => (x ? folderIdOf(x) : null)).find(Boolean) ?? null;
  const ask = `paste the link to ${facts.name}'s Headquarters folder and I'll put it there.`;
  if (!probe) return { ok: false, error: `I don't know where ${facts.name}'s Headquarters folder is in Drive: ${ask}`, fixHref, askForLink: true };
  let made: { id: string; url: string };
  let folder: string;
  let asPerson = false;
  let hqId: string;
  try {
    const look = await driveFor(me.email, probe);
    const hq = await findHq(look.drive, { client: { name: facts.name, kaizenId: facts.kaizenId }, pasted, stored: facts.hqLinks, clientFolder: facts.clientFolder, root });
    if (!hq.ok) return { ok: false, error: hq.error, fixHref, askForLink: true };
    hqId = hq.id;
    // Written as whoever can open the Headquarters itself (the person when Google allows, else the Drive user)
    const got = await driveFor(me.email, hq.id);
    asPerson = got.asPerson;
    folder = (await findOrCreateFolder(got.drive, hq.id, lineFolderStep(opts.line, folderName))).id;
    made = await got.drive.createDoc(folder, copyDocName({ client: facts.name, kind: d.content.kind, shortName: d.content.shortName, sendDate: d.content.brief.sendDate }), copyDocHtml(d.content, { client: facts.name }));
    // A pasted Headquarters link is kept on the client's sheet tab for the line, only where it had none
    if (hq.via === "pasted" && !facts.hqLinks.length) await rememberHq(admin, d.clientId, opts.line ?? "email", `https://drive.google.com/drive/folders/${hq.id}`).catch(() => undefined);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (/not connected/i.test(m)) return { ok: false, error: "Drive isn't connected yet: an admin needs to add the Google service account (with the Drive scope allowed for domain-wide delegation)." };
    if (/\b(?:401|403|404)\b|unauthorized_client|not found|forbidden/i.test(m)) return { ok: false, error: `Google won't let Kaizen OS open ${facts.name}'s Headquarters folder. Share it with the Drive user, or ${ask}`, fixHref, askForLink: true };
    return { ok: false, error: `Drive had a problem: ${m.slice(0, 160)}` };
  }
  await admin.from("copy_docs").update({ status: "approved", approved_by: me.id, approved_at: new Date().toISOString(), doc_id: made.id, doc_url: made.url, folder_id: folder, updated_at: new Date().toISOString() }).eq("id", id);
  return { ok: true, docUrl: made.url, folder: folderName, asPerson, already: false, hqUrl: `https://drive.google.com/drive/folders/${hqId}` };
}

/** Keeps a Headquarters link given on a call on the client's account sheet tab for the line (only when it had none) */
async function rememberHq(admin: Admin, clientId: string, line: string, url: string) {
  const { data } = await admin.from("clients").select("channel_sheet").eq("id", clientId).maybeSingle();
  const tabs = (data?.channel_sheet ?? {}) as Record<string, Record<string, unknown>>;
  const key = `${line}_details`;
  if (tabs[key]?.hq) return;
  await admin.from("clients").update({ channel_sheet: { ...tabs, [key]: { ...(tabs[key] ?? {}), hq: url } } }).eq("id", clientId);
}
