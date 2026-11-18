import { MAX_VARIATIONS } from "@/lib/allotment";
import type { AsanaDraft, AsanaFormat } from "@/lib/asana-request";
import type { CopyContent } from "@/lib/copy-docs/core";
import type { LineConfig, TaskInput } from "../engine";

// The creative line (paid ad creative requests): the Creative Director leads, the Copywriter writes, one preview
// document per concept in the creative brief's own structure (hook, concept, script or frames, copy, sizes, call to
// action, references). On approval the request goes through the EXISTING creative request path (src/lib/asana-request.ts:
// the request form's "Send to Asana"), so the task lands exactly like one made there: the Creative Brief column, the
// Client ID field, the designer or video editor assigned, counted once in the allotment, marked made in Kaizen OS.
// One concept per brief: the count is its versions (one new plus variations), every version counted. The creative board
// is not operated in Kaizen OS yet, so Kaizen OS requests stay "coming soon": briefs only.

const FORMAT_WORD: Record<string, string> = { image: "Image", video: "Video", carousel: "Carousel" };
/** One concept holds its first version and up to MAX_VARIATIONS variations of it */
export const MAX_VERSIONS = 1 + MAX_VARIATIONS;

/** The task's name, the way the request form's tasks are named (kept in step with planAsanaRequest by a test) */
export function creativeTaskName(t: Pick<TaskInput, "client" | "kind" | "shortName" | "count" | "urgency">) {
  const urgent = t.urgency === "urgent";
  return `${urgent ? "URGENT: " : ""}Meta Ads - Need a new creative - ${t.client.name} - ${FORMAT_WORD[t.kind.key] ?? t.kind.label}${t.count > 1 ? ` (x${t.count})` : ""}${t.shortName.trim() ? ` - ${t.shortName.trim()}` : ""}`.slice(0, 250);
}

const SIZES_LINE = "Sizes: 4:5 and 9:16 only";
const URL_RE = /https?:\/\/[^\s)>\]"']+/g;

/** The labelled sections of a concept document, read back by heading ("Hook", "Concept", "Script", "Frames", "Copy", "Platform") */
export function sectionOf(c: CopyContent, re: RegExp) {
  const e = c.emails[0];
  return e?.sections.filter((s) => re.test(s.heading.trim())).map((s) => s.body).join("\n").trim() ?? "";
}

/** The slides or frames the brief builds on (a carousel's cards), each a section headed "Slide n", "Card n" or "Frame n" */
export const framesOf = (c: CopyContent) => (c.emails[0]?.sections ?? []).filter((s) => /^(?:slide|card|frame|beat)\b/i.test(s.heading.trim()));

