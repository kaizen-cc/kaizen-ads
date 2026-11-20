// Who "ask Rahul for an update" means: a teammate found by name or role among the active team, forgiving the way a
// name comes through speech ("Raul" for "Rahul", "Jon" for "John", "Caitlin" for "Kaitlyn") and asking back when two
// people fit equally. Also which words in what someone said ask the assistant to send something to a teammate. Pure:
// no keys, no network, tested on its own.

import { ROLES, type TeamRole } from "@/lib/roles";

export type Teammate = { id: string; fullName: string; role: TeamRole | string; isActive?: boolean | null };

export type TeammateMatch =
  | { kind: "one"; person: Teammate; how: "name" | "first" | "sounds" | "role" }
  | { kind: "several"; people: Teammate[] }
  | { kind: "none" };

/** Lowercase letters only, accents gone */
export const plain = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, " ")
    .replace(/['-]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * How a name sounds, roughly: the spellings speech-to-text swaps for each other folded together (h after a letter,
 * ph and v as f, c and q as k, y as i, z as s, doubled letters once, a trailing e dropped). "Rahul" and "Raul" both
 * become "raul"; "Stephen" and "Steven" both "stefen".
 */
export function soundKey(name: string): string {
  let s = plain(name).replace(/\s+/g, "");
  if (!s) return "";
  s = s
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/q/g, "k")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/v/g, "f")
    .replace(/z/g, "s")
    .replace(/y/g, "i")
    .replace(/(?!^)h/g, "")
    .replace(/(.)\1+/g, "$1");
  if (s.length > 3) s = s.replace(/e$/, "");
  return s;
}

/** Edits between two words (insert, delete, swap a letter) */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Role words people say ("the account manager", "head of email") to the roles they mean */
const ROLE_WORDS: { re: RegExp; roles: TeamRole[] }[] = [
  { re: /\b(account manager|customer success|cs)\b/, roles: ["customer_success"] },
  { re: /\b(onboarding specialist|onboarding)\b/, roles: ["onboarding_specialist"] },
  { re: /\b(tracking specialist|tracking|pixel|capi)\b/, roles: ["tracking_specialist"] },
  { re: /\bhead of (meta|paid social|ads)\b/, roles: ["head_of_meta"] },
  { re: /\bhead of google\b/, roles: ["head_of_google"] },
  { re: /\bhead of creative\b/, roles: ["head_of_creative"] },
  { re: /\bhead of email\b/, roles: ["head_of_email"] },
  { re: /\bhead of (organic )?social\b/, roles: ["head_of_social"] },
  { re: /\b(meta |media )?buyer\b/, roles: ["media_buyer"] },
  { re: /\bgoogle buyer\b/, roles: ["google_buyer"] },
  { re: /\bcopy ?writer\b/, roles: ["copywriter"] },
  { re: /\bemail strategist\b/, roles: ["email_strategist"] },
  { re: /\bemail designer\b/, roles: ["email_designer"] },
  { re: /\bemail builder\b/, roles: ["email_builder"] },
  { re: /\bsocial (media )?manager\b/, roles: ["social_media_manager"] },
  { re: /\b(graphic )?designer\b/, roles: ["graphic_designer", "lead_graphic_designer"] },
  { re: /\bvideo editor\b/, roles: ["video_editor", "lead_video_editor"] },
];

/** The roles a phrase names ("the email strategist"), most specific first; none when it isn't a role */
export function rolesNamed(text: string): TeamRole[] {
  const t = plain(text);
  for (const { re, roles } of ROLE_WORDS) if (re.test(t)) return roles;
  const label = ROLES.find((r) => t === plain(r.label) || t === `the ${plain(r.label)}`);
  return label ? [label.value] : [];
}

/**
 * The teammate a name (or a role) means, among active people (never the person asking unless they name themselves):
 * the full name, then the first name, then a name that sounds the same or is one letter off, then the role. Two people
 * equally close: "several", so the assistant asks which one.
 */
