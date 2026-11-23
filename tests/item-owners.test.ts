import { describe, expect, it } from "vitest";
import { ladderKeyOf, leadItemTitle, lineOfItem, ownerOf, type OwnerContext } from "@/lib/item-owners-core";

const ctx = (o: Partial<OwnerContext> = {}): OwnerContext => ({
  overrides: new Map(),
  named: new Map(),
  seats: new Map([["acme", new Map([["meta_buyer", "buyer"], ["email_strategist", "strat"], ["social_manager", "smm"], ["google_buyer", "gbuyer"]])]]),
  roleHolder: new Map([["head_of_creative", "hoc"], ["onboarding_specialist", "onb"]]),
  ...o,
});
const item = (key: string, topic: string, title = "") => ({ key, stable: key, topic, title, clientId: "acme" });

describe("one item, one person", () => {
  it("the account's buyer owns 'Acme is in the red', by line", () => {
    expect(ownerOf(item("kpi:t1", "accounts", "Acme · Meta is off target"), "lead", ctx())).toBe("buyer");
    expect(ownerOf(item("kpi:t2", "accounts", "Acme · Google is off target"), "lead", ctx())).toBe("gbuyer");
    // The target's own owner wins over the seat
    expect(ownerOf(item("kpi:t1", "accounts", "Acme · Meta is off target"), "lead", ctx({ named: new Map([["kpi:t1", "kyle-buyer"]]) }))).toBe("kyle-buyer");
  });
  it("email, social and creative-performance items go to the client's seat on that line", () => {
    expect(ownerOf(item("email-score:acme", "email"), "x", ctx())).toBe("strat");
    expect(ownerOf(item("social-drop:acme", "social"), "x", ctx())).toBe("smm");
    expect(ownerOf(item("fatigue:acme:ad1", "ads"), "x", ctx())).toBe("buyer");
    expect(ownerOf(item("brief:s1", "briefs"), "x", ctx())).toBe("buyer");
  });
  it("the person a message or promise names owns it", () => {
    expect(ownerOf(item("owed:o1", "promises"), "lead", ctx({ named: new Map([["owed:o1", "mel"]]) }))).toBe("mel");
  });
  it("items a role owns outright", () => {
    expect(ownerOf({ key: "allot-behind:acme", stable: "allot-behind:acme", topic: "allotments", clientId: "acme" }, "x", ctx())).toBe("hoc");
    expect(ownerOf({ key: "intake:acme", stable: "intake:acme", topic: "onboarding", clientId: "acme" }, "x", ctx())).toBe("onb");
  });
  it("a transfer wins over everything, even one's own ticket", () => {
    const c = ctx({ overrides: new Map([["kpi:t1", "lead"], ["mine:ticket:9", "dana"]]) });
    expect(ownerOf(item("kpi:t1", "accounts", "Acme · Meta is off target"), "x", c)).toBe("lead");
    expect(ownerOf({ key: "mine:ticket:9", stable: "mine:ticket:9", topic: "mine" }, "me", c)).toBe("dana");
    expect(ownerOf({ key: "mine:ticket:10", stable: "mine:ticket:10", topic: "mine" }, "me", c)).toBe("me");
  });
  it("the same alert gathered for three people stays on exactly one of their days", () => {
    const people = ["buyer", "head_of_meta_person", "exec"];
    const keep = people.filter((p) => {
      const o = ownerOf(item("kpi:t1", "accounts", "Acme · Meta is off target"), p, ctx());
      return !o || o === p;
    });
    expect(keep).toEqual(["buyer"]);
  });
  it("nothing names an owner: it stays where its source put it", () => {
    expect(ownerOf({ key: "contact:c1", stable: "contact:c1", topic: "promises", clientId: null }, "x", ctx())).toBeNull();
  });
});

describe("the ladder's keys and the linked items", () => {
  it("maps recap keys to the ladder's", () => {
    expect(ladderKeyOf("mine:ticket:42")).toBe("ticket:42");
    expect(ladderKeyOf("email-ticket:7")).toBe("email:7");
    expect(ladderKeyOf("owed:abc")).toBe("owed:abc");
  });
  it("the lead's item is its own, worded about the teammate", () => {
    expect(leadItemTitle({ client: "Acme", what: "getting Meta back on target", owner: "Mel Crosson", hours: 50, kind: "kpi" })).toBe("Acme is in the red, and Mel hasn't acted in 50h");
    expect(leadItemTitle({ client: "Acme", what: "a reply to Dana", owner: "Mel Crosson", hours: 100 })).toBe("Acme: A reply to Dana, and Mel hasn't acted in 4 days");
  });
  it("reads an item's line", () => {
    expect(lineOfItem({ key: "kpi:t1", topic: "accounts", title: "Acme · TikTok is off target" })).toBe("tiktok");
    expect(lineOfItem({ key: "email-pace:acme", topic: "email" })).toBe("email");
  });
});
