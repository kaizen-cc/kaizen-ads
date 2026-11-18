import { describe, expect, it } from "vitest";
import {
  MAX_HOPS,
  MAX_ON_LINE,
  PLAYBOOKS,
  agentsToBring,
  canHandOff,
  cleanJob,
  joinLine,
  jobForPrompt,
  jobView,
  launchFacts,
  launchTicket,
  lineOf,
  mentions,
  newJob,
  platformIn,
  recognizeJob,
  routeTeam,
  speaksTo,
  updateJob,
  whatsMissing,
  type LaunchFound,
  type LaunchTicket,
} from "@/lib/assistant/team";

// Several agents on one call: who a turn is for with more than one specialist on the line, the jobs as data, what a
// job still needs from what the checks found (a launch's copy, creatives, ad set and checks), the shared job state,
// and how far agents may hand work to each other before the person has the floor.

const host = "assistant";

describe("who a turn is for with several specialists on the line", () => {
  const line = ["media_buyer", "copywriter"];
  it("goes to the host when nobody else is on", () => {
    expect(routeTeam("launch the Crust ads", { host, line: [] })).toEqual({ to: host, dismiss: [] });
  });
  it("goes to the specialist spoken to by role, wherever the conversation was", () => {
    expect(routeTeam("Copywriter, punchier", { host, line, last: "media_buyer" }).to).toBe("copywriter");
    expect(routeTeam("ok media buyer, which ad set?", { host, line, last: "copywriter" }).to).toBe("media_buyer");
    expect(routeTeam("is that the prospecting one, buyer?", { host, line, last: "copywriter" }).to).toBe("media_buyer");
    expect(routeTeam("Assistant, note that we launch Friday", { host, line, last: "copywriter" }).to).toBe("assistant");
  });
  it("goes to whoever the conversation is with otherwise", () => {
    expect(routeTeam("make the hook shorter", { host, line, last: "copywriter" }).to).toBe("copywriter");
    expect(routeTeam("what does that do to the budget?", { host, line, last: "media_buyer" }).to).toBe("media_buyer");
    expect(routeTeam("and then?", { host, line, last: "assistant" }).to).toBe("assistant");
    // Nobody has spoken yet: the newest on the line
    expect(routeTeam("hi there", { host, line, last: null }).to).toBe("copywriter");
  });
  it("doesn't take talking about an agent as talking to it", () => {
    expect(routeTeam("the copywriter said it's fine, so what now?", { host, line, last: "media_buyer" }).to).toBe("media_buyer");
    expect(routeTeam("copywriter's draft looks good", { host, line, last: "media_buyer" }).to).toBe("media_buyer");
  });
  it("lets the named specialist go, or all of them, when the call is handed back", () => {
    expect(routeTeam("thanks Copywriter, you can go", { host, line, last: "copywriter" })).toEqual({ to: host, dismiss: ["copywriter"] });
    expect(routeTeam("thanks, I'll take it from here", { host, line, last: "copywriter" })).toEqual({ to: host, dismiss: ["media_buyer", "copywriter"] });
  });
  it("counts a short name only when one agent on the line answers to it", () => {
    expect(speaksTo("buyer, what's the CPM?", "media_buyer", ["assistant", "media_buyer", "copywriter"])).toBe(true);
    expect(speaksTo("buyer, what's the CPM?", "media_buyer", ["assistant", "media_buyer", "google_buyer"])).toBe(false);
    expect(routeTeam("strategist, which angle?", { host, line: ["email_strategist", "social_strategist"], last: "social_strategist" }).to).toBe("social_strategist");
    expect(routeTeam("email strategist, which angle?", { host, line: ["email_strategist", "social_strategist"], last: "social_strategist" }).to).toBe("email_strategist");
  });
  it("works the same on a call with an agent called directly", () => {
    expect(routeTeam("Copywriter, give me three hooks", { host: "media_buyer", line: ["copywriter"], last: "media_buyer" }).to).toBe("copywriter");
    expect(routeTeam("and the ad set?", { host: "media_buyer", line: ["copywriter"], last: "media_buyer" }).to).toBe("media_buyer");
    expect(routeTeam("media buyer, which ad set?", { host: "media_buyer", line: ["copywriter"], last: "copywriter" }).to).toBe("media_buyer");
  });
  it("finds a name anywhere for letting it go", () => {
    expect(mentions("great work, thanks copywriter", "copywriter")).toBe(true);
    expect(mentions("great work", "copywriter")).toBe(false);
  });
});

