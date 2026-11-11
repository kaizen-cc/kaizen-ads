// The brief checked against itself before it's ready: the contradictions an editor hits when one line says one thing
// and another the opposite ("9:16 only" next to 4x5 file names, "show Best Tickets in the first 3s" next to "no logo,
// no domains", "use the Oct 21 event footage" next to "no event-specific content"), sizes outside Kaizen's 4:5 and 9:16,
// durations a placement can't run, edit-level direction that takes the HOW away from the maker (transitions, exact cut
// points, camera moves, a named track: a video's beats are its spine, how it's cut is not), and the two-page limits (5
// Must, 5 Never, a video with beats, a carousel with its slides, an image with its headline). Hard issues block
// "ready"; soft ones are a heads-up. Each comes with a one-click fix when there's an obvious one (sizes, a phrase to
// replace) or an instruction the revise chat carries out. The AI pass (consistency against the Brand Bible's cleared
// claims and the rest) adds to these on the server. Pure: tested in tests/brief-lint.test.ts.

import { aiMediaIn, hasConsentLine, hasDisclaimerLine, likenessIn } from "./ai-content";
import { checkPayoff } from "./brief-payoff";
import { LIMITS, frameOf, parseBrief, slideRows } from "./brief-spec";

export type LintFix =
  | { kind: "sizes"; sizes: string[]; label: string }
  | { kind: "replace"; from: string; to: string; label: string }
  | { kind: "ai"; instruction: string; label: string };
export type LintIssue = { id: string; severity: "hard" | "soft"; message: string; fixes: LintFix[] };

export type LintInput = {
  text: string;
  title?: string;
  /** The ticket's sizes ("4x5", "9x16") */
  sizes: string[];
  formats: string[];
  /** The client's name, to catch it shown on screen against a no-branding rule */
  client?: string | null;
  /** What the client said against AI content (src/lib/ai-content.ts aiContentRule), when they did */
  noAiRule?: string | null;
};

const KAIZEN_SIZES = ["4x5", "9x16"];
const sizeKey = (s: string) => s.replace(/[:×]/, "x").replace(/\s+/g, "").toLowerCase();
const label = (s: string) => s.replace("x", ":");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every size the text names, by key ("4x5", "9x16", "1x1", "16x9") */
function sizesNamed(text: string) {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![\d.])(4|9|1|16)\s?[:x×]\s?(5|16|1|9)(?![\d])/gi)) {
    const k = `${m[1]}x${m[2]}`;
    if (["4x5", "9x16", "1x1", "16x9"].includes(k)) out.add(k);
  }
  if (/\bsquare (?:format|version|crop|size|post)\b/i.test(text)) out.add("1x1");
  if (/\blandscape (?:format|version|crop|size|video)\b/i.test(text)) out.add("16x9");
  return out;
}

