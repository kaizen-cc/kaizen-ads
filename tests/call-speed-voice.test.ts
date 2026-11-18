import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { CONCISE_RULE } from "@/lib/agent-call/core";
import { forSpeech } from "@/lib/agent-call/speech-text";
import { createLengthGuard, spokenCapFor, SPOKEN_CAP_WORDS, DETAIL_CAP_WORDS, MORE_LINE } from "@/lib/agent-call/spoken-length";
import { isRepeatTurn } from "@/lib/agent-call/transcript";
import { createTranscript } from "@/lib/agent-call/turns";
import { callTimer } from "@/lib/agent-call/timing";
import { businessFitBlock, fitKindOf } from "@/lib/agent-call/business-fit";
import { asksToBringIn, directSpecialist, isExpertQuestion, specialistNamed, wantsShorter } from "@/lib/assistant/team";
import { CALL_VOICE_SETTINGS, previousContext, voiceSeed } from "@/lib/elevenlabs";

describe("money is always said with the plain word dollars", () => {
  const cases: [string, string][] = [
    ["$4k", "four thousand dollars"],
    ["$4,200", "four thousand two hundred dollars"],
    ["4,200 dollars", "four thousand two hundred dollars"],
    ["4,200 USD", "four thousand two hundred dollars"],
    ["USD 4,200", "four thousand two hundred dollars"],
    ["US$4,200", "four thousand two hundred dollars"],
    ["$ 4,200", "four thousand two hundred dollars"],
    ["$4,200 USD", "four thousand two hundred dollars"],
    ["$4.2K/mo", "four point two thousand dollars per month"],
    ["$150/day", "one hundred fifty dollars per day"],
    ["$12k/yr", "twelve thousand dollars per year"],
    ["$900 per mo", "nine hundred dollars per month"],
  ];
  for (const [raw, said] of cases) {
    it(raw, () => {
      const out = forSpeech(`Spend is ${raw}.`);
      expect(out).toBe(`Spend is ${said}.`);
      expect(out).not.toMatch(/\$|USD|\/|\d/);
    });
  }
});

describe("the call voice is steady and repeatable", () => {
  it("is steadier than before, still natural", () => {
    expect(CALL_VOICE_SETTINGS.stability).toBeGreaterThanOrEqual(0.6);
    expect(CALL_VOICE_SETTINGS.stability).toBeLessThanOrEqual(0.65);
  });
  it("has one fixed seed per voice", () => {
    expect(voiceSeed("JBFqnCBsd6RMkjVDRZzb")).toBe(voiceSeed("JBFqnCBsd6RMkjVDRZzb"));
    expect(voiceSeed("JBFqnCBsd6RMkjVDRZzb")).not.toBe(voiceSeed("XB0fDUnXU5powFXDhCwa"));
    const s = voiceSeed("cjVigY5qzO86Huf0OWal");
    expect(Number.isInteger(s) && s >= 0 && s <= 4294967295).toBe(true);
  });
  it("passes only whole words and sentences as the text before", () => {
    expect(previousContext("Okay.")).toBeNull();
    expect(previousContext(null)).toBeNull();
    const long = `${"Spend was about four thousand dollars last week. ".repeat(10)}And the return held up well.`;
    const p = previousContext(long, 120) ?? "";
    expect(p.length).toBeLessThanOrEqual(120);
    expect(p).toMatch(/^[A-Z]/);
    expect(p.endsWith("held up well.")).toBe(true);
  });
});

describe("spoken answers stay short", () => {
  it("the rule leads with the answer, three items at most, about sixty words", () => {
    expect(CONCISE_RULE).toMatch(/one or two short sentences/);
    expect(CONCISE_RULE).toMatch(/at most three/);
    expect(CONCISE_RULE).toMatch(/sixty words/);
    expect(CONCISE_RULE).not.toMatch(/—/);
  });
  it("asking for detail raises the cap", () => {
    expect(spokenCapFor("what workflows can we build?")).toBe(SPOKEN_CAP_WORDS);
    expect(spokenCapFor("walk me through it")).toBe(DETAIL_CAP_WORDS);
    expect(spokenCapFor("tell me more")).toBe(DETAIL_CAP_WORDS);
  });
  it("stops at the end of the sentence past the cap and offers the rest", () => {
    const g = createLengthGuard(10);
    let out = "";
    for (const piece of ["One two three four five. ", "Six seven eight nine ten eleven. ", "Twelve thirteen. ", "Fourteen."]) out += g.feed(piece);
    expect(out).toBe("One two three four five. Six seven eight nine ten eleven.");
    expect(g.capped).toBe(true);
    expect(g.tail).toBe(` ${MORE_LINE}`);
  });
  it("doesn't add the offer after a question", () => {
    const g = createLengthGuard(3);
    g.feed("Want me to pull all four of them now?");
    expect(g.capped).toBe(true);
    expect(g.tail).toBe("");
  });
  it("hears 'keep it short'", () => {
    expect(wantsShorter("you're rambling a little bit too much, keep conversations short")).toBe(true);
    expect(wantsShorter("keep it short")).toBe(true);
    expect(wantsShorter("what's the short version of the Crust report")).toBe(false);
  });
});

