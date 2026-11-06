import "server-only";
import { askJson } from "@/lib/ai";
import { gridText } from "./grid";
import { landingRule, pagesText, type LandingSet } from "@/lib/landing-pages-core";
import { budgetOptions, type Proposal } from "./plan";
import type { Grid, LaunchQuestion, LaunchSheet, Resolution } from "./types";

// The Media Buyer's side of a launch conversation (the launcher agent, with its skills and the client's context):
// reading the sheet, asking what only the buyer can answer, answering the buyer, and proposing the structure once
// everything is answered. It never writes to Meta and never decides alone what the buyer must decide.

const S = { type: "string" };
const B = { type: "boolean" };
const N = { type: "number" };
const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const arr = (items: unknown) => ({ type: "array", items });

/**
 * The fast tier for the steps someone is waiting on (reading a table the code already found, the questions, each chat
 * turn); the plan keeps the agent's own model
 */
const FAST = { model: "sonnet", effort: "low" } as const;

/** Short, plain lines for a narrow chat panel */
const SHORT = `Write for a narrow chat panel: short sentences, numbers first, no em dashes.`;

const RULES = `Kaizen's launch rules: everything is created PAUSED unless the buyer explicitly chooses a scheduled start in this conversation. Each ad stacks its text options (every primary text and headline as Meta's text options) with Advantage+ creative enhancements off; 4:5 runs in feeds and 9:16 in Stories and Reels (older 1:1 files are read but not launched). Kaizen's UTM template is added to every link. Budgets in a sheet are usually TOTALS per period, never daily budgets: never copy a period total in as a daily budget. Refer to people by role (the buyer, the client, the designer), never by name. Plain text, no markdown, no emojis.`;

/** A compact view of the sheet for the model (row numbers are the sheet's row indexes) */
export function sheetBrief(sheet: LaunchSheet, maxRows = 120) {
  const rows = sheet.rows.slice(0, maxRows).map((r) => {
    const copy = r.copy.map((c, i) => `   copy ${i + 1}: headline "${c.headline}" / primary "${c.primary.replace(/\n+/g, " / ").slice(0, 400)}"${c.description ? ` / description "${c.description}"` : ""}`).join("\n");
    const extra = Object.entries(r.extra).map(([k, v]) => `${k}: ${v}`).join("; ");
    return `#${r.index} date ${r.date ?? (r.dateText || "none")} · Page "${r.page}" · access "${r.access}" · place "${r.geo}" · ${r.existingPost ? `existing post ${r.existingPost}` : `creative "${r.creative.name}" (${r.creative.links.length} link${r.creative.links.length === 1 ? "" : "s"})`}${r.color ? ` · row color ${r.color}` : ""}${r.notes.length ? ` · footnotes ${r.notes.join(",")}` : ""}${extra ? ` · ${extra}` : ""}\n${copy}`;
  });
  return [
    `Event: ${sheet.event.name || "(none)"}${sheet.event.dateText ? ` on ${sheet.event.date ?? sheet.event.dateText}` : ""}${sheet.event.location ? ` in ${sheet.event.location}` : ""}`,
    `Link: ${sheet.event.link ?? "(none)"}`,
    `Goal: ${sheet.goal || "(not written)"}`,
    `Total budget: ${sheet.totalBudget != null ? `$${sheet.totalBudget}` : "(none)"}${sheet.spentToDate != null ? `, spent $${sheet.spentToDate}${sheet.spentThrough ? ` through ${sheet.spentThrough}` : ""}` : ""}`,
    ...sheet.budgets.map((b) => `${b.platform} budget periods (totals per period): ${b.periods.map((p) => `${p.label} (${p.start ?? "?"} to ${p.end ?? "?"}) $${p.amount ?? "?"}`).join("; ")}`),
    ...sheet.facts.map((f) => `${f.label}: ${f.value}`),
    ...sheet.footnotes.map((f) => `Footnote [${f.n}]: ${f.text}`),
    `Rows (${sheet.rows.length}${sheet.rows.length > maxRows ? `, first ${maxRows} shown` : ""}):`,
    ...rows,
  ].join("\n");
}

