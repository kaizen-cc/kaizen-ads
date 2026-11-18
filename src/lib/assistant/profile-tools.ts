import "server-only";
import { revalidatePath } from "next/cache";
import { ASSISTANT_PALETTE, ASSISTANT_TINT, cleanAssistantName, colorFromWords } from "@/lib/agent-look";
import { isVoiceId } from "@/lib/agent-call/core";
import type { LoopTool } from "@/lib/agent-call/tool-loop";
import { ConnectorError } from "@/lib/connector-http";
import { addLibraryVoice, elevenlabsConfigured, listLibraryVoices, listVoices } from "@/lib/elevenlabs";
import { cleanEdit } from "@/lib/profile";
import { findVoice, mergeVoices, optionOf } from "@/lib/voices";
import type { AssistantCtx } from "./tools";

// The assistant's tools for the person's own profile and for its own settings (name, color, voice), the same changes the
// Profile and Assistant pages make, only ever on the signed-in person's own row.

export function profileTools(ctx: AssistantCtx): LoopTool[] {
  return [
    {
      name: "update_my_profile",
      description:
        "Changes the person's own profile in Kaizen OS: the name they go by (display_name), their title, a short bio (about them) and the day they started at Kaizen (start_date, YYYY-MM-DD, which also sets their time with the company). Give only what they asked to change. Their profile page shows the picture, which they set themselves there. Say what you changed in a few words.",
      input_schema: {
        type: "object",
        properties: { display_name: { type: "string" }, title: { type: "string" }, bio: { type: "string" }, start_date: { type: "string", description: "YYYY-MM-DD" } },
        additionalProperties: false,
      },
      run: async (input) => {
        const given = Object.fromEntries((["display_name", "title", "bio", "start_date"] as const).filter((k) => k in input).map((k) => [k, input[k]]));
        if (!Object.keys(given).length) return { updated: false, note: "Which part of the profile: name, title, bio or start date?" };
        const edit = cleanEdit(given);
        if (!edit.ok) return { updated: false, note: edit.error };
        const { error } = await ctx.admin.from("profiles").update(edit.patch).eq("id", ctx.me.id);
        if (error) return { updated: false, note: "Couldn't save that: profiles need a database update first." };
        revalidatePath("/profile/[id]", "page");
        return { updated: true, ...edit.patch, profile: `/profile/${ctx.me.id}` };
      },
    },
    {
      name: "update_assistant_settings",
      description: `Changes the person's own assistant: what they call it (name; empty resets it to Assistant), its color (a swatch name: ${ASSISTANT_PALETTE.map((c) => c.name).join(", ")}, or a hex like #2a9d8f), and its voice (by the voice's name, e.g. George; if several match, the choices come back to ask which). Only theirs: nobody else's assistant changes. A new voice is heard from the next call. Say what you changed in a few words.`,
      input_schema: {
        type: "object",
        properties: { name: { type: "string" }, color: { type: "string" }, voice: { type: "string", description: "A voice's name, or 'default' to go back to the assistant's own voice" } },
        additionalProperties: false,
      },
      run: async (input) => {
        const update: Record<string, string | null> = {};
        const now: Record<string, unknown> = {};
        if ("name" in input) {
          const name = cleanAssistantName(input.name);
          if (String(input.name ?? "").trim() && !name) return { updated: false, note: "That name needs letters or numbers." };
          update.assistant_name = name;
          now.name = name ?? "Assistant (the default)";
        }
        if ("color" in input) {
          const color = colorFromWords(input.color);
          if (!color) return { updated: false, note: `I need a swatch name (${ASSISTANT_PALETTE.map((c) => c.name).join(", ")}) or a hex color like #2a9d8f.` };
          update.assistant_color = color === ASSISTANT_TINT ? null : color;
          now.color = color;
        }
        if ("voice" in input) {
          const want = String(input.voice ?? "").trim();
          if (!want || /^default$/i.test(want)) {
            update.assistant_voice = null;
            now.voice = "the default voice";
          } else {
            if (!elevenlabsConfigured()) return { updated: false, note: "ElevenLabs isn't connected, so voices can't be changed." };
            const [account, library] = await Promise.all([listVoices().catch(() => []), listLibraryVoices().catch(() => [])]);
            const options = mergeVoices([account, library]).map(optionOf);
            const found = isVoiceId(want) ? { match: options.find((o) => o.id === want) ?? null, candidates: [] } : findVoice(options, want);
            if (!found.match) return { updated: false, note: found.candidates.length ? "More than one voice fits. Ask which." : `No voice called ${want}.`, choices: found.candidates.map((c) => ({ name: c.name, about: c.about })) };
            if (found.match.owner) {
              try {
                await addLibraryVoice(found.match.owner, found.match.id, "Kaizen assistant voice");
              } catch (e) {
                return { updated: false, note: e instanceof ConnectorError ? e.message : "Couldn't add that voice to the account." };
              }
            }
            update.assistant_voice = found.match.id;
            now.voice = found.match.name;
          }
        }
        if (!Object.keys(update).length) return { updated: false, note: "What should change: its name, color or voice?" };
        const { error } = await ctx.admin.from("profiles").update(update).eq("id", ctx.me.id);
        if (error) return { updated: false, note: "Couldn't save that: the assistant's settings need a database update first." };
        revalidatePath("/assistant");
        return { updated: true, now, note: "A new name or color shows after a refresh; a new voice is heard from the next call." };
      },
    },
  ];
}
