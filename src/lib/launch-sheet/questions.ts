import { kindOf, normalizeUrl, shortUrl } from "@/lib/landing-pages-core";
import { isKaizenAdset, isKaizenName, notKaizenLine } from "@/lib/kaizen-scope";
import type { LaunchQuestion, LaunchSheet, Resolution } from "./types";

// The questions only the buyer can answer, before anything is planned. The Media Buyer writes them with its proposal
// for each (from its skills and the client's context); this makes sure the ones that decide what gets written are
// always there, whatever the model wrote, so a plan can never skip them.

const q = (key: string, question: string, why: string, proposal: string, options: string[] = [], required = true): LaunchQuestion => ({ key, question, why, proposal, options, required, answer: null });

/** The decisions every launch needs, given what the sheet and the account show */
export function requiredQuestions(sheet: LaunchSheet, res: Resolution, today: string): LaunchQuestion[] {
  const out: LaunchQuestion[] = [];
  // Created paused is Kaizen's rule, not a question (a scheduled start only when the buyer asks for one in the chat)
  const colors = [...new Set(sheet.rows.map((r) => r.color).filter(Boolean))] as string[];
  const past = sheet.rows.filter((r) => r.date && r.date < today).length;
  if (colors.length > 1 || past)
    out.push(
      q(
        "rows",
        `Which rows should launch?${colors.length > 1 ? ` The rows are colored ${colors.join(" and ")}: what does each color mean?` : ""}${past ? ` ${past} row${past === 1 ? " is" : "s are"} dated before today.` : ""}`,
        "The sheet's colors are the client's own tracking; they aren't read as launch instructions until you say what they mean.",
        "Only rows that aren't launched yet and are dated from today on",
      ),
    );
  else out.push(q("rows", "Launch every row in the sheet?", "So nothing is launched that wasn't meant to be.", "Every row", ["Every row"]));
  if (sheet.budgets.some((b) => b.periods.some((p) => p.amount != null)))
    out.push(
      q(
        "budget",
        "The budgets are totals per period. How should they map in Meta?",
        "A period total copied in as a daily budget would spend several times the plan.",
        "One campaign budget: a daily budget per period (total ÷ days), raised at each period's start with budget scheduling",
        ["Daily budget per period (budget scheduling)", "One ad set per period with the period's total as a lifetime budget", "One lifetime budget for the whole flight"],
      ),
    );
  else out.push(q("budget", "What budget should this launch run on?", "The sheet doesn't give one Meta can take.", "Ask the client's monthly budget on the KPI board", []));
  // Where the ads land: a Kaizen campaign or ad set (as it is, or a new ad set copied from one), a paused Kaizen
  // campaign brought back when its record says so, else a new Kaizen campaign. res.existing only holds Kaizen's own.
  const mine = res.existing.filter((e) => (e.level === "campaign" ? isKaizenName(e.name) : isKaizenAdset({ name: e.name, campaignName: e.campaignName })));
  const matched = mine.filter((e) => !e.related);
  const live = (e: { status: string }) => e.status === "ACTIVE";
  const byLive = <T extends { status: string }>(xs: T[]) => [...xs].sort((x, y) => Number(live(y)) - Number(live(x)));
  // Only live ones: nothing added to a paused campaign or ad set runs
  const camps = byLive(mine.filter((e) => e.level === "campaign" && live(e))).slice(0, 2);
  const sets = byLive(mine.filter((e) => e.level === "adset" && live(e))).slice(0, 2);
  const back = !camps.length && !sets.length && res.comeback ? `Bring back the campaign "${res.comeback.name}" (paused), a new ad set per Page` : null;
  const options = [
    ...camps.map((c) => `Add to the campaign "${c.name}", a new ad set per Page`),
    ...sets.slice(0, 1).map((s) => `Into the ad set "${s.name}" as it is`),
    ...sets.slice(0, 1).map((s) => `A new ad set copied from "${s.name}" (same targeting, pixel and optimization)`),
    ...(back ? [back] : []),
    "A new Kaizen campaign, one ad set per Page",
  ];
  out.push(
    q(
      "structure",
      "Where should these ads go: a Kaizen campaign or ad set that's running, or a new Kaizen campaign?",
      matched.length
        ? `${matched.length} Kaizen campaign${matched.length === 1 ? "" : "s"} or ad set${matched.length === 1 ? "" : "s"} look like this event.`
        : back && res.comeback
          ? res.comeback.why
          : mine.length
            ? "Nothing Kaizen set up is named like this event, but these Kaizen ones are live and spending."
            : "Nothing Kaizen set up fits yet, so a new Kaizen campaign.",
      matched.length && options.length > 1 ? options[0] : sets.length ? `A new ad set copied from "${sets[0].name}" (same targeting, pixel and optimization)` : (back ?? "A new Kaizen sales campaign optimizing for purchases, one ad set per Page"),
      options.length > 1 ? options : [],
    ),
  );
  out.push(
    q(
      "targeting",
      "Targeting: which places with what radius, and what ages?",
      "The sheet names places, not Meta locations.",
      `${[...new Set(sheet.rows.map((r) => r.geo).filter(Boolean))].join(", ") || sheet.event.location || "The event's city"} at a 15 mile radius, ages ${res.checks.some((c) => c.key === "policy_alcohol") ? "21" : "18"}–65, Advantage+ audience off`,
    ),
  );
  // Where the ads send people: asked when the sheet gives no link, or only the bare homepage (a page that matches
  // usually converts better: offered, not required). Its options are the client's pages (landing-pages-core.ts)
  const rowLinks = sheet.rows.some((r) => r.link && !r.existingPost);
  if (!rowLinks && sheet.rows.some((r) => !r.existingPost)) {
    const event = normalizeUrl(sheet.event.link);
    if (!event) out.push(q("link", "Where should the ads send people?", "The sheet has no landing link for the ads.", "The client's page that matches the event best"));
    else if (kindOf(event) === "home") out.push(q("link", `The sheet only links the homepage (${shortUrl(event)}). Send people there, or to a page that matches?`, "A page that matches the ad usually converts better than the homepage.", event, [event], false));
  }
  const missing = res.pages.filter((p) => !p.canAdvertise);
  if (missing.length)
    out.push(
      q(
        "pages",
        `Kaizen can't advertise as ${missing.map((p) => `"${p.name}"`).join(", ")} yet. Get access first, run those rows as partnership ads from the brand's Page, or run them from the brand's Page?`,
        "Ads run as a Page need the system user to have Create ads on that Page.",
        "Request access for the venue Page (Business settings → Pages → Add → Request access) and hold those rows until it's granted",
        ["Request access and wait", "Partnership ad with the brand's Page", "Run as the brand's Page"],
      ),
    );
  if (res.posts.length)
    out.push(
      q(
        "posts",
        `The sheet has ${res.posts.length} existing post${res.posts.length === 1 ? "" : "s"}. Run ${res.posts.length === 1 ? "it" : "them"} as existing-post ads (keeping likes and comments) in the same ad sets?`,
        "An existing post keeps its engagement; its caption is what runs, not the sheet's copy.",
        "Yes, as existing-post ads in the ad set of their place",
        ["Yes", "No, skip them"],
      ),
    );
  return out;
}

