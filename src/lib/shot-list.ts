import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson, clientContext, contextBlock } from "@/lib/ai";
import { assetsBlock, loadAssets } from "@/lib/client-assets";

// Next month's shot list for a client: the photos and clips to ask them for so the creative we plan can be made,
// from what's planned and winning, minus what's already on Drive. Written for the account's buyer or lead to send.

export type ShotList = {
  month: string; // "November 2026"
  intro: string; // the opening lines of the message to the client
  shots: { what: string; format: "photo" | "video"; specs: string; why: string }[];
  have: string[]; // what we already have and will use, so we don't ask for it
  closing: string;
};

const S = { type: "string" };
const SCHEMA = {
  type: "object",
  properties: {
    intro: S,
    shots: { type: "array", items: { type: "object", properties: { what: S, format: { type: "string", enum: ["photo", "video"] }, specs: S, why: S }, required: ["what", "format", "specs", "why"], additionalProperties: false } },
    have: { type: "array", items: S },
    closing: S,
  },
  required: ["intro", "shots", "have", "closing"],
  additionalProperties: false,
};

const SYSTEM = `You write a client's monthly shot list for Kaizen Marketing, a paid social agency: the photos and short clips to ask the client for so next month's ads can be made. You get everything known about the client (offers, what's winning, the strategy, upcoming events and promotions, open work) and what's already on their Drive.
Ask only for what we don't have and will actually use: the angles and offers coming up, fresh versions of what's winning (ads wear out, so new footage of the same thing counts), and anything their briefs keep needing. Skip what Drive already covers well and recently (list those in have, a few words each).
6 to 12 shots. Each: what (specific and filmable by someone with a phone: who, what, where, e.g. "Owner pulling a fresh pizza from the oven, close up, steam visible"), format (photo or video), specs (orientation and length, e.g. "vertical, 5–10s"; photos "vertical and square, natural light"), why (a few words for the client on what it's for, e.g. "for the Black Friday bundle ads").
intro: 2 sentences to the client, warm and plain, in Kaizen's voice: what this is and why it helps their ads. closing: one line on how to send it (their shared Drive folder) and by when (the first week of the month). No emojis, no jargon, no internal details (no allotments, KPIs, team names).`;

const monthName = (d: Date) => d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "America/New_York" });

export async function writeShotList(admin: SupabaseClient, clientId: string, by: string) {
  const [ctx, assets] = await Promise.all([clientContext(admin, clientId), loadAssets(admin, clientId)]);
  if (!ctx) throw new Error("Client not found");
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const out = await askJson<Omit<ShotList, "month">>({
    agent: "strategist",
    label: "monthly shot list",
    system: SYSTEM,
    schema: SCHEMA,
    maxTokens: 6000,
    prompt: `${contextBlock(ctx)}\n\n${assetsBlock(assets)}\n\nWrite the shot list for ${monthName(next)}.`,
  });
  const list: ShotList = { month: monthName(next), ...out, shots: out.shots.slice(0, 14) };
  const { data } = await admin.from("shot_lists").insert({ client_id: clientId, month: next.toISOString().slice(0, 10), list, created_by: by }).select("id, created_at").single();
  return { id: data?.id as string, list, createdAt: data?.created_at as string };
}
