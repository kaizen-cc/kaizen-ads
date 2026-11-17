import { describe, expect, it } from "vitest";
import {
  DEFAULT_VOICES,
  TURN,
  clock,
  createTurnDetector,
  downsample,
  firstNameOf,
  greetingFor,
  looksSensitive,
  parseLearnings,
  rms,
  speakable,
  splitSpeakable,
  toPcm16,
  voiceFor,
} from "@/lib/agent-call/core";
import { ROLE_SKILLS } from "@/lib/agent-access";

describe("splitting the reply into sentences to speak", () => {
  it("speaks whole sentences and keeps the unfinished one", () => {
    const r = splitSpeakable("I check frequency before anything else. Then I look at the hook rate and");
    expect(r.ready).toEqual(["I check frequency before anything else."]);
    expect(r.rest).toBe("Then I look at the hook rate and");
  });
  it("waits for the space after a full stop (the next token may continue a number)", () => {
    expect(splitSpeakable("ROAS was 2.").ready).toEqual([]);
    expect(splitSpeakable("ROAS was 2.4 last week, which is fine. Next").ready).toEqual(["ROAS was 2.4 last week, which is fine."]);
  });
  it("doesn't end a sentence at an abbreviation", () => {
    const r = splitSpeakable("Use a proof point, e.g. a review count, in the first line. Okay");
    expect(r.ready).toEqual(["Use a proof point, e.g. a review count, in the first line."]);
  });
  it("joins very short sentences to the next so the voice doesn't stutter", () => {
    const r = splitSpeakable("Sure. Here is how I build a brief for a new client. And");
    expect(r.ready).toEqual(["Sure. Here is how I build a brief for a new client."]);
    expect(r.rest).toBe("And");
  });
  it("holds a short sentence until more comes", () => {
    const r = splitSpeakable("Got it. ");
    expect(r.ready).toEqual([]);
    expect(r.rest.trim()).toBe("Got it.");
  });
  it("ends at questions, exclamations and line breaks", () => {
    const r = splitSpeakable("Which account do you mean here? That one is great!\nThird line coming");
    expect(r.ready).toEqual(["Which account do you mean here?", "That one is great!"]);
    expect(r.rest).toBe("Third line coming");
  });
  it("cuts a very long run at a comma so speech starts sooner", () => {
    const long = `${"word ".repeat(30).trim()}, ${"more ".repeat(30).trim()}, and still going on and on`;
    const r = splitSpeakable(long);
    expect(r.ready.length).toBeGreaterThan(0);
    expect(r.ready[0].endsWith(",")).toBe(true);
  });
});

describe("text for speech", () => {
  it("strips markdown, links and dashes", () => {
    expect(speakable("**Three things** to check:\n- [the report](https://x.y/z)\n- frequency — always")).toBe("Three things to check: the report frequency, always");
    expect(speakable("See https://example.com/a for it")).toBe("See the link for it");
  });
});

describe("greeting", () => {
  it("uses the first name", () => {
    expect(greetingFor("Kyle Smith", "Media Buyer")).toBe("Hey Kyle, it's the Media Buyer. What can I help you with?");
    expect(firstNameOf("")).toBe("there");
    expect(firstNameOf(null)).toBe("there");
  });
});

