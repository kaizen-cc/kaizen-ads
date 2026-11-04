"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { clientContext } from "@/lib/ai";
import { buildBible } from "@/lib/brand-bible";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { notLive } from "@/lib/live-guard";

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Execs and leads: research the client on the web, then build (or update) their Brand Bible from that research,
 * pasted sources (intake form, sales call) and everything the app already knows. Runs in the background; the
 * page shows progress until it's done.
 */
export async function buildBrandBible(clientId: string, slug: string, pasted: string): Promise<ActionResult> {
  { const why = await notLive(await createClient(), clientId); if (why) return { ok: false, error: why }; }
  const me = await requireStaff();
  if (!isExecOrLead(me)) return { ok: false, error: "Only execs and leads can build a Brand Bible." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const supabase = await createClient();
  const [{ data: client }, ctx] = await Promise.all([supabase.from("clients").select("id").eq("id", clientId).maybeSingle(), clientContext(supabase, clientId)]);
  if (!client || !ctx) return { ok: false, error: "You don't work on this client." };

  const admin = createAdminClient();
  // A new client's Bible starts from their intake form (or their answers pasted in)
  const [{ data: c }, { count: intakes }] = await Promise.all([
    admin.from("clients").select("status").eq("id", clientId).single(),
    admin.from("client_intakes").select("id", { count: "exact", head: true }).eq("client_id", clientId),
  ]);
  if (c?.status === "onboarding" && !intakes && pasted.trim().length < 200)
    return { ok: false, error: "Waiting on their marketing intake form: the Bible starts on its own once it's in (or paste their answers to start now)." };
  // Shown as building right away; the research and the Bible run after the response
  await admin.from("client_brand_bibles").upsert({ client_id: clientId, status: "building", build_stage: "research", error: null, started_at: new Date().toISOString(), generated_by: me.id });
  after(() => buildBible(admin, clientId, { pasted, by: me.id }));

  revalidatePath(`/clients/${slug}`);
  return { ok: true };
}

/** The Head of Creative (or an exec) reviewed it: from now on its "Read this first" feeds the brief strategist, copywriter and reviewer. */
export async function markBrandBibleReviewed(clientId: string, slug: string): Promise<ActionResult> {
  const me = await requireStaff();
  if (!isExecOrLead(me)) return { ok: false, error: "Only the head of creative or an exec can mark it reviewed." };
  const supabase = await createClient();
  const { error } = await supabase.from("client_brand_bibles").update({ status: "reviewed", reviewed_at: new Date().toISOString(), reviewed_by: me.id }).eq("client_id", clientId);
  revalidatePath(`/clients/${slug}`);
  return error ? { ok: false, error: error.message } : { ok: true };
}

export type BibleTurn = { role: "user" | "assistant"; text: string; at: string; by?: string; changed?: string[]; resolved?: string[] };

const S = { type: "string" };
const o = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const CLARIFY_SCHEMA = o({
  reply: S,
  edits: { type: "array", items: o({ section: S, markdown: S }) },
  resolved: { type: "array", items: S },
  newQuestions: { type: "array", items: o({ question: S, who: S }) },
  readThisFirst: S,
  changeNote: S,
});
type Clarified = { reply: string; edits: { section: string; markdown: string }[]; resolved: string[]; newQuestions: { question: string; who: string }[]; readThisFirst: string; changeNote: string };

const CLARIFY_RULES = `You are reviewing this client's Brand Bible with someone on the Kaizen team, in a chat. Your job: get the open questions answered and fold every answer into the Bible.
- When they answer something (or tell you a fact, a correction, a rule), update every section it touches. Return each changed section whole, as it should now read, Markdown, starting with its exact heading line. Keep everything in the section that still holds. Tag the new facts with their source, e.g. [Team, review chat, <date>].
- When an open question is settled, list its exact text in resolved, and update section 11 (Open questions) to match.
- If their answer changes a rule, an audience or a claim that the "Read this first" page covers, return the whole new Read this first in readThisFirst (plain text, under 400 words); otherwise return "".
- If what they say raises a real new blocker, add it to newQuestions with who answers (client, media buyer or Kaizen).
- reply: short and plain. Say what you changed, then ask the next open question that matters most (one at a time). If nothing is open, say the Bible is ready for review. Never invent client facts; if an answer is unclear, ask.
- changeNote: one line for the change log ("" when nothing changed).`;

/** The review chat: the team answers open questions and corrects the Bible; the strategist's answers edit it in place. */
export async function clarifyBrandBible(clientId: string, slug: string, message: string): Promise<{ ok: true; chat: BibleTurn[] } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!isExecOrLead(me)) return { ok: false, error: "Only execs and leads can change the Brand Bible." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const text = message.trim().slice(0, 8000);
  if (!text) return { ok: false, error: "Write something first." };
  const supabase = await createClient();
  const { data: client } = await supabase.from("clients").select("id, name").eq("id", clientId).maybeSingle();
  if (!client) return { ok: false, error: "You don't work on this client." };
  const admin = createAdminClient();
  const { data: b } = await admin.from("client_brand_bibles").select("markdown, read_this_first, open_questions, review_chat").eq("client_id", clientId).maybeSingle();
  if (!b?.markdown) return { ok: false, error: "There's no Brand Bible yet." };

  const { askJson, AiUnavailable, contextBlock } = await import("@/lib/ai");
  const { applyEdits, logChange } = await import("@/lib/bible-sections");
  const ctx = await clientContext(admin, clientId, { fresh: true }).catch(() => null);
  const now = new Date().toISOString();
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }).format(new Date());
  const chat = (b.review_chat ?? []) as BibleTurn[];
  const questions = (b.open_questions ?? []) as { question: string; who: string }[];
  const mine: BibleTurn = { role: "user", text, at: now, by: me.fullName ?? undefined };
  try {
    // The Bible sits in the system prompt, so the next message in the conversation reads it from the cache
    const out = await askJson<Clarified>({
      agent: "brandbible",
      label: `brand bible review ${client.name}`,
      clientId,
      override: { model: "sonnet", effort: "medium" },
      system: `${CLARIFY_RULES}\n\n<brand_bible client="${client.name}">\n${b.markdown}\n</brand_bible>\n\n<read_this_first>\n${b.read_this_first ?? ""}\n</read_this_first>`,
      prompt: `${ctx ? `${contextBlock({ ...ctx, brandBible: null }, undefined, { allotment: false })}\n\n` : ""}Open questions right now:\n${questions.map((q, i) => `${i + 1}. ${q.question} (${q.who})`).join("\n") || "None."}\n\nThe chat so far:\n${[...chat.slice(-16), mine].map((t) => `${t.role === "user" ? (t.by ?? "Team") : "You"}: ${t.text}`).join("\n\n")}\n\nToday is ${day}. Answer the last message.`,
      schema: CLARIFY_SCHEMA,
      // Whole sections come back, so there has to be room (streamed)
      maxTokens: 32000,
      onText: () => {},
    });
    let markdown = b.markdown as string;
    let changed: string[] = [];
    if (out.edits.length) ({ markdown, changed } = applyEdits(markdown, out.edits));
    if (out.changeNote.trim() && (changed.length || out.readThisFirst.trim())) markdown = logChange(markdown, `${day}: ${out.changeNote.trim()} (review chat, ${me.fullName ?? "team"})`);
    const settled = new Set(out.resolved.map((r) => r.trim().toLowerCase()));
    const open = [...questions.filter((q) => !settled.has(q.question.trim().toLowerCase())), ...out.newQuestions];
    const reply: BibleTurn = { role: "assistant", text: out.reply, at: new Date().toISOString(), changed, resolved: out.resolved };
    const next = [...chat, mine, reply].slice(-60);
    await admin
      .from("client_brand_bibles")
      .update({ markdown, open_questions: open, review_chat: next, ...(out.readThisFirst.trim() ? { read_this_first: out.readThisFirst.trim() } : {}) })
      .eq("client_id", clientId);
    revalidatePath(`/clients/${slug}`);
    revalidatePath(`/clients/${slug}/brand-bible`);
    return { ok: true, chat: next };
  } catch (e) {
    return { ok: false, error: e instanceof AiUnavailable ? e.message : "The strategist couldn't answer. Try again." };
  }
}

