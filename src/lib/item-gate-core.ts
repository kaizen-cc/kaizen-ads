// The relevance gate (owner, Nov 26 2026: "the OS only assigns things that are relevant to their role and their
// client"; the head of social had eight routine items, all for clients he isn't on and none of them social). Every item
// a routine, the nightly agent or the client-message reader makes passes here before it lands on someone's day:
// 1. Line: the work's line (email/SMS, Meta, Google, TikTok, creative, social, tracking, account, onboarding, web) must
//    be the person's line. Line heads and the people on a line get only that line's work; execs only their focus
//    lines; support roles their own scope.
// 2. Client: someone on a line gets a client's work only when they hold that line's seat on the client; line heads and
//    execs cover every client that buys their line; a line the client doesn't buy is nobody's.
// 3. Not theirs: it goes to the seat on that client's line, else the line's head; never parked with whoever read it.
// 4. Reading a channel or being cc'd doesn't make it theirs: only an explicit ask or their own promise (callers pass
//    those as explicit and skip the gate).
// Pure; tested in tests/item-gate.test.ts.

import { clientLines as linesOf, lineFromWords, LINE_HEAD, SEAT_LINE, type Line, type SeatHolder } from "@/lib/assistant/seat-routing";
import { isWebRequest } from "@/lib/client-signals-core";

export type WorkLine = Line | "tracking" | "web" | "onboarding";

/** Lines a client has to buy (creative, account, tracking, web and onboarding are every client's) */
const BOUGHT: ReadonlySet<WorkLine> = new Set(["meta", "google", "tiktok", "email", "social"]);

/** The lines each role works */
const ROLE_LINES: Record<string, WorkLine[]> = {
  head_of_meta: ["meta", "tiktok"],
  head_of_google: ["google"],
  head_of_email: ["email"],
  head_of_social: ["social"],
  head_of_creative: ["creative"],
  media_buyer: ["meta", "tiktok"],
  meta_buyer: ["meta", "tiktok"],
  google_buyer: ["google"],
  tiktok_buyer: ["tiktok"],
  email_strategist: ["email"],
  email_designer: ["email"],
  email_builder: ["email"],
  email_creative: ["email"],
  social_manager: ["social"],
  social_strategist: ["social"],
  social_creative: ["social"],
  graphic_designer: ["creative"],
  video_editor: ["creative"],
  copywriter: ["creative"],
  creative_director: ["creative"],
  tracking_specialist: ["tracking"],
  customer_success: ["account"],
  cs_coordinator: ["account"],
  account_manager: ["account"],
  onboarding_specialist: ["onboarding"],
};

/** An exec's focus lines as work lines */
const FOCUS_WORK: Record<string, WorkLine | null> = { meta: "meta", google: "google", tiktok: "tiktok", email: "email", social: "social", creative: "creative", creative_performance: "creative", web: "web", crm: null, finance: null };

export type Person = { id: string; name?: string; role: string; isExec: boolean; focus?: readonly string[] | null };

export function linesOfPerson(p: Person): Set<WorkLine> {
  if (p.isExec) return new Set((p.focus ?? []).map((f) => FOCUS_WORK[f]).filter((x): x is WorkLine => Boolean(x)));
  return new Set(ROLE_LINES[p.role] ?? []);
}
const covers = (p: Person) => p.isExec || p.role.startsWith("head_of_");

const TRACKING = /\b(track(ing|ed)?|pixel|capi|conversions? api|gtm|tag manager|ga4|google analytics|utm|events? (fire|firing)|purchase event)\b/i;
const CREATIVE = /\b(creatives?|design(er|s)?|video|edit(s|or)?|ugc|statics?|carousel|thumbnail|graphic|copy ?writ\w*|creative brief|scripts?|hooks?)\b/i;
const ONBOARDING = /\b(onboard\w*|intake|kick-?off|welcome call|portal invite)\b/i;
const PAID = /\b(cpl|cpa|cpc|ctr|roas|ad ?spend|spend|budget|campaigns?|ad ?sets?|ads|cost per (lead|result|registration)|leads? cost|media buy\w*)\b/i;

