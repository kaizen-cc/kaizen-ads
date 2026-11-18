import { noDash } from "@/lib/direction-core";

// What was promised on a call, routed to the people who have to act on it. The pure parts (no keys, no network):
// spotting the same meeting recorded twice, merging the same promise said in both, deciding who gets each one by its
// kind and the client's seats, how urgent it is, and what the notice says. Shared by the cron, the backfill and tests.

export type CallRow = { id: string; clientId: string | null; title: string; occurredAt: string; attendees: string[]; host: string | null; source: string };

export type Commitment = {
  id: string;
  callId: string;
  clientId: string;
  kind: string;
  what: string;
  why: string | null;
  dueAt: string;
  /** Already routed and told (an earlier run): kept over its duplicate, never told again */
  routed: boolean;
};

const STOP = new Set(["the", "a", "an", "and", "or", "to", "for", "of", "in", "on", "at", "by", "with", "we", "will", "our", "their", "them", "it", "is", "are", "be", "that", "this", "new", "some", "from", "into", "as", "so", "up", "out", "about", "kaizen", "client", "make", "create", "produce", "build", "get", "send", "do"]);

const stem = (w: string) => w.replace(/(ing|ed|es|s)$/i, "");

/** Words that carry meaning, lowercased and de-pluralised ("5 statics" and "five static images" share "5"/"static") */
const WORD_NUM: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", a: "1" };
const SYNONYM: Record<string, string> = { image: "static", picture: "static", photo: "static", graphic: "static", creative: "static", clip: "video", reel: "video", bfcm: "bfcm", "black friday": "bfcm" };

export function tokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().replace(/black friday|cyber monday/g, "bfcm").split(/[^a-z0-9]+/)) {
    if (!raw || STOP.has(raw)) continue;
    const w = WORD_NUM[raw] ?? stem(raw);
    out.add(SYNONYM[w] ?? w);
  }
  return out;
}

export const jaccard = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
};

/** Two notes of one meeting: the same time (within an hour), and the same client or the same people or a like title */
export function sameMeeting(a: CallRow, b: CallRow, windowMin = 60): boolean {
  if (a.id === b.id) return false;
  const gap = Math.abs(Date.parse(a.occurredAt) - Date.parse(b.occurredAt)) / 60_000;
  if (!(gap <= windowMin)) return false;
  if (a.clientId && b.clientId && a.clientId === b.clientId) return true;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const ta = tokens(a.title);
  const tb = tokens(b.title);
  if (norm(a.title) === norm(b.title) || jaccard(ta, tb) >= 0.5) return true;
  const pa = new Set([...a.attendees, a.host ?? ""].map((x) => x.toLowerCase()).filter(Boolean));
  const pb = new Set([...b.attendees, b.host ?? ""].map((x) => x.toLowerCase()).filter(Boolean));
  const shared = [...pa].filter((x) => pb.has(x)).length;
  // Mostly the same people (one tool often lists fewer)
  return shared >= 2 && shared / Math.min(pa.size, pb.size) >= 0.6;
}

/** The numbers and deliverables named in a promise: "1 video, 5 images" */
export function deliverables(text: string): { n: number; noun: string }[] {
  const out: { n: number; noun: string }[] = [];
  const re = /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|a|an)\s+(?:new\s+|more\s+|extra\s+)?(videos?|statics?|static images?|images?|carousels?|ads?|reels?|gifs?|ugc|graphics?|banners?|creatives?|stories|story|variations?|concepts?)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = m[1].toLowerCase();
    const n = /^\d/.test(raw) ? Number(raw) : Number(WORD_NUM[raw] ?? 1);
    const base = m[2].toLowerCase().replace(/^static images?$/, "image").replace(/^statics?$/, "image").replace(/ies$/, "y").replace(/s$/, "");
    const noun = base === "story" ? "story" : base;
    const have = out.find((o) => o.noun === noun);
    if (have) have.n = Math.max(have.n, n);
    else out.push({ n, noun });
  }
  return out;
}

