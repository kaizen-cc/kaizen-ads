import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TURN, createTurnDetector, createTurnWatchdog, muteTurn, STALL_MS } from "@/lib/agent-call/core";
import { CHECKPOINT, canSend, createTranscript, hasFloor, initialTurns, isCurrent, isEcho, shouldCheckpoint, shownPhase, stepTurns, turnToSend, wordsStalled, type TurnEffect, type TurnInput, type TurnState } from "@/lib/agent-call/turns";

// Whose turn it is on a call, and what mute, Send, typing, talking over and stalls do to it

type Run = { s: TurnState; fx: TurnEffect[] };

/** Feeds events in order; collects every effect */
function run(s: TurnState, ...events: TurnInput[]): Run {
  const fx: TurnEffect[] = [];
  for (const e of events) {
    const out = stepTurns(s, e);
    s = out.state;
    fx.push(...out.effects);
  }
  return { s, fx };
}
const has = (fx: TurnEffect[], d: TurnEffect["do"]) => fx.some((f) => f.do === d);
const asks = (fx: TurnEffect[]) => fx.filter((f): f is Extract<TurnEffect, { do: "ask" }> => f.do === "ask");
const lines = (fx: TurnEffect[]) => fx.filter((f): f is Extract<TurnEffect, { do: "line" }> => f.do === "line").map((f) => f.text);
const commits = (fx: TurnEffect[]) => fx.filter((f): f is Extract<TurnEffect, { do: "commit" }> => f.do === "commit").map((f) => f.commit);

/** On a call, listening, nothing said yet */
const listening = () => run(initialTurns(), { t: "ready" }).s;

/** A turn sent and being answered (turn number in s.asking) */
function asked(text = "how is crust doing"): TurnState {
  let { s } = run(listening(), { t: "partial", text }, { t: "turn_end" });
  s = run(s, { t: "heard", commit: s.commit!, text }).s;
  return s;
}

describe("a plain turn", () => {
  it("commits on the pause, shows the line once and asks once", () => {
    const a = run(listening(), { t: "partial", text: "hello" }, { t: "turn_end" });
    expect(a.s.phase).toBe("committing");
    expect(shownPhase(a.s)).toBe("thinking");
    expect(commits(a.fx)).toEqual([1]);
    const b = run(a.s, { t: "heard", commit: 1, text: "hello there" });
    expect(lines(b.fx)).toEqual(["hello there"]);
    expect(asks(b.fx).map((x) => x.said)).toEqual(["hello there"]);
    expect(b.s.phase).toBe("thinking");
    expect(b.fx).toContainEqual({ do: "watch", on: true, retry: false });
  });
  it("goes back to listening when the turn had no words (a cough)", () => {
    const { s, fx } = run(listening(), { t: "turn_end" }, { t: "heard", commit: 1, text: " . " });
    expect(s.phase).toBe("listening");
    expect(asks(fx)).toEqual([]);
    expect(lines(fx)).toEqual([]);
  });
  it("plays the answer, then listens with a clean slate", () => {
    let s = asked();
    const turn = s.asking!;
    s = run(s, { t: "audio", turn }).s;
    expect(s.phase).toBe("speaking");
    expect(hasFloor(s)).toBe(false);
    const { s: after, fx } = run(s, { t: "idle" });
    expect(after.phase).toBe("listening");
    expect(after.asking).toBeNull();
    expect(has(fx, "ears_reset")).toBe(true);
    expect(has(fx, "detector_reset")).toBe(true);
  });
});

