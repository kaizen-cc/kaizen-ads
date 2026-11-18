import { describe, expect, it } from "vitest";
import { DEFAULT_VOICES, assistantVoiceFor, speakable } from "@/lib/agent-call/core";
import { LINK_LINE, SAY_AS, forSpeech, intWords, numberWords, ordinalWords, sayAs } from "@/lib/agent-call/speech-text";
import { ASSISTANT_PALETTE, ASSISTANT_TINT, assistantTintOf, paletteColor } from "@/lib/agent-look";
import { formatTranscript, stamp, transcriptFileName } from "@/lib/agent-call/transcript";
import { RECENT_LINES, TURN_CHARS, callHistory, longTurnText } from "@/lib/agent-call/history";

// The call's voice: text put into spoken words, the assistant's voice and color per person, the transcript file,
// and how much of a long call goes back with each turn

const say = (t: string) => forSpeech(speakable(t));

describe("numbers in words", () => {
  it("says whole numbers, decimals and ordinals", () => {
    expect(intWords(0)).toBe("zero");
    expect(intWords(30512)).toBe("thirty thousand five hundred twelve");
    expect(intWords(1_000_000)).toBe("one million");
    expect(numberWords("1.25")).toBe("one point two five");
    expect(numberWords("30,512")).toBe("thirty thousand five hundred twelve");
    expect(ordinalWords(3)).toBe("third");
    expect(ordinalWords(21)).toBe("twenty first");
    expect(ordinalWords(30)).toBe("thirtieth");
    expect(ordinalWords(12)).toBe("twelfth");
  });
});

describe("text for the voice", () => {
  it("brand names the voice gets wrong are respelled the way they're said", () => {
    expect(say("Klaviyo is set up.")).toBe("Clay-vee-oh is set up.");
    expect(say("Check klaviyo's flows and the KLAVIYO list.")).toBe("Check Clay-vee-oh's flows and the Clay-vee-oh list.");
    expect(say("It syncs Cloudbeds and Customer.io.")).toBe("It syncs Cloud beds and Customer I O.");
    expect(say("Book it on OpenTable.")).toBe("Book it on Open Table.");
    // Only whole words, and a real link still isn't read out
    expect(say("Klaviyos")).toBe("Klaviyos");
    expect(say("See https://klaviyo.com/x for it.")).toBe(`See for it. ${LINK_LINE}`);
  });
  it("adding a brand is one line of data", () => {
    expect(Object.keys(SAY_AS)).toContain("Klaviyo");
    for (const [name, said] of Object.entries(SAY_AS)) expect(sayAs(name)).toBe(said);
  });
  it("money", () => {
    expect(say("Spend was $1.2k yesterday.")).toBe("Spend was one point two thousand dollars yesterday.");
    expect(say("Revenue hit $30,512 this month.")).toBe("Revenue hit thirty thousand five hundred twelve dollars this month.");
    expect(say("It cost $12.50 a lead.")).toBe("It cost twelve dollars and fifty cents a lead.");
    expect(say("We spent $2M.")).toBe("We spent two million dollars.");
    expect(say("Budget $10-$20 a day.")).toBe("Budget ten to twenty dollars a day.");
    expect(say("Run the $5/day test.")).toBe("Run the five dollars per day test.");
  });
  it("percentages, decimals, ranges and multipliers", () => {
    expect(say("CTR is up 12.5%.")).toBe("C T R is up twelve point five percent.");
    expect(say("Give it 3-5 days.")).toBe("Give it three to five days.");
    expect(say("A 2.4x ROAS.")).toBe("A two point four x Roh-as.");
    // ROAS is one word ("roh-as"), never spelled out, in any case and with a possessive
    expect(say("ROAS is 3.1 and the roas target's 2.")).toBe("Roh-as is three point one and the Roh-as target's two.");
    expect(say("The ROAS's trend.")).toBe("The Roh-as's trend.");
    expect(say("ROAS")).not.toMatch(/R O A S/);
    expect(say("We got 12k impressions.")).toBe("We got twelve thousand impressions.");
    expect(say("Conversion moved 2-3%.")).toBe("Conversion moved two to three percent.");
  });
  it("dates and times", () => {
    expect(say("Launch on Nov 3rd, 2026 at 3:30pm.")).toBe("Launch on November third, twenty twenty six at three thirty p m.");
    expect(say("Due 11/3 at 9am.")).toBe("Due November third at nine a m.");
    expect(say("Review 2026-11-05.")).toBe("Review November fifth, twenty twenty six.");
    expect(say("Call at 10:05.")).toBe("Call at ten oh five.");
  });
  it("symbols and short forms", () => {
    expect(say("Meta vs Google & TikTok")).toBe("Meta versus Google and TikTok");
    expect(say("KPIs look fine and CPA is flat.")).toBe("K P Is look fine and C P A is flat.");
    expect(say("The AI reads the URL by ID.")).toBe("The A I reads the U R L by I D.");
    expect(say("and/or")).toBe("and or or");
  });
  it("never reads a link or an email out", () => {
    expect(say("Check https://app.kaizen.com/x for it.")).toBe(`Check for it. ${LINK_LINE}`);
    expect(say("Email kyle@example.com please.")).toBe(`Email please. ${LINK_LINE}`);
    expect(say("https://example.com")).toBe(LINK_LINE);
    expect(say("I've put the link on screen.")).toBe("I've put the link on screen.");
  });
  it("strips markdown and emojis, leaves names as written", () => {
    expect(say("**Crust Pizza Co** is up 🎉")).toBe("Crust Pizza Co is up");
    expect(say("Ocean Box and Hello Fresh")).toBe("Ocean Box and Hello Fresh");
  });
});