const plural = (n: number, noun: string) => (n === 1 ? noun : noun === "story" ? "stories" : `${noun}s`);
const deliverableLine = (d: { n: number; noun: string }[], joiner: string) => d.map((x) => `${x.n} ${plural(x.n, x.noun)}`).join(joiner);

/**
 * The same promise said on both notes of one meeting: the wording differs, the work doesn't. Same deliverable numbers
 * (when both name any) and enough shared words, or nearly the same words, make a pair.
 */
export function samePromise(a: { kind: string; what: string; why?: string | null }, b: { kind: string; what: string; why?: string | null }): boolean {
  const ta = tokens(a.what);
  const tb = tokens(b.what);
  const j = jaccard(ta, tb);
  const da = deliverables(a.what);
  const db = deliverables(b.what);
  const key = (d: { n: number; noun: string }[]) => d.map((x) => `${x.n}:${x.noun}`).sort().join("|");
  if (da.length && db.length) {
    // Both name what's to be made: the same counts, and some words in common, are the same work
    if (key(da) === key(db)) return j >= 0.2 || a.kind === b.kind;
    return false;
  }
  if (a.kind !== b.kind && j < 0.6) return false;
  return j >= 0.45;
}

/** How much a promise says: its words plus its reason (the one with more detail is the one kept) */
export const detail = (c: { what: string; why?: string | null }) => c.what.length + (c.why ?? "").length * 0.7;

export type Merge = { keep: string; drop: string; what: string; why: string | null };

/**
 * Commitments from notes of the same meeting, matched across the two notes (never within one note: two promises on one
 * call are two promises). The one already told stays (else the richer one); it takes the richer wording.
 */
export function mergeDuplicates(calls: CallRow[], items: Commitment[]): Merge[] {
  const byCall = new Map<string, Commitment[]>();
  for (const c of items) byCall.set(c.callId, [...(byCall.get(c.callId) ?? []), c]);
  const callOf = new Map(calls.map((c) => [c.id, c]));
  const dropped = new Set<string>();
  const out: Merge[] = [];
  const ids = [...byCall.keys()].sort();
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const ca = callOf.get(ids[i]);
      const cb = callOf.get(ids[j]);
      if (!ca || !cb || !sameMeeting(ca, cb)) continue;
      for (const a of byCall.get(ids[i]) ?? []) {
        if (dropped.has(a.id)) continue;
        let best: Commitment | null = null;
        let bestScore = 0;
        for (const b of byCall.get(ids[j]) ?? []) {
          if (dropped.has(b.id) || a.clientId !== b.clientId || !samePromise(a, b)) continue;
          const score = jaccard(tokens(a.what), tokens(b.what));
          if (score >= bestScore) {
            best = b;
            bestScore = score;
          }
        }
        if (!best) continue;
        // An already told one stays so nobody is told twice; otherwise the one saying more
        const keep = a.routed && !best.routed ? a : best.routed && !a.routed ? best : detail(a) >= detail(best) ? a : best;
        const drop = keep === a ? best : a;
        const richer = detail(drop) > detail(keep) ? drop : keep;
        dropped.add(drop.id);
        out.push({ keep: keep.id, drop: drop.id, what: richer.what, why: richer.why ?? keep.why ?? drop.why ?? null });
      }
    }
  }
  return out;
}

// ─── Urgency ───────────────────────────────────────────────────────────────

const URGENT_WORDS = /\b(urgent(ly)?|asap|a\.s\.a\.p|today|tonight|this morning|this afternoon|right away|immediately|first thing|closing|close (the )?(deal|sale|sales|bfcm|them|it)|ends?|ending|deadline|before (the )?(sale|bfcm|black friday|cyber|launch)|critical|top priority|need(s|ed)? (it )?(now|by)|time[- ]sensitive)\b/i;

export const hasUrgencyWords = (s: string) => URGENT_WORDS.test(s);