describe("the line", () => {
  it("adds a specialist once, never the host, at most three", () => {
    expect(joinLine([], "copywriter", host)).toEqual({ line: ["copywriter"], joined: true, full: false });
    expect(joinLine(["copywriter"], "copywriter", host).joined).toBe(false);
    expect(joinLine([], "media_buyer", "media_buyer").joined).toBe(false);
    const full = ["copywriter", "media_buyer", "strategist"];
    expect(full.length).toBe(MAX_ON_LINE);
    expect(joinLine(full, "creative_director", host)).toMatchObject({ joined: false, full: true });
  });
  it("reads the list, or the one specialist kept before there could be several", () => {
    expect(lineOf({ guest_roles: ["copywriter", "media_buyer"] }, host)).toEqual(["copywriter", "media_buyer"]);
    expect(lineOf({ guest_roles: [], guest_role: "media_buyer" }, host)).toEqual(["media_buyer"]);
    expect(lineOf({ guest_role: null }, host)).toEqual([]);
    expect(lineOf({ guest_roles: ["media_buyer", "not_an_agent", "media_buyer"] }, "media_buyer")).toEqual([]);
  });
});

describe("hand-offs between agents", () => {
  const input = { host, line: ["copywriter", "media_buyer"], chain: [] as string[] };
  it("go to someone on the call", () => {
    expect(canHandOff({ from: "copywriter", to: "media_buyer" }, input).ok).toBe(true);
    expect(canHandOff({ from: "copywriter", to: "assistant" }, input).ok).toBe(true);
    expect(canHandOff({ from: "copywriter", to: "creative_director" }, input).ok).toBe(false);
    expect(canHandOff({ from: "copywriter", to: "copywriter" }, input).ok).toBe(false);
  });
  it("stop after a couple, so the person gets the floor back", () => {
    expect(canHandOff({ from: "media_buyer", to: "assistant" }, { ...input, chain: Array.from({ length: MAX_HOPS }, (_, i) => `x${i}>y`) }).ok).toBe(false);
  });
  it("never ping-pong the same hand-off", () => {
    expect(canHandOff({ from: "copywriter", to: "media_buyer" }, { ...input, chain: ["copywriter>media_buyer"] }).ok).toBe(false);
    expect(canHandOff({ from: "media_buyer", to: "copywriter" }, { ...input, chain: ["copywriter>media_buyer"] }).ok).toBe(true);
  });
});

describe("recognising the job", () => {
  it("finds the job in what they ask", () => {
    expect(recognizeJob("I want to launch ads for Crust")?.kind).toBe("launch_ads");
    expect(recognizeJob("let's get the new ads live for Ocean Box on Meta")?.kind).toBe("launch_ads");
    expect(recognizeJob("can we request some emails for the Black Friday sale")?.kind).toBe("email_request");
    expect(recognizeJob("I need a brief for new creatives")?.kind).toBe("creative_brief");
    expect(recognizeJob("run an audit on their account and plan a sprint")?.kind).toBe("audit_sprint");
    expect(recognizeJob("build the monthly report for Crust")?.kind).toBe("report");
    expect(recognizeJob("how's your day going?")).toBeNull();
  });
  it("hears the platform", () => {
    expect(platformIn("launch it on Google")).toBe("google");
    expect(platformIn("the Instagram ads")).toBe("meta");
    expect(platformIn("launch it")).toBeNull();
  });
  it("keeps every playbook's steps unique and its agents named", () => {
    for (const p of PLAYBOOKS) {
      expect(new Set(p.steps.map((s) => s.key)).size).toBe(p.steps.length);
      expect(p.steps.every((s) => s.agent && s.ask && s.how)).toBe(true);
    }
  });
});

