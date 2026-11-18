// The conversational deliverable flow, for any line (email now; creative and social next): the line's strategist leads,
// asks only what's missing (the type, how many), pulls fresh context, brainstorms with the person, brings in the
// writer once topics are agreed, the writer drafts one preview document for the whole batch, the person and the
// strategist review it until both approve, then the strategist asks to create the requests (Asana now; Kaizen OS
// requests are coming) and the assistant wraps up. Pure: the steps, what each one allows and the per-line config shape,
// with no database or network, so the progression is tested on its own. The server side is ./server.ts; each line's
// config is in ./lines.

import type { WantedField } from "@/lib/copy-docs/core";

// ─── A line's config ────────────────────────────────────────────────────────

/** One kind of request a line makes ("campaign", "flow"; "ad creative"; "organic post") */
export type KindConfig = {
  key: string;
  label: string;
  /** How many items one request may hold (a campaign batch up to 5, a flow up to 6) */
  max: number;
  /** One Asana task per item (each campaign in a batch) or one for the whole document (a flow, with its count) */
  split: "per_item" | "per_doc";
  /** Words that name it ("campaign", "blast", "newsletter") */
  words: RegExp;
};

/** What the Asana task is for one item (or the whole document): what a line's config builds from */
export type TaskInput = {
  client: { name: string; kaizenId: number | null; website: string | null; hqUrl: string | null; figma: string | null; platform: string | null };
  kind: KindConfig;
  /** The item's short name (or the document's for per_doc) */
  shortName: string;
  /** Items in the task (the flow's email count; 1 per item) */
  count: number;
  /** The Google Doc (or its section) the task's Copy field links */
  docUrl: string | null;
  /** The purpose line: what it's for, design direction, assets */
  purpose: string;
  urgency: "urgent" | "high" | "normal" | "low";
  /** Creative and social: what the item is (concept, posting date, one entry per slide or frame, the client's quick links) */
  concept?: string;
  postDate?: string | null;
  slides?: { name: string; headline: string; line: string; visual: string }[];
  links?: { label: string; url: string }[];
};

/** Words a line says differently from email (its count question, brainstorm ask and draft instruction); unset, email's apply */
export type LinePrompts = {
  askCount?: (kind: KindConfig) => string;
  brainstorm?: (count: number) => string;
  draft?: (kind: KindConfig, cfg: { lead: string }) => string;
};

export type LineConfig = {
  /** The line's key ("email", "creative", "social") */
  line: string;
  label: string;
  /** The specialist who leads (its role key) and the writer it brings in */
  lead: string;
  writer: string;
  /** The seat followed on every request (the client's strategist on this line), by client_assignments role */
  followerSeat: string;
  kinds: KindConfig[];
  /** Words that start the flow for this line ("create campaigns for", "email copy") */
  trigger: RegExp;
  /** The lookups the lead runs before brainstorming, as told to it (tool names and what to read) */
  context: string[];
  /** How to brainstorm: the rules from the line's knowledge (segments to include and exclude, send times) */
  brainstorm: string;
  /** The preview document: its template and the Drive folder the approved copy goes in (under the client's HQ) */
  doc: { template: "copy" | "creative" | "social"; folder: string };
  /** More people (by staff role, e.g. "head_of_creative") added to each task as collaborators beside the seat's person */
  collaborators?: string[];
  prompts?: LinePrompts;
  asana: {
    /** Where the project is found: a fixed gid, an env var, an app setting ({ gid }), else a project named like this */
    project: { gid?: string; env?: string; setting?: string; nameLike?: RegExp };
    /** The column new requests land in (matched by name) */
    section: string;
    taskName: (t: TaskInput) => string;
    fields: (t: TaskInput) => WantedField[];
    /** The task's description, when the line writes its own (social); unset, the copy brief's (email) */
    description?: (t: TaskInput) => string;
    /** "creative_form": send through the request form's own path (src/lib/asana-request.ts) instead of writing the task here */
    via?: "creative_form";
    /** The Kaizen mirror to record the task on (the Email Board's outline cards), if any */
    mirror?: "email_asana_tasks";
  };
  /** Kaizen OS requests for this line: off until they're built */
  kaizenRequests: boolean;
  /** The tool names the agents use for the request and its fixes */
  tools: { request: string; update: string };
};

