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
  { key: "team-ops", label: "Team tools", load: () => import("@/lib/ai-tools/team-ops") },
  { key: "email-design", label: "Email design", load: () => import("@/lib/ai-tools/email-design") },
  { key: "knowledge", label: "Team knowledge", load: () => import("@/lib/ai-tools/knowledge") },
  { key: "direction", label: "Direction changes", load: () => import("@/lib/ai-tools/direction") },
  { key: "overview-desk", label: "Overview", load: () => import("@/lib/ai-tools/overview-desk") },
  { key: "email-segments", label: "Email segments", load: () => import("@/lib/ai-tools/email-segments") },
  { key: "account-watch", label: "Account watch", load: () => import("@/lib/ai-tools/account-watch") },
  { key: "line-review", label: "Weekly review", load: () => import("@/lib/ai-tools/line-review") },
  { key: "oversight", label: "Scorecard and economics", load: () => import("@/lib/ai-tools/oversight") },
  { key: "stepins", label: "Exec step-ins", load: () => import("@/lib/ai-tools/stepins") },
  { key: "ad-library", label: "Ads running", load: () => import("@/lib/ai-tools/ad-library") },
  { key: "integration-health", label: "Connection health", load: () => import("@/lib/ai-tools/integration-health") },
  { key: "email-allotment", label: "Email allotment", load: () => import("@/lib/ai-tools/email-allotment") },
  { key: "social-allotment", label: "Social allotment", load: () => import("@/lib/ai-tools/social-allotment") },
  { key: "youtube", label: "YouTube learning", load: () => import("@/lib/ai-tools/youtube") },
  { key: "tracking", label: "Tracking", load: () => import("@/lib/ai-tools/tracking") },
  { key: "shopify", label: "Shopify", load: () => import("@/lib/ai-tools/shopify") },
  { key: "sales", label: "Sales", load: () => import("@/lib/ai-tools/sales") },
  { key: "connections", label: "Team connections", load: () => import("@/lib/ai-tools/connections") },
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
      return t.run(ctx.me, rest, {
        files: ctx.files.map((f) => ({ name: f.name, kind: f.kind, mime: f.mime, path: f.path })),
        clientId: ctx.clientId,
        card: (c) => void ctx.cards.push(c as unknown as ToolCtx["cards"][number]),
      });
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
  const { isChannelOnly, lineOfTeam } = await import("@/lib/roles");
  const myLine = isChannelOnly(ctx.me.role) ? (lineOfTeam(ctx.me.role) ?? "ads") : "ads";
  for (const { m, tools } of loaded)
    for (const t of tools) {
      // A tool for some teams only (an email tool isn't offered to the ads side, and the other way round); execs get all
      if (t.lines && !ctx.me.isExec && !t.lines.includes(myLine as "ads" | "email" | "social")) continue;
      // A tool for some people only (Sales: execs and leads); run() checks again
      if (t.only && !t.only(ctx.me)) continue;
      if (taken.has(t.name)) continue;
      taken.add(t.name);
      out.push(wrap(t, m.label, ctx));
    }
  return out;
}
