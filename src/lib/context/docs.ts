import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { askJson } from "@/lib/ai";
import { gmailMailboxes, googleDriveToken } from "@/lib/context/google";
import { rememberLessons, saveItems, trimBody, type Lesson } from "@/lib/context/shared";
import { LIVE } from "@/lib/live";

// Docs anywhere in the Workspace: every 30 minutes, the Google Docs and Slides anyone at Kaizen created or edited are
// read (as their owner, so My Drives count, not just the client folders). One that's about a client (a strategy, an
// audit, a plan, notes) joins that client's context with its key points, and what anyone making their ads should
// remember goes into the client's memory. Docs not about a client (personal, hiring, internal ops) are skipped and
// nothing from them is kept. A doc is read once it's sat still for 20 minutes, and again when it changes.

const DOC = "application/vnd.google-apps.document";
const SLIDES = "application/vnd.google-apps.presentation";
const SETTLE_MS = 20 * 60_000;
const MAX_PER_RUN = 30;

type File = { id: string; name: string; mimeType: string; modifiedTime: string; createdTime: string; webViewLink?: string; owners?: { emailAddress?: string; displayName?: string }[] };

const SCHEMA = {
  type: "object",
  properties: {
    client: { type: "string" },
    kind: { type: "string", enum: ["strategy", "plan", "audit", "report", "notes", "brief", "other"] },
    summary: { type: "string" },
    points: { type: "array", items: { type: "string" } },
    lessons: {
      type: "array",
      items: { type: "object", properties: { kind: { type: "string", enum: ["prefer", "avoid", "note"] }, body: { type: "string" } }, required: ["kind", "body"], additionalProperties: false },
    },
  },
  required: ["client", "kind", "summary", "points", "lessons"],
  additionalProperties: false,
};

const SYSTEM = `You read a document someone at Kaizen, a marketing agency, wrote in Google Drive, to decide whether it's about one of Kaizen's clients and, if so, what it tells the team about that client. Use only what's in the document; don't invent.
client: the client it's about, written exactly as in the list, or "" when it isn't about one client from the list (Kaizen's own business: hiring, HR, training, internal processes, templates, personal documents; or several clients at once with nothing specific to one). When client is "", leave everything else empty.
kind: strategy, plan, audit, report, notes, brief or other.
summary: 2 to 4 sentences: what the document is and what it decides or recommends for the client.
points: up to 8 short lines with the specifics worth knowing (goals, offers, audiences, angles, budgets, dates, what's working or not, what the client wants).
lessons: what anyone making this client's ads, creative or copy should remember from now on: lasting preferences and dislikes (imagery, AI-generated visuals, tone, words, claims), rules, audiences, positioning, business changes. One plain sentence each, ending with where it came from ("from the Q4 strategy doc"). kind: prefer (do this), avoid (don't), note (a fact to know). 0 to 6; none when the document only restates what's obvious.`;

