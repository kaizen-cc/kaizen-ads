import "server-only";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { officeText } from "@/lib/client-docs";
import { chunkPages, chunkText, type Section } from "@/lib/knowledge-chunks";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// Knowledge the agents read: PDFs, Word and PowerPoint files, pictures of documents and text files, added to one agent
// (or a whole role, e.g. every Strategist skill), to every agent, to the Ads Lab library or to one client. Each file is
// read once: its text (straight from the file when it has text, or the AI reading the pages when it's a scan or a
// picture), a title, a short summary, key points, and chunks with page numbers. A call never gets whole documents:
// only the few chunks that match what it's doing, within a budget, each cited by its title, so stacking up knowledge
// doesn't drown the instructions.

export const KNOWLEDGE_BUCKET = "knowledge";
export const MAX_KNOWLEDGE_BYTES = 50 * 1024 * 1024;
/** What the AI can read as pages (scans, pictures): Claude's limits for one PDF */
const MAX_AI_PDF_BYTES = 30 * 1024 * 1024;
const MAX_AI_PAGES = 100;
const MAX_TEXT = 400_000;

export type KnowledgeScope = "agent" | "shared" | "lab" | "client";
export type KnowledgeTarget = { scope: "agent"; agentKey: string } | { scope: "shared" } | { scope: "lab" } | { scope: "client"; clientId: string };
export type KnowledgeDoc = {
  id: string;
  name: string;
  title: string | null;
  summary: string | null;
  keyPoints: string[];
  pages: number | null;
  status: "reading" | "ready" | "failed";
  progress: number;
  note: string | null;
  method: string | null;
  background: boolean;
  bytes: number | null;
  mime: string | null;
  by: string | null;
  at: string;
  /** Where it came from when it's text from a link (a Loom video), not an uploaded file */
  url: string | null;
};

const SELECT = "id, name, title, summary, key_points, pages, status, progress, note, method, background, bytes, mime, source_url, created_at, profiles:uploaded_by(full_name)";

/** The knowledge added to one place, newest first (removed agent, shared and Lab files are left out) */
export async function listKnowledge(db: SupabaseClient, t: KnowledgeTarget): Promise<KnowledgeDoc[]> {
  let q = db.from("knowledge_docs").select(SELECT).eq("scope", t.scope).is("removed_at", null).order("created_at", { ascending: false }).limit(100);
  if (t.scope === "agent") q = q.eq("agent_key", t.agentKey);
  if (t.scope === "client") q = q.eq("client_id", t.clientId);
  const { data } = await q;
  return (data ?? []).map((d) => ({
    id: d.id as string,
    name: d.name as string,
    title: (d.title as string | null) ?? null,
    summary: (d.summary as string | null) ?? null,
    keyPoints: Array.isArray(d.key_points) ? (d.key_points as string[]) : [],
    pages: (d.pages as number | null) ?? null,
    status: d.status as KnowledgeDoc["status"],
    progress: (d.progress as number) ?? 0,
    note: (d.note as string | null) ?? null,
    method: (d.method as string | null) ?? null,
    background: Boolean(d.background),
    bytes: d.bytes == null ? null : Number(d.bytes),
    mime: (d.mime as string | null) ?? null,
    by: (d.profiles as unknown as { full_name: string } | null)?.full_name ?? null,
    at: d.created_at as string,
    url: (d.source_url as string | null) ?? null,
  }));
}

/** The folder a target's files live in (so a file can only be filed where it was uploaded for) */
export const folderOf = (t: KnowledgeTarget) => (t.scope === "agent" ? `agent/${t.agentKey.replace(/[^\w:-]/g, "")}` : t.scope === "client" ? `client/${t.clientId}` : t.scope);

const safe = (name: string) => name.replace(/[^\w.-]+/g, "-").slice(-90);

