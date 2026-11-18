// Where the time goes in one turn of a call, for diagnosing a slow call: each phase (auth, opening the call, the
// context reads, the model's first word, each tool, a specialist joining) timed and logged as one compact line,
// `[agent call timing] …`, and sent to the call so the hidden debug overlay (?calldebug=1) shows it. Pure: no keys.

export type CallTimer = {
  /** Adds `ms` to a phase (a phase timed more than once adds up: two rounds of the model, three tools) */
  add(label: string, ms: number): void;
  /** Times a piece of work as a phase (failures are timed too, then rethrown) */
  time<T>(label: string, work: Promise<T> | (() => Promise<T>)): Promise<T>;
  /** A moment since the turn arrived ("first word at 1840ms") */
  mark(label: string): void;
  /** Milliseconds since the turn arrived */
  since(): number;
  /** The compact line: total, then each phase in the order first seen */
  line(prefix?: string): string;
};

export function callTimer(startedAt = Date.now(), now: () => number = Date.now): CallTimer {
  const phases = new Map<string, { ms: number; n: number; at: boolean }>();
  const add = (label: string, ms: number, at = false) => {
    const p = phases.get(label);
    if (p && !at) {
      p.ms += ms;
      p.n++;
    } else if (!p) phases.set(label, { ms, n: 1, at });
  };
  return {
    add: (label, ms) => add(label, Math.max(0, Math.round(ms))),
    async time(label, work) {
      const t0 = now();
      try {
        return await (typeof work === "function" ? work() : work);
      } finally {
        add(label, Math.round(now() - t0));
      }
    },
    mark: (label) => add(label, Math.round(now() - startedAt), true),
    since: () => now() - startedAt,
    line(prefix = "") {
      const parts = [...phases].map(([k, p]) => `${k}${p.at ? "@" : "="}${p.ms}${p.n > 1 ? `x${p.n}` : ""}`);
      return `${prefix ? `${prefix} ` : ""}total=${Math.round(now() - startedAt)} ${parts.join(" ")}`.trim();
    },
  };
}

/** A timer that records nothing (when a caller passes none) */
export const noTimer = (): CallTimer => callTimer();
