import { describe, expect, it } from "vitest";
import { cleanComment, lineOfChannel, linesOfShare, shareNote, shareSignal, sharerWords, videoIdsIn } from "@/lib/youtube-core";
import { joinableTeamChannel, sharesIn } from "@/lib/youtube-slack";

// The share that started it: the paid-ads exec in #facebook
const POST = "GREAT OVERALL ADVERTISING VIDEO <!channel> <https://www.youtube.com/watch?v=FOZrtnJpuS8&amp;t=12s|youtube.com/watch?v=FOZrtnJpuS8>";
const EXEC = { id: "p-exec", role: "executive", is_exec: true, exec_focus: ["meta", "google", "tiktok", "creative_performance"], full_name: "Exec One", slack_user_id: "U0EXEC" };
const BUYER = { id: "p-buyer", role: "media_buyer", is_exec: false, exec_focus: [], full_name: "Buyer Two", slack_user_id: "U0BUY" };

describe("youtube links in Slack messages", () => {
  it("reads Slack's <url|label> form, &amp; and youtu.be and shorts links, once each", () => {
    expect(videoIdsIn(POST)).toEqual(["FOZrtnJpuS8"]);
    expect(videoIdsIn("<https://youtu.be/FOZrtnJpuS8?si=x> and <https://youtube.com/shorts/abcdefghijk|short> again https://youtu.be/FOZrtnJpuS8")).toEqual(["FOZrtnJpuS8", "abcdefghijk"]);
    expect(videoIdsIn("no video here <https://vimeo.com/1>")).toEqual([]);
  });
  it("keeps the sharer's own words, not the markup", () => {
    expect(cleanComment(POST)).toBe("GREAT OVERALL ADVERTISING VIDEO");
    expect(cleanComment("<@U123> look at this <#C1|facebook> https://youtu.be/x")).toBe("look at this #facebook");
  });
});

describe("what a share says about the video", () => {
  it("lines from the channel, else the sharer's role, else an exec's focus", () => {
    expect(lineOfChannel("facebook")).toBe("meta");
    expect(lineOfChannel("google-ads")).toBe("google");
    expect(lineOfChannel("email-team")).toBe("email");
    expect(lineOfChannel("creative-design")).toBe("creative");
    expect(lineOfChannel("tracking-help")).toBe("tracking");
    expect(lineOfChannel("general")).toBeNull();
    expect(linesOfShare({ channelName: "facebook", role: "executive", isExec: true })).toEqual(["meta"]);
    expect(linesOfShare({ channelName: "general", role: "google_buyer" })).toEqual(["google"]);
    expect(linesOfShare({ channelName: "general", role: "executive", isExec: true, execFocus: ["meta", "tiktok", "creative_performance"] })).toEqual(["meta", "creative"]);
    expect(linesOfShare({ channelName: null, role: "customer_success" })).toEqual([]);
  });
  it("an exec saying 'great' to the whole channel is top priority; a plain link is zero", () => {
    expect(shareSignal({ comment: POST, role: "executive", isExec: true })).toBe(4);
    expect(shareSignal({ comment: "worth a look", role: "head_of_meta" })).toBe(1);
    expect(shareSignal({ comment: "", role: "media_buyer" })).toBe(0);
    expect(shareSignal({ comment: "🔥 must watch", role: "media_buyer" })).toBe(1);
  });
  it("credits by role, never by name, and keeps a DM's words private", () => {
    expect(sharerWords({ role: "executive", isExec: true, execFocus: ["meta"] })).toBe("the paid-ads exec");
    expect(sharerWords({ role: "head_of_social" })).toBe("the Head of Organic Social");
    expect(sharerWords({ role: "head_of_meta" })).toBe("the Head of Meta");
    expect(sharerWords({ role: "email_strategist" })).toBe("an email strategist");
    expect(sharerWords({})).toBe("a teammate");
    expect(shareNote({ who: "the paid-ads exec", channelName: "facebook", comment: POST })).toBe('Shared by the paid-ads exec in #facebook: "GREAT OVERALL ADVERTISING VIDEO"');
    expect(shareNote({ who: "a media buyer", dm: true, comment: "secret client stuff https://youtu.be/x" })).toBe("Shared by a media buyer in a direct message");
  });
});

describe("shares from a Slack message", () => {
  it("one share per video, credited to the teammate by Slack user, comment kept for channels and dropped for DMs", () => {
    const where = { channelId: "C0FB", channelName: "facebook", clientId: null, source: "slack" as const, permalink: "https://slack.com/archives/C0FB/p1" };
    const s = sharesIn({ text: POST, ts: "1763700000.000100", user: "U0EXEC" }, where, [EXEC, BUYER]);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ videoId: "FOZrtnJpuS8", channelName: "facebook", comment: "GREAT OVERALL ADVERTISING VIDEO", messageTs: "1763700000.000100" });
    expect(s[0].person?.id).toBe("p-exec");
    const dm = sharesIn({ text: "watch https://youtu.be/FOZrtnJpuS8", ts: "1763700001.0", user: "U0BUY" }, { ...where, channelName: null, source: "slack_dm" }, [EXEC, BUYER]);
    expect(dm[0].comment).toBeNull();
    expect(dm[0].person?.id).toBe("p-buyer");
    expect(sharesIn({ text: "no links", ts: "1", user: "U0BUY" }, where, [BUYER])).toEqual([]);
  });
  it("matches a client channel's author by name when there's no Slack user id", () => {
    const s = sharesIn({ text: "https://youtu.be/FOZrtnJpuS8", ts: "2", authorName: "buyer two" }, { channelId: "C0CL", channelName: null, clientId: "client-1", source: "slack" }, [EXEC, BUYER]);
    expect(s[0]).toMatchObject({ clientId: "client-1" });
    expect(s[0].person?.id).toBe("p-buyer");
  });
  it("joins only public channels named for a line", () => {
    expect(joinableTeamChannel("facebook")).toBe(true);
    expect(joinableTeamChannel("random")).toBe(false);
  });
});