/** Starts the review chat over (the Bible keeps every change it made) */
export async function clearBibleChat(clientId: string, slug: string): Promise<ActionResult> {
  const me = await requireStaff();
  if (!isExecOrLead(me) || !adminConfigured()) return { ok: false, error: "Not allowed." };
  await createAdminClient().from("client_brand_bibles").update({ review_chat: [] }).eq("client_id", clientId);
  revalidatePath(`/clients/${slug}/brand-bible`);
  return { ok: true };
}

/** Someone on the team answers (or adds to) one open question, in the question itself: folded into the Bible when settled */
export async function discussBibleQuestion(clientId: string, slug: string, id: string, text: string) {
  const me = await requireStaff();
  if (!adminConfigured()) return { ok: false as const, error: "Server key missing." };
  const { data: client } = await (await createClient()).from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!client) return { ok: false as const, error: "You don't work on this client." };
  const { discussQuestion } = await import("@/lib/bible-questions");
  const r = await discussQuestion(createAdminClient(), clientId, id, { text, by: me.fullName ?? "Team", via: "team" });
  if (r.ok && r.answered) {
    revalidatePath(`/clients/${slug}`);
    revalidatePath(`/clients/${slug}/brand-bible`);
  }
  return r;
}

/** Hands a question on: to the next who should answer, or up to the execs */
export async function passBibleQuestion(clientId: string, slug: string, id: string, toExecs: boolean) {
  const me = await requireStaff();
  if (!adminConfigured()) return { ok: false as const, error: "Server key missing." };
  const { data: client } = await (await createClient()).from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!client) return { ok: false as const, error: "You don't work on this client." };
  const { passOn } = await import("@/lib/bible-questions");
  const next = await passOn(createAdminClient(), clientId, id, me.fullName ?? "Team", toExecs ? "exec" : undefined);
  revalidatePath(`/clients/${slug}/brand-bible`);
  return next ? { ok: true as const, stage: next } : { ok: false as const, error: "That question isn't open anymore." };
}

