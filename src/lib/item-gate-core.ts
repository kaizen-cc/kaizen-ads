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
/** Line heads and execs cover every client buying their lines; support roles every client, for their own scope */
const SUPPORT = new Set(["tracking_specialist", "customer_success", "cs_coordinator", "account_manager", "onboarding_specialist"]);
const covers = (p: Person) => p.isExec || p.role.startsWith("head_of_") || SUPPORT.has(p.role);

const TRACKING = /\b(track(ing|ed)?|pixel|capi|conversions? api|gtm|tag manager|ga4|google analytics|utm|events? (fire|firing)|purchase event)\b/i;
const CREATIVE = /\b(creatives?|design(er|s)?|videos?|edit(s|or)?|ugc|statics?|carousels?|thumbnails?|graphics?|copy ?writ\w*|creative brief|scripts?|hooks?|renders?|resizes?)\b/i;
const ONBOARDING = /\b(onboard\w*|intake|kick-?off|welcome call|portal invite)\b/i;
const PAID = /\b(cpl|cpa|cpc|ctr|roas|ad ?spend|spend|budget|campaigns?|ad ?sets?|ads|cost per (lead|result|registration)|leads?|media buy\w*|launch\w*|page posts?|boost\w*|fatigue|frequency|per day)\b|\$\d+\s*\/\s*day/i;
const EMAIL_TOOLS = /\b(brevo|mailchimp|omnisend|attentive|postscript|newsletter)\b/i;
const SITE_CHANGE = /\b(remove|update|add|change|fix|edit|build|take down|put|post|upload|redesign|proposal|page speed|feedback)\b[^.]{0,60}\b(website|site|homepage|web ?page)\b|\b(website|site|homepage)\b[^.]{0,30}\b(proposal|feedback|edits?|build|redesign)\b|\bmissing from\b[^.]{0,30}\b(website|site)\b/i;

/**
 * The line some work belongs to: its title decides (the first line), its notes only when the title is unclear (notes
 * carry links and side remarks: a Gmail link isn't Google Ads work); the client's paid line for generic ad talk
 */
export function workLine(text: string, clientBuys: readonly WorkLine[] = []): WorkLine | null {
  const [title, ...rest] = text.split("\n");
  return lineOfWords(title, clientBuys) ?? lineOfWords(rest.join(" "), clientBuys);
}

function lineOfWords(text: string, clientBuys: readonly WorkLine[]): WorkLine | null {
  const t = text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\[[^\]]{1,24}\]\s*/, "")
    .replace(/\bgoogle (docs?|drive|sheets?|slides?|calendar|meet|workspace|business profile|chat|builder)\b|\bgmail\b|\blegit ?script\b/gi, " ");
  if (!t.trim()) return null;
  // The client's site, unless it's ad or lead talk about it ("website leads dropping" is the ads' and tracking's)
  if (isWebRequest(t) && (!PAID.test(t) || SITE_CHANGE.test(t))) return "web";
  if (EMAIL_TOOLS.test(t)) return "email";
  const named = lineFromWords(t);
  // Tracking is its own line unless the work names a paid platform ("push the Meta rep on the pixel" is Meta's)
  if (TRACKING.test(t) && (!named || named === "account" || named === "social")) return "tracking";
  // "account manager" words are the account line; "social" alone is often "social proof" in ad talk, so ads win
  if (named === "social" && PAID.test(t) && !/\b(organic|social (media|posts?|calendar|content)|community)\b/i.test(t)) {
    // fall through to paid
  } else if (named) return named;
  if (ONBOARDING.test(t)) return "onboarding";
  // Generic ad talk is the client's paid line; a client with no paid line has none (an email "campaign")
  if (PAID.test(t)) {
    const paid = (["meta", "google", "tiktok"] as const).find((l) => clientBuys.includes(l));
    if (paid || !clientBuys.length) return paid ?? "meta";
  }
  if (CREATIVE.test(t)) return "creative";
  return null;
}

/**
 * The seat on a line that does this kind of work (owner, Nov 27 2026: an email strategist's campaign planning landed on
 * the email designer). Email: design → designer, build and QA → builder, everything else (strategy, client comms,
 * offers, copy decisions) → strategist. Paid lines have one seat (the buyer); creative production is the creative
 * line already.
 */
