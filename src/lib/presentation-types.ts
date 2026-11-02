// The client presentation's shape, shared by the server and the deck the client sees

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
};
