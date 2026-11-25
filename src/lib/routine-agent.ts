import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson, clientContext, contextBlock } from "@/lib/ai";
import { itemHref, nyClock, plainTitle, ROUTINES, type RecapDraft, type RecapLine, type RoutineReport } from "@/lib/routines-core";
import { tagged } from "@/lib/routine-sweeps-core";
import { isPeopleMatter, PEOPLE_RULE } from "@/lib/people-matters";

// The nightly execution agent and the morning clean sweep (owner, Nov 24 2026; docs/kyle-scheduled-runs.md #6 and #7).
// Nightly: works the person's open items with the context the OS has, and stages everything for their review: a
// drafted message on the item (their client's internal channel or a teammate; one tap to send, never sent for them), a
// branded PDF for a substantive deliverable (only into their standing confirmed folder), team tasks STAGED until they
// release them, and questions only they can answer. It never sends, posts or publishes, never touches an ad or email
// platform, never states a client's fee. Clean sweep: closes what they already sent or did (only on proof), merges
// duplicates, and leaves a short list of what only they can do today.

type Admin = SupabaseClient;
type Me = { id: string; full_name: string; email: string; role: string; is_exec: boolean; is_lead: boolean };
const DAY = 86_400_000;

// A report row for an item (the card's row: client chip, short title, due, and what it does)
type Row = { id: unknown; title: unknown; due_on?: unknown; clients?: unknown };
const clientName = (r: Row) => (r.clients as { name?: string } | null)?.name ?? null;
const itemLine = (r: Row, more: Partial<RecapLine> = {}): RecapLine => ({ text: plainTitle(String(r.title)), itemId: String(r.id), client: clientName(r), due: (r.due_on as string | null) ?? null, href: itemHref(String(r.id)), act: "open", tag: null, ...more });
const draftOf = (d: ItemDraft): RecapDraft | null =>
  d.text && (d.kind === "slack" || d.kind === "email") ? { kind: d.kind, text: d.text, channel: d.channelName ?? null, canPost: d.kind === "slack" && Boolean(d.channelId), to: d.to ?? null, subject: d.subject ?? null } : null;

export type ItemDraft = {
  at: string;
  kind: "slack" | "email" | "question" | "cant";
  text?: string;
  channelId?: string | null;
  channelName?: string | null;
  to?: string | null;
  subject?: string | null;
  pdf?: string | null;
  staged?: number;
  leftToDo?: string;
  question?: string;
  reason?: string;
  sentAt?: string | null;
};

const PLAN = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["execute", "question", "cant"] },
    reason: { type: "string", description: "cant: what needs them personally (a call, a pricing/fee/scope/hiring/churn decision, platform access, any change in Meta/Google/Klaviyo/Shopify); question: why it's blocked" },
    question: { type: ["string", "null"], description: "question: the one or two facts only they have, as one specific question" },
    options: { type: ["array", "null"], items: { type: "string" }, description: "question: 2-4 likely answers they can tap, when the answer is a choice (else null)" },
    deliverable: { type: ["object", "null"], properties: { title: { type: "string" }, markdown: { type: "string", description: "## sections, short paragraphs and bullets; generous, never cramped" } }, required: ["title", "markdown"], additionalProperties: false },
    message: {
      type: ["object", "null"],
      properties: { where: { type: "string", enum: ["internal_channel", "teammate", "email"] }, teammate: { type: ["string", "null"] }, to: { type: ["string", "null"] }, subject: { type: ["string", "null"] }, text: { type: "string" } },
      required: ["where", "teammate", "to", "subject", "text"],
      additionalProperties: false,
    },
    staged: { type: "array", items: { type: "object", properties: { person: { type: "string" }, scope: { type: "string" }, detail: { type: "string" }, done: { type: "string" } }, required: ["person", "scope", "detail", "done"], additionalProperties: false } },
    left_to_do: { type: "string", description: "Exactly what they still do, e.g. 'Send the draft in #internal-oceanbox + release 1 staged task'" },
  },
  required: ["decision", "reason", "question", "options", "deliverable", "message", "staged", "left_to_do"],
  additionalProperties: false,
};
type Plan = { decision: "execute" | "question" | "cant"; reason: string; question: string | null; options?: string[] | null; deliverable: { title: string; markdown: string } | null; message: { where: string; teammate: string | null; to: string | null; subject: string | null; text: string } | null; staged: { person: string; scope: string; detail: string; done: string }[]; left_to_do: string };