const ticket = (over: Partial<LaunchTicket> = {}): LaunchTicket => ({ number: 214, title: "Holiday UGC", stage: "copy", copy: null, designs: 3, approvedDesigns: 0, launch: null, ...over });
const found = (over: Partial<LaunchFound> = {}): LaunchFound => ({ tickets: [], uploadedCreatives: 0, sheet: null, copyOnCall: false, ...over });

describe("what a launch still needs", () => {
  const job = newJob({ kind: "launch_ads", goal: "Launch the holiday ads", client: { id: "c1", name: "Crust" }, platform: "meta" });

  it("asks for creatives first when nothing is ready or uploaded", () => {
    const gaps = whatsMissing(job, launchFacts(found()), host);
    expect(gaps[0]).toMatchObject({ key: "creatives", agent: "creative_director" });
    expect(gaps[0].ask).toContain("Crust");
  });
  it("needs the Copywriter when the designs are in but there's no approved copy", () => {
    const facts = launchFacts(found({ tickets: [ticket()] }));
    expect(facts).toMatchObject({ creatives: true, copy: false });
    const gaps = whatsMissing(job, facts, host);
    expect(gaps[0]).toMatchObject({ key: "copy", agent: "copywriter" });
    expect(agentsToBring(gaps, host, [])).toEqual(["copywriter", "media_buyer"]);
    expect(agentsToBring(gaps, host, ["copywriter"])).toEqual(["media_buyer"]);
  });
  it("goes straight to the buyer for a ticket in Ready to launch (its copy was approved to get there)", () => {
    const facts = launchFacts(found({ tickets: [ticket({ stage: "ready_for_launch", copy: "approved", approvedDesigns: 3 })] }));
    expect(facts).toMatchObject({ creatives: true, copy: true, adset: false, checks: false, live: false });
    expect(whatsMissing(job, facts, host)[0]).toMatchObject({ key: "adset", agent: "media_buyer" });
  });
  it("sends Google launches to the Google buyer", () => {
    const g = { ...job, platform: "google" as const };
    expect(whatsMissing(g, launchFacts(found({ tickets: [ticket({ stage: "ready_for_launch" })] })), host)[0].agent).toBe("google_buyer");
  });
  it("follows the launcher: an ad set picked, its checks, then created", () => {
    const planned = launchFacts(found({ tickets: [ticket({ stage: "ready_for_launch", launch: { status: "blocked", adset: "Prospecting" } })] }));
    expect(planned).toMatchObject({ adset: true, checks: false });
    expect(whatsMissing(job, planned, host)[0].key).toBe("checks");
    const ready = launchFacts(found({ tickets: [ticket({ stage: "ready_for_launch", launch: { status: "ready", adset: "Prospecting" } })] }));
    expect(whatsMissing(job, ready, host).map((g) => g.key)).toEqual(["live"]);
    const done = launchFacts(found({ tickets: [ticket({ stage: "ready_for_launch", launch: { status: "launched", adset: "Prospecting" } })] }));
    expect(whatsMissing(job, done, host)).toEqual([]);
  });
  it("counts creatives uploaded on the call and copy written on it (a launch sheet)", () => {
    const facts = launchFacts(found({ uploadedCreatives: 4, copyOnCall: true, sheet: { status: "asking" } }));
    expect(facts).toMatchObject({ creatives: true, copy: true, adset: false });
    expect(launchFacts(found({ uploadedCreatives: 4, sheet: { status: "applied" } }))).toMatchObject({ adset: true, checks: true, live: true });
  });
  it("picks the ticket nearest launch, never one already launched", () => {
    const t = launchTicket(found({ tickets: [ticket({ number: 1, stage: "copy" }), ticket({ number: 2, stage: "ready_for_launch" }), ticket({ number: 3, stage: "ready_for_launch", launch: { status: "launched", adset: "x" } })] }));
    expect(t?.number).toBe(2);
  });
  it("skips what an agent marked done", () => {
    const marked = updateJob(job, "copywriter", { done: ["creatives", "copy"] });
    expect(whatsMissing(marked, {}, host)[0].key).toBe("client");
  });
  it("waits for the client after the copy is approved (sending it needs the person's yes, by the host)", () => {
    const facts = launchFacts(found({ tickets: [ticket({ stage: "copy_review", copy: "approved" })] }));
    expect(facts).toMatchObject({ creatives: true, copy: true, client: false });
    expect(whatsMissing(job, facts, host)[0]).toMatchObject({ key: "client", agent: "assistant" });
  });
  it("never takes a copy card on the call for a ticket's approved copy", () => {
    expect(launchFacts(found({ tickets: [ticket()], copyOnCall: true })).copy).toBe(false);
  });
  it("lists optional steps last and never as the next thing", () => {
    const brief = newJob({ kind: "creative_brief", goal: "", client: { id: "c1", name: "Crust" }, platform: null });
    const gaps = whatsMissing(brief, {}, host);
    expect(gaps[0]).toMatchObject({ key: "brief", agent: "creative_director", optional: false });
    expect(gaps.slice(1).every((g) => g.optional)).toBe(true);
    expect(agentsToBring(gaps, host, [])).toEqual(["creative_director"]);
  });
  it("has the host do its own parts (a report)", () => {
    const report = newJob({ kind: "report", goal: "", client: { id: "c1", name: "Crust" }, platform: "meta" });
    const gaps = whatsMissing(report, {}, host);
    expect(gaps[0]).toMatchObject({ key: "report", agent: "assistant" });
    expect(agentsToBring(gaps, host, [])).toEqual([]);
  });
});

