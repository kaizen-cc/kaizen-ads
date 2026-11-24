import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { getCursor, setCursor } from "@/lib/context/shared";
import { cleanComment, lineOfChannel, linesOfShare, shareNote, shareSignal, sharerWords, videoIdsIn, videoUrl } from "@/lib/youtube-core";

// YouTube videos shared in Slack, into the agents' knowledge (owner, Nov 24 2026). Whenever anyone on the team shares
// a YouTube link where Kaizen OS reads Slack, the video goes through the same pipeline as the channels the agents study
// (src/lib/youtube.ts): transcript, takeaways by line, shared with the team, and only what a line head or exec accepts
// teaches an agent. Three places are read:
//   - team channels the bot is in (#facebook, a line's channel), every 30 minutes in the YouTube step; public channels
//     named for a line (facebook, google, email, social, creative, tracking…) are joined so they're read;
//   - client channels, as the context sync reads them (their Loom links already go to the knowledge the same way);
//   - a person's own DMs, only their own messages, only when they've connected Slack reading (search:read).
// One video is processed once however many times it's shared: each share is kept and linked (youtube_shares). The
// share sets the video's lines (the channel's, else the sharer's), its credit ("Shared by the paid-ads exec in
// #facebook: …") and its priority (an exec, praise, @channel). A video shared in a client channel is also filed to
// that client's knowledge when it's relevant to them.

type Admin = SupabaseClient;
const DAY = 86_400_000;
/** A team channel read for the first time looks back this far */
const FIRST_LOOK_DAYS = 14;

type Person = { id: string; role: string; is_exec: boolean; exec_focus: string[] | null; full_name: string | null; slack_user_id: string | null };

export type Share = {
  videoId: string;
  source: "slack" | "slack_dm";
  channelId: string;
  channelName: string | null;
  clientId: string | null;
  messageTs: string;
  permalink: string | null;
  person: Person | null;
  authorName: string | null;
  comment: string | null;
  sharedAt: string;
};

async function team(admin: Admin): Promise<Person[]> {
  const { data } = await admin.from("profiles").select("id, role, is_exec, exec_focus, full_name, slack_user_id").eq("is_active", true);
  return (data ?? []) as Person[];
}

/** The shares in one Slack message (each YouTube video in it) */
export function sharesIn(m: { text?: string | null; ts: string; user?: string | null; authorName?: string | null }, where: { channelId: string; channelName: string | null; clientId: string | null; source: "slack" | "slack_dm"; permalink?: string | null }, people: Person[]): Share[] {
  const ids = videoIdsIn(m.text ?? "");
  if (!ids.length) return [];
  const person = (m.user && people.find((p) => p.slack_user_id === m.user)) || (m.authorName && people.find((p) => p.full_name && p.full_name.toLowerCase() === m.authorName!.toLowerCase())) || null;
  return ids.map((videoId) => ({
    videoId,
    source: where.source,
    channelId: where.channelId,
    channelName: where.channelName,
    clientId: where.clientId,
    messageTs: m.ts,
    permalink: where.permalink ?? null,
    person,
    authorName: person?.full_name ?? m.authorName ?? null,
    comment: where.source === "slack_dm" ? null : cleanComment(m.text) || null,
    sharedAt: new Date(Number(m.ts) * 1000 || Date.now()).toISOString(),
  }));
}

/**
 * Shares into the queue: the video once (its lines, credit and priority from its strongest share), every share
 * linked. A video already read keeps its takeaways; a new share in a client channel still files it to that client.
 */