describe("mute", () => {
  it("mid-sentence: what was heard goes as a finished turn, once", () => {
    const a = run(listening(), { t: "partial", text: "can you pull the" }, { t: "mute", speaking: true });
    expect(a.s.muted).toBe(true);
    expect(commits(a.fx)).toEqual([1]);
    expect(a.fx).toContainEqual({ do: "ears_pause", on: true });
    const b = run(a.s, { t: "heard", commit: 1, text: "can you pull the Crust numbers" });
    expect(asks(b.fx).map((x) => x.said)).toEqual(["can you pull the Crust numbers"]);
    expect(lines(b.fx)).toEqual(["can you pull the Crust numbers"]);
  });
  it("with nothing heard: no turn, the slate is cleaned", () => {
    const { s, fx } = run(listening(), { t: "mute", speaking: false });
    expect(commits(fx)).toEqual([]);
    expect(has(fx, "ears_reset")).toBe(true);
    expect(s.phase).toBe("listening");
  });
  it("mid-reply: the answer carries on, nothing is sent or stopped", () => {
    let s = asked();
    s = run(s, { t: "audio", turn: s.asking }).s;
    const { s: m, fx } = run(s, { t: "mute", speaking: false });
    expect(m.phase).toBe("speaking");
    expect(has(fx, "stop_agent")).toBe(false);
    expect(commits(fx)).toEqual([]);
    // Unmuting mid-reply doesn't wipe or restart anything either
    const u = run(m, { t: "unmute" });
    expect(u.s.phase).toBe("speaking");
    expect(has(u.fx, "stop_agent")).toBe(false);
    expect(u.fx).toContainEqual({ do: "detector_relearn" });
  });
  it("while thinking: the answer still comes", () => {
    const s = asked();
    const turn = s.asking;
    const { s: m, fx } = run(s, { t: "mute", speaking: false }, { t: "unmute" });
    expect(m.asking).toBe(turn);
    expect(m.phase).toBe("thinking");
    expect(has(fx, "stop_agent")).toBe(false);
    expect(commits(fx)).toEqual([]);
  });
  it("quick toggles in a row: one commit, one line, one ask, nothing merged or doubled", () => {
    const { s, fx } = run(
      listening(),
      { t: "partial", text: "check frequency" },
      { t: "mute", speaking: true },
      { t: "unmute" },
      { t: "mute", speaking: false },
      { t: "unmute" },
      { t: "mute", speaking: false },
    );
    expect(commits(fx)).toEqual([1]);
    // Unmuting while the words were on their way never wiped them
    expect(fx.filter((f) => f.do === "ears_reset")).toEqual([]);
    const b = run(s, { t: "heard", commit: 1, text: "check frequency on Ocean Box" }, { t: "unmute" });
    expect(lines(b.fx)).toEqual(["check frequency on Ocean Box"]);
    expect(asks(b.fx)).toHaveLength(1);
  });
  it("unmuting listens fresh: detector reset with the room learned again, old words forgotten, a dropped line reconnected", () => {
    const { s } = run(listening(), { t: "mute", speaking: false });
    const { s: u, fx } = run(s, { t: "partial", text: "noise while muted" }, { t: "unmute" });
    expect(u.heard).toBe("");
    expect(fx).toContainEqual({ do: "detector_relearn" });
    expect(fx).toContainEqual({ do: "ears_reset" });
    expect(fx).toContainEqual({ do: "ears_wake" });
    expect(fx).toContainEqual({ do: "ears_pause", on: false });
  });
  it("ignores words and the pause detector while muted", () => {
    const { s, fx } = run(listening(), { t: "mute", speaking: false }, { t: "partial", text: "background chatter" }, { t: "turn_end" }, { t: "speech_start" });
    expect(s.heard).toBe("");
    expect(commits(fx)).toEqual([]);
    expect(canSend(s)).toBe(false);
  });
  it("the decision on its own", () => {
    expect(muteTurn({ phase: "listening", heard: "hi", carry: "", speaking: false })).toBe("send");
    expect(muteTurn({ phase: "listening", heard: "", carry: "", speaking: true })).toBe("send");
    expect(muteTurn({ phase: "listening", heard: " ", carry: "", speaking: false })).toBe("drop");
    expect(muteTurn({ phase: "speaking", heard: "hi", carry: "", speaking: true })).toBe("drop");
  });
});