/** Whether the person already sent the drafted message: their own message in that client's Slack after the draft, saying the same thing */
async function sentSince(admin: Admin, me: Me, item: { client_id: string | null }, d: ItemDraft): Promise<{ at: string; link: string | null } | null> {
  if (d.sentAt) return { at: d.sentAt, link: null };
  if (d.kind !== "slack" || !d.text || !item.client_id) return null;
  const { likeness } = await import("@/lib/reality-check-core");
  const { data } = await admin.from("context_items").select("occurred_at, body, url").eq("client_id", item.client_id).eq("author", me.full_name).in("source", ["slack_internal", "slack_external"]).gte("occurred_at", d.at).limit(40);
  const hit = (data ?? []).find((m) => likeness(d.text!, String(m.body ?? "")) >= 0.6);
  return hit ? { at: hit.occurred_at as string, link: (hit.url as string | null) ?? null } : null;
}

/** Step 0 (and the clean sweep's first step): items whose draft was sent close as "Sent by"; the rest still wait */
async function closeSent(admin: Admin, me: Me) {
  const { data } = await admin.from("agent_asks").select("id, title, client_id, detail, draft, due_on, clients(name)").eq("owner_id", me.id).eq("status", "open").not("draft", "is", null).limit(100);
  const closed: RecapLine[] = [];
  const waiting: RecapLine[] = [];
  for (const it of data ?? []) {
    const d = it.draft as ItemDraft;
    if (d.kind !== "slack" && d.kind !== "email") continue;
    const sent = await sentSince(admin, me, it as { client_id: string | null }, d);
    if (sent) {
      const when = new Date(sent.at).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      await admin.from("agent_asks").update({ status: "done", done_at: new Date().toISOString(), detail: `${String(it.detail ?? "").trim()}\nSent by ${me.full_name.split(" ")[0]} ${when}${sent.link ? ` ${sent.link}` : ""}`.trim().slice(0, 4000) }).eq("id", it.id);
      closed.push(itemLine(it, { detail: `Sent ${when}`, href: sent.link ?? itemHref(String(it.id)), tag: "certain" }));
    } else waiting.push(itemLine(it, { detail: d.kind === "slack" ? `The draft${d.channelName ? ` for #${d.channelName}` : ""}` : `The email${d.to ? ` to ${d.to}` : ""}`, act: draftOf(d) ? "send" : "open", draft: draftOf(d) }));
  }
  return { closed, waiting };
}

const revenueRank = (i: { urgent: boolean; client_id: string | null; due_on: string | null }) => (i.urgent ? 0 : i.client_id ? 1 : 2) * 10_000 + (i.due_on ? Math.floor(Date.parse(i.due_on) / DAY) % 10_000 : 9_999);

/** The nightly execution agent */
export async function nightly(admin: Admin, me: Me): Promise<RoutineReport> {
  const today = nyClock(new Date()).date;
  const { closed, waiting } = await closeSent(admin, me);
  const soon = new Date(Date.parse(today) + 3 * DAY).toISOString().slice(0, 10);
  const { data: open } = await admin.from("agent_asks").select("id, title, detail, client_id, due_on, urgent, created_at, draft, facts, clients(name, internal_slack_channel_id)").eq("owner_id", me.id).eq("status", "open").limit(200);
  // Answers to last night's questions: their comments on the item since the question
  const asked = (open ?? []).filter((i) => (i.draft as ItemDraft | null)?.kind === "question");
  const { data: answers } = asked.length ? await admin.from("item_comments").select("key, body, created_at, author_id").in("key", asked.map((i) => `ask:${i.id}`)).eq("author_id", me.id) : { data: [] };
  const answerOf = new Map<string, string>();
  for (const a of answers ?? []) {
    const it = asked.find((i) => `ask:${i.id}` === a.key);
    if (it && String(a.created_at) > String((it.draft as ItemDraft).at)) answerOf.set(it.id as string, String(a.body));
  }
  const queue = (open ?? [])
    .filter((i) => !i.draft || answerOf.has(i.id as string))
    .filter((i) => answerOf.has(i.id as string) || (i.due_on && String(i.due_on) <= soon) || Date.parse(String(i.created_at)) > Date.now() - 2 * DAY)
    .sort((a, b) => revenueRank(a as never) - revenueRank(b as never));
  const cap = me.is_exec || me.is_lead || me.role.startsWith("head_of_") ? 20 : 8;
  const now = queue.slice(0, cap);
  const notReached = queue.slice(cap).map((i) => itemLine(i));
  const { data: people } = await admin.from("profiles").select("id, full_name").eq("is_active", true);
  const { matchPerson } = await import("@/lib/routine-sweeps-core");
  const team = (people ?? []).filter((p) => p.id !== me.id).map((p) => ({ id: p.id as string, name: p.full_name as string }));
  const { loadReality, createItemIfNew } = await import("@/lib/reality-check");
  const found = await loadReality(admin, { clientIds: now.map((i) => (i.client_id as string | null) ?? null), ownerIds: team.map((t) => t.id) }).catch(() => []);
  const drafts: RecapLine[] = [];
  const questions: RecapLine[] = [];
  const cant: RecapLine[] = [];
  let pdfs = 0;
  const dest = await (await import("@/lib/drive-destination")).backgroundDestination(admin, { profileId: me.id, clientId: null, docType: "nightly_deliverable" }).catch(() => null);
  for (const it of now) {
    // A people matter is the person's own to handle: never drafted, staged or sent to anyone (owner, Nov 24 2026)
    if (isPeopleMatter(`${it.title}\n${String(it.detail ?? "")}`)) {
      cant.push(itemLine(it, { detail: "Yours to handle personally" }));
      continue;
    }
    const client = it.clients as unknown as { name: string; internal_slack_channel_id: string | null } | null;
    const ctx = it.client_id ? await clientContext(admin, it.client_id as string, { fresh: true }).catch(() => null) : null;
    const { data: said } = it.client_id ? await admin.from("context_items").select("source, occurred_at, author, body").eq("client_id", it.client_id).in("source", ["slack_internal", "slack_external", "gmail", "call"]).gte("occurred_at", new Date(Date.now() - 30 * DAY).toISOString()).order("occurred_at", { ascending: false }).limit(25) : { data: [] };
    let plan: Plan;
    try {
      plan = await askJson<Plan>({
        agent: "calls",
        label: "routine nightly item",
        clientId: (it.client_id as string | null) ?? null,
        override: { model: "sonnet", effort: "medium" },
        maxTokens: 6000,
        system: `You are the nightly execution agent for a ${me.role.replace(/_/g, " ")} at Kaizen, a paid ads, creative, email and social agency. For one of their open items, do everything you have full context for and stage it as DRAFTS for their review. Nothing is ever sent.
decision: execute (a brief, creative brief, summary or recap, research, an SOP or playbook, information for a teammate, a staged team task, a draft reply), question (blocked on one or two facts only they have), or cant (needs them personally: a call, a pricing/fee/scope/hiring/churn decision, platform access, anything that changes Meta, Google, Klaviyo or Shopify; never touch ad or email platforms).
deliverable: for a substantive piece only (else null): a title and the document in markdown with ## sections.
message: a drafted message (else null): internal_channel (the client's INTERNAL channel, tagging the audience by name), teammate (to one teammate, name them), or email (to, subject, a short body; long content goes in the deliverable). 1-3 lines of summary + what's needed + by when. Never client-facing Slack.
staged: tasks for teammates, staged until they release them: person, verb-first scope, detail (the data behind it, the client), done (definition of done; kill/scale rules for any ad work). One per person.
A question is only for a fact they have that you don't; never ask who should own, build or decide something (that's cant, with the reason), and never ask about work that's already done or already running. Already running in Kaizen OS for everyone (not open work): ${ROUTINES.map((r) => r.label.toLowerCase()).join(", ")}; owed replies and promises with drafts; the done-check; client message reading.
Never state what Kaizen charges a client. Tag inferred claims [likely] or [guessing] inline. Never invent numbers, links or dates: use [brackets]. ${PEOPLE_RULE} An item that is itself a people matter is cant.`,
        schema: PLAN,
        prompt: [
          ctx ? contextBlock(ctx, undefined, { allotment: false }) : "",
          `<item>${it.title}\n${String(it.detail ?? "").slice(0, 3000)}${it.due_on ? `\nDue ${it.due_on}` : ""}${client ? `\nClient: ${client.name}` : ""}</item>`,
          answerOf.has(it.id as string) ? `<their_answer>${answerOf.get(it.id as string)}</their_answer>` : "",
          said?.length ? `<said_lately>\n${said.map((s) => `- [${String(s.occurred_at).slice(0, 10)} ${s.source}${s.author ? ` ${s.author}` : ""}] ${String(s.body ?? "").replace(/\s+/g, " ").slice(0, 400)}`).join("\n")}\n</said_lately>` : "",
          `Teammates: ${team.map((t) => t.name).join(", ")}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      });
    } catch {
      continue;
    }
    const stamp = new Date().toISOString();
    if (plan.decision === "question" && plan.question) {
      questions.push(itemLine(it, { detail: plan.question, act: "answer", question: plan.question }));
      // Its sheet: the question, the answers to tap, and the answer goes back as a comment the next run reads
      await admin.from("agent_asks").update({ draft: { at: stamp, kind: "question", question: plan.question } satisfies ItemDraft, facts: { ...((it.facts as object | null) ?? {}), options: (plan.options ?? []).slice(0, 4) } }).eq("id", it.id);
      continue;
    }
    if (plan.decision === "cant") {
      cant.push(itemLine(it, { detail: plan.reason }));
      continue;
    }
    // A PDF for a substantive deliverable, into their standing confirmed folder only (never a guessed folder)
    let pdf: string | null = null;
    if (plan.deliverable && pdfs < 10 && dest) {
      try {
        const { renderBiblePdf } = await import("@/lib/brand-bible-pdf");
        const { uploadToFolder } = await import("@/lib/drive-push");
        const stampDate = `${today.slice(5, 7)}.${today.slice(8, 10)}.${today.slice(2, 4)}`;
        const name = `${client?.name ?? "Kaizen"} — ${plan.deliverable.title} — ${stampDate}`;
        const bytes = await renderBiblePdf({ client: client?.name ?? "Kaizen", version: stampDate, status: "draft", generatedAt: stamp, markdown: plan.deliverable.markdown, readThisFirst: "", kind: plan.deliverable.title, about: `Drafted overnight by Kaizen OS for ${me.full_name.split(" ")[0]} to review. Internal.` });
        const up = await uploadToFolder(me.email, dest.id, `${name}.pdf`, bytes, "application/pdf");
        pdf = up.link;
        pdfs++;
      } catch {
        pdf = null;
      }
    }
    // Team tasks: their own item to hand off with Delegate (the hand-off flow they already use); nobody else gets
    // anything until they hand it on
    let staged = 0;
    for (const t of plan.staged.slice(0, 4)) {
      const who = matchPerson(t.person, team);
      const r = await createItemIfNew(admin, { facts: { handoff: { toId: who?.id ?? null, toName: who?.name ?? t.person, scope: t.scope, done: t.done, detail: t.detail }, links: pdf ? [{ label: "PDF", url: pdf }] : [] }, owner_id: me.id, asked_by: me.id, client_id: (it.client_id as string | null) ?? null, title: tagged("Agent", today, `Hand to ${who?.name ?? t.person} · ${t.scope}`), detail: `Ready to hand to ${who?.name ?? t.person}: Delegate it to them when you're happy with it.\n${t.detail}\nDone means: ${t.done}${pdf ? `\n${pdf}` : ""}\n(Drafted by Kaizen OS's nightly agent.)`, source_ref: `nightly:${it.id}:${t.scope.slice(0, 40)}` }, found);
      if (r.state === "new" && r.id) staged++;
    }
    const m = plan.message && !isPeopleMatter(plan.message.text) ? plan.message : null;
    const internal = client?.internal_slack_channel_id ?? null;
    const draft: ItemDraft = m
      ? m.where === "email"
        ? { at: stamp, kind: "email", text: m.text, to: m.to, subject: m.subject, pdf, staged, leftToDo: plan.left_to_do }
        : { at: stamp, kind: "slack", text: m.text, channelId: m.where === "internal_channel" ? internal : null, channelName: m.where === "teammate" ? m.teammate : client ? `internal ${client.name}` : null, pdf, staged, leftToDo: plan.left_to_do }
      : { at: stamp, kind: "slack", text: "", pdf, staged, leftToDo: plan.left_to_do };
    await admin.from("agent_asks").update({ draft, detail: `${String(it.detail ?? "").trim()}\nDraft ready (${today}): ${plan.left_to_do}${pdf ? ` · ${pdf}` : ""}${draft.text ? `\n---\n${draft.kind === "email" && draft.subject ? `Subject: ${draft.subject}\n` : ""}${draft.text}` : ""}`.trim().slice(0, 4000) }).eq("id", it.id);
    drafts.push(itemLine(it, { detail: [plan.left_to_do, pdf ? `PDF: ${pdf}` : "", staged ? `${staged} task${staged === 1 ? "" : "s"} to hand off` : ""].filter(Boolean).join(" · "), act: draftOf(draft) ? "send" : "open", draft: draftOf(draft) }));
  }
  const top = drafts[0] ?? cant[0] ?? waiting[0] ?? null;
  return {
    headline: `${drafts.length} draft${drafts.length === 1 ? "" : "s"} ready, ${cant.length} couldn't be done, ${questions.length} question${questions.length === 1 ? "" : "s"}.${top ? ` Top priority: ${top.client ? `${top.client}, ` : ""}${top.text}.` : ""}`,
    sections: [
      { title: "Drafts ready to review", lines: drafts },
      { title: "Answer the agent", lines: questions },
      { title: "Couldn't do", lines: cant },
      { title: "Still waiting on you to send", lines: waiting },
      { title: "Closed tonight", lines: closed },
      { title: "Not reached tonight", lines: notReached },
    ].filter((s) => s.lines.length),
    failedSources: dest ? [] : ["No standing Drive folder for nightly deliverables: confirm one once (\"save nightly deliverables to …\") and PDFs go there"],
  };
}

/** The morning clean sweep: only what they still have to do today stays open */
export async function cleanSweep(admin: Admin, me: Me): Promise<RoutineReport> {
  const today = nyClock(new Date()).date;
  const { closed, waiting } = await closeSent(admin, me);
  // Provably done (the done-check's guardrails: a plain confirmation, never a decision or partial progress)
  const { checkNow } = await import("@/lib/done-check-now");
  const checked = await checkNow(admin, { id: me.id, role: me.role, isExec: me.is_exec, isLead: me.is_lead }, { scope: "mine", cap: 20 }).catch(() => null);
  const fromCheck = (c: { key: string; client: string; what: string; quote: string | null; link: string | null }, tag: "certain" | "likely"): RecapLine => {
    const id = c.key.startsWith("ask:") ? c.key.slice(4) : null;
    return { text: plainTitle(c.what), client: c.client, detail: c.quote ? `"${c.quote}"` : null, itemId: id, href: c.link ?? (id ? itemHref(id) : null), act: "open", tag };
  };
  const proven = (checked?.closed ?? []).map((c) => fromCheck(c, "certain"));
  const probably = (checked?.moving ?? []).slice(0, 6).map((c) => fromCheck(c, "likely"));
  // Their sheet shows why: the words, where and when they were said, the link
  for (const c of (checked?.moving ?? []).slice(0, 6) as { key: string; quote: string | null; where?: string | null; said?: string | null; link: string | null }[]) {
    if (!c.key.startsWith("ask:")) continue;
    const { data: cur } = await admin.from("agent_asks").select("facts").eq("id", c.key.slice(4)).maybeSingle();
    await admin.from("agent_asks").update({ facts: { ...((cur?.facts as object | null) ?? {}), evidence: { state: "moving", quote: c.quote ?? null, source: c.where ?? null, url: c.link ?? null, at: c.said ?? null } } }).eq("id", c.key.slice(4));
  }
  // Duplicates (recaps, the tracker and the nightly agent can each make one): the oldest keeps the details
  const { data: open } = await admin.from("agent_asks").select("id, title, detail, client_id, due_on, urgent, created_at, draft, status, staged_for, released_at, clients(name)").eq("owner_id", me.id).in("status", ["open", "staged"]).order("created_at").limit(300);
  const { sameWork } = await import("@/lib/reality-check-core");
  const merged: RecapLine[] = [];
  const keep: typeof open = [];
  for (const it of (open ?? []).filter((i) => i.status === "open")) {
    const k = keep!.find((x) => sameWork({ title: String(it.title), clientId: (it.client_id as string | null) ?? null }, { source: "item", id: String(x.id), title: String(x.title), clientId: (x.client_id as string | null) ?? null, ownerId: me.id, owner: null, open: true, href: null, at: null }));
    if (!k) {
      keep!.push(it);
      continue;
    }
    await admin.from("agent_asks").update({ detail: `${String(k.detail ?? "").trim()}\nAlso: ${String(it.detail ?? it.title).split("\n")[0].slice(0, 300)}`.trim().slice(0, 4000) }).eq("id", k.id);
    await admin.from("agent_asks").update({ status: "dismissed", done_at: new Date().toISOString(), detail: `Duplicate of: ${k.title}` }).eq("id", it.id);
    merged.push(itemLine(k, { detail: `Merged a duplicate: ${plainTitle(String(it.title))}` }));
  }
  const staged = (open ?? []).filter((i) => i.status === "open" && String(i.title).includes("] Hand to "));
  const answers = keep!.filter((i) => (i.draft as ItemDraft | null)?.kind === "question");
  const onlyYou = keep!
    .filter((i) => !i.draft && (!i.due_on || String(i.due_on) <= today))
    .sort((a, b) => revenueRank(a as never) - revenueRank(b as never))
    .slice(0, 10)
    .map((i) => itemLine(i));
  const cleaned = [...closed, ...proven, ...merged];
  return {
    headline: `Board's clean: ${onlyYou.length} need${onlyYou.length === 1 ? "s" : ""} you today, ${waiting.length} just need${waiting.length === 1 ? "s" : ""} a send.${onlyYou[0] ? ` First: ${onlyYou[0].client ? `${onlyYou[0].client}, ` : ""}${onlyYou[0].text}.` : ""}`,
    sections: [
      { title: "Only you can do", lines: onlyYou },
      { title: "Just hit send", lines: waiting },
      { title: "Answer the agent", lines: answers.map((i) => itemLine(i, { detail: (i.draft as ItemDraft).question ?? null, act: "answer", question: (i.draft as ItemDraft).question ?? null })) },
      { title: "Hand off", lines: staged.map((i) => itemLine(i, { act: "handoff" })) },
      { title: "Probably done, confirm", lines: probably },
      { title: "Cleaned up overnight", lines: cleaned },
    ].filter((s) => s.lines.length),
  };
}
