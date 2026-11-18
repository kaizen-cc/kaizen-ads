import { describe, expect, it } from "vitest";
import { CONCISE_RULE, SPOKEN_RULE, deliberateEnd, endReasonFor, greetingFor, handoverLine, leftUnfinished, resumeModeFor, RESUME_AGAIN_MINUTES, RESUME_CONTINUE_MINUTES, type PreviousCall } from "@/lib/agent-call/core";
import { CHAT_FORMAT_RULE, CHAT_IDLE_SECONDS, MODALITY_OPEN, agentModality, keptLine, modeSince, parseModeLog, stillOpen, streamShaping, talkModeOf, withoutModality } from "@/lib/agent-call/modality";
import { assistantGreeting, saidYes } from "@/lib/assistant/core";
import { planAssistantTurn } from "@/lib/assistant/prompt";

// Chat with the assistant, identical to the call: one turn pipeline with a mode, the only difference how it talks and
// streams; a yes typed counts as a yes said; and how a conversation ended decides how the next one greets.

const tools = [{ name: "my_work" }, { name: "open_screen" }, { name: "switch_mode" }, { name: "start_job" }, { name: "look" }];
const plan = (mode: "voice" | "text") => planAssistantTurn({ firstName: "Dana", mode, toolsRule: "TOOLS RULE", playbooks: "PLAYBOOKS", teamRule: "TEAM RULE", tools });

describe("one brain for a call and a chat", () => {
  it("builds the same tool list in both modes", () => {
    expect(plan("text").tools.map((t) => t.name)).toEqual(plan("voice").tools.map((t) => t.name));
    expect(plan("text").tools).toEqual(tools);
  });

  it("has the same system rules except the modality block", () => {
    const voice = plan("voice").system;
    const text = plan("text").system;
    expect(voice).not.toBe(text);
    expect(withoutModality(text)).toBe(withoutModality(voice));
    expect(voice.split(MODALITY_OPEN).length).toBe(2);
    // Every shared rule is in both: tools, jobs, gates, notes, team, distress, the goodbye
    for (const piece of ["TOOLS RULE", "PLAYBOOKS", "TEAM RULE", "remind_me", "send_to_teammate", "confirmed: true", "flag_client_risk", "[[END_CALL]]", "988"]) {
      expect(voice).toContain(piece);
      expect(text).toContain(piece);
    }
  });

  it("speaks on a call and writes in a chat", () => {
    expect(plan("voice").system).toContain(SPOKEN_RULE);
    expect(plan("voice").system).toContain(CONCISE_RULE);
    expect(plan("text").system).not.toContain(SPOKEN_RULE);
    expect(plan("text").system).toContain(CHAT_FORMAT_RULE);
    expect(agentModality("text")).toContain("[label](url)");
    expect(agentModality("voice")).toContain("No markdown");
  });

  it("drops the spoken fillers and length guard in a chat, and keeps its line breaks", () => {
    expect(plan("voice").stream).toEqual({ filler: true, lengthGuard: true, keepLineBreaks: false });
    expect(plan("text").stream).toEqual({ filler: false, lengthGuard: false, keepLineBreaks: true });
    expect(keptLine("Three things:\n- one\n- two", false, "text")).toBe("Three things:\n- one\n- two");
    expect(keptLine("Three things.\nOne.", true, "voice")).toBe("Three things. One.…");
  });

  it("treats anything but text as a call", () => {
    expect(talkModeOf("text")).toBe("text");
    expect(talkModeOf(undefined)).toBe("voice");
    expect(talkModeOf("chat")).toBe("voice");
  });

  it("takes a typed yes exactly like a spoken one", () => {
    for (const y of ["Yes.", "yes!", "YES", "yep, send it", "Sure, go ahead", "ok do it", "sounds good", "Yes, send it."]) expect(saidYes(y)).toBe(true);
    for (const n of ["no", "wait, not yet", "yes but hold on", "what would it send?", ""]) expect(saidYes(n)).toBe(false);
  });
});

describe("a conversation moving between chat and call", () => {
  const start = "2026-11-18T10:00:00-05:00";
  it("counts a call's thirty minutes from when it became a call", () => {
    const log = parseModeLog([{ mode: "text", at: start }, { mode: "voice", at: "2026-11-18T11:00:00-05:00" }, { mode: "bad", at: "x" }]);
    expect(log).toHaveLength(2);
    expect(modeSince({ mode: "voice", startedAt: start, log })).toBe(Date.parse("2026-11-18T11:00:00-05:00"));
    expect(stillOpen({ mode: "voice", startedAt: start, log, callLimitSeconds: 1800, now: Date.parse("2026-11-18T11:20:00-05:00") })).toBe(true);
    expect(stillOpen({ mode: "voice", startedAt: start, log, callLimitSeconds: 1800, now: Date.parse("2026-11-18T11:40:00-05:00") })).toBe(false);
  });

  it("keeps a chat open while it's in use", () => {
    const now = Date.parse("2026-11-18T12:00:00-05:00");
    expect(stillOpen({ mode: "text", startedAt: start, lastTurnAt: "2026-11-18T11:30:00-05:00", callLimitSeconds: 1800, now })).toBe(true);
    expect(stillOpen({ mode: "text", startedAt: "2026-11-18T08:00:00-05:00", lastTurnAt: new Date(now - (CHAT_IDLE_SECONDS + 60) * 1000).toISOString(), callLimitSeconds: 1800, now })).toBe(false);
  });

  it("picks up with one line, never a fresh greeting", () => {
    expect(handoverLine("the Crust report.")).toBe("Picking up where we left off: the Crust report.");
    expect(handoverLine(null)).toBe("Picking up where we left off. Go ahead.");
  });
});

