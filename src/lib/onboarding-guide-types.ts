// The client's onboarding guide in their portal: what each step holds, and the styles and pacing they pick from.
// Shared by the server and the guide.

export type MetaStep = { status?: "todo" | "done" | "verified" | "on_call"; at?: string; by?: string; account?: string | null; accountName?: string | null; page?: string | null; pageName?: string | null; typed?: string | null; note?: string | null; checkedAt?: string };
export type GoogleStep = { status?: "todo" | "sent" | "invited" | "verified" | "on_call" | "none"; account?: string | null; at?: string; by?: string; note?: string | null; checkedAt?: string };
export type AssetsStep = { files?: number; links?: number; at?: string; by?: string; drive?: "saved" | "kept here" | null };
export type StyleStep = { styles?: string[]; pacing?: string | null; liked?: { image: string; label: string }[]; note?: string; at?: string; by?: string };
export type Guide = { meta: MetaStep; google: GoogleStep; assets: AssetsStep; style: StyleStep };

/** The looks a client can pick (as many as fit), each with what it means for the creative team */
export const STYLES = [
  { key: "ugc", name: "Real people, phone-shot", line: "Customers or creators talking to camera, like a friend's story", brief: "UGC: real people filmed on a phone, talking to camera" },
  { key: "founder", name: "Founder or team story", line: "The face behind the business, why it exists", brief: "Founder/team-led: the owner or staff on camera telling the story" },
  { key: "testimonial", name: "Reviews and results", line: "What customers say, before and after, proof", brief: "Testimonial/social proof: reviews, results, before and after" },
  { key: "demo", name: "Show it working", line: "The product or service in action, step by step", brief: "Demo: the product or service in use, close up" },
  { key: "lifestyle", name: "Lifestyle", line: "The life your customer wants, with you in it", brief: "Lifestyle: aspirational scenes with the product or place" },
  { key: "studio", name: "Clean and premium", line: "Studio light, simple backgrounds, polished", brief: "Studio/premium: clean, polished product or place shots" },
  { key: "bold", name: "Bold text and graphics", line: "Big headlines, motion graphics, offers that pop", brief: "Text-led/motion graphics: bold headlines and animated text" },
  { key: "trend", name: "Fun and trending", line: "Memes, trends and humor that feel native to the feed", brief: "Native/trend: humor, memes and trending formats" },
] as const;

export const PACING = [
  { key: "fast", name: "Fast", line: "Quick cuts every second or two, high energy", brief: "Fast pacing: cuts every 1-2 seconds" },
  { key: "medium", name: "Steady", line: "A clear story with room to breathe", brief: "Medium pacing: 2-4 second shots" },
  { key: "slow", name: "Slow and cinematic", line: "Long, calm shots that let it sink in", brief: "Slow, cinematic pacing: long, calm shots" },
] as const;

/** Which steps a client has, from what they buy: Meta access if we run their Meta ads, Google if Google, the look if
 *  we run ads or make their creative; their assets always */
export function guideSteps(services: string[]) {
  return { meta: services.includes("facebook-ads"), google: services.includes("google-ads"), looks: services.includes("facebook-ads") || services.includes("creative") || services.includes("tiktok-ads") };
}

/** Steps done, out of the steps they have */
export function guideProgress(g: Guide, has: { meta: boolean; google: boolean; looks: boolean }) {
  const steps = [
    ...(has.meta ? [["verified", "done", "on_call"].includes(g.meta.status ?? "")] : []),
    ...(has.google ? [["sent", "invited", "verified", "on_call", "none"].includes(g.google.status ?? "")] : []),
    Boolean((g.assets.files ?? 0) + (g.assets.links ?? 0)),
    ...(has.looks ? [Boolean(g.style.styles?.length || g.style.pacing)] : []),
  ];
  return { done: steps.filter(Boolean).length, total: steps.length };
}
