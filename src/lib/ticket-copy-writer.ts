import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AiUnavailable, askJson, clientContext, contextBlock, getAgent, type Script } from "@/lib/ai";
import { writeScriptFor } from "@/lib/script-writer";
import { copyDiff, copyShape, copyText, fitCopy, pushHistory, type CopyShape, type CreativeCopy } from "@/lib/ticket-copy";

// The AI copywriter on a ticket in production: writes the creative's own copy the moment production starts (a video's
// script through the script writer, an image's headline and subheadline per version, a carousel's lines per slide per
// version) and edits it in a chat with the maker. Saved on ticket_copy_drafts (20261111190000_ticket_stage_views.sql);
// before that table exists a video's script still lands in request_scripts and statics say the setup is pending.

export type DraftMessage = { role: "user" | "assistant"; text: string; at: string; by: string | null; changes?: string[] };
export type DraftRow = {
  status: "writing" | "ready" | "failed";
  progress: string | null;
  content: CreativeCopy | null;
  history: CreativeCopy[];
  changes: string[];
  messages: DraftMessage[];
  error: string | null;
  updated_at: string;
};

const TABLE = "ticket_copy_drafts";
/** The table isn't there yet (the migration isn't applied) */
export const missingTable = (e: { code?: string; message?: string } | null) => Boolean(e && (e.code === "42P01" || e.code === "PGRST205" || /does not exist|schema cache/i.test(e.message ?? "")));

const str = { type: "string" };
const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const line = obj({ headline: str, subline: str });
const FRAMES = obj({ versions: { type: "array", items: line } });
const SLIDES = obj({ versions: { type: "array", items: obj({ slides: { type: "array", items: line } }) } });
const chatSchema = (shape: CopyShape) =>
  shape.kind === "script"
    ? obj({ reply: str, rewrite: { type: "boolean" }, instructions: str })
    : obj({ reply: str, rewrite: { type: "boolean" }, versions: shape.kind === "frames" ? FRAMES.properties.versions : SLIDES.properties.versions });

export const TICKET_COPY_SYSTEM = `You are Kaizen Marketing's AI copywriter. You write the words that go ON the creative (not the ad's primary text): the headline and subheadline of a static, or each slide's headline and subline in a carousel. The designer builds the creative from your lines.
- Build on the brief: its idea, its hook, its on-image text and its Must and Never. When the brief already gives a headline or slide line, keep it (fix only typos) and write the rest around it.
- Phone first: a headline is read in a second. Headlines up to 8 words, sublines up to 14. No hashtags, no emojis unless the brief or the client's voice uses them.
- Every version is its own idea (net new) or tests one thing against V1 (a variation): say it differently, don't repeat V1.
- The client's Brand Bible, voice and rules are hard limits: never a claim, number or offer that isn't in the brief or the client context.
- A carousel: slide 1 stops the scroll, the middle slides carry one point each, the last slide is the CTA.`;

const CHAT_SYSTEM = `You are Kaizen Marketing's AI copywriter, working with the designer or editor making this creative. They ask you to change the copy on the creative (headlines, sublines, slide lines, the script's scenes, voiceover and on-screen text) or ask a question about it.
Answer briefly and plainly, like a colleague: say what you changed and why, in one or two sentences. No emojis, no apologies.
rewrite: true when the copy should change. Change only what they asked for and keep everything else word for word. false when they only asked a question or you need something clarified first.
The client's Brand Bible, voice and rules and the brief's Must and Never still hold: if they ask for something that breaks them, say so and offer what fits instead.`;

function ticketBlock(r: { title: string; format: string; angle_name: string | null; audience: string | null; brief: string | null; sizes: string[] | null; new_count: number; variation_count: number }, shape: CopyShape) {
  return `<creative_ticket>
Title: ${r.title}
Format: ${r.format}
Angle: ${r.angle_name ?? "not set"}
Audience: ${r.audience ?? "not set"}
Sizes: ${(r.sizes ?? []).join(", ") || "4x5, 9x16"}
Versions: ${shape.versions} (${r.new_count} net new, ${r.variation_count} variations; V1 first)${shape.kind === "slides" ? `\nSlides per carousel: ${shape.slides}` : ""}
Brief:
${r.brief ?? "(no brief)"}
</creative_ticket>`;
}

