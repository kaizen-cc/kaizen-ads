import { describe, expect, it } from "vitest";
import { END_MARKER, endMarkerFilter, stripEndMarker } from "@/lib/agent-call/core";
import { canTalkToAgent, canTrainAgent } from "@/lib/agent-access";
import {
  assistantGreeting,
  audioDeleteAfter,
  audioDue,
  cleanMemory,
  effortOf,
  memoryForPrompt,
  orderForToday,
  ownMemory,
  parseSafetyReview,
  routeTurn,
  safeAppPath,
  safeLink,
  saidYes,
  suggestSpecialist,
  timedTranscript,
  type MemoryRow,
} from "@/lib/assistant/core";

// Call my assistant: who a turn goes to, offering specialists, the spoken yes, the order of the day, what it may open,
// the private memory's checks, the safety review's reading and the audio's retention, and hanging up on a goodbye.

describe("who answers on a call with a specialist", () => {
  it("is the assistant when nobody else is on", () => {
    expect(routeTurn("what's the ROAS on Crust?", null)).toEqual({ to: "assistant", dismiss: false });
  });
  it("is the specialist by default when one is on", () => {
    expect(routeTurn("what's the frequency on the prospecting ad set?", "media_buyer")).toEqual({ to: "guest", dismiss: false });
  });
  it("goes to the assistant when spoken to by name", () => {
    expect(routeTurn("Assistant, note that we pause it Friday", "media_buyer").to).toBe("assistant");
    expect(routeTurn("ok assistant what's next on my list", "media_buyer").to).toBe("assistant");
    expect(routeTurn("and assistant, remind me tomorrow", "google_buyer").to).toBe("assistant");
  });
  it("hands back and lets the specialist go", () => {
    expect(routeTurn("thanks, I'll take it from here", "media_buyer")).toEqual({ to: "assistant", dismiss: true });
    expect(routeTurn("that's all I need from you", "email_strategist")).toEqual({ to: "assistant", dismiss: true });
  });
  it("doesn't treat a mention of the word in passing as the assistant", () => {
    expect(routeTurn("my old assistant used to pull these numbers", "media_buyer").to).toBe("guest");
  });
});

describe("offering a specialist", () => {
  it("picks the clear fit", () => {
    expect(suggestSpecialist("why is the frequency so high on the Meta ad sets?")?.key).toBe("media_buyer");
    expect(suggestSpecialist("are our pmax campaigns losing impression share?")?.key).toBe("google_buyer");
    expect(suggestSpecialist("which Klaviyo flows make the most revenue")?.key).toBe("email_strategist");
  });
  it("offers nothing for plain questions or ties", () => {
    expect(suggestSpecialist("what do I need to do today?")).toBeNull();
    expect(suggestSpecialist("meta and google")).toBeNull();
  });
  it("never offers the one already on the line", () => {
    expect(suggestSpecialist("meta frequency on the ad sets", "media_buyer")?.key ?? null).not.toBe("media_buyer");
  });
});

describe("a spoken yes", () => {
  it("counts clear yeses", () => {
    for (const t of ["Yes", "yeah go ahead", "sure, do it", "yep launch it", "confirmed"]) expect(saidYes(t), t).toBe(true);
  });
  it("never counts a no, a wait or silence", () => {
    for (const t of ["", "no", "yes, but wait", "hold on", "not yet", "what would it do?", "don't send it"]) expect(saidYes(t), t).toBe(false);
  });
});

describe("what do I need to do today", () => {
  it("puts critical first (most at risk first), then simple to complex", () => {
    const out = orderForToday([
      { id: "a", tier: "normal", kind: "audit", title: "Run the Q4 audit" },
      { id: "b", tier: "critical", kind: "kpi", title: "Crust is 40% over CPA", score: 50 },
      { id: "c", tier: "high", kind: "reply", title: "Answer the client on Slack" },
      { id: "d", tier: "critical", kind: "ticket", title: "Late ticket", score: 90 },
      { id: "e", tier: "normal", kind: "ticket", title: "Write the copy for #12" },
      { id: "f", tier: "normal", kind: "notification", title: "Approved" },
    ]);
    expect(out.map((i) => i.id)).toEqual(["d", "b", "c", "f", "e", "a"]);
  });
  it("sizes work by what it is", () => {
    expect(effortOf({ kind: "x", title: "Launch the new ads" })).toBe(4);
    expect(effortOf({ kind: "reply", title: "Chase the client" })).toBe(2);
    expect(effortOf({ kind: "notification", title: "Approved" })).toBe(1);
  });
});

