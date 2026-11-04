import "server-only";
import type { AiTool as SharedTool } from "@/lib/ai-tools/types";
import type { ChatTool, ToolCtx } from "./tools";

// Where other features plug into Kaizen AI. Each module in src/lib/ai-tools exports `tools` (name, description, input
// schema, run(user, input), which checks the person's own rights); they show up here for every agent. Tools that spend
// money or make something (an ElevenLabs voiceover, a Higgsfield video) need the person's yes in the chat first: the
// model must ask, then call again with confirmed: true. A module that fails to load is left out, so the AI never
// offers what it can't do. New connectors: add the module to MODULES.

const MODULES: { key: string; label: string; load: () => Promise<{ tools: SharedTool[] }> }[] = [
  { key: "policy", label: "Google policy", load: () => import("@/lib/ai-tools/policy") },
  { key: "recap-deck", label: "Monthly recap deck", load: () => import("@/lib/ai-tools/recap-deck") },
  { key: "elevenlabs", label: "ElevenLabs", load: () => import("@/lib/ai-tools/elevenlabs") },
  { key: "higgsfield", label: "Higgsfield", load: () => import("@/lib/ai-tools/higgsfield") },
  { key: "motion", label: "Motion", load: () => import("@/lib/ai-tools/motion") },
];

function wrap(t: SharedTool, label: string, ctx: ToolCtx): ChatTool {
  const schema = t.spends
    ? { ...t.input_schema, properties: { ...t.input_schema.properties, confirmed: { type: "boolean", description: "True only after the person said yes to this exact run in the chat" } } }
    : t.input_schema;
  return {
    name: t.name,
    description: t.spends ? `${t.description} This spends credits or makes something: say what it will do and ask the person first; call it with confirmed: true only after they say yes.` : t.description,
    input_schema: schema,
    status: () => `${label}: ${t.name.replace(/_/g, " ")}…`,
    run: async (input) => {
      if (t.spends && input.confirmed !== true) throw new Error("Not run: ask the person to confirm first (it spends credits), then call again with confirmed: true.");
      const rest = { ...input };
      delete rest.confirmed;
      return t.run(ctx.me, rest);
    },
  };
}

/** Every connector's tools for this turn */
export async function extensionTools(ctx: ToolCtx): Promise<ChatTool[]> {
  const out: ChatTool[] = [];
  const loaded = await Promise.all(
    MODULES.map((m) =>
      m
        .load()
        .then((mod) => ({ m, tools: mod.tools ?? [] }))
        .catch((e) => {
          console.error(`[kaizen ai] connector ${m.key}:`, e instanceof Error ? e.message : e);
          return { m, tools: [] as SharedTool[] };
        }),
    ),
  );
  const taken = new Set<string>();
  for (const { m, tools } of loaded)
    for (const t of tools) {
      if (taken.has(t.name)) continue;
      taken.add(t.name);
      out.push(wrap(t, m.label, ctx));
    }
  return out;
}
