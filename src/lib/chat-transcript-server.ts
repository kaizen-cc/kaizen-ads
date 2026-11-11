import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChatReport } from "@/lib/chat-report";
import { buildTranscript, fromAiMessages, fromTurns, launchState, transcriptMarkdown, type LaunchRunRow, type Transcript, type TranscriptEntry } from "@/lib/chat-transcript";

// The whole conversation behind a report, read on the server from where the chat is stored (by its thread, run or
// chat id), never from what the browser had on screen. Chats that aren't stored (Talk it through, the brief revise
// chat, the report studio) fall back to the browser's copy. Only a chat the reporter can see is read.

type Admin = SupabaseClient;
type Me = { id: string; isExec: boolean };

const LAUNCH_COLS = "id, client_id, created_by, platform, status, summary, questions, plan, plan_warnings, error, progress, turns, created_at, updated_at";

async function launchRun(admin: Admin, runId: string, me: Me) {
  const { data: run } = await admin.from("launch_runs").select(LAUNCH_COLS).eq("id", runId).maybeSingle();
  if (!run) return null;
  const { data: items } = await admin.from("launch_items").select("key, kind, status, error").eq("run_id", runId).order("position").limit(500);
  return { run: run as LaunchRunRow & { client_id: string; created_by: string | null }, items: (items ?? []) as { key: string; kind: string; status: string; error: string | null }[], mine: run.created_by === me.id || me.isExec };
}

