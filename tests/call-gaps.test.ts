import { describe, expect, it } from "vitest";
import { AWAY_RELEARN_MS, initialAway, stepAway, type AwayEvent, type AwayState } from "@/lib/agent-call/away";
import { askedForNote, cleanItems, mergeItems, tickItem, titleProblem } from "@/lib/agent-call/ask-rules";
import { openPlan } from "@/lib/agent-call/open-link";
import { CHANNEL_SHEET_TABS, KPI_CARD_TABS, SCREEN_PLACES, channelSheetHref, kpiCardHref, safeAppPath, safeLink } from "@/lib/assistant/core";
import { askItem } from "@/lib/agent-call/next-items";
import { monthSection } from "@/lib/ai-tools/team-ops-core";

// The gaps found on the Email Strategist's call: opening the exact thing, a card's Open, reminders that are real
// tasks (one checklist per call), and a call that survives switching apps, tabs and windows

const run = (events: AwayEvent[], from: AwayState = initialAway()) => {
  let s = from;
  const all: string[][] = [];
  for (const e of events) {
    const out = stepAway(s, e);
    s = out.state;
    all.push(out.effects);
  }
  return { state: s, effects: all };
};

describe("a call survives switching apps, tabs and windows", () => {
  it("desktop: another tab or window changes nothing while the audio keeps running", () => {
    const { state, effects } = run([
      { t: "hidden", at: 0 },
      { t: "visible", at: 5_000 },
    ]);
    expect(effects[0]).toEqual([]);
    // Coming back only checks everything is still up: no dropped words, no pause shown
    expect(effects[1]).toEqual(["resume_audio", "wake_ears", "rewake"]);
    expect(state).toEqual(initialAway());
  });

  it("phone: the audio stopped in the background shows paused, and picks up quietly on return", () => {
    const { state, effects } = run([
      { t: "hidden", at: 0 },
      { t: "audio", state: "interrupted", at: 100 },
      { t: "audio", state: "suspended", at: 200 },
      { t: "visible", at: 3_000 },
    ]);
    expect(effects[1]).toEqual(["show_paused"]);
    expect(effects[2]).toEqual([]);
    expect(effects[3]).toEqual(["resume_audio", "wake_ears", "rewake", "drop_half_heard", "relearn_noise", "clear_paused"]);
    expect(state.paused).toBe(false);
    expect(state.away).toBe(false);
  });

  it("phone: the microphone taken away is opened again on return", () => {
    const { effects } = run([
      { t: "hidden", at: 0 },
      { t: "mic_ended", at: 50 },
      { t: "visible", at: 1_000 },
    ]);
    expect(effects[1]).toEqual(["show_paused"]);
    expect(effects[2]).toContain("restart_mic");
    expect(effects[2]).toContain("clear_paused");
  });

  it("in sight, a stopped audio engine resumes at once and a lost mic reopens at once", () => {
    expect(stepAway(initialAway(), { t: "audio", state: "suspended", at: 0 }).effects).toEqual(["resume_audio"]);
    expect(stepAway(initialAway(), { t: "mic_ended", at: 0 }).effects).toEqual(["restart_mic"]);
  });

  it("a long time away learns the room's noise again", () => {
    const { effects } = run([
      { t: "hidden", at: 0 },
      { t: "visible", at: AWAY_RELEARN_MS + 1 },
    ]);
    expect(effects[1]).toContain("relearn_noise");
    expect(effects[1]).not.toContain("drop_half_heard");
  });

  it("hidden twice keeps the first time it went away; visible while in sight does nothing", () => {
    const a = run([
      { t: "hidden", at: 0 },
      { t: "hidden", at: 10_000 },
    ]);
    expect(a.state.since).toBe(0);
    expect(stepAway(initialAway(), { t: "visible", at: 1 }).effects).toEqual([]);
  });
});

