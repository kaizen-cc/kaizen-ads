import "server-only";
import type { Staff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { OPEN_STATUSES, STATUS_LABEL, archiveText, briefHref, briefText, cleanBrief, fitBand, isProspectStatus, worksSales } from "@/lib/sales-core";
import { str, num, type AiTool } from "./types";

// The Sales agent's tools, for the assistant, every agent call and Kaizen AI (registered in src/lib/kaizen-ai/extensions.ts).
// Internal for now: only the executives and the leads see them (`only`) and every run checks again.
//   web_research        research anything on the open web (the assistant and calls have no web search of their own)
//   research_prospect   one business from its site and the open web → a prospect brief + Kaizen sales strategy, kept
//   find_prospects      businesses matching a profile from public sources, scored by fit, added as "new"
//   my_prospects        the pipeline: mine or everyone's, by stage
//   prospect_details    one prospect's research, drafts and reviews
//   save_prospect       add one by hand, or change its stage, owner, notes or details
//   draft_pitch         call script, email and LinkedIn drafts (sent by the person themselves; nothing on LinkedIn is automated)
//   review_sales_call   a sales call from its transcript (pasted, a Google Doc, an attached file) → coaching + next steps + proposal
//   prospect_won        won: linked to the enrolled client; its documents listed to move to the client's Headquarters
// Proposals and SOWs are the document system's (make_document with prospect: <name>); to talk to the agent itself:
// open_screen place 'sales agent'; the pipeline: open_screen place 'prospects'.

const NOT_SALES = { ok: false, error: "Sales is for the executives and leads for now." };
const viewing = (u: Staff) => (u.viewAs ? { ok: false, error: "While viewing as someone, nothing is researched or saved for them." } : null);
const pageOf = (id: string) => `/sales/${id}`;

async function prospectFrom(input: Record<string, unknown>) {
  const ref = str(input.prospect);
  if (!ref) return null;
  const { findProspect } = await import("@/lib/sales-agent");
  return findProspect(await createClient(), ref);
}

const webResearch: AiTool = {
  name: "web_research",
  description:
    "Executives and leads: researches a question on the open web (searches and reads pages) and returns notes with their sources. Use it for anything public: a business's website, reviews and social presence, whether it runs ads (Meta Ad Library, Google Ads Transparency Center), a market, competitors, a platform's latest rules, news. For a full prospect brief with a Kaizen sales strategy use research_prospect instead. LinkedIn: only what a public search shows; never log in, browse or automate LinkedIn. Takes up to a minute.",
  input_schema: { type: "object", properties: { question: { type: "string", description: "What to find out, with names and sites" } }, required: ["question"], additionalProperties: false },
  only: worksSales,
  run: async (user: Staff, input) => {
    if (!worksSales(user)) return NOT_SALES;
    const q = str(input.question);
    if (!q) return { ok: false, error: "What should I look up?" };
    const { researchWeb } = await import("@/lib/ai");
    const notes = await researchWeb({
      agent: "sales_desk",
      label: "web research",
      model: "sonnet",
      maxSearches: 6,
      maxFetches: 6,
      maxTurns: 4,
      system: "You research a question on the open web for Kaizen's team. Short factual notes, each with the URL it came from. Say plainly when something can't be found. LinkedIn: only what a public search result shows; never log in or browse it.",
      prompt: q.slice(0, 2000),
    });
    return { ok: true, notes: notes.slice(0, 12_000) };
  },
};

const research: AiTool = {
  name: "research_prospect",
  description:
    "Executives and leads: the Sales agent researches one business (a prospect) from its website and the open web (Google reviews, social profiles, the Meta Ad Library, the Google Ads Transparency Center, email capture) into a prospect brief: what they sell, locations, positioning, visible marketing, likely gaps, a fit score, and a Kaizen sales strategy: which Kaizen services fit (from the rate card, with prices), the angle, proof from similar Kaizen clients (internal: never named to a prospect), and first-outreach talking points. Saved on the prospect in Sales › Prospects (made if new). Give a name and/or website (and the city if the name is common); prospect: an existing prospect to refresh. Takes one to two minutes: say so first.",
  input_schema: {
    type: "object",
    properties: { name: { type: "string" }, website: { type: "string" }, location: { type: "string" }, question: { type: "string", description: "Anything specific to look into" }, prospect: { type: "string", description: "An existing prospect (id, name or site) to refresh" } },
    additionalProperties: false,
  },
  only: worksSales,
  run: async (user: Staff, input, chat) => {
    if (!worksSales(user)) return NOT_SALES;
    const v = viewing(user);
    if (v) return v;
    const existing = await prospectFrom(input);
    const { researchProspect } = await import("@/lib/sales-agent");
    const r = await researchProspect(await createClient(), createAdminClient(), user, { name: str(input.name), website: str(input.website), location: str(input.location), question: str(input.question), prospectId: existing?.id ?? null });
    if (!r.ok) return r;
    const b = cleanBrief(r.prospect.brief);
    chat?.card({ type: "link", title: `Prospect: ${r.prospect.name}`, detail: `Fit ${b.fit_score ?? "?"}/100 · ${b.gaps.length} gaps · ${b.strategy.services.length} services`, href: pageOf(r.prospect.id), cta: "Open the prospect" });
    return { ok: true, prospect_id: r.prospect.id, name: r.prospect.name, website: r.prospect.website, stage: r.prospect.status, fit_score: b.fit_score, brief: r.text, page: pageOf(r.prospect.id), next: "Offer the pitch drafts (draft_pitch) or a proposal (make_document with prospect: the name)." };
  },
};

const find: AiTool = {
  name: "find_prospects",
  description:
    "Executives and leads: the Sales agent builds a prospect list: businesses matching a profile (industry, area, size signals, a condition like \"running no ads\"), found from public web sources, each with its site, location, the signals seen and a fit score 0-100, best first. New ones are added to Sales › Prospects as \"new\" (save: false to only show them). count: 3 to 15 (default 8). Takes one to two minutes: say so first.",
  input_schema: { type: "object", properties: { profile: { type: "string", description: "e.g. med spas in Tampa running no ads" }, count: { type: "number" }, save: { type: "boolean" } }, required: ["profile"], additionalProperties: false },
  only: worksSales,
  run: async (user: Staff, input, chat) => {
    if (!worksSales(user)) return NOT_SALES;
    const v = viewing(user);
    if (v) return v;
    const { buildProspectList } = await import("@/lib/sales-agent");
    const r = await buildProspectList(await createClient(), createAdminClient(), user, { profile: str(input.profile) ?? "", count: num(input.count), save: input.save !== false });
    if (!r.ok) return r;
    chat?.card({ type: "list", title: `Prospects: ${str(input.profile)}`, items: r.prospects.map((p) => ({ title: `${p.name}${p.fit_score != null ? ` · ${p.fit_score}` : ""}`, detail: [p.location, p.signals].filter(Boolean).join(" · "), ...(p.id ? { href: pageOf(p.id) } : {}) })) });
    return { ok: true, added: r.added, prospects: r.prospects, page: "/sales", next: "Offer to research the best fits (research_prospect)." };
  },
};

const mine: AiTool = {
  name: "my_prospects",
  description: "Executives and leads: the sales pipeline (Sales › Prospects): the person's own prospects by default (everyone's with all: true), optionally one stage (new, researched, contacted, call_booked, talking, proposal, won, lost) or open only. Archived prospects are left out; archived: true lists only them (the archive log: why, who, when). Each with stage, fit, owner, last update and its page.",
  input_schema: { type: "object", properties: { all: { type: "boolean" }, stage: { type: "string" }, open: { type: "boolean" }, archived: { type: "boolean" } }, additionalProperties: false },
  only: worksSales,
  run: async (user: Staff, input) => {
    if (!worksSales(user)) return NOT_SALES;
    const db = await createClient();
    let q = db.from("prospects").select("id, name, website, industry, location, status, fit_score, owner_id, updated_at, archived_at, archive_reason, archive_note, profiles:owner_id(full_name)").order("updated_at", { ascending: false }).limit(60);
    if (input.all !== true) q = q.eq("owner_id", user.id);
    q = input.archived === true ? q.not("archived_at", "is", null) : q.is("archived_at", null);
    if (isProspectStatus(input.stage)) q = q.eq("status", input.stage);
    else if (input.open === true) q = q.in("status", [...OPEN_STATUSES]);
    const { data, error } = await q;
    if (error) return { ok: false, error: error.message };
    const rows = (data ?? []).map((p) => ({ id: p.id, name: p.name, website: p.website, industry: p.industry, location: p.location, stage: STATUS_LABEL[p.status as keyof typeof STATUS_LABEL] ?? p.status, fit: p.fit_score, fit_band: fitBand(p.fit_score as number | null), owner: (p.profiles as unknown as { full_name: string } | null)?.full_name ?? null, updated: String(p.updated_at).slice(0, 10), ...(p.archived_at ? { archived: `${String(p.archived_at).slice(0, 10)}: ${archiveText(p.archive_reason as string | null, p.archive_note as string | null)}` } : {}), page: pageOf(p.id as string) }));
    return { ok: true, count: rows.length, prospects: rows, page: "/sales" };
  },
};

const details: AiTool = {
  name: "prospect_details",
  description: "Executives and leads: one prospect's saved work: its research brief and sales strategy, contacts found, stage, owner, notes, and the latest pitch drafts and call reviews.",
  input_schema: { type: "object", properties: { prospect: { type: "string", description: "Its name, site or id" } }, required: ["prospect"], additionalProperties: false },
  only: worksSales,
  run: async (user: Staff, input) => {
    if (!worksSales(user)) return NOT_SALES;
    const p = await prospectFrom(input);
    if (!p) return { ok: false, error: "No prospect by that name. my_prospects lists them." };
    const db = await createClient();
    const { data: notes } = await db.from("prospect_notes").select("kind, title, body, created_at").eq("prospect_id", p.id).neq("kind", "research").order("created_at", { ascending: false }).limit(6);
    return { ok: true, id: p.id, name: p.name, website: p.website, stage: p.status, ...(p.archived_at ? { archived: `${p.archived_at.slice(0, 10)}: ${archiveText(p.archive_reason, p.archive_note)} (out of the pipeline; unarchive_prospect puts it back)` } : {}), fit_score: p.fit_score, owner_id: p.owner_id, notes: p.notes, contacts: p.contacts, brief: p.brief ? briefText(p.name, cleanBrief(p.brief)) : "Not researched yet (research_prospect).", work: (notes ?? []).map((n) => ({ kind: n.kind, title: n.title, at: String(n.created_at).slice(0, 10), body: n.body })), page: pageOf(p.id) };
  },
};

const save: AiTool = {
  name: "save_prospect",
  description: "Executives and leads: adds a prospect by hand (name, website, location, industry, notes) or changes one (prospect: its name, site or id): stage (new, researched, contacted, call_booked, talking, proposal, won, lost; lost_reason with lost), owner (a teammate's name, or \"me\"), notes, details. For won, prospect_won links the client too.",
  input_schema: {
    type: "object",
    properties: {
      prospect: { type: "string" },
      name: { type: "string" },
      website: { type: "string" },
      location: { type: "string" },
      industry: { type: "string" },
      stage: { type: "string", enum: ["new", "researched", "contacted", "call_booked", "talking", "proposal", "won", "lost"] },
      owner: { type: "string" },
      notes: { type: "string" },
      lost_reason: { type: "string" },
    },
    additionalProperties: false,
  },
  only: worksSales,
  run: async (user: Staff, input) => {
    if (!worksSales(user)) return NOT_SALES;
    const v = viewing(user);
    if (v) return v;
    const db = await createClient();
    let ownerId: string | undefined;
    const owner = str(input.owner);
    if (owner) {
      if (/^(me|myself|mine)$/i.test(owner)) ownerId = user.id;
      else {
        const { data: people } = await db.from("profiles").select("id, full_name").eq("is_active", true).ilike("full_name", `%${owner.replace(/[%_]/g, "")}%`).limit(3);
        if ((people ?? []).length !== 1) return { ok: false, error: (people ?? []).length ? `Which one: ${(people ?? []).map((x) => x.full_name).join(", ")}?` : `No one on the team is named ${owner}.` };
        ownerId = people![0].id as string;
      }
    }
    const { updateProspect } = await import("@/lib/sales-agent");
    const p = str(input.prospect) ? await prospectFrom(input) : null;
    if (str(input.prospect) && !p) return { ok: false, error: "No prospect by that name. my_prospects lists them." };
    if (!p) {
      const { cleanSite } = await import("@/lib/sales-core");
      const name = str(input.name);
      if (!name) return { ok: false, error: "A new prospect needs a name." };
      const { data, error } = await db
        .from("prospects")
        .insert({ name: name.slice(0, 160), website: cleanSite(input.website), location: str(input.location), industry: str(input.industry), notes: str(input.notes), status: isProspectStatus(input.stage) ? input.stage : "new", owner_id: ownerId ?? user.id, created_by: user.id, source: "added" })
        .select("id, name")
        .single();
      if (error) return { ok: false, error: /prospects_site/.test(error.message) ? "A prospect with that website is already in the pipeline." : error.message };
      return { ok: true, added: true, id: data.id, name: data.name, page: pageOf(data.id as string), next: "Offer to research it (research_prospect)." };
    }
    const r = await updateProspect(db, p.id, { status: input.stage, owner_id: ownerId, notes: input.notes, lost_reason: input.lost_reason, name: input.name, website: input.website, location: input.location, industry: input.industry });
    if (!r.ok) return r;
    return { ok: true, id: r.prospect.id, name: r.prospect.name, stage: r.prospect.status, page: pageOf(r.prospect.id), ...(r.prospect.status === "won" ? { next: "Run prospect_won to link the enrolled client and move its documents." } : {}) };
  },
};

const pitch: AiTool = {
  name: "draft_pitch",
  description: "Executives and leads: the Sales agent drafts first outreach for one prospect in Kaizen's voice, from its research: a call script (opener, discovery questions, the angle, the ask, answers to likely objections), an email (subject + body), and a LinkedIn connection note and follow-up message. All drafts: the person sends them themselves (nothing on LinkedIn is automated; email via draft_message/save_draft if they want it in Gmail). focus: anything to lean on (a service, an offer, a tone). Saved on the prospect.",
  input_schema: { type: "object", properties: { prospect: { type: "string" }, focus: { type: "string" } }, required: ["prospect"], additionalProperties: false },
  only: worksSales,
  run: async (user: Staff, input, chat) => {
    if (!worksSales(user)) return NOT_SALES;
    const v = viewing(user);
    if (v) return v;
    const p = await prospectFrom(input);
    if (!p) return { ok: false, error: "No prospect by that name. Research it first (research_prospect) or add it (save_prospect)." };
    const { draftPitch } = await import("@/lib/sales-agent");
    const r = await draftPitch(await createClient(), createAdminClient(), user, p, { focus: str(input.focus) });
    chat?.card({ type: "link", title: `Pitch drafts: ${p.name}`, detail: "Call script, email and LinkedIn note", href: `${pageOf(p.id)}?tab=drafts`, cta: "Open the drafts" });
    return { ok: true, prospect: p.name, drafts: r.drafts, page: `${pageOf(p.id)}?tab=drafts`, note: p.brief ? undefined : "It wasn't researched yet, so the drafts are general: research_prospect makes them specific." };
  },
};

const review: AiTool = {
  name: "review_sales_call",
  description: "Executives and leads: the Sales agent reviews a sales call: what went well, what to do better, the objections and better answers, next steps with who and when, and whether to send a proposal (services from the rate card). The call from: transcript (pasted text), doc (a Google Doc link, e.g. the meeting's Gemini notes or transcript), or a transcript or text file attached in this chat (read automatically). prospect: who it was with, to keep it on the prospect and move its stage forward. Takes about a minute.",
  input_schema: { type: "object", properties: { prospect: { type: "string" }, transcript: { type: "string" }, doc: { type: "string" } }, additionalProperties: false },
  only: worksSales,
  run: async (user: Staff, input, chat) => {
    if (!worksSales(user)) return NOT_SALES;
    const v = viewing(user);
    if (v) return v;
    let text = str(input.transcript) ?? "";
    let source: string | null = null;
    const doc = str(input.doc);
    if (!text && doc) {
      const { readGoogleFile } = await import("@/lib/assistant/read-file");
      const f = await readGoogleFile(user.email, doc);
      if (!f.ok) return { ok: false, error: f.say };
      text = f.text;
      source = f.title;
    }
    if (!text && chat?.files.length) {
      const readable = chat.files.filter((f) => f.kind === "doc" || f.kind === "text");
      if (readable.length) {
        const { attachmentBlocks } = await import("@/lib/kaizen-ai/files");
        const { blocks } = await attachmentBlocks(createAdminClient(), readable.map((f) => ({ ...f, bytes: 0 })) as never, true);
        text = blocks.map((b) => ((b as { type: string; text?: string }).type === "text" ? ((b as { text?: string }).text ?? "") : "")).join("\n");
        source = readable.map((f) => f.name).join(", ");
      }
    }
    if (!text) return { ok: false, error: "I need the call: paste the transcript, attach it, or give its Google Doc link (the meeting's Gemini notes or transcript)." };
    const p = await prospectFrom(input);
    if (str(input.prospect) && !p) return { ok: false, error: "No prospect by that name; add it (save_prospect) or leave prospect out." };
    const { reviewSalesCall } = await import("@/lib/sales-agent");
    const r = await reviewSalesCall(await createClient(), createAdminClient(), user, { transcript: text, prospect: p, source });
    if (!r.ok) return r;
    if (p) chat?.card({ type: "link", title: `Call review: ${p.name}`, detail: `${r.review.next_steps.length} next steps${r.review.proposal.send ? " · send a proposal" : ""}`, href: `${pageOf(p.id)}?tab=drafts`, cta: "Open the drafts" });
    return { ok: true, prospect: p?.name ?? null, review: r.review, ...(r.stage ? { moved_to: r.stage } : {}), ...(r.review.proposal.send ? { next: "Offer the proposal: make_document template proposal with prospect: the name, the services and what was said in brief." } : {}) };
  },
};

const won: AiTool = {
  name: "prospect_won",
  description: "Executives and leads: a prospect is won. Marks it won and links the client once they're enrolled (Kaizen Track's enrollment creates the client and starts onboarding; client: the client's name if it differs). Lists the prospect's Kaizen documents (proposal, SOW) with their document_id: move each into the client's Headquarters with move_document (it says the folder back for a yes first). If the client isn't enrolled yet, say so: it links on its own once they are, and the owner gets a notice.",
  input_schema: { type: "object", properties: { prospect: { type: "string" }, client: { type: "string" } }, required: ["prospect"], additionalProperties: false },
  only: worksSales,
  run: async (user: Staff, input) => {
    if (!worksSales(user)) return NOT_SALES;
    const v = viewing(user);
    if (v) return v;
    const p = await prospectFrom(input);
    if (!p) return { ok: false, error: "No prospect by that name. my_prospects lists them." };
    const db = await createClient();
    const { updateProspect, linkWonProspect } = await import("@/lib/sales-agent");
    if (p.status !== "won") {
      const r = await updateProspect(db, p.id, { status: "won" });
      if (!r.ok) return r;
    }
    const r = await linkWonProspect(db, createAdminClient(), { ...p, status: "won" }, str(input.client));
    return {
      ok: true,
      prospect: p.name,
      client: r.client ? { name: r.client.name, page: `/clients/${r.client.slug}` } : null,
      documents: r.documents.map((d) => ({ document_id: d.id, title: d.title, link: d.link, folder: d.folder })),
      say: r.client
        ? `${p.name} is won and linked to ${r.client.name}.${r.documents.length ? ` ${r.documents.length} document${r.documents.length === 1 ? "" : "s"} can move from Kaizen Sales › Prospects to its Headquarters.` : ""}`
        : `${p.name} is marked won. It isn't enrolled as a client yet: enrolling them in Kaizen Track creates the client and starts onboarding; it links here on its own then.`,
      next: r.client && r.documents.length ? "Offer to move the documents: move_document with each document_id (it confirms the folder first)." : undefined,
    };
  },
};

// ─── Sales call briefs (src/lib/sales-briefs.ts) ───────────────────────────

const myBriefs: AiTool = {
  name: "my_sales_briefs",
  description: "The sales calls this person runs in the next few days (from their Google Calendar: meetings with people outside Kaizen who aren't clients) and each one's brief from the Sales agent: who they are, what they said they want, fit, the Kaizen services that match, likely objections, the questions to ask and the next step. Execs and leads can ask for everyone's (all: true). Briefs are written 18 hours before each call.",
  input_schema: { type: "object", properties: { all: { type: "boolean" } }, additionalProperties: false },
  run: async (user: Staff, input) => {
    const db = await createClient();
    let q = db.from("sales_call_briefs").select("id, title, starts_at, status, brief, owner_id, prospect_id").in("status", ["pending", "ready", "failed"]).gt("starts_at", new Date().toISOString()).order("starts_at").limit(20);
    if (!(input.all === true && worksSales(user))) q = q.eq("owner_id", user.id);
    const { data, error } = await q;
    if (error) return { ok: false, error: error.message };
    const { callBriefText, cleanCallBrief, whenLabel } = await import("@/lib/sales-briefs-core");
    return {
      ok: true,
      calls: (data ?? []).map((r) => {
        const b = r.brief as (Parameters<typeof cleanCallBrief>[0] & { business?: string }) | null;
        const business = (b as { business?: string } | null)?.business ?? r.title;
        return { business, title: r.title, when: whenLabel(r.starts_at as string), status: r.status === "ready" ? "brief ready" : r.status === "failed" ? "brief failed" : "brief comes 18h before", brief: b ? callBriefText(business, whenLabel(r.starts_at as string), cleanCallBrief(b, { booking: (b as { booking?: { q: string; a: string }[] }).booking })) : null, page: briefHref(r.id as string, user.isExec) };
      }),
    };
  },
};

const saveToBrief: AiTool = {
  name: "save_to_brief",
  description: "Executives and leads: saves what came out of the conversation onto the prospect's sales call brief (its latest one) so it's there before and after the call: section pitch_ideas (angles and talking points), discovery_questions, watch_outs, or proof; or findings (new facts found, saved on the prospect as a note). lines: each one short. With no call booked, everything is saved on the prospect as a note.",
  input_schema: { type: "object", properties: { prospect: { type: "string" }, section: { type: "string", enum: ["pitch_ideas", "discovery_questions", "watch_outs", "proof", "findings"] }, lines: { type: "array", items: { type: "string" } } }, required: ["prospect", "section", "lines"], additionalProperties: false },
  only: worksSales,
  run: async (user: Staff, input) => {
    if (!worksSales(user)) return NOT_SALES;
    const v = viewing(user);
    if (v) return v;
    const p = await prospectFrom(input);
    if (!p) return { ok: false, error: "No prospect by that name. my_prospects lists them." };
    const lines = (Array.isArray(input.lines) ? input.lines : []).map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 12);
    if (!lines.length) return { ok: false, error: "What should I save?" };
    const db = await createClient();
    const { BRIEF_SECTIONS, addToBrief, cleanCallBrief } = await import("@/lib/sales-briefs-core");
    const section = String(input.section);
    const { data: b } = await db.from("sales_call_briefs").select("id, brief").eq("prospect_id", p.id).not("brief", "is", null).order("starts_at", { ascending: false }).limit(1).maybeSingle();
    if (b && (BRIEF_SECTIONS as readonly string[]).includes(section)) {
      const cur = b.brief as Record<string, unknown>;
      const next = { ...cur, ...addToBrief(cleanCallBrief(cur, { booking: cur.booking as { q: string; a: string }[] | undefined, in_motion: (cur.in_motion as string | null) ?? null }), section as (typeof BRIEF_SECTIONS)[number], lines) };
      const { error } = await db.from("sales_call_briefs").update({ brief: next, updated_at: new Date().toISOString() }).eq("id", b.id);
      if (error) return { ok: false, error: error.message };
      return { ok: true, saved: lines.length, where: `the call brief (${section.replace(/_/g, " ")})`, page: `/sales/briefs/${b.id}` };
    }
    const { error } = await db.from("prospect_notes").insert({ prospect_id: p.id, kind: "note", title: section === "findings" ? "Found in a conversation" : `Saved: ${section.replace(/_/g, " ")}`, body: { lines, section }, created_by: user.id });
    if (error) return { ok: false, error: error.message };
    return { ok: true, saved: lines.length, where: "the prospect's notes", page: pageOf(p.id) };
  },
};

