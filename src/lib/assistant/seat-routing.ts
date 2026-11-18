// Who on a client "the media buyer", "the strategist" or "the account lead" means: through the lines the client
// actually buys (Meta, Google, TikTok, email, social) and who sits in each seat, defaulting to the line of the agent on
// the call (the Media Buyer's "the buyer" is the client's Meta buyer). Never a seat for a line the client doesn't buy;
// an empty seat falls to the next sensible owner on that line (another seat on it, then the line's head). Pure: no
// keys, no network, tested on its own.

import type { TeamRole } from "@/lib/roles";

export type Line = "meta" | "google" | "tiktok" | "email" | "social" | "creative" | "account";

/** The lines a client has to buy before anyone can be routed there (creative and the account are every client's) */
const BOUGHT_LINES: ReadonlySet<Line> = new Set(["meta", "google", "tiktok", "email", "social"]);

/** clients.services slugs to lines */
export const LINE_OF_SERVICE: Record<string, Line> = {
  "facebook-ads": "meta",
  "google-ads": "google",
  "tiktok-ads": "tiktok",
  "email-marketing": "email",
  "social-media": "social",
  creative: "creative",
};

/** Each seat on a client (client_assignments.role) and its line */
export const SEAT_LINE: Record<string, Line> = {
  coordinator: "account",
  meta_buyer: "meta",
  google_buyer: "google",
  tiktok_buyer: "tiktok",
  email_strategist: "email",
  email_designer: "email",
  email_builder: "email",
  social_manager: "social",
  social_creative: "social",
  graphic_designer: "creative",
  video_editor: "creative",
  copywriter: "creative",
};

/** A seat in words, for what the agent says ("the Meta buyer") */
export const SEAT_LABEL: Record<string, string> = {
  coordinator: "account manager",
  meta_buyer: "Meta buyer",
  google_buyer: "Google buyer",
  tiktok_buyer: "TikTok buyer",
  email_strategist: "email strategist",
  email_designer: "email designer",
  email_builder: "email builder",
  social_manager: "social media manager",
  social_creative: "social designer",
  graphic_designer: "designer",
  video_editor: "video editor",
  copywriter: "copywriter",
};

/** The line each agent works on (its "the buyer" is that line's buyer); agents across lines have none */
export const AGENT_LINE: Record<string, Line> = {
  media_buyer: "meta",
  google_buyer: "google",
  tiktok_buyer: "tiktok",
  email_strategist: "email",
  email_creative: "email",
  email_builder: "email",
  social_strategist: "social",
  creative_director: "creative",
  copywriter: "creative",
  account_manager: "account",
};

/** Who answers for a line when its seats on a client are empty: the line's head (execs for the account) */
export const LINE_HEAD: Record<Line, TeamRole[]> = {
  meta: ["head_of_meta"],
  google: ["head_of_google"],
  tiktok: ["head_of_meta"],
  email: ["head_of_email"],
  social: ["head_of_social"],
  creative: ["head_of_creative"],
  account: ["customer_success", "executive"],
};

/** The seat a line's work goes to when no role is named */
const LINE_OWNER: Record<Line, string> = { meta: "meta_buyer", google: "google_buyer", tiktok: "tiktok_buyer", email: "email_strategist", social: "social_manager", creative: "coordinator", account: "coordinator" };
/** The other seats on a line, in the order an empty seat falls to them */
const LINE_SEATS: Record<Line, string[]> = {
  meta: ["meta_buyer"],
  google: ["google_buyer"],
  tiktok: ["tiktok_buyer", "meta_buyer"],
  email: ["email_strategist", "email_builder", "email_designer"],
  social: ["social_manager", "social_creative"],
  creative: ["coordinator", "graphic_designer", "video_editor", "copywriter"],
  account: ["coordinator"],
};

/** The lines a client works on: what it buys, plus any line someone holds a seat on (Track isn't always right) */
export function clientLines(services: readonly string[], seats: readonly { seat: string }[] = []): Line[] {
  const out = new Set<Line>();
  for (const s of services) if (LINE_OF_SERVICE[s]) out.add(LINE_OF_SERVICE[s]);
  for (const s of seats) if (SEAT_LINE[s.seat] && BOUGHT_LINES.has(SEAT_LINE[s.seat])) out.add(SEAT_LINE[s.seat]);
  return [...out];
}

/** The line words name ("the Meta media buyer" → meta), or null */
export function lineFromWords(text: string): Line | null {
  const t = ` ${text.toLowerCase()} `;
  if (/\b(meta|facebook|instagram|fb|ig)\b/.test(t)) return "meta";
  if (/\b(google|pmax|search ads|youtube)\b/.test(t)) return "google";
  if (/\btik ?tok\b/.test(t)) return "tiktok";
  if (/\b(email|e-mail|klaviyo|sms|flows?)\b/.test(t)) return "email";
  if (/\b(organic|social)\b/.test(t)) return "social";
  if (/\b(account (?:manager|lead|owner)|coordinator|customer success|cs)\b/.test(t)) return "account";
  return null;
}

