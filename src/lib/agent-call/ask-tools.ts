import "server-only";
import { firstNameOf } from "./core";
import { OWNER_SEAT } from "./role-focus";
import type { ChatTool, ToolCtx } from "@/lib/kaizen-ai/tools";

// What an agent can do when asked on a call or in its chat: a reminder for the person ("remind me about that"), or a
// task for whoever owns it on the client ("make sure that gets done": the client's seat holder for that work, primary
// first). Both land in that person's Overview, Next for me, credited "From <first name> via the <agent>", with what
// was said. Nothing is sent to a client.

const SEATS = ["coordinator", "meta_buyer", "google_buyer", "tiktok_buyer", "email_strategist", "email_designer", "email_builder", "social_manager", "social_creative", "graphic_designer", "video_editor", "copywriter"];
const SEAT_WORDS: Record<string, string> = {
  coordinator: "account manager",
  meta_buyer: "Meta buyer",
  google_buyer: "Google buyer",
  tiktok_buyer: "TikTok buyer",
  email_strategist: "email strategist",
  email_designer: "email designer",
  email_builder: "email builder",
  social_manager: "social media manager",
  social_creative: "social designer",
  graphic_designer: "designer",
  video_editor: "video editor",
  copywriter: "copywriter",
};
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export function askTools(ctx: ToolCtx, agent: { roleKey: string; label: string; callId: string | null }): ChatTool[] {
  /** The client named, if the person may see it (their own session decides) */
  const clientNamed = async (name: unknown) => {
    const asked = clip(name, 120);
    if (!asked) return null;
    const safe = asked.replace(/[%_,()]/g, " ").trim();
    const { data } = await ctx.db.from("clients").select("id, name, slug").is("archived_at", null).ilike("name", `%${safe}%`).limit(5);
    const hit = (data ?? []).find((c) => String(c.name).toLowerCase() === asked.toLowerCase()) ?? (data ?? [])[0];
    if (!hit) throw new Error(`No client called "${asked}" that you can see.`);
    return hit as { id: string; name: string; slug: string };
  };
  const save = async (row: { kind: "reminder" | "task"; owner: string; client: { id: string } | null; title: string; detail: string; due: string | null }) => {
    const { data, error } = await ctx.admin
      .from("agent_asks")
      .insert({ kind: row.kind, owner_id: row.owner, asked_by: ctx.me.id, role_key: agent.roleKey, call_id: agent.callId, client_id: row.client?.id ?? null, title: row.title, detail: row.detail, due_on: row.due })
      .select("id")
      .single();
    if (error || !data) throw new Error("Couldn't save it. Try again in a moment.");
    return data.id as string;
  };
  return [
    {
      name: "remind_me",
      description: `A reminder for the person you're talking with, on their Overview (Next for me): use it when they ask you to remind them of something. Write what to do plainly, with the context from the conversation. Then confirm in a few words ("Done, it's on your list for Thursday").`,
      input_schema: {
        type: "object",
        properties: { what: { type: "string", description: "What to do, as a short line" }, context: { type: "string", description: "What was said that they'll want with it (one or two sentences)" }, client: { type: "string", description: "The client it's about, if any" }, due: { type: "string", description: "YYYY-MM-DD (default today)" } },
        required: ["what"],
        additionalProperties: false,
      },
      status: () => "Adding a reminder…",
      run: async (input) => {
        const title = clip(input.what, 160);
        if (!title) throw new Error("What should I remind you about?");
        const client = await clientNamed(input.client);
        const due = DAY.test(String(input.due ?? "")) ? String(input.due) : new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
        await save({ kind: "reminder", owner: ctx.me.id, client, title, detail: clip(input.context, 800), due });
        return { done: true, on: "their Overview, Next for me", due, client: client?.name ?? null };
      },
    },
    {
      name: "ask_teammate",
      description: `Asks the right teammate to get something done on a client, when the person asks you to make sure it happens ("make sure that gets done", "have the strategist do it"): it goes on that teammate's Overview, Next for me, credited "From ${firstNameOf(ctx.me.fullName)} via the ${agent.label}", with the context. The owner is the client's holder of the seat for that work (primary first); leave seat out to use this agent's usual owner. Nothing is sent to the client. Then confirm with the owner's first name ("Done, I've asked Dana to …").`,
      input_schema: {
        type: "object",
        properties: {
          client: { type: "string", description: "The client's name" },
          what: { type: "string", description: "What needs doing, as a short line" },
          context: { type: "string", description: "What was said: why, numbers, anything the owner needs (one to three sentences)" },
          seat: { type: "string", enum: SEATS, description: "Whose job it is on the client (coordinator = the account manager)" },
          due: { type: "string", description: "YYYY-MM-DD, if a date was said" },
        },
        required: ["client", "what"],
        additionalProperties: false,
      },
      status: (input) => `Asking the team on ${clip(input.client, 60) || "the client"}…`,
      run: async (input) => {
        const client = await clientNamed(input.client);
        if (!client) throw new Error("Which client is it for?");
        const title = clip(input.what, 160);
        if (!title) throw new Error("What needs doing?");
        const seat = SEATS.includes(String(input.seat)) ? String(input.seat) : (OWNER_SEAT[agent.roleKey] ?? "coordinator");
        const { data: seats } = await ctx.admin.from("client_assignments").select("profile_id, is_primary, created_at, profiles(full_name, is_active)").eq("client_id", client.id).eq("role", seat);
        type Seat = { profile_id: string; is_primary: boolean | null; created_at: string | null; profiles: { full_name: string; is_active: boolean } | null };
        const holders = ((seats ?? []) as unknown as Seat[]).filter((s) => s.profiles?.is_active !== false).sort((a, b) => Number(b.is_primary !== false) - Number(a.is_primary !== false) || String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
        const owner = holders[0];
        if (!owner) return { done: false, note: `${client.name} has no ${SEAT_WORDS[seat] ?? seat} in the app. Say so, and offer a reminder for the person instead (remind_me).` };
        const due = DAY.test(String(input.due ?? "")) ? String(input.due) : null;
        const id = await save({ kind: "task", owner: owner.profile_id, client, title, detail: clip(input.context, 800), due });
        const from = firstNameOf(ctx.me.fullName);
        if (owner.profile_id !== ctx.me.id)
          await ctx.admin
            .from("notifications")
            .upsert({ profile_id: owner.profile_id, kind: "agent", title: `${client.name}: ${title}`, body: `From ${from} via the ${agent.label}${input.context ? `: ${clip(input.context, 400)}` : ""}`, href: "/pipeline#next", key: `agent-ask:${id}`, priority: "normal", read_at: null }, { onConflict: "profile_id,key" })
            .then(({ error }) => error && console.error("[agent ask] notice", error.message));
        return { done: true, asked: firstNameOf(owner.profiles?.full_name), seat: SEAT_WORDS[seat] ?? seat, client: client.name, due };
      },
    },
  ];
}
