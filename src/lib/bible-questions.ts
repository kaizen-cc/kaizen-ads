import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// The Brand Bible's open questions, each labeled by what it's about and routed to who should answer it:
// - offer (offers, promotions, prices, what's in stock): the client first, then the media buyer
// - creative (claims, messaging, the look, the brand guide): the client first, then the head of creative
// - media (where traffic goes, KPIs, breakeven, tracking): the media buyer
// - business (anything about the business only the owner knows): the client, then the execs
// Either arm can hand one up to the execs. The client answers first in their portal (a pick when there are options,
// "I don't know" sends it on); the team answers inside the question, in a conversation that has its whole context.
// Every answer is folded into the Bible and logged.

export type QCategory = "offer" | "creative" | "media" | "business";
export type QStage = "client" | "media_buyer" | "head_of_creative" | "exec" | "answered";
export type QTurn = { role: "client" | "team" | "ai"; text: string; at: string; by?: string };
export type BibleQuestion = {
  id: string;
  qid: string;
  question: string;
  category: QCategory;
  options: string[];
  multi: boolean;
  stage: QStage;
  answer: string | null;
  answeredBy: string | null;
  answeredVia: string | null;
  answeredAt: string | null;
  thread: QTurn[];
};

export const ROUTE: Record<QCategory, QStage[]> = {
  offer: ["client", "media_buyer"],
  creative: ["client", "head_of_creative"],
  media: ["media_buyer"],
  business: ["client", "exec"],
};
export const CATEGORY_NAME: Record<QCategory, string> = { offer: "Offer", creative: "Creative & messaging", media: "Media buying", business: "The business" };
export const STAGE_NAME: Record<QStage, string> = { client: "The client", media_buyer: "Media buyer", head_of_creative: "Head of creative", exec: "Execs", answered: "Answered" };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** A stable id for a question from its words (so a reworded Bible keeps the same question when the words hold) */
export function qidOf(text: string) {
  let h = 5381;
  for (const ch of norm(text)) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return h.toString(36);
}

/**
 * One open question as the Bible writes it: `[offer] Question {options: A | B | C}{multi}`, the tag and the options
 * optional. An untagged one (older Bibles) is labeled from its words and who the Bible says answers it.
 */
export function parseQuestion(raw: { question: string; who?: string }) {
  let text = raw.question.trim().replace(/^[-*•]\s*/, "");
  let category: QCategory | null = null;
  const tag = text.match(/^\[(offer|creative|media|business)\]\s*/i);
  if (tag) {
    category = tag[1].toLowerCase() as QCategory;
    text = text.slice(tag[0].length);
  }
  const multi = /\{multi\}/i.test(text);
  text = text.replace(/\{multi\}/gi, "");
  let options: string[] = [];
  const opt = text.match(/\{options:\s*([^}]*)\}/i);
  if (opt) {
    options = opt[1]
      .split("|")
      .map((o) => o.trim())
      .filter(Boolean)
      .slice(0, 12);
    text = text.replace(opt[0], "");
  }
  text = text.replace(/\s+/g, " ").trim();
  return { qid: qidOf(text), question: text, category: category ?? classify(text, raw.who ?? ""), options, multi };
}

/** Untagged questions, labeled by what they ask about (no AI needed: the words say it). Order matters: what ads may
 *  say is creative even when it's about an offer; KPIs and where traffic goes are media even when they mention creative */
export function classify(text: string, who: string): QCategory {
  const t = text.toLowerCase();
  const w = who.toLowerCase();
  if (/brand guide|guideline|\blogo|\bfonts?\b|colou?rs?\b|\bhex\b/.test(t)) return "creative";
  if (/\b(may|should|can) (ads|we) (say|state|use|show|name|carry|feature|mention)|appear in (the )?ads|\bclaims?\b|wording|never frozen|tagline/.test(t)) return "creative";
  if (/\bkpi|\bcpa\b|\bcpl\b|roas|break-?even|cost per|budget|pixel|tracking|conversion event|landing|\burl|point to|traffic|keyword|\bgeo|radius|zip code|\bbids?\b|platforms? (will|to) run/.test(t)) return "media";
  if (/\boffers?\b|promotion|discount|\bsale\b|black friday|cyber monday|thanksgiving|holiday|gift (box|card)|\bprices?\b|pricing|coupon|in stock|sold out|bundle|free (shipping|trial|gift)/.test(t)) return "offer";
  if (/photo|video|footage|creative|\bchef|\bface\b|testimonial|review|\btone\b|\bvoice\b|messag/.test(t)) return "creative";
  if (/media buyer|kaizen/.test(w)) return "media";
  return "business";
}

const toQuestion = (r: Record<string, unknown>): BibleQuestion => ({
  id: r.id as string,
  qid: r.qid as string,
  question: r.question as string,
  category: r.category as QCategory,
  options: (r.options ?? []) as string[],
  multi: Boolean(r.multi),
  stage: r.stage as QStage,
  answer: (r.answer as string | null) ?? null,
  answeredBy: (r.answered_by as string | null) ?? null,
  answeredVia: (r.answered_via as string | null) ?? null,
  answeredAt: (r.answered_at as string | null) ?? null,
  thread: (r.thread ?? []) as QTurn[],
});