/** Signed upload slots in the knowledge bucket: the browser sends each file straight to storage */
export async function knowledgeSlots(admin: SupabaseClient, t: KnowledgeTarget, files: { name: string; bytes: number }[]) {
  if (!files.length || files.length > 10) throw new Error("Up to ten files at a time.");
  if (files.some((f) => f.bytes > MAX_KNOWLEDGE_BYTES)) throw new Error("Files up to 50 MB.");
  const slots: { path: string; token: string }[] = [];
  for (const f of files) {
    const path = `${folderOf(t)}/${crypto.randomUUID()}-${safe(f.name)}`;
    const { data, error } = await admin.storage.from(KNOWLEDGE_BUCKET).createSignedUploadUrl(path);
    if (error || !data) throw new Error("Uploads aren't working right now. Try again in a minute.");
    slots.push({ path, token: data.token });
  }
  return slots;
}

/** Files already in storage, saved as "reading" for the target. Returns their ids. */
export async function addKnowledge(admin: SupabaseClient, t: KnowledgeTarget, by: string | null, files: { path: string; name: string; mime: string; bytes: number }[]) {
  const mine = files.filter((f) => f.path.startsWith(`${folderOf(t)}/`)).slice(0, 10);
  if (!mine.length) return [];
  const rows = mine.map((f) => ({
    scope: t.scope,
    agent_key: t.scope === "agent" ? t.agentKey : null,
    client_id: t.scope === "client" ? t.clientId : null,
    name: f.name.slice(0, 200),
    path: f.path,
    mime: f.mime || null,
    bytes: f.bytes,
    uploaded_by: by,
  }));
  const { data, error } = await admin.from("knowledge_docs").insert(rows).select("id, name");
  if (error) throw new Error(error.message);
  // The Lab's library lists it right away (reading), and reads its text once it's ready
  if (t.scope === "lab")
    for (const d of data ?? []) {
      const { data: s } = await admin.from("lab_sources").insert({ kind: "doc", title: (d.name as string).replace(/\.[a-z0-9]+$/i, "").slice(0, 120), body: "", status: "reading", added_by: by }).select("id").single();
      if (s) await admin.from("knowledge_docs").update({ lab_source_id: s.id }).eq("id", d.id);
    }
  return (data ?? []).map((d) => d.id as string);
}

/** Text-only documents (a Loom's transcript) keep their text in the row: their path says so */
const TEXT_PATH = "text:";

/**
 * Knowledge that's text rather than a file (a Loom video's transcript and what was learned from it): saved like an
 * upload, then read the same way (chunks, and the title and summary when they aren't given). Returns its id.
 */
