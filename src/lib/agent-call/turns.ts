import { muteTurn, type StallState } from "./core";

// Whose turn it is on a call, as a plain state machine: no audio, no network, no timers. The call (engine.ts) feeds it
// what happens (words heard, the person starting or stopping talking, mute, Send, a typed turn, the answer's first
// sound, a stall) and carries out what it says to do. Keeping it pure is what lets every awkward case be tested:
// muting mid-sentence or mid-reply, quick mute toggles, talking over an answer, a reply from an old turn arriving
// after a newer one, the agent hearing its own voice after unmuting.
//
// Every commit (asking the transcriber for the words of a turn) and every ask (a turn sent for an answer) has its own
// number. Only the latest commit's words count, and only the latest ask's answer is played: anything older is
// ignored, so turns are never doubled, merged by accident or answered out of order.

export type TurnPhase = "connecting" | "listening" | "committing" | "thinking" | "speaking";

export type TurnState = {
  phase: TurnPhase;
  muted: boolean;
  /** The commit waiting on the transcriber, if any */
  commit: number | null;
  /** The person finished another turn (or pressed Send) while a commit was still out: commit again once it's back */
  again: boolean;
  /** The turn whose answer is wanted, if any */
  asking: number | null;
  /** The next number for a commit or an ask */
  next: number;
  /** Words heard and not sent yet (they carried on talking before the turn was sent) */
  carry: string;
  /** A turn already sent and shown that was cut off by more talking: sent again with what comes next, not shown again */
  resend: string;
  /** The live words of this turn so far (what Send would send) */
  heard: string;
  /** This turn was sent on purpose (Send or typed): noise while it's answered doesn't cancel it */
  manual: boolean;
  /** The last turn sent, for a retry */
  last: { said: string; frame: string | null } | null;
  stall: StallState;
  /** The agent's latest lines, so its own voice heard back isn't taken for the person */
  agentSaid: string[];
};

export type TurnInput =
  | { t: "ready" }
  | { t: "partial"; text: string }
  | { t: "speech_start" }
  | { t: "turn_end" }
  | { t: "barge_in" }
  | { t: "mute"; speaking: boolean }
  | { t: "unmute" }
  | { t: "send" }
  | { t: "typed"; text: string }
  | { t: "inject"; text: string; shown: string; frame: string | null }
  | { t: "heard"; commit: number; text: string }
  | { t: "audio"; turn: number | null }
  | { t: "idle" }
  | { t: "agent_line"; text: string }
  | { t: "slow" }
  | { t: "failed" }
  | { t: "retry" };

export type TurnEffect =
  | { do: "commit"; commit: number }
  | { do: "ask"; turn: number; said: string; frame: string | null }
  | { do: "stop_agent" }
  | { do: "line"; text: string }
  | { do: "partial"; text: string }
  | { do: "ears_reset" }
  | { do: "ears_pause"; on: boolean }
  | { do: "ears_wake" }
  | { do: "ears_preroll" }
  | { do: "detector_reset" }
  | { do: "detector_relearn" }
  | { do: "stall"; state: StallState }
  | { do: "watch"; on: boolean; retry?: boolean };

/** A turn this long (characters) gets "Got it, thinking…" straight away */
export const LONG_TURN_CHARS = 400;

export const initialTurns = (): TurnState => ({ phase: "connecting", muted: false, commit: null, again: false, asking: null, next: 1, carry: "", resend: "", heard: "", manual: false, last: null, stall: null, agentSaid: [] });

/** The phase the screen shows (waiting on the transcriber looks like thinking) */
export const shownPhase = (s: TurnState): "connecting" | "listening" | "thinking" | "speaking" => (s.phase === "committing" ? "thinking" : s.phase);

/** Whether the microphone's audio goes to the transcriber now */
export const hasFloor = (s: TurnState) => !s.muted && (s.phase === "listening" || s.phase === "committing" || s.phase === "thinking");

/** Whether Send has something to send */
export const canSend = (s: TurnState) => s.phase === "listening" && Boolean(s.heard.trim() || s.carry.trim());

/**
 * "Answer now" when the call seems stuck (listening and nothing caught, or thinking too long): the words the agent gets
 * instead, so it answers from what it has. With words heard, Send is used instead (null).
 */
export function forcedTurn(s: Pick<TurnState, "phase" | "heard" | "carry" | "last">): string | null {
  if (s.phase === "connecting" || s.phase === "speaking") return null;
  if (canSend(s as TurnState)) return null;
  const last = s.last?.said?.replace(/\s+/g, " ").trim().slice(0, 400) ?? "";
  return last
    ? `[Answer now] I'm waiting on you. Answer what I last said ("${last}") now, or ask me one short question if you didn't catch it.`
    : "[Answer now] I'm waiting on you. Answer from what you've heard so far, or ask me one short question.";
}