const scanBriefs: AiTool = {
  name: "refresh_sales_briefs",
  description: "Executives and leads: reads the team's calendars now for upcoming sales calls (outside Kaizen, not a client) and lists each with who runs it and whether its brief is due; write: true also writes the briefs that are due now (each takes a minute or two). Normally this runs on its own every half hour.",
  input_schema: { type: "object", properties: { write: { type: "boolean" } }, additionalProperties: false },
  only: worksSales,
  run: async (user: Staff, input) => {
    if (!worksSales(user)) return NOT_SALES;
    const { runSalesBriefs } = await import("@/lib/sales-briefs");
    return runSalesBriefs(createAdminClient(), { dryRun: input.write !== true, max: 2, budgetMs: 200_000 });
  },
};

// The Sales pages are the executives' only for now: for anyone else (leads use every tool through their assistant) the
// results and cards leave out links into /sales, and a call brief points at its item on their Overview
const SALES_PAGE = /^\/sales(?:\/|\?|$)/;
function withoutSalesPages(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutSalesPages);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k, x]) => !((k === "page" || k === "href") && typeof x === "string" && SALES_PAGE.test(x))).map(([k, x]) => [k, withoutSalesPages(x)]));
}
const execPagesOnly = (t: AiTool): AiTool => ({
  ...t,
  run: async (user, input, chat) => {
    if (user.isExec) return t.run(user, input, chat);
    const card = chat ? (c: Record<string, unknown> & { type: string }) => (c.type === "link" && typeof c.href === "string" && SALES_PAGE.test(c.href) ? undefined : chat.card(withoutSalesPages(c) as typeof c)) : undefined;
    return withoutSalesPages(await t.run(user, input, chat && card ? { ...chat, card } : chat));
  },
});

