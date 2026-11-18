import { describe, expect, it } from "vitest";
import { briefLabel, deliverables, detectUrgency, dueWord, mergeDuplicates, promiseBody, promiseTitle, routeCommitment, sameMeeting, samePromise, type CallRow, type Commitment, type Person, type Seat } from "@/lib/promise-routing-core";

const NOW = Date.parse("2026-11-18T17:00:00Z");
const gemini: CallRow = { id: "c1", clientId: "sierra", title: "Sierra Dream Ad Hawk", occurredAt: "2026-11-18T16:00:00Z", attendees: ["exec@k.co", "head@k.co"], host: "exec@k.co", source: "gemini" };
const fireflies: CallRow = { id: "c2", clientId: "sierra", title: "Ad Hawk sync", occurredAt: "2026-11-18T16:20:00Z", attendees: ["exec@k.co"], host: "exec@k.co", source: "fireflies" };
const due = "2026-11-19T21:00:00Z";
const cm = (id: string, callId: string, what: string, extra: Partial<Commitment> = {}): Commitment => ({ id, callId, clientId: "sierra", kind: "creative", what, why: null, dueAt: due, routed: false, ...extra });

describe("same meeting recorded twice", () => {
  it("matches overlapping calls of one client, and not far apart or other clients", () => {
    expect(sameMeeting(gemini, fireflies)).toBe(true);
    expect(sameMeeting(gemini, { ...fireflies, occurredAt: "2026-11-18T19:00:00Z" })).toBe(false);
    expect(sameMeeting(gemini, { ...fireflies, clientId: "other", title: "Other thing", attendees: ["z@z.co"], host: "z@z.co" })).toBe(false);
  });
  it("matches by title or people when the client is unmatched on one", () => {
    expect(sameMeeting({ ...gemini, clientId: null }, { ...fireflies, clientId: null, title: "sierra dream ad hawk" })).toBe(true);
    expect(sameMeeting({ ...gemini, clientId: null, title: "x" }, { ...fireflies, clientId: null, title: "y", attendees: ["exec@k.co", "head@k.co"] })).toBe(true);
  });
  it("merges the same promise worded differently, keeping the richer one", () => {
    const a = cm("a", "c1", "Make 1 video and 5 statics to close BFCM", { why: "Urgent: Sierra Dreams wants to close BFCM strong" });
    const b = cm("b", "c2", "Create one video and five static images");
    const m = mergeDuplicates([gemini, fireflies], [a, b]);
    expect(m).toHaveLength(1);
    expect(m[0].keep).toBe("a");
    expect(m[0].drop).toBe("b");
    expect(m[0].why).toMatch(/close BFCM/);
  });
  it("keeps the one already told, and never merges within one note or different work", () => {
    const told = cm("t", "c1", "1 video and 5 images", { routed: true });
    const late = cm("l", "c2", "1 video and 5 images with the BFCM offer on them", { why: "closing BFCM" });
    const m = mergeDuplicates([gemini, fireflies], [told, late]);
    expect(m[0].keep).toBe("t");
    expect(m[0].what).toMatch(/BFCM offer/);
    expect(mergeDuplicates([gemini, fireflies], [cm("x", "c1", "2 videos"), cm("y", "c1", "2 videos")])).toHaveLength(0);
    expect(mergeDuplicates([gemini, fireflies], [cm("x", "c1", "3 videos"), cm("y", "c2", "10 images")])).toHaveLength(0);
    expect(samePromise({ kind: "launch", what: "Point Meta campaigns to the new landing page" }, { kind: "launch", what: "Redirect Meta campaigns to new landing page" })).toBe(true);
  });
});

