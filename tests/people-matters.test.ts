import { describe, expect, it } from "vitest";
import { isPeopleMatter, scrubPeopleMatters, withoutPeopleMatters } from "@/lib/people-matters";

// Owner, Nov 24 2026: management talk about a person on the team (from exec calls or meeting notes) never becomes a
// task, an item or a note that person or the team can see.

describe("management talk about people never becomes work", () => {
  it("catches performance, hiring and firing, pay, health and personal matters", () => {
    for (const t of [
      "The designer has been underperforming on revisions",
      "We should put him on a PIP",
      "Her performance review is next week",
      "Talk about letting her go if it doesn't improve: let her go by Friday",
      "Start hiring to replace him next month",
      "Discuss a raise for the video editor",
      "She's on sick leave this week, medical issue",
      "He's dealing with a family emergency",
      "Burnout risk on the creative team, mental health check-in",
      "Give a written warning about missed deadlines",
    ])
      expect(isPeopleMatter(t), t).toBe(true);
  });

  it("leaves the work itself alone", () => {
    for (const t of [
      "Make 3 new UGC ads for the brunch offer",
      "The client said performance is down on Meta; refresh creatives",
      "The retargeting ad set is underperforming; cut it",
      "Replace the hero image with the new menu, replace them with 4:5 versions",
      "Launch the Black Friday campaign with a 20% offer",
      "Raise the daily budget to $150",
      "Darling Psychology wants mental health awareness ads for December",
      "Holland Law's divorce consultation campaign launches Monday",
      "Performance review of the Q3 campaigns with the client on Friday",
      "The salary range in the client's hiring ad is $60k",
      "The lead forms work but they underperform on cost per lead",
      "Wellness members track their health and her pay plan is monthly",
    ])
      expect(isPeopleMatter(t), t).toBe(false);
  });

  it("takes the sentence out and keeps the rest", () => {
    expect(scrubPeopleMatters("We agreed on the new offer. The editor is underperforming and may need a PIP. Launch Monday.")).toBe("We agreed on the new offer. Launch Monday.");
    expect(withoutPeopleMatters(["Refresh the ads", "Discuss his salary"])).toEqual(["Refresh the ads"]);
  });
});

import { blockedForPeople } from "@/lib/people-matters";
import { closedNote } from "@/lib/done-check-core";

describe("people matters never become work for anyone (Nov 24 2026)", () => {
  it("blocks a generated item that's a people matter, flagged personnel, or owned by the person it's about", () => {
    expect(blockedForPeople({ text: "Put him on a PIP after the Granite delays" })).toBe(true);
    expect(blockedForPeople({ text: "Follow up with the client", personnel: true })).toBe(true);
    expect(blockedForPeople({ text: "Hand over Limelight's handoff doc", ownerName: "Matheus", about: ["Matheus"] })).toBe(true);
    expect(blockedForPeople({ text: "Hand over Limelight's handoff doc", ownerName: "Lucas Moreira", about: ["Matheus"] })).toBe(false);
    // Ad work isn't a people matter
    expect(blockedForPeople({ text: "The ad set is underperforming: cut the budget" })).toBe(false);
  });
  it("a done-check close never quotes a people matter", () => {
    expect(closedNote("We're letting him go on Friday", "slack_internal", "2026-11-24T15:00:00Z")).not.toMatch(/letting him go/);
    expect(closedNote("Tracking is set up and verified", "slack_internal", "2026-11-24T15:00:00Z")).toContain("Tracking is set up");
  });
});