describe("reminders that are real tasks", () => {
  it("only when asked for in so many words, or a yes to one offered", () => {
    expect(askedForNote("Remind me to send the deck tomorrow")).toBe(true);
    expect(askedForNote("Put that on my list")).toBe(true);
    expect(askedForNote("Send me the transcript inside of a task")).toBe(true);
    expect(askedForNote("Make sure the strategist does it")).toBe(true);
    expect(askedForNote("Yes. Set it for tomorrow")).toBe(true);
    expect(askedForNote("How are Ocean Box's Google numbers?")).toBe(false);
    expect(askedForNote("No, not now")).toBe(false);
    // A typed chat turn with no words to check is left to the model
    expect(askedForNote("")).toBe(true);
  });

  it("the title is a clear action, never the agent's own doubt", () => {
    expect(titleProblem("Decide whether to have Ocean Box's Google numbers pulled into the call")).toMatch(/Ask them/);
    expect(titleProblem("Should we pull the numbers?")).toMatch(/question/);
    expect(titleProblem("Maybe check the flows")).toMatch(/Ask them/);
    expect(titleProblem("Review")).toMatch(/clear action/);
    expect(titleProblem("Copy the Email Strategist call transcript into Claude Code")).toBeNull();
  });

  it("related things on one call are one checklist", () => {
    const first = cleanItems(["- Written flow playbook", "Email bars per industry", "email bars per industry", "", "  "]);
    expect(first).toEqual([
      { text: "Written flow playbook", done: false },
      { text: "Email bars per industry", done: false },
    ]);
    const more = mergeItems(tickItem(first, 0, true), cleanItems(["Klaviyo integrations library", "Written flow playbook"]));
    expect(more).toEqual([
      { text: "Written flow playbook", done: true },
      { text: "Email bars per industry", done: false },
      { text: "Klaviyo integrations library", done: false },
    ]);
  });

  it("Next for me shows the checklist and the transcript download", () => {
    const { item } = askItem(
      { id: "a1", kind: "reminder", title: "Improve the Email Strategist", detail: "", due_on: null, created_at: new Date().toISOString(), asked_by: "me", askerName: null, roleLabel: "Email Strategist", client: null, checklist: [{ text: "Flow playbook", done: false }], call_id: "c1", with_transcript: true },
      "me",
    );
    expect(item.ask).toEqual({ id: "a1", checklist: [{ text: "Flow playbook", done: false }], transcriptCallId: "c1" });
    const plain = askItem({ id: "a2", kind: "reminder", title: "Send it", detail: "", due_on: null, created_at: new Date().toISOString(), asked_by: "me", askerName: null, roleLabel: null, client: null }, "me");
    expect(plain.item.ask).toEqual({ id: "a2", checklist: undefined, transcriptCallId: undefined });
  });
});

describe("opening the exact thing", () => {
  it("a KPI card on its tab, and a client's Email or Social sheet", () => {
    expect(kpiCardHref("t-1")).toBe("/kpis?target=t-1");
    expect(kpiCardHref("t-1", "numbers")).toBe("/kpis?target=t-1&tab=numbers");
    expect(kpiCardHref("t-1", "flows")).toBe("/kpis?target=t-1");
    expect(channelSheetHref("email", "c-1", "flows")).toBe("/kpis?p=email&open=c-1&tab=flows");
    expect(channelSheetHref("social", "c-1")).toBe("/kpis?p=social&open=c-1");
    expect(KPI_CARD_TABS).toContain("policy");
    expect(CHANNEL_SHEET_TABS).toContain("campaigns");
  });

  it("every named place is a screen the call may open", () => {
    for (const [name, href] of Object.entries(SCREEN_PLACES)) expect(safeAppPath(href), name).toBe(href);
    expect(SCREEN_PLACES["assistant settings"]).toBe("/assistant#make-it-yours");
    expect(safeAppPath("/notifications")).toBe("/notifications");
  });

  it("a card's Open: in the app through the router, outside in a new tab, the same screen refreshed", () => {
    const here = { origin: "https://app.example.com", pathname: "/kpis", search: "?p=google", hash: "" };
    expect(openPlan({ href: "/reports/r1" }, here)).toEqual({ how: "push", href: "/reports/r1" });
    expect(openPlan({ href: "https://app.example.com/board?t=12" }, here)).toEqual({ how: "push", href: "/board?t=12" });
    expect(openPlan({ href: "/kpis?p=google" }, here)).toEqual({ how: "refresh", href: "/kpis?p=google" });
    expect(openPlan({ href: "/kpis?target=x&p=google" }, here)).toEqual({ how: "push", href: "/kpis?target=x&p=google" });
    expect(openPlan({ href: "https://business.facebook.com/x", external: true }, here)).toEqual({ how: "tab", href: "https://business.facebook.com/x" });
  });

  it("an outside link stays outside; a bad one is never shown", () => {
    expect(safeLink("https://www.loom.com/share/abc")).toEqual({ href: "https://www.loom.com/share/abc", external: true });
    expect(safeLink("javascript:alert(1)")).toBeNull();
  });
});

describe("the national days library feeds monthly moments", () => {
  const lib = "# National days library\n\n## June\n- Jun 1: National Donut Day (first Friday)\n\n## July\n- National Ice Cream Day (third Sunday)\n- Jul 7: World Chocolate Day\n\n## August\n- Aug 26: National Dog Day";
  it("one month's lines", () => {
    expect(monthSection(lib, 7)).toBe("- National Ice Cream Day (third Sunday)\n- Jul 7: World Chocolate Day");
    expect(monthSection(lib, 8)).toBe("- Aug 26: National Dog Day");
    expect(monthSection(lib, 1)).toBe("");
    expect(monthSection(lib, 13)).toBe("");
  });
});
