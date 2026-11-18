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
  "package_details",
  "client_wins",
  "get_client_context",
  "account_metrics",
  "winners_and_fatigue",
  "email_marketing",
  "kpi_board",
  "organic_social",
  "social_score",
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
  "direction_changes",
  "my_overview",
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
export const ASKED_ACTIONS: ReadonlySet<string> = new Set(["remind_me", "ask_teammate", "send_to_teammate", "draft_message", "flag_client_risk", "submit_feedback", "create_document", "keep_for_later"]);

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

/** How long tools run before a filler is said: a quick tool answers before anyone notices the pause */
export const FILLER_DELAY_MS = 1500;

/**
 * Tools that fetch nothing to speak of (a reminder, a screen opened, a card shown, a note saved, a message sent to a
 * teammate): never a "pulling…" line, and they're quick, so usually no filler at all
 */
const QUIET_TOOLS: ReadonlySet<string> = new Set([
  "remind_me",
  "ask_teammate",
  "send_to_teammate",
  "open_screen",
  "show_link",
  "clear_my_item",
  "remember",
  "set_style",
  "forget",
  "ask_for_files",
  "read_uploads",
  "draft_message",
  "flag_client_risk",
  "submit_feedback",
  "dismiss_specialist",
  "look_at_screen",
  "update_my_profile",
  "update_assistant_settings",
]);

/** Words of a client's name that say it was mentioned ("Crust" for Crust Pizza), not the filler words of a name */
const NAME_FILLER = new Set(["the", "and", "co", "inc", "llc", "ltd", "company", "group", "shop", "store", "studio", "brand", "brands", "of"]);

/** Whether what they said this turn is about this client (any distinctive word of its name, any case) */
export function mentionsClient(said: string, client: string): boolean {
  const s = ` ${said.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  const words = client
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length >= 3 && !NAME_FILLER.has(w));
  return words.some((w) => s.includes(` ${w} `) || s.includes(` ${w}s `) || s.includes(` ${w.replace(/s$/, "")} `));
}

/**
 * A spoken line while slow lookups run, so the call never goes quiet ("One sec, pulling Crust Pizza's numbers."), or
 * null when no line fits (only quick tools that fetch nothing). The client is named only when this turn's words are
 * about it (a stale name from an earlier turn is worse than none); handed-over turns (said "") name none. Never the
 * same line twice in a row (`last`); varied by `seed`. Pass `said` undefined to name the client from the tool alone.
 */
export function fillerFor(calls: readonly { name: string; input: Record<string, unknown> }[], opts: number | { said?: string | null; last?: string | null; seed?: number } = 0): string | null {
  const o = typeof opts === "number" ? { seed: opts } : opts;
  const seed = Math.abs(o.seed ?? 0);
  const loud = calls.filter((c) => !QUIET_TOOLS.has(c.name));
  if (!loud.length) return null;
  const named = loud.map((c) => String(c.input.client ?? "").trim()).find(Boolean) ?? null;
  const client = named && (o.said === undefined || (o.said !== null && mentionsClient(o.said, named))) ? named : null;
  const names = new Set(loud.map((c) => c.name));
  const reads = loud.some((c) => READ_TOOLS.has(c.name));
  const whose = client ? `${client}${/s$/i.test(client) ? "'" : "'s"}` : null;
  const what = names.has("rank_clients")
    ? "the rankings"
    : names.has("email_marketing") || names.has("kpi_board")
      ? `${whose ?? "the"} ${names.has("kpi_board") ? "KPI board" : "email numbers"}`
      : names.has("organic_social")
        ? `${whose ?? "the"} social numbers`
        : names.has("account_metrics") || names.has("winners_and_fatigue")
          ? `${whose ?? "the"} numbers`
          : names.has("what_changed")
            ? `what's changed${client ? ` on ${client}` : ""}`
            : reads && client
              ? `what we have on ${client}`
              : reads
                ? "that up"
                : null;
  const lines = what
    ? [`One sec, pulling ${what}.`, `Give me a second, I'm pulling ${what}.`, `Pulling ${what} now.`, `Hang on, grabbing ${what}.`, `Just a moment, getting ${what}.`]
    : ["On it, one moment.", "Working on that now.", "Give me a second.", "Doing that now.", "Bear with me a moment."];
  const fresh = lines.filter((l) => l !== o.last);
  return fresh[seed % fresh.length];
}

// ─── Long work: voiced check-ins, the progress steps, and never stopping halfway ─────────────────────────────────

