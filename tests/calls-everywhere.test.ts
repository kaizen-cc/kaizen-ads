import { describe, expect, it } from "vitest";
import { CALL_ROLES, contextPrompt, fitWithin, lookPlan, looksLikeLook, parseCallContext, roleForReport, roleForService, roleForThread, screenFileName } from "@/lib/agent-call/call-context";
import { audioExt, audioPartPath, DEFAULT_VOICES } from "@/lib/agent-call/core";
import { ASK_TTL_MS, askLine, liveAsk } from "@/lib/agent-call/connector-ask";
import { ROLE_SKILLS, canTalkToAgent, canTrainAgent } from "@/lib/agent-access";
import { lineOfRole } from "@/lib/agent-lines";
import { SPECIALISTS, suggestSpecialist } from "@/lib/assistant/core";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("the context a Call button passes", () => {
  it("keeps ids that look like ids and a short screen name", () => {
    expect(parseCallContext({ screen: "Kaizen AI", threadId: ID, clientId: ID.toUpperCase(), client: "Crust Pizza" })).toEqual({ screen: "Kaizen AI", threadId: ID, clientId: ID, client: "Crust Pizza" });
  });
  it("drops anything else", () => {
    const c = parseCallContext({ screen: "<script>x</script> report", reportId: "1; drop table", extra: "nope" });
    expect(c).toEqual({ screen: "scriptx/script report" });
    expect(parseCallContext(null)).toBeNull();
    expect(parseCallContext("Kaizen AI")).toBeNull();
    expect(parseCallContext({})).toBeNull();
    expect(parseCallContext({ screen: "x".repeat(300) })?.screen.length).toBe(80);
  });
});

describe("which agent a button reaches", () => {
  it("goes by the service tab on the client page", () => {
    expect(roleForService("meta")).toBe("media_buyer");
    expect(roleForService("google")).toBe("google_buyer");
    expect(roleForService("email")).toBe("email_strategist");
    expect(roleForService("social")).toBe("social_strategist");
    expect(roleForService("creative")).toBe("creative_director");
  });
  it("falls back to the desk, the line and the KPI card's platform", () => {
    expect(roleForService(null, { desk: "email" })).toBe("email_strategist");
    expect(roleForService(null, { line: "social" })).toBe("social_strategist");
    expect(roleForService(null, { platform: "google" })).toBe("google_buyer");
    expect(roleForService(null, { platform: "meta" })).toBe("media_buyer");
    expect(roleForService(null)).toBe("media_buyer");
  });
  it("reaches the agent that writes the report", () => {
    expect(roleForReport("meta")).toBe("media_buyer");
    expect(roleForReport("google")).toBe("google_buyer");
    expect(roleForReport("klaviyo")).toBe("email_strategist");
    expect(roleForReport("social")).toBe("social_strategist");
    expect(roleForReport("tiktok")).toBe("media_buyer");
  });
  it("reaches a Kaizen AI thread's agent, or the assistant when it's general", () => {
    expect(roleForThread("auditor")).toBe("media_buyer");
    expect(roleForThread("google_reporter")).toBe("google_buyer");
    expect(roleForThread("copy")).toBe("copywriter");
    expect(roleForThread("creativereview")).toBe("creative_director");
    expect(roleForThread(null)).toBe("assistant");
    expect(roleForThread("something_else")).toBe("assistant");
  });
  it("only names agents everyone can call", () => {
    const me = { role: "social_media_manager", isExec: false };
    for (const key of Object.keys(CALL_ROLES)) expect(canTalkToAgent(me, key), key).toBe(true);
  });
});

describe("the context in the agent's prompt", () => {
  it("names the client so tools don't ask which", () => {
    const out = contextPrompt({ screen: "the KPI board", client: { name: "Crust Pizza" } });
    expect(out).toContain("They called you from the KPI board.");
    expect(out).toContain("The client on screen is Crust Pizza");
  });
  it("carries the report and the chat so far, trimmed", () => {
    const out = contextPrompt({
      screen: "a report",
      report: { client: "Crust Pizza", platform: "meta", kind: "weekly", period: "2026-11-09 to 2026-11-15", status: "draft", message: "m".repeat(4000), sections: "", checks: 2 },
      thread: { title: 'The "plan"', client: null, turns: [{ who: "them", text: "What should we test?" }, { who: "ai", text: "A price hook." }] },
    });
    expect(out).toContain("weekly meta report for Crust Pizza");
    expect(out).toContain("2 checks flagged");
    expect(out).toContain("…");
    expect(out).not.toContain("m".repeat(2000));
    expect(out).toContain(`title="The 'plan'"`);
    expect(out).toContain("They wrote: What should we test?");
    expect(out).toContain("Kaizen AI answered: A price hook.");
  });
});

