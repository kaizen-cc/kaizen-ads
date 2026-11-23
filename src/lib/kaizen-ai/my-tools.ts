import "server-only";
import type { AiTool } from "@/lib/ai";
import { CHUNK_CHARS, readChunk, searchTerms, searchText } from "@/lib/assistant/long-text";
import type { ChatTool, ToolCtx } from "./tools";

// The person's own things, for Kaizen AI and their assistant alike (the assistant gets every chat tool): their Kaizen
// AI chats and the Claude chats and projects they imported, searched by title and content and read whole, a part at
// a time; any Google Docs, Sheets, Slides or Drive file opened as them (their own Drive access, read only); and a
// search of everything on file for a client by name (Slack, email, Drive, calls and Looms, creative, memory).

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const safe = (s: string) => s.replace(/[%_,()\\]/g, " ").replace(/\s+/g, " ").trim();

type ThreadRow = { id: string; title: string; source: string | null; project_id: string | null; last_message_at: string; client_id: string | null };

/** What was read from a Google file, for a few minutes (reading the next part doesn't open it again) */
const GOOGLE_CACHE = new Map<string, { at: number; read: Awaited<ReturnType<typeof import("@/lib/assistant/read-file").readGoogleFile>> }>();

async function googleRead(email: string, url: string) {
  const key = `${email}|${url}`;
  const hit = GOOGLE_CACHE.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.read;
  const { readGoogleFile } = await import("@/lib/assistant/read-file");
  const read = await readGoogleFile(email, url);
  if (read.ok) {
    if (GOOGLE_CACHE.size > 40) GOOGLE_CACHE.delete(GOOGLE_CACHE.keys().next().value!);
    GOOGLE_CACHE.set(key, { at: Date.now(), read });
  }
  return read;
}

/** While the owner views the app as a teammate, that teammate's own mailbox, Drive, calendar and chats stay private */
export const PRIVATE_WHILE_VIEWING = "While viewing as someone, their own Gmail, Drive, Calendar and Kaizen AI chats stay private.";
export const viewingAs = (ctx: Pick<ToolCtx, "me">) => Boolean(ctx.me.viewAs);

/** A long text as a tool answer: one part (whole when it fits), or the passages matching a search */
export function textAnswer(text: string, input: Record<string, unknown>): Record<string, unknown> {
  const q = clip(input.search, 200);
  if (q) {
    const hits = searchText(text, q, { limit: 8 });
    return { chars: text.length, parts: Math.max(1, Math.ceil(text.length / CHUNK_CHARS)), search: q, matches: hits.map((h) => ({ part: h.chunk + 1, text: h.snippet })), note: hits.length ? "Read a whole part with part: n." : "Nothing matched those words; try others, or read it part by part." };
  }
  const c = readChunk(text, Number(input.part ?? 1) - 1);
  return { part: c.part, parts: c.parts, chars: c.chars, text: c.text, ...(c.next ? { next: `There's more: read part ${c.next} of ${c.parts}.` } : {}) };
}

