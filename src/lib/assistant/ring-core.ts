// The assistant calls you about urgent items: the plain parts (no keys, no network), shared by the server, the
// incoming-call card and the tests. Whether a heads-up rings, goes to the chat, or waits a moment; the line the
// assistant opens with; and the ring itself as a small state machine (ringing at most ten seconds, then missed).

export const ACTIVE_MS = 2 * 60_000; // seen in the app this recently, with the tab in view: active
export const RING_MS = 10_000; // a ring stops after this
export const SETTLE_MS = 20_000; // a burst of items waits this long to become one heads-up
export const SETTLE_CAP_MS = 60_000; // …but never longer than this after the first of them
export const BATCH_MS = 5 * 60_000; // after a ring, new items wait this long and then come as one heads-up
export const STALE_MS = 30 * 60_000; // older than this: not worth a ring, it goes to the chat
export const BEAT_MS = 15_000; // how often the open app says it's there

export type RingMode = "ring" | "chat";
export type RingPrefs = { mode: RingMode; quietStart: string | null; quietEnd: string | null; tz: string };
export const DEFAULT_PREFS: RingPrefs = { mode: "ring", quietStart: null, quietEnd: null, tz: "America/New_York" };

export type Presence = { lastSeen: string | null; visible: boolean; inCall: boolean };

export type HeadsUpItem = { title: string; body: string | null; href: string | null; at: string };

/** What happens with the urgent items waiting for someone, and why (the why is kept as the heads-up's outcome) */
export type RingDecision = { action: "ring" } | { action: "chat"; why: "not_active" | "in_call" | "quiet" | "chat_only" | "stale" } | { action: "wait"; why: "ringing" | "settling" | "batching" };

/** "HH:MM" or "HH:MM:SS" → minutes after midnight; null when it isn't a time */
export function minutesOf(t: string | null | undefined): number | null {
  const m = String(t ?? "").match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/** The minute of the day in a time zone (New York when the zone isn't known) */
export function minuteIn(tz: string, now: number): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date(now));
  } catch {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date(now));
  }
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

/** Whether it's within their quiet hours (which may run past midnight: 21:00 to 08:00) */
export function inQuietHours(prefs: Pick<RingPrefs, "quietStart" | "quietEnd" | "tz">, now: number): boolean {
  const a = minutesOf(prefs.quietStart);
  const b = minutesOf(prefs.quietEnd);
  if (a == null || b == null || a === b) return false;
  const t = minuteIn(prefs.tz || DEFAULT_PREFS.tz, now);
  return a < b ? t >= a && t < b : t >= a || t < b;
}

/** In the app now: seen within two minutes with the tab in view */
export const isActive = (p: Presence | null, now: number) => Boolean(p && p.visible && p.lastSeen && now - Date.parse(p.lastSeen) <= ACTIVE_MS);

/**
 * What to do with the urgent items waiting for someone. One ring at a time; a burst becomes one heads-up; never a
 * ring during a call or chat, in quiet hours, when they chose chat only, when they're not in the app, or for
 * something already half an hour old: those go to the chat as unread instead.
 */
export function decideHeadsUp(input: { prefs: RingPrefs; presence: Presence | null; now: number; oldestAt: string; newestAt: string; lastRingAt: string | null; ringing: boolean }): RingDecision {
  const { prefs, presence, now } = input;
  const oldest = Date.parse(input.oldestAt);
  const newest = Date.parse(input.newestAt);
  if (input.ringing) return { action: "wait", why: "ringing" };
  if (!isActive(presence, now)) return { action: "chat", why: "not_active" };
  if (now - oldest > STALE_MS) return { action: "chat", why: "stale" };
  if (prefs.mode === "chat") return { action: "chat", why: "chat_only" };
  if (inQuietHours(prefs, now)) return { action: "chat", why: "quiet" };
  if (presence?.inCall) return { action: "chat", why: "in_call" };
  // Several at once: give the rest a moment to land, so they come as one
  if (now - newest < SETTLE_MS && now - oldest < SETTLE_CAP_MS) return { action: "wait", why: "settling" };
  // Rang a moment ago: what's come since waits, then comes as one heads-up
  if (input.lastRingAt && now - Date.parse(input.lastRingAt) < BATCH_MS) return { action: "wait", why: "batching" };
  return { action: "ring" };
}

// ─── What the assistant says ────────────────────────────────────────────────

const strip = (s: string) =>
  s
    .replace(/[—–]/g, ",")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!\s]+$/, "");

