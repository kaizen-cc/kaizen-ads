import { describe, expect, it } from "vitest";
import { cleanGeminiTranscript, geminiErrorKind, MAX_SECONDS, nextTranscriptStep, parseFeed } from "@/lib/youtube-core";
import { costOf, emptyUsage } from "@/lib/ai-costs";

const base = { playable: "OK", seconds: 1200, allowLong: false, geminiKey: true, geminiLeft: 3, serviceKey: false };

describe("youtube transcript order", () => {
  it("Gemini first when its key is set and the run has room, then the service, then a paste", () => {
    expect(nextTranscriptStep(base)).toBe("gemini");
    expect(nextTranscriptStep({ ...base, geminiFailed: true, serviceKey: true })).toBe("service");
    expect(nextTranscriptStep({ ...base, geminiFailed: true })).toBe("paste");
    expect(nextTranscriptStep({ ...base, geminiKey: false, serviceKey: true })).toBe("service");
  });
  it("waits for the key with none set, and for the next run when the cap is spent", () => {
    expect(nextTranscriptStep({ ...base, geminiKey: false })).toBe("wait-key");
    expect(nextTranscriptStep({ ...base, geminiLeft: 0 })).toBe("later");
  });
  it("skips a channel's video past an hour unless it was added on purpose", () => {
    expect(nextTranscriptStep({ ...base, seconds: MAX_SECONDS + 60 })).toBe("long");
    expect(nextTranscriptStep({ ...base, seconds: MAX_SECONDS + 60, allowLong: true })).toBe("gemini");
    // An unknown length is read (the per-run cap still holds)
    expect(nextTranscriptStep({ ...base, seconds: null })).toBe("gemini");
  });
  it("stops at a private, removed or age-restricted video", () => {
    expect(nextTranscriptStep({ ...base, playable: "LOGIN_REQUIRED" })).toBe("unavailable");
    expect(nextTranscriptStep({ ...base, playable: "ERROR", geminiKey: false })).toBe("unavailable");
  });
});

describe("gemini answers", () => {
  it("keeps the transcript and drops fences and preambles", () => {
    expect(cleanGeminiTranscript("Here is the transcript:\n[0:00] Welcome back. Today, the three two two method.\n[0:31] Three creatives.")).toBe("[0:00] Welcome back. Today, the three two two method.\n[0:31] Three creatives.");
    expect(cleanGeminiTranscript("```text\n[0:00] Hello and welcome to the channel, today we test ads\n```")).toBe("[0:00] Hello and welcome to the channel, today we test ads");
  });
  it("is null with no speech or nothing useful", () => {
    expect(cleanGeminiTranscript("NO_SPEECH")).toBeNull();
    expect(cleanGeminiTranscript("")).toBeNull();
    expect(cleanGeminiTranscript("[0:00] hi")).toBeNull();
  });
  it("sorts errors into unavailable, key and retry", () => {
    expect(geminiErrorKind(400, "The video is private and cannot be accessed")).toBe("unavailable");
    expect(geminiErrorKind(400, "Video is age restricted")).toBe("unavailable");
    expect(geminiErrorKind(400, "API key not valid. Please pass a valid API key.")).toBe("key");
    expect(geminiErrorKind(403, "Permission denied")).toBe("key");
    expect(geminiErrorKind(429, "Resource exhausted")).toBe("retry");
    expect(geminiErrorKind(503, "The model is overloaded")).toBe("retry");
  });
  it("prices Gemini on its own rates", () => {
    expect(costOf("gemini-flash", { ...emptyUsage(), input: 1_000_000, output: 100_000 })).toBeCloseTo(0.8, 5);
  });
});

describe("youtube shorts", () => {
  it("marks Shorts in the feed so a channel never reads them", () => {
    const f = parseFeed(`<feed><title>C</title><yt:channelId>UCWquNQV8Y0_defMKnGKrFOQ</yt:channelId>
<entry><yt:videoId>AAAAAAAAAAA</yt:videoId><title>A long one</title><link rel="alternate" href="https://www.youtube.com/watch?v=AAAAAAAAAAA"/><published>2026-11-01T00:00:00+00:00</published></entry>
<entry><yt:videoId>BBBBBBBBBBB</yt:videoId><title>Quick tip</title><link rel="alternate" href="https://www.youtube.com/shorts/BBBBBBBBBBB"/><published>2026-11-02T00:00:00+00:00</published></entry>
<entry><yt:videoId>CCCCCCCCCCC</yt:videoId><title>A good ad #shorts</title><published>2026-11-03T00:00:00+00:00</published></entry>
</feed>`);
    expect(f.videos.map((v) => [v.videoId, v.short])).toEqual([
      ["CCCCCCCCCCC", true],
      ["BBBBBBBBBBB", true],
      ["AAAAAAAAAAA", false],
    ]);
  });
});
