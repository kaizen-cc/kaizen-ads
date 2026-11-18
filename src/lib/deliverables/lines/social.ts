import type { CopyEmail } from "@/lib/copy-docs/core";
import type { LineConfig, TaskInput } from "../engine";

// The social line (organic content): the Social Strategist leads, the Copywriter writes, one preview document for the
// batch with a section per slide for each post, the approved copy as a Google Doc in the client's HQ Drive under
// "Social Media", and one Asana task per post in the Organic Social Creative project's "Creative Brief" column (spec:
// .review/social-asana-task-spec.md). No assignee or due date (the team sets those); the client's social manager follows.
// Titles: "Organic Social: <Client>- <Format> Request - <Mon DD YYYY>" (the date it will be posted).

export const SOCIAL_PROJECT_GID = "1213604282001906";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-11-12" as "Nov 12 2026" (the team's date in titles); anything else is "TBD" */
export function postDateLabel(day: string | null | undefined) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? ""));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return "TBD";
  return `${MONTHS[Number(m[2]) - 1]} ${m[3]} ${m[1]}`;
}

const FORMAT_LABEL: Record<string, string> = { image: "Single Image", carousel: "Carousel", video: "Video" };
export const socialFormatLabel = (key: string) => FORMAT_LABEL[key] ?? key;

/** "Organic Social: Tejas Brewery- Carousel Request - Nov 12 2026" (the team's own spacing: no space before the hyphen after the client) */
export function socialTaskName(t: Pick<TaskInput, "client" | "kind" | "postDate">) {
  return `Organic Social: ${t.client.name.trim()}- ${socialFormatLabel(t.kind.key)} Request - ${postDateLabel(t.postDate)}`.slice(0, 250);
}

/** The slides of a post document: a section each (heading the slide's name, body the on-image headline then the supporting line), with the visuals from the design notes ("Visual: ...") in slide order */
export function slidesOfPost(e: CopyEmail): NonNullable<TaskInput["slides"]> {
  const visuals = e.designNotes.filter((n) => /^visual\b/i.test(n.trim())).map((n) => n.replace(/^visual\s*\d*\s*[:.-]?\s*/i, "").trim());
  return e.sections.map((s, j) => {
    const [headline = "", ...rest] = s.body.split("\n").map((x) => x.trim()).filter(Boolean);
    return { name: s.heading.replace(/^slide\s*\d+\s*[:.-]?\s*/i, "").trim() || `Slide ${j + 1}`, headline, line: rest.join(" "), visual: visuals[j] ?? "" };
  });
}

const EMOJI: [RegExp, string][] = [
  [/hook|open/i, "👀"],
  [/cta|call to action|close/i, "👉"],
];
const emojiFor = (name: string) => EMOJI.find(([re]) => re.test(name))?.[1] ?? "";

/** The platform and format line: "Instagram Carousel (7 slides)" */
export function socialFormatLine(t: Pick<TaskInput, "kind" | "slides">, network = "Instagram") {
  const n = t.slides?.length ?? 0;
  return `${network} ${socialFormatLabel(t.kind.key)}${t.kind.key === "carousel" && n ? ` (${n} slides)` : ""}`;
}

/** The task's description, in the spec's order: format, date, brief, format line, concept, posting date, a section per slide, the quick links */
export function socialDescription(t: TaskInput): string {
  const slides = t.slides ?? [];
  const date = postDateLabel(t.postDate);
  const title = (t.shortName || t.concept || "").trim();
  const parts = [
    `Format Requested: ${socialFormatLabel(t.kind.key)}`,
    `Date this will be posted: ${date}`,
    `Creative Brief: ${t.client.name.trim().toUpperCase()}: ${title}`,
    `Format: ${socialFormatLine(t)}`,
    `Concept: ${(t.concept || t.purpose).trim()}`,
    `Suggested posting date: ${date === "TBD" ? "To confirm" : date}`,
  ];
  const slideText = slides.map((s, i) => [`SLIDE ${i + 1}: ${s.name.toUpperCase()}${emojiFor(s.name) ? ` ${emojiFor(s.name)}` : ""}`, s.headline, s.line, s.visual ? `Visual: ${s.visual}` : ""].filter(Boolean).join("\n"));
  const links = (t.links ?? []).filter((l) => l.url);
  return [parts.join("\n"), slideText.join("\n____\n"), links.length ? ["Quick Links of the client:", ...links.map((l) => `${l.label}: ${l.url}`)].join("\n") : ""]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 60000);
}

