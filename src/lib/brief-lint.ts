// The brief checked against itself before it's ready: the contradictions an editor hits when one line says one thing
// and another the opposite ("9:16 only" next to 4x5 file names, "show Best Tickets in the first 3s" next to "no logo,
// no domains", "use the Oct 21 event footage" next to "no event-specific content"), sizes outside Kaizen's 4:5 and 9:16,
// durations a placement can't run, and shot-by-shot direction that takes the HOW away from the maker. Hard issues block
// "ready"; soft ones are a heads-up. Each comes with a one-click fix when there's an obvious one (sizes, a phrase to
// replace) or an instruction the revise chat carries out. The AI pass (consistency against the Brand Bible's cleared
// claims and the rest) adds to these on the server. Pure: tested in tests/brief-lint.test.ts.

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

  // Shot-by-shot direction: the HOW is the maker's unless a script was asked for
  const beats = (i.text.match(/(?:^|\n)\s*(?:[-•]\s*)?(?:\d{1,2}(?:\.\d)?\s?[-–]\s?\d{1,2}(?:\.\d)?\s?s(?:ec)?\b|beat \d|scene \d|shot \d|frame \d)/gi) ?? []).length;
  if (beats >= 3 && !/(?:^|\n)Script:/i.test(i.text))
    issues.push({ id: "beats", severity: "soft", message: "Shot-by-shot direction: pacing, beats and edit structure are the maker's call unless a script was asked for.", fixes: [{ kind: "ai", instruction: "Take out the shot-by-shot beats and timings. Keep the insight, the hook and the constraints precise, and hand pacing, beats and structure to the maker in Your call.", label: "Hand the beats to the maker" }] });

  return issues;
}

/** A text fix applied: the first occurrence replaced (case kept as written in the fix) */
export function applyTextFix(text: string, from: string, to: string) {
  const at = text.indexOf(from);
  if (at >= 0) return text.slice(0, at) + to + text.slice(at + from.length);
  const re = new RegExp(escape(from), "i");
  return text.replace(re, to);
}

export const hardIssues = (xs: LintIssue[]) => xs.filter((x) => x.severity === "hard");