async function drive<T>(token: string, path: string, params: Record<string, string>) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/${path}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!res.ok) throw new Error(`Drive ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return (await res.json()) as T;
}

/** Docs and Slides someone owns, changed in the window. */
async function changedBy(person: string, from: Date, to: Date) {
  const token = await googleDriveToken(person);
  const q = `(mimeType = '${DOC}' or mimeType = '${SLIDES}') and 'me' in owners and modifiedTime > '${from.toISOString()}' and modifiedTime <= '${to.toISOString()}' and trashed = false and not name contains 'Notes by Gemini'`;
  const { files = [] } = await drive<{ files?: File[] }>(token, "files", { q, fields: "files(id,name,mimeType,modifiedTime,createdTime,webViewLink,owners(emailAddress,displayName))", pageSize: "100", orderBy: "modifiedTime" });
  return files.map((f) => ({ f, token, person }));
}

export async function watchDocs(admin: SupabaseClient, budgetMs = 600_000) {
  const deadline = Date.now() + budgetMs;
  const { tracker } = await import("@/lib/progress");
  const t = await tracker(admin, "docs", "documents");
  try {
    const { data: state } = await admin.from("sync_state").select("cursor_at").eq("source", "docs").maybeSingle();
    // First run: the last 14 days. A doc counts once it's sat still for 20 minutes (a new doc starts out empty)
    const from = state?.cursor_at ? new Date(state.cursor_at) : new Date(Date.now() - 14 * 86_400_000);
    const to = new Date(Date.now() - SETTLE_MS);
    t.on("Looking through everyone's Drive");
    const people = await gmailMailboxes();
    const found: Awaited<ReturnType<typeof changedBy>> = [];
    const failed: string[] = [];
    for (let i = 0; i < people.length; i += 5)
      for (const r of await Promise.allSettled(people.slice(i, i + 5).map((p) => changedBy(p, from, to))))
        if (r.status === "fulfilled") found.push(...r.value);
        else failed.push(people[i]);
    // Oldest first, so a run that stops early picks up where it left off
    const unique = [...new Map(found.map((x) => [x.f.id, x])).values()].sort((a, b) => a.f.modifiedTime.localeCompare(b.f.modifiedTime));

    const { data: known } = unique.length ? await admin.from("drive_docs").select("file_id, text_hash").in("file_id", unique.map((x) => x.f.id)) : { data: [] };
    const hashOf = new Map((known ?? []).map((k) => [k.file_id as string, k.text_hash as string | null]));
    const { data: clients } = await admin.from("clients").select("id, name").is("archived_at", null).in("status", LIVE);
    const byName = new Map((clients ?? []).map((c) => [c.name.toLowerCase().replace(/[^a-z0-9]/g, ""), c.id as string]));

    const queue = unique.slice(0, MAX_PER_RUN);
    t.total(queue.length);
    const out = { found: unique.length, read: 0, aboutClients: 0, skipped: 0, unchanged: 0, lessons: 0, failed: failed.length };
    let reached = to;
    for (const { f, token } of queue) {
      if (Date.now() > deadline) {
        reached = new Date(Date.parse(f.modifiedTime) - 1);
        break;
      }
      const owner = f.owners?.[0]?.emailAddress ?? null;
      try {
        const text = (await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}/export?mimeType=text/plain`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" }).then((r) => (r.ok ? r.text() : ""))).trim();
        const hash = createHash("sha1").update(text).digest("hex");
        const base = { file_id: f.id, name: f.name, mime: f.mimeType, owner_email: owner, url: f.webViewLink ?? null, modified_at: f.modifiedTime, read_at: new Date().toISOString(), text_hash: hash };
        if (hashOf.get(f.id) === hash) {
          out.unchanged++;
          t.tick(f.name);
          continue;
        }
        // Too little to say anything yet (an empty doc, a title page)
        if (text.length < 400) {
          await admin.from("drive_docs").upsert({ ...base, status: "skipped", client_id: null, summary: null });
          out.skipped++;
          t.tick(f.name);
          continue;
        }
        const r = await askJson<{ client: string; kind: string; summary: string; points: string[]; lessons: Lesson[] }>({
          agent: "calls",
          label: "read a doc",
          system: SYSTEM,
          schema: SCHEMA,
          maxTokens: 3000,
          prompt: `Clients:\n${(clients ?? []).map((c) => c.name).join("\n")}\n\nDocument: "${f.name}" (${f.mimeType === SLIDES ? "slides" : "doc"}) by ${f.owners?.[0]?.displayName ?? owner ?? "someone"}, last edited ${f.modifiedTime.slice(0, 10)}\n\n<document>\n${text.slice(0, 40_000)}\n</document>`,
        });
        out.read++;
        const clientId = r.client ? byName.get(r.client.toLowerCase().replace(/[^a-z0-9]/g, "")) : undefined;
        // Not about a client: nothing from it is kept
        if (!clientId) {
          await admin.from("drive_docs").upsert({ ...base, status: "skipped", client_id: null, summary: null });
          out.skipped++;
          t.tick(f.name);
          continue;
        }
        await saveItems(admin, [
          {
            client_id: clientId,
            source: "drive",
            external_id: `doc:${f.id}`,
            thread_id: null,
            occurred_at: f.modifiedTime,
            author: f.owners?.[0]?.displayName ?? owner,
            title: f.name,
            body: trimBody([r.summary, ...r.points.map((p) => `- ${p}`)].join("\n"), 4000),
            url: f.webViewLink ?? `https://docs.google.com/document/d/${f.id}`,
            meta: { doc: true, kind: r.kind, mimeType: f.mimeType },
          },
        ]);
        out.lessons += await rememberLessons(admin, clientId, r.lessons, "drive", f.modifiedTime);
        await admin.from("drive_docs").upsert({ ...base, status: "read", client_id: clientId, kind: r.kind, summary: r.summary.slice(0, 2000) });
        out.aboutClients++;
        t.tick(f.name);
      } catch (e) {
        await admin.from("drive_docs").upsert({ file_id: f.id, name: f.name, mime: f.mimeType, owner_email: owner, url: f.webViewLink ?? null, modified_at: f.modifiedTime, status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
        t.tick(f.name, false);
      }
    }
    // More than one run's worth: pick up after the last one read
    if (unique.length > queue.length) reached = new Date(Date.parse(queue[queue.length - 1].f.modifiedTime));
    const now = new Date().toISOString();
    await admin.from("sync_state").upsert({ source: "docs", cursor_at: reached.toISOString(), last_run_at: now, last_result: { ok: true, ...out } });
    await t.finish({ summary: `${out.aboutClients} docs about clients, ${out.lessons} things remembered, ${out.skipped} not about a client` });
    return out;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await admin.from("sync_state").upsert({ source: "docs", last_run_at: new Date().toISOString(), last_result: { ok: false, error } });
    await t.finish({ error });
    throw e;
  }
}