describe("stale answers and commits", () => {
  it("an answer from an older turn is ignored once a newer one is sent", () => {
    let s = asked("first question");
    const old = s.asking!;
    // They carry on talking: the old answer stops, the new turn takes over
    s = run(s, { t: "speech_start" }).s;
    expect(isCurrent(s, old)).toBe(false);
    s = run(s, { t: "turn_end" }).s;
    s = run(s, { t: "heard", commit: s.commit!, text: "and the second" }).s;
    const fresh = s.asking!;
    expect(fresh).toBeGreaterThan(old);
    // The old answer's sound arrives late: nothing happens
    const late = run(s, { t: "audio", turn: old });
    expect(late.s.phase).toBe("thinking");
    expect(late.fx).toEqual([]);
    expect(isCurrent(s, fresh)).toBe(true);
    // The greeting (no turn) always plays
    expect(isCurrent(s, null)).toBe(true);
  });
  it("words from an older commit are ignored", () => {
    const { s } = run(listening(), { t: "partial", text: "x" }, { t: "turn_end" });
    const typed = run(s, { t: "typed", text: "typed instead" });
    const late = run(typed.s, { t: "heard", commit: 1, text: "x y z" });
    expect(late.fx).toEqual([]);
    expect(asks(typed.fx).map((a) => a.said)).toEqual(["typed instead"]);
  });
  it("a turn ended while the last one's words are out is committed after, never in parallel", () => {
    let { s, fx } = run(listening(), { t: "partial", text: "one" }, { t: "turn_end" }, { t: "speech_start" }, { t: "turn_end" });
    expect(commits(fx)).toEqual([1]);
    expect(s.again).toBe(true);
    const b = run(s, { t: "heard", commit: 1, text: "one" });
    expect(commits(b.fx)).toEqual([2]);
    s = b.s;
    fx = run(s, { t: "heard", commit: 2, text: "two" }).fx;
    expect(asks(fx).map((a) => a.said)).toEqual(["one two"]);
    expect(lines(fx)).toEqual(["one two"]);
  });
});

describe("talking while the answer is coming", () => {
  it("sends the cut-off turn again with what they add, shown once", () => {
    let s = asked("pull the Crust report");
    const { fx: stopFx, s: s2 } = run(s, { t: "speech_start" });
    expect(has(stopFx, "stop_agent")).toBe(true);
    s = run(s2, { t: "turn_end" }).s;
    const { fx } = run(s, { t: "heard", commit: s.commit!, text: "for last week" });
    expect(asks(fx).map((a) => a.said)).toEqual(["pull the Crust report for last week"]);
    expect(lines(fx)).toEqual(["for last week"]);
  });
  it("noise that stopped the answer doesn't lose the turn: it's sent again, not shown again", () => {
    let s = asked("what's my day look like");
    s = run(s, { t: "speech_start" }, { t: "turn_end" }).s;
    const { fx } = run(s, { t: "heard", commit: s.commit!, text: "" });
    expect(asks(fx).map((a) => a.said)).toEqual(["what's my day look like"]);
    expect(lines(fx)).toEqual([]);
  });
  it("a turn sent with Send isn't cancelled by noise", () => {
    let { s } = run(listening(), { t: "partial", text: "loud cafe question" }, { t: "send" });
    expect(s.manual).toBe(true);
    s = run(s, { t: "heard", commit: s.commit!, text: "loud cafe question" }).s;
    const { fx, s: after } = run(s, { t: "speech_start" });
    expect(has(fx, "stop_agent")).toBe(false);
    expect(after.phase).toBe("thinking");
  });
  it("talking over the reply stops it and hears them from just before", () => {
    let s = asked();
    s = run(s, { t: "audio", turn: s.asking }).s;
    const { s: b, fx } = run(s, { t: "barge_in" });
    expect(b.phase).toBe("listening");
    expect(has(fx, "stop_agent")).toBe(true);
    expect(has(fx, "ears_preroll")).toBe(true);
  });
});

describe("Send and Type instead", () => {
  it("Send needs something heard, then commits now", () => {
    expect(canSend(listening())).toBe(false);
    expect(run(listening(), { t: "send" }).fx).toEqual([]);
    const { s, fx } = run(listening(), { t: "partial", text: "send this" }, { t: "send" });
    expect(commits(fx)).toEqual([1]);
    expect(s.phase).toBe("committing");
  });
  it("a typed turn interrupts the reply and is sent as written", () => {
    let s = asked();
    s = run(s, { t: "audio", turn: s.asking }).s;
    const { s: t, fx } = run(s, { t: "typed", text: "  just give me ROAS  " });
    expect(has(fx, "stop_agent")).toBe(true);
    expect(lines(fx)).toEqual(["just give me ROAS"]);
    expect(asks(fx).map((a) => a.said)).toEqual(["just give me ROAS"]);
    expect(t.phase).toBe("thinking");
  });
  it("an empty typed turn does nothing", () => {
    expect(run(listening(), { t: "typed", text: "   " }).fx).toEqual([]);
  });
  it("a long turn gets 'Got it, thinking' straight away", () => {
    const long = "word ".repeat(120);
    const { s, fx } = run(listening(), { t: "turn_end" }, { t: "heard", commit: 1, text: long });
    expect(s.stall).toBe("long");
    expect(fx).toContainEqual({ do: "stall", state: "long" });
  });
});

