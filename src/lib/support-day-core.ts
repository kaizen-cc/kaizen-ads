// The support positions' day, the pure rules (tested in tests/support-day.test.ts). See ./support-day.ts.

export type SupportRole = "onboarding_specialist" | "customer_success" | "tracking_specialist";
export const isSupportDayRole = (role: string | null | undefined): role is SupportRole => role === "onboarding_specialist" || role === "customer_success" || role === "tracking_specialist";

/** Every support item sits in one topic, so the review goes critical first, then important, then worth a look */
export const SUPPORT_TOPIC = "mine" as const;

/** Item kinds (the key's first part) that are creative, never on a support role's day */
const CREATIVE_KEYS = new Set(["direction", "bible", "radar", "first_round", "brief", "fatigue", "ads", "allotment", "allotments"]);
/** Words that make an item creative whatever its key ("Meta ads need a new creative", "creative request sent") */
const CREATIVE_WORDS = /\b(new creative|creative request|creatives?\b|change of direction|changed direction|brand bible|bible|refresh(?:ed)? (?:the )?ads?|brief)\b/i;

/** Waiting on you: messages owed a reply and things said yes to, theirs personally */
const WAITING = new Set(["owed", "owed2", "said", "said2"]);

/**
 * What a support role keeps of the day gathered for everyone: never anything creative. The Onboarding Specialist keeps
 * only Waiting on you (their blockers come from the onboarding read); the Client Success Coordinator and the Tracking
 * Specialist keep Waiting on you and their own tasks.
 */
export function keepForSupport(role: SupportRole, d: { key: string; title: string; story?: string }): boolean {
  const kind = d.key.split(":")[0];
  // A message or promise on them is theirs to answer, whatever it's about
  if (WAITING.has(kind)) return true;
  if (CREATIVE_KEYS.has(kind) || CREATIVE_WORDS.test(d.title)) return false;
  if (role === "onboarding_specialist") return false;
  if (role === "tracking_specialist") return kind === "mine" || kind === "ask";
  // The Client Success Coordinator: the client relationship, never an account's numbers
  return ["mine", "callp", "promise", "contact", "unhappy", "ask"].includes(kind);
}

const DAY = 86_400_000;
const dayNum = (s: string) => Date.parse(`${s.slice(0, 10)}T12:00:00Z`);

export type Blocker = { kind: "intake" | "call" | "assets"; title: string; story: string; why: string; score: number; days: number };

/**
 * A new client's onboarding blockers: the marketing intake form not filled out, the onboarding call not booked, and
 * client assets (nothing added to their Drive asset folder since onboarding began, or nothing in `quietDays` days).
 */
export function onboardingBlockers(i: { start: string; today: string; intakeAt: string | null; callBooked: boolean; lastAssetAt: string | null; quietDays: number }): Blocker[] {
  const days = Math.max(0, Math.round((dayNum(i.today) - dayNum(i.start)) / DAY));
  const out: Blocker[] = [];
  if (!i.intakeAt)
    out.push({ kind: "intake", days, title: "Marketing intake form not filled out", story: `No intake form yet, ${days} ${days === 1 ? "day" : "days"} into onboarding. There are no delivery dates until it's in.`, why: days >= 4 ? "Late: everything downstream waits on it." : "Needed before anything gets a date.", score: days >= 4 ? 86 : days >= 2 ? 72 : 60 });
  if (!i.callBooked)
    out.push({ kind: "call", days, title: "Onboarding call not booked", story: `No onboarding call on the books, ${days} ${days === 1 ? "day" : "days"} in.`, why: days >= 3 ? "Access and setup wait on this call." : "Book it while they're keen.", score: days >= 3 ? 82 : 66 });
  const quiet = i.lastAssetAt ? Math.round((dayNum(i.today) - dayNum(i.lastAssetAt)) / DAY) : null;
  if (quiet == null ? days >= 2 : quiet >= i.quietDays)
    out.push({ kind: "assets", days, title: "Waiting on client assets", story: quiet == null ? "Nothing has been added to their Drive asset folder since onboarding began." : `Nothing new in their Drive asset folder for ${quiet} days.`, why: "The first round can't be made without them.", score: (quiet ?? days) >= 7 ? 74 : 62 });
  return out;
}

export type Stuck = { what: string; line: string; why: string; score: number; hours: number };

/**
 * A creative stuck on the Asana Creative board: more than 48 hours in Ready for copy with no copy (on the media
 * buyer), or sent to the client with no reply. Ordered by how critical the timeline is: past due first.
 */
export function stuckCreative(t: { stage: string; moves: readonly { to?: string; at?: string }[]; modifiedAt: string | null; due: string | null; holder: string | null }, now = Date.now()): Stuck | null {
  if (t.stage !== "copy" && t.stage !== "client_review") return null;
  const entered = [...t.moves].reverse().find((m) => m.at && m.to && (t.stage === "copy" ? /copy/i.test(m.to) : /client/i.test(m.to)))?.at ?? t.modifiedAt;
  if (!entered) return null;
  const hours = (now - Date.parse(entered)) / 3_600_000;
  if (!Number.isFinite(hours) || hours < 48) return null;
  const late = t.due ? dayNum(t.due) < now : false;
  const days = Math.round(hours / 24);
  const who = t.holder ? t.holder : t.stage === "copy" ? "the media buyer" : "the client";
  const what = t.stage === "copy" ? "waiting on copy" : "waiting on the client";
  return {
    what,
    hours,
    line: `${what === "waiting on copy" ? "In Ready for copy with no copy" : "Sent to the client with no reply"} for ${days} days; ${who} holds it${t.due ? `, due ${t.due}` : ""}.`,
    why: late ? "Past its due date: the timeline is slipping." : days >= 4 ? "Sitting long enough to threaten the timeline." : "Over 48 hours: worth a nudge.",
    score: late ? 86 : days >= 4 ? 74 : 62,
  };
}
