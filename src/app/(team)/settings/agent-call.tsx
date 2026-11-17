"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { field } from "@/components/ui";
import { CALL_LIMIT_SECONDS, clock, createTurnDetector, downsample, rms, splitSpeakable, toPcm16, type CallEvent, type LearnedItem } from "@/lib/agent-call/core";
import { callVoices, endCall, renewSttToken, setAgentVoice, startCall, undoLearning, type CallVoice } from "./call-actions";

// Calling an agent: press Call, it picks up and greets you by name in its own voice, and you talk like on the phone.
// The microphone streams to ElevenLabs' realtime speech to text (or the browser's own listening where that's all
// there is); a pause ends your turn; the agent's answer streams from Claude and is spoken sentence by sentence as it
// arrives; talking over it stops it. What you teach it is saved as you go, and the hang-up summary shows each with Undo.

type Phase = "connecting" | "listening" | "thinking" | "speaking";
type Line = { id: number; who: "you" | "agent"; text: string };

const STT_RATE = 16000;
/** Audio kept from just before someone starts talking over the agent, so their first words aren't lost */
const PRE_ROLL_SAMPLES = STT_RATE / 2;
/** How much audio goes to speech to text in one message (100ms) */
const SEND_SAMPLES = STT_RATE / 10;

const WORKLET = `class KzTap extends AudioWorkletProcessor { process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; } } registerProcessor("kz-tap", KzTap);`;

const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

// ─── Listening ──────────────────────────────────────────────────────────────

/** What turns speech into text for the call: ElevenLabs realtime, or the browser's own */
interface Ears {
  readonly kind: "scribe" | "browser";
  /** Audio at 16kHz while the person has the floor */
  feed(samples: Float32Array): void;
  /** Their turn is over: everything they said in it */
  endTurn(): Promise<string>;
  /** Forget what was heard (the agent's own voice, or a turn already sent) */
  reset(): void;
  close(): void;
}

type SpeechRec = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
};

