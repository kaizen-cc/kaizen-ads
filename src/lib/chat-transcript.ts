// The whole conversation behind a report from a chat, so the fix pipeline sees everything that happened: every
// message in order with its role and time, the tool calls and their results (compact, kept in full), errors with
// their code, and the state around it (a launch run's status and plan, Kaizen AI's agent and connectors, the brief
// draft). Secrets are redacted; when it's too long, tool output is cut first, then the AI's words, never a person's.
// Plain logic: client-safe, and tested.

import type { ChatKind } from "./chat-report";

export type TranscriptEntry = {
  role: "user" | "ai" | "tool";
  at: string | null;
  text: string;
  /** The person or agent who spoke, or the tool's name */
  name?: string | null;
  /** A tool's outcome: true, false (failed), or null (unknown) */
  ok?: boolean | null;
  error?: { text: string | null; code: string | null } | null;
};

export type Transcript = {
  chat: ChatKind;
  /** Read from the stored conversation on the server, or the browser's copy for chats that aren't stored */
  source: "server" | "client";
  threadId: string | null;
  state: Record<string, unknown> | null;
  entries: TranscriptEntry[];
  /** Characters cut to fit, if any */
  cut: number;
};

// Anything that looks like a key, a token or a password
const SECRETS: [RegExp, string][] = [
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "$1 [redacted]"],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, "[redacted key]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[redacted key]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[redacted key]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "[redacted key]"],
  [/\bEAA[A-Za-z0-9]{30,}/g, "[redacted token]"],
  [/\b(?:re|rk|pk|sk|whsec)_(?:live|test)?_?[A-Za-z0-9]{20,}/g, "[redacted key]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[redacted token]"],
  [/(["']?(?:api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|access[_-]?token|refresh[_-]?token|auth[_-]?token|private[_-]?key|service[_-]?role[_-]?key)["']?\s*[:=]\s*)(["']?)[^\s"',}]{6,}\2/gi, "$1$2[redacted]$2"],
  [/(https?:\/\/[^\s"']*[?&](?:access_token|token|key|signature|sig|code)=)[^&\s"']+/gi, "$1[redacted]"],
];

/** The text with anything that looks like a key, a bearer token or a password replaced. */
export function redact(text: string): string {
  let out = text;
  for (const [re, to] of SECRETS) out = out.replace(re, to);
  return out;
}

const redactValue = (v: unknown): unknown => {
  if (typeof v === "string") return redact(v);
  if (Array.isArray(v)) return v.map(redactValue);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /secret|password|token|api[_-]?key/i.test(k) && typeof x === "string" ? "[redacted]" : redactValue(x)]));
  return v;
};

/** Entries in time order; ones without a time keep their place after the one before them. */
export function orderEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  let last = "";
  const keyed = entries.map((e, i) => {
    if (e.at) last = e.at;
    return { e, i, t: e.at ?? last };
  });
  return keyed.sort((a, b) => (a.t && b.t && a.t !== b.t ? (a.t < b.t ? -1 : 1) : a.i - b.i)).map((x) => x.e);
}

const size = (t: Pick<Transcript, "entries" | "state">) => t.entries.reduce((n, e) => n + e.text.length + 60, 0) + (t.state ? JSON.stringify(t.state).length : 0);

const cutText = (text: string, keep: number) => {
  if (text.length <= keep) return { text, cut: 0 };
  const cut = text.length - keep;
  return { text: `${text.slice(0, keep)}\n[cut: ${cut} more characters]`, cut };
};

/**
 * The transcript redacted, ordered, and within `max` characters: the longest tool results are cut first, then the
 * state, then the AI's longest replies. A person's words are never cut.
 */
export function buildTranscript(t: Omit<Transcript, "cut">, max = 200_000): Transcript {
  const entries = orderEntries(t.entries.filter((e) => e.text?.trim() || e.error).map((e) => ({ ...e, text: redact(String(e.text ?? "")), error: e.error ? { text: e.error.text ? redact(e.error.text) : null, code: e.error.code } : null })));
  let state = t.state ? (redactValue(t.state) as Record<string, unknown>) : null;
  let cut = 0;
  const out = { ...t, state, entries, cut };
  for (const role of ["tool", "state", "ai"] as const) {
    let over = size(out) - max;
    if (over <= 0) break;
    if (role === "state") {
      const s = JSON.stringify(state);
      if (state && s.length > 4000) {
        cut += s.length - 4000;
        state = { cut: `The state was ${s.length} characters; the first 4000 are here`, head: s.slice(0, 4000) };
        out.state = state;
      }
      continue;
    }
    // Longest first, down to a floor, until it fits
    const order = entries.map((e, i) => ({ e, i })).filter((x) => x.e.role === role).sort((a, b) => b.e.text.length - a.e.text.length);
    for (const floor of [4000, 1500, 400]) {
      for (const { e, i } of order) {
        if (over <= 0) break;
        if (e.text.length <= floor) continue;
        const r = cutText(e.text, Math.max(floor, e.text.length - over - 200));
        entries[i] = { ...e, text: r.text };
        over -= r.cut - 40;
        cut += r.cut;
      }
      if (over <= 0) break;
    }
  }
  out.cut = cut;
  return out;
}

const when = (at: string | null) => (at ? new Date(at).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "");

