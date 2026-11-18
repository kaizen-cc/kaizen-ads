import { describe, expect, it } from "vitest";
import { askedToSend, editDistance, resolveTeammate, soundKey, teammateTitle, type Teammate } from "@/lib/assistant/teammates";
import { clientLines, routeSeat, teamLines, type SeatHolder } from "@/lib/assistant/seat-routing";
import { askedForNote } from "@/lib/agent-call/ask-rules";
import { fillerFor, mentionsClient } from "@/lib/agent-call/tool-loop";
import { formatTranscript, orderLines, turnTimes } from "@/lib/agent-call/transcript";
import { forSpeech } from "@/lib/agent-call/speech-text";
import { asksToFileFeedback, awaitsOwner, feedbackPath, spokenFeedbackType } from "@/lib/feedback-logic";
import { atRiskClients, isRiskNote, riskNote, soundsLikeChurn } from "@/lib/client-risk";
import { byRetention } from "@/lib/today-lines-core";
import { clampDock, moved, nudge, parsePos, snapToEdge } from "@/lib/call-dock";
import { failedOnOurSide, rawEmail, reSubject, replyTo, slackPlace } from "@/lib/assistant/messages";
import { saidYes } from "@/lib/assistant/core";
import { ownerAskItem } from "@/lib/agent-call/next-items";

// The friction from real calls: sending to a teammate by a name heard imperfectly or a role on a client's lines,
// natural asks for a reminder, fillers that fit, the transcript in the order it was said, ROAS said as a word,
// feedback filed from a call, a client at risk, and the call widget that moves.

const team: Teammate[] = [
  { id: "1", fullName: "Rahul Mehta", role: "media_buyer" },
  { id: "2", fullName: "Dana Kim", role: "email_strategist" },
  { id: "3", fullName: "Dana Lopez", role: "customer_success" },
  { id: "4", fullName: "Kaitlyn Ross", role: "head_of_email" },
  { id: "5", fullName: "Steven Park", role: "copywriter" },
  { id: "6", fullName: "Old Timer", role: "media_buyer", isActive: false },
  { id: "me", fullName: "Santi Owner", role: "executive" },
];

describe("finding a teammate by name or role", () => {
  it("matches full names, first names and spoken variants", () => {
    expect(resolveTeammate("Rahul Mehta", team)).toMatchObject({ kind: "one", person: { id: "1" }, how: "name" });
    expect(resolveTeammate("rahul", team)).toMatchObject({ kind: "one", person: { id: "1" }, how: "first" });
    expect(resolveTeammate("Raul", team)).toMatchObject({ kind: "one", person: { id: "1" }, how: "sounds" });
    expect(resolveTeammate("Caitlin", team)).toMatchObject({ kind: "one", person: { id: "4" } });
    expect(resolveTeammate("Stephen", team)).toMatchObject({ kind: "one", person: { id: "5" } });
    expect(resolveTeammate("Mehta", team)).toMatchObject({ kind: "one", person: { id: "1" } });
  });
  it("asks back when two people fit, and finds none for a stranger", () => {
    expect(resolveTeammate("Dana", team).kind).toBe("several");
    expect(resolveTeammate("Dana K", team)).toMatchObject({ kind: "one", person: { id: "2" } });
    expect(resolveTeammate("Zebulon", team).kind).toBe("none");
  });
  it("skips inactive people and the person asking; finds a sole role holder", () => {
    expect(resolveTeammate("Old Timer", team).kind).toBe("none");
    expect(resolveTeammate("Santi", team, { exclude: "me" }).kind).toBe("none");
    expect(resolveTeammate("the head of email", team)).toMatchObject({ kind: "one", person: { id: "4" }, how: "role" });
  });
  it("folds names the way speech swaps them", () => {
    expect(soundKey("Rahul")).toBe(soundKey("Raul"));
    expect(soundKey("John")).toBe(soundKey("Jon"));
    expect(editDistance("kitten", "sitting")).toBe(3);
  });
  it("hears an ask to send, and titles each kind", () => {
    for (const t of ["ask Rahul for an update", "tell Dana the launch moved", "let the strategist know", "ping Steven", "yes, send it"]) expect(askedToSend(t), t).toBe(true);
    expect(teammateTitle("ask", "update on the Ocean Box launch")).toBe("Update on the Ocean Box launch?");
    expect(teammateTitle("fyi", "the client moved the shoot")).toBe("FYI: The client moved the shoot");
    expect(teammateTitle("task", "send the new offer.")).toBe("Send the new offer");
  });
});