export async function addKnowledgeText(
  admin: SupabaseClient,
  t: KnowledgeTarget,
  by: string | null,
  doc: { name: string; text: string; url?: string | null; mime?: string; title?: string | null; summary?: string | null; keyPoints?: string[]; method?: string },
) {
  const { data, error } = await admin
    .from("knowledge_docs")
    .insert({
      scope: t.scope,
      agent_key: t.scope === "agent" ? t.agentKey : null,
      client_id: t.scope === "client" ? t.clientId : null,
      name: doc.name.slice(0, 200),
      path: `${TEXT_PATH}${folderOf(t)}/${crypto.randomUUID()}`,
      mime: doc.mime ?? "text/plain",
      bytes: Buffer.byteLength(doc.text, "utf8"),
      text: doc.text.slice(0, MAX_TEXT),
      title: doc.title?.slice(0, 200) || null,
      summary: doc.summary?.slice(0, 2000) || null,
      key_points: (doc.keyPoints ?? []).map((k) => k.trim()).filter(Boolean).slice(0, 8),
      method: doc.method ?? "text",
      source_url: doc.url ?? null,
      uploaded_by: by,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Couldn't save it.");
  await readKnowledge(admin, data.id as string);
  return data.id as string;
}

// ─── Reading a file ─────────────────────────────────────────────────────────

/** A PDF's text, page by page, straight from the file (empty pages when it's a scan) */
export async function pdfPages(buf: Buffer): Promise<string[] | null> {
  try {
    const g = globalThis as unknown as { pdfjsWorker?: unknown };
    // The worker's code runs in this process (no worker thread on the server)
    // @ts-expect-error the worker module has no types
    g.pdfjsWorker ??= await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      pages.push(
        (tc.items as { str?: string; hasEOL?: boolean }[])
          .map((x) => (x.str ?? "") + (x.hasEOL ? "\n" : " "))
          .join("")
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim(),
      );
      page.cleanup();
    }
    await doc.cleanup();
    return pages;
  } catch (e) {
    console.error("[knowledge] pdf text", e instanceof Error ? e.message : e);
    return null;
  }
}

const ABOUT = { type: "object", properties: { title: { type: "string" }, summary: { type: "string" }, key_points: { type: "array", items: { type: "string" } } }, required: ["title", "summary", "key_points"], additionalProperties: false };
const ABOUT_RULES = `title: what the document is, in a few words (keep the document's own title if it has a good one). summary: two to four sentences on what it covers and what in it matters for a paid ads and creative agency. key_points: 3 to 8 short lines, the specifics worth knowing (rules, numbers, frameworks, examples, decisions). Plain text, no names of agency team members.`;
const READ_SYSTEM = "You file documents for Kaizen, a paid ads and creative agency, so its AI agents can look things up in them later: playbooks, guides, SOPs, brand guidelines, case studies, research, decks.";

const ABOUT_AND_SECTIONS = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    key_points: { type: "array", items: { type: "string" } },
    pages: { type: "integer" },
    sections: { type: "array", items: { type: "object", properties: { heading: { type: "string" }, page_from: { type: "integer" }, page_to: { type: "integer" }, text: { type: "string" } }, required: ["heading", "page_from", "page_to", "text"], additionalProperties: false } },
  },
  required: ["title", "summary", "key_points", "pages", "sections"],
  additionalProperties: false,
};

async function progress(admin: SupabaseClient, id: string, p: number) {
  await admin.from("knowledge_docs").update({ progress: p, updated_at: new Date().toISOString() }).eq("id", id);
}

/**
 * Reads one file: its text and chunks, title, summary and key points. A PDF with text is read straight from the file
 * (every page, page numbers kept); a scan, a picture or a PDF without text is read by the AI page by page.
 */
