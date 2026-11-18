import "server-only";
import { firstNameOf } from "./core";
import { askedForNote, cleanItems, mergeItems, titleProblem, type CheckItem } from "./ask-rules";
import { OWNER_SEAT } from "./role-focus";
import type { ChatTool, ToolCtx } from "@/lib/kaizen-ai/tools";

// What an agent can do when asked on a call or in its chat: a reminder for the person ("remind me about that"), or a
// task for whoever owns it on the client ("make sure that gets done": the client's seat holder for that work, primary
// first). Both land in that person's Overview, Next for me, credited "From <first name> via the <agent>", with what
// was said. Nothing is sent to a client. Only when asked in so many words (ask-rules.ts), with a clear action as the
// title, and related things said on one call go on ONE checklist reminder (its items ticked off in Next for me). A
// reminder can carry the call's transcript (a download button on it) when they ask for it.

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

const NOT_ASKED =
  "Not saved yet: what they just said didn't read as asking for a reminder or a task. If they did mean one, offer it in a few words (\"Want me to put that on your list for today?\") and save it on their yes. Never tell them the system didn't register it, and never ask them to repeat a phrase.";
/** Words that add to the list already made on this call ("also add…", "put that on there too") */
const ADDS = /\b(add|also|include|another|too|as well|on there|on the list)\b/i;

/** Columns that came with the checklist (before their migration, a reminder is saved without them) */
const missingColumn = (e: { message?: string } | null) => Boolean(e && /checklist|with_transcript|column/i.test(e.message ?? ""));