export function resolutionBrief(res: Resolution) {
  return [
    `Ad account: ${res.account ?? "none"}`,
    "Checks:",
    ...res.checks.map((c) => `- [${c.level}] ${c.label}: ${c.detail}${c.fix ? ` Fix: ${c.fix}` : ""}`),
    "Pages:",
    ...res.pages.map((p) => `- "${p.name}" → ${p.pageId ? `${p.pageName} (${p.pageId})${p.igId ? `, Instagram @${p.igName}` : ", no Instagram"}${p.canAdvertise ? "" : ", NOT usable for ads"}` : "not found"} (rows ${p.rows.join(",")})`),
    "Places:",
    ...res.geos.map((g) => `- "${g.text}" → ${g.key ? `${g.name}, ${g.region ?? ""} ${g.country ?? ""} (${g.type}, key ${g.key})` : "not found"}`),
    "Creative files:",
    ...res.creatives.map((c) => `- row #${c.row} "${c.name}": ${c.error ? `not read (${c.error})` : `${c.files.length} file(s): ${c.files.map((f) => `${f.name} ${f.aspect} ${f.kind}`).join(", ")}; picked 4:5 ${c.picked.feed ? "yes" : "no"}, 9:16 ${c.picked.vertical ? "yes" : "no"}`}`),
    "Existing posts:",
    ...res.posts.map((p) => `- row #${p.row} ${p.url}: ${p.mediaId ? `found (media ${p.mediaId})` : p.error}`),
    `Pixel: ${res.pixel ? `${res.pixel.name} (${res.pixel.id}), last fired ${res.pixel.lastFired ?? "never"}, Purchase in 7 days: ${res.pixel.purchaseRecent ?? "unknown"}` : "none"}`,
    "Already in the account:",
    ...res.existing.map((e) => `- ${e.level} "${e.name}" (${e.id}) ${e.status}${e.dailyBudget != null ? ` daily $${e.dailyBudget}` : ""}${e.lifetimeBudget != null ? ` lifetime $${e.lifetimeBudget}` : ""}${e.spend != null ? ` spent $${e.spend}` : ""}${e.related ? " (live in the account, not named like this event)" : ""}`),
  ].join("\n");
}

const questionsText = (qs: LaunchQuestion[]) => qs.map((q) => `- ${q.key}${q.required ? " (required)" : ""}: ${q.question} Proposal: ${q.proposal}. ${q.answer ? `ANSWERED: ${q.answer}` : "Not answered yet."}`).join("\n");

// ─── Reading the sheet ──────────────────────────────────────────────────────────────────────────────────────────

const READ_SCHEMA = obj({
  summary: S,
  eventName: S,
  goal: S,
  colorGuesses: arr(obj({ color: S, guess: S })),
  notes: arr(S),
  rows: arr(obj({ dateText: S, page: S, geo: S, creative: S, links: arr({ type: "integer" }), headlines: arr(S), primaries: arr(S), descriptions: arr(S), color: S })),
});
export type ReadOut = { summary: string; eventName: string; goal: string; colorGuesses: { color: string; guess: string }[]; notes: string[]; rows: { dateText: string; page: string; geo: string; creative: string; links: number[]; headlines: string[]; primaries: string[]; descriptions: string[]; color: string }[] };

/**
 * The Media Buyer reads the sheet: what it is, in a few sentences, and anything odd. When the table couldn't be found
 * from the file's structure (an unusual layout), it reads the rows itself, pointing at links by number so no link is
 * ever made up.
 */