describe("routing a hand-off through the client's lines and seats", () => {
  const seats: SeatHolder[] = [
    { seat: "meta_buyer", profileId: "b1", name: "Rahul Mehta", primary: true },
    { seat: "coordinator", profileId: "c1", name: "Dana Lopez", primary: true },
  ];
  const metaOnly = clientLines(["facebook-ads"], seats);
  it("knows a Meta-only client's lines", () => {
    expect(metaOnly).toEqual(["meta"]);
    expect(clientLines(["email-marketing", "facebook-ads"]).sort()).toEqual(["email", "meta"]);
  });
  it("the Media Buyer's 'strategist' or 'buyer' is the client's Meta buyer", () => {
    for (const words of ["the strategist", "the buyer", "the media buyer", "the Meta media buyer", "it should be on the Meta Media Buyer"])
      expect(routeSeat({ words, agentRole: "media_buyer", lines: metaOnly, seats }), words).toMatchObject({ kind: "seat", seat: "meta_buyer", holder: { profileId: "b1" } });
  });
  it("never routes to a line the client doesn't buy", () => {
    expect(routeSeat({ words: "the email strategist", agentRole: "media_buyer", lines: metaOnly, seats })).toMatchObject({ kind: "not_bought", line: "email" });
    expect(routeSeat({ words: "the strategist", agentRole: "email_strategist", lines: metaOnly, seats })).toMatchObject({ kind: "not_bought", line: "email" });
  });
  it("the account lead is the account manager on any client", () => {
    expect(routeSeat({ words: "the account lead", agentRole: "media_buyer", lines: metaOnly, seats })).toMatchObject({ kind: "seat", seat: "coordinator", holder: { profileId: "c1" } });
  });
  it("an empty seat falls to the next owner on the line, then the line's head", () => {
    const email = clientLines(["email-marketing"]);
    expect(routeSeat({ words: "the email builder", agentRole: null, lines: email, seats: [{ seat: "email_strategist", profileId: "s1", name: "Dana Kim" }] })).toMatchObject({ kind: "fallback", holder: { profileId: "s1" } });
    expect(routeSeat({ words: "the buyer", agentRole: "google_buyer", lines: clientLines(["google-ads"]), seats: [] })).toMatchObject({ kind: "fallback", seat: "google_buyer", holder: null, heads: ["head_of_google"] });
  });
  it("with no line known, it asks", () => {
    expect(routeSeat({ words: "someone", agentRole: null, lines: metaOnly, seats }).kind).toBe("unclear");
  });
  it("tells every agent the client's lines and seats, by role", () => {
    const block = teamLines("Ocean Box", metaOnly, seats);
    expect(block).toContain("Lines they buy: Meta ads");
    expect(block).toContain("Meta buyer: Rahul");
    expect(block).toContain("account manager: Dana");
  });
});

describe("asks and yeses, however they're said", () => {
  it("takes natural asks for a reminder", () => {
    for (const t of ["Make that an item for me today on my overview", "put it on my list", "add a task for me", "don't let me forget", "I need to remember to send the deck", "add that to my day", "remind me tomorrow"]) expect(askedForNote(t), t).toBe(true);
  });
  it("takes a short yes or a correction after a proposal", () => {
    for (const t of ["Yes, that'd be fine", "yeah that works", "it should be on the Meta media buyer", "No, the Meta buyer", "sure"]) expect(askedForNote(t), t).toBe(true);
    expect(askedForNote("no thanks")).toBe(false);
    expect(askedForNote("what's the ROAS on Crust?")).toBe(false);
    expect(saidYes("Yes, that'd be fine")).toBe(true);
    expect(saidYes("that works")).toBe(true);
  });
});

describe("fillers that fit", () => {
  it("says nothing for quick tools that fetch nothing", () => {
    expect(fillerFor([{ name: "remind_me", input: { client: "Crust Pizza" } }], { said: "remind me" })).toBeNull();
    expect(fillerFor([{ name: "open_screen", input: {} }, { name: "send_to_teammate", input: {} }], { said: "" })).toBeNull();
  });
  it("names the client only when this turn is about it", () => {
    expect(fillerFor([{ name: "account_metrics", input: { client: "Crust Pizza" } }], { said: "how's crust doing", seed: 0 })).toBe("One sec, pulling Crust Pizza's numbers.");
    expect(fillerFor([{ name: "account_metrics", input: { client: "Crust Pizza" } }], { said: "and the other one?", seed: 0 })).toBe("One sec, pulling the numbers.");
    expect(fillerFor([{ name: "get_client_context", input: { client: "Ocean Box" } }], { said: "", seed: 0 })).toBe("One sec, pulling that up.");
    expect(mentionsClient("what about ocean box", "Ocean Box Co")).toBe(true);
  });
  it("never repeats the same line twice in a row, and varies", () => {
    const calls = [{ name: "rank_clients", input: {} }];
    const first = fillerFor(calls, { said: "who's best", seed: 0 });
    for (let s = 0; s < 6; s++) expect(fillerFor(calls, { said: "who's best", seed: s, last: first })).not.toBe(first);
    expect(new Set([0, 1, 2, 3].map((s) => fillerFor(calls, { seed: s }))).size).toBeGreaterThan(2);
    for (let s = 0; s < 5; s++) expect(fillerFor(calls, { seed: s })).not.toMatch(/^Let me check\. Pulling/);
  });
  it("a write tool gets a plain line, not 'pulling'", () => {
    expect(fillerFor([{ name: "create_report", input: { client: "Crust Pizza" } }], { said: "build crust a report", seed: 0 })).not.toMatch(/pulling/i);
  });
});