/** The lines of the notes that talk about this promise (shared words), for urgency said around it */
export function evidenceSentences(notes: string | null | undefined, what: string, max = 3): string[] {
  if (!notes) return [];
  const want = tokens(what);
  if (want.size < 2) return [];
  const scored = notes
    .split(/(?<=[.!?\n])\s+/)
    .map((s) => ({ s, n: [...tokens(s)].filter((t) => want.has(t)).length }))
    .filter((x) => x.n >= 2)
    .sort((a, b) => b.n - a.n)
    .slice(0, max);
  return scored.map((x) => x.s);
}

export type Urgency = { urgent: boolean; reasons: string[] };

/** Due within 48 hours, urgency words in the promise or what was said around it, or an exec asking */
export function detectUrgency(c: { what: string; why?: string | null; dueAt: string }, o: { now?: number; notes?: string | null; execAsked?: boolean } = {}): Urgency {
  const now = o.now ?? Date.now();
  const reasons: string[] = [];
  const due = Date.parse(c.dueAt);
  if (Number.isFinite(due) && due - now <= 48 * 3_600_000) reasons.push("due within 48 hours");
  if (hasUrgencyWords(`${c.what} ${c.why ?? ""}`)) reasons.push("said to be urgent");
  else if (evidenceSentences(o.notes, c.what).some(hasUrgencyWords)) reasons.push("said to be urgent on the call");
  if (o.execAsked) reasons.push("an exec asked for it");
  return { urgent: reasons.length > 0, reasons };
}

// ─── Who gets it ───────────────────────────────────────────────────────────

export type Seat = { profile_id: string; role: string; is_primary?: boolean | null };
export type Person = { id: string; role: string; isExec: boolean; email: string | null };

export type Platform = "meta" | "google" | "tiktok";

export function platformOf(text: string): Platform | null {
  if (/\b(google|search ads?|pmax|performance max|youtube|shopping|demand gen|adwords)\b/i.test(text)) return "google";
  if (/\btiktok\b/i.test(text)) return "tiktok";
  if (/\b(meta|facebook|instagram|\bfb\b|\big\b|advantage\+?)\b/i.test(text)) return "meta";
  return null;
}

const wantsVideo = (t: string) => /\b(videos?|reels?|ugc|clips?|motion|animation|gif)\b/i.test(t);
const wantsStatic = (t: string) => /\b(statics?|images?|graphics?|banners?|carousels?|photos?|creatives?|stills?)\b/i.test(t);
const isEmailWork = (t: string) => /\b(email|emails|sms|klaviyo|flow|flows|newsletter|campaign batch)\b/i.test(t) && !/\b(meta|google|tiktok|facebook|instagram)\b/i.test(t);

export type Route = { to: string[]; why: Record<string, string> };

const holders = (seats: Seat[], ...roles: string[]) => seats.filter((s) => roles.includes(s.role)).sort((a, b) => Number(b.is_primary !== false) - Number(a.is_primary !== false)).map((s) => s.profile_id);

/**
 * Each commitment goes to the people who have to act on it, not to everyone:
 * - creative, copy, offer: the head of creative and the client's designer and video editor seats (the copywriter for copy)
 * - launch: the client's buyer for that platform (a TikTok seat, else Meta), and that line's head only when it's urgent
 * - email work: the client's email strategist (and their head when urgent)
 * - strategy and anything else: the client's buyers
 * The one who made the promise (the host of the call) gets it too. Execs only when urgent and they were in the meeting.
 */
