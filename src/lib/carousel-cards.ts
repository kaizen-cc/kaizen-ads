import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AGENCY_SYSTEM, askJson, clientContext, contextBlock, getAgent } from "@/lib/ai";
import type { Ad } from "@/lib/copy";
import { currentCreative } from "@/lib/creative-review";

// Carousel tickets: besides the copy set (the primary texts every carousel shares), each card gets its own headline
// and short description, written by the Copywriter looking at the cards themselves. Kept on the copy set as
// {designId: [{headline, description}]} in card order; copy review edits them, and the launcher puts them on the cards.

export type Card = { headline: string; description: string };
export type Cards = Record<string, Card[]>;
export const CARD_LIMITS = { headline: 40, description: 20 } as const;

/** Each carousel design on the ticket with its cards in order. */
export async function carouselDesigns(admin: SupabaseClient, requestId: string) {
  const { designs } = await currentCreative(admin, requestId);
  return designs
    .map((d) => ({ id: d.id, position: d.position, name: d.name, cards: d.files.filter((f) => f.card != null && f.card > 0).sort((a, b) => (a.card ?? 0) - (b.card ?? 0)) }))
    .filter((d) => d.cards.length);
}

const SCHEMA = {
  type: "object",
  properties: { cards: { type: "array", items: { type: "object", properties: { headline: { type: "string" }, description: { type: "string" } }, required: ["headline", "description"], additionalProperties: false } } },
  required: ["cards"],
  additionalProperties: false,
};

/** Writes the card headlines and descriptions for every carousel on the ticket (or just one design) and saves them. */
export async function draftCards(admin: SupabaseClient, requestId: string, only?: string) {
  const [{ data: r }, { data: set }, designs] = await Promise.all([
    admin.from("requests").select("client_id, title, brief, landing_url").eq("id", requestId).single(),
    admin.from("copy_sets").select("id, ads, cards").eq("request_id", requestId).maybeSingle(),
    carouselDesigns(admin, requestId),
  ]);
  if (!r || !set) return {};
  const [ctx, { sources }] = await Promise.all([clientContext(admin, r.client_id as string), getAgent("copy")]);
  if (!ctx) return {};
  const cards: Cards = { ...((set.cards ?? {}) as Cards) };
  const voice = ((set.ads ?? []) as Ad[]).slice(0, 3).map((a) => `- ${a.headline} · ${a.primaryText}`).join("\n");
  for (const d of designs.filter((x) => !only || x.id === only)) {
    const images: { mediaType: "image/webp"; data: string }[] = [];
    for (const f of d.cards.slice(0, 10)) {
      if (!f.thumb_path) continue;
      const { data } = await admin.storage.from("creative").download(f.thumb_path);
      if (data) images.push({ mediaType: "image/webp", data: Buffer.from(await data.arrayBuffer()).toString("base64") });
    }
    const out = await askJson<{ cards: Card[] }>({
      agent: "copy",
      label: `carousel cards ${ctx.name}`,
      system: AGENCY_SYSTEM,
      schema: SCHEMA,
      images,
      maxTokens: 2000,
      prompt: `${contextBlock(ctx, undefined, sources)}

<ticket>
${r.title}
Landing page: ${r.landing_url ?? "not set"}
Brief: ${String(r.brief ?? "").slice(0, 2500)}
</ticket>

<approved_copy>
The primary text and headlines this carousel runs with. Match this voice; don't repeat it word for word.
${voice || "(none yet)"}
</approved_copy>

The ${images.length} pictures are the ${d.cards.length} cards of the carousel "${d.name}", in order. Write each card's headline and description, in that order: exactly ${d.cards.length} cards.
- headline: max ${CARD_LIMITS.headline} characters; what this card shows or promises, so the carousel reads as a sequence (the first card hooks, the last asks for the click).
- description: max ${CARD_LIMITS.description} characters, or "" when the headline says it all.
- Never repeat the on-card text word for word. No emojis unless the client's voice uses them.`,
    });
    cards[d.id] = d.cards.map((_, i) => ({ headline: (out.cards[i]?.headline ?? "").trim().slice(0, 60), description: (out.cards[i]?.description ?? "").trim().slice(0, 40) }));
  }
  await admin.from("copy_sets").update({ cards }).eq("id", set.id);
  return cards;
}
