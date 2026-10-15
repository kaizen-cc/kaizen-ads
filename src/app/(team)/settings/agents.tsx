"use client";

import { useState } from "react";
import { ActionButton, ActionForm } from "@/components/action-form";
import { field, label } from "@/components/ui";
import { addKnowledge, saveAgent, setKnowledgeActive, updateKnowledge } from "./actions";

export type Agent = {
  key: "suggest" | "review" | "briefing" | "copy";
  label: string;
  description: string;
  model: "opus" | "sonnet" | "haiku";
  effort: "low" | "medium" | "high";
  instructions: string;
  sources: Record<string, boolean>;
  live: boolean;
  updatedAt: string;
  updatedBy: string | null;
  stats: { runs: number; avgMs: number | null; inTokens: number; outTokens: number; failed: number };
  recent: { at: string; label: string; model: string; ms: number | null; tokens: string; ok: boolean; error: string | null }[];
};
export type Knowledge = { id: string; agentKey: string | null; kind: "knowledge" | "skill" | "example"; title: string; body: string; fileName: string | null; active: boolean };

const MODELS = [
  { key: "opus", name: "Opus", hint: "Deepest judgement. Slowest, costs the most." },
  { key: "sonnet", name: "Sonnet", hint: "Strong and quick. The everyday choice." },
  { key: "haiku", name: "Haiku", hint: "Fastest and cheapest. Good for summarizing." },
] as const;
const EFFORTS = [
  { key: "low", name: "Low", hint: "Answers fast" },
  { key: "medium", name: "Medium", hint: "Thinks it through" },
  { key: "high", name: "High", hint: "Thinks hardest, slowest" },
] as const;
const SOURCES: { key: string; name: string; hint: string }[] = [
  { key: "meta", name: "Meta performance", hint: "Spend, results and top ads" },
  { key: "briefing", name: "Client briefing", hint: "Slack, email and Drive, summarized" },
  { key: "recent_messages", name: "Newest messages", hint: "Slack and email since the briefing" },
  { key: "memory", name: "Client memory", hint: "Avoid, prefer and notes the team saved" },
  { key: "angles", name: "Angles and avatars", hint: "The client's active angles" },
  { key: "recent_requests", name: "Past requests", hint: "The last 25 creative requests" },
  { key: "allotment", name: "Allotment", hint: "What's left this month and sprint dates" },
];
const KINDS = {
  knowledge: { name: "Knowledge", hint: "Reference it should know: brand rules, offers, policies", tone: "bg-surface-2 text-muted" },
  skill: { name: "Skill", hint: "How to do something: a framework or checklist to follow", tone: "bg-brand-soft text-brand-text" },
  example: { name: "Example", hint: "What good looks like: a brief or copy you loved", tone: "bg-ok-soft text-ok" },
} as const;

const fmtDate = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

