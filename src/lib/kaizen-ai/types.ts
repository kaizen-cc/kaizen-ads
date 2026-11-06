// Kaizen AI, the team's chat: the shapes shared by the server (route, tools) and the browser (the chat screen).

export type AiModel = "opus" | "sonnet";

/** The agents that can answer in Kaizen AI (a subset of the app's agents; each brings its core, skills and playbook) */
export const CHAT_AGENTS = ["strategist", "auditor", "google_auditor", "copy", "scripts", "creativereview", "reporter", "google_reporter"] as const;
export type ChatAgent = (typeof CHAT_AGENTS)[number];

export const AGENT_LABEL: Record<ChatAgent, string> = {
  strategist: "Strategist",
  auditor: "Media Buyer",
  google_auditor: "Google Ads Buyer",
  copy: "Copywriter",
  scripts: "Scriptwriter",
  creativereview: "Creative Director",
  reporter: "Reporter (Meta)",
  google_reporter: "Reporter (Google)",
};

export type AttachmentKind = "image" | "pdf" | "doc" | "text" | "video";
export type Attachment = {
  path: string; // in the ai-files bucket
  name: string;
  mime: string;
  bytes: number;
  kind: AttachmentKind;
  /** Videos: frames captured in the browser (paths) with their time, and the audio for the transcript */
  frames?: { ms: number; path: string }[];
  audio?: string | null;
  /** Filled in by the server the first time it's read: a video's transcript, a document's text */
  transcript?: string | null;
  text?: string | null;
  note?: string | null;
  /** Came with a Claude import: no stored file (path is empty), only the text Claude read from it */
  imported?: boolean;
};

/** What an attached file is, from its type and name */
export function kindOf(mime: string, name: string): AttachmentKind | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (/^image\/(jpeg|png|gif|webp)$/.test(mime)) return "image";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (mime.startsWith("video/") || ["mp4", "mov", "webm", "m4v"].includes(ext)) return "video";
  if (["docx", "xlsx", "pptx"].includes(ext)) return "doc";
  if (mime.startsWith("text/") || ["csv", "tsv", "txt", "md", "json"].includes(ext)) return "text";
  return null;
}

/** The most a person can attach to one message */
export const MAX_FILES = 10;
export const MAX_BYTES: Record<AttachmentKind, number> = { image: 10_000_000, pdf: 32_000_000, doc: 30_000_000, text: 5_000_000, video: 500_000_000 };

export type ToolRun ={ id: string; name: string; label: string; ok: boolean | null; ms?: number; summary?: string };

// ─── Rich cards a tool can return ───────────────────────────────────────────

export type MetricsRow = { name: string; spend: number; results: number | null; cpr: number | null; roas: number | null; ctr: number | null; cpm: number | null; freq: number | null; clicks: number | null; impressions: number | null; note?: string | null };
export type MetricsCard = {
  type: "metrics";
  client: string;
  platform: "meta" | "google";
  title: string;
  range: string;
  kpi: { label: string; target: number | null; roas: boolean; value: number | null; status: string | null } | null;
  budget: { budget: number; spent: number; projected: number; pace: number; status: string } | null;
  windows: { label: string; spend: number; results: number; value: number | null }[];
  rows: MetricsRow[];
  level: string;
};
export type CopyField = { text: string; limit: number | null };
export type CopyCard = {
  type: "copy";
  client: string | null;
  platform: "meta" | "google";
  meta?: { angle: string; primaryText: string; headline: CopyField; description: CopyField; cta: string }[];
  google?: { headlines: CopyField[]; descriptions: CopyField[]; sitelinks: { text: CopyField; line1: CopyField; line2: CopyField }[]; callouts: CopyField[] };
  flags: string[];
};
export type BriefCard = {
  type: "brief";
  client: { id: string; name: string; slug: string };
  title: string;
  formats: { format: "image" | "video" | "carousel"; new: number; variations: number }[];
  angle: string;
  audience: string;
  brief: string;
  landing: string;
  /** The prefilled request form (send to the board, or to Asana from there) */
  href: string;
};
export type LinkCard = { type: "link"; title: string; detail: string; href: string; cta: string; external?: boolean };
export type PlanCard = { type: "plan"; id: string; client: string; platform: string; instruction: string };
export type ListCard = { type: "list"; title: string; items: { title: string; detail?: string; tone?: "ok" | "warn" | "bad" | null; href?: string | null; when?: string | null }[] };
/** A launch from a launch sheet: read, checked, asked about, planned and created on the card */
export type LaunchCardRef = { type: "launch"; id: string; client: string };
export type Card = MetricsCard | CopyCard | BriefCard | LinkCard | PlanCard | ListCard | LaunchCardRef;

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments: Attachment[];
  tools: ToolRun[];
  cards: Card[];
  agent_key: string | null;
  model: string | null;
  error: string | null;
  stopped: boolean;
  created_at: string;
};

export type Thread = {
  id: string;
  title: string;
  client_id: string | null;
  client_confirmed: boolean;
  agent_key: string | null;
  model: AiModel;
  pinned: boolean;
  shared_with: string[];
  last_message_at: string;
  profile_id: string;
  clients?: { name: string; slug: string } | null;
  /** "claude" when imported from Claude (with the import it came in) */
  source?: string | null;
  import_id?: string | null;
  created_at?: string;
};

/** What the chat route streams back, one JSON object per line */
export type ChatEvent =
  | { t: "thread"; id: string; title: string; created: boolean }
  | { t: "user"; id: string }
  | { t: "agent"; key: ChatAgent; label: string; why: string }
  | { t: "client"; id: string; name: string; slug: string; confirmed: boolean }
  | { t: "text"; d: string }
  | { t: "tool"; run: ToolRun }
  | { t: "card"; card: Card }
  | { t: "title"; title: string }
  | { t: "done"; id: string; stopped?: boolean }
  | { t: "error"; message: string; id?: string };