export function routeCommitment(
  c: { kind: string; what: string; why?: string | null },
  o: { seats: Seat[]; people: Person[]; kpiOwners?: string[]; urgent: boolean; attendeeEmails?: string[]; hostEmail?: string | null },
): Route {
  const why: Record<string, string> = {};
  const add = (id: string | undefined | null, reason: string) => {
    if (id && !why[id]) why[id] = reason;
  };
  const text = `${c.what} ${c.why ?? ""}`;
  const byRole = (r: string) => o.people.filter((p) => p.role === r).map((p) => p.id);
  const platform = platformOf(text);
  const email = isEmailWork(text);

  if (email) {
    for (const id of holders(o.seats, "email_strategist")) add(id, "client's email strategist");
    if (!Object.keys(why).length || o.urgent) for (const id of byRole("head_of_email")) add(id, "head of email");
  } else if (["creative", "copy", "offer"].includes(c.kind)) {
    for (const id of byRole("head_of_creative")) add(id, "head of creative");
    const video = wantsVideo(text);
    const stat = wantsStatic(text) || !video;
    if (video) for (const id of holders(o.seats, "video_editor")) add(id, "client's video editor");
    if (stat) for (const id of holders(o.seats, "graphic_designer")) add(id, "client's designer");
    // The creative leads plan and hand out the work
    if (video) for (const id of byRole("lead_video_editor")) add(id, "lead video editor");
    if (stat) for (const id of byRole("lead_graphic_designer")) add(id, "lead graphic designer");
    if (c.kind === "copy") for (const id of holders(o.seats, "copywriter")) add(id, "client's copywriter");
    // A promise of ad creative on a platform is also the buyer's to run, only when it can't wait
    if (o.urgent) for (const id of holders(o.seats, platform === "google" ? "google_buyer" : platform === "tiktok" ? "tiktok_buyer" : "meta_buyer").slice(0, 1)) add(id, "client's buyer");
  } else if (c.kind === "launch") {
    const p: Platform = platform ?? "meta";
    const seatRole = p === "google" ? "google_buyer" : p === "tiktok" ? (o.seats.some((s) => s.role === "tiktok_buyer") ? "tiktok_buyer" : "meta_buyer") : "meta_buyer";
    for (const id of holders(o.seats, seatRole)) add(id, `client's ${p} buyer`);
    // Nobody on that seat: the other buyers, then the KPI owners
    if (!Object.keys(why).length) for (const id of holders(o.seats, "meta_buyer", "google_buyer", "tiktok_buyer")) add(id, "client's buyer");
    if (!Object.keys(why).length) for (const id of o.kpiOwners ?? []) add(id, "owns the client's ad account");
    if (o.urgent || !Object.keys(why).length) for (const id of byRole(p === "google" ? "head_of_google" : "head_of_meta")) add(id, p === "google" ? "head of Google" : "head of Meta");
  } else {
    // strategy, analysis and anything else: whoever buys for the client
    for (const id of holders(o.seats, "meta_buyer", "google_buyer", "tiktok_buyer")) add(id, "client's buyer");
    for (const id of o.kpiOwners ?? []) add(id, "owns the client's ad account");
    if (!Object.keys(why).length) for (const id of [...byRole("head_of_meta"), ...byRole("head_of_google")]) add(id, "line head");
  }

  // The one who made the promise
  const host = (o.hostEmail ?? "").toLowerCase();
  const owner = host ? o.people.find((p) => (p.email ?? "").toLowerCase() === host && !p.isExec) : undefined;
  add(owner?.id, "made the promise");
  // Execs never get the team's work items: the line heads and the people doing it do
  for (const p of o.people) if (p.isExec) delete why[p.id];
  return { to: Object.keys(why), why };
}

// ─── What the notice says ──────────────────────────────────────────────────

const NY = "America/New_York";
const dayKey = (t: number) => new Date(t).toLocaleDateString("en-CA", { timeZone: NY });