export function lintBrief(i: LintInput): LintIssue[] {
  const text = `${i.title ?? ""}\n${i.text}`;
  const lower = text.toLowerCase();
  const sizes = i.sizes.map(sizeKey);
  const issues: LintIssue[] = [];
  const named = sizesNamed(text);

  // Sizes outside 4:5 and 9:16, anywhere
  for (const k of [...named].filter((k) => !KAIZEN_SIZES.includes(k))) {
    const shown = new RegExp(`(?<![\\d.])${k.split("x")[0]}\\s?[:x×]\\s?${k.split("x")[1]}(?![\\d])`, "i").exec(text)?.[0] ?? label(k);
    issues.push({
      id: `size-${k}`,
      severity: "hard",
      message: `The brief mentions ${label(k)}. Kaizen makes 4:5 and 9:16 only.`,
      fixes: [{ kind: "replace", from: shown, to: k === "16x9" ? "9:16" : "4:5", label: `Change ${shown} to ${k === "16x9" ? "9:16" : "4:5"}` }],
    });
  }
  for (const s of sizes.filter((k) => !KAIZEN_SIZES.includes(k))) issues.push({ id: `ticket-size-${s}`, severity: "hard", message: `The request is set to ${label(s)}. Kaizen makes 4:5 and 9:16 only.`, fixes: [{ kind: "sizes", sizes: sizes.filter((k) => KAIZEN_SIZES.includes(k)).length ? sizes.filter((k) => KAIZEN_SIZES.includes(k)) : KAIZEN_SIZES, label: "Use 4:5 and 9:16" }] });

  // "9:16 only" against the request's sizes or file names in the other size
  const only = /(?<![\d.])(4|9)\s?[:x×]\s?(5|16)\s+only\b/i.exec(text);
  if (only) {
    const k = `${only[1]}x${only[2]}`;
    const other = KAIZEN_SIZES.find((x) => x !== k)!;
    const fileOther = new RegExp(`[_-]${other.replace("x", "[x:]")}\\b`, "i").test(text);
    if (sizes.includes(other) || fileOther)
      issues.push({
        id: "size-only",
        severity: "hard",
        message: `It says "${only[0]}", but ${sizes.includes(other) ? `the request also asks for ${label(other)}` : `file names use ${label(other)}`}.`,
        fixes: [
          { kind: "replace", from: only[0], to: "4:5 and 9:16", label: "Make it both sizes" },
          { kind: "sizes", sizes: [k], label: `Only ${label(k)}` },
        ],
      });
  }
  // File names in a size the request doesn't make
  for (const k of KAIZEN_SIZES) {
    if (sizes.includes(k) || !sizes.length) continue;
    if (new RegExp(`[_-]${k.replace("x", "[x:]")}\\b`, "i").test(text) && !issues.some((x) => x.id === "size-only"))
      issues.push({ id: `file-${k}`, severity: "hard", message: `File names use ${label(k)}, but the request doesn't make ${label(k)}.`, fixes: [{ kind: "sizes", sizes: [...new Set([...sizes, k])], label: `Add ${label(k)}` }] });
  }

  // No logo or branding, against a hook that shows the brand
  const noBrand = /\b(?:no|without|avoid|don'?t (?:show|use|put)|never show)\b[^.\n]{0,30}\b(?:logos?|branding|brand name|domains?|urls?|websites?)\b/i.exec(text);
  if (noBrand) {
    const client = i.client?.trim();
    const showsBrand =
      /\b(?:show|open (?:on|with)|lead with|put|add|end (?:card|on|with))\b[^.\n]{0,40}\b(?:logo|brand(?:ing)?|domain|url|website)\b/i.exec(text) ??
      (client ? new RegExp(`\\b(?:show|open (?:on|with)|lead with|put|feature|say)\\b[^.\\n]{0,30}${escape(client)}[^.\\n]{0,30}\\b(?:first|opening|in the first|on screen|end)`, "i").exec(text) : null) ??
      /\b[a-z0-9-]+\.(?:com|co|net|org|io|ca)\b/i.exec(text.replace(/https?:\/\/\S+/g, ""));
    if (showsBrand && !noBrand[0].toLowerCase().includes(showsBrand[0].toLowerCase()))
      issues.push({
        id: "brand-vs-hook",
        severity: "hard",
        message: `"${noBrand[0].trim()}" contradicts "${showsBrand[0].trim()}".`,
        fixes: [{ kind: "ai", instruction: `The brief contradicts itself on branding: "${noBrand[0].trim()}" against "${showsBrand[0].trim()}". Keep the client's branding rule from the Brand Bible and make every line agree with it.`, label: "Resolve with the Brand Bible" }],
      });
  }

  // Evergreen / no event-specific content, against event footage or a dated event
  const noEvent = /\b(?:no|avoid|without|don'?t use)\b[^.\n]{0,20}\b(?:event[- ]specific|dated|date[- ]specific|time[- ]bound)\b[^.\n]{0,20}|\bevergreen\b/i.exec(text);
  if (noEvent) {
    const eventUse = /\b(?:use|from|feature|show)\b[^.\n]{0,40}\b(?:event|game|show|concert|match)(?: footage| clips?| photos?| video)\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}(?:st|nd|rd|th)? (?:event|game|show|concert|match)\b/i.exec(text);
    if (eventUse)
      issues.push({
        id: "event-vs-footage",
        severity: "hard",
        message: `"${noEvent[0].trim()}" contradicts "${eventUse[0].trim()}".`,
        fixes: [{ kind: "ai", instruction: `The brief contradicts itself: "${noEvent[0].trim()}" against "${eventUse[0].trim()}". Decide from the request's goal whether this is evergreen or event-specific and make every line, including the footage, agree.`, label: "Make it agree" }],
      });
  }

  // Durations a placement can't run, or a duration on a static
  const secs = [...lower.matchAll(/\b(\d{1,3})\s?(?:s|sec|secs|seconds)\b(?!\s*(?:in|of|into))/g)].map((m) => Number(m[1])).filter((n) => n > 0);
  const longest = secs.length ? Math.max(...secs) : 0;
  const video = i.formats.includes("video");
  if (video && longest > 90) issues.push({ id: "duration-long", severity: "hard", message: `${longest}s is longer than Reels and Stories run well (up to 60s, 90s at most).`, fixes: [{ kind: "ai", instruction: `Bring the video's length to 60 seconds or less (15 to 30s is the sweet spot for 9:16 placements).`, label: "Fit it to 60s" }] });
  else if (video && longest > 60 && sizes.includes("9x16")) issues.push({ id: "duration-stories", severity: "soft", message: `${longest}s runs past 60s; Stories cut at 60s and Reels do best at 15 to 30s.`, fixes: [] });
  if (!video && secs.length && /\b(?:first|opening)\s+\d{1,2}\s?(?:s|sec|seconds)\b/i.test(text)) issues.push({ id: "duration-static", severity: "soft", message: "It gives seconds, but nothing in this request is video.", fixes: [] });

  // Placeholders where something real belongs
  const holder = /\b(?:MISSING|TBD|TBC|TK|XXX)\b|\[(?:link|url|insert[^\]]*)\]/.exec(i.text);
  if (holder) issues.push({ id: "placeholder", severity: "hard", message: `"${holder[0]}" is a placeholder. Put the real thing in, or list it under Assets as needed.`, fixes: [] });

  // A hook that promises a reveal, a tip or a hack, and a brief that never says what it is
  const parsed = parseBrief(i.text);
  const pay = checkPayoff({ title: i.title, overview: parsed.overview, spec: parsed.spec, text: i.text });
  if (pay.promise && !pay.paid) {
    const instruction = `The hook promises "${pay.promise}" but the brief never says what it is. State exactly what it is in "Why it works", where it comes from (client memory, the Brand Bible, a call, the footage) and how it shows on screen. If the context doesn't hold it, change the hook to one whose payoff we know, or keep it under Confirm with client with a "Fallback:" line giving a version that works without it.`;
    if (!pay.pending) issues.push({ id: "payoff", severity: "soft", message: `The hook promises "${pay.promise}", but the brief never says what it is.`, fixes: [{ kind: "ai", instruction, label: "Pay off the promise" }] });
    else if (!pay.fallback) issues.push({ id: "payoff-fallback", severity: "soft", message: `"${pay.promise}" waits on the client. Add a fallback version that works if they can't confirm it.`, fixes: [{ kind: "ai", instruction: `The hook's payoff ("${pay.promise}") waits on the client. Keep the question under Confirm with client and add a line in the opening that starts "Fallback:" with a version of the concept that works without it.`, label: "Add a fallback" }] });
  }

  // AI media for a client who said no to it: a real contradiction with their own rule (a lead can still send it anyway)
  const aiMedia = i.noAiRule ? aiMediaIn(text) : null;
  if (i.noAiRule && aiMedia)
    issues.push({
      id: "no-ai-content",
      severity: "hard",
      message: `This client said no AI content ("${i.noAiRule}"), but the brief uses "${aiMedia}".`,
      fixes: [{ kind: "ai", instruction: `This client said no AI content: "${i.noAiRule}". Replace every AI avatar, AI or cloned voice, AI narration and AI-generated video, footage or image in the brief ("${aiMedia}" and any other) with real footage, real photos, real people and a real voiceover, keeping the idea, and add "No AI-generated video, images or voices (client rule)" under Never.`, label: "Make it without AI" }],
    });

  // A real person's face or voice altered or generated: the client's written consent and an on-screen disclaimer
  const likeness = aiMedia ? null : likenessIn(text);
  if (likeness && (!hasConsentLine(text) || !hasDisclaimerLine(text))) {
    const missing = [!hasConsentLine(text) && "the client's written consent", !hasDisclaimerLine(text) && "an on-screen disclaimer"].filter(Boolean).join(" and ");
    issues.push({
      id: "likeness-consent",
      severity: "soft",
      message: `"${likeness}" alters or generates a real person's face or voice: that needs ${missing}.`,
      fixes: [{ kind: "ai", instruction: `The brief uses "${likeness}", which alters or generates a real person's likeness or voice. ${!hasConsentLine(text) ? `Add under Confirm with client: "Get the client's written consent for <who>'s likeness/voice", naming who the person is (e.g. the customer in the testimonial). ` : ""}${!hasDisclaimerLine(text) ? `Add a Must line: "Disclaimer: <the on-screen line, e.g. AI-generated likeness, used with permission; or Voice altered>". ` : ""}If it's a stock AI presenter and not a real person, say so instead. Change nothing else.`, label: "Add consent and disclaimer" }],
    });
  }

  // Edit-level direction: a video's beats (what happens, what's said) are the brief's; how it's cut is the maker's. Read
  // everywhere but Never and Your call, where naming transitions or music is handing them over, and not in a script.
  const sp = parsed.spec;
  if (!/(?:^|\n)Script:/i.test(i.text)) {
    const directing = [parsed.overview, sp.hook, ...sp.beats, ...sp.slides, ...sp.frame, sp.audio, ...sp.dos, ...sp.constraints].join("\n");
    const over = [...new Set([...directing.matchAll(OVER_DIRECTION)].map((m) => m[0].trim().toLowerCase()))];
    if (over.length >= 2)
      issues.push({
        id: "over-direction",
        severity: "soft",
        message: `Edit-level direction ("${over.slice(0, 2).join('", "')}"): transitions, exact cut points, camera moves and the track are the maker's call.`,
        fixes: [{ kind: "ai", instruction: `Take out the edit-level direction (${over.slice(0, 4).map((x) => `"${x}"`).join(", ")}): transitions, exact cut points, camera moves and a named music track. Keep each beat's name, what's on screen and the exact line, and leave the rest to the maker in Your call.`, label: "Leave the edit to the maker" }],
      });
  }

  // The two pages: lists of five, and the build the format needs (only for a brief written in today's sections: an
  // older brief isn't asked for beats it was never meant to have)
  const current = Boolean(sp.versions.length || sp.beats.length || sp.frame.length || sp.who || sp.stage || /(?:^|\n)(?:Why it works|Must|Never):/.test(i.text));
  if (parsed.structured && current) {
    if (sp.dos.length > LIMITS.must) issues.push({ id: "must-many", severity: "soft", message: `Must has ${sp.dos.length} items. Keep the 5 that matter most for this concept.`, fixes: [{ kind: "ai", instruction: "Cut Must to the 5 items that matter most for this concept, folding the client's rules into them. Change nothing else.", label: "Keep 5 musts" }] });
    if (sp.donts.length > LIMITS.never) issues.push({ id: "never-many", severity: "soft", message: `Never has ${sp.donts.length} items. Keep the 5 most specific.`, fixes: [{ kind: "ai", instruction: "Cut Never to the 5 most specific items (exact lines, assets or claims not to use), folding the client's don'ts into them. Change nothing else.", label: "Keep 5 nevers" }] });
    if (i.formats.includes("video") && !sp.beats.length && !sp.script.trim())
      issues.push({ id: "video-no-beats", severity: "soft", message: "The video has no beats: say what happens and what's said, in 4 to 6 beats.", fixes: [{ kind: "ai", instruction: "Add the video's Beats: 4 to 6, each with its time, a name, what's on screen and the exact line said or put on screen (from the footage with its source timestamp when we have it), the hook first and the end card last. Add a one-line Audio and the Length. Change nothing else.", label: "Write the beats" }] });
    else if (sp.beats.length > LIMITS.beats) issues.push({ id: "beats-many", severity: "soft", message: `${sp.beats.length} beats. Keep it to 4 to 6.`, fixes: [{ kind: "ai", instruction: "Merge the beats into 4 to 6, keeping the hook first, the exact lines and the end card. Change nothing else.", label: "Keep 6 beats" }] });
    if (i.formats.includes("carousel") && slideRows(sp).length < 2)
      issues.push({ id: "carousel-no-slides", severity: "soft", message: "The carousel has no slide flow: one line per slide, with its headline, what it shows and its job.", fixes: [{ kind: "ai", instruction: "Add the carousel's Slides, one numbered line per slide read top to bottom as a flow: its job (Hook, Proof, Payoff, CTA), the headline on the slide and what it shows. Change nothing else.", label: "Write the slides" }] });
    if (i.formats.includes("image") && !frameOf(sp.frame).headline && !sp.versions.length)
      issues.push({ id: "frame-no-headline", severity: "soft", message: "The single image has no headline: say the words on the frame.", fixes: [{ kind: "ai", instruction: "Add the single image's Frame: the headline (the words on the image), the subline, what's in the frame, what reads first and the CTA if it's on the image. Change nothing else.", label: "Write the frame" }] });
  }

  return issues;
}