export async function readWithModel(clientId: string, sheet: LaunchSheet, grid: Grid | null, pdf: string | null, name: string): Promise<ReadOut> {
  const needRows = sheet.rows.length === 0;
  const links = [...new Set((grid?.rows ?? []).flatMap((r) => r.flatMap((c) => c.links)))];
  return askJson<ReadOut>({
    agent: "launcher",
    label: "launch sheet read",
    clientId,
    // Rows already found by the code: only a summary and notes are written, so the fast tier is enough
    ...(needRows ? {} : { override: FAST }),
    system: `You read a launch sheet a buyer shared in a client's chat: the plan of ads to launch (often an event, with dates, the Page each ad runs on, the place, the creative and its copy options). You get the sheet as read from the file (its table, links and cell colors), and the file itself when it's a PDF (look at the pages: colors, layout, footnotes).
summary: 2 short sentences (at most 40 words) on what the sheet asks for (the event or offer, how many ads and posts, which Pages, the places, the dates and the budget as the sheet gives it). Don't decide anything.
colorGuesses: for each row color, what it most likely means in the client's tracking (a guess the buyer will confirm, e.g. "launched", "not launched yet", "error"). Empty when rows have no colors.
notes: anything odd a buyer should know (a row with no creative, the same creative twice on one Page, copy that doesn't match its row, dates after the event, a footnote that changes how to read the budget). At most 4, one short sentence each.
${SHORT}
${needRows ? "rows: the structure wasn't found from the file, so read every row of the table yourself: its date as written, the Page, the place, the creative's name, the numbers of its links from <links> (never write a URL), and its copy options. Leave out header and note lines." : "rows: [] (the rows were read already)."}
eventName and goal: as the sheet writes them ("" when absent).
${RULES}`,
    schema: READ_SCHEMA,
    maxTokens: needRows ? 32000 : 6000,
    pdfs: pdf ? [{ data: pdf, title: name }] : [],
    prompt: `<sheet name="${name.replace(/"/g, "'")}">\n${sheetBrief(sheet, 60)}\n</sheet>\n\n<table_as_read>\n${grid ? gridText(grid, needRows ? 60_000 : 12_000) : "(none)"}\n</table_as_read>${needRows ? `\n\n<links>\n${links.map((u, i) => `${i}: ${u}`).join("\n")}\n</links>` : ""}`,
  });
}

// ─── Questions ──────────────────────────────────────────────────────────────────────────────────────────────────

const Q = obj({ key: S, question: S, why: S, proposal: S, options: arr(S), required: B });
const ASK_SCHEMA = obj({ summary: S, questions: arr(Q) });

/** The Media Buyer's questions with a proposal for each (from its skills, the client's context and the checks) */
export async function askQuestions(clientId: string, client: string, brief: string, sheet: LaunchSheet, res: Resolution, must: LaunchQuestion[], today: string) {
  const budget = budgetOptions(sheet, today);
  return askJson<{ summary: string; questions: Omit<LaunchQuestion, "answer">[] }>({
    agent: "launcher",
    label: "launch sheet questions",
    clientId,
    override: FAST,
    system: `You're the media buyer about to launch a client's launch sheet into Meta. Everything was read and checked against the live account (below). Before anything is planned, you ask the buyer only what the buyer must decide, each with your proposal from your skills, the client's context and the checks, and why.
summary: 1 or 2 sentences (at most 35 words): what the checks found that matters for this launch (what's ready, what blocks).
questions: start from the required questions given (keep each key; rewrite the question and proposal for this client and sheet, keep it short; give options when there are clear choices; question at most 15 words, why one sentence of at most 15 words, proposal at most 12 words). Stay on this sheet: nothing account-wide. Add a question only when the sheet or the checks leave something open the buyer must decide (e.g. a different landing link per place, which creative of a folder with several, a footnote that changes the budget, rows marked as errors). Never ask what the checks already settled. At most 7 questions.
${SHORT}
Proposals follow the client's goal as the sheet states it (e.g. volume of purchases over ROAS), Kaizen's buying principles in your skills, and the account as it is (add to a matching campaign rather than duplicate it when that fits).
${RULES}`,
    schema: ASK_SCHEMA,
    maxTokens: 4000,
    prompt: `<client>${client}</client>\n\n<client_context>\n${brief.slice(0, 3000)}\n</client_context>\n\n<sheet>\n${sheetBrief(sheet)}\n</sheet>\n\n<checks>\n${resolutionBrief(res)}\n</checks>\n\n${budget ? `<budget_options note="exact numbers worked out from the sheet's periods from today (${today}); periods already over are left out">\n${budget.options.map((o) => `${o.mode}: ${o.map.lines.map((l) => `${l.label} ${l.start}..${l.end} $${l.amount} ($${l.daily}/day)`).join("; ")} · total $${o.map.total}${o.spec ? ` · as Meta takes it: ${o.spec.type} $${o.spec.amount}${o.spec.schedules?.length ? ` + ${o.spec.schedules.length} budget schedule(s)` : ""}` : ""}${o.map.notes.length ? ` · ${o.map.notes.join(" ")}` : ""}`).join("\n")}\n</budget_options>\n\n` : ""}<required_questions>\n${questionsText(must)}\n</required_questions>`,
  });
}