export async function readKnowledge(admin: SupabaseClient, id: string) {
  const { data: d } = await admin.from("knowledge_docs").select("id, scope, name, path, mime, lab_source_id, text, title, summary, key_points, method").eq("id", id).single();
  if (!d) return;
  const fail = async (note: string) => {
    await admin.from("knowledge_docs").update({ status: "failed", note: note.slice(0, 300), progress: 100, updated_at: new Date().toISOString() }).eq("id", id);
    if (d.lab_source_id) await admin.from("lab_sources").update({ status: "failed", summary: note.slice(0, 200) }).eq("id", d.lab_source_id);
  };
  try {
    await admin.from("knowledge_docs").update({ status: "reading", progress: 5, note: null, updated_at: new Date().toISOString() }).eq("id", id);
    // Text from a link (a Loom's transcript) is in the row; a file is in storage
    const isText = (d.path as string).startsWith(TEXT_PATH);
    let buf: Buffer;
    if (isText) {
      if (!(d.text as string | null)?.trim()) return fail("There's no text to read.");
      buf = Buffer.from(d.text as string, "utf8");
    } else {
      const { data: file } = await admin.storage.from(KNOWLEDGE_BUCKET).download(d.path as string);
      if (!file) return fail("The file is missing.");
      buf = Buffer.from(await file.arrayBuffer());
    }
    const name = d.name as string;
    const ext = isText ? "txt" : (name.toLowerCase().split(".").pop() ?? "");
    const mime = isText ? "text/plain" : ((d.mime as string | null) ?? "");
    await progress(admin, id, 15);

    let sections: Section[] = [];
    let pages: number | null = null;
    let method = isText ? ((d.method as string | null) ?? "text") : "text";
    // A text document saved with its title and summary already written isn't summarized again
    let about: { title: string; summary: string; key_points: string[] } | null =
      isText && d.title && d.summary ? { title: d.title as string, summary: d.summary as string, key_points: Array.isArray(d.key_points) ? (d.key_points as string[]) : [] } : null;
    const isPdf = mime === "application/pdf" || ext === "pdf";
    const isImage = mime.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "gif", "heic"].includes(ext);

    if (isPdf) {
      const text = await pdfPages(buf);
      pages = text?.length ?? null;
      const chars = (text ?? []).reduce((n, p) => n + p.length, 0);
      // Enough text on the pages to trust it (a scan has next to none)
      if (text && text.length && chars / text.length >= 200) sections = chunkPages(text);
      else {
        if (buf.byteLength > MAX_AI_PDF_BYTES) return fail("This PDF is a scan over 30 MB: too big for the AI to read its pages. Export it smaller or as text.");
        if (pages && pages > MAX_AI_PAGES) return fail(`This PDF is a scan of ${pages} pages: the AI reads up to ${MAX_AI_PAGES}. Split it, or export it with text.`);
        method = "ai";
      }
    } else if (isImage) method = "ai";
    else if (ext in { docx: 1, pptx: 1, xlsx: 1 }) {
      const text = officeText(buf, ext as "docx" | "pptx" | "xlsx");
      if (!text) return fail("The file couldn't be opened.");
      sections = chunkText(text);
    } else if (mime.startsWith("text/") || ["txt", "md", "markdown", "csv", "json", "html", "htm"].includes(ext)) {
      const raw = buf.toString("utf8");
      const text = ext.startsWith("htm") || mime === "text/html" ? raw.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ") : raw;
      sections = chunkText(text);
    } else return fail("This kind of file isn't read (PDF, Word, PowerPoint, Excel, pictures and text files are).");
    await progress(admin, id, 35);

    if (method === "ai") {
      // The AI reads the pages: a faithful write-up of each section, with its pages, plus the title and summary
      let picture: { mediaType: "image/jpeg"; data: string } | null = null;
      if (isImage) {
        const jpeg = await sharp(buf, { limitInputPixels: 120_000_000 }).rotate().resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer();
        picture = { mediaType: "image/jpeg", data: jpeg.toString("base64") };
      }
      const out = await askJson<{ title: string; summary: string; key_points: string[]; pages: number; sections: { heading: string; page_from: number; page_to: number; text: string }[] }>({
        agent: "briefing",
        label: "read a knowledge pdf ",
        bare: true,
        override: { model: "sonnet", effort: "low" },
        maxTokens: 48000,
        onText: () => {},
        system: READ_SYSTEM,
        schema: ABOUT_AND_SECTIONS,
        pdfs: isPdf ? [{ data: buf.toString("base64"), title: name }] : [],
        images: picture ? [picture] : [],
        prompt: `Document: ${name}\n\nRead every page. ${ABOUT_RULES} pages: how many pages it has (1 for a picture).\nsections: the document written out faithfully as clean markdown, section by section in order, each about 300 to 900 words with its heading and the pages it covers. Keep every specific: rules, numbers, steps, examples, quotes, tables (as markdown tables). Don't summarize them away and don't add anything that isn't there.`,
      });
      pages = out.pages || pages || (isImage ? 1 : null);
      sections = out.sections.filter((s) => s.text.trim()).map((s) => ({ heading: s.heading.slice(0, 120), pageFrom: s.page_from || null, pageTo: s.page_to || s.page_from || null, text: s.text }));
      about = { title: out.title, summary: out.summary, key_points: out.key_points };
    }
    if (!sections.length) return fail("Nothing readable was found in it.");
    await progress(admin, id, 65);

    const full = sections.map((s) => s.text).join("\n\n");
    if (!about) {
      // Title, summary and key points from the text: the start, and the end when it's long
      const sample = full.length > 70_000 ? `${full.slice(0, 60_000)}\n\n[…]\n\n${full.slice(-10_000)}` : full;
      about = await askJson<{ title: string; summary: string; key_points: string[] }>({
        agent: "briefing",
        label: "read a knowledge pdf ",
        bare: true,
        maxTokens: 3000,
        system: READ_SYSTEM,
        schema: ABOUT,
        prompt: `Document: ${name}${pages ? ` (${pages} pages)` : ""}\n<content>\n${sample}\n</content>\n\n${ABOUT_RULES}`,
      });
    }
    await progress(admin, id, 85);

    await admin.from("knowledge_chunks").delete().eq("doc_id", id);
    const rows = sections.map((s, i) => ({ doc_id: id, idx: i, page_from: s.pageFrom, page_to: s.pageTo, heading: s.heading || null, body: s.text.slice(0, 20_000) }));
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await admin.from("knowledge_chunks").insert(rows.slice(i, i + 200));
      if (error) throw new Error(error.message);
    }
    const keyPoints = (about.key_points ?? []).map((k) => k.trim()).filter(Boolean).slice(0, 8);
    await admin
      .from("knowledge_docs")
      .update({ title: about.title.slice(0, 200) || name, summary: about.summary.slice(0, 2000), key_points: keyPoints, pages, text: full.slice(0, MAX_TEXT), method, status: "ready", progress: 100, note: null, updated_at: new Date().toISOString() })
      .eq("id", id);
    // The Lab's copy: the text and takeaways it reads at the table
    if (d.lab_source_id) {
      const { data: still } = await admin.from("lab_sources").update({ title: about.title.slice(0, 120) || name, body: full.slice(0, 200_000), summary: keyPoints.map((k) => `- ${k}`).join("\n"), status: "ready" }).eq("id", d.lab_source_id).select("id");
      // Forgotten in the Lab meanwhile: it stays out
      if (!still?.length) await admin.from("knowledge_docs").update({ removed_at: new Date().toISOString() }).eq("id", id);
    }
    forgetIndex();
  } catch (e) {
    console.error("[knowledge] read", id, e instanceof Error ? e.message : e);
    await fail(e instanceof Error ? e.message : "Couldn't read it.");
  }
}