function browserSpeech(): (new () => SpeechRec) | null {
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** ElevenLabs Scribe over a WebSocket, opened with the single-use token the server minted (the key never leaves it) */
function scribeEars(token: string, opts: { onPartial: (t: string) => void; onLost: () => void; renew: () => Promise<string | null> }): Ears {
  let committed: string[] = [];
  let partial = "";
  let pending: number[] = [];
  let waiting: (() => void) | null = null;
  let closed = false;
  let ws: WebSocket;
  let retries = 0;
  const open = (t: string) => {
    ws = new WebSocket(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&token=${encodeURIComponent(t)}&audio_format=pcm_16000&commit_strategy=manual&language_code=en`);
    ws.onmessage = (m) => {
      let e: { message_type?: string; text?: string; error?: string };
      try {
        e = JSON.parse(String(m.data));
      } catch {
        return;
      }
      if (e.message_type === "partial_transcript") {
        partial = e.text ?? "";
        opts.onPartial([...committed, partial].join(" ").trim());
      } else if (e.message_type === "committed_transcript") {
        if (e.text?.trim()) committed.push(e.text.trim());
        partial = "";
        opts.onPartial(committed.join(" "));
        waiting?.();
      } else if (e.error) console.warn("[call] speech to text:", e.message_type, e.error);
    };
    ws.onclose = () => {
      if (closed) return;
      // A dropped connection: a new token and connect again, twice at most, then the browser's own listening
      if (retries++ < 2)
        void opts.renew().then((nt) => {
          if (nt && !closed) open(nt);
          else if (!closed) opts.onLost();
        });
      else opts.onLost();
    };
  };
  open(token);
  const send = (samples: ArrayLike<number>, commit: boolean) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: b64(toPcm16(samples)), commit, sample_rate: STT_RATE }));
  };
  return {
    kind: "scribe",
    feed(samples) {
      for (let i = 0; i < samples.length; i++) pending.push(samples[i]);
      if (pending.length >= SEND_SAMPLES) {
        send(pending, false);
        pending = [];
      }
    },
    async endTurn() {
      // Whatever is left, with a commit: Scribe sends the final words of the turn back
      send(pending.length ? pending : new Array(160).fill(0), true);
      pending = [];
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 1500);
        waiting = () => {
          clearTimeout(t);
          resolve();
        };
      });
      waiting = null;
      const text = [...committed, partial].join(" ").replace(/\s+/g, " ").trim();
      committed = [];
      partial = "";
      return text;
    },
    reset() {
      committed = [];
      partial = "";
      pending = [];
    },
    close() {
      closed = true;
      try {
        ws.close();
      } catch {
        // already closed
      }
    },
  };
}

/** The browser's own speech recognition (Chrome, Edge, Safari): the fallback when ElevenLabs can't be reached */
function browserEars(Rec: new () => SpeechRec, opts: { onPartial: (t: string) => void }): Ears {
  const rec = new Rec();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = navigator.language || "en-US";
  let results: { isFinal: boolean; text: string }[] = [];
  let from = 0;
  let closed = false;
  let waiting: (() => void) | null = null;
  const text = () =>
    results
      .slice(from)
      .map((r) => r.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  rec.onresult = (e) => {
    results = Array.from({ length: e.results.length }, (_, i) => ({ isFinal: e.results[i].isFinal, text: e.results[i][0].transcript }));
    opts.onPartial(text());
    if (results.slice(from).every((r) => r.isFinal)) waiting?.();
  };
  // It stops on its own after a quiet spell: started again for as long as the call lasts
  rec.onend = () => {
    if (closed) return;
    results = [];
    from = 0;
    try {
      rec.start();
    } catch {
      // already starting
    }
  };
  rec.onerror = (e) => e.error !== "no-speech" && e.error !== "aborted" && console.warn("[call] browser listening:", e.error);
  rec.start();
  return {
    kind: "browser",
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
      from = results.length;
      return said;
    },
    reset() {
      from = results.length;
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

type Hooks = {
  onPhase: (p: Phase) => void;
  onLine: (l: Line) => void;
  onPartial: (t: string) => void;
  onLearned: (items: LearnedItem[]) => void;
  onError: (msg: string) => void;
  onEars: (kind: "scribe" | "browser") => void;
};

/** Everything a live call runs: the microphone, turn taking, listening, the agent's answers and its voice */
class Call {
  private ctx: AudioContext;
  private out: AnalyserNode;
  private mic: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private ears: Ears | null = null;
  private detector = createTurnDetector();
  private phase: Phase = "connecting";
  private muted = false;
  private closed = false;
  private preRoll: number[] = [];
  private frame: number[] = [];
  private turn: AbortController | null = null;
  private voice: AbortController | null = null;
  private queue: { text: string; audio: Promise<AudioBuffer | null> }[] = [];
  private playing: AudioBufferSourceNode | null = null;
  private streamDone = true;
  private lineId = 0;
  private wake: { release: () => Promise<void> } | null = null;
  /** What they said before carrying on talking (the turn hadn't been sent yet): sent with the next turn */
  private carry = "";
  /** The latest loudness, mic or voice, for the waveform */
  level = 0;
  /** Set once the server has opened the call */
  callId = "";

  constructor(private hooks: Hooks) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC();
    this.out = this.ctx.createAnalyser();
    this.out.fftSize = 512;
    this.out.connect(this.ctx.destination);
  }

  private setPhase(p: Phase) {
    this.phase = p;
    this.hooks.onPhase(p);
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
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const src = this.ctx.createMediaStreamSource(this.mic);
    this.node = new AudioWorkletNode(this.ctx, "kz-tap");
    this.node.port.onmessage = (e: MessageEvent<Float32Array>) => this.onAudio(e.data);
    // Kept running through a muted output, so the microphone is read without being heard
    const silent = this.ctx.createGain();
    silent.gain.value = 0;
    src.connect(this.node).connect(silent).connect(this.ctx.destination);
    this.listenWith(sttToken);
    try {
      this.wake = await (navigator as unknown as { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request("screen") ?? null;
    } catch {
      // The screen may sleep; the call goes on
    }
    // Picks up: the greeting, in its voice
    this.streamDone = false;
    this.voice = new AbortController();
    this.say(greeting);
    this.streamDone = true;
    this.drain();
  }

  private listenWith(token: string | null) {
    const Rec = browserSpeech();
    const fallback = () => {
      if (this.closed) return;
      if (!Rec) return this.hooks.onError("Listening dropped and this browser can't listen on its own. Hang up and call again.");
      this.ears?.close();
      this.ears = browserEars(Rec, { onPartial: (t) => this.partial(t) });
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
    if (this.phase === "listening" || this.phase === "thinking") this.hooks.onPartial(t);
  }

  /** The person has the floor (not muted, and the agent isn't speaking) */
  private get floor() {
    return !this.muted && (this.phase === "listening" || this.phase === "thinking");
  }

  private onAudio(chunk: Float32Array) {
    if (this.closed) return;
    for (let i = 0; i < chunk.length; i++) this.frame.push(chunk[i]);
    // About 20ms at a time for turn taking
    const size = Math.round(this.ctx.sampleRate / 50);
    while (this.frame.length >= size) {
      const f = this.frame.splice(0, size);
      const level = this.muted ? 0 : rms(f);
      if (this.phase !== "speaking") this.level = level;
      const low = downsample(f, this.ctx.sampleRate, STT_RATE);
      for (let i = 0; i < low.length; i++) this.preRoll.push(low[i]);
      if (this.preRoll.length > PRE_ROLL_SAMPLES) this.preRoll.splice(0, this.preRoll.length - PRE_ROLL_SAMPLES);
      if (this.floor) this.ears?.feed(low);
      if (this.muted || this.phase === "connecting") continue;
      const ev = this.detector.feed(level, 20, this.phase === "speaking");
      if (ev === "barge_in") this.bargeIn();
      else if (ev === "speech_start" && this.phase === "thinking") {
        // They carried on talking before the answer came: stop it and keep listening (what they'd said is kept)
        this.stopAgent();
        this.setPhase("listening");
      } else if (ev === "turn_end" && this.phase === "listening") void this.endTurn();
    }
  }

  /** Talking over the agent: its voice stops, and what they say (from just before) is heard */
  private bargeIn() {
    this.stopAgent();
    this.ears?.reset();
    this.setPhase("listening");
    this.ears?.feed(Float32Array.from(this.preRoll));
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

  private async endTurn() {
    if (!this.ears) return;
    this.setPhase("thinking");
    const heard = await this.ears.endTurn();
    const said = `${this.carry} ${heard}`.replace(/\s+/g, " ").trim();
    this.carry = "";
    if (this.closed) return;
    // They carried on talking while their words were being finished: kept for the end of the turn
    if (this.phase !== "thinking") {
      this.carry = said;
      return;
    }
    if (!said || /^[\s.,!?]*$/.test(said)) {
      this.hooks.onPartial("");
      this.setPhase("listening");
      return;
    }
    this.hooks.onPartial("");
    this.hooks.onLine({ id: ++this.lineId, who: "you", text: said });
    await this.ask(said);
  }

  /** Sends what they said; the answer is spoken sentence by sentence as it's written */
  private async ask(said: string) {
    const turn = new AbortController();
    this.turn = turn;
    this.voice = new AbortController();
    this.streamDone = false;
    let buffer = "";
    try {
      const res = await fetch("/api/agent-call/turn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callId: this.callId, text: said }), signal: turn.signal });
      if (res.status === 410) return this.hooks.onError("The call has ended.");
      if (!res.ok || !res.body) throw new Error(String(res.status));
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let rest = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        rest += dec.decode(value, { stream: true });
        const lines = rest.split("\n");
        rest = lines.pop() ?? "";
        for (const l of lines) {
          if (!l.trim()) continue;
          const e = JSON.parse(l) as CallEvent;
          if (e.t === "text") {
            buffer += e.d;
            const { ready, rest: left } = splitSpeakable(buffer);
            buffer = left;
            ready.forEach((s) => this.say(s));
          } else if (e.t === "learned") this.hooks.onLearned(e.items);
          else if (e.t === "error") this.say(e.message);
        }
      }
      if (buffer.trim()) this.say(buffer.trim());
    } catch {
      if (turn.signal.aborted) return;
      this.say("Sorry, I lost the line for a second. Could you say that again?");
    } finally {
      if (this.turn === turn) {
        this.turn = null;
        this.streamDone = true;
        this.drain();
      }
    }
  }

  /** One sentence: its audio is fetched straight away (in parallel with the ones before), played in order */
  private say(text: string) {
    const signal = this.voice?.signal;
    const audio = fetch("/api/agent-call/speak", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callId: this.callId, text }), signal })
      .then(async (r) => (r.ok && r.status !== 204 ? this.ctx.decodeAudioData(await r.arrayBuffer()) : null))
      .catch(() => null);
    this.queue.push({ text, audio });
    this.drain();
  }

  private async drain() {
    if (this.playing || this.closed) return;
    const next = this.queue.shift();
    if (!next) {
      if (this.streamDone && this.phase !== "listening") {
        this.ears?.reset();
        this.detector.reset();
        this.setPhase("listening");
      }
      return;
    }
    // Held so a second drain doesn't start the sentence after this one meanwhile
    const hold = this.ctx.createBufferSource();
    this.playing = hold;
    const buf = await next.audio;
    if (this.playing !== hold) return;
    this.playing = null;
    if (!buf || this.closed) return void this.drain();
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.out);
    this.playing = src;
    src.onended = () => {
      if (this.playing === src) this.playing = null;
      void this.drain();
    };
    if (this.phase !== "speaking") this.setPhase("speaking");
    this.hooks.onLine({ id: ++this.lineId, who: "agent", text: next.text });
    src.start();
  }

  /** The agent's voice level while it speaks (read each animation frame) */
  sample() {
    if (this.phase !== "speaking") return this.level;
    const data = new Float32Array(this.out.fftSize);
    this.out.getFloatTimeDomainData(data);
    return rms(data);
  }

  setMuted(m: boolean) {
    this.muted = m;
    this.mic?.getAudioTracks().forEach((t) => (t.enabled = !m));
    if (m) this.detector.reset();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.stopAgent();
    this.ears?.close();
    this.node?.port.close();
    this.mic?.getTracks().forEach((t) => t.stop());
    void this.wake?.release().catch(() => undefined);
    void this.ctx.close().catch(() => undefined);
  }
}

// ─── Screens ────────────────────────────────────────────────────────────────

const PHASE_LABEL: Record<Phase, string> = { connecting: "Calling…", listening: "Listening", thinking: "Thinking", speaking: "Speaking" };

const PhoneIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
  </svg>
);

/** The live waveform: bars from the latest levels, in the agent's colour while it speaks */
function Wave({ call, phase, tint }: { call: RefObject<Call | null>; phase: Phase; tint: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const g = el.getContext("2d");
    if (!g) return;
    const levels: number[] = new Array(48).fill(0);
    const muted = getComputedStyle(document.documentElement).getPropertyValue("--color-faint").trim() || "#888";
    const brand = getComputedStyle(document.documentElement).getPropertyValue("--color-brand").trim() || "#888";
    let raf = 0;
    const draw = () => {
      const lv = call.current?.sample() ?? 0;
      levels.push(Math.min(1, lv * 9));
      levels.shift();
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (el.width !== w * dpr) el.width = w * dpr;
      if (el.height !== h * dpr) el.height = h * dpr;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const bar = w / levels.length;
      g.fillStyle = phase === "speaking" ? tint : phase === "listening" ? brand : muted;
      levels.forEach((v, i) => {
        const bh = Math.max(3, v * h);
        const x = i * bar + bar * 0.25;
        g.globalAlpha = 0.35 + 0.65 * (i / levels.length);
        g.beginPath();
        g.roundRect(x, (h - bh) / 2, bar * 0.5, bh, bar * 0.25);
        g.fill();
      });
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [call, phase, tint]);
  return <canvas ref={canvas} aria-hidden className="h-16 w-full max-w-sm" />;
}

type Props = {
  roleKey: string;
  label: string;
  /** The agent's icon, large */
  icon: ReactNode;
  /** The agent's colour */
  tint: string;
  /** "full": the big button on the agent's page; "compact": a small one beside its chat */
  size?: "full" | "compact";
};

/** Call the agent: the button, the in-call screen and the "What I learned" summary after hanging up */
export function AgentCall({ roleKey, label, icon, tint, size = "full" }: Props) {
  const router = useRouter();
  const [view, setView] = useState<"idle" | "call" | "summary">("idle");
  const [phase, setPhase] = useState<Phase>("connecting");
  const [lines, setLines] = useState<Line[]>([]);
  const [partial, setPartial] = useState("");
  const [learned, setLearned] = useState<LearnedItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [ears, setEars] = useState<"scribe" | "browser" | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [summary, setSummary] = useState<{ seconds: number; proposals: number } | null>(null);
  const [busy, start] = useTransition();
  const call = useRef<Call | null>(null);
  const callId = useRef<string | null>(null);
  // The call the summary is about (for Undo), and whether one is open (for the screen)
  const [lastCall, setLastCall] = useState<string | null>(null);
  const captions = useRef<HTMLDivElement>(null);

  const elapsed = startedAt ? Math.max(0, (now - startedAt) / 1000) : 0;
  const left = CALL_LIMIT_SECONDS - elapsed;

  useEffect(() => {
    captions.current?.scrollTo({ top: captions.current.scrollHeight, behavior: "smooth" });
  }, [lines.length, partial]);

  const hangUp = async () => {
    const id = callId.current;
    call.current?.close();
    call.current = null;
    callId.current = null;
    if (!id) return setView("idle");
    setView("summary");
    setSummary(null);
    const r = await endCall(id);
    if (r.ok) {
      setLearned(r.learned);
      setSummary({ seconds: r.seconds, proposals: r.proposals });
    } else setSummary({ seconds: elapsed, proposals: 0 });
    setLastCall(id);
    router.refresh();
  };

  // The clock, and hanging up at the limit
  useEffect(() => {
    if (view !== "call" || !startedAt) return;
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if ((n - startedAt) / 1000 >= CALL_LIMIT_SECONDS) void hangUp();
    }, 1000);
    return () => clearInterval(t);
    // hangUp reads refs only; restarting the clock on every render isn't wanted
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, startedAt]);

  // Leaving the page hangs up
  useEffect(
    () => () => {
      const id = callId.current;
      call.current?.close();
      if (id && call.current) void endCall(id);
    },
    [],
  );

  // Phones: the call takes the whole screen, and the page behind doesn't scroll
  useEffect(() => {
    if (view === "idle") return;
    const was = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = was;
    };
  }, [view]);

  const dial = () => {
    if (busy || view !== "idle") return;
    setError(null);
    setLines([]);
    setLearned([]);
    setPartial("");
    setMuted(false);
    setPhase("connecting");
    setEars(null);
    setView("call");
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("This browser can't use the microphone here.");
      return;
    }
    // Made on the tap itself, so the browser lets it play sound
    const c = new Call({
      onPhase: setPhase,
      onLine: (l) => setLines((cur) => [...cur.slice(-40), l]),
      onPartial: setPartial,
      onLearned: (items) => setLearned((cur) => [...cur, ...items]),
      onError: setError,
      onEars: setEars,
    });
    c.prime();
    call.current = c;
    start(async () => {
      const r = await startCall(roleKey);
      if (!r.ok) {
        c.close();
        call.current = null;
        setError(r.error);
        return;
      }
      callId.current = r.callId;
      c.callId = r.callId;
      const t0 = Date.now();
      setStartedAt(t0);
      setNow(t0);
      try {
        await c.open(r.greeting, r.sttToken);
      } catch (e) {
        const denied = e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError");
        setError(denied ? "Allow the microphone to talk to the agent." : "Couldn't start the call. Try again.");
        c.close();
        call.current = null;
        void endCall(r.callId);
        callId.current = null;
      }
    });
  };

  const toggleMute = () => {
    const m = !muted;
    setMuted(m);
    call.current?.setMuted(m);
  };

  const close = () => {
    setView("idle");
    setSummary(null);
    setLastCall(null);
  };

  const button =
    size === "full" ? (
      <button
        type="button"
        onClick={dial}
        className="inline-flex min-h-12 w-full items-center justify-center gap-2.5 rounded-full bg-brand px-6 text-[15px] font-medium text-white shadow-sm transition hover:bg-brand-hover active:scale-[0.98] sm:w-auto"
      >
        <PhoneIcon />
        Call the {label}
      </button>
    ) : (
      <button
        type="button"
        onClick={dial}
        className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line bg-bg/60 px-4 text-sm text-fg transition-colors hover:border-faint active:bg-surface-2 md:min-h-9"
      >
        <PhoneIcon size={15} />
        Call
      </button>
    );

  const screen =
    view === "call" ? (
      <div role="dialog" aria-modal aria-label={`Call with the ${label}`} className="fixed inset-0 z-[80] flex flex-col bg-bg pt-safe pb-safe animate-[sheet-up_.28s_cubic-bezier(.2,.8,.2,1)]">
        <span aria-hidden className="pointer-events-none absolute left-1/2 top-[18%] h-80 w-80 -translate-x-1/2 rounded-full opacity-25 blur-3xl" style={{ background: tint }} />
        <header className="relative flex items-center justify-between gap-3 px-5 pt-4">
          <span className="text-[11px] uppercase tracking-[0.16em] text-faint">{ears === "browser" ? "Call · browser listening" : "Call"}</span>
          <span className={`tabular rounded-full px-3 py-1 text-xs ${left < 120 ? "bg-warn-soft text-warn" : "bg-surface-2 text-muted"}`} aria-label={`${clock(elapsed)} of ${clock(CALL_LIMIT_SECONDS)}`}>
            {clock(elapsed)} <span className="text-faint">/ {clock(CALL_LIMIT_SECONDS)}</span>
          </span>
        </header>

        <div className="relative grid flex-none justify-items-center gap-4 px-5 pt-8 sm:pt-14">
          <div className="relative grid place-items-center">
            {phase === "speaking" && <span aria-hidden className="absolute inset-[-18px] animate-ping rounded-full opacity-20" style={{ background: tint }} />}
            {phase === "listening" && !muted && <span aria-hidden className="absolute inset-[-12px] rounded-full border-2 border-brand/40" />}
            <div className="relative">{icon}</div>
          </div>
          <div className="text-center">
            <p className="font-heading text-[24px] leading-tight">The {label}</p>
            <p aria-live="polite" className="mt-1 text-sm text-muted">
              {error ? <span className="text-bad">{error}</span> : muted ? "Muted" : PHASE_LABEL[phase]}
            </p>
          </div>
          <Wave call={call} phase={phase} tint={tint} />
        </div>

        <div ref={captions} className="relative mx-auto min-h-0 w-full max-w-xl flex-1 overflow-y-auto overscroll-contain px-5 py-4" aria-label="Live captions">
          <div className="grid gap-2.5">
            {lines.map((l) => (
              <p key={l.id} className={l.who === "you" ? "ml-auto max-w-[85%] rounded-[16px] rounded-br-[6px] bg-surface-2 px-3.5 py-2 text-[14.5px] leading-relaxed text-muted" : "max-w-[92%] text-[16px] leading-relaxed text-fg"}>
                {l.text}
              </p>
            ))}
            {partial && <p className="ml-auto max-w-[85%] rounded-[16px] rounded-br-[6px] border border-dashed border-line px-3.5 py-2 text-[14.5px] leading-relaxed text-faint">{partial}</p>}
          </div>
        </div>

        {learned.length > 0 && (
          <div className="relative mx-auto flex w-full max-w-xl flex-wrap gap-1.5 px-5 pb-2">
            {learned.slice(-3).map((l, i) => (
              <span key={`${l.title}-${i}`} className="inline-flex items-center gap-1.5 rounded-full bg-ok-soft px-3 py-1 text-[12px] text-ok">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                {l.type === "note" ? "Learned" : "Edit to propose"}: {l.title}
              </span>
            ))}
          </div>
        )}

        <footer className="relative flex items-center justify-center gap-10 px-5 pb-6 pt-3">
          <button
            type="button"
            onClick={toggleMute}
            aria-pressed={muted}
            aria-label={muted ? "Unmute" : "Mute"}
            className={`grid h-16 w-16 place-items-center rounded-full border transition active:scale-95 ${muted ? "border-fg bg-fg text-bg" : "border-line bg-surface text-fg hover:border-faint"}`}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />
              {muted && <path d="m3 3 18 18" />}
            </svg>
          </button>
          <button type="button" onClick={() => void hangUp()} aria-label="End call" className="grid h-[72px] w-[72px] place-items-center rounded-full bg-bad text-white shadow-lg transition hover:opacity-90 active:scale-95">
            <span className="rotate-[135deg]">
              <PhoneIcon size={28} />
            </span>
          </button>
        </footer>
      </div>
    ) : view === "summary" ? (
      <div role="dialog" aria-modal aria-label="What I learned" className="fixed inset-0 z-[80] flex flex-col bg-bg pt-safe pb-safe animate-[sheet-up_.28s_cubic-bezier(.2,.8,.2,1)] md:items-center md:justify-center md:bg-bg/80 md:backdrop-blur">
        <div className="flex min-h-0 w-full flex-1 flex-col md:max-h-[80vh] md:max-w-lg md:flex-none md:rounded-[20px] md:border md:border-line md:bg-surface md:shadow-xl">
          <div className="flex items-center gap-4 border-b border-line px-5 py-5">
            <div className="shrink-0">{icon}</div>
            <div className="min-w-0">
              <p className="font-heading text-[20px] leading-tight">What I learned</p>
              <p className="mt-0.5 text-sm text-muted">{summary ? `Call with the ${label} · ${clock(summary.seconds)}` : "Hanging up…"}</p>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {!summary ? (
              <p className="text-sm text-muted">Saving the call…</p>
            ) : learned.length === 0 ? (
              <p className="text-sm leading-relaxed text-muted">Nothing new this time. The whole call is in my chat, so you can read it back any time.</p>
            ) : (
              <ul className="grid gap-3">
                {learned.map((l, i) => (
                  <Learned key={`${l.id ?? l.title}-${i}`} item={l} callId={lastCall} onChange={(u) => setLearned((cur) => cur.map((x, j) => (j === i ? { ...x, undone: u } : x)))} />
                ))}
              </ul>
            )}
            {summary && summary.proposals > 0 && (
              <p className="mt-4 rounded-[12px] bg-brand-soft px-3.5 py-3 text-[13px] leading-relaxed text-brand-text">
                {summary.proposals === 1 ? "One change" : `${summary.proposals} changes`} to my core or a skill&apos;s instructions {summary.proposals === 1 ? "is" : "are"} on the way to my chat as {summary.proposals === 1 ? "an edit" : "edits"} for you to apply.
              </p>
            )}
          </div>
          <div className="border-t border-line px-5 py-4">
            <button type="button" onClick={close} className="min-h-12 w-full rounded-full bg-brand px-5 text-[14.5px] font-medium text-white transition hover:bg-brand-hover">
              Done
            </button>
          </div>
        </div>
      </div>
    ) : null;

  return (
    <>
      {button}
      {screen && typeof document !== "undefined" ? createPortal(screen, document.body) : null}
    </>
  );
}

function Learned({ item, callId, onChange }: { item: LearnedItem; callId: string | null; onChange: (undone: boolean) => void }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toggle = () =>
    start(async () => {
      if (!callId || !item.id) return;
      setError(null);
      const r = await undoLearning(callId, item.id, !item.undone);
      if (r.ok) onChange(!item.undone);
      else setError(r.error);
    });
  return (
    <li className={`grid gap-1.5 rounded-[14px] border border-line p-3.5 transition-opacity ${item.undone ? "opacity-55" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={`text-[14.5px] font-medium leading-snug ${item.undone ? "line-through" : ""}`}>{item.title}</p>
          <p className="mt-0.5 text-[11px] text-faint">{item.type === "note" ? (item.undone ? "Undone" : `Saved to ${item.skill}`) : item.skill === "core" ? "Proposed for my core" : `Proposed for ${item.skill}`}</p>
        </div>
        {item.type === "note" && item.id && (
          <button type="button" onClick={toggle} disabled={pending} className="inline-flex min-h-11 shrink-0 items-center rounded-full border border-line px-3.5 text-[13px] text-muted transition-colors hover:border-faint hover:text-fg disabled:opacity-50 md:min-h-8">
            {item.undone ? "Put back" : "Undo"}
          </button>
        )}
      </div>
      <p className="text-[13px] leading-relaxed text-muted">{item.body}</p>
      {error && <p className="text-xs text-bad">{error}</p>}
    </li>
  );
}

/** The agent's voice on calls: one dropdown, saved on change, with a preview */
export function AgentVoice({ roleKey, voiceId, defaultName }: { roleKey: string; voiceId: string | null; defaultName: string }) {
  const [voices, setVoices] = useState<CallVoice[] | null>(null);
  const [value, setValue] = useState(voiceId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const preview = useRef<HTMLAudioElement | null>(null);
  const load = () =>
    start(async () => {
      const r = await callVoices(roleKey);
      if (r.ok) setVoices(r.voices);
      else setError(r.error);
    });
  const pick = (id: string) => {
    setValue(id);
    setError(null);
    start(async () => {
      const r = await setAgentVoice(roleKey, id || null);
      if (!r.ok) setError(r.error);
    });
  };
  const current = voices?.find((v) => v.id === value);
  const play = () => {
    if (!current?.preview) return;
    preview.current?.pause();
    preview.current = new Audio(current.preview);
    void preview.current.play().catch(() => undefined);
  };
  if (!voices)
    return (
      <button type="button" onClick={load} disabled={pending} className="inline-flex min-h-11 items-center gap-2 text-[13px] text-muted transition-colors hover:text-fg disabled:opacity-60 md:min-h-8">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M11 5 6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" />
        </svg>
        {pending ? "Loading voices…" : `Voice: ${voiceId ? "custom" : `${defaultName} (default)`} · Change`}
        {error && <span className="text-bad">{error}</span>}
      </button>
    );
  return (
    <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
      <label className="sr-only" htmlFor={`voice-${roleKey}`}>
        Voice on calls
      </label>
      <select id={`voice-${roleKey}`} value={value} onChange={(e) => pick(e.target.value)} disabled={pending} className={`${field} h-11 flex-1 sm:w-64 md:h-9`}>
        <option value="">{defaultName} (default)</option>
        {voices.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
            {v.about ? ` · ${v.about}` : ""}
          </option>
        ))}
      </select>
      {current?.preview && (
        <button type="button" onClick={play} className="inline-flex min-h-11 items-center rounded-full border border-line px-3.5 text-[13px] text-muted transition-colors hover:border-faint hover:text-fg md:min-h-9">
          Preview
        </button>
      )}
      {error && <p className="w-full text-xs text-bad">{error}</p>}
    </div>
  );
}