/** The account packaged now (Bible, change log, where we left off, everything they ran), ready to download */
export async function exportAccount(clientId: string, slug: string) {
  const me = await requireStaff();
  if (!isExecOrLead(me)) return { ok: false as const, error: "Only execs and leads can package an account." };
  if (!adminConfigured()) return { ok: false as const, error: "Server key missing." };
  const { data: client } = await (await createClient()).from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!client) return { ok: false as const, error: "You don't work on this client." };
  const { makeExport } = await import("@/lib/client-export");
  const r = await makeExport(createAdminClient(), clientId, "on demand", me.id);
  revalidatePath(`/clients/${slug}/brand-bible`);
  return r ? { ok: true as const } : { ok: false as const, error: "Couldn't package it. Try again." };
}

/** The website suggestions sent to the client's contacts now (when the app isn't sending to them on its own yet) */
export async function sendWebsiteSuggestions(clientId: string, slug: string) {
  const me = await requireStaff();
  if (!isExecOrLead(me)) return { ok: false as const, error: "Only execs and leads can email the client from here." };
  if (!adminConfigured()) return { ok: false as const, error: "Server key missing." };
  const { data: client } = await (await createClient()).from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!client) return { ok: false as const, error: "You don't work on this client." };
  const { sendSuggestions } = await import("@/lib/website-issues");
  const r = await sendSuggestions(createAdminClient(), clientId, me.id);
  revalidatePath(`/clients/${slug}/brand-bible`);
  return r;
}

