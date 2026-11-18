// Several agents on one call: the plain parts (no keys, no network), shared by the server, the call screen and the
// tests. Who a turn is for when more than one specialist is on the line, the jobs a call can be about (launching ads,
// an email request, a creative brief, an audit and sprint, a report) as data, what each job still needs from what the
// checks found, the job's shared working state that every agent on the call reads, and how far agents may hand work
// to each other before the person gets the floor back.

import { ASSISTANT_KEY, SPECIALISTS, specialistOf, suggestSpecialist } from "./core";
import { emailWritingKind } from "@/lib/copy-docs/core";
import { lineForAsk } from "@/lib/deliverables/lines";

// ─── Who's on the line ──────────────────────────────────────────────────────

/** At most this many specialists on a call at once (besides the host) */
export const MAX_ON_LINE = 3;

/**
 * What a person calls each agent out loud. Short ones ("buyer", "designer") count only when one agent on the line
 * answers to them.
 */
const ALIASES: Record<string, { full: string[]; short?: string[] }> = {
  assistant: { full: ["assistant"] },
  media_buyer: { full: ["media buyer", "meta buyer", "meta media buyer", "facebook buyer", "facebook media buyer"], short: ["buyer"] },
  google_buyer: { full: ["google ads buyer", "google buyer", "google media buyer", "google ads media buyer", "google ads specialist"], short: ["buyer"] },
  email_strategist: { full: ["email strategist"], short: ["strategist"] },
  email_creative: { full: ["email designer"], short: ["designer"] },
  email_builder: { full: ["email builder"], short: ["builder"] },
  creative_director: { full: ["creative director", "head of creative"] },
  copywriter: { full: ["copywriter", "copy writer"] },
  strategist: { full: ["strategist"] },
  market_analyst: { full: ["market analyst"], short: ["analyst"] },
  social_strategist: { full: ["social strategist", "social media strategist", "organic strategist"], short: ["strategist"] },
  account_manager: { full: ["account manager"] },
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");

/** The words that name an agent on this line (a short word only when nobody else on it answers to it too) */
function namesOf(key: string, everyone: readonly string[]): string[] {
  const a = ALIASES[key];
  if (!a) return [key.replace(/_/g, " ")];
  const short = (a.short ?? []).filter((w) => everyone.filter((k) => k !== key && (ALIASES[k]?.short ?? []).includes(w)).length === 0 && !everyone.some((k) => k !== key && (ALIASES[k]?.full ?? []).some((f) => f === w)));
  return [...a.full, ...short].sort((x, y) => y.length - x.length);
}

const LEAD = "^\\s*(?:(?:hey|hi|ok(?:ay)?|so|and|right|alright|now|thanks|thank you|cool|great)[,!.\\s]+)*(?:the\\s+|my\\s+|our\\s+)?";
/** Not talking to it, talking about it ("the copywriter said…", "copywriter's draft") */
const ABOUT = "(?!['’]s\\b|\\s+(?:said|says|is|was|has|had|did|wrote|will|would|agent|thinks?|mentioned)\\b)";

/** Whether the person spoke to this agent by name: at the start ("Copywriter, punchier") or as a closing call-out ("…right, buyer?") */
export function speaksTo(text: string, key: string, everyone: readonly string[] = [key]): boolean {
  const names = namesOf(key, everyone).map(esc).join("|");
  if (!names) return false;
  return new RegExp(`${LEAD}(?:${names})\\b${ABOUT}`, "i").test(text) || new RegExp(`,\\s*(?:the\\s+)?(?:${names})\\s*[?.!]*\\s*$`, "i").test(text);
}

/** Whether an agent is named anywhere in what was said ("thanks Copywriter, you can go") */
export function mentions(text: string, key: string, everyone: readonly string[] = [key]): boolean {
  const names = namesOf(key, everyone).map(esc).join("|");
  return Boolean(names) && new RegExp(`\\b(?:${names})\\b`, "i").test(text);
}

const HAND_BACK = /\b(?:i'?ll take it from here|that'?s all(?: i need)?(?: from you(?: two| both| all)?)?|you can (?:go|drop off|hop off|leave)|you(?: two| both| all)? can (?:go|drop off|hop off|leave)|thanks?,? (?:that'?s it|we'?re good|you can go)|back to (?:the|my) assistant|dismiss (?:the )?(?:specialists?|agents?)|let (?:them|him|her) go)\b/i;

export type TeamRoute = { to: string; dismiss: string[] };

/**
 * Who a turn is for when several agents may be on the line. `host` runs the call (the assistant, or the agent called
 * directly); `line` is who else is on; `last` is the agent who spoke last. Handing the call back lets the named
 * specialists go (or all of them, when none is named) and goes to the host. Speaking to an agent by name goes to it.
 * Otherwise it goes to whoever the conversation is with: the last agent who spoke, else the newest on the line.
 */
export function routeTeam(text: string, input: { host: string; line: readonly string[]; last?: string | null }): TeamRoute {
  const { host } = input;
  const line = input.line.filter((k) => k !== host);
  const everyone = [host, ...line];
  if (!line.length) return { to: host, dismiss: [] };
  if (HAND_BACK.test(text)) {
    const named = line.filter((k) => mentions(text, k, everyone));
    return { to: host, dismiss: named.length ? named : [...line] };
  }
  const named = everyone.filter((k) => speaksTo(text, k, everyone));
  if (named.length === 1) return { to: named[0], dismiss: [] };
  if (input.last && everyone.includes(input.last)) return { to: input.last, dismiss: [] };
  return { to: line[line.length - 1], dismiss: [] };
}

/** The line after someone joins (no repeats, never the host, at most MAX_ON_LINE) */
export function joinLine(line: readonly string[], key: string, host: string): { line: string[]; joined: boolean; full: boolean } {
  if (key === host || line.includes(key)) return { line: [...line], joined: false, full: false };
  if (line.length >= MAX_ON_LINE) return { line: [...line], joined: false, full: true };
  return { line: [...line, key], joined: true, full: false };
}

/** The call's line from its row: the list, or the single specialist kept before there could be several */
export function lineOf(row: { guest_roles?: readonly string[] | null; guest_role?: string | null }, host: string): string[] {
  const list = Array.isArray(row.guest_roles) && row.guest_roles.length ? row.guest_roles : row.guest_role ? [row.guest_role] : [];
  return [...new Set(list.filter((k) => typeof k === "string" && k !== host && Boolean(specialistOf(k))))].slice(0, MAX_ON_LINE);
}

export const labelOf = (key: string) => (key === ASSISTANT_KEY ? "Assistant" : (specialistOf(key)?.label ?? key.replace(/_/g, " ")));

// ─── Agents talking to each other ───────────────────────────────────────────

/** At most this many agent-to-agent hand-offs follow one thing the person says, then the person has the floor */
export const MAX_HOPS = 2;

export type Handoff = { from: string; to: string; say: string };

/**
 * Whether a hand-off may go ahead now: to someone on the call (the host or the line), not to itself, within the hop
 * limit, and never the same hand-off twice in one go (no ping-pong without the person).
 */
export function canHandOff(h: Pick<Handoff, "from" | "to">, input: { host: string; line: readonly string[]; chain: readonly string[] }): { ok: true } | { ok: false; why: string } {
  if (h.to === h.from) return { ok: false, why: "That's you." };
  if (h.to !== input.host && !input.line.includes(h.to)) return { ok: false, why: `The ${labelOf(h.to)} isn't on the call. Ask the person first whether to bring it in.` };
  if (input.chain.length >= MAX_HOPS) return { ok: false, why: "Enough back and forth for now: give the person the floor and ask them." };
  if (input.chain.includes(`${h.from}>${h.to}`)) return { ok: false, why: "You already handed that over: ask the person instead." };
  return { ok: true };
}

// ─── Jobs ───────────────────────────────────────────────────────────────────

export const JOB_KINDS = ["launch_ads", "email_request", "creative_brief", "audit_sprint", "report"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** Who does a step: a specialist, the platform's buyer (Meta or Google), or the host running the call */
export type Slot = string | "buyer" | "host";

export type PlayStep = {
  key: string;
  label: string;
  /** Who does it */
  agent: Slot;
  /** Nice to have: never holds the job up */
  optional?: boolean;
  /** How it's offered when it's missing ({client} is filled in) */
  ask: string;
  /** How it's done, for the agent who does it */
  how: string;
};

export type Playbook = { kind: JobKind; label: string; about: string; words: RegExp; steps: PlayStep[] };

/**
 * The common jobs, as data: which agents, which checks, in which order. The model decides within them (what to skip,
 * what to ask, who to bring in); the order here is the order things are checked and offered. Add a job by adding an
 * entry (and its checks in team-server.ts).
 */
export const PLAYBOOKS: readonly Playbook[] = [
  {
    kind: "launch_ads",
    label: "Launch ads",
    about: "getting approved creative and copy live as ads, through the launcher's checks",
    words: /\b(launch\w*|go(?:es|ing)? live|get (?:the |them |these |those )?(?:new )?(?:ads? )?(?:up|live|out|running)|(?:ads?|creatives?) (?:up|live|running)|push (?:them|it|the ads) live|set up (?:the |new )?ads|deploy (?:the )?ads|put (?:the |them |these )?(?:ads )?live)\b/i,
    steps: [
      { key: "creatives", label: "Approved creatives", agent: "creative_director", ask: "Nothing approved is ready to launch for {client} yet. Want to upload the creatives, or shall I grab the Creative Director for a brief?", how: "Find the approved designs (tickets in Ready to launch, or creatives uploaded on this call). None: ask for files (ask_for_files) or offer a brief." },
      { key: "copy", label: "Approved copy", agent: "copywriter", ask: "There's no approved copy for these ads yet. Want me to grab the Copywriter?", how: "Draft the ticket's copy (ticket_copy draft), say the angle in a line, get a spoken yes to approve it (ticket_copy approve), then hand it to the buyer. For uploaded creatives with a launch sheet: write it with write_ad_copy." },
      { key: "client", label: "Client approved", agent: "host", ask: "The client hasn't approved these yet. Want me to send them over for review?", how: "Send the ticket to the client (move_ticket, or on the board) only after a spoken yes; the launch waits for their approval in the portal. Nothing goes to the client without that yes." },
      { key: "adset", label: "Ad set picked", agent: "buyer", ask: "The {buyer} picks the ad set and names. Want it in?", how: "Start the launcher on the ticket (ticket_launch start, after a yes): it reads the account, proposes the ad set and names and runs Kaizen's checks and Meta's dry run. Say which ad set it picked and why." },
      { key: "checks", label: "Launcher's checks passed", agent: "buyer", ask: "The launcher's checks haven't passed yet.", how: "Read ticket_launch status: say any block plainly and what fixes it; warnings in a line. Never skip a check." },
      { key: "live", label: "Ads created in Meta", agent: "buyer", ask: "Everything checks out. Want me to create the ads, paused, for you to turn on?", how: "Read the locked settings out in a sentence, ask, and only on a spoken yes run ticket_launch confirm with the fingerprint from status. The ads are created paused." },
    ],
  },
  {
    kind: "email_request",
    label: "Email request",
    about: "campaigns or a flow, from topics to approved copy to the Asana request",
    words: /\b(email (?:request|batch|campaign|flow)s?|request (?:an |some |a few )?emails?|(?:new|another) (?:email|campaign) batch|set up (?:a |the )?flow|emails? for (?:the |their )?\w+ (?:sale|launch|week|day))\b/i,
    steps: [
      { key: "idea", label: "Type, count and topics agreed", agent: "email_strategist", ask: "Want the Email Strategist on to shape the campaigns?", how: "The deliverable flow (deliverable action: start): ask the type and how many only if missing, pull fresh context, brainstorm topics, segments and send dates with them, record them agreed." },
      { key: "copy", label: "Copy drafted and approved", agent: "copywriter", ask: "The topics are set. Want the Copywriter to draft them?", how: "create_copy_doc: one preview document for the batch, a section per email; the strategist reviews, the person approves." },
      { key: "request", label: "Requested in Asana", agent: "email_strategist", ask: "Create this in Asana?", how: "create_email_request where: asana after a spoken yes: the Google Doc in their HQ Drive, then the Asana task(s) in Email Requests (Kaizen OS requests are coming soon)." },
      { key: "design", label: "Design direction", agent: "email_creative", optional: true, ask: "Want the Email Designer's take on the layout?", how: "A line or two of design direction, noted on the job." },
    ],
  },
  {
    kind: "creative_brief",
    label: "Creative brief",
    about: "a new creative brief for the board",
    words: /\b(brief\w*|new creatives?|creative (?:request|ideas?|concepts?)|concepts? for|need (?:new |more |fresh )?(?:ads|creatives?))\b/i,
    steps: [
      { key: "angle", label: "An angle from what's winning", agent: "strategist", optional: true, ask: "Want the Strategist to pick the angle from what's winning?", how: "Start from the client's winners, then similar clients and the market; give one angle in a sentence." },
      { key: "brief", label: "The brief", agent: "creative_director", ask: "Shall I grab the Creative Director to write the brief?", how: "create_brief: one concept per brief; it lands as a card to review." },
      { key: "copy_direction", label: "Copy direction", agent: "copywriter", optional: true, ask: "Want the Copywriter to add the copy direction?", how: "Two or three lines of hook and copy direction, noted on the job." },
    ],
  },
  {
    kind: "audit_sprint",
    label: "Audit and sprint",
    about: "an account audit and the sprint of changes that follows it",
    words: /\b(audit\w*|sprint|optimi[sz]\w*|what'?s wrong with (?:the |their )?account|fix (?:the |their )?account)\b/i,
    steps: [
      { key: "audit", label: "A recent audit", agent: "buyer", ask: "There's no audit from this week. Want the {buyer} to run one?", how: "run_audit after a spoken yes (it takes a few minutes), or read the latest one." },
      { key: "plan", label: "A change plan", agent: "buyer", ask: "Want the {buyer} to plan the changes?", how: "plan_ad_changes with every name and number; it lands on a plan card to confirm." },
    ],
  },
  {
    kind: "report",
    label: "Report",
    about: "a client report",
    words: /\b(reports?|recap|monthly numbers|weekly numbers)\b/i,
    steps: [
      { key: "story", label: "The story behind the numbers", agent: "buyer", optional: true, ask: "Want the {buyer} to walk through what moved?", how: "Pull the numbers and say what moved and why in three sentences." },
      { key: "report", label: "The report built", agent: "host", ask: "Shall I build the report?", how: "create_report after a spoken yes; they're told when it's ready." },
    ],
  },
];

export const playbookOf = (kind: string | null | undefined) => PLAYBOOKS.find((p) => p.kind === kind) ?? null;

/** The job a request is about, if one stands out (launching wins a tie: "brief and launch" is a launch) */
export function recognizeJob(text: string): Playbook | null {
  const hits = PLAYBOOKS.map((p, at) => ({ p, at, n: (text.match(new RegExp(p.words.source, "gi")) ?? []).length })).filter((x) => x.n > 0);
  if (!hits.length) return null;
  hits.sort((a, b) => b.n - a.n || a.at - b.at);
  return hits[0].p;
}

/** The platform named, if any */
export function platformIn(text: string): "meta" | "google" | null {
  if (/\b(google|search ads?|pmax|performance max|youtube)\b/i.test(text)) return "google";
  if (/\b(meta|facebook|instagram|fb|ig)\b/i.test(text)) return "meta";
  return null;
}

/** The specialist a step's slot means on this job */
export function agentFor(slot: Slot, platform: "meta" | "google" | null, host: string): string {
  if (slot === "host") return host;
  if (slot === "buyer") return platform === "google" ? "google_buyer" : "media_buyer";
  return slot;
}

export type Gap = { key: string; label: string; agent: string; optional: boolean; ask: string; how: string };

/**
 * What a job still needs, in the playbook's order: each step not done (the checks found it, or an agent marked it
 * done), with who does it and how it's offered. Optional steps are listed but never come first.
 */
export function whatsMissing(job: Pick<Job, "kind" | "platform" | "client" | "done">, facts: Readonly<Record<string, boolean>>, host: string): Gap[] {
  const book = playbookOf(job.kind);
  if (!book) return [];
  const buyer = job.platform === "google" ? "Google Ads Buyer" : "Media Buyer";
  const fill = (s: string) => s.replace(/\{client\}/g, job.client?.name ?? "the client").replace(/\{buyer\}/g, buyer);
  const gaps = book.steps
    .filter((s) => !facts[s.key] && !job.done.includes(s.key))
    .map((s) => ({ key: s.key, label: s.label, agent: agentFor(s.agent, job.platform, host), optional: Boolean(s.optional), ask: fill(s.ask), how: s.how }));
  return [...gaps.filter((g) => !g.optional), ...gaps.filter((g) => g.optional)];
}

/** The agents a job still needs, in order, that aren't on the call yet (the host and the line excluded) */
export function agentsToBring(gaps: readonly Gap[], host: string, line: readonly string[]): string[] {
  return [...new Set(gaps.filter((g) => !g.optional).map((g) => g.agent))].filter((k) => k !== host && !line.includes(k) && Boolean(specialistOf(k)));
}

// ─── The launch's checks ────────────────────────────────────────────────────

/** A client's ticket as the launch checks read it */
export type LaunchTicket = {
  number: number;
  title: string;
  stage: string;
  /** The copy set's status, or null when none is written */
  copy: "drafting" | "review" | "approved" | "failed" | null;
  designs: number;
  approvedDesigns: number;
  /** The ticket's latest launch (not discarded) */
  launch: { status: string; adset: string | null } | null;
};

/** What the launch checks found: the client's tickets, what was uploaded on the call, a launch sheet's run */
export type LaunchFound = {
  tickets: readonly LaunchTicket[];
  uploadedCreatives: number;
  sheet: { status: string } | null;
  /** Copy written on this call (a write_ad_copy card, kept on the job) */
  copyOnCall: boolean;
};

const LAUNCHABLE = new Set(["ready_for_launch"]);
const LAUNCHED_OR_READY = new Set(["ready_for_launch", "launched"]);
/** A launch sheet's run: checked and ready to confirm, or being created / created */
const SHEET_READY = new Set(["ready", "applying", "applied", "partial"]);
const SHEET_LIVE = new Set(["applying", "applied", "partial"]);
const COPY_STAGES = new Set(["copy", "copy_review", "internal_review", "ready_for_client", "client_review", "client_revision"]);

/** The ticket a launch is about: the one in Ready to launch first, else the one nearest it (one already launched only when there's nothing else) */
export function launchTicket(found: Pick<LaunchFound, "tickets">): LaunchTicket | null {
  const order = ["ready_for_launch", "client_review", "ready_for_client", "client_revision", "copy_review", "copy", "internal_review"];
  const near = [...found.tickets].filter((t) => order.includes(t.stage)).sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage));
  return near.find((t) => t.launch?.status !== "launched") ?? near[0] ?? null;
}

/**
 * The launch's facts from what the checks found: creatives (an approved design on a ticket in or near Ready to
 * launch, or creatives uploaded on the call), copy (that ticket's copy approved, or copy written on the call for a
 * launch sheet), the client's approval (the ticket reached Ready to launch), the ad set (the launcher's plan has one, or the sheet's run is ready), the checks (the launch is
 * ready), and live (created).
 */
export function launchFacts(found: LaunchFound): Record<string, boolean> {
  const t = launchTicket(found);
  const launch = t?.launch ?? null;
  const sheetReady = found.sheet ? SHEET_READY.has(found.sheet.status) : false;
  return {
    creatives: Boolean(t && (LAUNCHABLE.has(t.stage) || t.approvedDesigns > 0 || (COPY_STAGES.has(t.stage) && t.designs > 0))) || found.uploadedCreatives > 0,
    // Copy written on the call counts only for creatives without a ticket (a launch sheet): a ticket's copy is approved on the ticket
    copy: t ? t.copy === "approved" || LAUNCHED_OR_READY.has(t.stage) : found.copyOnCall,
    // A ticket reaches Ready to launch only once the client approved it; a launch sheet's creatives come approved
    client: t ? LAUNCHED_OR_READY.has(t.stage) : found.uploadedCreatives > 0 || Boolean(found.sheet),
    adset: Boolean(launch?.adset) || sheetReady,
    checks: launch ? ["ready", "launching", "launched"].includes(launch.status) : sheetReady,
    live: launch ? ["launching", "launched"].includes(launch.status) : found.sheet ? SHEET_LIVE.has(found.sheet.status) : false,
  };
}

// ─── The job's working state ────────────────────────────────────────────────

export type Artifact = { kind: "copy" | "copy_doc" | "asana_request" | "brief" | "ticket" | "email_ticket" | "launch" | "launch_run" | "report" | "audit" | "plan" | "files" | "other"; id: string; label: string; by: string; href: string | null };
export type JobNote = { by: string; text: string };

/** What the call is working on: every agent on the line reads it, so nothing is asked or said twice */
export type Job = {
  kind: JobKind;
  goal: string;
  client: { id: string; name: string } | null;
  platform: "meta" | "google" | null;
  /** Steps done (playbook keys) */
  done: string[];
  /** What's left as last checked (gap labels), for the prompt and the screen */
  left: string[];
  artifacts: Artifact[];
  /** Decisions and hand-off notes, by agent */
  notes: JobNote[];
  status: "open" | "done" | "dropped";
  startedAt: string;
};

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const ARTIFACT_KINDS: readonly Artifact["kind"][] = ["copy", "brief", "ticket", "email_ticket", "launch", "launch_run", "report", "audit", "plan", "files", "other"];

/** A job as saved on the call, checked (anything malformed is dropped; sizes capped) */
export function cleanJob(raw: unknown): Job | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const book = playbookOf(String(r.kind));
  if (!book) return null;
  const steps = new Set(book.steps.map((s) => s.key));
  const client = r.client && typeof r.client === "object" ? (r.client as Record<string, unknown>) : null;
  const artifacts = (Array.isArray(r.artifacts) ? r.artifacts : [])
    .map((a) => (a && typeof a === "object" ? (a as Record<string, unknown>) : {}))
    .filter((a) => ARTIFACT_KINDS.includes(a.kind as Artifact["kind"]) && clip(a.id, 80))
    .map((a) => ({ kind: a.kind as Artifact["kind"], id: clip(a.id, 80), label: clip(a.label, 140), by: clip(a.by, 40), href: typeof a.href === "string" && a.href.startsWith("/") ? clip(a.href, 300) : null }))
    .slice(-20);
  return {
    kind: book.kind,
    goal: clip(r.goal, 300),
    client: client && clip(client.id, 60) ? { id: clip(client.id, 60), name: clip(client.name, 120) } : null,
    platform: r.platform === "google" ? "google" : r.platform === "meta" ? "meta" : null,
    done: [...new Set((Array.isArray(r.done) ? r.done : []).map(String).filter((k) => steps.has(k)))],
    left: (Array.isArray(r.left) ? r.left : []).map((x) => clip(x, 80)).filter(Boolean).slice(0, 8),
    artifacts,
    notes: (Array.isArray(r.notes) ? r.notes : [])
      .map((n) => (n && typeof n === "object" ? (n as Record<string, unknown>) : {}))
      .map((n) => ({ by: clip(n.by, 40), text: clip(n.text, 300) }))
      .filter((n) => n.by && n.text)
      .slice(-16),
    status: r.status === "done" ? "done" : r.status === "dropped" ? "dropped" : "open",
    startedAt: typeof r.startedAt === "string" ? r.startedAt.slice(0, 40) : new Date(0).toISOString(),
  };
}