export const SOCIAL_LINE: LineConfig = {
  line: "social",
  label: "Social",
  lead: "social_strategist",
  writer: "copywriter",
  followerSeat: "social_manager",
  kinds: [
    { key: "image", label: "Single Image", max: 7, split: "per_item", words: /\b(?:single images?|static posts?|image posts?|photo posts?)\b/i },
    { key: "carousel", label: "Carousel", max: 7, split: "per_item", words: /\bcarousels?\b/i },
    { key: "video", label: "Video", max: 7, split: "per_item", words: /\b(?:videos?|reels?)\b/i },
  ],
  // Organic content asks ("organic posts for", "social content", "a carousel post for"), not paid ads
  trigger: /\b(?:(?:create|make|build|plan|do|need|write|draft|set up|put together)\b[^.?!]{0,40}\b(?:organic (?:social )?(?:posts?|content|carousels?|reels?|videos?)|social (?:media )?(?:posts?|content|carousels?)|(?:instagram|facebook|tiktok) (?:posts?|carousels?|reels?)|(?:carousel|single image|reel|video) posts?|content for the week)|organic social (?:request|content)\b)/i,
  context: [
    "organic_social and top_posts (engagement, followers and what their best posts did)",
    "social_score (how the account grades and where it's weak)",
    "the content calendar and what's already scheduled or requested (organic_social, open Asana tasks)",
    "the client's rules in the Brand Bible and client memory (voice, never-say, claims)",
    "get_client_context and search_client (the latest Slack, Gmail and call notes, recent conversations)",
    "recent_calls and read_call (what was promised on calls)",
  ],
  brainstorm: "Check the content calendar first so posts don't repeat, vary the formats, tie each to a date worth posting on (holidays, launches, what worked), keep each topic to one line with its posting date.",
  doc: { template: "social", folder: "Social Media" },
  prompts: {
    askCount: (k) => `Ask how many ${k.label.toLowerCase()} posts (up to ${k.max}) and the posting date for each. One short question.`,
    brainstorm: (n) => `Settle the ${n} post${n === 1 ? "" : "s"} with them: the concept, the posting date (record it as the topic's send, as YYYY-MM-DD), and for a carousel how many slides.`,
    draft: (k, cfg) =>
      `Draft every post into ONE preview document (create_copy_doc, kind: social, an entry per post: its name, then one section per slide headed with the slide's name, the body the on-image headline then the supporting line on the next line; design notes "Visual: ..." one per slide in order; brief.goal the concept, brief.send_date the posting date), then ask what they think in a line and hand_off to the ${cfg.lead.replace(/_/g, " ")} for its notes. A ${k.label.toLowerCase()} post is ${k.key === "carousel" ? "5 to 10 slides" : k.key === "video" ? "a few beats (hook, body, close)" : "one frame"}.`,
  },
  asana: {
    project: { gid: SOCIAL_PROJECT_GID },
    section: "Creative Brief",
    taskName: (t) => socialTaskName(t),
    fields: (t) => [
      { name: "Client ID", value: t.client.kaizenId != null ? String(t.client.kaizenId) : "", aliases: ["CLIENT ID", "Client #", "Kaizen ID"] },
      { name: "Priority", value: t.urgency, aliases: ["Urgency"] },
    ],
    description: socialDescription,
  },
  kaizenRequests: false,
  tools: { request: "create_social_request", update: "update_social_request" },
};