export function resolveTeammate(asked: string, people: readonly Teammate[], opts: { exclude?: string | null } = {}): TeammateMatch {
  const q = plain(asked).replace(/^(the|our|my)\s+/, "");
  if (!q) return { kind: "none" };
  const pool = people.filter((p) => p.isActive !== false && p.fullName?.trim() && p.id !== opts.exclude);
  const pick = (xs: Teammate[], how: "name" | "first" | "sounds" | "role"): TeammateMatch | null => (xs.length === 1 ? { kind: "one", person: xs[0], how } : xs.length > 1 ? { kind: "several", people: xs.slice(0, 5) } : null);

  const full = pool.filter((p) => plain(p.fullName) === q);
  const byFull = pick(full, "name");
  if (byFull) return byFull;

  const words = q.split(" ");
  const first = words[0];
  const last = words.length > 1 ? words[words.length - 1] : null;
  const parts = (p: Teammate) => plain(p.fullName).split(" ");
  // A first name and the start of a last name ("Dana K")
  if (last) {
    const both = pool.filter((p) => parts(p)[0] === first && parts(p).slice(1).some((w) => w.startsWith(last)));
    const r = pick(both, "name");
    if (r) return r;
  }
  const byFirst = pick(
    pool.filter((p) => parts(p)[0] === first),
    "first",
  );
  if (byFirst) return byFirst;
  // A last name on its own ("ask Patel")
  if (!last) {
    const byLast = pick(
      pool.filter((p) => parts(p).slice(1).includes(first)),
      "name",
    );
    if (byLast) return byLast;
  }

  // As it sounds: the same sound key, else the closest within a letter (two for longer names)
  const key = soundKey(first);
  if (key.length >= 2) {
    const same = pool.filter((p) => soundKey(parts(p)[0]) === key);
    const r = pick(same, "sounds");
    if (r) return r;
    const scored = pool
      .map((p) => ({ p, d: editDistance(soundKey(parts(p)[0]), key) }))
      .filter((x) => x.d <= (key.length >= 6 ? 2 : 1))
      .sort((a, b) => a.d - b.d);
    if (scored.length) {
      const best = scored.filter((x) => x.d === scored[0].d).map((x) => x.p);
      const r2 = pick(best, "sounds");
      if (r2) return r2;
    }
  }

  // A role ("the email strategist"): only when exactly one active person holds it
  const roles = rolesNamed(q);
  if (roles.length) {
    const holders = pool.filter((p) => roles.includes(p.role as TeamRole));
    const r = pick(holders, "role");
    if (r) return r;
  }
  return { kind: "none" };
}

/** Words that ask the assistant to send something to a teammate ("ask Rahul for an update", "tell Dana", "ping the strategist") */
const SEND_ASK =
  /\b(ask|tell|ping|message|dm|slack|text|send|let (?:\w+ ){0,3}know|have (?:\w+ ){0,3}(?:do|check|look|send|update)|get (?:\w+ ){0,3}to|check (?:in )?with|follow up with|assign|give (?:\w+ ){0,3}(?:a|the) task|loop (?:\w+ ){0,2}in|remind (?!me\b)\w+|fyi|heads up)\b/i;

/** Whether what they said this turn asks for something to go to a teammate (nothing said: the model's own judgment) */
export function askedToSend(said: string | null | undefined): boolean {
  const t = String(said ?? "").trim();
  if (!t) return true;
  return SEND_ASK.test(t) || /^\s*(yes|yeah|yep|yup|sure|please|ok(?:ay)?|do it|go ahead|send it)\b/i.test(t);
}

export type TeammateKind = "task" | "ask" | "fyi";

/** The line a teammate's Overview row and bell lead with ("Update on Ocean Box's launch?" for an ask) */
export function teammateTitle(kind: TeammateKind, what: string): string {
  const w = what.replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");
  if (!w) return "";
  const cap = w[0].toUpperCase() + w.slice(1);
  if (kind === "fyi") return /^fyi\b/i.test(cap) ? cap : `FYI: ${cap}`;
  if (kind === "ask") return /\?$/.test(cap) ? cap : `${cap}?`;
  return cap;
}