export function newJob(input: { kind: JobKind; goal: string; client: { id: string; name: string } | null; platform: "meta" | "google" | null; now?: Date }): Job {
  return { kind: input.kind, goal: clip(input.goal, 300), client: input.client, platform: input.platform, done: [], left: [], artifacts: [], notes: [], status: "open", startedAt: (input.now ?? new Date()).toISOString() };
}

export type JobPatch = { done?: string[]; artifact?: Omit<Artifact, "by"> | null; note?: string | null; left?: string[]; status?: Job["status"] };

/** A job with an agent's update: steps done, an artifact (one per id), a decision or hand-off note */
export function updateJob(job: Job, by: string, patch: JobPatch): Job {
  const steps = new Set(playbookOf(job.kind)?.steps.map((s) => s.key) ?? []);
  const done = [...new Set([...job.done, ...(patch.done ?? []).filter((k) => steps.has(k))])];
  let artifacts = job.artifacts;
  if (patch.artifact && clip(patch.artifact.id, 80) && ARTIFACT_KINDS.includes(patch.artifact.kind)) {
    const a: Artifact = { kind: patch.artifact.kind, id: clip(patch.artifact.id, 80), label: clip(patch.artifact.label, 140), by, href: patch.artifact.href && patch.artifact.href.startsWith("/") ? clip(patch.artifact.href, 300) : null };
    artifacts = [...artifacts.filter((x) => !(x.kind === a.kind && x.id === a.id)), a].slice(-20);
  }
  const notes = patch.note && clip(patch.note, 300) ? [...job.notes, { by, text: clip(patch.note, 300) }].slice(-16) : job.notes;
  return { ...job, done, artifacts, notes, left: patch.left ? patch.left.map((x) => clip(x, 80)).slice(0, 8) : job.left, status: patch.status ?? job.status };
}

