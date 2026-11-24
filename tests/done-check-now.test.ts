import { describe, expect, it } from "vitest";
import { inScope, pickForNow, summarize, NOW_CAP, type NowItem } from "@/lib/done-check-now-core";

const item = (o: Partial<NowItem>): NowItem => ({ key: "ask:1", kind: "ask", ownerId: "me", ownerRole: "media_buyer", client: "Limelight Entertainment", title: "Send the October report", since: "2026-11-10T00:00:00Z", ...o });
const buyer = { id: "me", role: "media_buyer", isExec: false, isLead: false };
const head = { id: "h", role: "head_of_meta", isExec: false, isLead: true };
const exec = { id: "x", role: "executive", isExec: true, isLead: false };
const leadOf = { media_buyer: "head_of_meta", google_buyer: "head_of_google" };

describe("whose items an on-demand check reads (Nov 24 2026)", () => {
  it("your own by default, never someone else's", () => {
    expect(inScope(item({}), buyer, { scope: "mine" })).toBe(true);
    expect(inScope(item({ ownerId: "other" }), buyer, { scope: "mine" })).toBe(false);
    // Asking for the team doesn't widen it for someone who leads nobody
    expect(inScope(item({ ownerId: "other" }), buyer, { scope: "team", leadOf })).toBe(false);
  });
  it("a lead's team is the people under them; an exec's is everyone", () => {
    expect(inScope(item({ ownerId: "b2", ownerRole: "media_buyer" }), head, { scope: "team", leadOf })).toBe(true);
    expect(inScope(item({ ownerId: "g1", ownerRole: "google_buyer" }), head, { scope: "team", leadOf })).toBe(false);
    expect(inScope(item({ ownerId: "anyone", ownerRole: "email_builder" }), exec, { scope: "team", leadOf })).toBe(true);
  });
  it("unowned tracking items belong to the Tracking Specialist", () => {
    const t = { id: "t", role: "tracking_specialist", isExec: false, isLead: false };
    expect(inScope(item({ kind: "notrack", ownerId: null }), t, { scope: "mine" })).toBe(true);
    expect(inScope(item({ kind: "notrack", ownerId: null }), buyer, { scope: "mine" })).toBe(false);
  });
  it("a named client or item narrows it", () => {
    expect(inScope(item({}), buyer, { scope: "mine", client: "limelight" })).toBe(true);
    expect(inScope(item({}), buyer, { scope: "mine", client: "OceanBox" })).toBe(false);
    expect(inScope(item({}), buyer, { scope: "mine", about: "is the October report done yet" })).toBe(true);
    expect(inScope(item({}), buyer, { scope: "mine", about: "landing page" })).toBe(false);
  });
});

describe("how many, and in what order", () => {
  it("the oldest first, capped; the rest say they wait", () => {
    const many = Array.from({ length: NOW_CAP + 5 }, (_, n) => item({ key: `ask:${n}`, since: `2026-11-${String(10 + (n % 15)).padStart(2, "0")}T00:00:00Z` }));
    const { now, later } = pickForNow(many);
    expect(now).toHaveLength(NOW_CAP);
    expect(later).toBe(5);
    expect(now[0].since <= now[now.length - 1].since).toBe(true);
  });
});

describe("the answer", () => {
  it("closed with the quote, where it was said and a reopen key; moving and nothing apart", () => {
    const s = summarize(
      [
        { key: "said:1", kind: "said", client: "OceanBox", title: "You said you'd send the warm-up", state: "done", quote: "Warm-up email is live", source: "slack_internal", link: "https://x", at: "2026-11-23T10:00:00Z" },
        { key: "ask:2", kind: "ask", client: "OceanBox", title: "Box statics", state: "moving", quote: "Working on it today", source: "gmail", link: null, at: "2026-11-23T11:00:00Z" },
        { key: "owed:3", kind: "owed", client: "Team", title: "Reply to Hugo", state: "nothing", quote: "", source: null, link: null, at: null },
      ],
      2,
    );
    expect(s.closed).toHaveLength(1);
    expect(s.closed[0]).toMatchObject({ reopen: "said:1", quote: "Warm-up email is live", where: "internal Slack", said: "2026-11-23" });
    expect(s.moving[0].where).toBe("email");
    expect(s.nothing_found).toHaveLength(1);
    expect(s.still_to_check).toBe(2);
    expect(s.note).toContain("2 more wait");
  });
});