// ─── The buyer's replies ────────────────────────────────────────────────────────────────────────────────────────

const REPLY_SCHEMA = obj({ answer: S, answers: arr(obj({ key: S, answer: S })), newQuestions: arr(Q), build: B, offTopic: B, setAside: B });
export type ReplyOut = { answer: string; answers: { key: string; answer: string }[]; newQuestions: Omit<LaunchQuestion, "answer">[]; build: boolean; offTopic: boolean; setAside: boolean };

export async function replyToBuyer(clientId: string, sheet: LaunchSheet, res: Resolution, qs: LaunchQuestion[], turns: { role: "user" | "assistant"; text: string }[], message: string, stage: string, landing: { set: LandingSet | null; theme: string } | null = null) {
  const asksLink = Boolean(landing) && qs.some((q) => q.key === "link");
  return askJson<ReplyOut>({
    agent: "launcher",
    label: "launch sheet chat",
    clientId,
    override: FAST,
    system: `You're the media buyer in a conversation with the buyer about launching a launch sheet into Meta. The sheet, the checks against the live account, your questions (with what's answered) and the conversation are below. Stage: ${stage}.
answers: the questions the buyer's message answers, by key, in their words made exact (e.g. "rows": "only the green rows dated from Oct 1"). When the buyer accepts your proposal ("yes", "go with that", "your defaults"), the answer is your proposal written out. Only what the buyer actually said or accepted; never answer for them.
newQuestions: a new question only when their answer opens one the plan needs.
build: true when the buyer asks to build, see or redo the plan, or says go ahead. The plan is only built once every required question is answered; if some aren't, say which in answer.
answer: your reply in 1 or 2 short sentences. Talk like a senior media buyer a colleague just walked up to: natural and brief, one breath at a time, under 45 words. Confirm what you took in a few words, then ask ONE thing, the next open decision, with your pick in a few words. No lists or bullets, no reasoning, rules or caveats unless they ask why or something would break; the rest comes in the next turns. Push back in a sentence when something works against the client's results or the platform's rules. Never propose or plan launching into a paused campaign, ad group or ad set: nothing added there runs. Only live ones, or a new one. If the buyer names a paused one, say plainly it's paused and offer the live ones or a new one. When the stage is "ready" or later and they ask for a change to the plan, take it as an answer (usually "structure", "budget", "targeting" or "rows") and set build true so the plan is rebuilt and checked again. When the stage is "ready" and they say go ahead or confirm, tell them to press Create on the launch card (it checks who may confirm and creates everything paused, or scheduled as agreed); build stays false.
offTopic: true when the message isn't about this launch at all (then answer "").
setAside: true when they say to stop, drop or park this launch.
${asksLink ? `${landingRule("link")}\n` : ""}${SHORT}
${RULES}`,
    schema: REPLY_SCHEMA,
    maxTokens: 3000,
    prompt: `<sheet>\n${sheetBrief(sheet, 60)}\n</sheet>\n\n<checks>\n${resolutionBrief(res)}\n</checks>\n\n${asksLink ? `<landing_pages site="${landing?.set?.site ?? ""}">\n${pagesText(landing?.set, landing?.theme ?? "")}\n</landing_pages>\n\n` : ""}<questions>\n${questionsText(qs)}\n</questions>\n\n<conversation>\n${turns
      .slice(-16)
      .map((t) => `${t.role === "user" ? "Buyer" : "You"}: ${t.text}`)
      .join("\n")}\n</conversation>\n\nThe buyer says: ${message.slice(0, 3000)}`,
  });
}

// ─── The plan's structure ───────────────────────────────────────────────────────────────────────────────────────

const PB = obj({ type: { type: "string", enum: ["daily", "lifetime", "none"] }, amount: N, schedules: arr(obj({ start: S, end: S, amount: N })) });
const PLAN_SCHEMA = obj({
  note: S,
  goLive: { type: "string", enum: ["paused", "scheduled"] },
  campaigns: arr(obj({ key: S, mode: { type: "string", enum: ["new", "existing"] }, existingId: S, name: S, objective: S, budget: PB, start: S, end: S })),
  adsets: arr(
    obj({
      key: S,
      campaignKey: S,
      mode: { type: "string", enum: ["new", "existing"] },
      existingId: S,
      name: S,
      budget: PB,
      start: S,
      end: S,
      geos: arr(obj({ text: S, radius: N })),
      countries: arr(S),
      zips: arr(S),
      ageMin: { type: "integer" },
      ageMax: { type: "integer" },
      advantageAudience: B,
      event: S,
      cloneFrom: S,
    }),
  ),
  ads: arr(obj({ key: S, adsetKey: S, rows: arr({ type: "integer" }), name: S, identity: { type: "string", enum: ["page", "partnership"] }, page: S, partner: S, cta: S, link: S })),
});

