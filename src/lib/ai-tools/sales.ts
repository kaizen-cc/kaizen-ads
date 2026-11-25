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
    "Executives and leads: starts a prospect search in the background: businesses matching a profile (industry, area, size signals, a condition like \"running no ads\"), found from public web sources, each site checked, scored 0-100 by fit, and new ones added to the pipeline as \"new\". It takes a few minutes and doesn't need them to wait: say you've started it and that they'll get a notification (and an Overview item) when it's done. count: how many to find, 3 to 25 (default 10). prospect_search_status checks on it.",
  input_schema: { type: "object", properties: { profile: { type: "string", description: "e.g. med spas in Tampa running no ads" }, count: { type: "number" } }, required: ["profile"], additionalProperties: false },
  only: worksSales,
  run: async (user: Staff, input) => {
    if (!worksSales(user)) return NOT_SALES;
    const v = viewing(user);
    if (v) return v;
    const profile = str(input.profile);
    if (!profile) return { ok: false, error: "What kind of business, and where? (e.g. med spas in Tampa running no ads)" };
    const { queueProspectSearch, runProspectSearch } = await import("@/lib/prospect-search");
    const admin = createAdminClient();
    const q = await queueProspectSearch(admin, { profileId: user.id, profile, want: num(input.count), via: "assistant" });
    if (!q.existing) {
      const { after } = await import("next/server");
      after(() => runProspectSearch(createAdminClient(), q.id).then(() => undefined));
    }
    const { searchHref } = await import("@/lib/prospect-search-core");
    return { ok: true, started: !q.existing, already_running: q.existing, search_id: q.id, page: searchHref(q.id, user.isExec), say: `${q.existing ? "That search is already running" : "I've started the search"}. It takes a few minutes; I'll let you know when it's done, and it'll be on your Overview to review.` };
  },
};