describe("the agent's own voice after unmuting", () => {
  it("is not taken for the person", () => {
    let s = asked();
    s = run(s, { t: "audio", turn: s.asking }, { t: "agent_line", text: "Crust spent twelve hundred dollars yesterday at a two point four ROAS." }, { t: "idle" }).s;
    s = run(s, { t: "mute", speaking: false }, { t: "unmute" }, { t: "turn_end" }).s;
    const { fx, s: after } = run(s, { t: "heard", commit: s.commit!, text: "twelve hundred dollars yesterday at a two point four" });
    expect(asks(fx)).toEqual([]);
    expect(after.phase).toBe("listening");
  });
  it("tells an echo from a real answer", () => {
    const said = ["Want to start with the Crust report?"];
    expect(isEcho("start with the crust report", said)).toBe(true);
    expect(isEcho("yes please do it", said)).toBe(false);
    expect(isEcho("yes", said)).toBe(false);
    expect(isEcho("start with the crust report", [])).toBe(false);
  });
});

describe("stalls", () => {
  it("slow: tries the same turn once more; failed: says so and listens; Retry sends it again", () => {
    const s = asked("build the weekly report");
    const first = s.asking!;
    const slow = run(s, { t: "slow" });
    expect(has(slow.fx, "stop_agent")).toBe(true);
    expect(asks(slow.fx).map((a) => a.said)).toEqual(["build the weekly report"]);
    expect(slow.fx).toContainEqual({ do: "watch", on: true, retry: true });
    expect(slow.s.stall).toBe("slow");
    expect(slow.s.asking).not.toBe(first);
    expect(lines(slow.fx)).toEqual([]);
    const failed = run(slow.s, { t: "failed" });
    expect(failed.s.phase).toBe("listening");
    expect(failed.s.stall).toBe("failed");
    const retry = run(failed.s, { t: "retry" });
    expect(asks(retry.fx).map((a) => a.said)).toEqual(["build the weekly report"]);
    expect(retry.s.stall).toBeNull();
    // The first word of the answer clears it
    const played = run(retry.s, { t: "audio", turn: retry.s.asking });
    expect(played.s.stall).toBeNull();
    expect(played.fx).toContainEqual({ do: "watch", on: false });
  });
  describe("the watchdog", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    it("retries once at twelve seconds without a first word, then gives up", () => {
      const onSlow = vi.fn();
      const onGiveUp = vi.fn();
      const w = createTurnWatchdog({ onSlow, onGiveUp });
      w.begin();
      vi.advanceTimersByTime(STALL_MS - 1);
      expect(onSlow).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onSlow).toHaveBeenCalledTimes(1);
      w.begin(true);
      vi.advanceTimersByTime(STALL_MS);
      expect(onGiveUp).toHaveBeenCalledTimes(1);
      expect(w.active).toBe(false);
    });
    it("starts the clock again when the server shows signs of life, and stops at the first word", () => {
      const onSlow = vi.fn();
      const w = createTurnWatchdog({ onSlow, onGiveUp: vi.fn() });
      w.begin();
      vi.advanceTimersByTime(10_000);
      w.progress();
      vi.advanceTimersByTime(10_000);
      expect(onSlow).not.toHaveBeenCalled();
      w.stop();
      vi.advanceTimersByTime(60_000);
      expect(onSlow).not.toHaveBeenCalled();
    });
    it("a fresh turn after a retry gets its own retry", () => {
      const onSlow = vi.fn();
      const onGiveUp = vi.fn();
      const w = createTurnWatchdog({ onSlow, onGiveUp });
      w.begin();
      vi.advanceTimersByTime(STALL_MS);
      w.stop();
      w.begin();
      vi.advanceTimersByTime(STALL_MS);
      expect(onSlow).toHaveBeenCalledTimes(2);
      expect(onGiveUp).not.toHaveBeenCalled();
    });
  });
});