/** Whether an answer's event or sentence belongs to the turn being answered (null: the greeting, always played) */
export const isCurrent = (s: TurnState, turn: number | null) => turn === null || turn === s.asking;

const clean = (x: string) => x.replace(/\s+/g, " ").trim();
const join = (...xs: string[]) => clean(xs.join(" "));

/**
 * What a turn sends and shows: a cut-off turn being sent again (`resend`, already on screen), words held from before
 * (`carry`) and what was just heard. Only what's new is shown. Null when there's nothing to send.
 */
export function turnToSend(s: { resend: string; carry: string; heard: string }): { said: string; shown: string | null } | null {
  const heard = /^[\s.,!?]*$/.test(s.heard) ? "" : clean(s.heard);
  const fresh = join(s.carry, heard);
  const said = join(s.resend, fresh);
  if (!said) return null;
  return { said, shown: fresh || null };
}

const words = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/**
 * Whether what was heard is just the agent's own voice coming back through the speakers (after unmuting, or a speaker
 * without echo cancelling): three words or more, nearly all of them from what it just said.
 */
export function isEcho(heard: string, agentSaid: readonly string[]): boolean {
  const w = words(heard);
  if (w.length < 3 || !agentSaid.length) return false;
  const theirs = new Set(agentSaid.flatMap(words));
  const hits = w.filter((x) => theirs.has(x)).length;
  return hits / w.length >= 0.8;
}

/**
 * The words safety net: the transcriber has words for this turn, yet the level detector never said it ended (the room
 * got louder, or quieter, than it learned). No new words for this long ends the turn anyway: a little longer than
 * the normal pause when it doesn't think anyone is talking, longer still when it thinks sound is still coming (a fan,
 * not a person, since no new words arrive).
 */
export function wordsStalled(s: { heard: string; sinceWordsMs: number; speaking: boolean }, pauseMs = 1600): boolean {
  if (!s.heard.trim()) return false;
  return s.sinceWordsMs >= (s.speaking ? pauseMs + 2000 : pauseMs + 500);
}

type Out = { state: TurnState; effects: TurnEffect[] };

function startCommit(s: TurnState, fx: TurnEffect[]): TurnState {
  if (s.commit !== null) return { ...s, phase: "committing", again: true };
  const n = s.next;
  fx.push({ do: "commit", commit: n });
  return { ...s, phase: "committing", commit: n, next: n + 1 };
}

function ask(s: TurnState, said: string, frame: string | null, fx: TurnEffect[], retry = false): TurnState {
  const n = s.next;
  fx.push({ do: "ask", turn: n, said, frame }, { do: "watch", on: true, retry });
  const long = !retry && said.length >= LONG_TURN_CHARS;
  const stall: StallState = retry ? "slow" : long ? "long" : null;
  if (stall !== s.stall) fx.push({ do: "stall", state: stall });
  return { ...s, phase: "thinking", asking: n, next: n + 1, last: { said, frame }, stall };
}

function clearStall(s: TurnState, fx: TurnEffect[]): TurnState {
  if (s.stall === null) return s;
  fx.push({ do: "stall", state: null });
  return { ...s, stall: null };
}

/** Back to listening with a clean slate (after an answer, a give-up, or a turn that had nothing in it) */
function toListening(s: TurnState, fx: TurnEffect[]): TurnState {
  fx.push({ do: "ears_reset" }, { do: "detector_reset" });
  if (s.heard) fx.push({ do: "partial", text: "" });
  return { ...s, phase: "listening", asking: null, heard: "", manual: false };
}

