import { describe, expect, it } from "vitest";
import { gate, workLine, type Directory, type Person } from "@/lib/item-gate-core";

// Owner, Nov 26 2026: "the OS only assigns things that are relevant to their role and their client". The head of
// social had eight routine items, all for clients he isn't on and none of them social. These are his eight.

const peter: Person = { id: "peter", name: "Peter", role: "head_of_social", isExec: false };
const dir: Directory = {
  people: [
    { id: "peter", name: "Peter", role: "head_of_social", isExec: false },
    { id: "niro", name: "Niro", role: "email_strategist", isExec: false },
    { id: "andres", name: "Andres", role: "email_builder", isExec: false },
    { id: "lucas", name: "Lucas", role: "media_buyer", isExec: false },
    { id: "rahul", name: "Rahul", role: "media_buyer", isExec: false },
    { id: "dipesh", name: "Dipesh", role: "head_of_meta", isExec: false },
    { id: "sultan", name: "Sultan", role: "head_of_google", isExec: false },
    { id: "jazem", name: "Jazem", role: "video_editor", isExec: false },
    { id: "jesus", name: "Jesus", role: "head_of_creative", isExec: false },
    { id: "kyle", name: "Kyle", role: "executive", isExec: true, focus: ["meta", "google", "tiktok", "creative_performance"] },
    { id: "santi", name: "Santi", role: "executive", isExec: true, focus: ["email"] },
    { id: "fabi", name: "Fabi", role: "tracking_specialist", isExec: false },
  ],
  webOwnerId: "kyle",
};
const seat = (seat: string, profileId: string, name: string) => ({ seat, profileId, name, primary: true });
const femme = { services: ["email-marketing"], seats: [seat("email_strategist", "niro", "Niro"), seat("email_builder", "andres", "Andres")] };
const granite = { services: ["facebook-ads", "google-ads", "crm"], seats: [seat("meta_buyer", "lucas", "Lucas"), seat("google_buyer", "sultan", "Sultan")] };
const seventh = { services: ["facebook-ads", "creative"], seats: [seat("meta_buyer", "rahul", "Rahul")] };
const rowan = { services: ["facebook-ads", "creative"], seats: [seat("meta_buyer", "lucas", "Lucas")] };
const goodmellow = { services: ["email-marketing", "facebook-ads", "creative"], seats: [seat("meta_buyer", "dipesh", "Dipesh"), seat("email_strategist", "niro", "Niro")] };
const shupe = { services: ["facebook-ads", "creative"], seats: [seat("meta_buyer", "lucas", "Lucas"), seat("video_editor", "jazem", "Jazem")] };
const social = { services: ["social-media"], seats: [seat("social_manager", "peter", "Peter")] };

const routed = (g: ReturnType<typeof gate>) => (g.verdict === "route" ? g.toId : g.verdict);

describe("the relevance gate (Peter's eight items)", () => {
  it("FEMME LA discount rules and the BFCM SMS question are email work: Niro's, not the head of social's", () => {
    expect(routed(gate({ person: peter, text: "Confirm FEMME LA discount rules for abandoned cart. Client wants the 10% off dropped; email team is waiting", client: femme, dir }))).toBe("niro");
    expect(routed(gate({ person: peter, text: "Answer FEMME LA discount question (do tonight). The BFCM SMS goes out from the 27th", client: femme, dir }))).toBe("niro");
  });
  it("paid work goes to the client's buyer", () => {
    expect(routed(gate({ person: peter, text: "Review Granite-Plus cost per lead at double target. Cost per lead was $132.84 against a $60 target on $531 spend", client: granite, dir }))).toBe("lucas");
    expect(routed(gate({ person: peter, text: "Reply to Meta rep question on aesthetics account", client: seventh, dir }))).toBe("rahul");
    expect(routed(gate({ person: peter, text: "Confirm Meta verification is complete", client: rowan, dir }))).toBe("lucas");
    expect(routed(gate({ person: peter, text: "Fix Goodmellow promo end date and offer. Client says ads show 4 for $60", client: goodmellow, dir }))).toBe("dipesh");
  });
  it("an ad script is creative work: the client's video editor", () => {
    expect(routed(gate({ person: peter, text: "Send Shupe Legal the full script", client: shupe, dir }))).toBe("jazem");
  });
  it("keeps what is theirs", () => {
    expect(routed(gate({ person: peter, text: "Plan next week's organic posts", client: social, dir }))).toBe("keep");
    expect(routed(gate({ person: dir.people[3], text: "Review cost per lead", client: granite, dir }))).toBe("keep");
    // A line head covers every client buying the line; an exec their focus lines
    expect(routed(gate({ person: dir.people[5], text: "Fix the Meta campaign budget", client: granite, dir }))).toBe("keep");
    expect(routed(gate({ person: dir.people[10], text: "Answer the BFCM email question", client: femme, dir }))).toBe("keep");
    expect(routed(gate({ person: dir.people[9], text: "Confirm Meta verification is complete", client: rowan, dir }))).toBe("keep");
  });
  it("an exec outside their focus, and someone on the line but not on the client, are routed to the seat", () => {
    expect(routed(gate({ person: dir.people[9], text: "Answer the BFCM email question", client: femme, dir }))).toBe("niro");
    expect(routed(gate({ person: dir.people[4], text: "Review cost per lead", client: granite, dir }))).toBe("lucas");
  });
  it("a line the client doesn't buy is nobody's; unclear work off their clients is dropped; no client is theirs", () => {
    expect(gate({ person: peter, text: "Launch the TikTok ads", client: femme, dir }).verdict).toBe("drop");
    expect(gate({ person: peter, text: "Check in with the client", client: femme, dir }).verdict).toBe("drop");
    expect(gate({ person: peter, text: "Prep the team meeting", client: null, dir }).verdict).toBe("keep");
  });
  it("tracking, web and no-seat lines go to their owner", () => {
    expect(routed(gate({ person: peter, text: "Check the pixel fires on purchase", client: granite, dir }))).toBe("fabi");
    expect(routed(gate({ person: peter, text: "Remove the summer promotions from the website", client: granite, dir }))).toBe("kyle");
    // Rowan dropped Google: its Google work is nobody's
    expect(gate({ person: peter, text: "Pause the Google campaigns", client: rowan, dir }).verdict).toBe("drop");
  });
  it("reads the line from the words", () => {
    expect(workLine("Share the Google Doc with the recap", ["meta"])).toBeNull();
    expect(workLine("CPL is up 40%", ["google"])).toBe("google");
    expect(workLine("Schedule the Klaviyo flow")).toBe("email");
  });
});
