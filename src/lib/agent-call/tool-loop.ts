// The agents' lookups on a voice call and in their own chat: which of Kaizen AI's tools they get, and the loop that runs
// them (the model asks for a tool, it runs, the result goes back, until it answers). Plain helpers with no keys or
// network of their own, so the loop is tested with a stand-in model.

/** A tool the loop can run: the same shape as Kaizen AI's chat tools */
export type LoopTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  run: (input: Record<string, unknown>) => Promise<unknown>;
  status?: (input: Record<string, unknown>, client: string | null) => string;
};

/**
 * Tools that only read: run on a call or in an agent's chat without asking. Everything else in Kaizen AI either makes
 * a card the call can't show (dropped, see CARD_TOOLS) or makes, sends or spends something (asked first, see gateTools).
 */
export const READ_TOOLS: ReadonlySet<string> = new Set([
  "list_clients",
  "get_client_context",
  "account_metrics",
  "winners_and_fatigue",
  "email_marketing",
  "organic_social",
  "what_changed",
  "get_copy_library",
  "rank_clients",
  "top_emails",
  "email_detail",
  "top_ads",
  "top_posts",
  "search_client",
  "recent_calls",
  "read_call",
  // Add-on tools that only read
  "elevenlabs_list_voices",
  "elevenlabs_quota",
  "higgsfield_jobs",
  "higgsfield_job",
  "search_market_ads",
  "client_swipe_file",
  "motion_report",
  "google_policy_check",
  "google_policy_latest",
  "recap_deck_status",
  "onboarding_status",
  "weekly_task_summary",
  "read_report_sheet",
  "monthly_moments",
  "search_looms",
  "read_loom",
  "client_package",
]);

/**
 * Tools whose whole point is a card in Kaizen AI's chat (a brief, a change plan, a launch, copy, a deck, an export):
 * a call has nowhere to show one, and the agent's own chat proposes playbook edits instead. Left out there; the agent
 * says to do it in Kaizen AI.
 */
export const CARD_TOOLS: ReadonlySet<string> = new Set([
  "create_brief",
  "plan_ad_changes",
  "launch_sheet",
  "launch_reply",
  "write_ad_copy",
  "make_deck",
  "draft_weekly_report",
  "creative_assessment",
  "export_to_google_doc",
  "export_to_google_sheet",
]);

/**
 * What the person asks for in so many words ("remind me about that", "make sure the strategist does it"): their own
 * words are the yes, so these run when asked. They only reach the team (a reminder, a task on someone's Overview),
 * never a client.
 */
export const ASKED_ACTIONS: ReadonlySet<string> = new Set(["remind_me", "ask_teammate"]);

const CONFIRM_NOTE = "This makes, sends or spends something: say in one sentence what it will do and ask first; call it with confirmed: true only after the person clearly says yes to this exact run.";

/**
 * The tools for a call or an agent's chat, from the person's own Kaizen AI tools (already narrowed to their rights and
 * line): read-only ones as they are, card-only ones left out, and anything that makes, sends or spends needs the
 * person's yes first (confirmed: true, the chat's own rule; tools that already ask for it keep theirs).
 */
export function gateTools<T extends LoopTool>(tools: readonly T[]): T[] {
  const out: T[] = [];
  for (const t of tools) {
    if (CARD_TOOLS.has(t.name)) continue;
    if (READ_TOOLS.has(t.name) || ASKED_ACTIONS.has(t.name)) {
      out.push(t);
      continue;
    }
    const s = t.input_schema as { properties?: Record<string, unknown> };
    if (s.properties && "confirmed" in s.properties) {
      out.push(t);
      continue;
    }
    out.push({
      ...t,
      description: `${t.description} ${CONFIRM_NOTE}`,
      input_schema: { ...t.input_schema, properties: { ...(s.properties ?? {}), confirmed: { type: "boolean", description: "True only after the person said yes to this exact run" } } },
      run: async (input: Record<string, unknown>) => {
        if (input.confirmed !== true) throw new Error("Not run: ask the person first (it makes, sends or spends something), then call again with confirmed: true.");
        const rest = { ...input };
        delete rest.confirmed;
        return t.run(rest);
      },
    });
  }
  return out;
}