/** A website or data issue marked fixed or not worth raising */
export async function closeWebsiteIssue(clientId: string, slug: string, id: string, status: "fixed" | "dismissed") {
  await requireStaff();
  if (!adminConfigured()) return { ok: false as const, error: "Server key missing." };
  const { data: client } = await (await createClient()).from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!client) return { ok: false as const, error: "You don't work on this client." };
  await createAdminClient().from("website_issues").update({ status }).eq("id", id).eq("client_id", clientId);
  revalidatePath(`/clients/${slug}/brand-bible`);
  return { ok: true as const };
}

/** The Bible's pages read again now */
export async function recheckLinks(clientId: string, slug: string) {
  await requireStaff();
  if (!adminConfigured()) return { ok: false as const, error: "Server key missing." };
  const { data: client } = await (await createClient()).from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!client) return { ok: false as const, error: "You don't work on this client." };
  const { checkLinks } = await import("@/lib/bible-links");
  const r = await checkLinks(createAdminClient(), clientId, { before: true, max: 25 });
  revalidatePath(`/clients/${slug}/brand-bible`);
  return { ok: true as const, ...r };
}

/** The client's Client Onboarding Sheet, by its link (when it isn't found by name in Drive): read right away */
export async function pointOnboardingSheet(clientId: string, slug: string, url: string): Promise<{ ok: true; result: string } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!isExecOrLead(me)) return { ok: false, error: "Only execs and leads can set the onboarding sheet." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const { data: client } = await (await createClient()).from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!client) return { ok: false, error: "You don't work on this client." };
  const { setOnboardingSheet } = await import("@/lib/onboarding-sheet");
  const r = await setOnboardingSheet(createAdminClient(), clientId, url).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
  revalidatePath(`/clients/${slug}/brand-bible`);
  return r;
}

/**
 * Collect the review bank again (the store's review app, Trustpilot, Google, comments on their Facebook and Instagram
 * posts and ads) and rewrite only the Bible's review bank and its count. Cheap: no web research, no Bible rewrite.
 * Runs in the background; the page shows "Collecting reviews" until it's done.
 */
export async function refreshReviewBankNow(clientId: string, slug: string): Promise<ActionResult> {
  const me = await requireStaff();
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const { data: client } = await (await createClient()).from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!client) return { ok: false, error: "You don't work on this client." };
  const admin = createAdminClient();
  if (!isExecOrLead(me)) {
    const { data: mine } = await admin.from("client_assignments").select("profile_id").eq("client_id", clientId).eq("profile_id", me.id).limit(1).maybeSingle();
    if (!mine) return { ok: false, error: "Only the client's team or a lead can refresh the review bank." };
  }
  const { data: b } = await admin.from("client_brand_bibles").select("markdown, status, review_bank").eq("client_id", clientId).maybeSingle();
  if (!b?.markdown) return { ok: false, error: "There's no Brand Bible yet." };
  if (b.status === "building") return { ok: false, error: "The Bible is being written: its review bank is collected as part of it." };
  const rb = b.review_bank as { status?: string; startedAt?: string } | null;
  // Already collecting (and not stuck): nothing to start
  if (rb?.status === "collecting" && rb.startedAt && Date.now() - new Date(rb.startedAt).getTime() < 10 * 60_000) return { ok: true };
  await admin
    .from("client_brand_bibles")
    .update({ review_bank: { ...(rb ?? {}), status: "collecting", startedAt: new Date().toISOString(), error: null } })
    .eq("client_id", clientId);
  const { refreshReviewBank } = await import("@/lib/review-bank");
  after(() => refreshReviewBank(admin, clientId).then(() => revalidatePath(`/clients/${slug}/brand-bible`)));
  revalidatePath(`/clients/${slug}/brand-bible`);
  return { ok: true };
}

/** Write the client presentation from this Bible, in the background (the presentation page shows its progress) */
export async function writeClientPresentation(clientId: string, slug: string): Promise<ActionResult> {
  const { rewritePresentation } = await import("./brand-bible/presentation/actions");
  const r = await rewritePresentation(clientId, "");
  revalidatePath(`/clients/${slug}/brand-bible`);
  return r.ok ? { ok: true } : r;
}