/** The seat a role word means on a line ("strategist" is the email strategist on email, the buyer on paid) */
function seatOfWord(text: string, line: Line | null): string | null {
  const t = text.toLowerCase();
  if (/\b(account (?:manager|lead|owner)|coordinator|customer success|cs|am)\b/.test(t)) return "coordinator";
  if (/\bcopy ?writer\b/.test(t)) return "copywriter";
  if (/\bvideo editor|editor\b/.test(t)) return line === "social" ? "social_creative" : "video_editor";
  if (/\bbuilder\b/.test(t)) return "email_builder";
  if (/\bdesigner\b/.test(t)) return line === "email" ? "email_designer" : line === "social" ? "social_creative" : "graphic_designer";
  if (/\b(social (?:media )?manager|community manager)\b/.test(t)) return "social_manager";
  if (/\b(buyer|media buyer|ads? (?:person|guy|manager))\b/.test(t)) return line === "google" ? "google_buyer" : line === "tiktok" ? "tiktok_buyer" : line === "meta" || !line || line === "account" || line === "creative" ? "meta_buyer" : null;
  if (/\bstrategist|strategy\b/.test(t)) return line === "email" ? "email_strategist" : line === "social" ? "social_manager" : line === "google" ? "google_buyer" : line === "tiktok" ? "tiktok_buyer" : line === "meta" ? "meta_buyer" : "coordinator";
  return null;
}

export type SeatHolder = { seat: string; profileId: string; name: string; primary?: boolean | null };

export type SeatRoute =
  | { kind: "seat"; line: Line; seat: string; holder: SeatHolder }
  /** The seat named is empty: the next owner on that line (another seat, or the line's head: `heads` roles to look up) */
  | { kind: "fallback"; line: Line; seat: string; holder: SeatHolder | null; heads: TeamRole[]; why: string }
  | { kind: "not_bought"; line: Line; lines: Line[] }
  | { kind: "unclear" };

/**
 * Where a hand-off on a client goes. `words`: what was said about who (a role word, a line, or nothing); `agentRole`:
 * the agent on the call (its line is the default); `lines`: what the client buys (clientLines); `seats`: who holds
 * each seat (primary first). A line the client doesn't buy is never routed to; an empty seat falls to another seat
 * on the line, then the line's head.
 */
export function routeSeat(input: { words: string; agentRole?: string | null; lines: readonly Line[]; seats: readonly SeatHolder[] }): SeatRoute {
  const words = input.words ?? "";
  const agentLine = input.agentRole ? (AGENT_LINE[input.agentRole] ?? null) : null;
  const named = lineFromWords(words);
  // A role word without a line takes the agent's line, unless the role word is itself a line ("email strategist")
  const line0 = named ?? agentLine;
  const seat0 = seatOfWord(words, line0);
  const line: Line | null = named ?? (seat0 ? SEAT_LINE[seat0] : null) ?? agentLine;
  if (!line) return { kind: "unclear" };
  const known = input.lines.length > 0;
  if (known && BOUGHT_LINES.has(line) && !input.lines.includes(line)) return { kind: "not_bought", line, lines: [...input.lines] };
  const seat = seat0 && SEAT_LINE[seat0] === line ? seat0 : (seatOfWord(words, line) ?? LINE_OWNER[line]);
  const holdersOf = (s: string) => input.seats.filter((x) => x.seat === s).sort((a, b) => Number(b.primary !== false) - Number(a.primary !== false));
  const holder = holdersOf(seat)[0];
  if (holder) return { kind: "seat", line, seat, holder };
  for (const other of LINE_SEATS[line]) {
    if (other === seat) continue;
    const h = holdersOf(other)[0];
    if (h) return { kind: "fallback", line, seat, holder: h, heads: [], why: `No ${SEAT_LABEL[seat] ?? seat} on the client, so it goes to the ${SEAT_LABEL[other] ?? other}` };
  }
  return { kind: "fallback", line, seat, holder: null, heads: LINE_HEAD[line], why: `No ${SEAT_LABEL[seat] ?? seat} on the client, so it goes to the line's head` };
}

/** The client's team for an agent's context: each line it buys and who sits in each seat, by role */
export function teamLines(name: string, lines: readonly Line[], seats: readonly SeatHolder[]): string {
  const first = (n: string) => n.trim().split(/\s+/)[0] || n;
  const bySeat = new Map<string, string[]>();
  for (const s of seats) bySeat.set(s.seat, [...(bySeat.get(s.seat) ?? []), first(s.name)]);
  const seatsTxt = [...bySeat.entries()].map(([seat, people]) => `${SEAT_LABEL[seat] ?? seat}: ${people.join(", ")}`);
  const lineWord: Record<Line, string> = { meta: "Meta ads", google: "Google ads", tiktok: "TikTok ads", email: "email", social: "organic social", creative: "creative", account: "account" };
  const bought = lines.filter((l) => BOUGHT_LINES.has(l)).map((l) => lineWord[l]);
  return `<client_team client="${name.replace(/"/g, "")}">\nLines they buy: ${bought.length ? bought.join(", ") : "not on record"}. Hand work only to these lines; never offer or route to a role on a line they don't buy.\nSeats: ${seatsTxt.length ? seatsTxt.join("; ") : "none on record"}.\n</client_team>`;
}