describe("your assistant's voice and color", () => {
  it("speaks in the voice the person picked, else the assistant's, else the default", () => {
    expect(assistantVoiceFor("Pick3dVoice12345", "RoleVoice1234567")).toBe("Pick3dVoice12345");
    expect(assistantVoiceFor(null, "RoleVoice1234567")).toBe("RoleVoice1234567");
    expect(assistantVoiceFor("bad id!", null)).toBe(DEFAULT_VOICES.assistant.id);
    expect(assistantVoiceFor(undefined, undefined)).toBe(DEFAULT_VOICES.assistant.id);
  });
  it("takes only the palette's colors", () => {
    expect(ASSISTANT_PALETTE.length).toBeGreaterThanOrEqual(8);
    expect(ASSISTANT_PALETTE.length).toBeLessThanOrEqual(10);
    expect(ASSISTANT_PALETTE[0].hex).toBe(ASSISTANT_TINT);
    for (const c of ASSISTANT_PALETTE) expect(c.hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(ASSISTANT_PALETTE.map((c) => c.hex)).size).toBe(ASSISTANT_PALETTE.length);
    expect(paletteColor(" #2A9D8F ")).toBe("#2a9d8f");
    expect(paletteColor("#123456")).toBeNull();
    expect(paletteColor("red")).toBeNull();
    expect(paletteColor(null)).toBeNull();
    expect(assistantTintOf("#123456")).toBe(ASSISTANT_TINT);
    expect(assistantTintOf("#d4507a")).toBe("#d4507a");
  });
});

describe("the transcript file", () => {
  const startedAt = "2026-11-17T15:00:00.000Z";
  it("has the date, the agent, and each line with its time and speaker", () => {
    const text = formatTranscript({
      startedAt,
      endedAt: "2026-11-17T15:04:10.000Z",
      agentLabel: "Assistant",
      personName: "Santi",
      lines: [
        { at: "2026-11-17T15:00:01.000Z", who: "agent", speaker: "Assistant", text: "Morning, Santi!" },
        { at: "2026-11-17T15:00:42.000Z", who: "user", text: "What's on today?" },
        { at: "2026-11-17T15:01:05.000Z", who: "agent", speaker: "Media Buyer", text: "Crust is  first." },
        { at: "2026-11-17T15:01:06.000Z", who: "agent", text: "  " },
      ],
    });
    expect(text).toContain("Call with the Assistant");
    expect(text).toContain("Tuesday, November 17, 2026");
    expect(text).toContain("(4:10)");
    expect(text).toContain("[00:01] Assistant: Morning, Santi!");
    expect(text).toContain("[00:42] Santi: What's on today?");
    expect(text).toContain("[01:05] Media Buyer: Crust is first.");
    expect(text.split("\n").filter((l) => l.startsWith("[")).length).toBe(3);
  });
  it("times past an hour, never negative; a file name by agent and day", () => {
    expect(stamp("2026-11-17T16:02:03.000Z", startedAt)).toBe("1:02:03");
    expect(stamp("2026-11-17T14:59:00.000Z", startedAt)).toBe("00:00");
    expect(transcriptFileName(startedAt, "Media Buyer")).toBe("call-media-buyer-2026-11-17.txt");
  });
  it("says so when nothing was said", () => {
    expect(formatTranscript({ startedAt, agentLabel: "Copywriter", personName: "You", lines: [] })).toContain("(Nothing was said on this call.)");
  });
});

describe("a long call's history", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "agent" : "user", content: `line ${i}` }));
  it("sends a short call whole", () => {
    expect(callHistory(rows(10))).toEqual({ recent: rows(10), digest: null });
  });
  it("keeps the newest lines whole and digests the rest, so it doesn't grow with the call", () => {
    const h = callHistory(rows(400));
    expect(h.recent).toHaveLength(RECENT_LINES);
    expect(h.recent[RECENT_LINES - 1].content).toBe("line 399");
    expect(h.digest).toContain("line 374");
    expect(h.digest).not.toContain("agent");
    expect(h.digest!.length).toBeLessThan(2100);
    expect(callHistory(rows(4000)).digest!.length).toBeLessThan(2100);
  });
  it("takes a long monologue whole, and only cuts a truly huge one", () => {
    const five = "word ".repeat(900);
    expect(longTurnText(five)).toBe(five.trim());
    const huge = "x".repeat(TURN_CHARS * 2);
    const cut = longTurnText(huge);
    expect(cut.length).toBeLessThanOrEqual(TURN_CHARS);
    expect(cut).toContain("left out");
  });
});
