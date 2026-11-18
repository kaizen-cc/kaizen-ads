import { useCallback, useEffect, useRef, useState } from "react";
import { dictationToken } from "@/app/(team)/settings/call-actions";
import { createTurnDetector, downsample, rms } from "@/lib/agent-call/core";
import { STT_RATE, WORKLET, browserEars, browserSpeech, scribeEars, type Ears } from "@/lib/agent-call/engine";

// Voice to text in the chat: the mic button dictates into the input with the same realtime listening as a call
// (ElevenLabs Scribe through a short token from the server; the browser's own listening where that's all there is),
// showing the words live. Tapping the mic again stops and leaves the words in the input to edit and send; with
// "send on pause" on, a pause sends them. Replies stay text. The choice is remembered on this device.

const AUTO_KEY = "kz:chat-dictate-autosend";

const readAuto = () => {
  try {
    return localStorage.getItem(AUTO_KEY) === "1";
  } catch {
    return false;
  }
};

type Rig = { ctx: AudioContext; mic: MediaStream; node: AudioWorkletNode | null; ears: Ears };

export function useDictation(opts: { callId: string | null; onWords: (text: string) => void; onSend: (text: string) => void }) {
  const [on, setOn] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Read once (the chat window only renders in the browser)
  const [auto, setAutoState] = useState(readAuto);
  const rig = useRef<Rig | null>(null);
  const hooks = useRef(opts);
  useEffect(() => {
    hooks.current = opts;
  });
  const teardown = useCallback(() => {
    const r = rig.current;
    rig.current = null;
    if (!r) return;
    if (r.node) {
      r.node.port.onmessage = null;
      r.node.disconnect();
    }
    r.ears.close();
    r.mic.getTracks().forEach((t) => t.stop());
    void r.ctx.close().catch(() => undefined);
  }, []);

  /** Stops listening; the last words land in the input (and are sent when `send`) */
  const stop = useCallback(
    async (send = false) => {
      const r = rig.current;
      if (!r) return;
      setOn(false);
      const words = await r.ears.endTurn().catch(() => "");
      teardown();
      if (words.trim()) hooks.current.onWords(words);
      if (send) hooks.current.onSend(words);
    },
    [teardown],
  );

  const start = useCallback(async () => {
    if (rig.current || starting) return;
    setError(null);
    setStarting(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser can't use the microphone here.");
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AC();
      await ctx.resume().catch(() => undefined);
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const id = hooks.current.callId;
      const tok = id ? await dictationToken(id).catch(() => null) : null;
      const onPartial = (t: string) => hooks.current.onWords(t);
      const Rec = browserSpeech();
      let ears: Ears;
      if (tok?.ok) {
        ears = scribeEars(tok.token, {
          onPartial,
          onLost: () => setError("Dictation dropped. Tap the mic to try again."),
          renew: async () => {
            const r = id ? await dictationToken(id).catch(() => null) : null;
            return r?.ok ? r.token : null;
          },
        });
      } else if (Rec) ears = browserEars(Rec, { onPartial });
      else {
        mic.getTracks().forEach((t) => t.stop());
        void ctx.close();
        throw new Error("This browser can't listen. Use Chrome, Edge or Safari.");
      }
      let node: AudioWorkletNode | null = null;
      // Scribe hears the mic through the audio graph (the browser's own listening has its own mic)
      if (ears.kind === "scribe") {
        const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        const src = ctx.createMediaStreamSource(mic);
        node = new AudioWorkletNode(ctx, "kz-tap");
        const silent = ctx.createGain();
        silent.gain.value = 0;
        src.connect(node).connect(silent).connect(ctx.destination);
        const detector = createTurnDetector();
        let frame: number[] = [];
        let heard = false;
        node.port.onmessage = (e: MessageEvent<Float32Array>) => {
          for (let i = 0; i < e.data.length; i++) frame.push(e.data[i]);
          const size = Math.round(ctx.sampleRate / 50);
          while (frame.length >= size) {
            const f = frame.slice(0, size);
            frame = frame.slice(size);
            ears.feed(downsample(f, ctx.sampleRate, STT_RATE));
            const ev = detector.feed(rms(f), 20, false);
            if (ev === "speech_start") heard = true;
            // Send on pause: a pause after speech sends what was said
            if (ev === "turn_end" && heard && readAuto()) {
              heard = false;
              void stop(true);
            }
          }
        };
      }
      rig.current = { ctx, mic, node, ears };
      setOn(true);
    } catch (e) {
      const denied = e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError");
      setError(denied ? "Allow the microphone to dictate." : e instanceof Error ? e.message : "Couldn't start dictation.");
      teardown();
    } finally {
      setStarting(false);
    }
  }, [starting, stop, teardown]);

  const setAuto = useCallback((v: boolean) => {
    setAutoState(v);
    try {
      localStorage.setItem(AUTO_KEY, v ? "1" : "0");
    } catch {
      /* private window: not remembered */
    }
  }, []);

  useEffect(() => teardown, [teardown]);

  return { on, starting, error, auto, setAuto, start, stop, supported: typeof window !== "undefined" };
}