describe("what the assistant may open", () => {
  it("allows the app's own screens", () => {
    expect(safeAppPath("/clients/crust-pizza?tab=ads")).toBe("/clients/crust-pizza?tab=ads");
    expect(safeAppPath("/board?t=412")).toBe("/board?t=412");
  });
  it("refuses anything else", () => {
    for (const h of ["//evil.com", "https://evil.com", "/api/agent-call/turn", "/clients/../api", "javascript:alert(1)", "/clients/x y"]) expect(safeAppPath(h), h).toBeNull();
  });
  it("opens known outside sites in a new tab only over https", () => {
    expect(safeLink("https://business.facebook.com/adsmanager/manage/ads?act=1")).toEqual({ href: "https://business.facebook.com/adsmanager/manage/ads?act=1", external: true });
    expect(safeLink("http://facebook.com")).toBeNull();
    expect(safeLink("https://facebook.com.evil.io/x")).toBeNull();
    expect(safeLink("/reports/abc")).toEqual({ href: "/reports/abc", external: false });
  });
});

describe("the private memory", () => {
  it("keeps what they said about themselves, with dates", () => {
    const out = cleanMemory({ notes: [{ kind: "fact", topic: "trip", body: "You're off to Lisbon next week", on_date: "2026-11-24", follow_up_on: "2026-12-01" }, { kind: "style", topic: "length", body: "Likes it short", on_date: "", follow_up_on: "2026-12-01" }] });
    expect(out).toEqual([
      { kind: "fact", topic: "trip", body: "You're off to Lisbon next week", on_date: "2026-11-24", follow_up_on: "2026-12-01" },
      { kind: "style", topic: "length", body: "Likes it short", on_date: null, follow_up_on: null },
    ]);
  });
  it("never keeps secrets, health, beliefs or money troubles", () => {
    const out = cleanMemory({ notes: [
      { kind: "fact", topic: "other", body: "Your password is hunter2 for the portal" },
      { kind: "fact", topic: "other", body: "Your email is sam@example.com" },
      { kind: "fact", topic: "family", body: "Your diagnosis came back last week" },
      { kind: "fact", topic: "other", body: "You go to church on Sundays" },
      { kind: "fact", topic: "other", body: "You're worried about your debt" },
    ] });
    expect(out).toEqual([]);
  });
  it("drops repeats and unknown kinds, and keeps six at most", () => {
    const existing = [{ kind: "fact" as const, topic: "hobby", body: "You play padel" }];
    const many = Array.from({ length: 10 }, (_, i) => ({ kind: "fact", topic: "hobby", body: `Hobby number ${i}` }));
    expect(cleanMemory({ notes: [{ kind: "fact", topic: "hobby", body: "You play padel" }, { kind: "secret", topic: "x", body: "nope nope" }] }, existing)).toEqual([]);
    expect(cleanMemory({ notes: many })).toHaveLength(6);
  });
  it("only ever shows a person their own rows, an exec included", () => {
    const rows = [{ profile_id: "me", id: "1" }, { profile_id: "someone", id: "2" }];
    expect(ownMemory(rows, "me").map((r) => r.id)).toEqual(["1"]);
    expect(ownMemory(rows, "exec")).toEqual([]);
  });
  it("is never shared agent knowledge: nobody trains the assistant", () => {
    expect(canTrainAgent({ role: "executive", isExec: true }, "assistant")).toBe(false);
    expect(canTalkToAgent({ role: "graphic_designer", isExec: false }, "assistant")).toBe(true);
  });
});

const row = (p: Partial<MemoryRow>): MemoryRow => ({ id: "x", profile_id: "me", kind: "fact", topic: "other", body: "", on_date: null, follow_up_on: null, followed_up_at: null, ...p });

describe("the assistant's hello", () => {
  it("says happy birthday on the day (any year)", () => {
    const g = assistantGreeting({ name: "Sam", memory: [row({ topic: "birthday", body: "Your birthday", on_date: "1990-11-17" })], today: "2026-11-17" });
    expect(g.text).toMatch(/^Happy birthday, Sam!/);
  });
  it("asks how the trip went once it's due, and marks it asked", () => {
    const g = assistantGreeting({ name: "Sam", memory: [row({ id: "t1", topic: "trip", body: "the trip to Lisbon", follow_up_on: "2026-11-16" })], today: "2026-11-17" });
    expect(g).toEqual({ text: "Hey Sam! How was the trip to Lisbon?", followed: "t1" });
  });
  it("doesn't ask twice or early", () => {
    const asked = assistantGreeting({ name: "Sam", memory: [row({ topic: "trip", body: "the trip to Lisbon", follow_up_on: "2026-11-16", followed_up_at: "2026-11-16T12:00:00Z" })], today: "2026-11-17" });
    const early = assistantGreeting({ name: "Sam", memory: [row({ topic: "trip", body: "the trip to Lisbon", follow_up_on: "2026-11-20" })], today: "2026-11-17" });
    expect(asked.followed).toBeNull();
    expect(early.followed).toBeNull();
  });
  it("reads style first in the prompt", () => {
    const text = memoryForPrompt([row({ topic: "hobby", body: "Plays padel" }), row({ kind: "style", topic: "length", body: "Short answers" })], "2026-11-17");
    expect(text.indexOf("Short answers")).toBeLessThan(text.indexOf("Plays padel"));
  });
});

