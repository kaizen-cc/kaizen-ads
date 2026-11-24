import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sourceOf, type Attached, type Feedback, type FeedbackFile } from "./direction-feedback-core";

// The client's original feedback for a change (src/lib/direction-feedback-core.ts): the whole message from where it
// was said (Slack through Kaizen's Slack app, an email, the portal chat, a call), its files from Slack, and those files
// attached to an Asana task as the person applying it (too big: linked instead).

const MAX_ATTACH = 25 * 1024 * 1024;

type SlackFile = { name?: string; title?: string; size?: number; mimetype?: string; url_private_download?: string; url_private?: string; permalink?: string };

/** The files on a Slack message (channel and ts from its id), read with Kaizen's Slack app */
async function slackFilesOf(externalId: string): Promise<SlackFile[]> {
  const [channel, ts] = externalId.split(":");
  if (!channel || !ts || !process.env.SLACK_BOT_TOKEN) return [];
  try {
    const { slack } = await import("@/lib/context/slack");
    const r = await slack<{ messages?: { ts: string; files?: SlackFile[] }[] }>("conversations.history", { channel, latest: ts, oldest: ts, inclusive: "true", limit: "1" });
    let m = (r.messages ?? []).find((x) => x.ts === ts);
    if (!m) {
      // A reply in a thread isn't in the channel's history
      const t = await slack<{ messages?: { ts: string; files?: SlackFile[] }[] }>("conversations.replies", { channel, ts, latest: ts, inclusive: "true", limit: "1" }).catch(() => ({ messages: [] }));
      m = (t.messages ?? []).find((x) => x.ts === ts);
    }
    return m?.files ?? [];
  } catch {
    return [];
  }
}

const whereOf: Record<string, string> = { slack_external: "Slack", gmail: "Email", portal: "the portal chat", call: "a call" };

/** The client's full original message behind a change, or null when it was logged by the team in their own words */
export async function loadFeedback(admin: SupabaseClient, c: { source_ref: string | null; url: string | null; said_at: string | null; quote: string | null }): Promise<(Feedback & { slackFiles: SlackFile[] }) | null> {
  const src = sourceOf(c.source_ref);
  if (!src) return null;
  if (src.kind === "context") {
    const { data } = await admin.from("context_items").select("author, occurred_at, body, url").eq("source", src.source).eq("external_id", src.externalId).maybeSingle();
    if (!data?.body) return null;
    const slackFiles = src.source === "slack_external" ? await slackFilesOf(src.externalId) : [];
    return {
      author: String(data.author ?? "The client"),
      at: (data.occurred_at as string | null) ?? c.said_at,
      where: whereOf[src.source],
      text: String(data.body).slice(0, 8000),
      permalink: (data.url as string | null) ?? c.url,
      files: slackFiles.map((f): FeedbackFile => ({ name: f.name ?? f.title ?? "file", url: f.permalink ?? null, size: f.size ?? null, mime: f.mimetype ?? null })),
      slackFiles,
    };
  }
  if (src.kind === "portal") {
    const { data } = await admin.from("portal_chat_messages").select("author_name, text, sent_at").eq("id", src.id).maybeSingle();
    if (!data?.text) return null;
    return { author: String(data.author_name ?? "The client"), at: (data.sent_at as string | null) ?? c.said_at, where: whereOf.portal, text: String(data.text).slice(0, 8000), permalink: null, files: [], slackFiles: [] };
  }
  const { data } = await admin.from("client_calls").select("title, occurred_at, url, summary").eq("id", src.id).maybeSingle();
  if (!data) return null;
  const s = (data.summary ?? {}) as { clientSaid?: string[] };
  const text = s.clientSaid?.length ? s.clientSaid.join("\n") : (c.quote ?? "");
  if (!text) return null;
  return { author: "The client", at: (data.occurred_at as string | null) ?? c.said_at, where: `${whereOf.call}${data.title ? ` (${data.title})` : ""}`, text, permalink: (data.url as string | null) ?? c.url, files: [], slackFiles: [] };
}

/**
 * The client's Slack files attached to an Asana task (as whoever runs it: the person applying, src/lib/asana-user.ts),
 * each read with Kaizen's Slack app; too big or unreadable, it's linked instead. Returns what was attached and linked,
 * with the attachment ids (so Undo can take them off again).
 */
export async function attachSlackFiles(taskGid: string, files: SlackFile[]): Promise<{ attached: Attached[]; ids: string[] }> {
  const attached: Attached[] = [];
  const ids: string[] = [];
  const { asanaAttach } = await import("@/lib/asana");
  const { isAsanaConnectNeeded } = await import("@/lib/asana-connect");
  for (const f of files.slice(0, 8)) {
    const name = f.name ?? f.title ?? "file";
    const url = f.url_private_download ?? f.url_private ?? null;
    if (!url || !process.env.SLACK_BOT_TOKEN || (f.size ?? 0) > MAX_ATTACH) {
      attached.push({ name, url: f.permalink ?? null });
      continue;
    }
    try {
      const res = await fetch(url, { headers: { authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }, cache: "no-store" });
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || type.includes("text/html")) throw new Error("Slack wouldn't give the file");
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > MAX_ATTACH) throw new Error("too big");
      const a = await asanaAttach(taskGid, name, bytes, f.mimetype ?? type);
      ids.push(a.gid);
      attached.push({ name, url: null });
    } catch (e) {
      if (isAsanaConnectNeeded(e)) throw e;
      attached.push({ name, url: f.permalink ?? null });
    }
  }
  return { attached, ids };
}
