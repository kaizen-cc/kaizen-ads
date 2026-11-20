"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { canManageSources, cleanLines } from "@/lib/youtube-core";

// Settings › AI agents › YouTube: execs and line heads add channels and videos and tag their lines; a line head or an
// exec decides on each takeaway (accept into learning, call in an agent, dismiss); anyone can have a video summarized
// or paste a transcript YouTube wouldn't give.

type Result = { ok: true; message?: string } | { ok: false; error: string };
const PAGE = "/settings";
const NOT_YOURS = { ok: false as const, error: "Only an executive or a line head sets up what the agents study." };

export async function addYouTubeSource(input: string, lines: string[]): Promise<Result> {
  const me = await requireStaff();
  if (!canManageSources(me)) return NOT_YOURS;
  const { addSource } = await import("@/lib/youtube");
  const r = await addSource(createAdminClient(), input, { lines, by: me.id });
  revalidatePath(PAGE);
  if (!r.ok) return r;
  return { ok: true, message: r.kind === "channel" ? `Subscribed to ${r.title ?? "the channel"}${r.queued ? `: its latest ${r.queued} video${r.queued === 1 ? "" : "s"} are being read` : ""}.` : "Added: the video is being read." };
}

export async function setYouTubeLines(id: string, lines: string[]): Promise<Result> {
  const me = await requireStaff();
  if (!canManageSources(me)) return NOT_YOURS;
  const { error } = await createAdminClient().from("youtube_sources").update({ lines: cleanLines(lines), updated_at: new Date().toISOString() }).eq("id", id);
  revalidatePath(PAGE);
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function setYouTubeActive(id: string, active: boolean): Promise<Result> {
  const me = await requireStaff();
  if (!canManageSources(me)) return NOT_YOURS;
  const { error } = await createAdminClient().from("youtube_sources").update({ active, updated_at: new Date().toISOString() }).eq("id", id);
  revalidatePath(PAGE);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** A source unsubscribed: its videos and takeaways stay (what's accepted is the agents' now) */
export async function removeYouTubeSource(id: string): Promise<Result> {
  const me = await requireStaff();
  if (!canManageSources(me)) return NOT_YOURS;
  const { error } = await createAdminClient().from("youtube_sources").delete().eq("id", id);
  revalidatePath(PAGE);
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function checkYouTubeNow(id: string): Promise<Result> {
  const me = await requireStaff();
  if (!canManageSources(me)) return NOT_YOURS;
  const yt = await import("@/lib/youtube");
  const admin = createAdminClient();
  const r = await yt.checkSource(admin, id);
  revalidatePath(PAGE);
  return r.error ? { ok: false, error: r.error } : { ok: true, message: r.queued ? `${r.queued} new video${r.queued === 1 ? "" : "s"} queued.` : "Nothing new since the last check." };
}

export async function suggestYouTubeLines(id: string): Promise<Result> {
  const me = await requireStaff();
  if (!canManageSources(me)) return NOT_YOURS;
  const lines = await (await import("@/lib/youtube")).suggestLines(createAdminClient(), id).catch(() => null);
  revalidatePath(PAGE);
  return lines ? { ok: true, message: lines.length ? "Lines suggested from its videos." : "The AI couldn't tell which lines it teaches." } : { ok: false, error: "Couldn't suggest lines right now." };
}

export async function acceptYouTubeTakeaway(id: string, edited?: string | null): Promise<Result> {
  const me = await requireStaff();
  const r = await (await import("@/lib/youtube")).acceptTakeaway(createAdminClient(), me, id, edited ?? null);
  revalidatePath(PAGE);
  return r.ok ? { ok: true, message: r.message ?? `Accepted: ${r.learnings} agent${r.learnings === 1 ? "" : "s"} will use it from now on.` } : r;
}

export async function dismissYouTubeTakeaway(id: string): Promise<Result> {
  const me = await requireStaff();
  const r = await (await import("@/lib/youtube")).dismissTakeaway(createAdminClient(), me, id);
  revalidatePath(PAGE);
  return r.ok ? { ok: true } : r;
}

/**
 * Call in the agent best placed to work a takeaway into its knowledge base or playbook: the takeaway is sent to it in
 * its Talk thread, where it proposes the exact edits for the decider to apply. Returns where to open it.
 */
export async function callInYouTubeAgent(id: string, roleKey?: string | null): Promise<{ ok: true; href: string } | { ok: false; error: string }> {
  const me = await requireStaff();
  const b = await (await import("@/lib/youtube")).callInBrief(createAdminClient(), me, id, roleKey ?? null);
  if (!b.ok) return b;
  const { chatWithAgent } = await import("./actions");
  const r = await chatWithAgent(b.roleKey, b.message);
  revalidatePath(PAGE);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, href: `/settings?tab=agents&role=${b.roleKey}#talk` };
}

export async function pasteYouTubeTranscript(videoRow: string, text: string): Promise<Result> {
  await requireStaff();
  const r = await (await import("@/lib/youtube")).pasteTranscript(createAdminClient(), videoRow, text);
  revalidatePath(PAGE);
  return r.ok ? { ok: true, message: "Thanks: it's read in the next few minutes." } : r;
}

export type Summary = { title: string | null; channel: string | null; summary: string | null; url: string; takeaways: { takeaway: string; why: string | null; link: string }[] };

/** "Summarize this video", for anyone: read and distilled now */
export async function summarizeYouTube(link: string): Promise<{ ok: true; summary: Summary } | { ok: false; error: string }> {
  const me = await requireStaff();
  const r = await (await import("@/lib/youtube")).summarizeVideo(createAdminClient(), link, me.id);
  revalidatePath(PAGE);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, summary: { title: r.title, channel: r.channel, summary: r.summary, url: r.url, takeaways: r.takeaways.map((t) => ({ takeaway: t.takeaway, why: t.why, link: t.link })) } };
}