describe("urgency", () => {
  it("is due within 48 hours, words, or an exec asking", () => {
    expect(detectUrgency({ what: "1 video", dueAt: due }, { now: NOW }).urgent).toBe(true);
    expect(detectUrgency({ what: "A reel", dueAt: "2026-11-30T00:00:00Z" }, { now: NOW }).urgent).toBe(false);
    expect(detectUrgency({ what: "A reel asap", dueAt: "2026-11-30T00:00:00Z" }, { now: NOW }).urgent).toBe(true);
    expect(detectUrgency({ what: "5 statics", why: "the sale ends Friday", dueAt: "2026-11-30T00:00:00Z" }, { now: NOW }).reasons).toContain("said to be urgent");
    expect(detectUrgency({ what: "A reel", dueAt: "2026-11-30T00:00:00Z" }, { now: NOW, execAsked: true }).urgent).toBe(true);
    expect(detectUrgency({ what: "5 statics for the sale", dueAt: "2026-11-30T00:00:00Z" }, { now: NOW, notes: "It is urgent that we ship the 5 statics for the sale." }).urgent).toBe(true);
  });
});

describe("routing", () => {
  const people: Person[] = [
    { id: "hoc", role: "head_of_creative", isExec: false, email: "hoc@k.co" },
    { id: "hog", role: "head_of_google", isExec: false, email: "hog@k.co" },
    { id: "hom", role: "head_of_meta", isExec: false, email: "hom@k.co" },
    { id: "ex1", role: "executive", isExec: true, email: "exec@k.co" },
    { id: "ex2", role: "executive", isExec: true, email: "ex2@k.co" },
    { id: "des", role: "graphic_designer", isExec: false, email: "des@k.co" },
    { id: "buyer", role: "media_buyer", isExec: false, email: "buyer@k.co" },
    { id: "gbuy", role: "google_buyer", isExec: false, email: "gbuy@k.co" },
    { id: "es", role: "email_strategist", isExec: false, email: "es@k.co" },
  ];
  const seats: Seat[] = [
    { profile_id: "des", role: "graphic_designer" },
    { profile_id: "vid", role: "video_editor" },
    { profile_id: "buyer", role: "meta_buyer" },
    { profile_id: "gbuy", role: "google_buyer" },
    { profile_id: "es", role: "email_strategist" },
  ];
  const base = { seats, people, urgent: false, attendeeEmails: ["exec@k.co"], hostEmail: "exec@k.co" };
  it("creative goes to the head of creative and the client's makers, not execs or the other heads", () => {
    const r = routeCommitment({ kind: "creative", what: "1 video + 5 statics" }, base);
    expect([...r.to].sort()).toEqual(["des", "hoc", "vid"]);
  });
  it("urgent creative adds the buyer, never the execs (even ones in the meeting)", () => {
    const r = routeCommitment({ kind: "creative", what: "5 statics" }, { ...base, urgent: true });
    expect(r.to).toContain("buyer");
    expect(r.to).not.toContain("ex1");
    expect(r.to).not.toContain("ex2");
    expect(r.to).not.toContain("hog");
  });
  it("launch goes to that platform's buyer, and the line head only when urgent", () => {
    expect(routeCommitment({ kind: "launch", what: "Launch the Google search campaign" }, base).to).toEqual(["gbuy"]);
    expect(routeCommitment({ kind: "launch", what: "Launch the Google search campaign" }, { ...base, urgent: true }).to).toEqual(expect.arrayContaining(["gbuy", "hog"]));
    expect(routeCommitment({ kind: "launch", what: "Raise Meta budgets" }, base).to).toEqual(["buyer"]);
  });
  it("email work goes to the email strategist; strategy to the buyers; the promise maker also gets it", () => {
    expect(routeCommitment({ kind: "strategy", what: "Send the SMS flow plan" }, base).to).toEqual(["es"]);
    expect([...routeCommitment({ kind: "strategy", what: "Review the account" }, base).to].sort()).toEqual(["buyer", "gbuy"]);
    const r = routeCommitment({ kind: "launch", what: "Raise Meta budgets" }, { ...base, hostEmail: "hom@k.co" });
    expect(r.to).toEqual(["buyer", "hom"]);
  });
  it("falls back to the line head when nobody holds the seat", () => {
    expect(routeCommitment({ kind: "launch", what: "Raise Meta budgets" }, { ...base, seats: [] }).to).toEqual(["hom"]);
  });
});

