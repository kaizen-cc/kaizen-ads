import { baseRole, type TeamRole } from "@/lib/roles";
import { AGENT_LABEL, CHAT_AGENTS, type ChatAgent } from "./types";

// Which agent answers a message in Kaizen AI: what the message is about first (copy goes to the copywriter, a creative
// assessment to the creative director, Google work to the Google buyer, audits, reports, strategy), else the person's
// own role. Read from the words, without an AI call, so it's instant; the person can switch it with the chip.

/** The agent for someone's role, when the message doesn't say otherwise */
export function agentForRole(role: TeamRole): ChatAgent {
  switch (baseRole(role)) {
    case "head_of_meta":
    case "media_buyer":
      return "auditor";
    case "head_of_google":
    case "google_buyer":
      return "google_auditor";
    case "head_of_creative":
    case "graphic_designer":
      return "creativereview";
    case "video_editor":
      return "scripts";
    case "copywriter":
      return "copy";
    default:
      return "strategist";
  }
}

const GOOGLE = /\b(google|search terms?|keywords?|rsa|responsive search|sitelinks?|callouts?|pmax|performance max|quality score|impression share|gaql|negatives?)\b/i;

/** The agent for this message, and why (shown on the chip) */
export function pickAgent(text: string, role: TeamRole): { key: ChatAgent; why: string } {
  const t = text.toLowerCase();
  const google = GOOGLE.test(t) || role === "google_buyer" || role === "head_of_google";
  if (/\b(script|shot list|storyboard|hooks?\b.*video|voice ?over|\bvo\b|elevenlabs|ugc|avatar|higgsfield|video prompts?|image prompts?)\b/i.test(t)) return { key: "scripts", why: "scripts and video" };
  if (/\b(creative (assessment|review|feedback)|assess (this|the|these) (creative|design|ad|video)|review (this|these|the) (design|creative|ad|video)s?|brand bible check|on.brand)\b/i.test(t)) return { key: "creativereview", why: "creative assessment" };
  if (/\b(report|recap|weekly update|monthly update|monday report)s?\b/i.test(t)) return { key: google && !/\bmeta\b/i.test(t) ? "google_reporter" : "reporter", why: "reporting" };
  if (/\b(audit|account check|daily check|health check|what('s| is) wrong|troubleshoot|diagnos)/i.test(t)) return { key: google && !/\bmeta\b/i.test(t) ? "google_auditor" : "auditor", why: "account check" };
  if (/\b(copy|headlines?|primary text|captions?|descriptions?|ad text|rewrite|clean up|grammar|sitelinks?|callouts?|rsa)\b/i.test(t)) return { key: "copy", why: "copywriting" };
  if (GOOGLE.test(t)) return { key: "google_auditor", why: "Google Ads" };
  if (/\b(strategy|strategi[sz]e|plan|angles?|positioning|go.to.market|offer|funnel|roadmap|ideas?)\b/i.test(t)) return { key: "strategist", why: "strategy" };
  return { key: agentForRole(role), why: "your role" };
}

export const isChatAgent = (k: string | null | undefined): k is ChatAgent => Boolean(k) && (CHAT_AGENTS as readonly string[]).includes(k!);
export const agentLabel = (k: string | null | undefined) => (isChatAgent(k) ? AGENT_LABEL[k] : "Kaizen AI");

// ─── Quick actions ──────────────────────────────────────────────────────────

export type QuickAction = { id: string; title: string; prompt: string; group: "buyer" | "google" | "creative" | "copy" | "everyone"; needsClient?: boolean };

/** Built-in quick actions; {client} is filled with the pinned client's name (or asked for) */
export const QUICK_ACTIONS: QuickAction[] = [
  { id: "daily-check", group: "buyer", title: "Daily account check", needsClient: true, prompt: "Run my daily account check on {client}: the last 1, 3 and 7 days against the KPI target and the monthly budget pacing, any CPA or ROAS drop, frequency creeping up, and ads that are tiring. End with what I should do today, most important first." },
  { id: "monday-reports", group: "buyer", title: "Draft Monday reports", prompt: "Draft this Monday's weekly report for {client}. Pull the last 7 days, say what changed against the week before and against target, and give me the link to review it." },
  { id: "what-changed", group: "buyer", title: "What changed on {client}?", needsClient: true, prompt: "What changed on {client} in the last 7 days and why? Give exact dates: changes in the ad account, launches, what the client said in Slack, email and calls, what we promised, and anything still waiting on us." },
  { id: "search-terms", group: "google", title: "Search term review", needsClient: true, prompt: "Review the search terms for {client} over the last 14 days: what's spending without converting (negatives to add, with match type), what's converting that isn't a keyword yet, and any wasted spend by theme. Plan the changes for me to confirm." },
  { id: "rsa-copy", group: "google", title: "Write RSA copy", needsClient: true, prompt: "Write Google responsive search ad copy for {client}: 15 headlines (30 characters max), 4 descriptions (90 max), 4 sitelinks with descriptions and 6 callouts, in their tone and following Google's policies." },
  { id: "creative-assessment", group: "creative", title: "Creative assessment", prompt: "Give me a creative assessment of what I've attached for {client}: against their Brand Bible, the brief, Meta's policies and what's been winning. What to fix before it goes out, what to watch, what works." },
  { id: "script-shotlist", group: "creative", title: "Script, shot list and hooks from a brief", prompt: "From this brief for {client}, write the video script: five hook options (first 3 seconds, on-screen text and spoken line), the beats with on-screen text, the shot list, and the call to action.\n\nBrief: " },
  { id: "vo-script", group: "creative", title: "VO script for ElevenLabs", prompt: "Write a voiceover script for {client} ready to paste into ElevenLabs: natural spoken lines, pauses marked with <break time=\"0.5s\" />, emphasis written into the words, about 30 seconds, plus the voice direction (tone, pace, age, accent).\n\nWhat it's for: " },
  { id: "ai-prompts", group: "creative", title: "AI image and video prompts", prompt: "Write AI generation prompts for {client}: three image prompts and three short video prompts (subject, setting, camera, light, style, aspect 4:5 or 9:16), plus an AI avatar script if it fits, all on brand.\n\nThe idea: " },
  { id: "copy-from-brief", group: "copy", title: "Write copy from a brief", prompt: "Write the Meta ad copy for {client} from this brief, in their tone: three angles, each with primary text, a headline (40 characters max) and a description, plus the call to action.\n\nBrief: " },
  { id: "rewrite", group: "everyone", title: "Rewrite or clean up my message", prompt: "Clean this up: fix the grammar, make it clear and friendly, keep my meaning and roughly my length. Give me just the rewritten version.\n\n" },
];

/** The quick action groups each role sees first (everyone sees the rest under More) */
export function groupsFor(role: TeamRole): QuickAction["group"][] {
  switch (baseRole(role)) {
    case "media_buyer":
    case "head_of_meta":
      return ["buyer", "copy", "everyone"];
    case "google_buyer":
    case "head_of_google":
      return ["google", "buyer", "everyone"];
    case "graphic_designer":
    case "video_editor":
    case "head_of_creative":
      return ["creative", "everyone"];
    case "copywriter":
      return ["copy", "creative", "everyone"];
    default:
      return ["buyer", "creative", "copy", "everyone"];
  }
}
