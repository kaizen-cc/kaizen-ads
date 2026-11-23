import "server-only";
import type { Staff } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { canDecide, canManageSources, cleanLines } from "@/lib/youtube-core";
import { str, type AiTool } from "./types";

// YouTube learning, for the assistant and every agent (registered in src/lib/kaizen-ai/extensions.ts):
//   youtube_subscribe          an exec or line head: subscribe to a channel (or add one video) with the lines it teaches
//   youtube_summarize          anyone: a pasted video link summarized now, with its takeaways (nothing shared or learned)
//   youtube_ask                anyone: what the channels we study said about a topic, cited to the video and moment
//   youtube_takeaways          what's new: the takeaways waiting for this person's call, or shared with them
//   youtube_decide             a line head or exec: accept a takeaway into the agents' learning, or dismiss it
// Each opens on Settings › AI agents › YouTube: open_screen place 'youtube learning' (or its views).

const subscribe: AiTool = {
  name: "youtube_subscribe",
  description:
    "An exec or line head: have the agents keep studying a YouTube channel (link, @handle) or one video (link). lines: what it teaches, any of meta (Meta and TikTok ads), google, creative, email, social, or all; leave empty and the AI suggests them from the channel's videos. New videos become takeaways shared with the team on those lines. Say what you'll add and ask first. To show it, open_screen place 'youtube channels'.",
  input_schema: { type: "object", properties: { link: { type: "string" }, lines: { type: "array", items: { type: "string" } } }, required: ["link"], additionalProperties: false },
  run: async (user: Staff, input) => {
    if (!canManageSources(user)) return { ok: false, error: "Only an executive or a line head sets up what the agents study." };
    const { addSource } = await import("@/lib/youtube");
    const r = await addSource(createAdminClient(), str(input.link) ?? "", { lines: Array.isArray(input.lines) ? (input.lines as string[]) : [], by: user.id });
    return r.ok ? { ...r, page: "/settings?tab=agents&section=youtube&yt=sources" } : r;
  },
};

const summarize: AiTool = {
  name: "youtube_summarize",
  description:
    "Anyone: summarize a YouTube video from its link, now: what it argues and its concrete takeaways with the moment each is said. Takes a minute. Nothing is shared with the team or learned by the agents. Use it whenever someone pastes a YouTube link and asks what it says.",
  input_schema: { type: "object", properties: { link: { type: "string" } }, required: ["link"], additionalProperties: false },
  run: async (user: Staff, input) => (await import("@/lib/youtube")).summarizeVideo(createAdminClient(), str(input.link) ?? "", user.id),
};

const ask: AiTool = {
  name: "youtube_ask",
  description:
    "Anyone: what the YouTube channels Kaizen's agents study said about a topic (e.g. what a channel says about the 3:2:2 testing method, or creative fatigue), answered from their transcripts with the video and the moment. channel: a channel's name to narrow it; leave empty to search every channel.",
  input_schema: { type: "object", properties: { question: { type: "string" }, channel: { type: "string" } }, required: ["question"], additionalProperties: false },
  run: async (_user: Staff, input) => (await import("@/lib/youtube")).askChannels(createAdminClient(), str(input.question) ?? "", str(input.channel)),
};

const list: AiTool = {
  name: "youtube_takeaways",
  description:
    "Takeaways from the YouTube channels the agents study. which: 'decide' (a line head or exec: the ones waiting for their call on the lines they oversee, each with its id for youtube_decide; seeAll: true adds the rest they may decide), 'mine' (shared with this person's lines), 'all'. To show them, open_screen place 'youtube takeaways to decide' or 'youtube takeaways for me'.",
  input_schema: { type: "object", properties: { which: { type: "string", enum: ["decide", "mine", "all"] }, seeAll: { type: "boolean" } }, additionalProperties: false },
  run: async (user: Staff, input) => {
    const { loadYouTube } = await import("@/lib/youtube");
    const seeAll = input.seeAll === true;
    const which = str(input.which) ?? (canManageSources(user) ? "decide" : "mine");
    const data = await loadYouTube(await createClient(), user);
    const rows = data.videos.flatMap((v) =>
      v.takeaways
        .filter((t) => (which === "decide" ? t.canDecide && t.status === "pending" && (seeAll || t.scoped) : which === "mine" ? t.mine && t.status !== "dismissed" : true))
        .map((t) => ({ id: t.id, video: v.title, channel: v.channel, takeaway: t.takeaway, why: t.why, lines: t.lines, link: t.link, status: t.status })),
    );
    return { ok: true, which, waitingForYou: data.waiting, takeaways: rows.slice(0, 40), page: `/settings?tab=agents&section=youtube&yt=${which}${seeAll ? "&ytall=1" : ""}` };
  },
};

const decide: AiTool = {
  name: "youtube_decide",
  description:
    "A line head or exec: decide on a YouTube takeaway (id from youtube_takeaways). how 'accept' files it into the agents' learning (the agents of its lines use it from then on, citing the video); reworded: optional better wording. how 'dismiss' sets it aside. To work it into a playbook instead, open_screen place 'youtube takeaways to decide' and use Call in. Say what you'll do and ask first.",
  input_schema: { type: "object", properties: { id: { type: "string" }, how: { type: "string", enum: ["accept", "dismiss"] }, reworded: { type: "string" } }, required: ["id", "how"], additionalProperties: false },
  run: async (user: Staff, input) => {
    const admin = createAdminClient();
    const id = str(input.id) ?? "";
    const { data } = await admin.from("youtube_takeaways").select("lines").eq("id", id).maybeSingle();
    if (!data) return { ok: false, error: "No takeaway with that id." };
    if (!canDecide(user, cleanLines(data.lines as string[]))) return { ok: false, error: "Only an executive or the head of this takeaway's line decides on it." };
    const yt = await import("@/lib/youtube");
    return str(input.how) === "dismiss" ? yt.dismissTakeaway(admin, user, id) : yt.acceptTakeaway(admin, user, id, str(input.reworded));
  },
};

export const tools: AiTool[] = [subscribe, summarize, ask, list, decide];