/** A spoken line while lookups run, so the call never goes quiet ("One sec, pulling Crust Pizza's numbers.") */
export function fillerFor(calls: readonly { name: string; input: Record<string, unknown> }[], seed = 0): string {
  const client = calls.map((c) => String(c.input.client ?? "").trim()).find(Boolean) ?? null;
  const names = new Set(calls.map((c) => c.name));
  const whose = client ? `${client}${/s$/i.test(client) ? "'" : "'s"}` : null;
  const what = names.has("rank_clients")
    ? "the rankings"
    : names.has("email_marketing")
      ? `${whose ?? "the"} email numbers`
      : names.has("organic_social")
        ? `${whose ?? "the"} social numbers`
        : names.has("account_metrics") || names.has("winners_and_fatigue")
          ? `${whose ?? "the"} numbers`
          : names.has("what_changed")
            ? `what's changed${client ? ` on ${client}` : ""}`
            : client
              ? `what we have on ${client}`
              : "that up";
  const lines = [`One sec, pulling ${what}.`, `Give me a second, I'm pulling ${what}.`, `Let me check. Pulling ${what} now.`];
  return lines[Math.abs(seed) % lines.length];
}

/** A tool's answer as the model reads it: text, cut when it's very long */
export function resultText(out: unknown, max = 40_000): string {
  const s = typeof out === "string" ? out : JSON.stringify(out ?? null);
  return s.length > max ? `${s.slice(0, max)}\n…(cut: ask for a narrower range or fewer clients)` : s;
}

type Block = { type: string; id?: string; name?: string; input?: unknown; text?: string };
export type LoopMessage = { role: "user" | "assistant"; content: unknown };
export type ToolRun = { name: string; input: Record<string, unknown>; ok: boolean; ms: number; error?: string };

/**
 * Runs a model with tools until it answers. `step` sends the messages so far and returns the model's reply (its
 * blocks and why it stopped); `last` is true on the final round, which goes without tools so it answers with what it
 * has. Tool calls in a round run together; failures go back as errors (the model says what it couldn't read). Stops
 * early when the signal is aborted. Returns every tool run and the last reply.
 */
export async function runToolLoop(opts: {
  tools: readonly LoopTool[];
  messages: LoopMessage[];
  maxRounds: number;
  step: (messages: LoopMessage[], last: boolean, round: number) => Promise<{ content: Block[]; stop: string | null }>;
  /** Told before a round's tools run (for a spoken filler or a status line) */
  onTools?: (calls: { name: string; input: Record<string, unknown> }[], round: number) => void;
  signal?: AbortSignal;
  maxResultChars?: number;
}): Promise<{ runs: ToolRun[]; rounds: number; stop: string | null; content: Block[] }> {
  const runs: ToolRun[] = [];
  let last: { content: Block[]; stop: string | null } = { content: [], stop: null };
  let round = 0;
  for (; round < Math.max(1, opts.maxRounds); round++) {
    const final = round === Math.max(1, opts.maxRounds) - 1;
    last = await opts.step(opts.messages, final, round);
    if (last.stop !== "tool_use" || final || opts.signal?.aborted) break;
    const calls = last.content.filter((b) => b.type === "tool_use" && b.id && b.name).map((b) => ({ id: b.id as string, name: b.name as string, input: (b.input ?? {}) as Record<string, unknown> }));
    if (!calls.length) break;
    opts.messages.push({ role: "assistant", content: last.content });
    opts.onTools?.(
      calls.map(({ name, input }) => ({ name, input })),
      round,
    );
    const results = await Promise.all(
      calls.map(async (c) => {
        const tool = opts.tools.find((t) => t.name === c.name);
        const t0 = Date.now();
        try {
          if (!tool) throw new Error(`No tool called ${c.name}.`);
          const out = await tool.run(c.input);
          runs.push({ name: c.name, input: c.input, ok: true, ms: Date.now() - t0 });
          return { type: "tool_result", tool_use_id: c.id, content: resultText(out, opts.maxResultChars) };
        } catch (e) {
          const error = (e instanceof Error ? e.message : String(e)).slice(0, 400);
          runs.push({ name: c.name, input: c.input, ok: false, ms: Date.now() - t0, error });
          return { type: "tool_result", tool_use_id: c.id, is_error: true, content: error };
        }
      }),
    );
    opts.messages.push({ role: "user", content: results });
    if (opts.signal?.aborted) break;
  }
  return { runs, rounds: round + 1, stop: last.stop, content: last.content };
}