/** "today", "tomorrow", "Fri" or "Mon, Nov 23" */
export function dueWord(dueAt: string, now = Date.now()): string {
  const due = Date.parse(dueAt);
  if (!Number.isFinite(due)) return "soon";
  const a = dayKey(now);
  const b = dayKey(due);
  if (b <= a) return "today";
  if (b === dayKey(now + 86_400_000)) return "tomorrow";
  const days = Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
  const d = new Date(due);
  return days < 7 ? d.toLocaleDateString("en-US", { weekday: "short", timeZone: NY }) : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: NY });
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).replace(/\s+\S*$/, "")}...`);

/** What the promise is for ("to close BFCM"), when the words say it */
export function purposeOf(text: string): string | null {
  const m = /\b(to|so (?:we|they|that we) can|in order to)\s+((?:close|hit|win|beat|capture|support|drive|launch|run|get ready for|be ready for|make|push)\b[^.;,\n]{0,60})/i.exec(text) ?? /\b(for)\s+((?:the\s+)?(?:bfcm|black friday|cyber monday|holiday|sale|launch|promo|promotion)\b[^.;,\n]{0,40})/i.exec(text);
  if (!m) return null;
  const tail = m[2].replace(/\b(and|but|because)\b.*$/i, "").trim();
  return noDash(`${m[1].toLowerCase().startsWith("for") ? "for" : "to"} ${tail}`).replace(/\s+/g, " ");
}

/** "Sierra Dreams: 1 video + 5 images to close BFCM, due tomorrow" */
export function promiseTitle(c: { client: string; what: string; why?: string | null; dueAt: string }, now = Date.now()): string {
  const d = deliverables(c.what);
  const purpose = purposeOf(c.what) ?? purposeOf(c.why ?? "");
  const lead = d.length ? deliverableLine(d, " + ") : clip(noDash(c.what.replace(/^(we('ll| will)?|kaizen will|i('ll| will))\s+/i, "")).replace(/\.$/, ""), 80);
  const body = d.length && purpose ? `${lead} ${purpose}` : lead;
  return noDash(`${c.client}: ${body}, due ${dueWord(c.dueAt, now)}`).slice(0, 200);
}

/** The label a brief card carries: "Sierra Dreams BFCM close (1 video, 5 images)" */
export function briefLabel(c: { client: string; what: string; why?: string | null }): string {
  const d = deliverables(c.what);
  const purpose = purposeOf(c.what) ?? purposeOf(c.why ?? "");
  const theme = purpose ? themeOf(purpose) : "";
  const bits = d.length ? ` (${deliverableLine(d, ", ")})` : "";
  return noDash(`${c.client}${theme ? ` ${theme}` : ""}${bits}`.trim() + (!theme && !bits ? `: ${clip(c.what, 60)}` : ""));
}

export function promiseBody(c: { what: string; why?: string | null; callTitle: string; callAt: string; callUrl?: string | null; reasons?: string[]; role?: string; briefReady?: boolean }): string {
  const day = new Date(c.callAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: NY });
  const parts = [
    c.why ? `Why: ${c.why.replace(/\.$/, "")}.` : `Promised: ${c.what.replace(/\.$/, "")}.`,
    c.reasons?.length ? `Urgent: ${c.reasons.join(", ")}.` : "",
    `From the call "${clip(c.callTitle, 60)}" (${day}).`,
    c.briefReady ? "A brief is ready on your Overview." : "",
    c.callUrl ? `Call notes: ${c.callUrl}` : "",
  ];
  return noDash(parts.filter(Boolean).join(" ")).slice(0, 1000);
}

const VERBS = new Set(["close", "hit", "win", "beat", "capture", "support", "drive", "launch", "run", "push", "make"]);
const cap = (w: string) => (w.toLowerCase() === "bfcm" ? "BFCM" : /[A-Z]/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1));

/** "to close BFCM" is the "BFCM close" a brief is called; "for the Black Friday sale" is "Black Friday Sale" */
function themeOf(purpose: string): string {
  const words = purpose.replace(/^(to|for)\s+/i, "").replace(/\b(the|a|an|our|their)\s+/gi, "").split(/\s+/).filter(Boolean);
  const verb = words.length > 1 && VERBS.has(words[0].toLowerCase()) ? words.shift()!.toLowerCase() : null;
  const rest = words.slice(0, 3).map(cap).join(" ");
  return verb ? `${rest} ${verb}` : rest;
}
