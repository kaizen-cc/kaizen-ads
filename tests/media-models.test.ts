import { describe, expect, it } from "vitest";
import { canGenerateMedia, clampVoiceSettings, DEFAULT_VOICE_SETTINGS, hfOutputs, hfRequest, hfStatus, mediaFileName, MAX_VO_CHARS, voFromScript, voModelOf, voText } from "@/lib/media-models";

describe("voice settings", () => {
  it("keeps every setting inside what ElevenLabs takes", () => {
    expect(clampVoiceSettings({ stability: 3, similarityBoost: -1, style: "0.333", speed: 2, speakerBoost: false })).toEqual({ stability: 1, similarityBoost: 0, style: 0.33, speed: 1.2, speakerBoost: false });
    expect(clampVoiceSettings({ speed: 0.1 }).speed).toBe(0.7);
  });
  it("falls back to the defaults for anything missing or garbled", () => {
    expect(clampVoiceSettings(null)).toEqual(DEFAULT_VOICE_SETTINGS);
    expect(clampVoiceSettings({ stability: "abc", style: NaN })).toEqual(DEFAULT_VOICE_SETTINGS);
  });
  it("only takes known models", () => {
    expect(voModelOf("eleven_turbo_v2_5")).toBe("eleven_turbo_v2_5");
    expect(voModelOf("gpt-voice")).toBe("eleven_multilingual_v2");
  });
});

describe("voiceover text", () => {
  it("tidies the text and refuses empty or too long", () => {
    expect(voText("  Hello   there\r\n\n\n\nfriend ")).toEqual({ ok: true, text: "Hello there\n\nfriend" });
    expect(voText("   ").ok).toBe(false);
    expect(voText("a".repeat(MAX_VO_CHARS + 1)).ok).toBe(false);
  });
  it("pulls the VO from a script: the hook's line, then each beat, without repeats or empties", () => {
    const s = {
      hooks: [{ spoken: "Stop scrolling." }, { spoken: "Second hook." }],
      beats: [{ voiceover: "Stop scrolling." }, { voiceover: "VO: Meet the serum." }, { voiceover: "none" }, { voiceover: null }, { voiceover: "Shop now." }],
    };
    expect(voFromScript(s)).toBe("Stop scrolling.\nMeet the serum.\nShop now.");
    expect(voFromScript(s, 1)).toBe("Second hook.\nStop scrolling.\nMeet the serum.\nShop now.");
    expect(voFromScript(null)).toBe("");
  });
});

describe("Higgsfield requests", () => {
  it("sends only the model's own fields, each within what it accepts", () => {
    const r = hfRequest("soul-v2", { prompt: " a red bottle ", options: { aspect_ratio: "5:4", batch_size: "4", resolution: "720p", junk: 1, enhance_prompt: false } });
    expect(r.ok && r.path).toBe("/higgsfield-ai/soul/v2/standard");
    expect(r.ok && r.body).toEqual({ prompt: "a red bottle", aspect_ratio: "9:16", resolution: "720p", batch_size: 4, enhance_prompt: false });
  });
  it("clamps a video's length and uses the image path only with a reference", () => {
    const text = hfRequest("seedance-2", { prompt: "waves", options: { duration: 99 } });
    expect(text.ok && text.path).toBe("/bytedance/seedance-2.0/text-to-video");
    expect(text.ok && text.body.duration).toBe(15);
    expect(text.ok && text.body.aspect_ratio).toBe("9:16");
    const img = hfRequest("seedance-2", { prompt: "", referenceUrl: "https://x/y.png", options: { duration: 2 } });
    expect(img.ok && img.path).toBe("/bytedance/seedance-2.0/image-to-video");
    expect(img.ok && img.body).toMatchObject({ image_url: "https://x/y.png", duration: 4 });
    expect(img.ok && "aspect_ratio" in img.body).toBe(false);
    expect(img.ok && "prompt" in img.body).toBe(false);
  });
  it("sends a product photo as image_urls and Kling's duration as a number", () => {
    const m = hfRequest("marketing-image", { prompt: "ad", referenceUrl: "https://x/p.jpg" });
    expect(m.ok && m.body.image_urls).toEqual(["https://x/p.jpg"]);
    const k = hfRequest("kling-2.5", { prompt: "go", options: { duration: "10" } });
    expect(k.ok && k.body.duration).toBe(10);
  });
  it("refuses what can't run", () => {
    expect(hfRequest("nope", { prompt: "x" }).ok).toBe(false);
    expect(hfRequest("soul-v2", { prompt: "" }).ok).toBe(false);
    expect(hfRequest("seedance-2", { prompt: "" }).ok).toBe(false);
    expect(hfRequest("soul-v2", { prompt: "x".repeat(3000) }).ok).toBe(false);
  });
  it("reads statuses and outputs", () => {
    expect(hfStatus("in_progress")).toBe("running");
    expect(hfStatus("completed")).toBe("ready");
    expect(hfStatus("nsfw")).toBe("failed");
    expect(hfOutputs({ images: [{ url: "a" }, {}], video: { url: "v" } })).toEqual([
      { url: "a", kind: "image" },
      { url: "v", kind: "video" },
    ]);
  });
});

describe("roles and names", () => {
  const base = { isExec: false, isLead: false, isCreative: false, isCopywriter: false, role: "media_buyer" };
  it("lets the creative team, leads and execs generate", () => {
    expect(canGenerateMedia(base)).toBe(false);
    expect(canGenerateMedia({ ...base, role: "video_editor" })).toBe(true);
    expect(canGenerateMedia({ ...base, isLead: true })).toBe(true);
    expect(canGenerateMedia({ ...base, isCopywriter: true })).toBe(true);
  });
  it("names files by client, kind and time", () => {
    expect(mediaFileName("voiceover", "Glow & Co.", new Date("2026-11-04T15:30:00Z"), 1, "audio/mpeg")).toBe("glow-co-voiceover-202611041530.mp3");
    expect(mediaFileName("image", null, new Date("2026-11-04T15:30:00Z"), 2, "image/png")).toBe("kaizen-image-202611041530-2.png");
  });
});