const EMAIL_DESIGN = /\b(design\w*|mock-?ups?|banners?|visuals?|graphics?|images?|layout|figma|hero|header|blocks?|artwork|flyers?|photos?|bold|enlarge|fonts?|colou?rs?|swap\w*|resiz\w*|gifs?)\b/i;
const EMAIL_BUILD = /\b(build\w*|code|coding|html|qa|test sends?|(re)?schedul\w*|upload\w*|set ?up|segment\w*|flow (setup|build)|in klaviyo|klaviyo (build|setup)|template|send (time|in|at)|pst|est|cst|time ?zone|resend)\b/i;
export function seatFor(line: WorkLine, text: string): string | null {
  if (line !== "email") return null;
  const t = text.split("\n")[0];
  // Planning, client talk and decisions are the strategist's even when they mention a build ("prep three campaigns")
  if (/\b(reply|answer|confirm|ask|tell|plan\w*|prep\w*|decid\w*|strategy|calendar|offer|copy|approv\w*|review|watch)\b/i.test(t) && !/\b(design|build|code|qa)\b/i.test(t)) return "email_strategist";
  if (EMAIL_DESIGN.test(t)) return "email_designer";
  if (EMAIL_BUILD.test(t)) return "email_builder";
  return "email_strategist";
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
export function gate(input: { person: Person; text: string; line?: WorkLine | null; client: ClientTeam | null; dir: Directory; handoff?: boolean }): Gate {
  const { person, client, dir } = input;
  if (!client) return { verdict: "keep", line: input.line ?? null };
  const buys = linesOf(client.services, client.seats) as WorkLine[];
  // Creative and the account are every client's (heads and execs on them cover every client)
  const covered = [...buys, "creative", "account"] as WorkLine[];
  const [title, ...rest] = input.text.split("\n");
  const fromTitle = input.line ?? lineOfWords(title, buys);
  const line = fromTitle ?? lineOfWords(rest.join(" "), buys);
  const mine = linesOfPerson(person);
  const seated = (l: WorkLine | null) => client.seats.some((s) => s.profileId === person.id && (!l || SEAT_LINE[s.seat] === l));
  const named = (id: string) => dir.people.find((p) => p.id === id)?.name ?? "them";
  // A hand-off ("Hand to X · …") is theirs to delegate when the client is theirs at all
  if (input.handoff) {
    if (seated(null) || SUPPORT.has(person.role) || (covers(person) && [...mine].some((l) => covered.includes(l)))) return { verdict: "keep", line };
    return { verdict: "drop", line, why: "Not your client" };
  }
  if (!line) {
    // Unclear work: theirs on a client they're on, or one that buys a line they head; else the client's main seat
    if (seated(null) || (covers(person) && [...mine].some((l) => covered.includes(l)))) return { verdict: "keep", line: null };
    for (const l of ["meta", "google", "tiktok", "email", "social"] as const) {
      if (!buys.includes(l)) continue;
      const h = client.seats.filter((x) => (LINE_SEATS[l] ?? []).includes(x.seat)).sort((a, b) => Number(b.primary !== false) - Number(a.primary !== false))[0];
      if (h) return h.profileId === person.id ? { verdict: "keep", line: null } : { verdict: "route", line: l, toId: h.profileId, toName: h.name, why: `Not your client: ${h.name} runs it` };
    }
    return { verdict: "drop", line: null, why: "Not your client" };
  }
  // A line the client doesn't buy is nobody's, when the work itself says so (a line read from its notes, or someone on
  // the client, keeps it as theirs)
  if (BOUGHT.has(line) && buys.length && !buys.includes(line)) {
    if (seated(null) || !fromTitle) return seated(null) ? { verdict: "keep", line: null } : gate({ ...input, line: null, text: "" });
    return { verdict: "drop", line, why: `The client doesn't buy ${LINE_WORD[line]}` };
  }
  // Creative is everyone's on a client: whoever works the client keeps it; a line read only from the notes doesn't take
  // an item off someone on the client
  if ((line === "creative" || !fromTitle) && seated(null)) return { verdict: "keep", line };
  const to = (id: string, why: string): Gate => (id === person.id ? { verdict: "keep", line } : { verdict: "route", line, toId: id, toName: named(id), why });
  if (line === "web") return dir.webOwnerId ? to(dir.webOwnerId, "Web requests go to whoever hands them to the web team") : { verdict: "drop", line, why: "No one hands web requests on yet" };
  const want = seatFor(line, input.text);
  const holderOf = (seat: string) => client.seats.filter((s) => s.seat === seat).sort((a, b) => Number(b.primary !== false) - Number(a.primary !== false))[0];
  // On the line but not the seat that does this kind of work: that seat's holder, when the client has one
  if (want && mine.has(line) && !covers(person) && seated(line)) {
    const h = holderOf(want);
    if (!h || h.profileId === person.id || client.seats.some((s) => s.profileId === person.id && s.seat === want)) return { verdict: "keep", line };
    return to(h.profileId, `${want.replace(/_/g, " ").replace("email ", "")} work on this client's email is ${h.name}'s`);
  }
  if (mine.has(line) && (covers(person) || seated(line))) return { verdict: "keep", line };
  // The seat on that client's line that does this kind of work, else the line's seats in order, primary first
  for (const seat of [...(want ? [want] : []), ...(LINE_SEATS[line] ?? [])]) {
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