export async function recordShares(admin: Admin, shares: Share[]) {
  if (!shares.length) return { videos: 0, shares: 0 };
  const { queueVideos } = await import("@/lib/youtube");
  const byVideo = new Map<string, Share[]>();
  for (const s of shares) byVideo.set(s.videoId, [...(byVideo.get(s.videoId) ?? []), s]);
  let linked = 0;
  for (const [videoId, list] of byVideo) {
    await queueVideos(admin, [{ videoId }], {});
    const { data: v } = await admin.from("youtube_videos").select("id, status, priority, lines, shared_note, source_id").eq("video_id", videoId).single();
    if (!v) continue;
    const scored = list.map((s) => {
      const p = s.person;
      const who = { role: p?.role ?? null, isExec: Boolean(p?.is_exec), execFocus: p?.exec_focus ?? [] };
      return { s, priority: shareSignal({ comment: s.comment, ...who }), lines: linesOfShare({ channelName: s.channelName, ...who }), note: shareNote({ who: sharerWords(who), channelName: s.channelName, dm: s.source === "slack_dm", comment: s.comment }) };
    });
    const { error } = await admin.from("youtube_shares").upsert(
      scored.map(({ s, priority }) => ({
        video_row: v.id,
        source: s.source,
        channel_id: s.channelId,
        channel_name: s.channelName,
        client_id: s.clientId,
        message_ts: s.messageTs,
        permalink: s.permalink,
        shared_by: s.person?.id ?? null,
        shared_by_name: s.authorName,
        comment: s.comment,
        priority,
        shared_at: s.sharedAt,
      })),
      { onConflict: "video_row,channel_id,message_ts", ignoreDuplicates: true },
    );
    if (error) throw new Error(error.message);
    linked += list.length;
    const best = scored.sort((a, b) => b.priority - a.priority)[0];
    const lines = [...new Set([...((v.lines as string[] | null) ?? []), ...scored.flatMap((x) => x.lines)])];
    const priority = Math.max(Number(v.priority) || 0, best.priority);
    await admin
      .from("youtube_videos")
      .update({
        lines,
        priority,
        // The strongest share is the credit; a channel's own video keeps its source and gains the credit too
        shared_note: !v.shared_note || best.priority > (Number(v.priority) || 0) ? best.note : v.shared_note,
        // Shared with the team: no longer just one person's on-demand summary
        on_demand: false,
        ...(v.status === "queued" ? { next_at: new Date().toISOString() } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", v.id);
  }
  return { videos: byVideo.size, shares: linked };
}

// ─── Reading Slack ──────────────────────────────────────────────────────────

/** Public team channels the bot joins so their shared videos are read: the ones named for a line */
export const joinableTeamChannel = (name: string) => Boolean(lineOfChannel(name));

/**
 * Team channels the bot is in (and public line channels it joins), not linked to a client: messages since the last
 * read with a YouTube link, threads included. A handful of channels a run, oldest-read first.
 */
export async function scanTeamChannels(admin: Admin, { budgetMs = 60_000 }: { budgetMs?: number } = {}) {
  const { slack, slackConfigured, listChannels, permalink } = await import("@/lib/context/slack");
  if (!slackConfigured()) return { skipped: "Slack isn't connected" };
  const until = Date.now() + budgetMs;
  const [channels, { data: clients }, people] = await Promise.all([listChannels(), admin.from("clients").select("slack_channel_id, internal_slack_channel_id"), team(admin)]);
  const clientChannels = new Set((clients ?? []).flatMap((c) => [c.slack_channel_id as string | null, c.internal_slack_channel_id as string | null]).filter(Boolean) as string[]);
  const teamChannels = channels.filter((c) => !c.is_archived && !clientChannels.has(c.id) && !c.is_ext_shared && (c.is_member || (!c.is_private && joinableTeamChannel(c.name))));
  let read = 0;
  let found = 0;
  const errors: string[] = [];
  for (const ch of teamChannels) {
    if (Date.now() > until) break;
    const key = `slack-yt:${ch.id}`;
    const started = new Date();
    try {
      if (!ch.is_member) await slack("conversations.join", { channel: ch.id });
      const since = await getCursor(admin, key, FIRST_LOOK_DAYS);
      const oldest = (since.getTime() / 1000).toFixed(6);
      const { messages } = await slack<{ messages: { ts: string; user?: string; text?: string; thread_ts?: string; reply_count?: number; latest_reply?: string }[] }>("conversations.history", { channel: ch.id, oldest, limit: "200" });
      const shares: Share[] = [];
      for (const m of messages ?? []) {
        shares.push(...sharesIn(m, { channelId: ch.id, channelName: ch.name, clientId: null, source: "slack", permalink: permalink(ch.id, m.ts, m.thread_ts) }, people));
        if (m.reply_count && m.latest_reply && Number(m.latest_reply) > Number(oldest)) {
          const { messages: replies } = await slack<{ messages: { ts: string; user?: string; text?: string; thread_ts?: string }[] }>("conversations.replies", { channel: ch.id, ts: m.ts, oldest, limit: "200" });
          for (const r of replies ?? []) if (r.ts !== m.ts) shares.push(...sharesIn(r, { channelId: ch.id, channelName: ch.name, clientId: null, source: "slack", permalink: permalink(ch.id, r.ts, r.thread_ts ?? m.ts) }, people));
        }
      }
      found += (await recordShares(admin, shares)).shares;
      await setCursor(admin, key, new Date(started.getTime() - 5 * 60_000), { ok: true, shares: shares.length });
      read++;
    } catch (e) {
      errors.push(`#${ch.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { channels: teamChannels.length, read, shares: found, errors: errors.slice(0, 5) };
}

/** Client channel messages the context sync just read (its saved items): their YouTube shares, about that client */
export async function queueSlackYouTube(admin: Admin, items: { body: string | null; url?: string | null; occurred_at?: string; author?: string | null; external_id?: string | null }[], where: { clientId: string; channelId: string; channelName?: string | null }) {
  const withYt = items.filter((m) => m.body && /youtu\.?be/i.test(m.body));
  if (!withYt.length) return { shares: 0 };
  const people = await team(admin);
  const shares = withYt.flatMap((m) => sharesIn({ text: m.body, ts: String(m.external_id ?? "").split(":")[1] || String(Date.parse(m.occurred_at ?? "") / 1000), authorName: m.author ?? null }, { channelId: where.channelId, channelName: where.channelName ?? null, clientId: where.clientId, source: "slack", permalink: m.url ?? null }, people));
  return recordShares(admin, shares);
}

/**
 * People who connected Slack reading: YouTube links they shared themselves in their DMs and group DMs since the last
 * look (Slack search, with their own token). Only their own messages, and the DM's words are never kept.
 */
export async function scanPersonalDms(admin: Admin, { max = 10 }: { max?: number } = {}) {
  const { data: tokens } = await admin.from("slack_user_tokens").select("profile_id, token, scopes, slack_user_id").limit(200);
  const readers = (tokens ?? []).filter((t) => String(t.scopes ?? "").includes("search:read") && t.slack_user_id).slice(0, max);
  if (!readers.length) return { people: 0, shares: 0 };
  const { slackRead } = await import("@/lib/slack-user");
  const people = await team(admin);
  let found = 0;
  for (const t of readers) {
    const key = `slack-yt-dm:${t.profile_id}`;
    const started = new Date();
    const since = await getCursor(admin, key, FIRST_LOOK_DAYS);
    const after = new Date(since.getTime() - DAY).toISOString().slice(0, 10);
    type Match = { ts: string; text?: string; user?: string; permalink?: string; channel?: { id: string; is_im?: boolean; is_mpim?: boolean } };
    const r = await slackRead<{ ok: boolean; error?: string; messages?: { matches?: Match[] } }>(t.token as string, "search.messages", { query: `youtu from:<@${t.slack_user_id}> after:${after}`, sort: "timestamp", count: "50" }).catch(() => null);
    if (!r?.ok) continue;
    const mine = (r.messages?.matches ?? []).filter((m) => (m.channel?.is_im || m.channel?.is_mpim) && Number(m.ts) * 1000 >= since.getTime() && m.user === t.slack_user_id);
    const shares = mine.flatMap((m) => sharesIn({ text: m.text, ts: m.ts, user: m.user }, { channelId: m.channel!.id, channelName: null, clientId: null, source: "slack_dm", permalink: null }, people));
    found += (await recordShares(admin, shares)).shares;
    await setCursor(admin, key, new Date(started.getTime() - 5 * 60_000), { ok: true, shares: shares.length });
  }
  return { people: readers.length, shares: found };
}

// ─── A client's knowledge ───────────────────────────────────────────────────

const RELEVANT = { type: "object", additionalProperties: false, required: ["relevant", "why"], properties: { relevant: { type: "boolean" }, why: { type: "string" } } };

/**
 * Videos shared in a client's channel and now read: filed to that client's knowledge when they're about the client's
 * kind of business, offer or situation (a general marketing video stays team knowledge only). A few a run.
 */
export async function attachSharedToClients(admin: Admin, max = 6) {
  const { data } = await admin.from("youtube_shares").select("id, client_id, channel_name, video_row, youtube_videos!inner(video_id, title, channel_title, summary, status)").not("client_id", "is", null).is("attached_at", null).in("youtube_videos.status", ["done", "skipped", "failed", "no_transcript"]).limit(max);
  let filed = 0;
  for (const s of (data ?? []) as unknown as { id: string; client_id: string; channel_name: string | null; video_row: string; youtube_videos: { video_id: string; title: string | null; channel_title: string | null; summary: string | null; status: string } }[]) {
    const v = s.youtube_videos;
    const now = new Date().toISOString();
    if (v.status !== "done" || !v.summary) {
      await admin.from("youtube_shares").update({ attached_at: now }).eq("id", s.id);
      continue;
    }
    const [{ data: c }, { data: tk }] = await Promise.all([admin.from("clients").select("name, industry, industry_detail").eq("id", s.client_id).maybeSingle(), admin.from("youtube_takeaways").select("takeaway, at_seconds").eq("video_row", s.video_row).neq("status", "dismissed").limit(8)]);
    const r = await askJson<{ relevant: boolean; why: string }>({
      agent: "market",
      label: "youtube client fit",
      clientId: s.client_id,
      bare: true,
      schema: RELEVANT,
      override: { model: "haiku", effort: "low" },
      maxTokens: 400,
      system: "A marketing video was shared in a client's Slack channel. Say whether it's specifically relevant to this client (their kind of business, product, offer, market or a situation they're in), not just general marketing advice. Be strict.",
      prompt: `<client>${c?.industry_detail ?? c?.industry ?? "unknown"}</client>\n<video title="${(v.title ?? "").replace(/"/g, "'")}" channel="${(v.channel_title ?? "").replace(/"/g, "'")}">${v.summary}</video>`,
    }).catch(() => ({ relevant: false, why: "" }));
    if (r.relevant) {
      const { addKnowledgeText } = await import("@/lib/knowledge");
      const url = videoUrl(v.video_id);
      await addKnowledgeText(admin, { scope: "client", clientId: s.client_id }, null, {
        name: `YouTube: ${(v.title ?? v.video_id).slice(0, 160)}`,
        title: v.title ?? "A YouTube video shared in the channel",
        summary: v.summary,
        keyPoints: (tk ?? []).map((t) => String(t.takeaway).slice(0, 200)).slice(0, 8),
        url,
        method: "youtube",
        text: `${v.title ?? ""} (${v.channel_title ?? "YouTube"}), shared in ${s.channel_name ? `#${s.channel_name}` : "the client's channel"}. ${url}\nWhy it's relevant to this client: ${r.why}\n\nSummary: ${v.summary}\n\nTakeaways:\n${(tk ?? []).map((t) => `- ${t.takeaway}${t.at_seconds ? ` (${videoUrl(v.video_id, t.at_seconds as number)})` : ""}`).join("\n")}`,
      }).catch((e) => console.error("[youtube] client knowledge", e instanceof Error ? e.message : e));
      filed++;
    }
    await admin.from("youtube_shares").update({ attached_at: now }).eq("id", s.id);
  }
  return { filed };
}
