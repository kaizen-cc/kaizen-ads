// Phone notices for urgent items (phase 1 of docs/PHONE-NOTIFICATIONS.md): the pure parts, tested in tests/phone.test.ts.
// Who gets a call and when (critical, unseen 10 minutes, opted in, outside quiet hours, rate limited), the number as
// Twilio wants it, and the words spoken (TwiML). Twilio's webhook signature is src/lib/phone-signature.ts (server only).

/** How long a critical item sits unseen before the phone rings */
export const UNSEEN_MINUTES = 10;
/** No call for an item older than this (it's been handled some other way, or it's stale) */
export const STALE_MINUTES = 180;
/** At most this many calls an hour to one person */
export const MAX_CALLS_PER_HOUR = 3;
/** One item rings at most this many times (the first call, and once more after a snooze) */
export const MAX_CALLS_PER_ITEM = 2;
/** "Press 2": snoozed this long */
export const SNOOZE_MINUTES = 60;

/** The exact words a person agrees to when they turn phone notices on (kept with their consent) */
export const CONSENT_TEXT =
  "I agree that Kaizen OS may call this number with an automated, AI-voiced notice when an urgent item for me sits unseen, and send me its link by text when I ask on the call. Message and data rates may apply. I can turn this off in Settings at any time.";

export const twilioConfigured = (env: Record<string, string | undefined> = process.env) => Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER);

/** A US or international number as +E.164 ("(512) 555-0134" → "+15125550134"); null when it isn't a number */
export function toE164(input: string | null | undefined): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** "(512) 555-0134" for a US number, the +E.164 otherwise */
export const prettyPhone = (e164: string) => (/^\+1\d{10}$/.test(e164) ? `(${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}` : e164);

/** The hour (0-23) it is now in a time zone */
export function hourIn(now: Date, timezone: string): number {
  try {
    return Number(new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hourCycle: "h23" }).format(now)) % 24;
  } catch {
    return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(now)) % 24;
  }
}

/** Whether it's inside their quiet hours (start to end, across midnight when start > end; equal means none) */
export function inQuietHours(now: Date, s: { quiet_start: number; quiet_end: number; timezone: string }): boolean {
  if (s.quiet_start === s.quiet_end) return false;
  const h = hourIn(now, s.timezone);
  return s.quiet_start < s.quiet_end ? h >= s.quiet_start && h < s.quiet_end : h >= s.quiet_start || h < s.quiet_end;
}

export type PhoneSettings = { profile_id: string; phone: string | null; opted_in: boolean; consent_at: string | null; quiet_start: number; quiet_end: number; timezone: string };
export type Item = { id: string; profile_id: string; priority: string | null; read_at: string | null; cleared_at: string | null; created_at: string };
export type PastCall = { notification_id: string | null; created_at: string; snoozed_until: string | null };

/** Whether this item rings this person's phone now, and if not, why (for the log) */
export function shouldCall(item: Item, s: PhoneSettings | null | undefined, calls: readonly PastCall[], now: Date): { call: boolean; why: string } {
  if (item.priority !== "critical") return { call: false, why: "not critical" };
  if (item.read_at || item.cleared_at) return { call: false, why: "seen" };
  if (!s?.opted_in || !s.consent_at || !toE164(s.phone)) return { call: false, why: "not opted in" };
  const age = (now.getTime() - Date.parse(item.created_at)) / 60_000;
  if (age < UNSEEN_MINUTES) return { call: false, why: "not 10 minutes yet" };
  if (age > STALE_MINUTES) return { call: false, why: "too old" };
  if (inQuietHours(now, s)) return { call: false, why: "quiet hours" };
  const forItem = calls.filter((c) => c.notification_id === item.id);
  if (forItem.length >= MAX_CALLS_PER_ITEM) return { call: false, why: "called enough for this item" };
  // Called once already: only again after a snooze ran out
  if (forItem.length) {
    const snooze = forItem.map((c) => c.snoozed_until).filter((x): x is string => Boolean(x)).sort().pop();
    if (!snooze || Date.parse(snooze) > now.getTime()) return { call: false, why: "already called" };
  }
  const lastHour = calls.filter((c) => now.getTime() - Date.parse(c.created_at) < 3_600_000).length;
  if (lastHour >= MAX_CALLS_PER_HOUR) return { call: false, why: "rate limited" };
  return { call: true, why: "due" };
}

// ─── What's said (TwiML) ─────────────────────────────────────────────────────

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
/** Spoken text: no markdown, no links, short */
export const speakable = (s: string, max = 600) =>
  String(s ?? "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/(^|\n)\s*>\s?/g, "$1")
    .replace(/[*_#`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

const VOICE = 'voice="Polly.Joanna-Neural" language="en-US"';
const say = (s: string) => `<Say ${VOICE}>${xml(s)}</Say>`;
const doc = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;

/** The notice: who it is, the item's title, and the choice */
export function noticeTwiml(o: { firstName: string; title: string; gatherUrl: string; test?: boolean }): string {
  if (o.test)
    return doc(`${say(`Hi ${o.firstName}, this is Kaizen OS. This is a test call: phone notices are on for you. Press 1 to hear how it works, or just hang up.`)}<Gather numDigits="1" timeout="6" action="${xml(o.gatherUrl)}" method="POST"/>${say("Goodbye.")}`);
  return doc(
    `${say(`Hi ${o.firstName}, this is Kaizen OS with something urgent for you. ${speakable(o.title, 200)}.`)}<Gather numDigits="1" timeout="8" action="${xml(o.gatherUrl)}" method="POST">${say("Press 1 to hear the details. Press 2 to snooze it for an hour.")}</Gather>${say("It's waiting for you in Kaizen OS. Goodbye.")}`,
  );
}

/** "Press 1": the item read out, then the offer to text the link */
export function detailTwiml(o: { body: string; textUrl: string | null }): string {
  const offer = o.textUrl ? `<Gather numDigits="1" timeout="6" action="${xml(o.textUrl)}" method="POST">${say("Press 1 and I'll text you the link to it.")}</Gather>` : "";
  return doc(`${say(speakable(o.body) || "There are no more details. Open it in Kaizen OS.")}${offer}${say("It's in Kaizen OS too. Goodbye.")}`);
}

export const testDetailTwiml = () =>
  doc(say("When something urgent for you sits unseen for ten minutes, Kaizen OS calls you. Press 1 to hear it, 2 to snooze it for an hour, and you can ask for the link by text. Quiet hours and turning this off are in Settings. Goodbye."));
export const snoozedTwiml = () => doc(say("Snoozed for an hour. Goodbye."));
export const textedTwiml = (ok: boolean) => doc(say(ok ? "Sent. Goodbye." : "I couldn't send the text, but it's waiting for you in Kaizen OS. Goodbye."));
export const byeTwiml = () => doc(say("It's waiting for you in Kaizen OS. Goodbye."));