/** After this long with nothing said while an agent works, it says a short check-in */
export const CHECK_IN_FIRST_MS = 3000;
/** Then one every this long while the work goes on */
export const CHECK_IN_EVERY_MS = 4500;

const CHECK_INS = ["Still working on it.", "Almost there.", "Pulling the last of it together.", "Bear with me, nearly done.", "Still on it.", "Just finishing this up.", "Give me a moment more.", "Nearly there."];

/** Whether a check-in is due: `quietMs` since anything was said, `said` check-ins so far this turn */
export const checkInDue = (quietMs: number, said: number) => quietMs >= (said === 0 ? CHECK_IN_FIRST_MS : CHECK_IN_EVERY_MS);

/** A short varied check-in, never the same as the last one */
export function checkInLine(last: string | null, seed: number): string {
  const fresh = CHECK_INS.filter((l) => l !== last);
  return fresh[Math.abs(Math.floor(seed)) % fresh.length];
}

/** What a step is called on the progress bar: the tool's own status line, else a plain one from its name */
export function stepLabel(tool: Pick<LoopTool, "name" | "status"> | undefined, input: Record<string, unknown>, client: string | null = null): string {
  const own = tool?.status?.(input, client);
  if (own && own !== "Working on it…") return own.replace(/…$/, "");
  const name = tool?.name ?? "";
  if (/context|brief|memory|bible|rules/.test(name)) return "Reading brand rules and context";
  if (/email|klaviyo/.test(name)) return "Reading the email numbers";
  if (/social|post/.test(name)) return "Reading the social numbers";
  if (/copy_doc/.test(name)) return "Writing the copy";
  if (/request/.test(name)) return "Creating the request";
  return "Working on it";
}

/** A rough share done after `done` steps (the total isn't known up front): climbs quickly, never reaches 100 until the answer */
export const progressPct = (done: number) => Math.min(92, Math.round(100 * (1 - Math.pow(0.62, Math.max(0, done)))));

/**
 * The model said it's working on something and stopped without doing it ("On it, give me a sec.", "Let me pull that
 * together."): that's not an answer, so the turn carries on instead of handing back and waiting for them to speak.
 */
export function soundsUnfinished(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t || t.length > 260 || /\?\s*$/.test(t)) return false;
  const last = t.split(/(?<=[.!])\s+/).filter(Boolean).at(-1) ?? t;
  return /\b(?:(?:i'?m|i am|we'?re|still) (?:working on|pulling|getting|grabbing|putting|writing|building|drafting|checking|looking)|let me (?:pull|get|grab|put|write|build|draft|check|look|start|work)|(?:give|bear with) me (?:a|one) (?:sec|second|moment|minute)|one (?:sec|second|moment)|on it\b|working on (?:it|that|those|them)|hang on|(?:i'?ll|i will) (?:pull|get|grab|put|write|build|draft|start|do|have) (?:that|it|those|them|this)?)/i.test(last);
}

/** What the model is told when it stopped halfway: carry on in this turn */
export const CARRY_ON = "(Carry on now, in this same turn: do the work you just said you're doing with your tools, then give the result. Don't say you're working on it again.)";

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
  /** Told once a round's tools have all finished (a filler waiting on a slow tool is dropped here) */
  afterTools?: (round: number) => void;
  signal?: AbortSignal;
  maxResultChars?: number;
  /**
   * Whether a round that ended without tools stopped halfway (said it's working and handed back): it's sent back with
   * CARRY_ON so the work finishes in this turn. At most twice a turn. Off unless given.
   */
  unfinished?: (content: Block[]) => boolean;
}): Promise<{ runs: ToolRun[]; rounds: number; stop: string | null; content: Block[]; nudged: number }> {
  const runs: ToolRun[] = [];
  let last: { content: Block[]; stop: string | null } = { content: [], stop: null };
  let round = 0;
  let nudged = 0;
  for (; round < Math.max(1, opts.maxRounds); round++) {
    const final = round === Math.max(1, opts.maxRounds) - 1;
    last = await opts.step(opts.messages, final, round);
    if (last.stop === "end_turn" && !final && !opts.signal?.aborted && nudged < 2 && opts.unfinished?.(last.content)) {
      nudged++;
      opts.messages.push({ role: "assistant", content: last.content });
      opts.messages.push({ role: "user", content: CARRY_ON });
      continue;
    }
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
    opts.afterTools?.(round);
    opts.messages.push({ role: "user", content: results });
    if (opts.signal?.aborted) break;
  }
  return { runs, rounds: round + 1, stop: last.stop, content: last.content, nudged };
}
