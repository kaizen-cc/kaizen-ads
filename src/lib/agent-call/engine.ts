import { downsample, createTurnDetector, createTurnWatchdog, rms, splitSpeakable, toPcm16, type CallCard, type CallEvent, type CallProgress, type LearnedItem, type StallState, type UploadAsk } from "./core";
import { canSend, createTranscript, hasFloor, initialTurns, isCurrent, shouldCheckpoint, showWithoutVoice, shownPhase, stepTurns, wordsStalled, type TurnEffect, type TurnInput, type TurnState, forcedTurn, turnCapped } from "./turns";
import type { CallContext } from "./call-context";
import { initialAway, stepAway, type AwayEffect, type AwayEvent, type AwayState } from "./away";
import { AUDIO_PART_SECONDS } from "@/lib/assistant/core";
import type { JobView } from "@/lib/assistant/team";
import { renewSttToken } from "@/app/(team)/settings/call-actions";

// The live call itself: the microphone, turn taking, listening, the agent's answers and its voice. It knows nothing
// about screens; the call provider (src/components/agent-call-provider.tsx) owns one of these and both ways of
// showing it (the full screen on phones, the huddle on computers) read the same state.
// The microphone streams to ElevenLabs realtime speech to text (or the browser's own listening where that's all
// there is); a pause ends your turn (or Send, or a typed turn); the agent's answer streams from Claude and is spoken
// sentence by sentence as it arrives; talking over it stops it. Whose turn it is lives in a plain state machine
// (turns.ts): this file only carries out what it says, so mute, Send and stale answers behave the same every time.

/** A turn's last words are waited on at most this long (the transcriber's own wait is shorter); then the words shown go */
const END_TURN_TIMEOUT_MS = 6000;

export type Phase = "connecting" | "listening" | "thinking" | "speaking";
/** A line of the call; `speaker` names the agent that said it when more than one is on the line */
export type Line = { id: number; who: "you" | "agent"; text: string; speaker?: { role: string; label: string; icon: string } };

/** Who is speaking now (an assistant call can have a specialist on the line) */
export type Speaker = { role: string; label: string; icon: string };

/** What the hidden debug overlay shows (?calldebug=1) */
export type CallDebug = { phase: string; muted: boolean; ears: string; noise: number; threshold: number; level: number; speaking: boolean; commit: number | null; asking: number | null; heard: number; stall: StallState; queue: number; timing: string | null; voice: string | null; client: string | null };

export const STT_RATE = 16000;
/** Audio kept from just before someone starts talking over the agent, so their first words aren't lost */
const PRE_ROLL_SAMPLES = STT_RATE / 2;
/** How much audio goes to speech to text in one message (100ms) */
const SEND_SAMPLES = STT_RATE / 10;
/** The longest wait for the transcriber's last words of a turn */
const END_TURN_WAIT_MS = 2500;
/** A sentence's voice that hasn't arrived in this long is skipped (the call never hangs on one) */
const SPEAK_TIMEOUT_MS = 15_000;
/** Keep-alive pings count as progress for the stall watch only this long into a turn */
const PING_PROGRESS_MS = 45_000;

export const WORKLET = `class KzTap extends AudioWorkletProcessor { process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; } } registerProcessor("kz-tap", KzTap);`;

const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

// ─── Listening ──────────────────────────────────────────────────────────────

/** What turns speech into text for the call: ElevenLabs realtime, or the browser's own */
export interface Ears {
  readonly kind: "scribe" | "browser";
  /** Where the connection stands, for the debug overlay */
  readonly state: string;
  /** Audio at 16kHz while the person has the floor */
  feed(samples: Float32Array): void;
  /** Their turn is over: everything they said in it */
  endTurn(): Promise<string>;
  /** Forget what was heard (the agent's own voice, or a turn already sent) */
  reset(): void;
  /** Muted: stop hearing (the browser's own listening has its own microphone); unmuted: hear again */
  pause(on: boolean): void;
  /** Unmuted: reconnect if the connection dropped meanwhile */
  wake(): void;
  close(): void;
}

export type SpeechRec = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
};