describe("the transcript in the order it was said", () => {
  it("puts the person's line before the answer on the same instant", () => {
    const at = "2026-11-18T15:04:52.000Z";
    const out = orderLines([
      { at, who: "agent" as const, text: "The answer" },
      { at, who: "user" as const, text: "The question" },
    ]);
    expect(out.map((l) => l.text)).toEqual(["The question", "The answer"]);
    const file = formatTranscript({ startedAt: "2026-11-18T15:00:00.000Z", agentLabel: "Assistant", personName: "Santi", lines: [{ at, who: "agent", text: "Answer" }, { at, who: "user", text: "Question" }] });
    expect(file.indexOf("Santi: Question")).toBeLessThan(file.indexOf("Assistant: Answer"));
  });
  it("stamps the person's line when it was said and the answer after it", () => {
    const t = turnTimes(1_000, 5_000);
    expect(t.said).toBe(new Date(1_000).toISOString());
    expect(Date.parse(t.answered)).toBeGreaterThan(Date.parse(t.said));
    const same = turnTimes(5_000, 5_000);
    expect(Date.parse(same.answered)).toBeGreaterThan(Date.parse(same.said));
    expect(Date.parse(turnTimes(undefined, 9_000).said)).toBeLessThan(9_000);
  });
});

describe("ROAS said as one word", () => {
  it("respells it, never letter by letter", () => {
    expect(forSpeech("Their ROAS is 2.4.")).toBe("Their Roh-as is two point four.");
    expect(forSpeech("roas")).not.toMatch(/R O A S/);
  });
});

describe("feedback from a call", () => {
  it("reads what kind it is", () => {
    expect(spokenFeedbackType("report a bug: the KPI board won't load")).toBe("bug");
    expect(spokenFeedbackType("I have an idea for the Overview, it'd be great if it grouped by client")).toBe("idea");
    expect(spokenFeedbackType("it would be nice if reports had a dark cover")).toBe("idea");
    expect(spokenFeedbackType("the save button is broken on the brief")).toBe("bug");
    expect(spokenFeedbackType("I don't understand where the sprint lives")).toBe("confusing");
  });
  it("hears an ask to file it", () => {
    for (const t of ["submit feedback", "I want to report a bug", "I have an idea for the board", "can you log this issue"]) expect(asksToFileFeedback(t), t).toBe(true);
    expect(asksToFileFeedback("how's the Crust ROAS")).toBe(false);
  });
  it("routes a bug to the fix pipeline and an idea to the owner", () => {
    expect(feedbackPath("bug")).toMatchObject({ path: "fix", mode: "error" });
    expect(feedbackPath("confusing")).toMatchObject({ path: "fix" });
    expect(feedbackPath("idea")).toMatchObject({ path: "owner", mode: "cant" });
  });
  it("an Ask waits on the owner's Overview until it's handled", () => {
    expect(awaitsOwner({ status: "new", scope: "feature", lane: "review" })).toBe(true);
    expect(awaitsOwner({ status: "planned", scope: "feature", lane: "review" })).toBe(false);
    expect(awaitsOwner({ status: "new", scope: "feature", lane: "build" })).toBe(false);
    expect(awaitsOwner({ status: "new", scope: "small_bug", lane: "auto_fix" })).toBe(false);
    const item = ownerAskItem({ id: "g1", title: "Group by client", summary: "On the Overview", people: 2, createdAt: new Date().toISOString(), by: "Dana Kim" });
    expect(item).toMatchObject({ kind: "feedback", feedback: { groupId: "g1" }, why: "From Dana and 1 more: On the Overview" });
  });
});