/** One item in a sentence: "Sierra Dreams needs 1 video and 5 statics by tomorrow" (the title, made speakable) */
export function itemLine(i: Pick<HeadsUpItem, "title">): string {
  const t = strip(i.title);
  // "Sierra Dreams: needs 1 video" → "Sierra Dreams needs 1 video"; "Client: Something" → "Client, something"
  const m = t.match(/^([^:]{2,60}):\s*(.+)$/);
  if (!m) return t;
  const rest = m[2];
  return /^[a-z]/.test(rest) ? `${m[1]} ${rest}` : `${m[1]}: ${rest}`;
}

const joinAnd = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs.slice(0, -1).join("; ")}; and ${xs.at(-1)}`);

/** The heads-up as the assistant opens the call with it */
export function headsUpLine(firstName: string, items: readonly Pick<HeadsUpItem, "title">[]): string {
  const hi = firstName ? `Hey ${firstName}!` : "Hey!";
  if (items.length <= 1) return `${hi} Heads up, I just put something urgent on your board: ${itemLine(items[0] ?? { title: "something needs you" })}. Want me to take you there now, or will you review it later?`;
  const shown = items.slice(0, 3).map(itemLine);
  const more = items.length > 3 ? `, plus ${items.length - 3} more` : "";
  return `${hi} Heads up, ${items.length} urgent things just landed on your board: ${joinAnd(shown)}${more}. Want me to take you to the first one now, or will you review them later?`;
}

/** The heads-up as it waits in the chat (they missed the ring, declined it, or weren't in the app) */
export function headsUpChat(firstName: string, items: readonly Pick<HeadsUpItem, "title">[], why: "declined" | "missed" | "away" | "quiet"): string {
  const hi = firstName ? `Hey ${firstName}. ` : "";
  const lead = why === "missed" ? "I tried to call you about this." : why === "declined" ? "Here's what I was calling about." : why === "quiet" ? "This came in during your quiet hours." : "This came in while you were away.";
  if (items.length <= 1) return `${hi}${lead} Something urgent landed on your board: **${itemLine(items[0] ?? { title: "something needs you" })}**.`;
  const list = items
    .slice(0, 5)
    .map((i) => `- **${itemLine(i)}**`)
    .join("\n");
  return `${hi}${lead} ${items.length} urgent things landed on your board:\n${list}${items.length > 5 ? `\n- and ${items.length - 5} more` : ""}`;
}

// ─── The ring ───────────────────────────────────────────────────────────────

export type RingState = { phase: "idle" } | { phase: "ringing"; id: string; since: number } | { phase: "ended"; id: string; outcome: "answered" | "declined" | "missed" };
export type RingEvent = { type: "ring"; id: string; now: number } | { type: "answer" } | { type: "decline" } | { type: "tick"; now: number } | { type: "reset" };

/**
 * The incoming call: a ring starts only from idle (one at a time); Answer or Decline end it; ten seconds without
 * either is a miss. An ended ring stays ended (its outcome reported once) until it's reset.
 */
export function ringStep(s: RingState, e: RingEvent): RingState {
  switch (e.type) {
    case "ring":
      return s.phase === "idle" ? { phase: "ringing", id: e.id, since: e.now } : s;
    case "answer":
      return s.phase === "ringing" ? { phase: "ended", id: s.id, outcome: "answered" } : s;
    case "decline":
      return s.phase === "ringing" ? { phase: "ended", id: s.id, outcome: "declined" } : s;
    case "tick":
      return s.phase === "ringing" && e.now - s.since >= RING_MS ? { phase: "ended", id: s.id, outcome: "missed" } : s;
    case "reset":
      return { phase: "idle" };
  }
}

/** Seconds left on a ring (for the card's countdown ring) */
export const ringLeft = (s: RingState, now: number) => (s.phase === "ringing" ? Math.max(0, Math.ceil((RING_MS - (now - s.since)) / 1000)) : 0);

/** A ring's outcome → what it means for the heads-up: answered (the call opens with it), or into the chat as unread */
export const afterRing = (outcome: "answered" | "declined" | "missed"): "answered" | "chat" => (outcome === "answered" ? "answered" : "chat");

/** Clean ring settings from a form or a row */
export function cleanPrefs(raw: { mode?: unknown; quietStart?: unknown; quietEnd?: unknown; tz?: unknown } | null | undefined): RingPrefs {
  const t = (v: unknown) => {
    const m = minutesOf(String(v ?? ""));
    return m == null ? null : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  };
  const tz = typeof raw?.tz === "string" && /^[A-Za-z_]+\/[A-Za-z_/+-]+$/.test(raw.tz) ? raw.tz : DEFAULT_PREFS.tz;
  return { mode: raw?.mode === "chat" ? "chat" : "ring", quietStart: t(raw?.quietStart), quietEnd: t(raw?.quietEnd), tz };
}
