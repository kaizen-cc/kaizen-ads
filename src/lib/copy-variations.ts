import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AGENCY_SYSTEM, askJson, clientContext, contextBlock, getAgent } from "@/lib/ai";
import { COPY_LIMITS, KIND_LABEL, limitOf, lineForAi, type CopyLine } from "@/lib/copy-library-core";
import { copyContext } from "@/lib/copy-library";

// "Make variations" in the Copy library: the Copywriter writes new versions of a proven line in the client's voice,
// from the Brand Bible and everything known about the client, with the winning line as the model, inside Meta's
// character limits (Google's on Google copy, keeping a pinned headline's position), each with why it should work. Kept on the line so the team can come back to them.

export type Variation = { text: string; reason: string; chars: number };

const SCHEMA = {
  type: "object",
  properties: { variations: { type: "array", items: { type: "object", properties: { text: { type: "string" }, reason: { type: "string" } }, required: ["text", "reason"], additionalProperties: false } } },
  required: ["variations"],
  additionalProperties: false,
} as const;

/** The most a variation of this line may run to: Meta's limit for headlines and descriptions, the line's own form for primary text */
export function limitFor(line: Pick<CopyLine, "kind" | "text"> & { platform?: CopyLine["platform"] }) {
  const hard = limitOf(line.platform ?? "meta", line.kind);
  if (hard != null) return hard;
  return line.text.length <= 300 ? 300 : Math.max(line.text.length * 1.3, 600);
}

export async function writeVariations(admin: SupabaseClient, o: { clientId: string; line: CopyLine & { roasKpi?: boolean }; n: number; note?: string | null; by: string | null }) {
  const n = Math.max(1, Math.min(10, Math.round(o.n) || 5));
  const max = Math.round(limitFor(o.line));
  const google = o.line.platform === "google";
  const [ctx, { sources, model }, copy] = await Promise.all([clientContext(admin, o.clientId), getAgent("copy"), copyContext(admin, o.clientId, 14_000, google ? "google" : "meta").catch(() => "")]);
  if (!ctx) throw new Error("Client not found.");
  const kind = KIND_LABEL[o.line.kind].toLowerCase();
  const pin = o.line.pinned ? ` It's pinned to ${o.line.pinned.toLowerCase().replace("_", " ")} in its ad, so every variation must work in that position on its own.` : "";
  const form = google
    ? `Google ${KIND_LABEL[o.line.kind].toLowerCase()}: ${max} characters or less, hard limit (Google rejects anything longer). No exclamation mark in a headline, no repeated punctuation, no all caps words.${pin}`
    : o.line.kind === "primary"
      ? o.line.text.length <= 300
        ? `Short-form primary text: up to 300 characters, the hook inside the first ${COPY_LIMITS.primary} (what shows before "See more"). No links.`
        : `Long-form primary text, about as long as the model (up to ${max} characters), the hook inside the first ${COPY_LIMITS.primary} characters. Line breaks as \\n. No links.`
      : `${KIND_LABEL[o.line.kind]}: ${max} characters or less, hard limit.`;
  const out = await askJson<{ variations: { text: string; reason: string }[] }>({
    agent: "copy",
    label: "copy variations",
    clientId: o.clientId,
    system: AGENCY_SYSTEM,
    schema: SCHEMA,
    maxTokens: 6000,
    prompt: `${contextBlock(ctx, undefined, sources)}
${copy ? `\n${copy}\n` : ""}
<proven_line>
${lineForAi(o.line, Boolean(o.line.roasKpi), 3000)}
</proven_line>
${o.note?.trim() ? `\n<asked_for>\n${o.note.trim().slice(0, 1000)}\n</asked_for>\n` : ""}
Write ${n} variations of this ${google ? "Google " : ""}${kind} in the client's brand voice (the Brand Bible's voice and rules), using the proven line as the model: keep what made it work (its hook, structure, claim and offer), and change the words, the angle of entry or the emotion so each one is worth testing against it. Never break the client's rules or anything they told us to avoid; only claims the client can back.
${form}
For each: text, and reason (one line: what it keeps from the winner and what it tests). Count characters before answering. No em dashes.`,
  });
  const variations: Variation[] = out.variations
    .map((v) => ({ text: v.text.replace(/\s*—\s*/g, ", ").trim(), reason: v.reason.replace(/\s*—\s*/g, ", ").trim(), chars: v.text.trim().length }))
    .filter((v) => v.text && v.chars <= max)
    .slice(0, n);
  const { data } = await admin
    .from("copy_library_variations")
    .insert({ client_id: o.clientId, platform: o.line.platform ?? "meta", line_key: o.line.key, kind: o.line.kind, model_text: o.line.text.slice(0, 4000), note: o.note?.trim() || null, variations, model, created_by: o.by })
    .select("id, created_at")
    .single();
  return { id: (data?.id as string | undefined) ?? null, at: (data?.created_at as string | undefined) ?? new Date().toISOString(), variations, dropped: out.variations.length - variations.length };
}
