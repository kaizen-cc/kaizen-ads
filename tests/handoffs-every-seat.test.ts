import { describe, expect, it } from "vitest";
import { HANDOFF_SEATS, headOf, movedLine, seatJob, workFor } from "@/lib/handoff-roles";
import { byChannel, leavesExternal, planSlackSeats, type ClientSeats, type Members } from "@/lib/slack-seats-core";
import { SLOTS } from "@/lib/roles";

describe("a handoff for every seat", () => {
  it("covers every seat a client has, each with its job and its line's head", () => {
    for (const s of SLOTS) {
      expect(HANDOFF_SEATS).toContain(s.value);
      expect(seatJob(s.value).job.length).toBeGreaterThan(10);
      expect(headOf(s.value)).toMatch(/^head_of_/);
    }
    expect(headOf("video_editor")).toBe("head_of_creative");
    expect(headOf("email_builder")).toBe("head_of_email");
  });

  it("moves the work that belongs to the seat", () => {
    const keys = (r: string) => workFor(r).map((w) => w.key);
    expect(keys("meta_buyer")).toEqual(expect.arrayContaining(["kpis", "tickets", "sprints", "held", "promises", "owed"]));
    expect(keys("google_buyer")).toContain("kpis");
    expect(workFor("google_buyer").find((w) => w.key === "kpis")!.open).toMatchObject({ platform: "google" });
    expect(workFor("graphic_designer").find((w) => w.key === "tickets")!.column).toBe("creative_id");
    expect(keys("email_strategist")).toEqual(expect.arrayContaining(["email_tickets", "email_sprints", "email_targets"]));
    expect(keys("email_designer")).not.toContain("email_sprints");
    expect(keys("social_manager")).toEqual(expect.arrayContaining(["social_sprints", "social_targets"]));
    // Work shared across seats only moves when the old person keeps no other seat on the client
    expect(workFor("video_editor").filter((w) => w.shared).map((w) => w.key).sort()).toEqual(["owed", "promises", "tasks"]);
  });

  it("says what moved in words", () => {
    expect(movedLine("email_strategist", { email_tickets: 3, email_sprints: 1, promises: 0 })).toEqual(["3 open email tickets", "the email sprint"]);
    expect(movedLine("meta_buyer", {})).toEqual([]);
  });
});

describe("Slack access follows the seat", () => {
  const people = [
    { profileId: "a", name: "Ana", slackId: "UA" },
    { profileId: "b", name: "Bo", slackId: "UB" },
    { profileId: "c", name: "Cy", slackId: null },
  ];
  const clients: ClientSeats[] = [
    { clientId: "1", client: "Limelight", internal: "CI1", external: "CE1", people },
    { clientId: "2", client: "OceanBox", internal: null, external: "CE2", people: [people[0]] },
    { clientId: "3", client: "Empty", internal: "CI3", external: "CE3", people: [] },
  ];
  const members = new Map<string, Members>([
    ["CI1", { ok: true, ids: new Set(["UA", "UB"]) }],
    ["CE1", { ok: true, ids: new Set(["UA"]) }],
    ["CE2", { ok: false, why: "The Kaizen OS bot isn't in this channel" }],
  ]);

  it("invites who's missing, and says what can't be fixed", () => {
    const r = planSlackSeats(clients, members);
    expect(r.invites).toEqual([expect.objectContaining({ client: "Limelight", kind: "external", channel: "CE1", name: "Bo", slackId: "UB" })]);
    expect(r.inPlace).toBe(3);
    expect(r.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ client: "OceanBox", kind: "internal", why: expect.stringMatching(/No internal Slack channel/) }),
        expect.objectContaining({ client: "OceanBox", kind: "external", why: expect.stringMatching(/bot isn't in/) }),
        expect.objectContaining({ name: "Cy", why: expect.stringMatching(/No Slack user/) }),
      ]),
    );
    // A client with nobody assigned isn't checked
    expect(r.problems.some((p) => p.client === "Empty")).toBe(false);
  });

  it("groups invites per channel", () => {
    const g = byChannel([
      { clientId: "1", client: "L", kind: "external", channel: "C1", profileId: "a", name: "A", slackId: "UA" },
      { clientId: "1", client: "L", kind: "external", channel: "C1", profileId: "b", name: "B", slackId: "UB" },
      { clientId: "1", client: "L", kind: "internal", channel: "C2", profileId: "a", name: "A", slackId: "UA" },
    ]);
    expect(g.map((x) => [x.channel, x.invites.length])).toEqual([
      ["C1", 2],
      ["C2", 1],
    ]);
  });

  it("someone leaving their last seat leaves the client's channel; leaders stay", () => {
    expect(leavesExternal(0, false)).toBe(true);
    expect(leavesExternal(1, false)).toBe(false);
    expect(leavesExternal(0, true)).toBe(false);
  });
});