describe("a client at risk", () => {
  it("keeps a dated note and reads the flag back", () => {
    const note = riskNote("probably canceling, pushing work off", "2026-11-18");
    expect(note).toBe("At risk (said Nov 18, 2026): probably canceling, pushing work off.");
    expect(isRiskNote(note)).toBe(true);
    expect(isRiskNote("At their request, we paused")).toBe(false);
    const now = Date.parse("2026-11-18T12:00:00Z");
    expect([...atRiskClients([{ client_id: "a", body: note, created_at: "2026-11-10T00:00:00Z" }, { client_id: "b", body: note, created_at: "2026-07-01T00:00:00Z" }], now)]).toEqual(["a"]);
  });
  it("hears it said", () => {
    expect(soundsLikeChurn("they're probably gonna be canceling as a client")).toBe(true);
    expect(soundsLikeChurn("they won't renew in January")).toBe(true);
    expect(soundsLikeChurn("cancel that meeting")).toBe(true);
    expect(soundsLikeChurn("how's their ROAS")).toBe(false);
  });
  it("moves the client's pressing work up the day", () => {
    const items = [
      { key: "k:a", topic: "ads", score: 70, client: "A", clientId: "a" },
      { key: "k:b", topic: "ads", score: 74, client: "B", clientId: "b" },
    ] as Parameters<typeof byRetention>[0];
    expect(byRetention(items).map((i) => i.clientId)).toEqual(["b", "a"]);
    expect(byRetention(items, new Set(["a"])).map((i) => i.clientId)).toEqual(["a", "b"]);
  });
});

describe("the call widget that moves", () => {
  const size = { w: 300, h: 60 };
  const view = { w: 1000, h: 800 };
  it("stays on screen", () => {
    expect(clampDock({ x: -50, y: 900 }, size, view)).toEqual({ x: 8, y: 732 });
    expect(clampDock({ x: 400, y: 300 }, size, view)).toEqual({ x: 400, y: 300 });
    expect(clampDock({ x: 10, y: 10 }, { w: 2000, h: 2000 }, view)).toEqual({ x: 8, y: 8 });
  });
  it("snaps the pill to the nearer side on phones", () => {
    const phone = { w: 390, h: 800 };
    const pill = { w: 200, h: 52 };
    expect(snapToEdge({ x: 20, y: 400 }, pill, phone)).toEqual({ x: 12, y: 400 });
    expect(snapToEdge({ x: 150, y: 400 }, pill, phone)).toEqual({ x: 178, y: 400 });
  });
  it("moves by keyboard, tells a tap from a drag, and reads a remembered spot", () => {
    expect(nudge({ x: 100, y: 100 }, "ArrowLeft")).toEqual({ x: 84, y: 100 });
    expect(nudge({ x: 100, y: 100 }, "ArrowDown", true)).toEqual({ x: 100, y: 164 });
    expect(nudge({ x: 100, y: 100 }, "Enter")).toBeNull();
    expect(moved({ x: 0, y: 0 }, { x: 2, y: 2 })).toBe(false);
    expect(moved({ x: 0, y: 0 }, { x: 6, y: 0 })).toBe(true);
    expect(parsePos('{"x":10,"y":20}')).toEqual({ x: 10, y: 20 });
    expect(parsePos("junk")).toBeNull();
    expect(parsePos(null)).toBeNull();
  });
});

describe("messages as the person", () => {
  it("finds a Slack thread from stored keys", () => {
    expect(slackPlace("C123ABC:1700000000.0001", "C123ABC:1690000000.0002")).toEqual({ channel: "C123ABC", thread: "1690000000.0002" });
    expect(slackPlace("C123ABC:1700000000.0001", null)).toEqual({ channel: "C123ABC", thread: "1700000000.0001" });
    expect(slackPlace("nonsense", null)).toBeNull();
  });
  it("replies in the email thread to the right person", () => {
    expect(reSubject("Launch plan")).toBe("Re: Launch plan");
    expect(reSubject("RE: Launch plan")).toBe("RE: Launch plan");
    expect(replyTo({ from: "Client <c@x.com>", to: "me@k.com" }, "me@k.com")).toBe("Client <c@x.com>");
    expect(replyTo({ from: "Me <me@k.com>", to: "c@x.com" }, "me@k.com")).toBe("c@x.com");
    const raw = Buffer.from(rawEmail({ from: "Me <me@k.com>", to: "c@x.com", subject: "Re: Plan\r\nBcc: evil@x.com", body: "Hi\nThere", inReplyTo: "<m1@x>", references: "<m0@x>" }).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    expect(raw).toContain("In-Reply-To: <m1@x>");
    expect(raw).toContain("References: <m0@x> <m1@x>");
    expect(raw).not.toMatch(/\r\nBcc:/);
    expect(raw).toContain("Hi\r\nThere");
  });
  it("a failure on our side keeps the yes; a 'not run' doesn't", () => {
    expect(failedOnOurSide({ sent: false, error: "Slack couldn't post it" })).toBe(true);
    expect(failedOnOurSide({ done: false, error: "boom" })).toBe(true);
    expect(failedOnOurSide({ done: false, note: "Not run: say in one sentence exactly what this will do and ask" })).toBe(false);
    expect(failedOnOurSide({ sent: true })).toBe(false);
  });
});
