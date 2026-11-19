import "server-only";
import type { ChatTool, ToolCtx } from "./tools";
import { textAnswer } from "./my-tools";

// Asana in Kaizen AI (and the assistant), with no sign-in (owner, Nov 19 2026): Asana's hosted connector needs an app
// registered with Asana, so Kaizen AI reads Asana itself, the same way the boards do. The creative and email task
// mirrors (refreshed all day) to find tasks, the company's Asana access to read one live with its comments. Read only:
// tasks are created and moved through the boards and the brief flow, never from here.

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const safe = (s: string) => s.replace(/[%_,()\\]/g, " ").replace(/\s+/g, " ").trim();

type Row = { gid: string; name: string; section: string | null; stage: string | null; due_on: string | null; assignee_name: string | null; url: string | null; open: boolean; asana_modified_at?: string | null; clients: { name: string } | null };

export function asanaTools(ctx: ToolCtx): ChatTool[] {
  return [
    {
      name: "search_asana",
      description:
        "Finds Asana tasks on the creative and email boards (as Kaizen mirrors them, all day): by words in the task's name, by client, by who it's on (a name, or 'me'), open or done, due before a day. Returns each task's name, client, column, who's on it, due date and its Asana link. Read one whole with read_asana_task (its gid). Use it whenever they ask about a task, what's on someone's plate in Asana, or what's due.",
      input_schema: {
        type: "object",
        properties: {
          words: { type: "string", description: "Words in the task's name" },
          client: { type: "string" },
          assignee: { type: "string", description: "A teammate's name, or 'me'" },
          board: { type: "string", enum: ["creative", "email", "both"] },
          include_done: { type: "boolean" },
          due_before: { type: "string", description: "YYYY-MM-DD" },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
        additionalProperties: false,
      },
      status: (input) => `Searching Asana${input.words ? ` for ${clip(input.words, 30)}` : ""}…`,
      run: async (input) => {
        const limit = Math.min(50, Number(input.limit) || 20);
        const board = String(input.board ?? "both");
        const words = safe(clip(input.words, 80));
        let clientId: string | null = ctx.clientId;
        if (input.client) {
          const { clientNamedForTools } = await import("./tools");
          clientId = (await clientNamedForTools(ctx, input)).id;
        }
        const who = clip(input.assignee, 60);
        const q = (table: "asana_tasks" | "email_asana_tasks") => {
          // Their own session: only the tasks they may see
          let r = ctx.db.from(table).select("gid, name, section, stage, due_on, assignee_name, url, open, asana_modified_at, clients(name)");
          if (!input.include_done) r = r.eq("open", true);
          if (words) for (const w of words.split(" ").filter((x) => x.length > 1).slice(0, 4)) r = r.ilike("name", `%${w}%`);
          if (clientId) r = r.eq("client_id", clientId);
          if (who && /^(me|mine|myself)$/i.test(who)) r = r.eq("profile_id", ctx.me.id);
          else if (who) r = r.ilike("assignee_name", `%${safe(who)}%`);
          if (typeof input.due_before === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.due_before)) r = r.lte("due_on", input.due_before);
          return r.order("due_on", { ascending: true, nullsFirst: false }).limit(limit);
        };
        const [c, e] = await Promise.all([board !== "email" ? q("asana_tasks") : null, board !== "creative" ? q("email_asana_tasks") : null]);
        const rows = [...((c?.data ?? []) as unknown as Row[]).map((r) => ({ ...r, board: "creative" })), ...((e?.data ?? []) as unknown as Row[]).map((r) => ({ ...r, board: "email" }))];
        const tasks = rows.slice(0, limit).map((r) => ({ gid: r.gid, name: r.name, client: r.clients?.name ?? null, board: r.board, column: r.section ?? r.stage, on: r.assignee_name, due: r.due_on, done: !r.open, link: r.url ?? `https://app.asana.com/0/0/${r.gid}` }));
        return { found: tasks.length, tasks, note: tasks.length ? "Read one whole with read_asana_task (gid); share its link to open it in Asana." : "No task matches: try fewer words, another client or include_done." };
      },
    },
    {
      name: "read_asana_task",
      description: "Reads one Asana task live (the company's Asana access): its name, description, who's on it, due date, column, subtasks and the comments, a part at a time or the passages matching a search. gid from search_asana or an app.asana.com link.",
      input_schema: { type: "object", properties: { gid: { type: "string", description: "The task gid, or its Asana link" }, part: { type: "integer", minimum: 1 }, search: { type: "string" } }, required: ["gid"], additionalProperties: false },
      status: () => "Reading the Asana task…",
      run: async (input) => {
        const raw = String(input.gid ?? "");
        const gid = raw.match(/(\d{10,})(?!.*\d{10,})/)?.[1] ?? null;
        if (!gid) return { error: "Give the task's gid or its Asana link." };
        const { asana, asanaConfigured } = await import("@/lib/asana");
        if (!asanaConfigured()) return { error: "Asana isn't connected to Kaizen OS (ASANA_TOKEN in Vercel)." };
        // Only a task Kaizen mirrors, on a board this person can see
        const [{ data: a }, { data: b }] = await Promise.all([ctx.db.from("asana_tasks").select("gid").eq("gid", gid).maybeSingle(), ctx.db.from("email_asana_tasks").select("gid").eq("gid", gid).maybeSingle()]);
        if (!a && !b) return { error: "That task isn't on a board you can see in Kaizen OS." };
        try {
          type Task = { name: string; notes?: string; completed?: boolean; due_on?: string | null; assignee?: { name?: string } | null; permalink_url?: string; memberships?: { section?: { name?: string } }[] };
          const [t, stories, subs] = await Promise.all([
            asana<Task>(`/tasks/${gid}`, { opt_fields: "name,notes,completed,due_on,assignee.name,permalink_url,memberships.section.name" }),
            asana<{ type: string; text?: string; created_at: string; created_by?: { name?: string } }[]>(`/tasks/${gid}/stories`, { opt_fields: "type,text,created_at,created_by.name", limit: "100" }),
            asana<{ name: string; completed: boolean }[]>(`/tasks/${gid}/subtasks`, { opt_fields: "name,completed" }),
          ]);
          const comments = stories.data.filter((s) => s.type === "comment" && s.text).map((s) => `${s.created_by?.name ?? "Someone"} (${s.created_at.slice(0, 10)}): ${s.text}`);
          const text = [`Description:\n${t.data.notes?.trim() || "(none)"}`, subs.data.length ? `Subtasks:\n${subs.data.map((x) => `- [${x.completed ? "x" : " "}] ${x.name}`).join("\n")}` : null, comments.length ? `Comments:\n${comments.join("\n")}` : null].filter(Boolean).join("\n\n");
          return { name: t.data.name, done: Boolean(t.data.completed), on: t.data.assignee?.name ?? null, due: t.data.due_on ?? null, column: t.data.memberships?.find((m) => m.section?.name)?.section?.name ?? null, link: t.data.permalink_url ?? `https://app.asana.com/0/0/${gid}`, ...textAnswer(text, input) };
        } catch (e) {
          return { error: `Asana didn't answer: ${clip(e instanceof Error ? e.message : e, 200)}` };
        }
      },
    },
  ];
}