/** The stored conversation for a report, or null when this chat isn't stored (or can't be found). */
async function fromServer(admin: Admin, r: ChatReport, me: Me): Promise<Omit<Transcript, "cut" | "chat" | "source"> | null> {
  const id = r.threadId;
  switch (r.chat) {
    case "kaizen-ai": {
      if (!id) return null;
      const { data: t } = await admin.from("ai_threads").select("id, profile_id, shared_with, agent_key, model, client_id, clients(name)").eq("id", id).maybeSingle();
      if (!t || !(t.profile_id === me.id || ((t.shared_with as string[] | null) ?? []).includes(me.id) || me.isExec)) return null;
      const [{ data: rows }, { data: conn }] = await Promise.all([
        admin.from("ai_messages").select("role, content, tools, error, agent_key, model, created_at").eq("thread_id", id).order("created_at").limit(1000),
        admin.from("ai_thread_connectors").select("keys").eq("thread_id", id).maybeSingle(),
      ]);
      const entries = fromAiMessages(rows ?? []);
      // A launch started in this thread: its run's state goes with it
      const launches = (rows ?? []).flatMap((m) => ((m.tools as { output?: unknown }[] | null) ?? []).map((x) => JSON.stringify(x.output ?? "").match(/"launch(?:Run|_run|Id)?"\s*:\s*"([0-9a-f-]{36})"/)?.[1])).filter(Boolean) as string[];
      const runs = await Promise.all([...new Set(launches)].slice(-3).map((rid) => launchRun(admin, rid, me)));
      return {
        threadId: id,
        state: {
          thread: id,
          agent: t.agent_key ?? "picked per message",
          model: t.model,
          client: (t.clients as unknown as { name: string } | null)?.name ?? null,
          connectors: (conn?.keys as string[] | undefined) ?? [],
          lastAgent: [...(rows ?? [])].reverse().find((m) => m.role === "assistant")?.agent_key ?? null,
          ...(runs.some(Boolean) ? { launches: runs.filter((x): x is NonNullable<typeof x> => Boolean(x)).map((x) => launchState(x.run, x.items)) } : {}),
        },
        entries,
      };
    }
    case "client-chat": {
      if (!r.clientSlug) return null;
      const { data: c } = await admin.from("clients").select("id, name").eq("slug", r.clientSlug).maybeSingle();
      if (!c) return null;
      const { data: chat } = await admin.from("client_chats").select("turns").eq("client_id", c.id).eq("profile_id", me.id).maybeSingle();
      if (!chat) return null;
      const turns = (chat.turns ?? []) as { launch?: { id: string } }[];
      const ids = [...new Set(turns.map((t) => t.launch?.id).filter((x): x is string => Boolean(x)))].slice(-3);
      const runs = (await Promise.all(ids.map((rid) => launchRun(admin, rid, me)))).filter((x): x is NonNullable<typeof x> => Boolean(x) && x!.run.client_id === c.id);
      return { threadId: `${c.id}:${me.id}`, state: { client: c.name, ...(runs.length ? { launches: runs.map((x) => launchState(x.run, x.items)) } : {}) }, entries: fromTurns(turns) };
    }
    case "launch":
    case "google-launch": {
      if (!id) return null;
      const got = await launchRun(admin, id, me);
      if (!got) return null;
      // The chat the launch was started from, and the launch's own back-and-forth
      const { data: chat } = await admin.from("client_chats").select("turns").eq("client_id", got.run.client_id).eq("profile_id", me.id).maybeSingle();
      const entries: TranscriptEntry[] = [...fromTurns(chat?.turns ?? []), ...fromTurns(got.run.turns ?? [])];
      return { threadId: id, state: launchState(got.run, got.items), entries };
    }
    case "copy-studio": {
      if (!id) return null;
      const { data } = await admin.from("copy_chats").select("messages").eq("request_id", id).maybeSingle();
      return data ? { threadId: id, state: { request: id }, entries: fromTurns(data.messages) } : null;
    }
    case "ads-lab": {
      if (!id) return null;
      const { data } = await admin.from("lab_messages").select("role, agent, body, data, created_at").eq("thread_id", id).order("created_at").limit(1000);
      return data?.length ? { threadId: id, state: { labThread: id }, entries: fromTurns(data.map((m) => ({ ...m, text: m.body, by: m.agent }))) } : null;
    }
    case "suggested-brief": {
      if (!id) return null;
      const { data } = await admin.from("suggestion_messages").select("role, body, created_at").eq("suggestion_id", id).order("created_at").limit(1000);
      return data?.length ? { threadId: id, state: { suggestion: id }, entries: fromTurns(data.map((m) => ({ ...m, text: m.body }))) } : null;
    }
    case "agent-coach": {
      // "agent:<key>" for an agent's coach, "role:<key>" for a role agent's chat
      const [kind, key] = (id ?? "").split(":");
      if (!key) return null;
      const table = kind === "role" ? "ai_role_chats" : "ai_agent_chats";
      const col = kind === "role" ? "role_key" : "agent_key";
      const { data } = await admin.from(table).select("role, content, changes, created_at").eq(col, key).order("created_at").limit(1000);
      return data?.length ? { threadId: id, state: { [kind === "role" ? "role" : "agent"]: key }, entries: fromTurns(data.map((m) => ({ ...m, text: m.content, done: (m.changes as unknown[])?.length ? m.changes : undefined }))) } : null;
    }
    default:
      return null;
  }
}

/**
 * The transcript for a report: the stored conversation where there is one, the browser's copy otherwise (with the
 * state the browser saw added to the server's), redacted and within size.
 */
export async function loadTranscript(admin: Admin, r: ChatReport, me: Me): Promise<Transcript> {
  let server: Awaited<ReturnType<typeof fromServer>> = null;
  try {
    server = await fromServer(admin, r, me);
  } catch (e) {
    console.error("[chat-report] reading the stored chat failed:", e instanceof Error ? e.message : e);
  }
  if (server && server.entries.length)
    return buildTranscript({ chat: r.chat, source: "server", threadId: server.threadId, state: { ...(r.state ?? {}), ...(server.state ?? {}) }, entries: server.entries });
  return buildTranscript({ chat: r.chat, source: "client", threadId: r.threadId, state: r.state, entries: r.entries });
}

export { transcriptMarkdown };
