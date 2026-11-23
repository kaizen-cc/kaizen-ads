import "server-only";
import type { LoopTool } from "@/lib/agent-call/tool-loop";
import { textAnswer } from "@/lib/kaizen-ai/my-tools";
import type { GmailMessage } from "@/lib/context/google";
import { uploadText, type CallUpload } from "./uploads";
import type { AssistantCtx } from "./tools";
import type { NeedsConnection } from "@/lib/personal-connections-core";

// The assistant's lookups in the person's own private places, on a call or in its chat: their Slack (DMs included,
// through their own connected Slack token) and their Gmail (their own mailbox only, read only), each searched and a
// thread read whole; and what was uploaded or pasted in this conversation, read a part at a time or searched. Private
// by construction: every read is as this person (their token, their mailbox), and only their own assistant has these
// tools; agents and Kaizen AI threads others can see don't.

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

type SlackMatch = { channel?: { id?: string; name?: string; is_im?: boolean; is_mpim?: boolean; is_private?: boolean }; user?: string; username?: string; ts?: string; text?: string; permalink?: string };

/** Where a Slack match was: a DM, a group DM or #channel */
const placeOf = (m: SlackMatch) => (m.channel?.is_im ? "a direct message" : m.channel?.is_mpim ? "a group DM" : m.channel?.name ? `#${m.channel.name}` : "Slack");
/** The thread a match belongs to (its permalink names the parent), else the message itself */
export const slackThreadTs = (m: { ts?: string; permalink?: string }) => m.permalink?.match(/[?&]thread_ts=(\d+\.\d+)/)?.[1] ?? m.ts ?? "";

