import type { LaunchQuestion, LaunchSheet, Resolution } from "./types";

// The questions only the buyer can answer, before anything is planned. The Media Buyer writes them with its proposal
// for each (from its skills and the client's context); this makes sure the ones that decide what gets written are
// always there, whatever the model wrote, so a plan can never skip them.

const q = (key: string, question: string, why: string, proposal: string, options: string[] = [], required = true): LaunchQuestion => ({ key, question, why, proposal, options, required, answer: null });

/** The decisions every launch needs, given what the sheet and the account show */
export function requiredQuestions(sheet: LaunchSheet, res: Resolution, today: string): LaunchQuestion[] {
  const out: LaunchQuestion[] = [];
  out.push(
    q(
      "go_live",
      "Create everything paused for you to turn on, or scheduled to start on its own?",
      "Kaizen creates everything paused unless you choose a scheduled start.",
      "Paused",
      ["Paused", "Scheduled to start on the dates in the plan"],
    ),
  );
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
  // Where the ads land: an existing campaign or ad set (as it is, or a new ad set copied from one), else a new campaign
  const matched = res.existing.filter((e) => !e.related);
  const live = (e: { status: string }) => e.status === "ACTIVE";
  const byLive = <T extends { status: string }>(xs: T[]) => [...xs].sort((x, y) => Number(live(y)) - Number(live(x)));
  // Only live ones: nothing added to a paused campaign or ad set runs
  const camps = byLive(res.existing.filter((e) => e.level === "campaign" && live(e))).slice(0, 2);
  const sets = byLive(res.existing.filter((e) => e.level === "adset" && live(e))).slice(0, 2);
  const options = [
    ...camps.map((c) => `Add to the campaign "${c.name}", a new ad set per Page`),
    ...sets.slice(0, 1).map((s) => `Into the ad set "${s.name}" as it is`),
    ...sets.slice(0, 1).map((s) => `A new ad set copied from "${s.name}" (same targeting, pixel and optimization)`),
    "A new campaign, one ad set per Page",
  ];
  out.push(
    q(
      "structure",
      "Where should these ads go: into a campaign or ad set that's running (as it is, or a new ad set copied from one), or a new campaign?",
      matched.length
        ? `The account already has ${matched.length} campaign${matched.length === 1 ? "" : "s"} or ad set${matched.length === 1 ? "" : "s"} that look like this event.`
        : res.existing.length
          ? "Nothing is named like this event, but these are live and spending in the account."
          : "Nothing in the account looks like this event yet.",
      matched.length ? options[0] : sets.length ? `A new ad set copied from "${sets[0].name}" (same targeting, pixel and optimization)` : "A new sales campaign optimizing for purchases, one ad set per Page",
      res.existing.length ? options : [],
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
  for (const m of model) byKey.set(m.key, { ...m, required: byKey.has(m.key) ? true : m.required, answer: null });
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
export function followStructure(questions: LaunchQuestion[], existing: { name: string }[]): LaunchQuestion[] {
  return questions.map((x) => {
    if (x.key !== "structure") return x;
    const proposal = x.options.length && !x.options.includes(x.proposal) ? x.options[0] : x.proposal;
    const a = String(x.answer ?? "").toLowerCase();
    let rest = a;
    let named = 0;
    for (const e of [...existing].sort((p, q) => q.name.length - p.name.length)) {
      const n = e.name.toLowerCase();
      if (n && rest.includes(n)) {
        named++;
        rest = rest.split(n).join(" ");
      }
    }
    // "A new ad set copied from X" names one place; naming two different ones is the ambiguous case
    return named > 1 && !/copied from/i.test(a) ? { ...x, proposal, answer: null, why: "Pick one place: that answer named more than one campaign or ad set." } : { ...x, proposal };
  });
}