async function readTicket(db: SupabaseClient, requestId: string) {
  const { data: r } = await db
    .from("board_requests")
    .select("id, number, client_id, title, format, angle_name, audience, brief, sizes, new_count, variation_count, quantity")
    .eq("id", requestId)
    .maybeSingle();
  if (!r) throw new AiUnavailable("Ticket not found.");
  const { data: cards } = await db.from("requests").select("cards").eq("id", requestId).maybeSingle();
  const shape = copyShape({ format: r.format, newCount: r.new_count ?? 0, variationCount: r.variation_count ?? 0, quantity: r.quantity ?? 1, cards: (cards?.cards as number | null) ?? null });
  return { r, shape };
}

export async function readDraft(db: SupabaseClient, requestId: string): Promise<{ row: DraftRow | null; setup: boolean }> {
  const { data, error } = await db.from(TABLE).select("status, progress, content, history, changes, messages, error, updated_at").eq("request_id", requestId).maybeSingle();
  if (missingTable(error)) return { row: null, setup: false };
  return { row: (data as DraftRow | null) ?? null, setup: true };
}

async function save(admin: SupabaseClient, requestId: string, clientId: string, patch: Partial<DraftRow> & { updated_by?: string | null }) {
  const { error } = await admin.from(TABLE).upsert({ request_id: requestId, client_id: clientId, ...patch, updated_at: new Date().toISOString() });
  return error;
}

/**
 * Writes the copy (in the background, the moment production starts). A video's script comes from the script writer;
 * statics from the copywriter. Progress is saved as it goes, so the ticket shows it.
 */
export async function writeTicketCopy(admin: SupabaseClient, requestId: string, by: string | null) {
  const { r, shape } = await readTicket(admin, requestId);
  const setupErr = await save(admin, requestId, r.client_id, { status: "writing", progress: shape.kind === "script" ? "Reading the brief's beats" : "Reading the brief", error: null, updated_by: by });
  const tracked = !missingTable(setupErr);
  try {
    let content: CreativeCopy | null;
    if (shape.kind === "script") {
      if (tracked) await save(admin, requestId, r.client_id, { status: "writing", progress: "Writing the scenes, voiceover and on-screen lines" });
      const { content: script } = await writeScriptFor(admin, admin, requestId, by);
      content = { kind: "script", script };
    } else {
      const ctx = await clientContext(admin, r.client_id);
      if (!ctx) throw new AiUnavailable("No client context.");
      const { sources } = await getAgent("copy");
      if (tracked) await save(admin, requestId, r.client_id, { status: "writing", progress: shape.kind === "slides" ? `Writing ${shape.versions * shape.slides} slide lines` : `Writing ${shape.versions} headline${shape.versions === 1 ? "" : "s"}` });
      const raw = await askJson<unknown>({
        agent: "copy",
        label: `ticket copy #${r.number}`,
        clientId: r.client_id,
        system: TICKET_COPY_SYSTEM,
        schema: shape.kind === "frames" ? FRAMES : SLIDES,
        maxTokens: 8000,
        prompt: `${contextBlock(ctx, undefined, sources)}

${ticketBlock(r, shape)}

Write the copy that goes on the creative: ${shape.kind === "frames" ? `a headline and a subheadline (subline) for each of the ${shape.versions} version${shape.versions === 1 ? "" : "s"}` : `for each of the ${shape.versions} version${shape.versions === 1 ? "" : "s"}, ${shape.slides} slides, each with a headline and a subline ("" when the slide needs none)`}, V1 first.`,
      });
      content = fitCopy(raw, shape);
    }
    if (!content) throw new AiUnavailable("The copywriter came back empty.");
    if (tracked) {
      const { row } = await readDraft(admin, requestId);
      await save(admin, requestId, r.client_id, { status: "ready", progress: null, content, history: pushHistory(row?.history ?? [], row?.content ?? null), changes: [] });
    }
    return content;
  } catch (e) {
    if (tracked) await save(admin, requestId, r.client_id, { status: "failed", progress: null, error: e instanceof Error ? e.message : "Couldn't write the copy." });
    throw e;
  }
}