/** The transcript as readable Markdown (the .md stored with the report, and the issue's details block). */
export function transcriptMarkdown(t: Transcript, title = "Chat transcript"): string {
  const head = [`# ${title}`, ``, `- Chat: ${t.chat}${t.threadId ? ` · ${t.threadId}` : ""}`, `- Read from: ${t.source === "server" ? "the stored conversation" : "the browser's copy"}`, `- Messages: ${t.entries.length}${t.cut ? ` · ${t.cut} characters of tool output and long replies cut to fit` : ""}`];
  const state = t.state ? [``, `## State`, "```json", JSON.stringify(t.state, null, 2), "```"] : [];
  const body = t.entries.map((e) => {
    const who = e.role === "user" ? `**${e.name || "Person"}**` : e.role === "ai" ? `**${e.name || "AI"}**` : `Tool \`${e.name ?? "tool"}\`${e.ok === false ? " (failed)" : e.ok ? " (ok)" : ""}`;
    const err = e.error ? `\n> Error${e.error.code ? ` (${e.error.code})` : ""}: ${e.error.text ?? ""}` : "";
    const text = e.role === "tool" ? (e.text ? "\n```\n" + e.text.replace(/```/g, "ˋˋˋ") + "\n```" : "") : e.text ? `\n${e.text}` : "";
    return `### ${who} ${when(e.at)}${text}${err}`;
  });
  return [...head, ...state, ``, `## Messages`, ``, body.join("\n\n")].join("\n");
}

// ─── From each chat's stored shape ──────────────────────────────────────────

type ToolRunLike = { name?: string; label?: string; ok?: boolean | null; summary?: string; input?: unknown; output?: unknown; connector?: string };
const asText = (v: unknown) => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v));

/** Kaizen AI's stored messages: the words, each tool run (input and result), and the error, in order. */
export function fromAiMessages(rows: { role: string; content: string | null; tools?: unknown; error?: string | null; agent_key?: string | null; model?: string | null; created_at: string }[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const m of rows) {
    if (m.role === "user") {
      out.push({ role: "user", at: m.created_at, text: m.content ?? "" });
      continue;
    }
    for (const t of (Array.isArray(m.tools) ? m.tools : []) as ToolRunLike[])
      out.push({
        role: "tool",
        at: m.created_at,
        name: t.connector ? `${t.connector}: ${t.name ?? t.label}` : (t.name ?? t.label ?? "tool"),
        ok: t.ok ?? null,
        text: [t.label && t.label !== t.name ? t.label : "", t.input != null ? `input: ${asText(t.input)}` : "", t.summary ? `result: ${t.summary}` : "", t.output != null ? `output: ${asText(t.output)}` : ""].filter(Boolean).join("\n"),
      });
    out.push({ role: "ai", at: m.created_at, name: m.agent_key ?? null, text: m.content ?? "", error: m.error ? { text: m.error, code: null } : null });
  }
  return out;
}

/** A chat stored as turns ({ role, text, at, by }): the client chat, the copy studio, a launch run's own talk. */
export function fromTurns(turns: unknown, opts: { aiRoles?: string[] } = {}): TranscriptEntry[] {
  const ai = opts.aiRoles ?? ["assistant", "ai", "agent", "coach"];
  return (Array.isArray(turns) ? turns : []).map((raw) => {
    const t = (raw ?? {}) as Record<string, unknown>;
    const role = ai.includes(String(t.role)) ? "ai" : "user";
    const extra = [t.done ? `did: ${asText(t.done)}` : "", t.launch ? `launch card: ${asText(t.launch)}` : "", t.plan ? `plan card: ${asText(t.plan)}` : ""].filter(Boolean).join("\n");
    return {
      role,
      at: typeof t.at === "string" && t.at ? t.at : typeof t.created_at === "string" ? t.created_at : null,
      name: typeof t.by === "string" ? t.by : typeof t.agent === "string" ? t.agent : null,
      text: [String(t.text ?? t.content ?? t.body ?? ""), extra].filter(Boolean).join("\n"),
      error: typeof t.error === "string" && t.error ? { text: t.error, code: null } : null,
    } satisfies TranscriptEntry;
  });
}

export type LaunchRunRow = {
  id: string;
  platform?: string | null;
  status?: string | null;
  summary?: string | null;
  questions?: unknown;
  plan?: unknown;
  plan_warnings?: unknown;
  error?: string | null;
  progress?: string | null;
  turns?: unknown;
  created_at?: string | null;
  updated_at?: string | null;
};

/** A launch run's state, as the report carries it: status, questions and answers, the plan in short, its warnings, and every line that failed. */
export function launchState(run: LaunchRunRow, items: { key: string; kind: string; status: string; error: string | null }[] = []): Record<string, unknown> {
  const plan = (run.plan ?? null) as Record<string, unknown> | null;
  const planSummary = plan
    ? {
        ...(typeof plan.summary === "string" ? { summary: plan.summary } : {}),
        ...Object.fromEntries(
          Object.entries(plan)
            .filter(([k, v]) => k !== "summary" && Array.isArray(v))
            .map(([k, v]) => [k, (v as unknown[]).length]),
        ),
      }
    : null;
  return {
    launchRun: run.id,
    platform: run.platform ?? "meta",
    status: run.status ?? null,
    progress: run.progress ?? null,
    error: run.error ?? null,
    summary: run.summary ?? null,
    questions: Array.isArray(run.questions) ? run.questions : [],
    plan: planSummary,
    planWarnings: Array.isArray(run.plan_warnings) ? run.plan_warnings : [],
    lineErrors: items.filter((i) => i.error || i.status === "failed" || i.status === "invalid").map((i) => ({ key: i.key, kind: i.kind, status: i.status, error: i.error })),
  };
}
