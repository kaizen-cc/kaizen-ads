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

const LESSON = { type: "object", properties: { kind: { type: "string", enum: ["prefer", "avoid", "note"] }, body: { type: "string" } }, required: ["kind", "body"], additionalProperties: false };
const SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["strategy", "plan", "audit", "report", "notes", "brief", "other"] },
    clients: {
      type: "array",
      items: {
        type: "object",
        properties: { client: { type: "string" }, summary: { type: "string" }, points: { type: "array", items: { type: "string" } }, lessons: { type: "array", items: LESSON } },
        required: ["client", "summary", "points", "lessons"],
        additionalProperties: false,
      },
    },
  },
  required: ["kind", "clients"],
  additionalProperties: false,
};

const SYSTEM = `You read a document someone at Kaizen, a marketing agency, wrote in Google Drive, to find which of Kaizen's clients it's about and what it tells the team about each. Use only what's in the document; don't invent.
kind: strategy, plan, audit, report, notes, brief or other.
clients: one entry per client from the list the document says something specific about (a doc covering several accounts gets several entries). client: the name exactly as in the list. Empty when it isn't about a client: Kaizen's own business (hiring, HR, training, internal processes), blank templates, personal documents.
summary: 2 to 4 sentences: what the document says and decides or recommends for that client.
points: up to 8 short lines with the specifics (goals, offers, audiences, angles, budgets, dates, results, what's working or not, what the client wants). This is where a period's numbers and results go.
lessons: only what stays true for months and should change how their ads, creative or copy are made: lasting preferences and dislikes (imagery, AI-generated visuals, tone, words, claims), rules, positioning, audiences, products, business changes, an angle or format that has proven itself. Not a month's metrics (ROAS, CPA, CTR, spend), one-off events or dates, plans for next month, or remarks about the document itself. One plain sentence each, ending with where it came from ("from the Q4 strategy doc"). kind: prefer (do this), avoid (don't), note (a fact to know). 0 to 4 per client; most reports have 0 or 1.`;

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
        const r = await askJson<{ kind: string; clients: { client: string; summary: string; points: string[]; lessons: Lesson[] }[] }>({
          agent: "calls",
          label: "read a doc",
          system: SYSTEM,
          schema: SCHEMA,
          maxTokens: 4000,
          prompt: `Clients:\n${(clients ?? []).map((c) => c.name).join("\n")}\n\nDocument: "${f.name}" (${f.mimeType === SLIDES ? "slides" : "doc"}) by ${f.owners?.[0]?.displayName ?? owner ?? "someone"}, last edited ${f.modifiedTime.slice(0, 10)}\n\n<document>\n${text.slice(0, 40_000)}\n</document>`,
        });
        out.read++;
        const about = [
          ...new Map(
            r.clients
              .map((m) => ({ ...m, clientId: byName.get(m.client.toLowerCase().replace(/[^a-z0-9]/g, "")) }))
              .filter((m): m is typeof m & { clientId: string } => Boolean(m.clientId))
              .map((m) => [m.clientId, m]),
          ).values(),
        ];
        // What an earlier read of this doc said is replaced by this one
        await admin.from("context_items").delete().eq("source", "drive").like("external_id", `doc:${f.id}%`);
        // Not about a client: nothing from it is kept
        if (!about.length) {
          await admin.from("drive_docs").upsert({ ...base, status: "skipped", client_id: null, summary: null });
          out.skipped++;
          t.tick(f.name);
          continue;
        }
        for (const m of about) {
          await saveItems(admin, [
            {
              client_id: m.clientId,
              source: "drive",
              external_id: `doc:${f.id}:${m.clientId}`,
              thread_id: null,
              occurred_at: f.modifiedTime,
              author: f.owners?.[0]?.displayName ?? owner,
              title: f.name,
              body: trimBody([m.summary, ...m.points.map((p) => `- ${p}`)].join("\n"), 4000),
              url: f.webViewLink ?? `https://docs.google.com/document/d/${f.id}`,
              meta: { doc: true, kind: r.kind, mimeType: f.mimeType },
            },
          ]);
          out.lessons += await rememberLessons(admin, m.clientId, m.lessons, "drive", f.modifiedTime);
        }
        await admin.from("drive_docs").upsert({ ...base, status: "read", client_id: about[0].clientId, kind: r.kind, summary: about.map((m) => m.summary).join("\n\n").slice(0, 4000) });
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