export function stepTurns(s: TurnState, e: TurnInput): Out {
  const fx: TurnEffect[] = [];
  switch (e.t) {
    case "ready":
      // Picked up: the greeting plays (speaking comes with its first sound); listening until then
      return { state: s.phase === "connecting" ? { ...s, phase: "listening" } : s, effects: fx };

    case "partial": {
      if (s.muted || s.phase === "speaking" || s.phase === "connecting") return { state: s, effects: fx };
      if (e.text === s.heard) return { state: s, effects: fx };
      fx.push({ do: "partial", text: e.text });
      return { state: { ...s, heard: e.text }, effects: fx };
    }

    case "speech_start": {
      if (s.muted) return { state: s, effects: fx };
      // They carried on talking while the answer was coming: it stops, and the turn already sent goes again with
      // what they add (never lost, never shown twice). A turn sent on purpose isn't cancelled by noise.
      if (s.phase === "thinking" && !s.manual) {
        fx.push({ do: "stop_agent" }, { do: "watch", on: false });
        let next: TurnState = { ...s, phase: "listening", asking: null, resend: s.last && s.asking !== null ? join(s.resend, s.last.said) : s.resend };
        next = clearStall(next, fx);
        return { state: next, effects: fx };
      }
      // Still waiting on the words of the turn: listening again, those words wait for the end of this one
      if (s.phase === "committing" && !s.manual) return { state: { ...s, phase: "listening" }, effects: fx };
      return { state: s, effects: fx };
    }

    case "turn_end":
      if (s.muted || s.phase !== "listening") return { state: s, effects: fx };
      return { state: startCommit(s, fx), effects: fx };

    case "send":
      if (!canSend(s)) return { state: s, effects: fx };
      fx.push({ do: "detector_reset" });
      return { state: startCommit({ ...s, manual: true }, fx), effects: fx };

    case "barge_in": {
      if (s.muted || s.phase !== "speaking") return { state: s, effects: fx };
      fx.push({ do: "stop_agent" }, { do: "watch", on: false }, { do: "ears_reset" }, { do: "ears_preroll" });
      return { state: { ...s, phase: "listening", asking: null, heard: "", manual: false }, effects: fx };
    }

    case "mute": {
      if (s.muted) return { state: s, effects: fx };
      let next: TurnState = { ...s, muted: true };
      fx.push({ do: "detector_reset" });
      // Muting mid-sentence: what was heard so far goes as a finished turn. Nothing heard: the slate is cleaned.
      if (muteTurn({ phase: s.phase, heard: s.heard, carry: s.carry, speaking: e.speaking }) === "send") next = startCommit(next, fx);
      else if (s.phase === "listening" && s.commit === null) {
        fx.push({ do: "ears_reset" });
        if (s.heard) fx.push({ do: "partial", text: "" });
        next = { ...next, heard: "" };
      }
      fx.push({ do: "ears_pause", on: true });
      return { state: next, effects: fx };
    }

    case "unmute": {
      if (!s.muted) return { state: s, effects: fx };
      let next: TurnState = { ...s, muted: false };
      fx.push({ do: "ears_pause", on: false }, { do: "ears_wake" }, { do: "detector_relearn" });
      // Listening fresh, unless the words of the turn sent on mute are still on their way (they'd be wiped)
      if (s.phase === "listening" && s.commit === null) {
        fx.push({ do: "ears_reset" });
        if (s.heard) fx.push({ do: "partial", text: "" });
        next = { ...next, heard: "" };
      }
      return { state: next, effects: fx };
    }

    case "heard": {
      // Only the latest commit's words count
      if (e.commit !== s.commit) return { state: s, effects: fx };
      const text = isEcho(e.text, s.agentSaid) ? "" : e.text;
      let next: TurnState = { ...s, commit: null };
      if (s.again) {
        next = { ...next, again: false, carry: join(s.carry, text), heard: "" };
        if (s.heard) fx.push({ do: "partial", text: "" });
        return { state: startCommit(next, fx), effects: fx };
      }
      // They went back to talking while the words came: kept for the end of this turn
      if (s.phase !== "committing") return { state: { ...next, carry: join(s.carry, text) }, effects: fx };
      const send = turnToSend({ resend: s.resend, carry: s.carry, heard: text });
      next = { ...next, carry: "", resend: "", heard: "" };
      if (s.heard) fx.push({ do: "partial", text: "" });
      if (!send) return { state: toListening(next, fx), effects: fx };
      if (send.shown) fx.push({ do: "line", text: send.shown });
      return { state: ask(next, send.said, null, fx), effects: fx };
    }

    case "typed":
    case "inject": {
      const text = clean(e.text);
      if (!text || s.phase === "connecting") return { state: s, effects: fx };
      if (s.phase === "thinking" || s.phase === "speaking") fx.push({ do: "stop_agent" }, { do: "watch", on: false });
      fx.push({ do: "ears_reset" }, { do: "detector_reset" });
      if (s.heard) fx.push({ do: "partial", text: "" });
      fx.push({ do: "line", text: e.t === "typed" ? text : e.shown });
      // A commit still out is dropped (its words would come after this turn)
      const next: TurnState = { ...s, commit: null, again: false, carry: "", resend: "", heard: "", manual: e.t === "typed", asking: null };
      return { state: ask(next, text, e.t === "inject" ? e.frame : null, fx), effects: fx };
    }

    case "audio": {
      if (!isCurrent(s, e.turn)) return { state: s, effects: fx };
      fx.push({ do: "watch", on: false });
      const next = clearStall({ ...s, phase: "speaking" }, fx);
      return { state: next, effects: fx };
    }

    case "idle": {
      // The answer has played (or had nothing to say): their turn
      if (s.phase !== "speaking" && s.phase !== "thinking") return { state: s, effects: fx };
      fx.push({ do: "watch", on: false });
      return { state: toListening(clearStall(s, fx), fx), effects: fx };
    }

    case "agent_line":
      return { state: { ...s, agentSaid: [...s.agentSaid, e.text].slice(-3) }, effects: fx };

    case "slow": {
      // No first word in time: tried once more, quietly
      if (s.phase !== "thinking" || s.asking === null || !s.last) return { state: s, effects: fx };
      fx.push({ do: "stop_agent" });
      return { state: ask(s, s.last.said, s.last.frame, fx, true), effects: fx };
    }

    case "failed": {
      if (s.phase !== "thinking") return { state: s, effects: fx };
      fx.push({ do: "stop_agent" }, { do: "watch", on: false }, { do: "stall", state: "failed" });
      return { state: toListening({ ...s, stall: "failed" }, fx), effects: fx };
    }

    case "retry": {
      if (!s.last || s.phase !== "listening" || s.commit !== null) return { state: s, effects: fx };
      return { state: ask(s, s.last.said, s.last.frame, fx), effects: fx };
    }
  }
}

