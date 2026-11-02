// The client presentation's shape, shared by the server and the deck the client sees

/** Kaizen's marketing intake form (it asks for the client's Client ID) */
/** Clients who signed (or came back) from this day go through the new onboarding: Bible, presentation, review, then
 * the first round. Anyone onboarding before it keeps the old flow (first round at the intake). */
export const FLOW_START = "2026-11-02";
export const inNewFlow = (c: { created_at?: string | null; reonboarded_at?: string | null }) => (c.created_at ?? "") >= FLOW_START || (c.reonboarded_at ?? "") >= FLOW_START;

export const INTAKE_FORM_URL = "https://forms.gle/m3WUwbrprQ1Fc1KF8";

export type Deck = {
  headline: string;
  intro: string;
  brand: { statement: string; different: string[] };
  goal: { line: string; measure: string };
  audiences: { name: string; who: string; wants: string; hook: string }[];
  voice: { words: string[]; sounds: string; never: string[] };
  ideas: { title: string; hook: string; why: string; format: "image" | "video" | "carousel" }[];
  launch: { fast: string; wait: string };
  questions: { question: string; why: string }[];
};

/** The sections a client reacts to, in order */
export const SECTIONS = ["brand", "goal", "audiences", "voice", "ideas"] as const;
export type Section = (typeof SECTIONS)[number];
export type Reactions = {
  sections?: Partial<Record<Section, { verdict: "right" | "off"; note: string; at: string; by: string }>>;
  answers?: Record<string, { answer: string; at: string; by: string }>;
  launch?: { choice: "engagement_first" | "wait"; at: string; by: string };
  /** Their customer list for lookalikes, shared in the portal (kept private; never read by the AI) */
  customerList?: { name: string; rows: number | null; at: string; by: string };
  /** Lasting facts from the conversation, for the Bible and the client's memory */
  facts?: { kind: "prefer" | "avoid" | "note"; text: string; at: string }[];
};
