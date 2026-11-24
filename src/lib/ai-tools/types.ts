import type { Staff } from "@/lib/auth";

/**
 * A tool Kaizen AI (or any screen) can call: a name, what it does, the JSON schema of its input, and run(user, input).
 * run checks the person's own rights; it never trusts the caller to have done so.
 */
export type AiTool = {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  /** True when running it spends money or makes something (the chat should confirm with the person first) */
  spends?: boolean;
  run: (user: Staff, input: Record<string, unknown>, chat?: ChatExtra) => Promise<unknown>;
  /** Only for these teams' lines (leave out for everyone): "ads" (the ads side), "email", "social" */
  lines?: ("ads" | "email" | "social")[];
  /** Only for the people this says yes to (e.g. Sales: execs and leads); left out of everyone else's tool list */
  only?: (user: Staff) => boolean;
};

/**
 * What a tool gets when Kaizen AI runs it in a chat (other screens pass nothing): the files attached to the newest
 * message (read them with the server's rights from the ai-files bucket), the thread's client, and a way to show a card
 * in the chat (a link, a list, a download).
 */
export type ChatExtra = {
  files: { name: string; kind: string; mime: string; path: string }[];
  clientId: string | null;
  card: (c: Record<string, unknown> & { type: string }) => void;
};

/** What the media connectors' tools return: the data and a one-line summary, or an error to show as is */
export type ToolResult = { ok: true; data: unknown; summary: string } | { ok: false; error: string };

export const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
export const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