export function browserSpeech(): (new () => SpeechRec) | null {
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * ElevenLabs Scribe over a WebSocket, opened with the single-use token the server minted (the key never leaves it).
 * Long turns are committed in pieces at natural pauses and joined in order; a quiet line gets a tiny keep-alive; a
 * dropped connection gets a new token and reconnects (backing off, and only falling back to the browser's own
 * listening after several failures in a row), keeping the words heard so far.
 */
export function scribeEars(token: string, opts: { onPartial: (t: string) => void; onLost: () => void; renew: () => Promise<string | null> }): Ears {
  const words = createTranscript();
  let pending: number[] = [];
  let waiting: (() => void) | null = null;
  let closed = false;
  let ws: WebSocket | null = null;
  let failures = 0;
  let openedAt = 0;
  let reconnecting = false;
  let lastSent = Date.now();
  let uncommitted = 0;
  /** Messages made while connecting, sent once it's open (a few seconds at most) */
  let backlog: string[] = [];

  const settle = () => {
    if (words.settled) waiting?.();
  };
  const open = (t: string) => {
    const sock = new WebSocket(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&token=${encodeURIComponent(t)}&audio_format=pcm_16000&commit_strategy=manual&language_code=en`);
    ws = sock;
    sock.onopen = () => {
      openedAt = Date.now();
      for (const m of backlog) sock.send(m);
      backlog = [];
    };
    sock.onmessage = (m) => {
      if (ws !== sock) return;
      let e: { message_type?: string; text?: string; error?: string };
      try {
        e = JSON.parse(String(m.data));
      } catch {
        return;
      }
      if (e.message_type === "partial_transcript") {
        if (words.partial(e.text ?? "")) opts.onPartial(words.text);
      } else if (e.message_type === "committed_transcript") {
        if (words.committed(e.text ?? "")) opts.onPartial(words.text);
        settle();
      } else if (e.error) console.warn("[call] speech to text:", e.message_type, e.error);
    };
    sock.onclose = () => {
      if (closed || ws !== sock) return;
      ws = null;
      // What was heard stays; a turn waiting on its last words goes ahead with them
      words.lost();
      waiting?.();
      // A connection that lived a while was fine: only drops in a row count against it
      if (Date.now() - openedAt > 10_000) failures = 0;
      failures++;
      void reconnect();
    };
  };
  const reconnect = async () => {
    if (closed || reconnecting) return;
    if (failures > 4) return opts.onLost();
    reconnecting = true;
    if (failures > 1) await new Promise((r) => setTimeout(r, 600 * failures));
    const nt = await opts.renew().catch(() => null);
    reconnecting = false;
    if (closed) return;
    if (nt) open(nt);
    else if (++failures > 4) opts.onLost();
    else void reconnect();
  };
  open(token);

  const send = (samples: ArrayLike<number>, commit: boolean) => {
    const msg = JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: b64(toPcm16(samples)), commit, sample_rate: STT_RATE });
    lastSent = Date.now();
    if (commit) {
      words.sent();
      uncommitted = 0;
    } else uncommitted += samples.length;
    if (ws?.readyState === WebSocket.OPEN) ws.send(msg);
    else if (ws?.readyState === WebSocket.CONNECTING && backlog.length < 40) backlog.push(msg);
    // Nowhere to send it: a commit is counted back at once, so nothing waits on it
    else if (commit) words.committed("");
  };
  // A quiet line (muted, or a long answer) gets a tenth of a second of silence now and then, so it isn't closed
  const keepAlive = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN && Date.now() - lastSent > 8000) send(new Array(SEND_SAMPLES).fill(0), false);
  }, 4000);

  return {
    kind: "scribe",
    get state() {
      return ws ? ["connecting", "open", "closing", "closed"][ws.readyState] : reconnecting ? "reconnecting" : "closed";
    },
    feed(samples) {
      for (let i = 0; i < samples.length; i++) pending.push(samples[i]);
      if (pending.length >= SEND_SAMPLES) {
        // A long monologue: committed in pieces at a pause, so nothing is cut or dropped
        const checkpoint = shouldCheckpoint({ uncommittedMs: ((uncommitted + pending.length) / STT_RATE) * 1000, level: rms(pending) });
        send(pending, checkpoint);
        pending = [];
      }
    },
    async endTurn() {
      // Whatever is left, with a commit: Scribe sends the final words of the turn back (all pieces, in order)
      send(pending.length ? pending : new Array(160).fill(0), true);
      pending = [];
      if (!words.settled)
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            words.expire();
            resolve();
          }, END_TURN_WAIT_MS);
          waiting = () => {
            clearTimeout(t);
            resolve();
          };
        });
      waiting = null;
      return words.take();
    },
    reset() {
      pending = [];
      // Words still on the server for this turn are committed and thrown away, so they never start the next one
      if (words.forget()) {
        uncommitted = 0;
        lastSent = Date.now();
        const msg = JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: b64(toPcm16(new Array(160).fill(0))), commit: true, sample_rate: STT_RATE });
        if (ws?.readyState === WebSocket.OPEN) ws.send(msg);
        else words.expire();
        setTimeout(() => words.expire(), END_TURN_WAIT_MS);
      }
    },
    pause() {},
    wake() {
      // Back from a mute or from the background: drops while away don't count against it
      if (closed || reconnecting) return;
      if (!ws || ws.readyState === WebSocket.CLOSED) {
        failures = 0;
        void reconnect();
      }
    },
    close() {
      closed = true;
      clearInterval(keepAlive);
      try {
        ws?.close();
      } catch {
        // already closed
      }
    },
  };
}

/**
 * The browser's own speech recognition (Chrome, Edge, Safari): the fallback when ElevenLabs can't be reached. It
 * stops on its own every minute or so: what was heard before it stopped is kept for the turn (it used to be lost).
 * It listens with its own microphone, so muting stops it.
 */
export function browserEars(Rec: new () => SpeechRec, opts: { onPartial: (t: string) => void }): Ears {
  const rec = new Rec();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = navigator.language || "en-US";
  let results: { isFinal: boolean; text: string }[] = [];
  let from = 0;
  let banked = "";
  let closed = false;
  let paused = false;
  let running = false;
  let waiting: (() => void) | null = null;
  const current = () =>
    results
      .slice(from)
      .map((r) => r.text)
      .join(" ");
  const text = () => `${banked} ${current()}`.replace(/\s+/g, " ").trim();
  const start = () => {
    if (running || closed || paused) return;
    try {
      rec.start();
      running = true;
    } catch {
      // already starting
    }
  };
  rec.onresult = (e) => {
    results = Array.from({ length: e.results.length }, (_, i) => ({ isFinal: e.results[i].isFinal, text: e.results[i][0].transcript }));
    opts.onPartial(text());
    if (results.slice(from).every((r) => r.isFinal)) waiting?.();
  };
  rec.onend = () => {
    running = false;
    // What it heard before stopping is kept for the turn
    banked = text();
    results = [];
    from = 0;
    waiting?.();
    start();
  };
  rec.onerror = (e) => e.error !== "no-speech" && e.error !== "aborted" && console.warn("[call] browser listening:", e.error);
  start();
  return {
    kind: "browser",
    get state() {
      return paused ? "paused" : running ? "listening" : "restarting";
    },
    feed() {},
    async endTurn() {
      // A moment for the last words to be final
      if (!results.slice(from).every((r) => r.isFinal))
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 700);
          waiting = () => {
            clearTimeout(t);
            resolve();
          };
        });
      waiting = null;
      const said = text();
      banked = "";
      from = results.length;
      return said;
    },
    reset() {
      banked = "";
      from = results.length;
    },
    pause(on) {
      paused = on;
      if (on) {
        try {
          rec.stop();
        } catch {
          // already stopped
        }
      } else start();
    },
    wake() {
      start();
    },
    close() {
      closed = true;
      try {
        rec.stop();
      } catch {
        // already stopped
      }
    },
  };
}

// ─── The call ───────────────────────────────────────────────────────────────

export type Hooks = {
  onPhase: (p: Phase) => void;
  onLine: (l: Line) => void;
  onPartial: (t: string) => void;
  onLearned: (items: LearnedItem[]) => void;
  onError: (msg: string) => void;
  onEars: (kind: "scribe" | "browser") => void;
  /** A long turn was sent, an answer is slow (retrying), or it didn't go through (null: all well) */
  onStall?: (s: StallState) => void;
  /** Whether Send has something to send */
  onCanSend?: (can: boolean) => void;
  /** A short note for the person ("Didn't catch that"), shown for a few seconds */
  onHint?: (text: string) => void;
  /** Who else is on the line (specialists joining or leaving) */
  onTeam?: (line: Speaker[]) => void;
  /** The job the call is working on, and its steps (null: none) */
  onJob?: (job: JobView | null) => void;
  /** What the agent is working on now, a step bar while it works (null: done) */
  onProgress?: (p: CallProgress | null) => void;
  /** Open a screen in the app; the call carries on */
  onNavigate?: (href: string) => void;
  /** A link card on the call */
  onCard?: (c: CallCard) => void;
  /** The assistant asked for files */
  onUpload?: (ask: UploadAsk) => void;
  /** The agent wants to see the screen ("take a look") */
  onLook?: () => void;
  /** The agent said goodbye and its last words have played: hang up */
  onEnd?: () => void;
  /** The agent moved the conversation to the chat (or back to a call) and its last words have played */
  onSwitch?: (to: "voice" | "text") => void;
  /** The phone stopped the call's audio while the page was in the background (true), or it's back (false) */
  onAway?: (paused: boolean) => void;
  /** A finished part of the call's recording (both sides), to upload */
  onAudioPart?: (part: { blob: Blob; index: number; startSeconds: number; mime: string }) => void;
};

/**
 * A short tone made right here (no file): a soft rising pair when the call connects, a pleasant falling pair when it
 * ends (whoever hangs up). Its own audio context, so it plays after the call's is closed.
 */
export function chime(kind: "connect" | "end") {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    const notes = kind === "end" ? [659.25, 493.88] : [523.25, 659.25];
    const t0 = ctx.currentTime + 0.02;
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      const at = t0 + i * 0.16;
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(kind === "end" ? 0.16 : 0.1, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.32);
      o.connect(g).connect(ctx.destination);
      o.start(at);
      o.stop(at + 0.34);
    });
    setTimeout(() => void ctx.close().catch(() => undefined), 900);
  } catch {
    // No sound: the call still ends
  }
}

type Queued = { text: string; audio: Promise<AudioBuffer | null>; speaker: Speaker | null; turn: number | null; voiceFailed: () => boolean };

/** Everything a live call runs: the microphone, turn taking, listening, the agent's answers and its voice */
export class Call {
  private ctx: AudioContext;
  private out: AnalyserNode;
  private mic: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private ears: Ears | null = null;
  private detector = createTurnDetector();
  private st: TurnState = initialTurns();
  private closed = false;
  private preRoll: number[] = [];
  private frame: number[] = [];
  private turn: AbortController | null = null;
  private voice: AbortController | null = null;
  private queue: Queued[] = [];
  /** Who the next words are from (set by the turn's speaker events) */
  private speaker: Speaker | null = null;
  /** The agent said goodbye: hang up once the queue has played */
  private ending = false;
  /** The agent is moving the conversation to the chat: once the queue has played */
  private switching: "voice" | "text" | null = null;
  private recorder: MediaRecorder | null = null;
  private recDest: MediaStreamAudioDestinationNode | null = null;
  private recTimer: ReturnType<typeof setTimeout> | null = null;
  private recIndex = 0;
  private recStarted = 0;
  private playing: AudioBufferSourceNode | null = null;
  private streamDone = true;
  private lineId = 0;
  private wake: { release: () => Promise<void> } | null = null;
  /** When the words of this turn last changed (the words safety net) */
  private wordsAt = 0;
  /** When this turn's first words came (for the hard cap) */
  private firstWordsAt = 0;
  /** What ended the turn being sent (logged with it: how often the safety nets catch a stuck turn) */
  private endedBy: "pause" | "stall" | "cap" | "button" = "pause";
  /** The sentence before this one in the same answer, so the voice carries on smoothly from it */
  private lastSentence = "";
  /** Where the last turn's time went: the server's line, the first sentence's voice, and what the call itself saw */
  private timing: { server: string | null; voice: string | null; firstText: number | null; sentAt: number; firstAudio: number | null } = { server: null, voice: null, firstText: null, sentAt: 0, firstAudio: null };
  private watch = createTurnWatchdog({ onSlow: () => this.dispatch({ t: "slow" }), onGiveUp: () => this.dispatch({ t: "failed" }) });
  private canSendNow = false;
  /** The microphone's source in the audio graph (opened again after the phone takes it away) */
  private src: MediaStreamAudioSourceNode | null = null;
  /** Switching apps, tabs and windows (away.ts) */
  private awayState: AwayState = initialAway();
  /** The latest loudness, mic or voice, for the waveform */
  level = 0;
  /** Set once the server has opened the call */
  callId = "";
  /** Where they called from (a client, a report, a Kaizen AI thread): sent with every turn */
  context: CallContext | null = null;

  constructor(private hooks: Hooks) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC();
    this.out = this.ctx.createAnalyser();
    this.out.fftSize = 512;
    this.out.connect(this.ctx.destination);
    // The audio engine stopping (a phone in the background, another app taking the audio) and starting again
    this.ctx.onstatechange = () => this.awayEvent({ t: "audio", state: this.ctx.state as string, at: Date.now() });
  }

  // ─── Away: other apps, tabs and windows ─────────────────────────────────

  /** The page went out of sight (hidden: true) or came back */
  setAway(hidden: boolean) {
    this.awayEvent({ t: hidden ? "hidden" : "visible", at: Date.now() });
  }

  private awayEvent(e: AwayEvent) {
    if (this.closed) return;
    const { state, effects } = stepAway(this.awayState, e);
    this.awayState = state;
    for (const fx of effects) this.awayEffect(fx);
  }

  private awayEffect(fx: AwayEffect) {
    switch (fx) {
      case "resume_audio":
        return void this.ctx.resume().catch(() => undefined);
      case "wake_ears":
        return this.ears?.wake();
      case "restart_mic":
        return void this.restartMic();
      case "drop_half_heard":
        // What was half heard before the switch never becomes a turn; the agent says nothing about it
        this.ears?.reset();
        this.detector.reset();
        this.preRoll = [];
        this.frame = [];
        if (this.st.phase === "listening" && this.st.heard) this.partial("");
        return;
      case "relearn_noise":
        return this.detector.relearn();
      case "rewake":
        return void this.keepAwake();
      case "show_paused":
        return this.hooks.onAway?.(true);
      case "clear_paused":
        return this.hooks.onAway?.(false);
    }
  }

  /** The microphone again, after the phone took it (the same graph: the tap, the recording) */
  private async restartMic() {
    if (this.closed || !this.node) return;
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (this.closed) return void mic.getTracks().forEach((t) => t.stop());
      this.mic?.getTracks().forEach((t) => t.stop());
      try {
        this.src?.disconnect();
      } catch {
        // already gone
      }
      this.mic = mic;
      this.watchMic(mic);
      mic.getAudioTracks().forEach((t) => (t.enabled = !this.st.muted));
      this.src = this.ctx.createMediaStreamSource(mic);
      this.src.connect(this.node);
      if (this.recDest) this.src.connect(this.recDest);
    } catch {
      this.hooks.onError("The microphone stopped while you were away. Tap the mic or hang up and call again.");
    }
  }

  private watchMic(mic: MediaStream) {
    for (const t of mic.getAudioTracks()) t.onended = () => mic === this.mic && this.awayEvent({ t: "mic_ended", at: Date.now() });
  }

  /** Keeps the screen on during the call (the browser lets go of it in the background; asked again on return) */
  private async keepAwake() {
    if (this.closed) return;
    try {
      await this.wake?.release().catch(() => undefined);
      this.wake = (await (navigator as unknown as { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request("screen")) ?? null;
    } catch {
      // The screen may sleep; the call goes on
    }
  }

  // ─── Turns ──────────────────────────────────────────────────────────────

  private dispatch(e: TurnInput) {
    if (this.closed) return;
    const before = shownPhase(this.st);
    const { state, effects } = stepTurns(this.st, e);
    this.st = state;
    const after = shownPhase(state);
    if (after !== before) this.hooks.onPhase(after);
    for (const fx of effects) this.run(fx);
    const can = canSend(state);
    if (can !== this.canSendNow) {
      this.canSendNow = can;
      this.hooks.onCanSend?.(can);
    }
  }

  private run(fx: TurnEffect) {
    switch (fx.do) {
      case "commit": {
        const ears = this.ears;
        if (!ears) return this.dispatch({ t: "heard", commit: fx.commit, text: "" });
        // Never waits forever: a transcriber that fails or never answers ends the turn with the words already shown
        void Promise.race([ears.endTurn(), new Promise<string>((r) => setTimeout(() => r(""), END_TURN_TIMEOUT_MS))])
          .catch(() => "")
          .then((text) => this.dispatch({ t: "heard", commit: fx.commit, text }));
        return;
      }
      case "ask":
        return void this.ask(fx.turn, fx.said, fx.frame);
      case "stop_agent":
        return this.stopAgent();
      case "line":
        return this.hooks.onLine({ id: ++this.lineId, who: "you", text: fx.text });
      case "partial":
        return this.hooks.onPartial(fx.text);
      case "ears_reset":
        return this.ears?.reset();
      case "ears_pause":
        return this.ears?.pause(fx.on);
      case "ears_wake":
        return this.ears?.wake();
      case "ears_preroll":
        return this.ears?.feed(Float32Array.from(this.preRoll));
      case "detector_reset":
        return this.detector.reset();
      case "detector_relearn":
        return this.detector.relearn();
      case "stall":
        return this.hooks.onStall?.(fx.state);
      case "nothing_heard":
        return this.hooks.onHint?.("Didn't catch that. Try again, or type it.");
      case "watch":
        return fx.on ? this.watch.begin(fx.retry) : this.watch.stop();
    }
  }

  /** On the tap itself: phones only let a page play sound it started from a tap, so a silent blip unlocks it */
  prime() {
    void this.ctx.resume().catch(() => undefined);
    const blip = this.ctx.createBufferSource();
    blip.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
    blip.connect(this.ctx.destination);
    blip.start();
  }

  /** Starts on the Call press (browsers only play and record after a tap) */
  async open(greeting: string, sttToken: string | null) {
    await this.ctx.resume();
    this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    this.watchMic(this.mic);
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const src = this.ctx.createMediaStreamSource(this.mic);
    this.src = src;
    this.node = new AudioWorkletNode(this.ctx, "kz-tap");
    this.node.port.onmessage = (e: MessageEvent<Float32Array>) => this.onAudio(e.data);
    // Kept running through a muted output, so the microphone is read without being heard
    const silent = this.ctx.createGain();
    silent.gain.value = 0;
    src.connect(this.node).connect(silent).connect(this.ctx.destination);
    // The recording (people are told before their first call): the microphone and the agent's voice together
    if (this.hooks.onAudioPart && typeof MediaRecorder !== "undefined") {
      this.recDest = this.ctx.createMediaStreamDestination();
      src.connect(this.recDest);
      this.out.connect(this.recDest);
      this.recStarted = Date.now();
      this.recordPart();
    }
    this.listenWith(sttToken);
    await this.keepAwake();
    this.dispatch({ t: "ready" });
    // Picks up: the greeting, in its voice
    this.streamDone = false;
    this.voice = new AbortController();
    this.lastSentence = "";
    this.say(greeting, null);
    this.streamDone = true;
    void this.drain();
  }

  /** One part of the recording: a whole file of its own, a couple of minutes long, then the next */
  private recordPart() {
    if (!this.recDest || this.closed) return;
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported?.(m)) ?? "";
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(this.recDest.stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
    } catch {
      return;
    }
    const index = this.recIndex++;
    const startSeconds = Math.round((Date.now() - this.recStarted) / 1000);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    rec.onstop = () => {
      if (chunks.length) this.hooks.onAudioPart?.({ blob: new Blob(chunks, { type: rec.mimeType || mime || "audio/webm" }), index, startSeconds, mime: rec.mimeType || mime || "audio/webm" });
    };
    rec.start();
    this.recorder = rec;
    this.recTimer = setTimeout(() => {
      rec.stop();
      this.recordPart();
    }, AUDIO_PART_SECONDS * 1000);
  }

  private listenWith(token: string | null) {
    const Rec = browserSpeech();
    const fallback = () => {
      if (this.closed) return;
      if (!Rec) return this.hooks.onError("Listening dropped and this browser can't listen on its own. Hang up and call again.");
      this.ears?.close();
      this.ears = browserEars(Rec, { onPartial: (t) => this.partial(t) });
      if (this.st.muted) this.ears.pause(true);
      this.hooks.onEars("browser");
    };
    if (token) {
      this.ears = scribeEars(token, {
        onPartial: (t) => this.partial(t),
        onLost: fallback,
        renew: async () => {
          const r = await renewSttToken(this.callId);
          return r.ok ? r.token : null;
        },
      });
      this.hooks.onEars("scribe");
    } else if (Rec) {
      this.ears = browserEars(Rec, { onPartial: (t) => this.partial(t) });
      this.hooks.onEars("browser");
    } else this.hooks.onError("This browser can't listen. Use Chrome, Edge or Safari.");
  }

  private partial(t: string) {
    if (t !== this.st.heard) this.wordsAt = performance.now();
    if (t.trim() && !this.st.heard.trim()) this.firstWordsAt = performance.now();
    this.dispatch({ t: "partial", text: t });
  }

  private onAudio(chunk: Float32Array) {
    if (this.closed) return;
    for (let i = 0; i < chunk.length; i++) this.frame.push(chunk[i]);
    // About 20ms at a time for turn taking
    const size = Math.round(this.ctx.sampleRate / 50);
    while (this.frame.length >= size) {
      const f = this.frame.splice(0, size);
      const level = this.st.muted ? 0 : rms(f);
      const speaking = this.st.phase === "speaking";
      if (!speaking) this.level = level;
      const low = downsample(f, this.ctx.sampleRate, STT_RATE);
      for (let i = 0; i < low.length; i++) this.preRoll.push(low[i]);
      if (this.preRoll.length > PRE_ROLL_SAMPLES) this.preRoll.splice(0, this.preRoll.length - PRE_ROLL_SAMPLES);
      if (hasFloor(this.st)) this.ears?.feed(low);
      if (this.st.muted || this.st.phase === "connecting") continue;
      const ev = this.detector.feed(level, 20, speaking);
      if (ev) this.dispatch({ t: ev });
      // The words safety net: the transcriber heard words, the level never said they stopped
      else if (this.st.phase === "listening" && wordsStalled({ heard: this.st.heard, sinceWordsMs: performance.now() - this.wordsAt, speaking: this.detector.speaking })) {
        this.detector.reset();
        this.endedBy = "stall";
        this.dispatch({ t: "turn_end" });
      }
      // The hard cap: words captured and the turn never ending on its own (noise around them)
      else if (this.st.phase === "listening" && turnCapped({ heard: this.st.heard, sinceFirstWordsMs: performance.now() - this.firstWordsAt, sinceWordsMs: performance.now() - this.wordsAt })) {
        this.detector.reset();
        this.endedBy = "cap";
        this.dispatch({ t: "turn_end" });
      }
    }
  }

  private stopAgent() {
    this.turn?.abort();
    this.turn = null;
    this.voice?.abort();
    this.voice = null;
    this.queue = [];
    this.streamDone = true;
    if (this.playing) {
      this.playing.onended = null;
      try {
        this.playing.stop();
      } catch {
        // already stopped
      }
      this.playing = null;
    }
  }

  /** Sends a turn; the answer is spoken sentence by sentence as it's written. Anything from an older turn is ignored */
  private async ask(turnNo: number, said: string, frame: string | null) {
    const turn = new AbortController();
    this.turn = turn;
    this.voice = new AbortController();
    this.streamDone = false;
    this.speaker = null;
    this.lastSentence = "";
    const startedAt = Date.now();
    this.timing = { server: this.timing.server, voice: this.timing.voice, firstText: null, sentAt: startedAt, firstAudio: null };
    let buffer = "";
    const live = () => !turn.signal.aborted && isCurrent(this.st, turnNo);
    try {
      const res = await fetch("/api/agent-call/turn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callId: this.callId, mode: "voice", text: said, ended: this.takeEndedBy(), path: `${window.location.pathname}${window.location.search}`.slice(0, 500), ...(this.context ? { context: this.context } : {}), ...(frame ? { frame } : {}) }), signal: turn.signal });
      if (res.status === 410) return this.hooks.onError("The call has ended.");
      if (!res.ok || !res.body) throw new Error(String(res.status));
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let rest = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done || !live()) break;
        rest += dec.decode(value, { stream: true });
        const lines = rest.split("\n");
        rest = lines.pop() ?? "";
        for (const l of lines) {
          if (!l.trim()) continue;
          let e: CallEvent;
          try {
            e = JSON.parse(l) as CallEvent;
          } catch {
            continue;
          }
          if (e.t !== "ping" || Date.now() - startedAt < PING_PROGRESS_MS) this.watch.progress();
          if (e.t === "text" && this.timing.firstText === null) this.timing.firstText = Date.now() - startedAt;
          if (e.t === "timing") this.timing.server = e.line;
          else if (e.t === "text") {
            buffer += e.d;
            const { ready, rest: left } = splitSpeakable(buffer);
            buffer = left;
            ready.forEach((s) => this.say(s, turnNo));
          } else if (e.t === "learned") this.hooks.onLearned(e.items);
          else if (e.t === "error") this.say(e.message, turnNo);
          else if (e.t === "speaker") {
            // A new voice: what the last one was still writing is said first
            if (buffer.trim()) this.say(buffer.trim(), turnNo);
            buffer = "";
            this.speaker = { role: e.role, label: e.label, icon: e.icon };
            this.lastSentence = "";
          } else if (e.t === "team") this.hooks.onTeam?.(e.line);
          else if (e.t === "job") this.hooks.onJob?.(e.job);
          else if (e.t === "progress") this.hooks.onProgress?.(e.progress);
          else if (e.t === "navigate") this.hooks.onNavigate?.(e.href);
          else if (e.t === "page" && typeof window !== "undefined") window.dispatchEvent(new CustomEvent("kaizen-page", { detail: { name: e.name, detail: e.detail } }));
          else if (e.t === "card") this.hooks.onCard?.(e.card);
          else if (e.t === "upload") this.hooks.onUpload?.(e.ask);
          else if (e.t === "look") this.hooks.onLook?.();
          else if (e.t === "end") this.ending = true;
          else if (e.t === "switch") this.switching = e.to;
        }
      }
      if (live() && buffer.trim()) this.say(buffer.trim(), turnNo);
      this.hooks.onProgress?.(null);
    } catch {
      if (!live()) return;
      this.say("Sorry, I lost the line for a second. Could you say that again?", turnNo);
    } finally {
      if (this.turn === turn) {
        this.turn = null;
        this.streamDone = true;
        void this.drain();
      }
    }
  }

  /** One sentence: its audio is fetched straight away (in parallel with the ones before), played in order, in its speaker's voice */
  private say(text: string, turn: number | null) {
    if (!isCurrent(this.st, turn)) return;
    const outer = this.voice?.signal;
    const speaker = this.speaker;
    const previous = this.lastSentence;
    this.lastSentence = text;
    // Its own timeout, so one slow sentence never holds the call
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), SPEAK_TIMEOUT_MS);
    const onAbort = () => ctl.abort();
    outer?.addEventListener("abort", onAbort, { once: true });
    // The same request again when the voice service fails once: the same text, the same speaker, so the same voice
    // (a sentence is never dropped or said in another voice)
    const body = JSON.stringify({ callId: this.callId, text, ...(previous ? { previous } : {}), ...(speaker ? { role: speaker.role } : {}) });
    const speak = () => fetch("/api/agent-call/speak", { method: "POST", headers: { "content-type": "application/json" }, body, signal: ctl.signal });
    // The voice service failed even on the retry (not a sentence they cut off): the line is still shown, unspoken
    let voiceFailed = false;
    const failed = () => {
      voiceFailed = !outer?.aborted;
      return null;
    };
    const audio = speak()
      .catch((e) => (ctl.signal.aborted ? Promise.reject(e) : speak()))
      .then((r) => (r.ok || r.status === 204 || r.status === 410 || ctl.signal.aborted ? r : speak()))
      .then(async (r) => {
        // The first voice of a turn: how long from sending the turn, and where the speak request's time went
        if (this.timing.firstAudio === null && this.timing.sentAt) {
          this.timing.firstAudio = Date.now() - this.timing.sentAt;
          this.timing.voice = r.headers.get("x-call-timing");
        }
        if (r.status === 204 || r.status === 410) return null;
        return r.ok ? this.ctx.decodeAudioData(await r.arrayBuffer()) : failed();
      })
      .catch(failed)
      .finally(() => {
        clearTimeout(timer);
        outer?.removeEventListener("abort", onAbort);
      });
    this.queue.push({ text, audio, speaker, turn, voiceFailed: () => voiceFailed });
    void this.drain();
  }

  private async drain() {
    if (this.playing || this.closed) return;
    const next = this.queue.shift();
    if (!next) {
      // The goodbye has played: hang up
      if (this.streamDone && this.ending) {
        this.ending = false;
        this.hooks.onEnd?.();
        return;
      }
      if (this.streamDone && this.switching) {
        const to = this.switching;
        this.switching = null;
        this.hooks.onSwitch?.(to);
        return;
      }
      if (this.streamDone) this.dispatch({ t: "idle" });
      return;
    }
    // Held so a second drain doesn't start the sentence after this one meanwhile
    const hold = this.ctx.createBufferSource();
    this.playing = hold;
    const buf = await next.audio;
    if (this.playing !== hold) return;
    this.playing = null;
    if (!buf && showWithoutVoice({ voiceFailed: next.voiceFailed(), closed: this.closed, current: isCurrent(this.st, next.turn) })) {
      this.dispatch({ t: "audio", turn: next.turn });
      this.dispatch({ t: "agent_line", text: next.text });
      this.hooks.onLine({ id: ++this.lineId, who: "agent", text: next.text, ...(next.speaker ? { speaker: next.speaker } : {}) });
      return void this.drain();
    }
    if (!buf || this.closed || !isCurrent(this.st, next.turn)) return void this.drain();
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.out);
    this.playing = src;
    src.onended = () => {
      src.disconnect();
      if (this.playing === src) this.playing = null;
      void this.drain();
    };
    this.dispatch({ t: "audio", turn: next.turn });
    this.dispatch({ t: "agent_line", text: next.text });
    this.hooks.onLine({ id: ++this.lineId, who: "agent", text: next.text, ...(next.speaker ? { speaker: next.speaker } : {}) });
    src.start();
  }

  /**
   * A turn sent without speaking (the files they just uploaded): shown as a note on the call and answered like
   * anything they said. Waits for the agent to finish talking first.
   */
  inject(text: string, shown: string, frame: string | null = null) {
    if (this.closed) return;
    const go = () => {
      if (this.closed) return;
      if (this.st.phase !== "listening" || this.st.commit !== null || this.turn) return void setTimeout(go, 400);
      this.dispatch({ t: "inject", text, shown, frame });
    };
    go();
  }

  /** Whether nothing is being said or worked on right now (the call is just listening) */
  idle() {
    return !this.closed && this.st.phase === "listening" && this.st.commit === null && !this.turn && !this.playing && !this.queue.length;
  }

  /** The agent says a line of its own (the five minutes left), once it has finished what it's saying */
  announce(text: string) {
    if (this.closed) return;
    const go = () => {
      if (this.closed) return;
      if (!this.idle()) return void setTimeout(go, 500);
      this.say(text, null);
    };
    go();
  }

  /** What ended the turn just sent, then back to the usual (a pause) */
  private takeEndedBy() {
    const e = this.endedBy;
    this.endedBy = "pause";
    return e;
  }

  /** "Done talking": end the turn now and send what's been heard (the button, or Enter or Space on a computer) */
  sendNow() {
    this.endedBy = "button";
    this.dispatch({ t: "send" });
  }

  /**
   * "Answer now": it seems stuck (listening and nothing caught, or thinking too long). Words heard go as with Send;
   * otherwise whatever it's doing is stopped and it's asked to answer what was last said, or ask one short question.
   */
  forceAnswer() {
    if (this.closed) return;
    const nudge = forcedTurn(this.st);
    if (nudge === null) return this.sendNow();
    this.dispatch({ t: "inject", text: nudge, shown: "Answer now", frame: null });
  }

  /** A typed turn (loud places, or the transcriber missed it): sent as if said */
  sendText(text: string) {
    this.dispatch({ t: "typed", text });
  }

  /** The last turn didn't go through: send it again */
  retry() {
    this.dispatch({ t: "retry" });
  }

  /** The agent's voice level while it speaks (read each animation frame) */
  sample() {
    if (this.st.phase !== "speaking") return this.level;
    const data = new Float32Array(this.out.fftSize);
    this.out.getFloatTimeDomainData(data);
    return rms(data);
  }

  setMuted(m: boolean) {
    if (m === this.st.muted) return;
    this.mic?.getAudioTracks().forEach((t) => (t.enabled = !m));
    if (m) this.dispatch({ t: "mute", speaking: this.detector.speaking });
    else {
      this.wordsAt = performance.now();
      this.dispatch({ t: "unmute" });
    }
  }

  /** What the hidden debug overlay shows */
  debug(): CallDebug {
    return {
      phase: this.st.phase,
      muted: this.st.muted,
      ears: this.ears ? `${this.ears.kind} (${this.ears.state})` : "none",
      noise: this.detector.noise,
      threshold: this.detector.threshold,
      level: this.level,
      speaking: this.detector.speaking,
      commit: this.st.commit,
      asking: this.st.asking,
      heard: this.st.heard.length,
      stall: this.st.stall,
      queue: this.queue.length,
      timing: this.timing.server,
      voice: this.timing.voice,
      client: this.timing.sentAt ? `first text ${this.timing.firstText ?? "-"}ms, first voice ${this.timing.firstAudio ?? "-"}ms after sending` : null,
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.ctx.onstatechange = null;
    this.watch.stop();
    // The last part of the recording is finished and handed over
    if (this.recTimer) clearTimeout(this.recTimer);
    try {
      if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    } catch {
      // already stopped
    }
    this.stopAgent();
    this.ears?.close();
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
    }
    this.node?.port.close();
    this.mic?.getTracks().forEach((t) => t.stop());
    void this.wake?.release().catch(() => undefined);
    void this.ctx.close().catch(() => undefined);
  }
}