describe("notice text", () => {
  it("reads deliverables", () => {
    expect(deliverables("1 video and 5 statics")).toEqual([
      { n: 1, noun: "video" },
      { n: 5, noun: "image" },
    ]);
    expect(deliverables("one video and five static images")).toEqual([
      { n: 1, noun: "video" },
      { n: 5, noun: "image" },
    ]);
  });
  it("makes a specific title", () => {
    expect(promiseTitle({ client: "Sierra Dreams", what: "Make 1 video and 5 statics to close BFCM", dueAt: due }, NOW)).toBe("Sierra Dreams: 1 video + 5 images to close BFCM, due tomorrow");
    expect(promiseTitle({ client: "Acme", what: "Raise the Meta prospecting budget", dueAt: "2026-11-18T22:00:00Z" }, NOW)).toBe("Acme: Raise the Meta prospecting budget, due today");
    expect(promiseTitle({ client: "Acme", what: "A — dash", dueAt: due }, NOW)).not.toMatch(/[—–]/);
  });
  it("labels the brief and writes a body with why and the call link", () => {
    expect(briefLabel({ client: "Sierra Dreams", what: "1 video and 5 statics to close BFCM" })).toBe("Sierra Dreams BFCM close (1 video, 5 images)");
    const b = promiseBody({ what: "1 video", why: "They want to close BFCM", callTitle: "Sierra Dream Ad Hawk", callAt: "2026-11-18T16:00:00Z", callUrl: "https://meet.example/x", reasons: ["due within 48 hours"], briefReady: true });
    expect(b).toContain("Why: They want to close BFCM.");
    expect(b).toContain("https://meet.example/x");
    expect(b).toContain("brief is ready");
    expect(dueWord(due, NOW)).toBe("tomorrow");
  });
});

import { delegateCandidates, delegatedDetail, delegatedTitle, delegationState, itemRef } from "@/lib/delegate-core";

describe("delegating an item", () => {
  const team = [
    { id: "hoc", name: "Head Creative", role: "head_of_creative" },
    { id: "d1", name: "Ana Designer", role: "graphic_designer" },
    { id: "d2", name: "Zed Designer", role: "graphic_designer" },
    { id: "v1", name: "Vic Editor", role: "video_editor" },
    { id: "b1", name: "Bo Buyer", role: "media_buyer" },
  ];
  it("offers the roles under the delegator, the client's seats first, never themselves", () => {
    const c = delegateCandidates({ id: "hoc", role: "head_of_creative", isExec: false }, team, ["v1"]);
    expect(c.map((p) => p.id)).toEqual(["v1", "d1", "d2"]);
    expect(c[0].onClient).toBe(true);
    expect(delegateCandidates({ id: "x", role: "executive", isExec: true }, team).length).toBe(5);
  });
  it("credits the delegator and keeps no dashes", () => {
    expect(delegatedTitle("Dana", "Brief ready: Sierra Dreams BFCM close (1 video, 5 images)")).toBe("Dana: Brief: Sierra Dreams BFCM close (1 video, 5 images)");
    expect(delegatedDetail({ from: "Dana", note: "use the — BFCM offer" })).not.toMatch(/—/);
  });
  it("shows Delegated to while open and clears once done", () => {
    const ref = itemRef("promise", "abc");
    const row = (status: string) => [{ id: "k", source_ref: ref, status, ownerName: "Ana Designer" }];
    expect(delegationState(ref, row("open"))).toEqual({ hide: false, label: "Delegated to Ana Designer" });
    expect(delegationState(ref, row("done"))).toEqual({ hide: true, label: null });
    expect(delegationState(ref, [])).toEqual({ hide: false, label: null });
  });
});
