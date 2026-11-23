import "server-only";
import type { ChatTool, ToolCtx } from "./tools";

// The person's own Asana from Kaizen AI and their assistant ("what's next on my Asana?", "move my Granite task to
// Friday", "mark the Acme statics done", "comment on it that the client sent the logo"): the same reads and writes as
// the task preview on the Overview (src/lib/asana-live.ts), with the same permission check and the same Asana comment
// naming who changed it from Kaizen OS.

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export const ASANA_LIVE_TOOLS = ["my_asana_tasks", "update_asana_task"] as const;

export function asanaLiveTools(ctx: ToolCtx): ChatTool[] {
  /** A task of theirs by a few words of its name or its client, or by its gid */
  const find = async (words: string) => {
    if (/^\d{6,25}$/.test(words)) return { gid: words, name: null as string | null };
    const { myAsanaTasks } = await import("@/lib/asana-live");
    const tasks = await myAsanaTasks(ctx.me.email, ctx.db, ctx.me.id);
    const w = words.toLowerCase().split(/\s+/).filter((x) => x.length > 2);
    const scored = tasks.map((t) => ({ t, n: w.filter((x) => `${t.name} ${t.client ?? ""} ${t.project ?? ""}`.toLowerCase().includes(x)).length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
    if (!scored.length) return null;
    if (scored.length > 1 && scored[1].n === scored[0].n) return { many: scored.slice(0, 5).map((x) => x.t.name) };
    return { gid: scored[0].t.gid, name: scored[0].t.name };
  };
  return [
    {
      name: "my_asana_tasks",
      description: "The person's open Asana tasks (assigned to them), overdue first then by due date: name, client or project, section, due date, and the address that opens its preview on the Overview (open_screen 'my tasks', or the task's open address). Use for \"what's next on my Asana?\", \"what's overdue?\".",
      input_schema: { type: "object", properties: { search: { type: "string", description: "Only tasks whose name, client or project has these words" } }, additionalProperties: false },
      status: () => "Reading your Asana…",
      run: async (input) => {
        const { myAsanaTasks } = await import("@/lib/asana-live");
        const q = clip(input.search, 80).toLowerCase();
        const tasks = (await myAsanaTasks(ctx.me.email, ctx.db, ctx.me.id)).filter((t) => !q || `${t.name} ${t.client ?? ""} ${t.project ?? ""}`.toLowerCase().includes(q));
        const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
        return { overdue: tasks.filter((t) => t.due && t.due < today).length, tasks: tasks.slice(0, 25).map((t) => ({ gid: t.gid, name: t.name, client: t.client ?? t.project, section: t.section, due: t.due, open: `/pipeline?task=${t.gid}` })) };
      },
    },
    {
      name: "update_asana_task",
      description: "Changes one Asana task straight in Asana, as they asked: find it by a few words of its name or client (or its gid), then any of: due (YYYY-MM-DD, or today, tomorrow, friday, next week), start date, completed, name, notes, section (its column, by name), a custom field by name and value, a comment, a subtask to add. Each change leaves an Asana comment saying they made it from Kaizen OS. Only tasks that are theirs, on clients they work on, or their team's. Do it when they ask; say what changed in a few words.",
      input_schema: {
        type: "object",
        properties: {
          task: { type: "string", description: "A few words of the task's name or client, or its gid" },
          due: { type: "string" },
          start: { type: "string" },
          completed: { type: "boolean" },
          name: { type: "string" },
          notes: { type: "string" },
          section: { type: "string", description: "The column to move it to, by name" },
          field: { type: "object", properties: { name: { type: "string" }, value: { type: "string" } }, required: ["name", "value"], additionalProperties: false },
          comment: { type: "string" },
          subtask: { type: "string", description: "A subtask to add" },
        },
        required: ["task"],
        additionalProperties: false,
      },
      status: () => "Updating it in Asana…",
      run: async (input) => {
        if (ctx.me.viewAs) return { ok: false, note: "Not while viewing as someone." };
        const hit = await find(clip(input.task, 120));
        if (!hit) return { ok: false, note: "No open task of theirs matches: ask which one, or read my_asana_tasks." };
        if ("many" in hit) return { ok: false, note: "Several of their tasks match: ask which one.", options: hit.many };
        const { quickDue } = await import("@/lib/asana-live-core");
        const { saveAsanaTask, commentAsanaTask, subtaskAsanaTask, asanaTask } = await import("@/app/(team)/asana-task-actions");
        const got = await asanaTask(hit.gid);
        if (!got.ok) return { ok: false, note: got.error };
        const t = got.task;
        const patch: Record<string, unknown> = {};
        if (input.due) {
          const d = quickDue(clip(input.due, 20));
          if (!d) return { ok: false, note: "Which day? Say a date or a weekday." };
          patch.due = d;
        }
        if (input.start) patch.start = quickDue(clip(input.start, 20));
        if (typeof input.completed === "boolean") patch.completed = input.completed;
        if (input.name) patch.name = clip(input.name, 500);
        if (input.notes) patch.notes = String(input.notes).slice(0, 20000);
        if (input.section) {
          const s = t.sections.find((x) => x.name.toLowerCase().includes(clip(input.section, 80).toLowerCase()));
          if (!s) return { ok: false, note: `No column like that. Its columns: ${t.sections.map((x) => x.name).join(", ")}.` };
          patch.section = s.gid;
          patch.sectionName = s.name;
        }
        if (input.field && typeof input.field === "object") {
          const fi = input.field as { name: string; value: string };
          const f = t.fields.find((x) => x.name.toLowerCase() === fi.name.toLowerCase()) ?? t.fields.find((x) => x.name.toLowerCase().includes(fi.name.toLowerCase()));
          if (!f) return { ok: false, note: `No field like that. Its fields: ${t.fields.map((x) => x.name).join(", ")}.` };
          const v = clip(fi.value, 500);
          const value = f.kind === "enum" ? (f.options.find((o) => o.name.toLowerCase() === v.toLowerCase())?.gid ?? null) : f.kind === "number" ? Number(v) : f.kind === "date" ? { date: quickDue(v) } : v;
          if (f.kind === "enum" && !value) return { ok: false, note: `${f.name} takes: ${f.options.map((o) => o.name).join(", ")}.` };
          patch.fields = { [f.gid]: value };
        }
        const done: string[] = [];
        if (Object.keys(patch).length) {
          const r = await saveAsanaTask(hit.gid, patch);
          if (!r.ok) return { ok: false, note: r.error };
          done.push("updated");
        }
        if (input.comment) {
          const r = await commentAsanaTask(hit.gid, String(input.comment));
          if (!r.ok) return { ok: false, note: r.error };
          done.push("commented");
        }
        if (input.subtask) {
          const r = await subtaskAsanaTask(hit.gid, { add: clip(input.subtask, 300) });
          if (!r.ok) return { ok: false, note: r.error };
          done.push("subtask added");
        }
        return { ok: true, task: t.name, done, open: `/pipeline?task=${hit.gid}` };
      },
    },
  ];
}