/** The model's questions with the required ones added where it left them out (matched by key), answers kept */
export function mergeQuestions(model: LaunchQuestion[], must: LaunchQuestion[], previous: LaunchQuestion[] = []): LaunchQuestion[] {
  const byKey = new Map<string, LaunchQuestion>();
  for (const m of must) byKey.set(m.key, m);
  // The model's version of a required question wins (its proposal comes from the client's context), still required
  // (a code question that's only offered, like the landing page over a homepage link, stays optional)
  for (const m of model) byKey.set(m.key, { ...m, required: byKey.has(m.key) ? byKey.get(m.key)!.required : m.required, answer: null });
  for (const p of previous) {
    const cur = byKey.get(p.key);
    if (cur && p.answer) cur.answer = p.answer;
    else if (!cur && p.answer) byKey.set(p.key, p);
  }
  return [...byKey.values()];
}

/** The buyer's answers folded in: only questions that exist, never an empty answer */
export function applyAnswers(qs: LaunchQuestion[], answers: { key: string; answer: string }[]): LaunchQuestion[] {
  const next = qs.map((x) => ({ ...x }));
  for (const a of answers) {
    const t = a.answer.trim();
    if (!t) continue;
    const hit = next.find((x) => x.key === a.key);
    if (hit) hit.answer = t.slice(0, 1000);
  }
  return next;
}

/**
 * Where the ads land must be one place: an answer to "structure" that names more than one live campaign or ad set
 * ("if brand, X; if not, Y") is cleared and asked again, and its proposal is always one of the options offered.
 */
export function followStructure(questions: LaunchQuestion[], existing: { name: string }[], outside: string[] = []): LaunchQuestion[] {
  return questions.map((x) => {
    if (x.key !== "structure") return x;
    const proposal = x.options.length && !x.options.includes(x.proposal) ? x.options[0] : x.proposal;
    const refused = structureRefusal(x.answer, existing, outside, x.options);
    return refused ? { ...x, proposal, answer: null, why: refused } : { ...x, proposal };
  });
}

/**
 * Why a "where it goes" answer isn't taken, or null when it stands: it names more than one place ("if brand, X; if
 * not, Y"), or a campaign or ad set Kaizen didn't set up (and none of Kaizen's).
 */
export function structureRefusal(answer: string | null | undefined, existing: { name: string }[], outside: string[] = [], options: string[] = []): string | null {
  const a = String(answer ?? "").toLowerCase();
  if (!a) return null;
  const count = (names: string[]) => {
    let rest = a;
    const hit: string[] = [];
    for (const name of [...names].sort((p, q) => q.length - p.length)) {
      const n = name.toLowerCase();
      if (n && rest.includes(n)) {
        hit.push(name);
        rest = rest.split(n).join(" ");
      }
    }
    return hit;
  };
  const mine = count(existing.map((e) => e.name));
  // "A new ad set copied from X" names one place; naming two different ones is the ambiguous case
  if (mine.length > 1 && !/copied from/i.test(a)) return "Pick one place: that answer named more than one campaign or ad set.";
  if (mine.length) return null;
  const theirs = count(outside.filter((n) => !existing.some((e) => e.name.toLowerCase() === n.toLowerCase())));
  if (!theirs.length) return null;
  const alt = options.find((o) => !/^a new /i.test(o))?.match(/"([^"]+)"/)?.[1] ?? null;
  return notKaizenLine(theirs[0], alt, /ad set/i.test(a) ? "ad set" : "campaign");
}