export function lookupTools(ctx: AssistantCtx): LoopTool[] {
  const names = new Map<string, string>();
  async function nameOf(id: string | undefined, token: string): Promise<string> {
    if (!id) return "Someone";
    if (names.has(id)) return names.get(id)!;
    const { slackRead } = await import("@/lib/slack-user");
    const r = await slackRead<{ ok: boolean; user?: { real_name?: string; profile?: { display_name?: string; real_name?: string } } }>(process.env.SLACK_BOT_TOKEN || token, "users.info", { user: id }).catch(() => null);
    const n = r?.user?.profile?.display_name || r?.user?.profile?.real_name || r?.user?.real_name || "Someone";
    names.set(id, n);
    return n;
  }

  /** Their Slack token when it may read; else the needs_connection answer, with the Connect card on screen */
  async function slackFor(): Promise<{ token: string } | NeedsConnection> {
    const { slackTokenFor, showConnect } = await import("@/lib/personal-connections");
    const got = await slackTokenFor(ctx.me.id, "read");
    if ("needs_connection" in got) showConnect(ctx.emit, got);
    return got;
  }
  /** A Slack error that's the connection itself (expired, missing a scope): the same answer and card */
  async function slackFailed(error: string | undefined): Promise<NeedsConnection | null> {
    const { slackErrorNeeds, showConnect } = await import("@/lib/personal-connections");
    const n = slackErrorNeeds(error);
    if (n) showConnect(ctx.emit, n);
    return n;
  }

  const tools: LoopTool[] = [
    {
      name: "search_my_slack",
      description:
        "Searches the person's own Slack as them: every channel they're in and their DMs and group DMs (their connected Slack). Slack search syntax works (from:@name, in:#channel, in:@person for a DM, after:2026-10-01, \"exact phrase\"). Returns each match with who, where, when, the text and a thread ref; read one whole with read_my_slack_thread. Private to them: only for what they asked, never to mine personal details.",
      input_schema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } }, required: ["query"], additionalProperties: false },
      run: async (input) => {
        const query = clip(input.query, 300);
        if (!query) return { error: "What should I look for?" };
        const got = await slackFor();
        if ("needs_connection" in got) {
          // Meanwhile: the client channels Kaizen OS already keeps (only clients they can see; no DMs)
          const words = query.replace(/[%_,()"]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !w.includes(":")).slice(0, 4);
          const { data } = words.length ? await ctx.db.from("context_items").select("author, body, occurred_at, url, clients(name)").in("source", ["slack_internal", "slack_external"]).or(words.map((w) => `body.ilike.%${w}%`).join(",")).order("occurred_at", { ascending: false }).limit(12) : { data: [] };
          return { ...got, searched: "client channels only (no DMs)", matches: ((data ?? []) as unknown as { author: string | null; body: string | null; occurred_at: string; url: string | null; clients: { name: string } | null }[]).map((i) => ({ who: i.author, client: i.clients?.name ?? null, when: i.occurred_at.slice(0, 10), text: clip(i.body, 400), link: i.url })) };
        }
        const { slackRead } = await import("@/lib/slack-user");
        const r = await slackRead<{ ok: boolean; error?: string; messages?: { total?: number; matches?: SlackMatch[] } }>(got.token, "search.messages", { query, count: String(Math.min(30, Number(input.limit) || 15)), sort: "timestamp", sort_dir: "desc" });
        if (!r.ok) return (await slackFailed(r.error)) ?? { error: `Slack said ${r.error ?? "no"}.` };
        const matches = r.messages?.matches ?? [];
        return {
          total: r.messages?.total ?? matches.length,
          matches: await Promise.all(
            matches.map(async (m) => ({
              who: m.username || (await nameOf(m.user, got.token)),
              where: placeOf(m),
              when: m.ts ? new Date(Number(m.ts) * 1000).toISOString().slice(0, 16).replace("T", " ") : null,
              text: clip(m.text, 600),
              thread: m.channel?.id ? `${m.channel.id}:${slackThreadTs(m)}` : null,
              link: m.permalink ?? null,
            })),
          ),
        };
      },
    },
    {
      name: "read_my_slack_thread",
      description: "Reads a Slack thread or DM conversation whole as the person (the thread ref from search_my_slack: channel:ts), every reply with who and when.",
      input_schema: { type: "object", properties: { thread: { type: "string", description: "The ref from search_my_slack" }, part: { type: "integer", minimum: 1 }, search: { type: "string" } }, required: ["thread"], additionalProperties: false },
      run: async (input) => {
        const [channel, ts] = String(input.thread ?? "").split(":");
        if (!/^[CDG][A-Z0-9]{6,}$/.test(channel ?? "") || !/^\d+\.\d+$/.test(ts ?? "")) return { error: "That isn't a thread ref from search_my_slack." };
        const got = await slackFor();
        if ("needs_connection" in got) return got;
        const { slackRead } = await import("@/lib/slack-user");
        type Msg = { user?: string; username?: string; text?: string; ts?: string; files?: { name?: string }[] };
        let msgs: Msg[] = [];
        let cursor = "";
        for (let page = 0; page < 10; page++) {
          const r = await slackRead<{ ok: boolean; error?: string; messages?: Msg[]; response_metadata?: { next_cursor?: string } }>(got.token, "conversations.replies", { channel, ts, limit: "200", ...(cursor ? { cursor } : {}) });
          if (!r.ok) return (await slackFailed(r.error)) ?? { error: r.error === "thread_not_found" ? "Slack can't find that thread." : `Slack said ${r.error ?? "no"}.` };
          msgs = msgs.concat(r.messages ?? []);
          cursor = r.response_metadata?.next_cursor ?? "";
          if (!cursor) break;
        }
        const lines = await Promise.all(msgs.map(async (m) => `${m.username || (await nameOf(m.user, got.token))} (${m.ts ? new Date(Number(m.ts) * 1000).toISOString().slice(0, 16).replace("T", " ") : ""}): ${m.text ?? ""}${m.files?.length ? ` [files: ${m.files.map((f) => f.name).join(", ")}]` : ""}`));
        return { messages: lines.length, ...textAnswer(lines.join("\n\n") || "(empty)", input) };
      },
    },
    {
      name: "search_my_email",
      description:
        "Searches the person's own Gmail (their mailbox only, read only) with Gmail search syntax (from:, to:, subject:, after:2026/10/01, \"exact phrase\", has:attachment). Returns each email with who, when, the subject, a snippet and a thread id; read one whole with read_my_email_thread. To reply in one, pass its thread_id to draft_message as email_thread (the reply stays in that thread). Private to them: only for what they asked.",
      input_schema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } }, required: ["query"], additionalProperties: false },
      run: async (input) => {
        const q = clip(input.query, 300);
        if (!q) return { error: "What should I look for?" };
        const { gmailToken, google, googleConfigured } = await import("@/lib/context/google");
        if (!googleConfigured()) return { error: "Google isn't connected to Kaizen OS." };
        try {
          const token = await gmailToken(ctx.me.email);
          const list = await google<{ messages?: { id: string; threadId: string }[]; resultSizeEstimate?: number }>(token, "https://gmail.googleapis.com/gmail/v1/users/me/messages", { q, maxResults: String(Math.min(25, Number(input.limit) || 12)) });
          type Meta = { id: string; threadId: string; snippet?: string; internalDate: string; payload: { headers: { name: string; value: string }[] } };
          const metas = await Promise.all((list.messages ?? []).map((m) => google<Meta>(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}`, { format: "metadata" }).catch(() => null)));
          const h = (m: Meta, n: string) => m.payload.headers.find((x) => x.name.toLowerCase() === n)?.value ?? "";
          return {
            total: list.resultSizeEstimate ?? metas.length,
            emails: metas.flatMap((m) => (m ? [{ from: h(m, "from"), to: h(m, "to"), subject: h(m, "subject"), when: new Date(Number(m.internalDate)).toISOString().slice(0, 10), snippet: clip(m.snippet, 300), thread_id: m.threadId }] : [])),
          };
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          if (/unauthorized_client|access_denied|insufficient/i.test(m)) return (await import("@/lib/personal-connections")).googleNeeds("gmail", "https://www.googleapis.com/auth/gmail.readonly", "search your Gmail");
          return { error: `Gmail couldn't search (${m.slice(0, 120)}).` };
        }
      },
    },
    {
      name: "read_my_email_thread",
      description: "Reads one of the person's own email threads whole (thread_id from search_my_email): each email's sender, date and text, quoted history left out.",
      input_schema: { type: "object", properties: { thread_id: { type: "string" }, part: { type: "integer", minimum: 1 }, search: { type: "string" } }, required: ["thread_id"], additionalProperties: false },
      run: async (input) => {
        const id = String(input.thread_id ?? "");
        if (!/^[0-9a-f]{8,24}$/i.test(id)) return { error: "That isn't a thread id from search_my_email." };
        const { gmailToken, google, plainText, withoutQuotes } = await import("@/lib/context/google");
        try {
          const t = await google<{ messages: GmailMessage[] }>(await gmailToken(ctx.me.email), `https://gmail.googleapis.com/gmail/v1/users/me/threads/${id}`, { format: "full" });
          const lines = t.messages.map((m) => {
            const h = (n: string) => m.payload.headers.find((x) => x.name.toLowerCase() === n)?.value ?? "";
            return `From ${h("from")} to ${h("to")} (${new Date(Number(m.internalDate)).toISOString().slice(0, 16).replace("T", " ")})\nSubject: ${h("subject")}\n${withoutQuotes(plainText(m.payload) ?? m.snippet ?? "").trim()}`;
          });
          return { emails: lines.length, ...textAnswer(lines.join("\n\n---\n\n"), input) };
        } catch (e) {
          return { error: `Gmail couldn't open it (${(e instanceof Error ? e.message : String(e)).slice(0, 120)}).` };
        }
      },
    },
    {
      name: "read_upload",
      description: "Reads a file uploaded in this conversation whole, a part at a time (part: 1, 2...), or finds passages in it (search). Every page of a PDF, Word, PowerPoint, Excel (every tab), CSV or text file is kept. Use it to answer from the document itself, or to read it again when they ask.",
      input_schema: { type: "object", properties: { name: { type: "string", description: "The file's name (or part of it); leave out for the newest document" }, part: { type: "integer", minimum: 1 }, search: { type: "string" } }, additionalProperties: false },
      run: async (input) => {
        const { data } = await ctx.admin.from("ai_role_calls").select("uploads").eq("id", ctx.callId).maybeSingle();
        const ups = ((data?.uploads ?? []) as CallUpload[]).filter((u) => u.kind === "pdf" || u.kind === "doc" || u.kind === "text");
        const want = clip(input.name, 200).toLowerCase();
        const u = (want ? ups.filter((x) => x.name.toLowerCase().includes(want)) : ups).at(-1);
        if (!u) return { error: ups.length ? `No document called ${want}. There are: ${ups.map((x) => x.name).join(", ")}.` : "No documents were uploaded in this conversation." };
        if (!u.textPath) return { file: u.name, error: u.pending ? "It's a scan still being typed out: try again in a minute." : (u.textNote ?? "No text could be read from it.") };
        const text = await uploadText(ctx.admin, u);
        if (!text) return { file: u.name, error: "Its text isn't there any more." };
        return { file: u.name, pages: u.pages ?? null, ...(u.textNote ? { note: u.textNote } : {}), ...textAnswer(text, input) };
      },
    },
    {
      name: "read_pasted_text",
      description: "Reads, whole, the long messages they pasted or typed in this conversation (a document pasted in several parts comes back joined, in order), a part at a time, or finds passages in them. Use it when a pasted message shows as kept whole, or when they say they pasted something in parts.",
      input_schema: { type: "object", properties: { which: { type: "string", enum: ["all", "latest"], description: "all: every long message joined in order (default); latest: the newest one" }, part: { type: "integer", minimum: 1 }, search: { type: "string" } }, additionalProperties: false },
      run: async (input) => {
        const { data } = await ctx.admin.from("ai_role_chats").select("content, created_at").eq("call_id", ctx.callId).eq("role", "user").eq("created_by", ctx.me.id).order("created_at").limit(400);
        const long = ((data ?? []) as { content: string; created_at: string }[]).filter((r) => (r.content ?? "").length >= 1500);
        if (!long.length) return { error: "Nothing long was pasted in this conversation." };
        const pick = input.which === "latest" ? long.slice(-1) : long;
        const text = pick.map((r, i) => (pick.length > 1 ? `[Pasted message ${i + 1} of ${pick.length}]\n${r.content}` : r.content)).join("\n\n");
        return { messages: pick.length, ...textAnswer(text, input) };
      },
    },
  ];
  // While the owner views the app as someone, that person's own mailbox and Slack stay private
  const PRIVATE = new Set(["search_my_slack", "read_my_slack_thread", "search_my_email", "read_my_email_thread"]);
  return ctx.me.viewAs ? tools.map((t) => (PRIVATE.has(t.name) ? { ...t, run: async () => ({ error: "While viewing as someone, their own mailbox and Slack stay private." }) } : t)) : tools;
}