/**
 * The Bible's open questions as routed rows: new ones start with the first who should answer, ones the Bible no
 * longer lists (settled in the review chat or a rebuild) are closed. Cheap: run it whenever the questions are shown.
 */
export async function syncQuestions(admin: SupabaseClient, clientId: string): Promise<BibleQuestion[]> {
  const [{ data: b }, { data: rows }] = await Promise.all([
    admin.from("client_brand_bibles").select("open_questions").eq("client_id", clientId).maybeSingle(),
    admin.from("bible_questions").select("*").eq("client_id", clientId).order("created_at"),
  ]);
  const open = ((b?.open_questions ?? []) as { question: string; who?: string }[]).map(parseQuestion);
  const have = new Map((rows ?? []).map((r) => [r.qid as string, r]));
  const now = new Date().toISOString();
  const fresh = open.filter((q) => !have.has(q.qid));
  if (fresh.length)
    await admin.from("bible_questions").upsert(
      fresh.map((q) => ({ client_id: clientId, qid: q.qid, question: q.question, category: q.category, options: q.options, multi: q.multi, stage: ROUTE[q.category][0] })),
      { onConflict: "client_id,qid", ignoreDuplicates: true },
    );
  const listed = new Set(open.map((q) => q.qid));
  const gone = (rows ?? []).filter((r) => r.stage !== "answered" && !listed.has(r.qid as string));
  if (gone.length) await admin.from("bible_questions").update({ stage: "answered", answered_via: "chat", answered_at: now, updated_at: now }).in("id", gone.map((r) => r.id as string));
  if (!fresh.length && !gone.length) return (rows ?? []).map(toQuestion);
  const { data: again } = await admin.from("bible_questions").select("*").eq("client_id", clientId).order("created_at");
  return (again ?? []).map(toQuestion);
}

/** Who on the team holds a stage for a client: the assigned buyers, the head of creative, the execs */
async function holders(admin: SupabaseClient, clientId: string, stage: QStage) {
  if (stage === "media_buyer") {
    const { data } = await admin.from("client_assignments").select("profile_id").eq("client_id", clientId).in("role", ["meta_buyer", "google_buyer", "tiktok_buyer"]);
    if (data?.length) return data.map((d) => d.profile_id as string);
    const { data: heads } = await admin.from("profiles").select("id").eq("is_active", true).in("role", ["head_of_meta", "head_of_google"]);
    return (heads ?? []).map((h) => h.id as string);
  }
  const role = stage === "head_of_creative" ? "head_of_creative" : stage === "exec" ? "executive" : null;
  if (!role) return [];
  const { data } = await admin.from("profiles").select("id").eq("is_active", true).eq("role", role);
  return (data ?? []).map((d) => d.id as string);
}

async function tellHolders(admin: SupabaseClient, clientId: string, q: { id: string; question: string; stage: QStage }, why: string) {
  const ids = await holders(admin, clientId, q.stage);
  if (!ids.length) return;
  const { data: c } = await admin.from("clients").select("name, slug").eq("id", clientId).single();
  if (!c) return;
  await admin.from("notifications").upsert(
    ids.map((id) => ({
      profile_id: id,
      kind: "onboarding",
      title: `${c.name}: a Brand Bible question for you`.slice(0, 200),
      body: `${why} "${q.question.slice(0, 400)}"`.slice(0, 1000),
      href: `/clients/${c.slug}/brand-bible?q=${q.id}`,
      client_id: clientId,
      key: `bible-q:${q.id}:${q.stage}`,
      priority: q.stage === "exec" ? "critical" : "normal",
    })),
    { onConflict: "profile_id,key", ignoreDuplicates: true },
  );
}

/** Sent on to the next who should answer (the client said they don't know, or the team handed it up) */
export async function passOn(admin: SupabaseClient, clientId: string, id: string, by: string, to?: QStage) {
  const { data: r } = await admin.from("bible_questions").select("*").eq("id", id).eq("client_id", clientId).maybeSingle();
  if (!r || r.stage === "answered") return null;
  const q = toQuestion(r);
  const route = ROUTE[q.category];
  const next: QStage = to ?? route[route.indexOf(q.stage) + 1] ?? "exec";
  const now = new Date().toISOString();
  const note: QTurn = { role: q.stage === "client" ? "client" : "team", text: to === "exec" ? "Handed up to the execs." : q.stage === "client" ? "I don't know: over to the team." : `Passed to ${STAGE_NAME[next].toLowerCase()}.`, at: now, by };
  await admin.from("bible_questions").update({ stage: next, thread: [...q.thread, note], updated_at: now }).eq("id", id);
  await tellHolders(admin, clientId, { ...q, stage: next }, q.stage === "client" ? "The client didn't know this one, so it's yours:" : `Passed to you by ${by}:`);
  return next;
}