describe("what a turn sends", () => {
  it("joins held words and what was just heard; shows only what's new", () => {
    expect(turnToSend({ resend: "", carry: "", heard: "" })).toBeNull();
    expect(turnToSend({ resend: "", carry: "first part", heard: "second" })).toEqual({ said: "first part second", shown: "first part second" });
    expect(turnToSend({ resend: "asked before", carry: "", heard: "  " })).toEqual({ said: "asked before", shown: null });
    expect(turnToSend({ resend: "asked before", carry: "", heard: "more" })).toEqual({ said: "asked before more", shown: "more" });
  });
  it("the words safety net ends a turn the level detector missed", () => {
    expect(wordsStalled({ heard: "", sinceWordsMs: 99_000, speaking: false })).toBe(false);
    expect(wordsStalled({ heard: "hello", sinceWordsMs: 1000, speaking: false })).toBe(false);
    expect(wordsStalled({ heard: "hello", sinceWordsMs: 2200, speaking: false })).toBe(true);
    expect(wordsStalled({ heard: "hello", sinceWordsMs: 2200, speaking: true })).toBe(false);
    expect(wordsStalled({ heard: "hello", sinceWordsMs: 3700, speaking: true })).toBe(true);
  });
});

describe("long turns from the transcriber", () => {
  it("commits a long monologue in pieces at pauses, and regardless at the hard limit", () => {
    expect(shouldCheckpoint({ uncommittedMs: 5_000, level: 0 })).toBe(false);
    expect(shouldCheckpoint({ uncommittedMs: CHECKPOINT.atPauseMs, level: 0.2 })).toBe(false);
    expect(shouldCheckpoint({ uncommittedMs: CHECKPOINT.atPauseMs, level: 0.001 })).toBe(true);
    expect(shouldCheckpoint({ uncommittedMs: CHECKPOINT.hardMs, level: 0.2 })).toBe(true);
  });
  it("joins every committed piece in order with the live partial, and waits for all of them", () => {
    const t = createTranscript();
    t.sent();
    t.partial("so the first thing");
    t.committed("So the first thing is budget.");
    t.partial("then creative");
    t.sent();
    t.sent();
    expect(t.settled).toBe(false);
    t.committed("Then creative fatigue on the hero ad.");
    t.committed("And last, the landing page.");
    expect(t.settled).toBe(true);
    expect(t.take()).toBe("So the first thing is budget. Then creative fatigue on the hero ad. And last, the landing page.");
    expect(t.text).toBe("");
  });
  it("five minutes of talking in twenty second pieces comes back whole", () => {
    const t = createTranscript();
    const pieces = Array.from({ length: 15 }, (_, i) => `Piece ${i + 1} of what I was saying.`);
    for (const p of pieces) {
      t.sent();
      t.partial(p.slice(0, 8));
      t.committed(p);
    }
    expect(t.take()).toBe(pieces.join(" "));
  });
  it("forgetting a turn throws away the words still coming back for it", () => {
    const t = createTranscript();
    t.partial("the agent's own voice");
    expect(t.forget()).toBe(true);
    expect(t.partial("late partial for it")).toBe(false);
    expect(t.committed("the agent's own voice")).toBe(false);
    expect(t.partial("their real words")).toBe(true);
    t.sent();
    t.committed("their real words");
    expect(t.take()).toBe("their real words");
  });
  it("a dropped connection keeps what was heard", () => {
    const t = createTranscript();
    t.sent();
    t.committed("first half");
    t.partial("second half");
    t.sent();
    t.lost();
    expect(t.settled).toBe(true);
    expect(t.take()).toBe("first half second half");
  });
});

// ─── The level detector over a long call ────────────────────────────────────

