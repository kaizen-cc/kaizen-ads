import { describe, expect, it } from "vitest";
import {
  agentsForTakeaway,
  canDecide,
  canManageSources,
  channelIdFromPage,
  cleanLines,
  cleanTakeaways,
  learningText,
  noticeText,
  parseCaptions,
  parseFeed,
  parseYouTube,
  pickTrack,
  routeTakeaway,
  secondsOf,
  transcriptOf,
  videoIdsIn,
  videoUrl,
  type Person,
} from "@/lib/youtube-core";
import { learningKeys } from "@/lib/learnings";

describe("youtube links", () => {
  it("reads every shape of video link", () => {
    expect(parseYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s")).toEqual({ kind: "video", id: "dQw4w9WgXcQ" });
    expect(parseYouTube("youtu.be/dQw4w9WgXcQ?si=abc")).toEqual({ kind: "video", id: "dQw4w9WgXcQ" });
    expect(parseYouTube("https://youtube.com/shorts/dQw4w9WgXcQ")).toEqual({ kind: "video", id: "dQw4w9WgXcQ" });
    expect(parseYouTube("https://m.youtube.com/live/dQw4w9WgXcQ")).toEqual({ kind: "video", id: "dQw4w9WgXcQ" });
  });
  it("reads channels by handle, id, custom url and a bare @handle", () => {
    expect(parseYouTube("@AhrefsCom")).toEqual({ kind: "handle", handle: "AhrefsCom" });
    expect(parseYouTube("https://www.youtube.com/@AhrefsCom/videos")).toEqual({ kind: "handle", handle: "AhrefsCom" });
    expect(parseYouTube("https://www.youtube.com/channel/UCWquNQV8Y0_defMKnGKrFOQ")).toEqual({ kind: "channel", channelId: "UCWquNQV8Y0_defMKnGKrFOQ" });
    expect(parseYouTube("UCWquNQV8Y0_defMKnGKrFOQ")).toEqual({ kind: "channel", channelId: "UCWquNQV8Y0_defMKnGKrFOQ" });
    expect(parseYouTube("youtube.com/c/SomeName")).toEqual({ kind: "custom", path: "c/SomeName" });
  });
  it("refuses what isn't YouTube", () => {
    expect(parseYouTube("https://vimeo.com/123")).toBeNull();
    expect(parseYouTube("https://www.youtube.com/")).toBeNull();
    expect(parseYouTube("")).toBeNull();
  });
  it("finds video links in text, once each, and links to a moment", () => {
    expect(videoIdsIn("see https://youtu.be/dQw4w9WgXcQ and https://www.youtube.com/watch?v=dQw4w9WgXcQ, also youtube.com/watch?v=abcdefghijk")).toEqual(["dQw4w9WgXcQ", "abcdefghijk"]);
    expect(videoUrl("dQw4w9WgXcQ", 83)).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=83s");
    expect(videoUrl("dQw4w9WgXcQ", null)).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });
});

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <id>yt:channel:WquNQV8Y0_defMKnGKrFOQ</id>
 <yt:channelId>WquNQV8Y0_defMKnGKrFOQ</yt:channelId>
 <title>Ahrefs</title>
 <entry>
  <id>yt:video:AAAAAAAAAAA</id>
  <yt:videoId>AAAAAAAAAAA</yt:videoId>
  <yt:channelId>UCWquNQV8Y0_defMKnGKrFOQ</yt:channelId>
  <title>Older &amp; wiser</title>
  <author><name>Ahrefs</name></author>
  <published>2026-11-01T10:00:00+00:00</published>
  <media:group><media:title>Older &amp; wiser</media:title><media:thumbnail url="https://i4.ytimg.com/vi/AAAAAAAAAAA/hqdefault.jpg" width="480" height="360"/><media:description>The 3:2:2 method, explained</media:description></media:group>
 </entry>
 <entry>
  <id>yt:video:BBBBBBBBBBB</id>
  <yt:videoId>BBBBBBBBBBB</yt:videoId>
  <title>Newest</title>
  <author><name>Ahrefs</name></author>
  <published>2026-11-18T10:01:36+00:00</published>
 </entry>
</feed>`;

describe("youtube feed", () => {
  it("reads the channel and its videos, newest first, entities decoded", () => {
    const f = parseFeed(FEED);
    expect(f.channelTitle).toBe("Ahrefs");
    expect(f.channelId).toBe("UCWquNQV8Y0_defMKnGKrFOQ");
    expect(f.videos.map((v) => v.videoId)).toEqual(["BBBBBBBBBBB", "AAAAAAAAAAA"]);
    const old = f.videos[1];
    expect(old.title).toBe("Older & wiser");
    expect(old.description).toBe("The 3:2:2 method, explained");
    expect(old.thumbnail).toContain("AAAAAAAAAAA");
    expect(old.channelTitle).toBe("Ahrefs");
    expect(f.videos[0].channelId).toBe("UCWquNQV8Y0_defMKnGKrFOQ");
  });
  it("is empty for a page that isn't a feed", () => {
    expect(parseFeed("<html>404</html>").videos).toEqual([]);
  });
  it("finds the channel id in a channel page", () => {
    expect(channelIdFromPage('<link rel="canonical" href="https://www.youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA">')).toBe("UCX6OQ3DkcsbYNE6H8uQQuVA");
    expect(channelIdFromPage('{"externalId":"UCX6OQ3DkcsbYNE6H8uQQuVA"}')).toBe("UCX6OQ3DkcsbYNE6H8uQQuVA");
    expect(channelIdFromPage("<html></html>")).toBeNull();
  });
});

describe("youtube captions", () => {
  it("reads the classic XML, the format 3 XML and json3", () => {
    expect(parseCaptions('<transcript><text start="0.5" dur="2">Hook in the first &amp;#39;3&amp;#39; seconds</text><text start="3.1" dur="1">then &lt;b&gt;proof&lt;/b&gt;</text></transcript>')).toEqual([
      { at: 0.5, text: "Hook in the first '3' seconds" },
      { at: 3.1, text: "then proof" },
    ]);
    expect(parseCaptions('<timedtext format="3"><body><p t="1200" d="900"><s>three</s><s> creatives</s></p></body></timedtext>')).toEqual([{ at: 1.2, text: "three creatives" }]);
    expect(parseCaptions(JSON.stringify({ events: [{ tStartMs: 61000, segs: [{ utf8: "two " }, { utf8: "headlines" }] }, { tStartMs: 62000 }] }))).toEqual([{ at: 61, text: "two headlines" }]);
    expect(parseCaptions("")).toEqual([]);
    expect(parseCaptions("{not json")).toEqual([]);
  });
  it("marks the transcript about every 30 seconds", () => {
    const t = transcriptOf([
      { at: 0, text: "a" },
      { at: 10, text: "b" },
      { at: 31, text: "c" },
      { at: 3725, text: "d" },
    ]);
    expect(t).toBe("[0:00] a b\n[0:31] c\n[1:02:05] d");
  });
  it("prefers English captions a person wrote", () => {
    expect(pickTrack([{ languageCode: "es" }, { languageCode: "en", kind: "asr" }, { languageCode: "en-US" }])).toEqual({ languageCode: "en-US" });
    expect(pickTrack([{ languageCode: "es" }, { languageCode: "en", kind: "asr" }])).toEqual({ languageCode: "en", kind: "asr" });
    expect(pickTrack([])).toBeNull();
  });
  it("reads time marks as seconds", () => {
    expect(secondsOf("12:34")).toBe(754);
    expect(secondsOf("[1:02:03]")).toBe(3723);
    expect(secondsOf(90)).toBe(90);
    expect(secondsOf("")).toBeNull();
    expect(secondsOf("soon")).toBeNull();
  });
});

describe("youtube takeaways", () => {
  it("cleans the AI's takeaways: lines and roles we know, a fallback line, dedupe, time marks", () => {
    const out = cleanTakeaways(
      [
        { takeaway: "Per the channel: test 3 creatives × 2 headlines × 2 primary texts in one ad set — the 3:2:2 method.", why: "Finds a winner faster", lines: ["meta", "tiktok", "nonsense"], roles: ["media_buyer", "ceo"], at: "4:05" },
        { takeaway: "per the channel: Test 3 creatives × 2 headlines × 2 primary texts in one ad set, the 3:2:2 method", why: "dup", lines: [], roles: [], at: "" },
        { takeaway: "Short", lines: ["meta"] },
        { takeaway: "Cut the first second of dead air from every edit before export.", why: "", lines: [], roles: ["video_editor"], at: "99:00" },
      ],
      { fallbackLines: ["creative"], durationSeconds: 1200 },
    );
    expect(out).toHaveLength(2);
    expect(out[0].takeaway).toContain("one ad set, the 3:2:2 method");
    expect(out[0].lines).toEqual(["meta"]);
    expect(out[0].roles).toEqual(["media_buyer"]);
    expect(out[0].atSeconds).toBe(245);
    expect(out[1].lines).toEqual(["creative"]);
    expect(out[1].roles).toEqual(["video_editor"]);
    // Past the video's end: no time mark
    expect(out[1].atSeconds).toBeNull();
  });
  it("caps the number and survives junk", () => {
    expect(cleanTakeaways(null, { fallbackLines: ["meta"] })).toEqual([]);
    const many = Array.from({ length: 12 }, (_, i) => ({ takeaway: `A concrete method number ${i} worth keeping`, lines: ["google"] }));
    expect(cleanTakeaways(many, { fallbackLines: [], max: 5 })).toHaveLength(5);
  });
  it("expands 'all' and aliases into the lines", () => {
    expect(cleanLines(["all"])).toEqual(["meta", "google", "creative", "email", "social", "tracking", "strategy"]);
    expect(cleanLines(["video", "tiktok", "email", "email"])).toEqual(["meta", "creative", "email"]);
  });
  it("writes the learning with its source", () => {
    const t = learningText({ takeaway: "Launch 3:2:2 tests in one ad set.", why: "Faster read" }, { title: "The 3:2:2 method", channel: "A channel", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=245s" });
    expect(t).toBe('Launch 3:2:2 tests in one ad set. Why: Faster read Source: A channel, "The 3:2:2 method" (https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=245s).');
  });
});

const TEAM: Person[] = [
  { id: "hc", role: "head_of_creative", isExec: false },
  { id: "lgd", role: "lead_graphic_designer", isExec: false },
  { id: "lve", role: "lead_video_editor", isExec: false },
  { id: "gd", role: "graphic_designer", isExec: false },
  { id: "ve", role: "video_editor", isExec: false },
  { id: "cw", role: "copywriter", isExec: false },
  { id: "hm", role: "head_of_meta", isExec: false },
  { id: "mb", role: "media_buyer", isExec: false },
  { id: "hg", role: "head_of_google", isExec: false },
  { id: "gb", role: "google_buyer", isExec: false },
  { id: "he", role: "head_of_email", isExec: false },
  { id: "es", role: "email_strategist", isExec: false },
  { id: "ed", role: "email_designer", isExec: false },
  { id: "eb", role: "email_builder", isExec: false },
  { id: "hs", role: "head_of_social", isExec: false },
  { id: "smm", role: "social_media_manager", isExec: false },
  { id: "cs", role: "customer_success", isExec: false },
  { id: "x-creative", role: "executive", isExec: true, execFocus: ["social", "creative"] },
  { id: "x-ads", role: "executive", isExec: true, execFocus: ["meta", "google", "tiktok", "creative_performance"] },
  { id: "x-email", role: "executive", isExec: true, execFocus: ["email"] },
  { id: "x-all", role: "executive", isExec: true, execFocus: [] },
  { id: "gone", role: "media_buyer", isExec: false, active: false },
];
const ids = (r: { team: string[]; execs: string[] }) => ({ team: [...r.team].sort(), execs: [...r.execs].sort() });

describe("youtube routing", () => {
  it("creative: the head and the leads always, the designers or editors only for their craft, execs by focus", () => {
    expect(ids(routeTakeaway({ lines: ["creative"], roles: [] }, TEAM))).toEqual({ team: ["hc", "lgd", "lve"], execs: ["x-ads", "x-all", "x-creative"] });
    expect(ids(routeTakeaway({ lines: ["creative"], roles: ["video_editor"] }, TEAM)).team).toEqual(["hc", "lgd", "lve", "ve"]);
    expect(ids(routeTakeaway({ lines: ["creative"], roles: ["graphic_designer", "copywriter"] }, TEAM)).team).toEqual(["cw", "gd", "hc", "lgd", "lve"]);
  });
  it("email: the head and the strategists; designers and builders only for design or build", () => {
    expect(ids(routeTakeaway({ lines: ["email"], roles: [] }, TEAM))).toEqual({ team: ["es", "he"], execs: ["x-all", "x-email"] });
    expect(ids(routeTakeaway({ lines: ["email"], roles: ["email_builder"] }, TEAM)).team).toEqual(["eb", "es", "he"]);
  });
  it("social, Meta and Google: the heads and their people", () => {
    expect(ids(routeTakeaway({ lines: ["social"], roles: [] }, TEAM))).toEqual({ team: ["hs", "smm"], execs: ["x-all", "x-creative"] });
    expect(ids(routeTakeaway({ lines: ["meta"], roles: [] }, TEAM))).toEqual({ team: ["hm", "mb"], execs: ["x-ads", "x-all"] });
    expect(ids(routeTakeaway({ lines: ["google"], roles: [] }, TEAM))).toEqual({ team: ["gb", "hg"], execs: ["x-ads", "x-all"] });
  });
  it("a craft role tagged on another line still reaches it; nobody outside the lines, nobody inactive", () => {
    const r = ids(routeTakeaway({ lines: ["meta"], roles: ["video_editor"] }, TEAM));
    expect(r.team).toEqual(["hm", "mb", "ve"]);
    expect(r.team).not.toContain("cs");
    expect(r.team).not.toContain("gone");
  });
  it("only execs and the line's head decide; only execs and heads manage sources", () => {
    expect(canDecide({ role: "head_of_creative" }, ["creative"])).toBe(true);
    expect(canDecide({ role: "head_of_creative" }, ["meta"])).toBe(false);
    expect(canDecide({ role: "lead_graphic_designer" }, ["creative"])).toBe(false);
    expect(canDecide({ role: "executive", isExec: true }, ["email"])).toBe(true);
    expect(canManageSources({ role: "head_of_social" })).toBe(true);
    expect(canManageSources({ role: "media_buyer" })).toBe(false);
  });
  it("files an accepted takeaway to the line's agents, and the craft agents when it's their craft", () => {
    expect(agentsForTakeaway({ lines: ["meta", "creative"], roles: ["copywriter"] })).toEqual(["media_buyer", "creative_director", "copywriter"]);
    expect(agentsForTakeaway({ lines: ["email"], roles: ["email_designer", "email_builder"] })).toEqual(["email_strategist", "email_creative", "email_builder"]);
    expect(agentsForTakeaway({ lines: [], roles: [] })).toEqual([]);
  });
  it("every skill reads its role agent's learnings", () => {
    expect(learningKeys(["auditor"])).toEqual(["auditor", "role:media_buyer"]);
    expect(learningKeys(["google_launcher", "google_auditor"])).toEqual(["google_launcher", "google_auditor", "role:google_buyer"]);
  });
});

describe("youtube notices", () => {
  it("one notice per person per day: counts, titles and what's theirs to decide", () => {
    const n = noticeText([
      { videoTitle: "The 3:2:2 method", channel: "A", decide: true },
      { videoTitle: "The 3:2:2 method", channel: "A", decide: false },
      { videoTitle: "Hooks that hold", channel: "B", decide: true },
    ]);
    expect(n.title).toBe("3 new takeaways from YouTube for your work");
    expect(n.body).toBe('From "The 3:2:2 method" (A), "Hooks that hold" (B). 2 wait for your call: accept into the agents\' learning, call in an agent, or dismiss.');
    expect(noticeText([{ videoTitle: "One", channel: null, decide: false }], { digest: true }).title).toBe("YouTube digest: 1 takeaway from 1 video today");
  });
});
