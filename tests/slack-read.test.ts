import { describe, expect, it } from "vitest";
import { isNew, messageText, profileName, threadsWithNewReplies } from "@/lib/context/slack-read-core";

// Nov 25: a client's reply inside a thread that started before our last read ("do not send anything about Black
// Friday") never reached the OS.
const since = 1_795_000_000;

describe("reading client channels, threads included", () => {
  it("reads the replies of an older thread that got a new reply, and only those threads", () => {
    const parents = [
      { ts: String(since - 86_400 * 3), reply_count: 4, latest_reply: String(since + 600) }, // older thread, new reply: read
      { ts: String(since - 86_400 * 2), reply_count: 2, latest_reply: String(since - 100) }, // older thread, nothing new
      { ts: String(since + 50) }, // a new message without replies
      { ts: String(since + 60), reply_count: 1, latest_reply: String(since + 70) }, // a new thread with a reply
    ];
    expect(threadsWithNewReplies(parents, since)).toEqual([String(since - 86_400 * 3), String(since + 60)]);
    expect(isNew(String(since + 1), since)).toBe(true);
    expect(isNew(String(since - 1), since)).toBe(false);
  });
  it("keeps what clients say, file shares included, and drops joins and topic changes", () => {
    expect(messageText({ ts: "1", text: " Please do not send anything about Black Friday " })).toBe("Please do not send anything about Black Friday");
    expect(messageText({ ts: "1", text: "", files: [{ title: "Holiday promo.pdf" }] })).toBe("Shared a file: Holiday promo.pdf");
    expect(messageText({ ts: "1", subtype: "channel_join", text: "joined" })).toBeNull();
    expect(messageText({ ts: "1", subtype: "thread_broadcast", text: "Also posted to the channel" })).toBe("Also posted to the channel");
    expect(messageText({ ts: "1" })).toBeNull();
  });
  it("names someone from the client's own workspace from the message", () => {
    expect(profileName({ ts: "1", user_profile: { real_name: "Natalia R." } })).toBe("Natalia R.");
    expect(profileName({ ts: "1" })).toBeNull();
  });
});