/** The structure the conversation settled on, as the Media Buyer lays it out (the exact parts are filled in by code) */
export async function proposeStructure(clientId: string, sheet: LaunchSheet, res: Resolution, qs: LaunchQuestion[], turns: { role: "user" | "assistant"; text: string }[], today: string, namesInAccount: string[], tz: string) {
  const budget = budgetOptions(sheet, today);
  return askJson<Proposal>({
    agent: "launcher",
    label: "launch sheet plan",
    clientId,
    system: `You lay out the launch the buyer agreed to, as campaigns, ad sets and ads, exactly as answered in the questions and the conversation. Code fills in the copy (straight from the sheet's rows), the files, the posts, the pixel and the UTMs: you choose the structure.
- campaigns: key ("c1"…), mode "existing" with existingId only when the buyer agreed to add to that campaign (an id from the checks), else "new" with existingId "". name follows the account's naming pattern (examples given). objective "OUTCOME_SALES" for purchases unless agreed otherwise. budget: the campaign's when the budget lives on the campaign (type "daily" with schedules for later periods, or "lifetime"), else type "none" with amount 0. start/end YYYY-MM-DD or "".
- adsets: key ("s1"…), campaignKey, mode/existingId as for campaigns. name in the account's pattern. budget when the ad set holds it (else type "none"). start/end: from today (${today}) on, never in the past. geos: the places by their text exactly as in the checks' Places list, with a radius in miles (10 to 50). countries ["US"] only when targeting a whole country. ageMin 21 when the ads promote alcohol or bars in the US. advantageAudience false unless agreed. event "PURCHASE" unless agreed. cloneFrom: when the buyer chose a new ad set copied from an existing one, that ad set's id (from the checks' "Already in the account"): it keeps that ad set's targeting, pixel, event and optimization, so geos may be []; else "". Kaizen's launcher puts ads into an existing ad set or a copy of one inside an existing campaign; a new campaign only when the buyer asked for one.
- ads: key ("a1"…), adsetKey, rows: the sheet row numbers (#) this ad runs (one row per ad, unless rows repeat the same creative and copy on the same Page), name in the account's pattern, identity "page" (the Page by its name as in the sheet) or "partnership" (page = the brand's Page, partner = the partner Page's name), cta as a Meta CTA type (BUY_TICKETS, SHOP_NOW, LEARN_MORE…), link "" to use the sheet's link.
Use the budget numbers worked out below exactly for the mapping the buyer chose (never a period total as a daily budget). Leave out rows the buyer said not to launch. goLive "scheduled" only when the buyer chose a scheduled start, else "paused".
note: 1 to 3 sentences on how the plan follows what was agreed.
${RULES}`,
    schema: PLAN_SCHEMA,
    maxTokens: 16000,
    prompt: `<sheet>\n${sheetBrief(sheet)}\n</sheet>\n\n<checks>\n${resolutionBrief(res)}\n</checks>\n\n<answers>\n${questionsText(qs)}\n</answers>\n\n<conversation>\n${turns
      .slice(-20)
      .map((t) => `${t.role === "user" ? "Buyer" : "You"}: ${t.text}`)
      .join("\n")}\n</conversation>\n\n${budget ? `<budget_options>\n${budget.options.map((o) => `${o.mode}: ${o.map.lines.map((l) => `${l.label} ${l.start}..${l.end} total $${l.amount}, $${l.daily}/day`).join("; ")} · total $${o.map.total}${o.spec ? ` · on one object: ${JSON.stringify(o.spec)}` : ""}`).join("\n")}\n</budget_options>\n\n` : ""}<naming_examples note="campaign and ad set names in this account now">\n${namesInAccount.slice(0, 30).join("\n") || "(none)"}\n</naming_examples>\n\nThe ad account's time zone: ${tz}. Today: ${today}.`,
  });
}
