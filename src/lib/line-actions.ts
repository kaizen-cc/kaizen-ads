// Who may act on a client's line from a chat (the client page's chat, Ask about <client>, huddles, Kaizen AI and the
// assistant): run audits and re-audits, start sprints, change or launch, create requests for the line, send asks and
// tasks to teammates, change the client's Klaviyo. The owner's rule (Nov 19 2026): executives on every line; a line's
// head on their own line; the person in that line's seat on that client. Everyone else in a client chat views the
// data and asks questions: a Google buyer never runs a Meta audit, an email builder never runs any audit. Pure, so the
// server's checks (src/lib/line-actions-server.ts), the chats' prompts and the tests share it.

export type ActLine = "meta" | "google" | "tiktok" | "email" | "social" | "creative";
export type LineVerdict = { ok: true; reason: null } | { ok: false; reason: string };
export type LineWho = { role: string | null | undefined; isExec?: boolean | null };

const LABEL: Record<ActLine, string> = { meta: "Meta", google: "Google Ads", tiktok: "TikTok", email: "email", social: "organic social", creative: "creative" };
/** The heads who act on each line */
const HEADS: Record<ActLine, string[]> = {
  meta: ["head_of_meta"],
  google: ["head_of_google"],
  tiktok: ["head_of_meta"],
  email: ["head_of_email"],
  social: ["head_of_social"],
  // Creative requests come from the creative team's head and the ads lines that brief them
  creative: ["head_of_creative", "head_of_meta", "head_of_google"],
};
const HEAD_WORDS: Record<ActLine, string> = { meta: "the head of Meta", google: "the head of Google", tiktok: "the head of Meta", email: "the head of email", social: "the head of social", creative: "the head of creative" };
/** The seats on a client that own each line there */
const OWNERS: Record<ActLine, string[]> = {
  meta: ["meta_buyer"],
  google: ["google_buyer"],
  tiktok: ["tiktok_buyer", "meta_buyer"],
  email: ["email_strategist"],
  social: ["social_manager"],
  creative: ["meta_buyer", "google_buyer", "tiktok_buyer"],
};
const OWNER_WORDS: Record<ActLine, string> = { meta: "Meta buyer", google: "Google buyer", tiktok: "TikTok buyer", email: "email strategist", social: "social media manager", creative: "media buyer" };

/** Every seat that owns a line somewhere (asks and tasks to teammates come from these, the heads and the executives) */
export const OWNER_SEATS = [...new Set(Object.values(OWNERS).flat())];

const isExec = (me: LineWho) => Boolean(me.isExec) || me.role === "executive";
const YES: LineVerdict = { ok: true, reason: null };

/** "Only the Meta buyer on this client, the head of Meta or an exec can run a Meta audit." */
export const onlyWho = (line: ActLine, doing: string) => `Only the ${OWNER_WORDS[line]} on this client, ${HEAD_WORDS[line]} or an exec can ${doing}.`;

/**
 * Whether this person may act on this line of this client. seats: the seat roles they hold on the client
 * (client_assignments.role). doing: what they're doing, for the refusal ("run a Meta audit").
 */
export function mayActOnLine(me: LineWho, line: ActLine, seats: readonly string[], doing = `act on ${LABEL[line]}`): LineVerdict {
  if (isExec(me)) return YES;
  if (HEADS[line].includes(String(me.role ?? ""))) return YES;
  if (OWNERS[line].some((s) => seats.includes(s))) return YES;
  return { ok: false, reason: onlyWho(line, doing) };
}

/** Running an audit or a re-audit, or starting a sprint, on a line */
export const mayAudit = (me: LineWho, line: ActLine, seats: readonly string[]) => mayActOnLine(me, line, seats, `run ${line === "email" ? "an email" : line === "social" ? "an organic social" : `a ${LABEL[line]}`} audit or sprint`);

/** The line an ad platform is on */
export const lineOfPlatform = (platform: string | null | undefined): ActLine | null => (platform === "meta" || platform === "google" || platform === "tiktok" ? platform : null);

/**
 * Sending an ask or a task about a client to someone else: executives, any line head, or someone who owns a line on the
 * client (its buyer, email strategist or social media manager). An FYI (just so they know) is open to everyone.
 */
export function mayAskTeammate(me: LineWho, seats: readonly string[], kind: "task" | "ask" | "fyi" = "task"): LineVerdict {
  if (kind === "fyi" || isExec(me) || String(me.role ?? "").startsWith("head_of_") || OWNER_SEATS.some((s) => seats.includes(s))) return YES;
  return { ok: false, reason: "Asks and tasks for the team on a client come from the client's buyer, strategist or social media manager, a line head or an exec. You can still share it as an FYI, or ask them to send it." };
}

/**
 * The whole-business audit (every line at once): executives, the line heads, and the client's seated buyers,
 * strategists and social media managers. Designers, editors, builders, copywriters and customer success never run it.
 */
export function mayBusinessAudit(me: LineWho, seats: readonly string[]): LineVerdict {
  if (isExec(me) || String(me.role ?? "").startsWith("head_of_") || OWNER_SEATS.some((s) => seats.includes(s))) return YES;
  return { ok: false, reason: "Only the client's buyers and strategists, the line heads or an exec can run a full business audit." };
}

/** The lines this person may act on for a client (for the chat's prompt) */
export function actingLines(me: LineWho, seats: readonly string[], lines: readonly ActLine[] = ["meta", "google", "email", "social"]): ActLine[] {
  return lines.filter((l) => mayActOnLine(me, l, seats).ok);
}

/** For a chat's system prompt: which audits, sprints and team asks this person may start here, and that the rest is read only */
export function lineActionsPrompt(me: LineWho, seats: readonly string[]): string {
  const can = actingLines(me, seats);
  const all: ActLine[] = ["meta", "google", "email", "social"];
  const cannot = all.filter((l) => !can.includes(l));
  const asks = mayAskTeammate(me, seats).ok;
  if (!cannot.length && asks) return "Audits, re-audits and sprints: this person may run them on every line here, and may send asks and tasks to the team.";
  return [
    can.length ? `Audits, re-audits and sprints: this person may run them for ${can.map((l) => LABEL[l]).join(" and ")} only.` : "Audits, re-audits and sprints: none for this person; here they view the data and ask questions.",
    cannot.length ? `Never offer or start one for ${cannot.map((l) => LABEL[l]).join(" or ")}: ${cannot.map((l) => onlyWho(l, `run ${l === "email" ? "an email" : l === "social" ? "an organic social" : `a ${LABEL[l]}`} audit`)).join(" ")}` : "",
    asks ? "" : "Asks and tasks to teammates: not theirs to send (an FYI is fine); say who can.",
  ]
    .filter(Boolean)
    .join(" ");
}