describe("the job's shared state", () => {
  const job = newJob({ kind: "launch_ads", goal: "Launch the holiday ads", client: { id: "c1", name: "Crust" }, platform: "meta", now: new Date("2026-11-18T15:00:00Z") });

  it("records steps, what was made (once per id) and notes by agent", () => {
    let j = updateJob(job, "copywriter", { done: ["copy", "not_a_step"], artifact: { kind: "copy", id: "set-1", label: "Approved copy for #214", href: "/board?t=214" }, note: "Went with the gifting angle" });
    j = updateJob(j, "copywriter", { artifact: { kind: "copy", id: "set-1", label: "Approved copy for #214 (v2)", href: "/board?t=214" } });
    expect(j.done).toEqual(["copy"]);
    expect(j.artifacts).toHaveLength(1);
    expect(j.artifacts[0]).toMatchObject({ label: "Approved copy for #214 (v2)", by: "copywriter" });
    expect(j.notes).toEqual([{ by: "copywriter", text: "Went with the gifting angle" }]);
  });
  it("reads back only what's well formed, with links kept in the app", () => {
    expect(cleanJob(null)).toBeNull();
    expect(cleanJob({ kind: "rob_a_bank" })).toBeNull();
    const back = cleanJob({ ...job, done: ["copy", "evil"], artifacts: [{ kind: "copy", id: "x", label: "y", by: "copywriter", href: "https://evil.example" }, { kind: "nope", id: "z" }] });
    expect(back?.done).toEqual(["copy"]);
    expect(back?.artifacts).toEqual([{ kind: "copy", id: "x", label: "y", by: "copywriter", href: null }]);
    expect(cleanJob(JSON.parse(JSON.stringify(job)))).toEqual(job);
  });
  it("is in every agent's prompt: what, done, left, made, notes", () => {
    const j = updateJob(job, "copywriter", { done: ["creatives", "copy"], artifact: { kind: "copy", id: "set-1", label: "Approved copy for #214", href: null }, note: "Gifting angle" });
    const gaps = whatsMissing(j, {}, host);
    const text = jobForPrompt(j, gaps);
    expect(text).toContain("Launch ads for Crust on Meta");
    expect(text).toContain("Done: Approved creatives; Approved copy.");
    expect(text).toContain("Client approved: Assistant");
    expect(text).toContain("Ad set picked: Media Buyer");
    expect(text).toContain("Approved copy for #214 (copy set-1, by the Copywriter)");
    expect(text).toContain("the Copywriter: Gifting angle");
    expect(jobForPrompt(null)).toBe("");
  });
  it("shows on the call as steps done or to do", () => {
    const j = updateJob(job, "copywriter", { done: ["copy"] });
    const v = jobView(j, whatsMissing(j, { creatives: true }, host));
    expect(v?.label).toBe("Launch ads");
    expect(v?.steps.filter((s) => s.done).map((s) => s.key)).toEqual(["creatives", "copy"]);
  });
});