/** The maker's message: the copywriter answers and, when it should, changes the copy in place (the old one kept for undo) */
export async function chatTicketCopy(admin: SupabaseClient, requestId: string, text: string, by: { id: string; name: string }) {
  const { r, shape } = await readTicket(admin, requestId);
  const { row, setup } = await readDraft(admin, requestId);
  if (!setup) throw new AiUnavailable("The copy chat turns on once the database update for it is applied.");
  const current = row?.content ?? null;
  const ctx = await clientContext(admin, r.client_id);
  if (!ctx) throw new AiUnavailable("No client context.");
  const { sources } = await getAgent("copy");
  const earlier = (row?.messages ?? []).slice(-12);
  const out = await askJson<{ reply: string; rewrite: boolean; instructions?: string; versions?: unknown[] }>({
    agent: "copy",
    label: `ticket copy chat #${r.number}`,
    clientId: r.client_id,
    system: `${CHAT_SYSTEM}\n\n${TICKET_COPY_SYSTEM}`,
    schema: chatSchema(shape),
    maxTokens: 8000,
    prompt: `${contextBlock(ctx, undefined, sources)}

${ticketBlock(r, shape)}

<current_copy>
${current ? copyText(current) : "(none written yet)"}
</current_copy>
${earlier.length ? `\n<conversation>\n${earlier.map((m) => `${m.role === "user" ? "Maker" : "You"}: ${m.text}`).join("\n")}\n</conversation>\n` : ""}
The maker says: ${text}
${shape.kind === "script" ? "instructions: when rewriting, everything the script rewrite must change, as instructions to the script writer (it also gets the current script and keeps the rest). \"\" when not rewriting." : "versions: the whole copy after your change (every version, every slide), unchanged parts word for word; when not rewriting, the current copy as it is."}`,
  });
  let next: CreativeCopy | null = current;
  if (out.rewrite) {
    if (shape.kind === "script") {
      const { content } = await writeScriptFor(admin, admin, requestId, by.id, `${out.instructions || text}\n\nKeep everything else as in the current script:\n${current ? copyText(current) : ""}`);
      next = { kind: "script", script: content as Script };
    } else next = fitCopy({ versions: out.versions ?? [] }, shape) ?? current;
  }
  const changes = out.rewrite ? copyDiff(current, next) : [];
  const now = new Date().toISOString();
  const mine: DraftMessage = { role: "user", text, at: now, by: by.name };
  const reply: DraftMessage = { role: "assistant", text: out.reply, at: new Date(Date.parse(now) + 1).toISOString(), by: null, ...(changes.length ? { changes } : {}) };
  const messages: DraftMessage[] = [...(row?.messages ?? []), mine, reply].slice(-60);
  const patch: Partial<DraftRow> = { messages, ...(changes.length && next ? { content: next, history: pushHistory(row?.history ?? [], current), changes, status: "ready" as const } : {}) };
  const err = await save(admin, requestId, r.client_id, { ...patch, updated_by: by.id });
  if (err) throw new AiUnavailable(err.message);
}

/** Back to the copy before the last change */
export async function undoTicketCopy(admin: SupabaseClient, requestId: string, by: { id: string; name: string }) {
  const { r } = await readTicket(admin, requestId);
  const { row, setup } = await readDraft(admin, requestId);
  if (!setup || !row?.history.length) throw new AiUnavailable("Nothing to undo.");
  const prev = row.history[row.history.length - 1];
  const changes = copyDiff(row.content, prev);
  if (prev.kind === "script")
    await admin.from("request_scripts").update({ content: prev.script, generated_at: new Date().toISOString(), generated_by: by.id }).eq("request_id", requestId);
  const now = new Date().toISOString();
  await save(admin, requestId, r.client_id, {
    content: prev,
    history: row.history.slice(0, -1),
    changes,
    messages: [...row.messages, { role: "assistant" as const, text: `Undone, by ${by.name}: back to the copy before the last change.`, at: now, by: null, ...(changes.length ? { changes } : {}) }].slice(-60),
    updated_by: by.id,
  });
}
