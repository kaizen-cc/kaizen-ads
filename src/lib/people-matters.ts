// Management talk about the people on the team never becomes work (owner, Nov 24 2026): what execs and leads say on a
// call or in meeting notes about someone's performance, conduct, pay, hiring or firing, health or personal life stays
// with them. It never becomes a task, an item, a summary line, a lesson or a note the person or the team can see.
// Pure: tests/people-matters.test.ts. The models are told the same in their own instructions; this is the hard stop.

// About a person, never a campaign or a client's business ("the ad set is underperforming", a psychology practice's
// mental health ads, a law firm's divorce campaign are work): each rule needs someone in it
// "They" and "their" are usually the client or the ads, so a person here is he, she or a role
const WHO = String.raw`(?:he|she|him|her|his|the (?:designer|editor|video editor|buyer|media buyer|strategist|copywriter|manager|coordinator|specialist|intern|contractor|freelancer|new hire)|(?:a |our |the )?(?:teammate|employee|team member|staff member|contractor|freelancer))`;

const PATTERNS: RegExp[] = [
  // Performance and conduct
  new RegExp(String.raw`\b${WHO}\b[^.!?]{0,40}\b(?:under ?perform\w*|not (?:meeting|hitting) expectations|isn'?t (?:cutting it|working out)|keeps? missing deadlines|attitude (?:issue|problem))`, "i"),
  new RegExp(String.raw`\b(?:his|her|their|the (?:designer|editor|buyer|strategist|copywriter)'s) (?:performance (?:review|issue|concern|problem)s?)\b`, "i"),
  /\b(performance improvement plan|(put|putting) (him|her|them) on (a )?pip|written warning|final warning|verbal warning|disciplinar\w*|reprimand\w*)/i,
  // Hiring, firing, replacing a person, probation, leaving
  /\b(let(ting)? (him|her|them) go|fire (him|her)|firing (him|her|them)|terminat\w* (him|her|them|his|her|their)|lay(ing)? (him|her|them) off|replac(e|ing) (him|her)\b|hir(e|ing) (someone )?to replace|demot\w+ (him|her|them)|on probation|probation(ary)? period|exit interview|(he|she|they)('s| is| are)? (resigning|quitting|giving notice|leaving the company)|(his|her|their) notice period)/i,
  // Pay
  new RegExp(String.raw`\b(?:his|her) (?:salary|raise|bonus|compensation)\b|\b(?:a )?(?:raise|bonus|pay cut|pay rise) for (?:him|her|them|the (?:designer|editor|video editor|buyer|strategist|copywriter|coordinator|specialist))\b`, "i"),
  // Health and personal life
  new RegExp(String.raw`\b(?:he|she)(?:'s| is| has| was)?\b[^.!?]{0,30}\b(?:sick|on leave|medical|mental health|burn(?:ed|t)? ?out|pregnan\w+|on maternity|on paternity|going through a divorce|funeral|bereavement|family emergency|personal (?:issue|matter|problem)s?|rehab)`, "i"),
  new RegExp(String.raw`\b(?:his|her) (?:mental health|divorce|pregnancy|maternity leave|paternity leave|family (?:emergency|situation|issues?)|personal (?:life|issues?|matters?|situation)|medical (?:leave|condition|appointment)|diagnosis)\b`, "i"),
  /\b(sick leave|maternity leave|paternity leave|bereavement leave|burnout (risk|on the team)|mental health check-?in)\b/i,
];

/** Whether a line is management talk about a person on the team (never a task, an item or a note) */
export function isPeopleMatter(text: string | null | undefined): boolean {
  const t = String(text ?? "");
  return t.trim().length > 0 && PATTERNS.some((p) => p.test(t));
}

/** Only the lines that aren't */
export const withoutPeopleMatters = <T extends string>(lines: readonly T[] | null | undefined): T[] => (lines ?? []).filter((l) => !isPeopleMatter(l));

/** A paragraph with any sentence about it taken out */
export function scrubPeopleMatters(text: string | null | undefined): string {
  const t = String(text ?? "");
  if (!isPeopleMatter(t)) return t;
  return t
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !isPeopleMatter(s))
    .join(" ")
    .trim();
}

/**
 * Whether a generated item must never be made (owner, Nov 24 2026): it's a people matter by its words, the model
 * flagged it, or the person it would go to is the person it's about. Every automated item generator checks this.
 */
export function blockedForPeople(it: { text: string; personnel?: boolean | null; ownerName?: string | null; about?: readonly (string | null | undefined)[] | null }): boolean {
  if (it.personnel) return true;
  if (isPeopleMatter(it.text)) return true;
  const owner = String(it.ownerName ?? "").trim().toLowerCase();
  if (!owner) return false;
  const first = owner.split(" ")[0];
  return (it.about ?? []).some((a) => {
    const n = String(a ?? "").trim().toLowerCase().replace(/^@/, "");
    return Boolean(n) && (n === owner || n === first || owner.startsWith(n));
  });
}

/** For a model's instructions: the same rule in words */
export const PEOPLE_RULE =
  "Never include management talk about people on the Kaizen team: anyone's performance, conduct, warnings, pay, hiring, firing or replacing someone, probation, health, or personal or family life. It stays with the execs: not in any summary, decision, lesson, promise, task or note, even when the same call talks about a client.";
