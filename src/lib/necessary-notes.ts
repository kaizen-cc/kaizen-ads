// The AI creative review leaves only necessary comments (the owner, Nov 2026): each one points to a real problem against
// the brief, the specs, the client's rules or the platform, never a filler or taste note. The prompt asks for that; this
// filter is the backstop that drops what still slips through before anything is pinned on the creative.
// Pure: tested in tests/necessary-notes.test.ts.

export type ReviewNote = { severity: "fix" | "watch" | "good"; area: string; note: string; size?: string; design?: string };

// A real problem: a mistake, something checked against the brief or the client's rules, a spec, the platform, a legal risk
const PROBLEM =
  /\b(typos?|misspel\w*|spelling|spelled|grammar|placeholder|lorem|wrong|incorrect|inaccurate|doesn'?t match|does not match|mismatch\w*|contradict\w*|differs? from|inconsistent|brief'?s?|missing|left out|absent|no (cta|logo|disclaimer|price|offer|end card|captions?|product)|cut off|cropped|clipped|truncated|cut in half|safe zones?|covered|covers|under (meta'?s|the) (interface|ui|caption|buttons)|overlap\w*|hidden behind|unreadable|illegible|can'?t be read|hard to read|too small|low contrast|blurry|blurred|pixelat\w*|compression|artefacts?|artifacts?|watermark\w*|stretched|distorted|low[- ]res\w*|off[- ]brand|brand (colou?rs?|fonts?|rules?|guidelines?)|bible|client (asked|said|rules?|memory|context)|avoid|banned|not allowed|policy|before[- ]and[- ]after|personal attributes?|guarantee\w*|unsupported claim|disclaimer|consent|invented|made up|not (in|on) (the )?(brief|client)|outdated|expired|unlicensed|duplicate)\b/i;

// What a spec is about (worth a note only with a problem behind it, or in a hard area)
const TOPIC = /(\$\d|\d+ ?%|\b(price|discount|offer|promo code|code|dates?|deadline|phone|url|link|logo|cta|4:5|9:16|1:1|aspect|sizes?|resolution|captions?|subtitles?|voice ?over|ai[- ](avatar|voice|generated)|face swap|cloned voice|claims?)\b)/i;

// Taste and filler: suggestions, hedges, praise dressed as a comment
const TASTE =
  /\b(consider(ing)?|could (be|feel|use|try|look)|might (want|be|feel|consider)|may want|you may|maybe|perhaps|optionally|optional|if you (want|like|have time)|nice to have|personal(ly)? (preference|taste)|i'?d (prefer|suggest|love)|feels? (a (bit|little)|slightly|somewhat)|a (bit|little|touch) (more|less|bland|busy|plain|flat)|slightly|somewhat|more (dynamic|engaging|impactful|eye[- ]catching|premium|modern|polished|vibrant|exciting|punchy|energetic|interesting)|punchier|pop more|stand out more|could be stronger|stronger hook|fresher|subtle|overall (looks|feels|it'?s)|looks (good|great|nice|clean|solid)|well done|nicely|great job|good job)\b/i;

// Areas that are a problem class on their own (a spec or a rule), not a matter of taste
const HARD_AREAS = /^(text|offer|facts?|placement|sizes?|policy|client ask|legal|specs?)$/i;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9$%]+/g, " ").trim();

/** One note: does it point to a real problem? A "Client ask" check always stays; a "good" note is never a comment. */
export function isNecessary(n: ReviewNote): boolean {
  if (n.severity === "good") return false;
  const area = n.area.trim();
  if (/^client ask$/i.test(area)) return true;
  const text = n.note.trim();
  if (text.length < 12) return false;
  const problem = PROBLEM.test(text);
  // A suggestion or a matter of taste with no real problem behind it goes, whatever its severity
  if (TASTE.test(text) && !problem) return false;
  // A fix the model is sure of stays; a watch note needs a real problem, or a spec in a hard area
  if (n.severity === "fix") return true;
  return problem || (HARD_AREAS.test(area) && TOPIC.test(text));
}

/**
 * The notes to keep: the necessary ones, one per problem (the same point on the same design said twice goes), and at
 * most one "working well" note for the summary (it's never pinned on the creative).
 */
export function necessaryNotes<T extends ReviewNote>(notes: T[]): T[] {
  const seen = new Set<string>();
  let good = 0;
  const out: T[] = [];
  for (const n of notes) {
    if (n.severity === "good") {
      if (good++ < 1) out.push(n);
      continue;
    }
    if (!isNecessary(n)) continue;
    const key = `${n.design ?? ""}|${norm(n.note).slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

/** The comments an AI review left, summarized for the creative review: counts and the first few, fixes first */
export function reviewSummary<T extends ReviewNote>(notes: T[], max = 3) {
  const kept = notes.filter((n) => n.severity !== "good");
  const fixes = kept.filter((n) => n.severity === "fix");
  const watch = kept.filter((n) => n.severity === "watch");
  return { fixes: fixes.length, watch: watch.length, top: [...fixes, ...watch].slice(0, max), good: notes.find((n) => n.severity === "good") ?? null };
}