// ─── The state of one run ───────────────────────────────────────────────────

export type Topic = { title: string; angle: string; offer: string; include: string[]; exclude: string[]; send: string };
export type Request = { name: string; url: string; gid: string; follower: string | null; followerMissing: string | null };

export type RunState = {
  line: string;
  client: { id: string; name: string } | null;
  kind: string | null;
  count: number | null;
  contextPulled: boolean;
  topics: Topic[];
  topicsAgreed: boolean;
  writerJoined: boolean;
  docId: string | null;
  docVersion: number;
  /** The doc version each approval was given on (a new version needs approving again) */
  personApproved: number | null;
  leadApproved: number | null;
  asanaAsked: boolean;
  requests: Request[];
  wrapped: boolean;
};

export const newRun = (line: string, client: { id: string; name: string } | null): RunState => ({
  line,
  client,
  kind: null,
  count: null,
  contextPulled: false,
  topics: [],
  topicsAgreed: false,
  writerJoined: false,
  docId: null,
  docVersion: 0,
  personApproved: null,
  leadApproved: null,
  asanaAsked: false,
  requests: [],
  wrapped: false,
});

export type Step = "ask_type" | "ask_count" | "pull_context" | "brainstorm" | "bring_writer" | "draft" | "review" | "ask_requests" | "create_requests" | "wrap_up" | "done";
export type Next = { step: Step; who: "lead" | "writer" | "host"; say: string };

export const kindOf = (cfg: LineConfig, key: string | null) => cfg.kinds.find((k) => k.key === key) ?? null;
export const approved = (s: RunState) => s.docVersion > 0 && s.personApproved === s.docVersion && s.leadApproved === s.docVersion;
/** The writer comes in only once the topics are agreed */
export const canBringWriter = (s: RunState) => s.topicsAgreed && s.topics.length > 0;
/** The writer drafts only once it's on and the topics are agreed */
export const canDraft = (s: RunState) => canBringWriter(s);
/** Requests are made only once the person and the lead approved the latest version and the lead asked */
export const canRequest = (s: RunState) => approved(s) && s.asanaAsked;