/** Transitions, exact cut points, camera moves and a named track: how it's cut, not what happens */
const OVER_DIRECTION =
  /\b(?:whip|swipe|zoom|glitch|spin|cross[- ]?dissolve|dissolve|wipe|flash|j[- ]cut|l[- ]cut|match[- ]cut|jump[- ]cut|hard[- ]cut|smash[- ]cut)\s+(?:transition|to|cut)s?\b|\btransition(?:s)?\s+(?:on|at|between|every|with)\b|\bcut (?:at|on|exactly at|to black at)\s+(?:\d|the beat)|\b(?:dolly|pan|tilt)\s+(?:in|out|up|down|left|right|across)\b|\b(?:push[- ]in|pull[- ]back|crane shot|tracking shot|rack focus|dutch angle|speed ramp|slow[- ]?mo(?:tion)?)\b|\b(?:song|track)\s*:\s*["\u201c]|["\u201c][^"\u201d\n]{2,40}["\u201d]\s+by\s+[A-Z]/gi;

/** A text fix applied: the first occurrence replaced (case kept as written in the fix) */
export function applyTextFix(text: string, from: string, to: string) {
  const at = text.indexOf(from);
  if (at >= 0) return text.slice(0, at) + to + text.slice(at + from.length);
  const re = new RegExp(escape(from), "i");
  return text.replace(re, to);
}

export const hardIssues = (xs: LintIssue[]) => xs.filter((x) => x.severity === "hard");

/**
 * The AI consistency pass's answer: flat, strings only (severity is checked in code: no enums, since the API refuses
 * grammars that are too large)
 */
export const LINT_SCHEMA = {
  type: "object",
  properties: { issues: { type: "array", items: { type: "object", properties: { message: { type: "string" }, severity: { type: "string" }, fix: { type: "string" } }, required: ["message", "severity", "fix"], additionalProperties: false } } },
  required: ["issues"],
  additionalProperties: false,
};