const archive: AiTool = {
  name: "archive_prospect",
  description: "Executives and leads: archives a prospect (never deleted): it leaves the pipeline and its upcoming call briefs, items and follow-ups stop. Needs the reason: not_a_fit, no_budget, went_elsewhere, no_response, duplicate, not_real, or other with a note. If they didn't say why, ask once (offer those reasons) before calling. \"Lost\" is different: a deal that got to a decision and was lost is save_prospect stage lost. Undo with unarchive_prospect.",
  input_schema: { type: "object", properties: { prospect: { type: "string" }, reason: { type: "string", enum: ["not_a_fit", "no_budget", "went_elsewhere", "no_response", "duplicate", "not_real", "other"] }, note: { type: "string" } }, required: ["prospect", "reason"], additionalProperties: false },
  only: worksSales,
  run: async (user: Staff, input) => {
    if (!worksSales(user)) return NOT_SALES;
    const v = viewing(user);
    if (v) return v;
    const p = await prospectFrom(input);
    if (!p) return { ok: false, error: "No prospect by that name. my_prospects lists them." };
    const { archiveProspect } = await import("@/lib/sales-agent");
    const r = await archiveProspect(await createClient(), createAdminClient(), user, p.id, input.reason, input.note);
    if (!r.ok) return r;
    return { ok: true, archived: p.name, reason: archiveText(r.prospect.archive_reason, r.prospect.archive_note), stopped_briefs: r.stopped, kept_stage: r.prospect.status, say: `${p.name} is archived (${archiveText(r.prospect.archive_reason, r.prospect.archive_note)}). It's out of the pipeline; unarchiving puts it back at ${r.prospect.status.replace("_", " ")}.` };
  },
};

const unarchive: AiTool = {
  name: "unarchive_prospect",
  description: "Executives and leads: puts an archived prospect back into the pipeline at the stage it had (its upcoming call briefs pick up again).",
  input_schema: { type: "object", properties: { prospect: { type: "string" } }, required: ["prospect"], additionalProperties: false },
  only: worksSales,
  run: async (user: Staff, input) => {
    if (!worksSales(user)) return NOT_SALES;
    const v = viewing(user);
    if (v) return v;
    const p = await prospectFrom(input);
    if (!p) return { ok: false, error: "No prospect by that name. my_prospects with archived: true lists the archived ones." };
    const { unarchiveProspect } = await import("@/lib/sales-agent");
    const r = await unarchiveProspect(await createClient(), createAdminClient(), user, p.id);
    if (!r.ok) return r;
    return { ok: true, restored: p.name, stage: r.prospect.status, page: pageOf(p.id) };
  },
};

export const tools: AiTool[] = [webResearch, research, find, mine, details, save, pitch, review, won, myBriefs, saveToBrief, scanBriefs, archive, unarchive].map(execPagesOnly);