/** The next step and who takes it, with what to say (short: it's spoken on a call) */
export function nextStep(cfg: LineConfig, s: RunState): Next {
  const kind = kindOf(cfg, s.kind);
  const many = kind ? `${kind.label.toLowerCase()}s` : "items";
  if (!kind) return { step: "ask_type", who: "lead", say: `Greet them in a line and ask which it is: ${cfg.kinds.map((k) => k.label.toLowerCase()).join(" or ")}${s.count == null ? ", and how many" : ""}. One short question.` };
  if (s.count == null) return { step: "ask_count", who: "lead", say: cfg.prompts?.askCount?.(kind) ?? `Ask how many ${kind.split === "per_doc" ? `emails in the ${kind.label.toLowerCase()}` : many} (up to ${kind.max}). One short question.` };
  if (!s.contextPulled) return { step: "pull_context", who: "lead", say: `Before brainstorming, pull fresh context (deliverable action: context), then read: ${cfg.context.join("; ")}. Say in one line what stood out.` };
  if (!s.topicsAgreed)
    return {
      step: "brainstorm",
      who: "lead",
      say: s.topics.length
        ? `${cfg.prompts?.brainstorm?.(s.count) ?? `Settle the ${s.count} topic${s.count === 1 ? "" : "s"} with them: angle, offer, segments to include and exclude, send date.`} ${cfg.brainstorm} When they agree, record them with agreed: true.`
        : `Brainstorm with them: ask for their ideas first. No ideas: propose ${s.count} from holidays and national days that fit the client, what worked in their own data, and patterns from similar clients in their industry (never name another client). ${cfg.brainstorm}`,
    };
  if (!s.writerJoined) return { step: "bring_writer", who: "lead", say: `Topics are agreed: bring in the ${cfg.writer.replace(/_/g, " ")} (call_in_specialist) with the topics, segments and send dates, in one line.` };
  if (!s.docId) return { step: "draft", who: "writer", say: cfg.prompts?.draft?.(kind, cfg) ?? `Draft every ${kind.split === "per_doc" ? "email in the flow" : kind.label.toLowerCase()} into ONE preview document (create_copy_doc, a section per email: subject, preview text, body, button, design notes), then ask what they think in a line and hand_off to the ${cfg.lead.replace(/_/g, " ")} for its notes.` };
  if (!approved(s))
    return {
      step: "review",
      who: s.leadApproved === s.docVersion ? "writer" : "lead",
      say: `Review loop on version ${s.docVersion}: the ${cfg.lead.replace(/_/g, " ")} gives its notes (taking the person's feedback into account) or approves (deliverable action: approve, by: lead); the writer revises with create_copy_doc (copy_doc_id) on notes. When the person approves, record it (by: person). Both must approve the same version.`,
    };
  if (!s.asanaAsked) return { step: "ask_requests", who: "lead", say: `Both approved. Ask: "Create this in Asana?"${cfg.kaizenRequests ? ' (or in Kaizen OS)' : ' (Kaizen OS requests are coming soon)'}. Record that you asked (deliverable action: asked).` };
  if (!s.requests.length) return { step: "create_requests", who: "lead", say: `On their yes: ${cfg.tools.request} with where: asana and confirmed: true. It makes the Google Doc in the client's HQ Drive (${cfg.doc.folder}) and the Asana task${kind.split === "per_item" && (s.count ?? 1) > 1 ? "s, one per item" : ""}, and shows the links.` };
  if (!s.wrapped) return { step: "wrap_up", who: "host", say: "The requests are in: thank the specialists, then ask if there's anything else." };
  return { step: "done", who: "host", say: "Done." };
}

export type Patch = {
  kind?: string | null;
  count?: number | null;
  contextPulled?: boolean;
  topics?: Topic[];
  agreed?: boolean;
  writerJoined?: boolean;
  doc?: { id: string; version: number };
  approve?: "person" | "lead";
  asked?: boolean;
  requests?: Request[];
  wrapped?: boolean;
};

/**
 * A change to the run, checked against the line's rules: a count past the kind's limit is refused, the writer can't
 * join before the topics are agreed, approvals only count for the version they were given on, the requests only
 * after both approved and the ask was made. Returns the new state, or why it was refused.
 */
export function applyPatch(cfg: LineConfig, s: RunState, p: Patch): { ok: true; state: RunState } | { ok: false; why: string } {
  const n: RunState = { ...s, topics: [...s.topics], requests: [...s.requests] };
  if (p.kind !== undefined && p.kind !== null) {
    const k = cfg.kinds.find((x) => x.key === p.kind || x.words.test(String(p.kind)));
    if (!k) return { ok: false, why: `Not a kind here: ${cfg.kinds.map((x) => x.key).join(", ")}.` };
    n.kind = k.key;
  }
  if (p.count !== undefined && p.count !== null) {
    const k = kindOf(cfg, n.kind);
    const c = Math.round(Number(p.count));
    if (!Number.isFinite(c) || c < 1) return { ok: false, why: "How many: at least one." };
    if (k && c > k.max) return { ok: false, why: `A ${k.label.toLowerCase()} request holds up to ${k.max}. Split it into two.` };
    n.count = c;
  }
  if (p.contextPulled) n.contextPulled = true;
  if (p.topics) {
    n.topics = p.topics.slice(0, 12);
    n.topicsAgreed = false;
  }
  if (p.agreed !== undefined) {
    if (p.agreed && !n.topics.length) return { ok: false, why: "Record the topics first (topics), then agree them." };
    n.topicsAgreed = p.agreed;
  }
  if (p.writerJoined) {
    if (!canBringWriter(n)) return { ok: false, why: "The writer comes in once the topics are agreed with the person." };
    n.writerJoined = true;
  }
  if (p.doc) {
    if (!canDraft(n)) return { ok: false, why: "Agree the topics before drafting." };
    n.docId = p.doc.id;
    n.writerJoined = true;
    if (p.doc.version !== n.docVersion) {
      n.docVersion = p.doc.version;
      n.asanaAsked = false;
    }
  }
  if (p.approve) {
    if (!n.docId) return { ok: false, why: "There's no draft to approve yet." };
    if (p.approve === "person") n.personApproved = n.docVersion;
    else n.leadApproved = n.docVersion;
  }
  if (p.asked) {
    if (!approved(n)) return { ok: false, why: "Ask about Asana only once the person and the lead approved the latest version." };
    n.asanaAsked = true;
  }
  if (p.requests) {
    if (!approved(n)) return { ok: false, why: "The requests wait until the copy is approved." };
    n.requests = [...n.requests, ...p.requests];
    n.asanaAsked = true;
  }
  if (p.wrapped) n.wrapped = true;
  return { ok: true, state: n };
}