describe("the safety review", () => {
  it("flags only listed categories, with moments inside the call", () => {
    const r = parseSafetyReview({ flagged: true, categories: ["harassment", "made_up"], severity: "medium", summary: "Demeaning remarks about a colleague.", moments: [{ at_seconds: 95.4, category: "harassment", note: "remark" }, { at_seconds: 9999, category: "harassment", note: "late" }, { at_seconds: 5, category: "bogus", note: "x" }], distress: false }, 600);
    expect(r).toEqual({ flagged: true, categories: ["harassment"], severity: "medium", summary: "Demeaning remarks about a colleague.", moments: [{ at_seconds: 95, category: "harassment", note: "remark" }, { at_seconds: 600, category: "harassment", note: "late" }], distress: false });
  });
  it("never flags without a category, and a malformed answer flags nothing", () => {
    expect(parseSafetyReview({ flagged: true, categories: [] }).flagged).toBe(false);
    expect(parseSafetyReview(null)).toEqual({ flagged: false, categories: [], severity: null, summary: "", moments: [], distress: false });
  });
  it("treats distress as a flag that asks for support", () => {
    const r = parseSafetyReview({ flagged: true, categories: [], distress: true, severity: "none" });
    expect(r).toMatchObject({ flagged: true, categories: ["distress"], distress: true, severity: "low" });
  });
  it("times the transcript from the call's start", () => {
    expect(timedTranscript([{ who: "Sam", text: "hi", at: "2026-11-17T10:02:13Z" }], "2026-11-17T10:00:00Z")).toBe("[2:13] Sam: hi");
  });
});

describe("keeping call audio", () => {
  const at = new Date("2026-11-17T12:00:00Z");
  it("keeps flagged audio about 90 days, deletes the rest at once", () => {
    expect(audioDeleteAfter(true, at).toISOString()).toBe("2027-02-15T12:00:00.000Z");
    expect(audioDeleteAfter(false, at).toISOString()).toBe(at.toISOString());
  });
  it("deletes when due, and audio never reviewed after two days", () => {
    expect(audioDue({ endedAt: null, deleteAfter: "2026-11-17T11:00:00Z", deletedAt: null }, at)).toBe(true);
    expect(audioDue({ endedAt: null, deleteAfter: "2027-02-15T12:00:00Z", deletedAt: null }, at)).toBe(false);
    expect(audioDue({ endedAt: "2026-11-14T12:00:00Z", deleteAfter: null, deletedAt: null }, at)).toBe(true);
    expect(audioDue({ endedAt: "2026-11-16T12:00:00Z", deleteAfter: null, deletedAt: null }, at)).toBe(false);
    expect(audioDue({ endedAt: "2026-11-01T12:00:00Z", deleteAfter: "2026-11-01T12:00:00Z", deletedAt: "2026-11-01T12:00:00Z" }, at)).toBe(false);
  });
});

describe("hanging up on goodbye", () => {
  const run = (pieces: string[]) => {
    const f = endMarkerFilter();
    const out = pieces.map((p) => f.feed(p)).join("") + f.flush();
    return { out, ended: f.ended };
  };
  it("passes text through and holds nothing when there's no marker", () => {
    expect(run(["Sure, ", "the ROAS is two point four. [see] ok"])).toEqual({ out: "Sure, the ROAS is two point four. [see] ok", ended: false });
  });
  it("strips the marker and ends, even split across pieces", () => {
    expect(run(["Talk soon, Sam! ", "[[END", "_CALL]]"])).toEqual({ out: "Talk soon, Sam! ", ended: true });
    expect(run([`Bye!${END_MARKER} anything after`])).toEqual({ out: "Bye!", ended: true });
  });
  it("gives back a held tail that turned out not to be the marker", () => {
    expect(run(["Look at [[", "this"])).toEqual({ out: "Look at [[this", ended: false });
    expect(run(["Ends with [["])).toEqual({ out: "Ends with [[", ended: false });
  });
  it("strips a whole reply", () => {
    expect(stripEndMarker(`Bye now! ${END_MARKER}`)).toEqual({ text: "Bye now!", ended: true });
    expect(stripEndMarker("bye for now, but first the numbers")).toEqual({ text: "bye for now, but first the numbers", ended: false });
  });
});