describe("take a look", () => {
  it("hears look requests", () => {
    for (const t of ["Can you take a look at this?", "take a screenshot", "what's on my screen", "look at this ad", "can you see this?", "Have a look"]) expect(looksLikeLook(t), t).toBe(true);
  });
  it("doesn't hear ordinary questions", () => {
    for (const t of ["How is Crust doing this week?", "Look up the numbers for Crust", "what's our ROAS", "I see what you mean"]) expect(looksLikeLook(t), t).toBe(false);
  });
  it("grabs a frame when sharing, asks to share on computers, and asks phones for a screenshot", () => {
    expect(lookPlan({ desktop: true, canShare: true, sharing: true })).toBe("grab");
    expect(lookPlan({ desktop: true, canShare: true, sharing: false })).toBe("ask_share");
    expect(lookPlan({ desktop: true, canShare: false, sharing: false })).toBe("upload");
    expect(lookPlan({ desktop: false, canShare: false, sharing: false })).toBe("upload");
  });
  it("scales frames down to about 1600 pixels, never up", () => {
    expect(fitWithin(3840, 2160)).toEqual({ width: 1600, height: 900 });
    expect(fitWithin(1080, 2400)).toEqual({ width: 720, height: 1600 });
    expect(fitWithin(1280, 720)).toEqual({ width: 1280, height: 720 });
    expect(fitWithin(0, 0)).toEqual({ width: 1, height: 1 });
  });
  it("names screenshots so they're found and deleted with the call", () => {
    expect(screenFileName(new Date("2026-11-17T15:04:05.123Z"))).toBe("screen-2026-11-17T15-04-05-123Z.jpg");
  });
});

describe("recorded audio names", () => {
  it("names a part by what the browser recorded", () => {
    expect(audioExt("audio/webm;codecs=opus")).toBe("webm");
    expect(audioExt("audio/mp4")).toBe("m4a");
    expect(audioExt("audio/mp4;codecs=mp4a.40.2")).toBe("m4a");
    expect(audioExt("audio/ogg")).toBe("ogg");
    expect(audioExt("")).toBe("webm");
    expect(audioExt(undefined)).toBe("webm");
  });
  it("keeps the part's order and start in the path", () => {
    expect(audioPartPath("call-1", 3, 125.7, "audio/mp4")).toBe("call-1/003-125.m4a");
    expect(audioPartPath("call-1", 99, -4, "audio/webm")).toBe("call-1/060-0.webm");
  });
});

describe("a connector action waits for a spoken yes", () => {
  const now = Date.parse("2026-11-17T15:00:00Z");
  const ask = { id: "a", key: "gmail", name: "Gmail", tool: "send_reply", input: "{}", summary: "Reply to Crust", at: new Date(now - 60_000).toISOString() };
  it("holds an ask made before this turn, on a connected service", () => {
    expect(liveAsk(ask, ["gmail"], now, now)?.tool).toBe("send_reply");
  });
  it("never counts a yes said in the same turn as the ask", () => {
    expect(liveAsk({ ...ask, at: new Date(now).toISOString() }, ["gmail"], now, now - 1000)).toBeNull();
  });
  it("lets go of stale asks, disconnected services and junk", () => {
    expect(liveAsk({ ...ask, at: new Date(now - ASK_TTL_MS - 1).toISOString() }, ["gmail"], now)).toBeNull();
    expect(liveAsk(ask, ["slack"], now)).toBeNull();
    expect(liveAsk({ key: "gmail" }, ["gmail"], now)).toBeNull();
    expect(liveAsk(null, ["gmail"], now)).toBeNull();
  });
  it("tells the agent to run it once on a yes, and to drop it otherwise", () => {
    const a = liveAsk(ask, ["gmail"], now)!;
    expect(askLine(a, true)).toContain("Run that tool now, once");
    expect(askLine(a, false)).toContain("hasn't run");
  });
});

describe("the Social Strategist", () => {
  it("is a role agent on its own line, trained by the Head of Organic Social", () => {
    expect(ROLE_SKILLS.social_strategist).toEqual(["social_audit", "social_desk"]);
    expect(lineOfRole("social_strategist")).toBe("social");
    expect(canTrainAgent({ role: "head_of_social", isExec: false }, "social_strategist")).toBe(true);
    expect(canTrainAgent({ role: "social_media_manager", isExec: false }, "social_strategist")).toBe(false);
    expect(DEFAULT_VOICES.social_strategist).toBeTruthy();
  });
  it("can be called into the assistant's call for organic social", () => {
    expect(SPECIALISTS.some((s) => s.key === "social_strategist")).toBe(true);
    expect(suggestSpecialist("which reels got the best engagement rate for Crust's organic account?")?.key).toBe("social_strategist");
  });
});