/** The type and count a person said up front ("3 campaigns for Candy Cloud", "a 4 email welcome flow") */
export function readAsk(cfg: LineConfig, text: string): { kind: string | null; count: number | null } {
  const t = String(text ?? "");
  const kind = cfg.kinds.find((k) => k.words.test(t)) ?? null;
  const words: Record<string, number> = { one: 1, a: 1, an: 1, single: 1, two: 2, couple: 2, three: 3, four: 4, five: 5, six: 6 };
  const m = /\b(\d{1,2}|one|two|three|four|five|six|couple|single)\s*(?:of\s+)?(?:new\s+)?(?:-?\s*)?(?:emails?|campaigns?|sends?|blasts?|newsletters?|messages?|texts?|posts?|ads?|creatives?|videos?|carousels?|statics?|images?|versions?|variations?|concepts?)\b/i.exec(t);
  const count = m ? (/^\d+$/.test(m[1]) ? Number(m[1]) : (words[m[1].toLowerCase()] ?? null)) : null;
  return { kind: kind?.key ?? null, count };
}

/** The Asana tasks a run makes: one per item, or one for the document (a flow, with its count) */
export function tasksFor(cfg: LineConfig, s: RunState, items: { shortName: string; docUrl: string | null; purpose: string; extra?: Pick<TaskInput, "concept" | "postDate" | "slides" | "links"> }[], base: Omit<TaskInput, "kind" | "shortName" | "count" | "docUrl" | "purpose">, docName: string, docUrl: string | null, purpose: string) {
  const kind = kindOf(cfg, s.kind) ?? cfg.kinds[0];
  const inputs: TaskInput[] = kind.split === "per_item" ? items.map((i) => ({ ...base, ...i.extra, kind, shortName: i.shortName, count: 1, docUrl: i.docUrl ?? docUrl, purpose: i.purpose })) : [{ ...base, kind, shortName: docName, count: items.length, docUrl, purpose }];
  return inputs.map((t) => ({ input: t, name: cfg.asana.taskName(t), fields: cfg.asana.fields(t) }));
}

/**
 * The client's strategist on the line follows every request (never its assignee): their Asana user when matched by
 * email (or the mirror's mapping), else a plain note for the result card instead of a failure.
 */
export function followerOf(seatLabel: string, seat: { name: string; email: string | null } | null, asanaUser: string | null): { follower: string | null; missing: string | null } {
  if (!seat) return { follower: null, missing: `No ${seatLabel} on the account, so nobody was added as a follower.` };
  if (!asanaUser) return { follower: null, missing: `${seat.name} couldn't be matched to an Asana user, so they aren't following it yet: add them on the task.` };
  return { follower: asanaUser, missing: null };
}