describe("how a conversation ended", () => {
  it("is deliberate from the button, the agent's goodbye or closing the chat", () => {
    expect(endReasonFor({ trigger: "button" })).toBe("hangup");
    expect(endReasonFor({ trigger: "agent_end" })).toBe("goodbye");
    expect(endReasonFor({ trigger: "chat_close" })).toBe("chat_closed");
  });

  it("is a drop when nothing ended it (a closed tab, a lost line, the sweep)", () => {
    for (const trigger of ["sweep", "unload", "error", "limit", null] as const) expect(endReasonFor({ trigger, lastUser: "and what about the welcome flow", lastAgent: "The welcome flow is at 4%." })).toBe("dropped");
  });

  it("is a goodbye when the last words were a parting line, even without a button", () => {
    expect(endReasonFor({ trigger: "sweep", lastUser: "ok thanks, bye", lastAgent: "Anytime!" })).toBe("goodbye");
    expect(endReasonFor({ trigger: "unload", lastUser: "that's all for now", lastAgent: null })).toBe("goodbye");
    expect(endReasonFor({ trigger: "sweep", lastUser: "sure", lastAgent: "Talk soon, Dana!" })).toBe("goodbye");
  });

  it("knows which are deliberate", () => {
    expect(deliberateEnd("hangup")).toBe(true);
    expect(deliberateEnd("goodbye")).toBe(true);
    expect(deliberateEnd("chat_closed")).toBe(true);
    expect(deliberateEnd("dropped")).toBe(false);
    expect(deliberateEnd(null)).toBe(false);
  });
});

describe("cut off, or hey again", () => {
  const now = new Date("2026-11-17T16:00:00-05:00");
  const prev = (minutesAgo: number, endReason: PreviousCall["endReason"]): PreviousCall => {
    const at = new Date(now.getTime() - minutesAgo * 60_000).toISOString();
    return { startedAt: at, endedAt: at, lastTurnAt: at, turns: 4, endReason };
  };

  it("apologises for a drop when they're back within the window", () => {
    expect(resumeModeFor(prev(3, "dropped"), now)).toBe("continue");
    expect(resumeModeFor(prev(RESUME_CONTINUE_MINUTES, null), now)).toBe("continue");
    expect(resumeModeFor(prev(RESUME_CONTINUE_MINUTES + 2, "dropped"), now)).toBe("soon");
  });

  it("says hey again after they ended it themselves, never 'cut off'", () => {
    for (const r of ["hangup", "goodbye", "chat_closed"] as const) {
      expect(resumeModeFor(prev(2, r), now)).toBe("again");
      expect(resumeModeFor(prev(RESUME_AGAIN_MINUTES + 1, r), now)).toBe("soon");
    }
  });

  it("keeps the timing greetings later the same day and the next", () => {
    expect(resumeModeFor(prev(6 * 60, "hangup"), now)).toBe("later_today");
    expect(resumeModeFor(prev(20 * 60, "dropped"), now)).toBe("fresh");
  });

  it("greets casually, varied, with the topic only when something was left open", () => {
    const plain = new Set([0, 1, 2, 3].map((s) => greetingFor("Dana Lee", "Assistant", "again", null, s)));
    expect(plain.size).toBeGreaterThan(1);
    for (const g of plain) {
      expect(g).toMatch(/again|Back already/i);
      expect(g).not.toMatch(/cut off|dropped/i);
      expect(g).not.toMatch(/[—–]/);
    }
    expect(greetingFor("Dana Lee", "Assistant", "again", null, 0)).toBe("Hey again, Dana! What's up?");
    expect(greetingFor("Dana Lee", "Assistant", "again", "the welcome flow", 0)).toBe("Hey again, Dana! What's up? We can finish the welcome flow if you like.");
    expect(greetingFor("Dana Lee", "Assistant", "continue", "the welcome flow", 0)).toMatch(/^Sorry Dana, we got cut off/);
  });

  it("calls something unfinished only when a job is open or the agent's last line asked", () => {
    expect(leftUnfinished({ jobOpen: true })).toBe(true);
    expect(leftUnfinished({ lastAgent: "Want me to send it to the client?" })).toBe(true);
    expect(leftUnfinished({ lastAgent: "Shall I draft it" })).toBe(true);
    expect(leftUnfinished({ lastAgent: "Done. Talk soon!" })).toBe(false);
    expect(leftUnfinished({ lastAgent: "Bye, Dana. Anything else?" })).toBe(false);
    expect(leftUnfinished({})).toBe(false);
  });

  it("the assistant says hey again too, even before it knows them", () => {
    const timed = greetingFor("Dana Lee", "Assistant", "again", null, 1);
    expect(assistantGreeting({ name: "Dana", memory: [], today: "2026-11-17", mode: "again", timed }).text).toBe(timed);
  });
});