/** A small seeded random, so the long run is the same every time */
function rand(seed: number) {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

describe("turn taking over a thirty minute call", () => {
  it("still ends every turn within the pause, with no false ends, and the room's noise stays sane", () => {
    const r = rand(42);
    const d = createTurnDetector();
    const FRAME = 20;
    let ms = 0;
    const lateness: number[] = [];
    let falseEnds = 0;
    let turns = 0;
    let missed = 0;
    while (ms < 30 * 60_000) {
      // The room drifts over the call (the microphone's own gain moving), between very quiet and a light hum
      const room = 0.002 + 0.006 * (0.5 + 0.5 * Math.sin(ms / 240_000)) + r() * 0.001;
      // The person talks for 2 to 40 seconds: words with short gaps (down near the room) and the odd breath
      const talk = 2000 + r() * (r() < 0.1 ? 38_000 : 12_000);
      let said = 0;
      let started = false;
      let total = 0;
      while (said < talk) {
        const word = 120 + r() * 380;
        for (let t = 0; t < word; t += FRAME) {
          total += FRAME;
          const e = d.feed(0.05 + r() * 0.12, FRAME, false);
          if (e === "speech_start") started = true;
          if (e === "turn_end") falseEnds++;
        }
        const gap = r() < 0.08 ? 600 + r() * 600 : 40 + r() * 160;
        for (let t = 0; t < gap; t += FRAME) {
          total += FRAME;
          const e = d.feed(room * (1 + r() * 2), FRAME, false);
          if (e === "turn_end") falseEnds++;
        }
        said += word + gap;
      }
      ms += total;
      if (started) turns++;
      // Then they stop: the turn must end within the pause it allows
      let ended = -1;
      for (let t = 0; t < 6000; t += FRAME) {
        if (d.feed(room * (0.8 + r() * 0.4), FRAME, false) === "turn_end") {
          ended = t + FRAME;
          break;
        }
      }
      ms += 6000;
      if (!started) continue;
      if (ended < 0) missed++;
      else lateness.push(ended);
      // The agent answers for 3 to 20 seconds, its voice leaking into the mic, then a short echo tail
      const reply = 3000 + r() * 17_000;
      for (let t = 0; t < reply; t += FRAME) d.feed(0.015 + r() * 0.02, FRAME, true);
      for (let t = 0; t < 300; t += FRAME) d.feed(room + 0.01 * (1 - t / 300), FRAME, false);
      d.reset();
      ms += reply + 300;
      expect(d.noise).toBeGreaterThanOrEqual(TURN.noiseMin);
      expect(d.noise).toBeLessThanOrEqual(TURN.noiseMax);
    }
    expect(turns).toBeGreaterThan(50);
    expect(missed).toBe(0);
    expect(falseEnds).toBe(0);
    // Every end comes at the pause (the long-turn pause at most), never drifting later as the call goes on
    expect(Math.max(...lateness)).toBeLessThanOrEqual(TURN.longTurnSilenceMs + 2 * FRAME);
    const firstTen = lateness.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
    const lastTen = lateness.slice(-10).reduce((a, b) => a + b, 0) / 10;
    expect(lastTen - firstTen).toBeLessThan(400);
    expect(d.threshold).toBeLessThan(0.05);
  });
  it("the dips between words don't creep the room's noise up mid-turn", () => {
    const d = createTurnDetector();
    for (let t = 0; t < 1000; t += 20) d.feed(0.003, 20, false);
    const before = d.noise;
    // Forty seconds of speech whose gaps sit just under the speech level
    for (let i = 0; i < 400; i++) {
      for (let t = 0; t < 240; t += 20) d.feed(t % 40 ? 0.08 : 0.15, 20, false);
      d.feed(0.017, 20, false);
    }
    expect(d.noise).toBeCloseTo(before, 4);
  });
  it("never learns the agent's voice as the room", () => {
    const d = createTurnDetector();
    for (let t = 0; t < 1000; t += 20) d.feed(0.003, 20, false);
    const before = d.noise;
    for (let t = 0; t < 20_000; t += 20) d.feed(0.03, 20, true);
    // Its echo tail just after it stops is held out too
    for (let t = 0; t < TURN.afterAgentHoldMs; t += 20) d.feed(0.015, 20, false);
    expect(d.noise).toBeCloseTo(before, 5);
  });
  it("after unmuting in a louder room, learns it quickly and still ends the turn", () => {
    const d = createTurnDetector();
    for (let t = 0; t < 2000; t += 20) d.feed(0.002, 20, false);
    d.relearn();
    // A cafe: a steady hum well above the old room
    for (let t = 0; t < TURN.relearnMs + 200; t += 20) expect(d.feed(0.012, 20, false)).toBeNull();
    const events: string[] = [];
    for (let t = 0; t < 1500; t += 20) {
      const e = d.feed(0.15, 20, false);
      if (e) events.push(e);
    }
    for (let t = 0; t < TURN.endSilenceMs + 100; t += 20) {
      const e = d.feed(0.012, 20, false);
      if (e) events.push(e);
    }
    expect(events).toEqual(["speech_start", "turn_end"]);
  });
  it("steady noise that never dips isn't taken for someone talking forever", () => {
    const d = createTurnDetector();
    for (let t = 0; t < 1000; t += 20) d.feed(0.003, 20, false);
    const events: string[] = [];
    // A fan switched on: constant, well above the room
    for (let t = 0; t < 12_000; t += 20) {
      const e = d.feed(0.04, 20, false);
      if (e) events.push(e);
    }
    expect(events).toEqual(["speech_start", "turn_end"]);
  });
});