describe("voices", () => {
  it("has a distinct default voice for every agent", () => {
    for (const role of Object.keys(ROLE_SKILLS)) expect(DEFAULT_VOICES[role], role).toBeTruthy();
    const ids = Object.values(DEFAULT_VOICES).map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("uses the picked voice when it's a real id", () => {
    expect(voiceFor("media_buyer", "abcdefgh12345678")).toBe("abcdefgh12345678");
    expect(voiceFor("media_buyer", "bad id!")).toBe(DEFAULT_VOICES.media_buyer.id);
    expect(voiceFor("unknown_role", null)).toMatch(/^[A-Za-z0-9]{8,40}$/);
  });
});

describe("turn taking", () => {
  const run = (d: ReturnType<typeof createTurnDetector>, level: number, ms: number, speaking = false) => {
    const events: string[] = [];
    for (let t = 0; t < ms; t += 20) {
      const e = d.feed(level, 20, speaking);
      if (e) events.push(e);
    }
    return events;
  };
  it("starts a turn after enough speech and ends it after enough silence", () => {
    const d = createTurnDetector();
    expect(run(d, 0.001, 400)).toEqual([]);
    expect(run(d, 0.1, TURN.minSpeechMs + 40)).toEqual(["speech_start"]);
    expect(run(d, 0.001, TURN.endSilenceMs - 100)).toEqual([]);
    expect(run(d, 0.001, 200)).toEqual(["turn_end"]);
  });
  it("ignores a click or a cough", () => {
    const d = createTurnDetector();
    expect(run(d, 0.2, 60)).toEqual([]);
    expect(run(d, 0.001, 2000)).toEqual([]);
  });
  it("keeps the turn open through a short pause", () => {
    const d = createTurnDetector();
    run(d, 0.1, 400);
    expect(run(d, 0.001, 400)).toEqual([]);
    expect(run(d, 0.1, 200)).toEqual([]);
    expect(run(d, 0.001, 1000)).toEqual(["turn_end"]);
  });
  it("hears someone talking over the agent, but not its quiet echo", () => {
    const d = createTurnDetector();
    expect(run(d, 0.03, 1000, true)).toEqual([]);
    expect(run(d, 0.1, TURN.bargeMs + 20, true)).toEqual(["barge_in"]);
  });
  it("needs louder speech in a noisy room", () => {
    const d = createTurnDetector();
    // A steady hum just under the speech level: learned as the room's noise
    run(d, 0.015, 4000);
    expect(run(d, 0.03, 400)).toEqual([]);
    expect(run(d, 0.2, 400)).toEqual(["speech_start"]);
  });
});

describe("microphone audio", () => {
  it("measures loudness", () => {
    expect(rms([])).toBe(0);
    expect(rms([0.5, -0.5, 0.5, -0.5])).toBeCloseTo(0.5);
  });
  it("downsamples 48kHz to 16kHz", () => {
    const out = downsample(new Float32Array(480).fill(0.25), 48000, 16000);
    expect(out.length).toBe(160);
    expect(out[10]).toBeCloseTo(0.25);
  });
  it("encodes 16-bit little-endian PCM, clipped", () => {
    const b = toPcm16([0, 1, -1, 2]);
    const v = new DataView(b.buffer);
    expect(b.length).toBe(8);
    expect(v.getInt16(0, true)).toBe(0);
    expect(v.getInt16(2, true)).toBe(32767);
    expect(v.getInt16(4, true)).toBe(-32768);
    expect(v.getInt16(6, true)).toBe(32767);
  });
  it("shows the clock", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(65.9)).toBe("1:05");
    expect(clock(1800)).toBe("30:00");
  });
});

describe("what the agent learned", () => {
  const skills = ["auditor", "launcher", "fatigue"];
  it("keeps notes on its own skills and rewrites of its core", () => {
    const out = parseLearnings(
      {
        learnings: [
          { type: "note", skill: "fatigue", kind: "skill", title: "Check frequency first", body: "Before calling an ad fatigued, check frequency over the last seven days." },
          { type: "rewrite", skill: "core", kind: "knowledge", title: "Shorter answers", body: "Keep every answer to the buyer under four sentences." },
        ],
      },
      skills,
    );
    expect(out.map((l) => [l.type, l.skill])).toEqual([
      ["note", "fatigue"],
      ["rewrite", "core"],
    ]);
  });
  it("drops other agents' skills, notes on the core, empty and unknown entries", () => {
    const out = parseLearnings(
      {
        learnings: [
          { type: "note", skill: "copy", kind: "skill", title: "Not mine", body: "A rule for another agent entirely here." },
          { type: "note", skill: "core", kind: "skill", title: "Core as a note", body: "Notes go to skills, not to the core." },
          { type: "note", skill: "auditor", kind: "skill", title: "", body: "No title on this one at all." },
          { type: "note", skill: "auditor", kind: "skill", title: "Too short", body: "ok" },
          { type: "maybe", skill: "auditor", kind: "skill", title: "Odd type", body: "This has a type that isn't known." },
          null,
          "text",
        ],
      },
      skills,
    );
    expect(out).toEqual([]);
    expect(parseLearnings(null, skills)).toEqual([]);
    expect(parseLearnings({ learnings: "nope" }, skills)).toEqual([]);
  });
  it("never keeps secrets or personal details", () => {
    const bad = [
      "The Meta login is ops@kaizen.example, use it for launches.",
      "Call the owner on +1 (415) 555-0134 before pausing anything.",
      "The API key is sk-live_abcdefghijklmnopqrstuvwxyz123456 for the store.",
      "The password for the client's Shopify is in the shared vault.",
      "Card 4242 4242 4242 4242 pays for the boosts.",
    ];
    const out = parseLearnings({ learnings: bad.map((body, i) => ({ type: "note", skill: "auditor", kind: "knowledge", title: `Item ${i}`, body })) }, skills);
    expect(out).toEqual([]);
    for (const b of bad) expect(looksSensitive(b), b).toBe(true);
    expect(looksSensitive("Check frequency over 7 days before calling fatigue; above 3.5 is high.")).toBe(false);
  });
  it("removes repeats, fixes the kind and keeps at most three", () => {
    const one = { type: "note", skill: "auditor", kind: "weird", title: "Same title", body: "The same lesson said twice in one go." };
    const out = parseLearnings(
      {
        learnings: [one, { ...one, title: "same TITLE" }, ...[1, 2, 3, 4].map((n) => ({ type: "note", skill: "launcher", kind: "example", title: `Lesson ${n}`, body: "A lesson worth keeping for launches." }))],
      },
      skills,
    );
    expect(out).toHaveLength(3);
    expect(out[0].kind).toBe("knowledge");
    expect(out.filter((l) => l.title.toLowerCase() === "same title")).toHaveLength(1);
  });
});