export function askTools(ctx: ToolCtx, agent: { roleKey: string; label: string; callId: string | null; said?: string | null }): ChatTool[] {
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
  const save = async (row: { kind: "reminder" | "task"; owner: string; client: { id: string } | null; title: string; detail: string; due: string | null; checklist?: CheckItem[]; withTranscript?: boolean }) => {
    const base = { kind: row.kind, owner_id: row.owner, asked_by: ctx.me.id, role_key: agent.roleKey, call_id: agent.callId, client_id: row.client?.id ?? null, title: row.title, detail: row.detail, due_on: row.due };
    let { data, error } = await ctx.admin
      .from("agent_asks")
      .insert({ ...base, checklist: row.checklist ?? [], with_transcript: row.withTranscript === true })
      .select("id")
      .single();
    // Before the checklist's migration: the items go in the detail instead
    if (missingColumn(error)) {
      const items = (row.checklist ?? []).map((i) => `- ${i.text}`).join("\n");
      ({ data, error } = await ctx.admin
        .from("agent_asks")
        .insert({ ...base, detail: [row.detail, items].filter(Boolean).join("\n").slice(0, 2000) })
        .select("id")
        .single());
    }
    if (error || !data) throw new Error("Couldn't save it. Try again in a moment.");
    return data.id as string;
  };
  /** The open reminder this call already made for this person about the same client: related things join it */
  const listOnThisCall = async (client: { id: string } | null) => {
    if (!agent.callId) return null;
    let q = ctx.admin.from("agent_asks").select("id, title, detail, checklist, with_transcript").eq("call_id", agent.callId).eq("owner_id", ctx.me.id).eq("kind", "reminder").eq("status", "open");
    q = client ? q.eq("client_id", client.id) : q.is("client_id", null);
    const { data, error } = await q.order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (missingColumn(error)) {
      let q2 = ctx.admin.from("agent_asks").select("id, title, detail").eq("call_id", agent.callId).eq("owner_id", ctx.me.id).eq("kind", "reminder").eq("status", "open");
      q2 = client ? q2.eq("client_id", client.id) : q2.is("client_id", null);
      const { data: d2 } = await q2.order("created_at", { ascending: false }).limit(1).maybeSingle();
      return d2 ? { id: d2.id as string, title: d2.title as string, detail: (d2.detail as string) ?? "", checklist: null as CheckItem[] | null, withTranscript: false } : null;
    }
    return data ? { id: data.id as string, title: data.title as string, detail: (data.detail as string) ?? "", checklist: cleanItems(data.checklist), withTranscript: data.with_transcript === true } : null;
  };
  return [
    {
      name: "remind_me",
      description: `A reminder for the person you're talking with, on their Overview (Next for me). Only when they ask for one in so many words ("remind me", "put that on my list", "make it a task", "send me the transcript in a task"), or say yes when you offer one. The title (what) is a clear action for them, starting with a verb ("Send Ocean Box the new offer", "Review the email bars per industry"). Related things on one call go on ONE checklist: list them as items, and anything added later in the call joins the same list on its own (separate: true only for an unrelated topic). Never make a reminder out of your own uncertainty or a decision you're unsure of: ask them instead. with_transcript: true when they ask for this call's transcript with it (the reminder gets a download button). Then confirm in a few words ("Done, it's on your list for Thursday").`,
      input_schema: {
        type: "object",
        properties: {
          what: { type: "string", description: "What to do, as a short action starting with a verb" },
          items: { type: "array", items: { type: "string" }, description: "The checklist: each related thing to do, a short line each" },
          context: { type: "string", description: "What was said that they'll want with it (one or two sentences)" },
          client: { type: "string", description: "The client it's about, if any" },
          due: { type: "string", description: "YYYY-MM-DD (default today)" },
          with_transcript: { type: "boolean", description: "They asked for this call's transcript with it" },
          separate: { type: "boolean", description: "An unrelated topic: its own reminder instead of joining this call's list" },
        },
        required: ["what"],
        additionalProperties: false,
      },
      status: () => "Adding a reminder…",
      run: async (input) => {
        const title = clip(input.what, 160);
        const problem = titleProblem(title);
        if (problem) return { done: false, note: problem };
        const client = await clientNamed(input.client);
        const items = cleanItems(input.items);
        const withTranscript = input.with_transcript === true && Boolean(agent.callId);
        const had = input.separate === true ? null : await listOnThisCall(client);
        const said = agent.said ?? null;
        if (!askedForNote(said) && !(had && ADDS.test(String(said ?? "")))) return { done: false, note: NOT_ASKED };
        const due = DAY.test(String(input.due ?? "")) ? String(input.due) : new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
        if (had) {
          // Joins this call's list: what they asked for becomes an item on it
          const add = items.length ? items : cleanItems([title]);
          const context = clip(input.context, 400);
          const detail = [had.detail, context].filter(Boolean).join(" ").slice(0, 1600);
          if (had.checklist) {
            const checklist = mergeItems(had.checklist, add);
            await ctx.admin.from("agent_asks").update({ checklist, detail, with_transcript: had.withTranscript || withTranscript }).eq("id", had.id);
            return { done: true, joined: had.title, items: checklist.length, on: "their Overview, Next for me", client: client?.name ?? null, transcript: had.withTranscript || withTranscript };
          }
          await ctx.admin.from("agent_asks").update({ detail: [detail, ...add.map((i) => `- ${i.text}`)].join("\n").slice(0, 2000) }).eq("id", had.id);
          return { done: true, joined: had.title, on: "their Overview, Next for me", client: client?.name ?? null };
        }
        await save({ kind: "reminder", owner: ctx.me.id, client, title, detail: clip(input.context, 800), due, checklist: items, withTranscript });
        return { done: true, on: "their Overview, Next for me", due, client: client?.name ?? null, items: items.length || undefined, transcript: withTranscript || undefined };
      },
    },
    {
      name: "ask_teammate",
      description: `When they name the person ("ask Dana", "tell the head of email"), use send_to_teammate instead. Asks the right teammate to get something done on a client, when the person asks you to make sure it happens ("make sure that gets done", "have the strategist do it"), or says yes to a hand-off you proposed, or corrects who it goes to ("it should be on the Meta buyer": that IS the ask, send it with what you'd drafted): the title is a clear action for that teammate, never your own uncertainty. It goes on that teammate's Overview, Next for me, credited "From ${firstNameOf(ctx.me.fullName)} via the ${agent.label}", with the context. The owner is the client's holder of the seat for that work on a line the client buys (see client_team), primary first; "the buyer" or "the strategist" means your own line's seat; an empty seat goes to the next owner on that line (say who). Never offer or route to a role on a line the client doesn't buy. Nothing is sent to the client. Then confirm with the owner's first name ("Done, I've asked Dana to …").`,
      input_schema: {
        type: "object",
        properties: {
          client: { type: "string", description: "The client's name" },
          what: { type: "string", description: "What needs doing, as a short line" },
          context: { type: "string", description: "What was said: why, numbers, anything the owner needs (one to three sentences)" },
          seat: { type: "string", enum: SEATS, description: "Whose job it is on the client (coordinator = the account manager); only a seat on a line the client buys" },
          to: { type: "string", description: "Who, as they said it (\"the Meta media buyer\", \"the strategist\", \"the account lead\"): routed through the client's lines and seats, your own line by default" },
          due: { type: "string", description: "YYYY-MM-DD, if a date was said" },
        },
        required: ["client", "what"],
        additionalProperties: false,
      },
      status: (input) => `Asking the team on ${clip(input.client, 60) || "the client"}…`,
      run: async (input) => {
        // Their ask, or their yes (or correction) to a hand-off you proposed, is enough: no phrase to repeat
        const client = await clientNamed(input.client);
        if (!client) throw new Error("Which client is it for?");
        const title = clip(input.what, 160);
        const problem = titleProblem(title);
        if (problem) return { done: false, note: problem };
        const { clientTeam, recipientFor } = await import("@/lib/assistant/routing-server");
        const team = await clientTeam(ctx.admin, client.id);
        const seatWord = SEATS.includes(String(input.seat)) ? (SEAT_WORDS[String(input.seat)] ?? "") : "";
        const words = clip(input.to, 120) || seatWord || (OWNER_SEAT[agent.roleKey] ? (SEAT_WORDS[OWNER_SEAT[agent.roleKey]] ?? "") : "account manager");
        const r = await recipientFor(ctx.admin, { to: words, client: team, agentRole: agent.roleKey, exclude: ctx.me.id });
        if (!r.ok) return { done: false, note: r.note, options: r.options };
        const due = DAY.test(String(input.due ?? "")) ? String(input.due) : null;
        const id = await save({ kind: "task", owner: r.to.id, client, title, detail: clip(input.context, 800), due });
        const from = firstNameOf(ctx.me.fullName);
        if (r.to.id !== ctx.me.id) {
          const { tellTeammate } = await import("@/lib/assistant/handoff-server");
          await tellTeammate(ctx.admin, { ownerId: r.to.id, askId: id, title: `${client.name}: ${title}`, body: `From ${from} via the ${agent.label}${input.context ? `: ${clip(input.context, 400)}` : ""}` });
        }
        return { done: true, asked: firstNameOf(r.to.name), client: client.name, due, routed: r.to.why ?? undefined, note: r.to.why ? "Say who you sent it to and why in a few words." : undefined };
      },
    },
  ];
}