export function myTools(ctx: ToolCtx): ChatTool[] {
  const tools: ChatTool[] = [
    {
      name: "remember",
      description:
        "Saves something about the person to their own memory, which every one of their chats and calls reads from then on (only they see it; they can see and forget it on their assistant's page): how they like to work (\"keep drafts short\", \"numbers first\"), a preference, or a lesson for every client (\"always lead subject lines with the offer\": topic work). Never a client's details (those stay in that client's chats), secrets or health. Say in a few words that you'll remember it.",
      input_schema: {
        type: "object",
        properties: { topic: { type: "string", enum: ["preference", "work", "routine", "uses", "goals", "focus", "other"] }, body: { type: "string", description: "One short sentence, in the second person (\"You like drafts short.\")" } },
        required: ["topic", "body"],
        additionalProperties: false,
      },
      status: () => "Remembering that…",
      run: async (input) => {
        if (viewingAs(ctx)) return { error: "While viewing as someone, nothing is saved to their memory." };
        const { cleanMemory } = await import("@/lib/assistant/core");
        const notes = cleanMemory({ notes: [{ kind: "fact", topic: input.topic, body: input.body }] });
        if (!notes.length) return { saved: false, note: "That isn't something kept (a client's details, secrets, health). Say so kindly." };
        const { saveNotes } = await import("@/lib/assistant/memory");
        await saveNotes(ctx.admin, ctx.me.id, notes, null);
        return { saved: true, where: "Their assistant's page, under what it knows (they can forget it there)" };
      },
    },
    {
      name: "search_my_kaizen_ai",
      description:
        "Searches the person's own Kaizen AI chats, the Claude chats and projects they imported, and the documents in their Kaizen AI projects: by title (e.g. a thread called \"Kore Outdoor 284 NEW\") and by what was said in them. Words match anywhere (accents and case aside); put a phrase in quotes to match it as written. Returns the matching threads and projects with a passage of each; read one whole with read_my_kaizen_ai.",
      input_schema: { type: "object", properties: { query: { type: "string", description: "A title, a client, or words that were said" }, limit: { type: "integer" } }, required: ["query"], additionalProperties: false },
      status: (input) => `Searching your Kaizen AI chats for ${clip(input.query, 40)}…`,
      run: async (input) => {
        if (viewingAs(ctx)) return { error: PRIVATE_WHILE_VIEWING };
        const query = clip(input.query, 200);
        const terms = searchTerms(query).filter((t) => t.length >= 3).slice(0, 4);
        if (!query) throw new Error("What should I look for?");
        const limit = Math.min(20, Number(input.limit) || 10);
        const whole = safe(query);
        // Their own threads (with the server's rights, always filtered to them): by title, the whole query or every word
        let byTitle = ctx.admin.from("ai_threads").select("id, title, source, project_id, last_message_at, client_id").eq("profile_id", ctx.me.id).is("archived_at", null);
        byTitle = terms.length > 1 ? terms.reduce((q, t) => q.ilike("title", `%${safe(t)}%`), byTitle) : byTitle.ilike("title", `%${whole}%`);
        // And by content: the whole phrase first, else every word in the same message
        const inMessages = async (words: string[]) => {
          let q = ctx.admin.from("ai_messages").select("thread_id, content, created_at, ai_threads!inner(id, title, source, profile_id, project_id, last_message_at)").eq("ai_threads.profile_id", ctx.me.id);
          for (const w of words) q = q.ilike("content", `%${safe(w)}%`);
          const { data } = await q.order("created_at", { ascending: false }).limit(40);
          return (data ?? []) as unknown as { thread_id: string; content: string; created_at: string; ai_threads: ThreadRow }[];
        };
        const [{ data: titled }, phrase, docs, projects] = await Promise.all([
          byTitle.order("last_message_at", { ascending: false }).limit(limit),
          whole.length >= 3 ? inMessages([whole]) : Promise.resolve([]),
          ctx.db.from("ai_project_docs").select("id, name, text, project_id, ai_projects(name)").or(`name.ilike.%${whole}%,text.ilike.%${whole}%`).limit(8),
          ctx.db.from("ai_projects").select("id, name, description, source").ilike("name", `%${whole}%`).is("archived_at", null).limit(8),
        ]);
        const said = phrase.length || terms.length < 2 ? phrase : await inMessages(terms);
        const threads = new Map<string, { thread_id: string; title: string; from_claude: boolean; last: string; matches: string[] }>();
        for (const t of (titled ?? []) as ThreadRow[]) threads.set(t.id, { thread_id: t.id, title: t.title, from_claude: t.source === "claude", last: String(t.last_message_at).slice(0, 10), matches: ["(the title matches)"] });
        for (const m of said) {
          const t = m.ai_threads;
          const got = threads.get(t.id) ?? { thread_id: t.id, title: t.title, from_claude: t.source === "claude", last: String(t.last_message_at).slice(0, 10), matches: [] };
          if (got.matches.length < 3) got.matches.push(searchText(m.content, query, { limit: 1, around: 220 })[0]?.snippet ?? clip(m.content, 300));
          threads.set(t.id, got);
        }
        type Doc = { id: string; name: string; text: string | null; project_id: string; ai_projects: { name: string } | null };
        return {
          threads: [...threads.values()].slice(0, limit),
          project_documents: ((docs.data ?? []) as unknown as Doc[]).map((d) => ({ project_doc_id: d.id, name: d.name, project: d.ai_projects?.name ?? null, match: searchText(d.text ?? "", query, { limit: 1, around: 220 })[0]?.snippet ?? null })),
          projects: ((projects.data ?? []) as { id: string; name: string; description: string | null; source: string | null }[]).map((p) => ({ project_id: p.id, name: p.name, about: clip(p.description, 200), from_claude: p.source === "claude" })),
          note: threads.size || (docs.data ?? []).length || (projects.data ?? []).length ? "Read one whole with read_my_kaizen_ai (thread_id, project_id or project_doc_id)." : "Nothing in their Kaizen AI chats or imported Claude chats matches; try other words.",
        };
      },
    },
    {
      name: "read_my_kaizen_ai",
      description:
        "Reads one of the person's Kaizen AI chats or imported Claude chats whole (thread_id), a Kaizen AI project's instructions and documents (project_id), or one project document (project_doc_id), a part at a time (part: 1, 2...) or the passages matching a search. Ids come from search_my_kaizen_ai.",
      input_schema: { type: "object", properties: { thread_id: { type: "string" }, project_id: { type: "string" }, project_doc_id: { type: "string" }, part: { type: "integer", minimum: 1 }, search: { type: "string", description: "Words to find inside it (instead of a part)" } }, additionalProperties: false },
      status: () => "Reading the chat…",
      run: async (input) => {
        if (viewingAs(ctx)) return { error: PRIVATE_WHILE_VIEWING };
        const id = (k: string) => (typeof input[k] === "string" && /^[0-9a-f-]{36}$/i.test(input[k] as string) ? (input[k] as string) : null);
        if (id("project_doc_id")) {
          const { data: d } = await ctx.db.from("ai_project_docs").select("name, text, note, ai_projects(name)").eq("id", id("project_doc_id")!).maybeSingle();
          if (!d) return { error: "No such project document that you can open." };
          return { document: d.name, project: (d.ai_projects as unknown as { name: string } | null)?.name ?? null, ...textAnswer(String(d.text ?? d.note ?? "(no text)"), input) };
        }
        if (id("project_id")) {
          const [{ data: p }, { data: docs }] = await Promise.all([
            ctx.db.from("ai_projects").select("name, description, instructions").eq("id", id("project_id")!).maybeSingle(),
            ctx.db.from("ai_project_docs").select("id, name, chars").eq("project_id", id("project_id")!).order("created_at").limit(100),
          ]);
          if (!p) return { error: "No such project that you can open." };
          const text = `Project: ${p.name}\n${p.description ? `About: ${p.description}\n` : ""}${p.instructions ? `\nInstructions:\n${p.instructions}\n` : ""}`;
          return { project: p.name, documents: (docs ?? []).map((d) => ({ project_doc_id: d.id, name: d.name, chars: d.chars })), ...textAnswer(text, input) };
        }
        const tid = id("thread_id");
        if (!tid) return { error: "Which thread? Give a thread_id from search_my_kaizen_ai." };
        const { data: t } = await ctx.admin.from("ai_threads").select("id, title, source, notes, project_id, history_summary, created_at").eq("id", tid).eq("profile_id", ctx.me.id).maybeSingle();
        if (!t) return { error: "That isn't one of their chats." };
        const { data: msgs } = await ctx.admin.from("ai_messages").select("role, content, attachments, created_at").eq("thread_id", tid).order("created_at").limit(2000);
        type Att = { name: string; text?: string | null };
        const notes = ((t.notes ?? []) as { name?: string; text?: string }[]).filter((n) => n?.text).map((n) => `[Project document: ${n.name ?? "notes"}]\n${n.text}`);
        const lines = ((msgs ?? []) as { role: string; content: string; attachments: Att[] | null; created_at: string }[]).map((m) => {
          const files = (m.attachments ?? []).map((a) => (a.text ? `\n[Attached ${a.name}]\n${a.text}` : `\n[Attached ${a.name}]`)).join("");
          return `${m.role === "user" ? "Them" : t.source === "claude" ? "Claude" : "Kaizen AI"} (${String(m.created_at).slice(0, 10)}): ${m.content}${files}`;
        });
        const text = [...notes, ...lines].join("\n\n");
        return { thread: t.title, from_claude: t.source === "claude", messages: lines.length, ...textAnswer(text || "(an empty chat)", input) };
      },
    },
    {
      name: "read_google_file",
      description:
        "Opens a Google Docs, Sheets, Slides or Drive link (a PDF, Word, Excel or text file in Drive, or a folder's list) as the person, with their own Drive access, and reads its whole text: Docs and Slides as text, Sheets every tab as CSV. Long files come a part at a time (part: 1, 2...), or search inside it. Use it whenever they share or mention a Google link; never ask them to paste the contents.",
      input_schema: { type: "object", properties: { url: { type: "string", description: "The docs.google.com or drive.google.com link" }, part: { type: "integer", minimum: 1 }, search: { type: "string", description: "Words to find inside it (instead of a part)" } }, required: ["url"], additionalProperties: false },
      status: () => "Opening the Google file…",
      run: async (input) => {
        if (viewingAs(ctx)) return { opened: false, why: PRIVATE_WHILE_VIEWING };
        const read = await googleRead(ctx.me.email, String(input.url ?? "").trim());
        if (!read.ok) return { opened: false, why: read.say, ...(read.problem === "scope" ? { for_the_admin: "Add https://www.googleapis.com/auth/drive.readonly to the service account's domain-wide delegation (Google Admin console, Security, API controls)." } : {}) };
        return { opened: true, title: read.title, kind: read.kind, modified: read.modified?.slice(0, 10) ?? null, link: read.url, ...(read.note ? { note: read.note } : {}), ...textAnswer(read.text || "(empty)", input) };
      },
    },
  ];

  // A client's records by name, when the chat isn't pinned to one (pinned chats have it already, for that client)
  if (!ctx.clientId)
    tools.push({
      name: "search_client",
      description:
        "Searches everything on file for a client by name: client and internal Slack channels, email, Drive files, recorded calls (Fireflies and Gemini notes, transcripts) and Loom notes, creative requests and review comments, and what's remembered about them (the client's notes). Give the client and words to look for (any match), optionally sources and a start date. Use it for context on a client before asking the person where to look.",
      input_schema: {
        type: "object",
        properties: {
          client: { type: "string", description: "The client's name" },
          words: { type: "array", items: { type: "string" } },
          sources: { type: "array", items: { type: "string", enum: ["slack", "email", "drive", "calls", "creative", "memory"] } },
          since: { type: "string", description: "YYYY-MM-DD, optional" },
        },
        required: ["client", "words"],
        additionalProperties: false,
      },
      status: (input) => `Searching ${clip(input.client, 40) || "the client"}'s Slack, email, Drive and calls…`,
      run: async (input) => {
        const { clientNamedForTools } = await import("./tools");
        const c = await clientNamedForTools(ctx, input);
        const { reportTools } = await import("@/lib/reports/tools");
        const found = (await reportTools(ctx.admin, { client_id: c.id, platform: "meta", kpi_targets: null }, [])).find((t: AiTool) => t.name === "search_client");
        if (!found) return { error: "Searching isn't available right now." };
        const { client: _drop, ...rest } = input;
        void _drop;
        return { client: c.name, found: await found.run(rest) };
      },
    });
  return tools;
}