/** Files left "reading" (the server stopped mid-read): read again, a couple at a time */
export async function keepKnowledge(admin: SupabaseClient, max = 2) {
  const { data } = await admin.from("knowledge_docs").select("id").eq("status", "reading").is("removed_at", null).lt("updated_at", new Date(Date.now() - 15 * 60_000).toISOString()).order("created_at").limit(max);
  for (const d of data ?? []) await readKnowledge(admin, d.id as string);
  return { reread: (data ?? []).length };
}

// ─── What a call reads ──────────────────────────────────────────────────────

type IndexDoc = { id: string; scope: KnowledgeScope; agentKey: string | null; clientId: string | null; title: string; summary: string | null; background: boolean };
let index: { at: number; docs: IndexDoc[]; clients: { id: string; name: string; key: string }[]; roleOf: Map<string, string> } | null = null;
export const forgetIndex = () => (index = null);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Every ready document, which client each belongs to and each skill's role (kept a minute) */
async function knowledgeIndex(admin: SupabaseClient) {
  if (index && Date.now() - index.at < 60_000) return index;
  const { data } = await admin.from("knowledge_docs").select("id, scope, agent_key, client_id, title, name, summary, background").eq("status", "ready").is("removed_at", null).neq("scope", "lab").limit(2000);
  const docs: IndexDoc[] = (data ?? []).map((d) => ({ id: d.id as string, scope: d.scope as KnowledgeScope, agentKey: (d.agent_key as string | null) ?? null, clientId: (d.client_id as string | null) ?? null, title: ((d.title as string | null) || (d.name as string)).replace(/"/g, "'"), summary: (d.summary as string | null) ?? null, background: Boolean(d.background) }));
  const ids = [...new Set(docs.map((d) => d.clientId).filter((x): x is string => Boolean(x)))];
  const [{ data: cs }, { data: agents }] = await Promise.all([
    ids.length ? admin.from("clients").select("id, name").in("id", ids) : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    admin.from("ai_agents").select("key, role_key"),
  ]);
  index = {
    at: Date.now(),
    docs,
    clients: (cs ?? []).map((c) => ({ id: c.id as string, name: c.name as string, key: norm(c.name as string) })).filter((c) => c.key.length >= 4),
    roleOf: new Map((agents ?? []).filter((a) => a.role_key).map((a) => [a.key as string, a.role_key as string])),
  };
  return index;
}

/**
 * The knowledge a call should read: from the documents this agent may use (its own, its role's, every agent's, and a
 * client's own only when the task is about that client), the few chunks that best match the task, within a budget,
 * each with its document's title and pages. Empty when nothing matches, so a call without a use for it costs nothing.
 */
export async function knowledgeBlock({ agent, label, prompt, budget = 9000 }: { agent: string; label: string; prompt: string; budget?: number }) {
  if (!adminConfigured()) return "";
  const admin = createAdminClient();
  const idx = await knowledgeIndex(admin);
  if (!idx.docs.length) return "";
  const role = idx.roleOf.get(agent);
  const text = norm(prompt.slice(0, 40_000));
  const named = new Map(idx.clients.filter((c) => ` ${text} `.includes(` ${c.key} `)).map((c) => [c.id, c.name]));
  const usable = idx.docs.filter(
    (d) => d.scope === "shared" || (d.scope === "agent" && (d.agentKey === agent || (role && d.agentKey === `role:${role}`))) || (d.scope === "client" && d.clientId && named.has(d.clientId)),
  );
  if (!usable.length) return "";
  const byId = new Map(usable.map((d) => [d.id, d]));
  const { data: hits } = await admin.rpc("match_knowledge", { p_query: `${label} ${prompt.slice(0, 20_000)}`, p_docs: usable.map((d) => d.id), p_limit: 24 });
  const ranked = ((hits ?? []) as { doc_id: string; idx: number; page_from: number | null; page_to: number | null; heading: string | null; body: string; rank: number }[])
    .map((h) => ({ ...h, score: h.rank * (byId.get(h.doc_id)?.background ? 0.5 : 1) }))
    .sort((a, b) => b.score - a.score);
  const perDoc = new Map<string, number>();
  const picked: typeof ranked = [];
  let used = 0;
  for (const h of ranked) {
    if ((perDoc.get(h.doc_id) ?? 0) >= 3) continue;
    const body = h.body.length > 3500 ? `${h.body.slice(0, 3500)}…` : h.body;
    if (used + body.length > budget) continue;
    picked.push({ ...h, body });
    used += body.length;
    perDoc.set(h.doc_id, (perDoc.get(h.doc_id) ?? 0) + 1);
  }
  // A client's own documents the excerpts didn't reach: their summaries, so the agent knows they exist
  const clientDocs = usable.filter((d) => d.scope === "client" && !perDoc.has(d.id) && d.summary).slice(0, 6);
  if (!picked.length && !clientDocs.length) return "";
  const pagesOf = (h: { page_from: number | null; page_to: number | null }) => (h.page_from ? ` pages="${h.page_from}${h.page_to && h.page_to !== h.page_from ? `–${h.page_to}` : ""}"` : "");
  const whose = (d: IndexDoc | undefined) => (d?.scope === "client" && d.clientId ? ` client="${(named.get(d.clientId) ?? "").replace(/"/g, "'")}"` : "");
  return `<knowledge_library note="Excerpts from documents the team added for you (playbooks, guides, brand material, case studies), picked because they match this task. Use what's relevant and say which document it came from; ignore what isn't. The task's own instructions and the client's rules win if they differ.">
${picked.map((h) => `<excerpt doc="${byId.get(h.doc_id)?.title ?? "Document"}"${pagesOf(h)}${whose(byId.get(h.doc_id))}>\n${h.body.trim()}\n</excerpt>`).join("\n")}${clientDocs.length ? `\n<also_on_file>\n${clientDocs.map((d) => `- ${d.title}${whose(d)}: ${d.summary}`).join("\n")}\n</also_on_file>` : ""}
</knowledge_library>`;
}