const searchStatus: AiTool = {
  name: "prospect_search_status",
  description: "Executives and leads: how a prospect search is going (their latest, or search_id): the stage (searching sources, checking sites, scoring fit, saving), the percentage, how many businesses found so far, and when done the businesses found with their fit. cancel: true stops it.",
  input_schema: { type: "object", properties: { search_id: { type: "string" }, cancel: { type: "boolean" } }, additionalProperties: false },
  only: worksSales,
  run: async (user: Staff, input) => {
    if (!worksSales(user)) return NOT_SALES;
    const db = await createClient();
    const { SEARCH_COLS, searchView } = await import("@/lib/prospect-search");
    const { STAGE_LABEL, progressOf } = await import("@/lib/prospect-search-core");
    const id = str(input.search_id);
    let q = db.from("prospect_searches").select(SEARCH_COLS).eq("profile_id", user.id).order("created_at", { ascending: false }).limit(1);
    if (id && /^[0-9a-f-]{36}$/i.test(id)) q = db.from("prospect_searches").select(SEARCH_COLS).eq("id", id).limit(1);
    const { data } = await q.maybeSingle();
    if (!data) return { ok: false, error: "No prospect search found. find_prospects starts one." };
    const s = searchView(data as Record<string, unknown>);
    if (input.cancel === true && (s.status === "queued" || s.status === "running")) {
      await db.from("prospect_searches").update({ cancel: true }).eq("id", s.id);
      return { ok: true, cancelling: true, profile: s.profile };
    }
    const pct = progressOf({ status: s.status as never, stage: s.stage, stageAt: s.stageAt, saved: s.progress });
    return { ok: true, profile: s.profile, status: s.status, stage: s.stage ? STAGE_LABEL[s.stage] : null, percent: Math.max(pct, s.progress), found_so_far: s.found, added: s.added, ...(s.status === "done" ? { businesses: s.results.map((r) => ({ name: r.name, website: r.website, location: r.location, fit: r.fit_score, why: r.fit_reason, already_in_pipeline: r.already })) } : {}), ...(s.error ? { error: s.error } : {}) };
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
      relationship: { type: "string", enum: ["direct", "white_label"], description: "A direct Kaizen deal, or a white-label pitch for a partner agency (with partner)" },
      partner: { type: "string" },
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
    let partnerKey: string | null | undefined;
    if (str(input.partner)) {
      const { partnerNamed } = await import("@/lib/sales-gtm");
      const pt = await partnerNamed(createAdminClient(), str(input.partner));
      if (!pt) return { ok: false, error: `${str(input.partner)} isn't a partner on file: partner_kit adds it.` };
      partnerKey = pt.key;
    }
    const r = await updateProspect(db, p.id, { status: input.stage, owner_id: ownerId, notes: input.notes, lost_reason: input.lost_reason, name: input.name, website: input.website, location: input.location, industry: input.industry, relationship: input.relationship ?? (partnerKey ? "white_label" : undefined), partner_key: partnerKey });
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

// ─── Go-to-market strategy and proposal (src/lib/sales-gtm.ts) ─────────────

const makeGtm: AiTool = {
  name: "make_gtm",
  description:
    "Executives and leads: builds a prospect's go-to-market strategy in the background (several minutes): a client-facing branded PDF (cover, exec summary with 3 stat tiles, who they are, digital footprint leaks, the market and competitive landscape, positioning and front-door offer, channel plan, investment tiers with projections and sourced benchmarks, 90-day plan and 12-month calendar, measurement and next steps, sources) plus internal talking notes that are never sent (every claim tagged certain / likely / guessing). Branding follows the prospect's relationship: direct (Kaizen's brand, prepared by the CEO) or white_label (a partner agency's brand kit, zero Kaizen mentions, ad spend only, notes written for the partner). If the record doesn't say and it can't be detected, the result asks the question: ask it once, then call again with relationship (and partner for white label); it's stored on the prospect so the notes and proposal follow it. ask: anything they said (channels, the creative package, who it's for). Say you've started it and they'll be notified; the proposal is separate (proposal_brief).",
  input_schema: { type: "object", properties: { prospect: { type: "string" }, relationship: { type: "string", enum: ["direct", "white_label"] }, partner: { type: "string", description: "The partner agency for a white-label pitch, e.g. ZenChange" }, ask: { type: "string" } }, required: ["prospect"], additionalProperties: false },
  only: worksSales,
  run: async (user: Staff, input) => {
    if (!worksSales(user)) return NOT_SALES;
    const v = viewing(user);
    if (v) return v;
    const p = await prospectFrom(input);
    if (!p) return { ok: false, error: "No prospect by that name. Research it first (research_prospect) or add it (save_prospect)." };
    const admin = createAdminClient();
    const { queueGtm, partnerNamed, relationshipOf } = await import("@/lib/sales-gtm");
    const { RELATIONSHIP_QUESTION, modeLabel } = await import("@/lib/sales-gtm-core");
    // The relationship: what they said now, else what the record shows (set, or a partner credited on their site), else ask once
    let rel: { relationship: "direct" | "white_label"; partner: import("@/lib/sales-gtm-core").Partner | null } | null = null;
    if (input.relationship === "direct") rel = { relationship: "direct", partner: null };
    else if (input.relationship === "white_label" || str(input.partner)) {
      const partner = await partnerNamed(admin, str(input.partner));
      if (!partner) return { ok: false, needs: "partner", say: str(input.partner) ? `${str(input.partner)} isn't a partner on file yet: partner_kit can add it (its brand kit, confirmed once).` : "Which partner agency is it for?" };
      rel = { relationship: "white_label", partner };
    } else {
      const found = await relationshipOf(admin, p);
      if (!found) return { ok: false, needs: "relationship", ask: RELATIONSHIP_QUESTION, note: "Ask exactly that once; call again with relationship (and partner for white label)." };
      rel = found;
    }
    await (await createClient()).from("prospects").update({ relationship: rel.relationship, partner_key: rel.partner?.key ?? null, updated_at: new Date().toISOString() }).eq("id", p.id);
    if (rel.partner && !rel.partner.kit_confirmed_at) return { ok: false, needs: "partner_kit", say: `${rel.partner.name}'s brand kit isn't confirmed yet. partner_kit pulls it from their site for a yes first; the GTM is built in their brand after that.` };
    const q = await queueGtm(admin, { prospectId: p.id, profileId: user.id, partnerKey: rel.partner?.key ?? null, ask: str(input.ask) });
    return { ok: true, started: !q.existing, already_running: q.existing, gtm_id: q.id, mode: modeLabel(rel.relationship, rel.partner?.name), say: `${q.existing ? "A go-to-market strategy for them is already being built" : `I've started the go-to-market strategy (${modeLabel(rel.relationship, rel.partner?.name)})`}. It takes several minutes; you'll get a notification when it's ready.` };
  },
};

const partnerKit: AiTool = {
  name: "partner_kit",
  description: "Executives and leads: a white-label partner agency's brand kit, kept once and reused on every GTM for them (logo, colors, fonts, the 'Prepared by' name and contact). Without confirm: shows what's on file, or pulls the logo and main color from the partner's website (website) as a proposal; say it back and ask. confirm: true saves it (with any corrections: prepared_by, contact_name, contact_role, contact_email, accent, dark). Adding a new partner: name + website. Never guess silently: always confirm before it's used.",
  input_schema: { type: "object", properties: { partner: { type: "string" }, website: { type: "string" }, prepared_by: { type: "string" }, contact_name: { type: "string" }, contact_role: { type: "string" }, contact_email: { type: "string" }, accent: { type: "string" }, dark: { type: "string" }, confirm: { type: "boolean" } }, required: ["partner"], additionalProperties: false },
  only: worksSales,
  run: async (user: Staff, input) => {
    if (!worksSales(user)) return NOT_SALES;
    const v = viewing(user);
    if (v) return v;
    const admin = createAdminClient();
    const { partnerNamed } = await import("@/lib/sales-gtm");
    const name = str(input.partner)!;
    const existing = await partnerNamed(admin, name);
    const website = str(input.website) ?? existing?.website ?? null;
    let logo = existing?.brand?.logo ?? null;
    let color: string | null = null;
    if (!logo && website) {
      const { logoFromWebsite } = await import("@/lib/reports/brand-server");
      const got = await logoFromWebsite(website, name).catch(() => null);
      logo = got?.logo ?? null;
      color = got?.color ?? null;
    }
    const hex = (x: unknown) => (typeof x === "string" && /^#[0-9a-f]{6}$/i.test(x.trim()) ? x.trim() : null);
    const brand = { ...(existing?.brand ?? {}), ...(logo ? { logo } : {}), ...(hex(input.accent) ?? color ? { accent: (hex(input.accent) ?? color)! } : {}), ...(hex(input.dark) ? { dark: hex(input.dark)! } : {}) };
    const contact = { ...(existing?.contact ?? {}), ...(str(input.contact_name) ? { name: str(input.contact_name)! } : {}), ...(str(input.contact_role) ? { role: str(input.contact_role)! } : {}), ...(str(input.contact_email) ? { email: str(input.contact_email)! } : {}) };
    const preparedBy = str(input.prepared_by) ?? existing?.prepared_by ?? `${name} Marketing`;
    const summary = { partner: existing?.name ?? name, prepared_by: preparedBy, contact, website, logo_found: Boolean(logo), colors: { accent: brand.accent ?? null, dark: brand.dark ?? null }, confirmed: Boolean(existing?.kit_confirmed_at) };
    if (input.confirm !== true) return { ok: true, proposed: summary, say: `${summary.partner}'s kit: prepared by "${preparedBy}"${contact.name ? `, contact ${contact.name}` : ""}, ${logo ? "logo found" : "no logo (their name in text)"}${brand.accent ? `, accent ${brand.accent}` : ""}. Use it?`, note: "Say it back and ask; call again with confirm: true (and any corrections)." };
    const key = existing?.key ?? name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);
    const row = { key, name: existing?.name ?? name, prepared_by: preparedBy, brand, contact, website, kit_confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...(existing ? {} : { rules: "White-label partner: their branding only, zero Kaizen mentions, ad spend only unless told otherwise; internal notes rewritten for the partner.", show_fees: false }) };
    const { error } = await admin.from("sales_partners").upsert(row, { onConflict: "key" });
    if (error) return { ok: false, error: error.message };
    return { ok: true, saved: row.name, say: `${row.name}'s brand kit is saved; every white-label GTM for them uses it.` };
  },
};

const gtmStatus: AiTool = {
  name: "gtm_status",
  description: "Executives and leads: a prospect's go-to-market strategy: how it's going (researching, writing, notes, drawing the PDF) or, when ready, its document_id (give it to upload_to_drive to save it in Drive under the Drive rule, or to draft_message to email the PDF), the strategy's key points, and the internal talking notes (never sent).",
  input_schema: { type: "object", properties: { prospect: { type: "string" } }, required: ["prospect"], additionalProperties: false },
  only: worksSales,
  run: async (user: Staff, input) => {
    if (!worksSales(user)) return NOT_SALES;
    const p = await prospectFrom(input);
    if (!p) return { ok: false, error: "No prospect by that name." };
    const db = await createClient();
    const { data: g } = await db.from("prospect_gtms").select("id, status, stage, content, notes, document_id, partner_key, error, created_at").eq("prospect_id", p.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!g) return { ok: false, error: "No go-to-market strategy yet. make_gtm starts one." };
    if (g.status !== "done") return { ok: true, status: g.status, stage: g.stage, ...(g.error ? { error: g.error } : {}) };
    const { cleanGtm, cleanNotes, notesText } = await import("@/lib/sales-gtm-core");
    const c = cleanGtm(g.content);
    return {
      ok: true,
      status: "done",
      document_id: g.document_id,
      partner: g.partner_key,
      headline: `${c.cover.headline} ${c.cover.highlight}`.trim(),
      recommend: c.exec.recommend,
      offer: c.positioning.offer,
      tiers: c.investment.tiers,
      internal_notes: notesText(p.name, cleanNotes(g.notes, null)),
      note: "The talking notes are internal: never paste them into anything the prospect sees.",
    };
  },
};

const proposalBrief: AiTool = {
  name: "proposal_brief",
  description:
    "Executives and leads: everything the proposal needs for one prospect, compiled for make_document (template proposal, prospect: the name): the CEO's 11-slide rules, the best-matching case study plus supporting ones with exact numbers, the proposed services at exact prices, the terms (the 60/90-day minimum and the 30-day written notice together), the research, the go-to-market strategy's recommendations and the call reviews. services: what's being proposed (\"Meta + Google + Email/SMS, Silver creative\"); game_plan: how it will be delivered (required: ask if missing); transcript: the meeting notes or transcript if they have them. Pass the returned brief to make_document as its brief.",
  input_schema: { type: "object", properties: { prospect: { type: "string" }, services: { type: "string" }, game_plan: { type: "string" }, transcript: { type: "string" } }, required: ["prospect", "services"], additionalProperties: false },
  only: worksSales,
  run: async (user: Staff, input) => {
    if (!worksSales(user)) return NOT_SALES;
    const p = await prospectFrom(input);
    if (!p) return { ok: false, error: "No prospect by that name." };
    if (!str(input.game_plan)) return { ok: false, needs: "game_plan", say: "What's the game plan: how will we deliver it (the first 30/60/90 days)? The proposal is built around it." };
    const db = await createClient();
    const admin = createAdminClient();
    const [{ data: studies }, { data: g }, { data: reviews }, { rateCardText }] = await Promise.all([
      admin.from("sales_case_studies").select("key, name, vertical, fits, services, results, connection").eq("active", true).order("sort_order"),
      db.from("prospect_gtms").select("content").eq("prospect_id", p.id).eq("status", "done").order("created_at", { ascending: false }).limit(1).maybeSingle(),
      db.from("prospect_notes").select("body").eq("prospect_id", p.id).eq("kind", "call_review").order("created_at", { ascending: false }).limit(2),
      import("@/lib/sales-agent"),
    ]);
    const { pickCaseStudies, verticalOf, cleanGtm } = await import("@/lib/sales-gtm-core");
    const b = p.brief ? cleanBrief(p.brief) : null;
    const picked = pickCaseStudies(`${p.industry ?? ""} ${b?.sells ?? ""}`, (studies ?? []) as import("@/lib/sales-gtm-core").CaseStudy[], verticalOf(p.industry, b?.sells));
    const gtm = g?.content ? cleanGtm(g.content) : null;
    const whiteLabel = p.relationship === "white_label";
    const brief = [
      whiteLabel ? `WHITE LABEL (${p.partner_key ?? "a partner agency"}): no Kaizen mentions, ad spend only unless told. Kaizen's proposal deck template is Kaizen-branded: for a white-label pitch, say so and offer the partner-branded GTM PDF instead (or ask the owner for a partner proposal template). Don't make a Kaizen-branded proposal for a white-label prospect.` : "Direct Kaizen deal: Kaizen branding, prepared by the CEO.",
      `Proposal for ${p.name}${p.website ? ` (${p.website})` : ""}. Proposed services: ${str(input.services)}.`,
      `Game plan (how we deliver; weave into the executive summary, the platform playbook bullets and the game plan slide): ${str(input.game_plan)}`,
      `Rules: the CEO's 11 slides; only the proposed services; exact prices from the pricing reference below; ad spend paid directly to the platforms, never marked up; the 60-day minimum (90 days with email) AND the 30-day written notice to cancel, together; month to month after; the client owns every account and asset; tracking and analytics setup included; no competitor names; never a placeholder or an invented stat.`,
      `Case studies (exact numbers, never changed). Lead with: ${picked[0] ? `${picked[0].name} (${picked[0].vertical}): ${picked[0].services}. Results: ${picked[0].results}. Connection: ${picked[0].connection}` : "none"}. Supporting: ${picked.slice(1, 3).map((c) => `${c.name}: ${c.results}`).join(" | ")}`,
      `Pricing reference:\n${await rateCardText(admin)}`,
      b ? `Research:\n${briefText(p.name, b)}` : "Not researched yet.",
      gtm ? `Go-to-market strategy (already made; the proposal stays separate but consistent): offer ${gtm.positioning.offer.name}: ${gtm.positioning.offer.text}. Recommended: ${gtm.exec.recommend.map((r) => `${r.lead}: ${r.text}`).join(" | ")}. Benchmarks: ${JSON.stringify(gtm.investment.benchmarks).slice(0, 1500)}` : "",
      (reviews ?? []).length ? `Call reviews: ${(reviews ?? []).map((r) => JSON.stringify(r.body).slice(0, 2000)).join("\n")}` : "",
      str(input.transcript) ? `Meeting transcript (reference it at least 3 times, quoting their pain points):\n${str(input.transcript)!.slice(0, 20_000)}` : "No transcript given: use the call reviews and research for what they said.",
    ].filter(Boolean).join("\n\n");
    return { ok: true, prospect: p.name, case_study: picked[0]?.name ?? null, brief, next: "Call make_document with template proposal, prospect: the name, and this brief. Afterwards, write 'Proposal notes' for the person (2-3 follow-up insights, objections and handling, close talking points): internal, never sent." };
  },
};

export const tools: AiTool[] = [webResearch, research, find, mine, details, save, pitch, review, won, myBriefs, saveToBrief, scanBriefs, archive, unarchive, searchStatus, makeGtm, gtmStatus, proposalBrief, partnerKit].map(execPagesOnly);
