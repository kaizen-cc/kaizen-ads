// A call that survives switching apps, tabs and windows. Desktop browsers keep a call's audio running in a background
// tab (only timers slow down, and the call doesn't lean on them): nothing changes, and coming back just checks
// everything is still up. Phones may stop a page's audio while it's in the background (iOS does): then the call
// shows "Paused while you were away" and, on return, quietly picks up: the audio resumes, the microphone and the
// transcriber reconnect, and anything half heard before the switch is dropped so no stray words become a turn. The
// agent never says anything about it. Plain state, no browser APIs, tested on its own.

export type AwayState = {
  /** The page is out of sight (another app, tab or window over it) */
  away: boolean;
  since: number | null;
  /** The browser stopped the call's audio or microphone while away: shown, and fixed on return */
  paused: boolean;
  /** The microphone itself stopped (it has to be opened again) */
  micLost: boolean;
};

export type AwayEvent =
  | { t: "hidden"; at: number }
  | { t: "visible"; at: number }
  /** The audio engine's state changed (Safari says "interrupted" when another app takes the audio) */
  | { t: "audio"; state: string; at: number }
  /** The microphone track ended (the system took it) */
  | { t: "mic_ended"; at: number };

export type AwayEffect =
  /** Resume the audio engine */
  | "resume_audio"
  /** Reconnect the transcriber if its connection dropped (failures forgiven: the drop was the background) */
  | "wake_ears"
  /** Open the microphone again */
  | "restart_mic"
  /** Drop what was half heard before the switch */
  | "drop_half_heard"
  /** Learn the room's noise again (it may be a different room now) */
  | "relearn_noise"
  /** Keep the screen awake again (the browser lets go of it in the background) */
  | "rewake"
  | "show_paused"
  | "clear_paused";

/** Away this long, the room may have changed: its noise is learned again */
export const AWAY_RELEARN_MS = 20_000;

export const initialAway = (): AwayState => ({ away: false, since: null, paused: false, micLost: false });

const stopped = (state: string) => state === "suspended" || state === "interrupted";

export function stepAway(s: AwayState, e: AwayEvent): { state: AwayState; effects: AwayEffect[] } {
  switch (e.t) {
    case "hidden":
      return s.away ? { state: s, effects: [] } : { state: { ...s, away: true, since: e.at }, effects: [] };
    case "audio": {
      if (stopped(e.state)) {
        // Away: the phone stopped it; shown, fixed on return. In sight (a system sound, a notification): resume now
        if (s.away) return { state: { ...s, paused: true }, effects: s.paused ? [] : ["show_paused"] };
        return { state: s, effects: ["resume_audio"] };
      }
      if (e.state === "running" && s.paused && !s.away && !s.micLost) return { state: { ...s, paused: false }, effects: ["clear_paused"] };
      return { state: s, effects: [] };
    }
    case "mic_ended":
      if (s.away) return { state: { ...s, paused: true, micLost: true }, effects: s.paused ? [] : ["show_paused"] };
      return { state: { ...s, micLost: true }, effects: ["restart_mic"] };
    case "visible": {
      if (!s.away && !s.paused && !s.micLost) return { state: s, effects: [] };
      const longAway = s.since !== null && e.at - s.since >= AWAY_RELEARN_MS;
      const effects: AwayEffect[] = ["resume_audio", "wake_ears", "rewake"];
      if (s.micLost) effects.push("restart_mic");
      if (s.paused) effects.push("drop_half_heard");
      if (s.paused || longAway) effects.push("relearn_noise");
      if (s.paused) effects.push("clear_paused");
      return { state: { away: false, since: null, paused: false, micLost: false }, effects };
    }
  }
}