// ─── The words of a turn, as the transcriber sends them ─────────────────────

/** A long monologue is committed in pieces: at a pause after this long, or regardless after the hard limit */
export const CHECKPOINT = { atPauseMs: 20_000, hardMs: 45_000, quietLevel: 0.012 };

/** Whether to commit what's been said so far mid-turn (so a two to five minute monologue is never cut or dropped) */
export function shouldCheckpoint(s: { uncommittedMs: number; level: number }): boolean {
  return s.uncommittedMs >= CHECKPOINT.hardMs || (s.uncommittedMs >= CHECKPOINT.atPauseMs && s.level < CHECKPOINT.quietLevel);
}

/**
 * The words of one turn from a realtime transcriber with manual commits: committed pieces in order, then the live
 * partial. Commits out and not back yet are counted, so the end of a turn waits for all of them. Forgetting a turn
 * (the agent's own voice, a turn already sent) throws away anything still coming back for it. A dropped connection
 * keeps what was heard.
 */
export function createTranscript() {
  let committed: string[] = [];
  let partial = "";
  let inflight = 0;
  let discard = 0;
  /** What the last turn was sent as, after a wait that ran out: a commit for it arriving late is not new words */
  let lateFor = "";
  let expired = false;
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const text = () => [...committed, partial].join(" ").replace(/\s+/g, " ").trim();
  return {
    /** A commit was sent */
    sent() {
      inflight++;
    },
    /** A live partial for the audio since the last commit (false: ignored, it belongs to a forgotten turn) */
    partial(t: string): boolean {
      if (discard > 0) return false;
      partial = t;
      return true;
    },
    /** A commit came back with its words (false: thrown away) */
    committed(t: string): boolean {
      const expected = inflight > 0;
      inflight = Math.max(0, inflight - 1);
      partial = "";
      if (discard > 0) {
        discard--;
        return false;
      }
      // A commit nobody is waiting on, with words the last turn already sent (its wait ran out and it went with the
      // live words): the same sentence again, which used to come back as the person's next turn word for word
      if (!expected && lateFor && t.trim() && lateFor.includes(norm(t))) return false;
      if (t.trim()) committed.push(t.trim());
      return true;
    },
    get text() {
      return text();
    },
    /** Every commit sent has come back */
    get settled() {
      return inflight === 0;
    },
    /** The turn's words, and a clean slate */
    take(): string {
      const t = text();
      // Commits still out when the turn is taken (the wait ran out) may come back late with these same words
      lateFor = inflight > 0 || expired ? norm(t) : "";
      expired = false;
      committed = [];
      partial = "";
      return t;
    },
    /**
     * Forget this turn. True when the transcriber still holds words for it (the caller sends a commit so they come
     * back and are thrown away rather than turning up in the next turn).
     */
    forget(): boolean {
      const has = partial.trim() !== "";
      committed = [];
      partial = "";
      if (has) inflight++;
      discard = inflight;
      return has;
    },
    /** The connection dropped: the words heard so far are kept, nothing more is coming for the commits that were out */
    lost() {
      if (partial.trim() && discard === 0) committed.push(partial.trim());
      partial = "";
      inflight = 0;
      discard = 0;
    },
    /** Waited long enough: whatever didn't come back isn't coming */
    expire() {
      if (inflight > 0) expired = true;
      inflight = 0;
      discard = 0;
    },
  };
}