/** The line some work belongs to, from its words; the client's paid line for generic ad talk; null when unclear */
export function workLine(text: string, clientBuys: readonly WorkLine[] = []): WorkLine | null {
  const t = text.replace(/\bgoogle (docs?|drive|sheets?|slides?|calendar|meet|workspace|business profile)\b/gi, "");
  if (isWebRequest(t)) return "web";
  if (TRACKING.test(t)) return "tracking";
  const named = lineFromWords(t);
  // "account manager" words are the account line; "social" alone is often "social proof" in ad talk, so ads win
  if (named === "social" && PAID.test(t) && !/\b(organic|social (media|posts?|calendar|content)|community)\b/i.test(t)) {
    // fall through to paid
  } else if (named) return named;
  if (ONBOARDING.test(t)) return "onboarding";
  if (PAID.test(t)) return (["meta", "google", "tiktok"] as const).find((l) => clientBuys.includes(l)) ?? "meta";
  if (CREATIVE.test(t)) return "creative";
  return null;
}

export type ClientTeam = { services: readonly string[]; seats: readonly SeatHolder[] };
export type Directory = { people: readonly (Person & { name: string })[]; webOwnerId?: string | null };

export type Gate =
  | { verdict: "keep"; line: WorkLine | null }
  | { verdict: "route"; line: WorkLine; toId: string; toName: string; why: string }
  | { verdict: "drop"; line: WorkLine | null; why: string };

const LINE_WORD: Record<WorkLine, string> = { meta: "Meta", google: "Google", tiktok: "TikTok", email: "email/SMS", social: "social", creative: "creative", account: "account", tracking: "tracking", web: "web", onboarding: "onboarding" };
const LINE_SEATS: Partial<Record<WorkLine, string[]>> = {
  meta: ["meta_buyer"],
  google: ["google_buyer"],
  tiktok: ["tiktok_buyer", "meta_buyer"],
  email: ["email_strategist", "email_builder", "email_designer"],
  social: ["social_manager", "social_creative"],
  creative: ["coordinator", "graphic_designer", "video_editor", "copywriter"],
  account: ["coordinator"],
};
/** Who answers for a line with no seat (or a line with no seats at all) */
const ROLE_OWNER: Partial<Record<WorkLine, string[]>> = { tracking: ["tracking_specialist"], onboarding: ["onboarding_specialist"], account: ["cs_coordinator", "customer_success"] };

/** Whether this person should get this work on this client, and if not, who should */
export function gate(input: { person: Person; text: string; line?: WorkLine | null; client: ClientTeam | null; dir: Directory }): Gate {
  const { person, client, dir } = input;
  if (!client) return { verdict: "keep", line: input.line ?? null };
  const buys = linesOf(client.services, client.seats) as WorkLine[];
  const line = input.line ?? workLine(input.text, buys);
  const mine = linesOfPerson(person);
  const seated = (l: WorkLine | null) => client.seats.some((s) => s.profileId === person.id && (!l || SEAT_LINE[s.seat] === l));
  if (!line) {
    // Unclear work: theirs only on a client they're on, or one that buys a line they head
    if (seated(null) || (covers(person) && [...mine].some((l) => buys.includes(l)))) return { verdict: "keep", line: null };
    return { verdict: "drop", line: null, why: "Not your client" };
  }
  if (BOUGHT.has(line) && buys.length && !buys.includes(line)) return { verdict: "drop", line, why: `The client doesn't buy ${LINE_WORD[line]}` };
  const named = (id: string) => dir.people.find((p) => p.id === id)?.name ?? "them";
  const to = (id: string, why: string): Gate => (id === person.id ? { verdict: "keep", line } : { verdict: "route", line, toId: id, toName: named(id), why });
  if (line === "web") return dir.webOwnerId ? to(dir.webOwnerId, "Web requests go to whoever hands them to the web team") : { verdict: "drop", line, why: "No one hands web requests on yet" };
  if (mine.has(line) && (covers(person) || seated(line))) return { verdict: "keep", line };
  // The seat on that client's line, primary first
  for (const seat of LINE_SEATS[line] ?? []) {
    const h = client.seats.filter((s) => s.seat === seat).sort((a, b) => Number(b.primary !== false) - Number(a.primary !== false))[0];
    if (h) return to(h.profileId, `${LINE_WORD[line]} work on this client is ${h.name}'s`);
  }
  // No seat: the line's head (or the role that owns it)
  const roles = ROLE_OWNER[line] ?? (LINE_HEAD[line as Line] as string[] | undefined) ?? [];
  for (const r of roles) {
    const h = dir.people.find((p) => p.role === r);
    if (h) return to(h.id, `No ${LINE_WORD[line]} seat on this client, so it goes to the line's head`);
  }
  return { verdict: "drop", line, why: `No one holds ${LINE_WORD[line]} for this client` };
}