/** The brief text the creative team reads in the task ("Anything Specific to focus on"): the document in the brief's structure */
export function creativeBriefText(c: CopyContent, p: { kind: string; platform?: string | null } = { kind: "image" }) {
  const e = c.emails[0];
  const b = c.brief;
  const frames = framesOf(c);
  const hook = sectionOf(c, /^hook/i);
  const concept = sectionOf(c, /^concept|^idea|^insight/i);
  const script = sectionOf(c, /^script|^voice/i);
  const copy = (e?.sections ?? []).filter((s) => /^(?:copy|primary|headline|description)/i.test(s.heading.trim()));
  const platform = p.platform || sectionOf(c, /^platform/i);
  return [
    b.goal ? `Goal: ${b.goal}` : "",
    hook ? `Hook: ${hook}` : "",
    concept ? `Concept: ${concept}` : "",
    script ? `Script: ${script}` : "",
    ...(frames.length ? [`${p.kind === "video" ? "Beats" : "Frames"}:`, ...frames.map((f) => `- ${f.heading}: ${f.body.replace(/\n+/g, " / ")}`)] : []),
    ...(copy.length ? ["Copy:", ...copy.map((s) => `- ${s.heading}: ${s.body.replace(/\n+/g, " / ")}`)] : []),
    e?.cta ? `Call to action: ${e.cta.label}` : "",
    platform ? `Platform: ${platform}` : "",
    SIZES_LINE,
    b.rules.length ? `Rules: ${b.rules.join("; ")}` : "",
    b.assets ? `Assets: ${b.assets}` : "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 6000);
}

/** The links in the document (references, landing page), for the request's References */
export function creativeRefs(c: CopyContent): string {
  const text = [c.brief.designDirection, c.brief.assets, ...(c.emails[0]?.designNotes ?? [])].join(" ");
  return [...new Set(text.match(URL_RE) ?? [])].slice(0, 20).join(" ");
}

/**
 * The request the form would send for an approved concept: one format, the versions asked for (a first new one plus
 * variations), 4:5 and 9:16 only, the angle and audience from the agreed topic and the document's brief. Pure: handed to
 * the existing sendAsanaRequest unchanged.
 */
export function creativeDraft(p: { clientId: string; kind: string; count: number; content: CopyContent; angle: string; avatar?: string; urgency: "urgent" | "high" | "normal" | "low"; landing?: string | null }): AsanaDraft {
  const format = (p.kind === "video" || p.kind === "carousel" ? p.kind : "image") as AsanaFormat;
  const versions = Math.min(MAX_VERSIONS, Math.max(1, Math.round(p.count)));
  const cards = format === "carousel" ? Math.max(2, framesOf(p.content).length || 5) : undefined;
  return {
    clientId: p.clientId,
    title: p.content.shortName || p.content.title,
    formats: { [format]: { new: 1, variations: versions - 1, ...(cards ? { cards } : {}) } },
    sizes: ["4x5", "9x16"],
    angle: p.angle || p.content.title,
    ...(p.avatar ? { avatar: p.avatar } : {}),
    audience: p.content.brief.audience || "To confirm",
    brief: creativeBriefText(p.content, { kind: format }),
    refs: creativeRefs(p.content),
    ...(p.landing ? { landing: p.landing } : {}),
    priority: p.urgency,
  };
}

export const CREATIVE_LINE: LineConfig = {
  line: "creative",
  label: "Creative",
  lead: "creative_director",
  writer: "copywriter",
  // The client's buyer follows; the head of creative collaborates on every request
  followerSeat: "meta_buyer",
  collaborators: ["head_of_creative"],
  kinds: [
    { key: "image", label: "Static", max: MAX_VERSIONS, split: "per_doc", words: /\b(?:statics?|single images?|images?|graphics?|banners?)\b/i },
    { key: "carousel", label: "Carousel", max: MAX_VERSIONS, split: "per_doc", words: /\bcarousels?\b/i },
    { key: "video", label: "Video", max: MAX_VERSIONS, split: "per_doc", words: /\b(?:videos?|ugc|reels?)\b/i },
  ],
  // Paid ad creative asks ("a creative request", "new ad creative", "carousel ads for"), not briefs or organic posts
  trigger: /\b(?:(?:create|make|build|plan|do|need|write|draft|set up|put together|request)\b[^.?!]{0,40}\b(?:(?:new |paid |meta |ad )?creative request|ad creatives?|(?:static|carousel|video|ugc|image) ads?|new ads? for|creatives? for)|creative request for)\b/i,
  context: [
    "winners_and_fatigue (the account's winning ads and what's wearing out)",
    "creative_allotments and the KPI status (the month's allotment and its weekly pace)",
    "creative_assessment and the angles and avatars in the Brand Bible (what's been tested)",
    "get_client_context and search_client (the latest Slack, Gmail and call notes, recent conversations)",
    "recent_calls and read_call (what was promised on calls and not yet briefed)",
    "open creative requests on the board and in Asana (never repeat one that's in flight)",
  ],
  brainstorm: "One concept per brief: every version counts toward the allotment, a carousel once per slide, resizes are free. Build on a winner or fill an untested angle, name the avatar (Brand Bible or a new one under test), keep it to one line per concept.",
  doc: { template: "creative", folder: "Ad Creative Briefs" },
  prompts: {
    askCount: (k) => `Ask the platform (Meta unless they say otherwise) and how many versions of the ${k.label.toLowerCase()} concept, a first new one plus variations (up to ${k.max}). One concept per brief. One short question.`,
    brainstorm: (n) => `Settle the concept with them (${n} version${n === 1 ? "" : "s"}): angle, avatar, the hook, what to show and the call to action.`,
    draft: (k, cfg) =>
      `Write ONE concept brief into a preview document (create_copy_doc, kind: creative, one entry): sections headed Hook, Concept, ${k.key === "video" ? "Script" : k.key === "carousel" ? "Slide 1, Slide 2 and so on" : "Frame"}, Copy (primary text, headline), Platform; one button (the call to action); design notes for references and links; brief.goal, brief.audience. Sizes are 4:5 and 9:16 only. Then ask what they think in a line and hand_off to the ${cfg.lead.replace(/_/g, " ")} for its notes.`,
  },
  asana: {
    // The request form's own path decides the project and column; these are what it shows
    project: { nameLike: /creative/i },
    section: "Creative Brief",
    via: "creative_form",
    taskName: (t) => creativeTaskName(t),
    fields: (t) => [
      { name: "Client ID", value: t.client.kaizenId != null ? String(t.client.kaizenId) : "" },
      ...(t.urgency === "urgent" || t.urgency === "high" ? [{ name: "Priority", value: t.urgency === "urgent" ? "URGENT" : "HIGH" }] : []),
    ],
  },
  // The creative board isn't operated in Kaizen OS yet: briefs only, requests go to Asana through the form's path
  kaizenRequests: false,
  tools: { request: "create_creative_request", update: "update_creative_request" },
};
