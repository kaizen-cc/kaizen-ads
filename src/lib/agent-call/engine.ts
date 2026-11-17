import { downsample, createTurnDetector, rms, splitSpeakable, toPcm16, type CallCard, type CallEvent, type LearnedItem, type UploadAsk } from "./core";
import type { CallContext } from "./call-context";
import { AUDIO_PART_SECONDS } from "@/lib/assistant/core";
import { renewSttToken } from "@/app/(team)/settings/call-actions";

// The live call itself: the microphone, turn taking, listening, the agent's answers and its voice. It knows nothing
// about screens; the call provider (src/components/agent-call-provider.tsx) owns one of these and both ways of
// showing it (the full screen on phones, the huddle on computers) read the same state.
// The microphone streams to ElevenLabs realtime speech to text (or the browser's own listening where that's all
// there is); a pause ends your turn; the agent's answer streams from Claude and is spoken sentence by sentence as it
// arrives; talking over it stops it.

export type Phase = "connecting" | "listening" | "thinking" | "speaking";
/** A line of the call; `speaker` names the agent that said it when more than one is on the line */
export type Line = { id: number; who: "you" | "agent"; text: string; speaker?: { role: string; label: string; icon: string } };

/** Who is speaking now (an assistant call can have a specialist on the line) */
export type Speaker = { role: string; label: string; icon: string };

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

export type Hooks = {
  onPhase: (p: Phase) => void;
  onLine: (l: Line) => void;
  onPartial: (t: string) => void;
  onLearned: (items: LearnedItem[]) => void;
  onError: (msg: string) => void;
  onEars: (kind: "scribe" | "browser") => void;
  /** A specialist joined (or left: null) */
  onGuest?: (g: Speaker | null) => void;
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

/** Everything a live call runs: the microphone, turn taking, listening, the agent's answers and its voice */
export class Call {
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
  private queue: { text: string; audio: Promise<AudioBuffer | null>; speaker: Speaker | null }[] = [];
  /** Who the next words are from (set by the turn's speaker events) */
  private speaker: Speaker | null = null;
  /** The agent said goodbye: hang up once the queue has played */
  private ending = false;
  private recorder: MediaRecorder | null = null;
  private recDest: MediaStreamAudioDestinationNode | null = null;
  private recTimer: ReturnType<typeof setTimeout> | null = null;
  private recIndex = 0;
  private recStarted = 0;
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
  /** Where they called from (a client, a report, a Kaizen AI thread): sent with every turn */
  context: CallContext | null = null;

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
    // The recording (people are told before their first call): the microphone and the agent's voice together
    if (this.hooks.onAudioPart && typeof MediaRecorder !== "undefined") {
      this.recDest = this.ctx.createMediaStreamDestination();
      src.connect(this.recDest);
      this.out.connect(this.recDest);
      this.recStarted = Date.now();
      this.recordPart();
    }
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
  private async ask(said: string, frame: string | null = null) {
    const turn = new AbortController();
    this.turn = turn;
    this.voice = new AbortController();
    this.streamDone = false;
    let buffer = "";
    try {
      const res = await fetch("/api/agent-call/turn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callId: this.callId, text: said, ...(this.context ? { context: this.context } : {}), ...(frame ? { frame } : {}) }), signal: turn.signal });
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
          else if (e.t === "speaker") {
            // A new voice: what the last one was still writing is said first
            if (buffer.trim()) this.say(buffer.trim());
            buffer = "";
            this.speaker = { role: e.role, label: e.label, icon: e.icon };
          } else if (e.t === "guest") this.hooks.onGuest?.(e.role ? { role: e.role, label: e.label ?? "", icon: e.icon ?? "spark" } : null);
          else if (e.t === "navigate") this.hooks.onNavigate?.(e.href);
          else if (e.t === "card") this.hooks.onCard?.(e.card);
          else if (e.t === "upload") this.hooks.onUpload?.(e.ask);
          else if (e.t === "look") this.hooks.onLook?.();
          else if (e.t === "end") this.ending = true;
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

  /** One sentence: its audio is fetched straight away (in parallel with the ones before), played in order, in its speaker's voice */
  private say(text: string) {
    const signal = this.voice?.signal;
    const speaker = this.speaker;
    const audio = fetch("/api/agent-call/speak", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callId: this.callId, text, ...(speaker ? { role: speaker.role } : {}) }), signal })
      .then(async (r) => (r.ok && r.status !== 204 ? this.ctx.decodeAudioData(await r.arrayBuffer()) : null))
      .catch(() => null);
    this.queue.push({ text, audio, speaker });
    this.drain();
  }

  /**
   * A turn sent without speaking (the files they just uploaded): shown as a note on the call and answered like
   * anything they said. Waits for the agent to finish talking first.
   */
  inject(text: string, shown: string, frame: string | null = null) {
    if (this.closed) return;
    const go = () => {
      if (this.closed) return;
      if (this.phase === "speaking" || this.phase === "thinking" || this.turn) return void setTimeout(go, 400);
      this.ears?.reset();
      this.hooks.onLine({ id: ++this.lineId, who: "you", text: shown });
      this.setPhase("thinking");
      void this.ask(text, frame);
    };
    go();
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
    this.hooks.onLine({ id: ++this.lineId, who: "agent", text: next.text, ...(next.speaker ? { speaker: next.speaker } : {}) });
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
    // The last part of the recording is finished and handed over
    if (this.recTimer) clearTimeout(this.recTimer);
    try {
      if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    } catch {
      // already stopped
    }
    this.stopAgent();
    this.ears?.close();
    this.node?.port.close();
    this.mic?.getTracks().forEach((t) => t.stop());
    void this.wake?.release().catch(() => undefined);
    void this.ctx.close().catch(() => undefined);
  }
}