/** The job as every agent on the call reads it each turn */
export function jobForPrompt(job: Job | null, gaps: readonly Gap[] | null = null): string {
  if (!job) return "";
  const book = playbookOf(job.kind);
  const doneLabels = (book?.steps ?? []).filter((s) => job.done.includes(s.key)).map((s) => s.label);
  const left = gaps ? gaps.map((g) => `${g.label}${g.optional ? " (optional)" : ""}: ${labelOf(g.agent)}`) : job.left;
  return [
    `<job status="${job.status}">`,
    `What we're doing: ${book?.label ?? job.kind}${job.client ? ` for ${job.client.name}` : ""}${job.platform ? ` on ${job.platform === "google" ? "Google" : "Meta"}` : ""}.${job.goal ? ` ${job.goal}` : ""}`,
    `Done: ${doneLabels.length ? doneLabels.join("; ") : "nothing yet"}.`,
    `Left: ${left.length ? left.join("; ") : "nothing"}.`,
    job.artifacts.length ? `Made on this call: ${job.artifacts.map((a) => `${a.label} (${a.kind} ${a.id}, by the ${labelOf(a.by)})`).join("; ")}.` : "",
    job.notes.length ? `Notes:\n${job.notes.map((n) => `- the ${labelOf(n.by)}: ${n.text}`).join("\n")}` : "",
    "</job>",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The job as the call screen shows it: what, for whom, and each step done or not */
export type JobView = { label: string; client: string | null; platform: "meta" | "google" | null; status: Job["status"]; steps: { key: string; label: string; done: boolean; optional: boolean }[] };

export function jobView(job: Job | null, gaps: readonly Gap[] | null = null): JobView | null {
  if (!job) return null;
  const book = playbookOf(job.kind);
  if (!book) return null;
  const open = gaps ? new Set(gaps.map((g) => g.key)) : null;
  return {
    label: book.label,
    client: job.client?.name ?? null,
    platform: job.platform,
    status: job.status,
    steps: book.steps.map((s) => ({ key: s.key, label: s.label, done: job.done.includes(s.key) || (open ? !open.has(s.key) : false), optional: Boolean(s.optional) })),
  };
}

/** The playbooks as the host reads them: which job, who does what, in which order */
export function playbooksForPrompt(): string {
  return PLAYBOOKS.map((p) => `- ${p.kind} (${p.about}): ${p.steps.map((s) => `${s.label}${s.optional ? " (optional)" : ""} by ${s.agent === "buyer" ? "the platform's buyer" : s.agent === "host" ? "you" : `the ${labelOf(s.agent)}`}`).join(", then ")}`).join("\n");
}

/** Every specialist key (for tool schemas) */
export const SPECIALIST_KEYS = SPECIALISTS.map((s) => s.key);

// ─── Bringing a specialist in on the first ask ─────────────────────────────

/** The specialist a phrase names in full ("the Google media buyer"), the longest name winning ("Google media buyer" over "media buyer") */
export function specialistNamed(text: string): string | null {
  let best: { key: string; len: number } | null = null;
  for (const s of SPECIALISTS) {
    for (const name of ALIASES[s.key]?.full ?? []) {
      if (new RegExp(String.raw`\b${esc(name)}\b`, "i").test(text) && (!best || name.length > best.len)) best = { key: s.key, len: name.length };
    }
  }
  return best?.key ?? null;
}

const BRING = String.raw`(?:call(?:\s+in|\s+over)?|bring(?:\s+in|\s+on)?|loop(?:\s+in)?|pull(?:\s+in)?|patch(?:\s+in)?|grab|invite|add|get|talk\s+(?:to|with)|speak\s+(?:to|with)|connect\s+(?:me|us)\s+(?:to|with)|put|have)`;
const NOT_NOW = /\b(?:don'?t|do not|no need|not yet|never ?mind|without)\b/i;

/**
 * The specialist the person asked to bring onto the call ("can you call in the Google media buyer so we can talk
 * about Ocean Box?", "get the Email Strategist on", "I want to talk to the copywriter"): that ask is the yes, so it
 * joins straight away with no "shall I?". Not when they say not to, and not "get the buyer to update the client"
 * (that's a task for a teammate).
 */
export function asksToBringIn(text: string): string | null {
  if (NOT_NOW.test(text)) return null;
  const key = specialistNamed(text);
  if (!key) return null;
  const names = (ALIASES[key]?.full ?? []).map(esc).join("|");
  const bring = new RegExp(String.raw`\b${BRING}\b[^.?!]{0,24}?\b(?:the\s+|our\s+|my\s+|a\s+|your\s+)?(?:${names})\b`, "i");
  const join = new RegExp(String.raw`\b(?:${names})\b[^.?!]{0,20}\b(?:on the (?:call|line)|join|hop on|jump in|in here)\b`, "i");
  if (!bring.test(text) && !join.test(text)) return null;
  const task = new RegExp(String.raw`\b(?:get|have)\b[^.?!]{0,24}?(?:${names})\s+to\s+\w`, "i");
  if (task.test(text) && !/\b(?:on the (?:call|line)|join)\b/i.test(text)) return null;
  return key;
}

/**
 * A strategy or expert question for a service line ("what flows can we build for them?", "why is this campaign off?",
 * "what should we test next?"): the specialist for that line answers it, not the assistant. The assistant keeps facts,
 * finding things, the person's own tasks and reminders, quick numbers and routing.
 */
const EXPERT: RegExp[] = [
  /\bwhat\s+(?:[\w'-]+\s+){0,3}(?:can|could|should|would)\s+(?:we|they|you)\s+(?:build|run|test|try|launch|do|change|add|fix|send|set up|make|improve|cut|scale|focus on)\b/i,
  /\bwhy\s+(?:is|are|was|were|did|does|do|has|have)\b[^?]{0,80}\b(?:off|down|dropp?(?:ed|ing)?|low|lower|high|higher|bad|poor|worse|under ?perform\w*|struggl\w*|not\s+(?:working|converting|selling)|tank\w*|declin\w*|spik\w*|slipp\w*|fall\w*)\b/i,
  /\bhow\s+(?:do|can|could|should|would)\s+(?:we|they|you)\s+(?:improve|fix|grow|scale|get|increase|lower|reduce|boost|turn|beat|structure|set up|approach|win)\b/i,
  /\bwhat\s+(?:would|do)\s+you\s+(?:recommend|suggest|test|change|do|try)\b/i,
  /\bshould\s+(?:we|they)\s+(?:test|try|launch|cut|kill|pause|scale|change|build|add|switch|move|raise|lower|increase|drop|run)\b/i,
  /\b(?:ideas?|recommendations?|suggestions?|a (?:strategy|plan|game plan))\s+(?:for|on|to)\b/i,
  /\bwhat(?:'s| is)\s+(?:wrong|going on|off)\s+with\b/i,
];
const ASSISTANT_OWN = /\b(?:today|tomorrow|my day|my list|my plate|on my overview|remind|reminder|note that|take me|open (?:the|my)|where (?:is|do i find))\b/i;

export function isExpertQuestion(text: string): boolean {
  if (ASSISTANT_OWN.test(text)) return false;
  return EXPERT.some((r) => r.test(text));
}

/** Which specialist a screen is about ("the client page, Email tab", "the Email Board") */
export function specialistForScreen(screen: string | null | undefined): string | null {
  const s = String(screen ?? "").toLowerCase();
  if (!s) return null;
  if (/\b(?:email|klaviyo|flows?|sms)\b/.test(s)) return "email_strategist";
  if (/\bgoogle\b/.test(s)) return "google_buyer";
  if (/\b(?:meta|facebook|instagram ads)\b/.test(s)) return "media_buyer";
  if (/\b(?:social|organic|posts?)\b/.test(s)) return "social_strategist";
  if (/\b(?:creative|concepts?)\b/.test(s)) return "creative_director";
  return null;
}

export type DirectRoute = { key: string; why: "asked" | "expert" | "deliverable" };

/**
 * Before the assistant answers: a specialist the person asked for by name joins now; a deliverable to make with them
 * (campaigns, a flow) goes to the line's lead strategist, who runs the flow; a strategy question goes to the
 * specialist for its line (from the words, else the screen they're on). Null: the assistant answers.
 */
export function directSpecialist(text: string, opts: { screen?: string | null } = {}): DirectRoute | null {
  const asked = asksToBringIn(text);
  if (asked) return { key: asked, why: "asked" };
  // Making a deliverable with them ("I need to create campaigns for Candy Cloud"): the line's lead strategist runs it
  const flow = lineForAsk(text);
  if (flow && specialistOf(flow.lead) && emailWritingKind(text) !== "message") return { key: flow.lead, why: "deliverable" };
  if (!isExpertQuestion(text)) return null;
  const key = specialistNamed(text) ?? suggestSpecialist(text)?.key ?? specialistForScreen(opts.screen);
  return key && specialistOf(key) ? { key, why: "expert" } : null;
}

/** They're telling the assistant it talks too long ("keep it short", "you're rambling") */
export const wantsShorter = (text: string) =>
  /\b(?:rambl\w*|too long|too much talking|talk(?:ing)? too much|keep (?:it|things|conversations?|answers?|them) (?:short|brief|tight)|shorter answers?|be (?:more )?(?:brief|concise)|get to the point)\b/i.test(text);