function Segmented<T extends string>({ name, options, value, onChange }: { name: string; options: readonly { key: T; name: string; hint: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="grid gap-2">
      <div className="grid gap-1 rounded-[10px] border border-line bg-bg p-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
        {options.map((o) => (
          <label key={o.key} className={`cursor-pointer rounded-[7px] px-3 py-2 text-center text-sm transition-colors ${value === o.key ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
            <input type="radio" name={name} value={o.key} checked={value === o.key} onChange={() => onChange(o.key)} className="sr-only" />
            {o.name}
          </label>
        ))}
      </div>
      <p className="text-xs text-faint">{options.find((o) => o.key === value)?.hint}</p>
    </div>
  );
}

/** Read a dropped text file into the form, so a doc can be added as knowledge without copy and paste. */
function FileToText({ onText }: { onText: (name: string, text: string) => void }) {
  const [err, setErr] = useState<string | null>(null);
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted hover:text-fg">
      <input
        type="file"
        accept=".txt,.md,.markdown,.csv,.json,.html,text/*"
        className="sr-only"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          if (f.size > 500_000) return setErr("That file is over 500 KB. Paste the part that matters.");
          setErr(null);
          onText(f.name, await f.text());
        }}
      />
      <span className="rounded-full border border-line px-3 py-1.5">Upload a text file</span>
      <span className="text-faint">.txt, .md, .csv</span>
      {err && <span className="text-bad">{err}</span>}
    </label>
  );
}

function KnowledgeItem({ k }: { k: Knowledge }) {
  const [open, setOpen] = useState(false);
  const meta = KINDS[k.kind];
  return (
    <li className={`rounded-[10px] border border-line bg-bg ${k.active ? "" : "opacity-55"}`}>
      <div className="flex items-center gap-3 px-4 py-3">
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${meta.tone}`}>{meta.name}</span>
        <button onClick={() => setOpen((o) => !o)} className="min-w-0 flex-1 truncate text-left text-sm hover:text-brand-text">
          {k.title}
          {k.fileName && <span className="text-xs text-faint"> · {k.fileName}</span>}
        </button>
        <span className="shrink-0 tabular text-[11px] text-faint">{Math.round(k.body.length / 4).toLocaleString()} tokens</span>
        <ActionButton action={setKnowledgeActive.bind(null, k.id, !k.active)} label={k.active ? "Turn off" : "Turn on"} />
      </div>
      {open && (
        <ActionForm action={updateKnowledge.bind(null, k.id)} submitLabel="Save" className="grid gap-3 border-t border-line px-4 py-4">
          <input name="title" defaultValue={k.title} className={field} />
          <textarea name="body" defaultValue={k.body} rows={10} className={`${field} h-auto py-3 font-mono text-xs font-normal leading-relaxed`} />
        </ActionForm>
      )}
    </li>
  );
}

function AddKnowledge({ agentKey }: { agentKey: string }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<keyof typeof KINDS>("knowledge");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [file, setFile] = useState("");
  if (!open)
    return (
      <button onClick={() => setOpen(true)} className="justify-self-start text-sm text-muted underline-offset-4 hover:text-fg hover:underline">
        + Add knowledge, a skill or an example
      </button>
    );
  return (
    <ActionForm action={addKnowledge} submitLabel="Add" resetOnSuccess className="grid gap-3 rounded-[10px] border border-line bg-bg p-4">
      <input type="hidden" name="agent_key" value={agentKey} />
      <input type="hidden" name="file_name" value={file} />
      <div className="grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)]">
        <label className={label}>
          Type
          <select name="kind" value={kind} onChange={(e) => setKind(e.target.value as keyof typeof KINDS)} className={field}>
            {Object.entries(KINDS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          Title
          <input name="title" value={title} onChange={(e) => setTitle(e.target.value)} className={field} placeholder={kind === "skill" ? "e.g. Hook writing framework" : kind === "example" ? "e.g. Nectr brief that won" : "e.g. Meta ad policy cheat sheet"} />
        </label>
      </div>
      <p className="-mt-1 text-xs text-faint">{KINDS[kind].hint}</p>
      <textarea name="body" value={body} onChange={(e) => setBody(e.target.value)} rows={8} className={`${field} h-auto py-3 text-sm font-normal leading-relaxed`} placeholder="Paste it here, or upload a text file." />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FileToText
          onText={(name, text) => {
            setFile(name);
            setBody(text);
            if (!title) setTitle(name.replace(/\.[^.]+$/, ""));
          }}
        />
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-muted hover:text-fg">
          Cancel
        </button>
      </div>
    </ActionForm>
  );
}

function AgentCard({ a, knowledge }: { a: Agent; knowledge: Knowledge[] }) {
  const [model, setModel] = useState(a.model);
  const [effort, setEffort] = useState(a.effort);
  const mine = knowledge.filter((k) => k.agentKey === a.key);
  const tokens = knowledge.filter((k) => k.active && (k.agentKey === a.key || k.agentKey === null)).reduce((t, k) => t + k.body.length / 4, 0);
  return (
    <section id={a.key} className="grid gap-6 rounded-[14px] border border-line bg-surface p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-heading text-[20px]">{a.label}</h2>
            {a.live ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-ok-soft px-2.5 py-0.5 text-[11px] text-ok">
                <span className="h-1.5 w-1.5 rounded-full bg-ok" />
                In use
              </span>
            ) : (
              <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-[11px] text-muted">Not wired in yet</span>
            )}
          </div>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">{a.description}</p>
        </div>
        <dl className="grid shrink-0 grid-cols-3 gap-5 text-right">
          <div>
            <dt className="text-[11px] text-faint">Runs, 7 days</dt>
            <dd className="tabular font-heading text-lg">{a.stats.runs}</dd>
          </div>
          <div>
            <dt className="text-[11px] text-faint">Avg time</dt>
            <dd className="tabular font-heading text-lg">{a.stats.avgMs == null ? "—" : `${(a.stats.avgMs / 1000).toFixed(1)}s`}</dd>
          </div>
          <div>
            <dt className="text-[11px] text-faint">Tokens</dt>
            <dd className="tabular font-heading text-lg">{a.stats.runs ? `${Math.round((a.stats.inTokens + a.stats.outTokens) / 1000)}k` : "—"}</dd>
          </div>
        </dl>
      </header>

      <ActionForm action={saveAgent.bind(null, a.key)} submitLabel={`Save ${a.label.toLowerCase()}`} className="grid gap-6">
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="grid content-start gap-2">
            <p className="text-sm font-medium">Model</p>
            <Segmented name="model" options={MODELS} value={model} onChange={setModel} />
          </div>
          <div className="grid content-start gap-2">
            <p className="text-sm font-medium">Effort</p>
            <Segmented name="effort" options={EFFORTS} value={effort} onChange={setEffort} />
          </div>
        </div>

        <label className={label}>
          <span>
            Instructions <span className="font-normal text-faint">· how this agent should think and write, on top of the built-in prompt</span>
          </span>
          <textarea
            name="instructions"
            defaultValue={a.instructions}
            rows={6}
            className={`${field} h-auto py-3 text-sm font-normal leading-relaxed`}
            placeholder={
              a.key === "suggest"
                ? "e.g. Lead with the offer in the first 3 words. Always give one UGC-style option. Never suggest stock-photo looks for food clients."
                : a.key === "review"
                  ? "e.g. Block any brief that promises results. Warn when the CTA doesn't match the campaign objective."
                  : a.key === "briefing"
                    ? "e.g. Call out any client complaint at the top. Keep each list to 5 items."
                    : "e.g. Primary text under 125 characters. Headlines under 40. Match the client's voice from past approved copy."
            }
          />
        </label>

        <fieldset className="grid gap-3">
          <legend className="mb-3 text-sm font-medium">What it reads about the client</legend>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {SOURCES.map((s) => (
              <label key={s.key} className="flex cursor-pointer items-start gap-3 rounded-[10px] border border-line bg-bg px-3.5 py-3 transition-colors hover:border-faint/60">
                <input type="checkbox" name={`source_${s.key}`} defaultChecked={a.sources[s.key] !== false} className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="grid gap-0.5">
                  <span className="text-sm">{s.name}</span>
                  <span className="text-[11px] leading-snug text-faint">{s.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      </ActionForm>

      <div className="grid gap-3 border-t border-line pt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-medium">Knowledge, skills and examples</p>
          <p className="text-xs text-faint">
            Reads about <span className="tabular text-muted">{Math.round(tokens).toLocaleString()}</span> tokens of it on every call, including what all agents share
          </p>
        </div>
        {mine.length > 0 && (
          <ul className="grid gap-2">
            {mine.map((k) => (
              <KnowledgeItem key={k.id} k={k} />
            ))}
          </ul>
        )}
        <AddKnowledge agentKey={a.key} />
      </div>

      {a.recent.length > 0 && (
        <details className="group border-t border-line pt-5">
          <summary className="cursor-pointer list-none text-sm text-muted hover:text-fg">
            <span className="group-open:hidden">Show recent runs</span>
            <span className="hidden group-open:inline">Hide recent runs</span>
            {a.stats.failed > 0 && <span className="ml-2 text-bad">{a.stats.failed} failed this week</span>}
          </summary>
          <ul className="mt-3 grid gap-1">
            {a.recent.map((r, i) => (
              <li key={i} className="grid grid-cols-[110px_minmax(0,1fr)_70px_60px_110px] items-center gap-3 rounded-[8px] px-3 py-2 text-xs odd:bg-bg">
                <span className="tabular text-faint">{fmtDate(r.at)}</span>
                <span className={`truncate ${r.ok ? "text-muted" : "text-bad"}`} title={r.error ?? undefined}>
                  {r.label}
                  {r.error && ` · ${r.error}`}
                </span>
                <span className="capitalize text-muted">{r.model}</span>
                <span className="tabular text-right text-muted">{r.ms == null ? "—" : `${(r.ms / 1000).toFixed(1)}s`}</span>
                <span className="tabular text-right text-faint">{r.tokens}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="-mt-3 text-[11px] text-faint">
        Last changed {fmtDate(a.updatedAt)}
        {a.updatedBy && ` by ${a.updatedBy}`}. Changes apply to the next call, within a minute.
      </p>
    </section>
  );
}

/** Every AI agent in the app: its model, effort, instructions, what it reads, and what it knows. */
export function AgentsPanel({ agents, knowledge }: { agents: Agent[]; knowledge: Knowledge[] }) {
  const shared = knowledge.filter((k) => k.agentKey === null);
  return (
    <div className="grid gap-6">
      <nav className="flex flex-wrap gap-1.5">
        {agents.map((a) => (
          <a key={a.key} href={`#${a.key}`} className="inline-flex h-9 items-center gap-2 rounded-full border border-line px-4 text-sm text-muted transition-colors hover:text-fg">
            {a.label}
            <span className="text-[11px] capitalize text-faint">{a.model}</span>
          </a>
        ))}
        <a href="#shared" className="inline-flex h-9 items-center rounded-full border border-line px-4 text-sm text-muted transition-colors hover:text-fg">
          Shared knowledge
        </a>
      </nav>

      {agents.map((a) => (
        <AgentCard key={a.key} a={a} knowledge={knowledge} />
      ))}

      <section id="shared" className="grid gap-4 rounded-[14px] border border-line bg-surface p-6">
        <div>
          <h2 className="font-heading text-[20px]">Shared knowledge</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted">Every agent reads these: agency-wide brand rules, Meta policy, how Kaizen likes things done.</p>
        </div>
        {shared.length > 0 && (
          <ul className="grid gap-2">
            {shared.map((k) => (
              <KnowledgeItem key={k.id} k={k} />
            ))}
          </ul>
        )}
        <AddKnowledge agentKey="all" />
      </section>
    </div>
  );
}