const S = { type: "string" };
const o = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const FOLD_SCHEMA = o({
  answered: { type: "boolean" },
  answer: S,
  reply: S,
  edits: { type: "array", items: o({ section: S, markdown: S }) },
  readThisFirst: S,
  changeNote: S,
});
type Folded = { answered: boolean; answer: string; reply: string; edits: { section: string; markdown: string }[]; readThisFirst: string; changeNote: string };

/**
 * A message on one question (an answer, or part of one): when it settles the question, the answer is folded into
 * every Bible section it touches and the question closes; when it doesn't, a short reply asks for what's missing.
 */
export async function discussQuestion(admin: SupabaseClient, clientId: string, id: string, msg: { text: string; by: string; via: "client" | "team" }) {
  const [{ data: r }, { data: b }, { data: c }] = await Promise.all([
    admin.from("bible_questions").select("*").eq("id", id).eq("client_id", clientId).maybeSingle(),
    admin.from("client_brand_bibles").select("markdown, read_this_first, open_questions").eq("client_id", clientId).maybeSingle(),
    admin.from("clients").select("name").eq("id", clientId).single(),
  ]);
  if (!r || !b?.markdown || !c) return { ok: false as const, error: "That question isn't open anymore." };
  const q = toQuestion(r);
  if (q.stage === "answered") return { ok: false as const, error: "It's already answered." };
  const text = msg.text.trim().slice(0, 6000);
  if (!text) return { ok: false as const, error: "Write an answer first." };
  const now = new Date().toISOString();
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }).format(new Date());
  const mine: QTurn = { role: msg.via, text, at: now, by: msg.by };
  const { askJson, AiUnavailable } = await import("@/lib/ai");
  const { applyEdits, logChange } = await import("@/lib/bible-sections");
  try {
    const out = await askJson<Folded>({
      agent: "brandbible",
      label: `bible question ${c.name}`,
      clientId,
      override: { model: "sonnet", effort: "low" },
      system: `You keep this client's Brand Bible. One open question is being answered${msg.via === "client" ? " by the client, in their portal" : " by the Kaizen team"}.
- answered: true when the message (with the earlier turns) settles the question; false when something's missing or unclear.
- answer: when answered, the settled answer in one or two plain sentences; else "".
- reply: when answered, a short thank-you that says what changes; when not, one short question asking only for what's missing. Plain words${msg.via === "client" ? ", warm, written to the client" : ""}.
- edits: when answered, every Bible section the answer touches, each returned whole as it should now read (Markdown, starting with its exact heading line), the new facts tagged with their source, e.g. [${msg.via === "client" ? "Client" : "Team"}, Bible question, ${day}]. Remove the question from the open questions section. Keep everything else that still holds. An answer about one test or one conversation is context, never a rule. Else [].
- readThisFirst: the whole new "Read this first" (plain text, under 400 words) only if the answer changes something it covers; else "".
- changeNote: one line for the change log when answered; else "".
Never invent facts.

<brand_bible client="${c.name}">
${b.markdown}
</brand_bible>`,
      prompt: `The question (${CATEGORY_NAME[q.category]}): ${q.question}${q.options.length ? `\nOptions offered: ${q.options.join(" | ")}${q.multi ? " (any that apply)" : ""}` : ""}\n\nThe conversation on it so far:\n${[...q.thread, mine].map((t) => `${t.role === "ai" ? "Bible keeper" : `${t.by ?? (t.role === "client" ? "Client" : "Team")}`}: ${t.text}`).join("\n")}`,
      schema: FOLD_SCHEMA,
      maxTokens: 32000,
      onText: () => {},
    });
    const reply: QTurn = { role: "ai", text: out.reply, at: new Date().toISOString() };
    const thread = [...q.thread, mine, reply].slice(-40);
    if (!out.answered) {
      await admin.from("bible_questions").update({ thread, updated_at: now }).eq("id", id);
      return { ok: true as const, answered: false, thread };
    }
    let markdown = b.markdown as string;
    if (out.edits.length) markdown = applyEdits(markdown, out.edits).markdown;
    markdown = logChange(markdown, `${day}: ${out.changeNote.trim() || `Answered: ${q.question.slice(0, 120)}`} (Bible question, ${msg.by})`);
    const open = ((b.open_questions ?? []) as { question: string; who: string }[]).filter((x) => parseQuestion(x).qid !== q.qid);
    await admin
      .from("client_brand_bibles")
      .update({ markdown, open_questions: open, ...(out.readThisFirst.trim() ? { read_this_first: out.readThisFirst.trim() } : {}) })
      .eq("client_id", clientId);
    await admin
      .from("bible_questions")
      .update({ stage: "answered", answer: out.answer || text, answered_by: msg.by, answered_via: msg.via, answered_at: now, thread, updated_at: now })
      .eq("id", id);
    return { ok: true as const, answered: true, thread };
  } catch (e) {
    return { ok: false as const, error: e instanceof AiUnavailable ? e.message : "That didn't go through. Try again." };
  }
}

/** For the agents and the client portal: what's still open on the client's side */
export async function clientQuestions(admin: SupabaseClient, clientId: string) {
  return (await syncQuestions(admin, clientId)).filter((q) => q.stage === "client");
}