describe("the same words are one turn", () => {
  it("drops the same sentence sent again moments later", () => {
    const said = "Can you call in the Google media buyer so we can talk about Ocean Box?";
    expect(isRepeatTurn(said, { text: said, at: 1000 }, 26_000)).toBe(true);
    expect(isRepeatTurn(said.toLowerCase().replace("?", ""), { text: said, at: 1000 }, 26_000)).toBe(true);
    expect(isRepeatTurn(said, { text: said, at: 1000 }, 120_000)).toBe(false);
    expect(isRepeatTurn("yes do it", { text: "yes do it", at: 0 }, 5000)).toBe(false);
    expect(isRepeatTurn(said, null, 5000)).toBe(false);
  });
  it("a late transcript of a turn already sent doesn't come back as the next turn", () => {
    const w = createTranscript();
    w.sent();
    w.partial("call in the google media buyer");
    // The wait ran out: the turn goes with the live words
    w.expire();
    expect(w.take()).toBe("call in the google media buyer");
    // Then the transcriber's commit for it arrives
    w.committed("Call in the Google media buyer.");
    expect(w.text).toBe("");
    // New words still count
    w.sent();
    w.committed("What about Ocean Box?");
    expect(w.take()).toBe("What about Ocean Box?");
  });
});

describe("bringing a specialist in on the first ask", () => {
  it("an explicit ask names the right specialist, the longest name winning", () => {
    expect(asksToBringIn("Can you call in the Google media buyer so we can talk about Ocean Box?")).toBe("google_buyer");
    expect(asksToBringIn("bring in the media buyer")).toBe("media_buyer");
    expect(asksToBringIn("can I talk to the email strategist")).toBe("email_strategist");
    expect(asksToBringIn("get the copywriter on the call")).toBe("copywriter");
    expect(specialistNamed("the google ads buyer")).toBe("google_buyer");
  });
  it("not when they say not to, or it's a task for a teammate", () => {
    expect(asksToBringIn("don't call in the media buyer yet")).toBeNull();
    expect(asksToBringIn("get the media buyer to update the client")).toBeNull();
    expect(asksToBringIn("what did the media buyer say?")).toBeNull();
  });
  it("strategy questions go to the line's specialist, not the assistant", () => {
    expect(directSpecialist("what flows can we build for Angry Chickz?")).toEqual({ key: "email_strategist", why: "expert" });
    expect(directSpecialist("why is this Google campaign off?")).toEqual({ key: "google_buyer", why: "expert" });
    expect(directSpecialist("what should we test next on Meta?")).toEqual({ key: "media_buyer", why: "expert" });
    expect(directSpecialist("what workflows can we build?", { screen: "the client page, Email tab" })).toEqual({ key: "email_strategist", why: "expert" });
    expect(directSpecialist("can you call in the Google media buyer?")).toEqual({ key: "google_buyer", why: "asked" });
  });
  it("the assistant keeps facts, its own tasks and navigation", () => {
    expect(isExpertQuestion("what do I need to do today?")).toBe(false);
    expect(directSpecialist("remind me to check Crust tomorrow")).toBeNull();
    expect(directSpecialist("take me to Ocean Box's page")).toBeNull();
    expect(directSpecialist("what's Crust's ROAS this week?")).toBeNull();
  });
});

describe("every agent knows what kind of business the client is", () => {
  it("a restaurant gets restaurant tactics and is told what doesn't fit", () => {
    const b = businessFitBlock({ client: "Angry Chickz", model: "restaurant", also: "lead_gen", industry: "restaurant", sub: "Fast casual chicken" });
    expect(b).toContain('client="Angry Chickz"');
    expect(b).toMatch(/Business type: a restaurant \(restaurant, Fast casual chicken\)/);
    expect(b).toMatch(/Only suggest tactics that fit this business/);
    expect(b).toMatch(/loyalty/);
    expect(b).toMatch(/Toast/);
    expect(b).toMatch(/reservations/);
    expect(b).toMatch(/What doesn't fit: ecommerce tactics: browse abandonment, cart or checkout abandonment/);
  });
  it("hotels and subscriptions are told apart", () => {
    expect(fitKindOf("bookings", "Hospitality Boutique hotel")).toBe("hotel");
    expect(fitKindOf("ecommerce", "Coffee subscription")).toBe("subscription");
    expect(fitKindOf("ecommerce", "Apparel")).toBe("ecommerce");
  });
  it("unknown: ask or say the assumption", () => {
    const b = businessFitBlock({ client: "New Co", model: null, also: null, industry: null, sub: null });
    expect(b).toMatch(/not on record/);
    expect(b).toMatch(/ask what kind of business/);
    expect(b).toMatch(/assuming/);
  });
});

describe("turn timings", () => {
  it("one compact line: total, each phase, repeats added up, moments marked", async () => {
    let now = 0;
    const t = callTimer(0, () => now);
    now = 40;
    t.add("auth", 40);
    await t.time("model", async () => {
      now = 1240;
    });
    await t.time("model", async () => {
      now = 1540;
    });
    t.mark("first_word");
    expect(t.line("call=abc")).toBe("call=abc total=1540 auth=40 model=1500x2 first_word@1540");
  });
});
