"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { field } from "@/components/ui";
import { pushParams, useParam } from "@/lib/url-state";
import { createClient as createBrowserClient } from "@/lib/supabase/client";
import type { AgentFile, Attachment } from "@/lib/agent-docs";
import { AGENT_TINT, tintOf } from "@/lib/agent-look";
import { EFFORT_TRADEOFFS, TRADEOFFS, costIf, costOf, type ModelKey as CostModel, type Usage } from "@/lib/ai-costs";
import {
  addItem,
  applyChange,
  applyRoleChange,
  chatWithAgent,
  chatWithCoach,
  clearChat,
  clearRoleChat,
  deleteItem,
  saveAgentSetup,
  saveRoleCore,
  saveSpine,
  setItemActive,
  updateItem,
  type Change,
  type ChatMessage,
  type RoleChatMessage,
} from "./actions";

type Result = { ok: true } | { ok: false; error: string };
export type AgentKey = import("@/lib/ai").AgentKey;
export type Agent = {
  key: AgentKey;
  roleKey: string | null;
  roleLabel: string | null;
  proposals: number; // the Coach's and the Ads Lab's edits not applied yet
  label: string;
  description: string;
  icon: string;
  model: "opus" | "sonnet" | "haiku";
  effort: "low" | "medium" | "high";
  instructions: string;
  live: boolean;
  updatedAt: string;
  updatedBy: string | null;
  stats: { runs: number; avgMs: number | null; inTokens: number; outTokens: number; failed: number };
  /** What it cost over the last 7 days, in dollars */
  cost7: number;
  /** This month's tokens by the model they ran on */
  mtd: Partial<Record<CostModel, Usage>>;
  lastAt: string | null; // the last time it ran, ever
  moments: { title: string; where: string; trigger: "auto" | "click"; when: string; runs7: number; lastAt: string | null }[];
  recent: { at: string; moment: string | null; label: string; model: string; ms: number | null; tokens: string; ok: boolean; error: string | null }[];
};

// "3 min ago", "2 hours ago", "4 days ago"
const ago = (iso: string | null) => {
  if (!iso) return null;
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} hour${Math.round(m / 60) === 1 ? "" : "s"} ago` : `${Math.round(m / 1440)} days ago`;
};
export type Kind = "knowledge" | "skill" | "example";
export type Item = { id: string; agentKey: string | null; kind: Kind; title: string; body: string; fileName: string | null; active: boolean; updatedAt: string };

const MODELS = [
  { key: "opus", name: "Opus", hint: "Deepest judgement. Slowest, costs the most.", meter: 3 },
  { key: "sonnet", name: "Sonnet", hint: "Strong and quick. The everyday choice.", meter: 2 },
  { key: "haiku", name: "Haiku", hint: "Fastest and cheapest. Great for gathering and summarizing.", meter: 1 },
] as const;
const EFFORTS = [
  { key: "low", name: "Low", hint: "Answers fast. Best when someone is waiting." },
  { key: "medium", name: "Medium", hint: "Thinks it through. Good for checks and writing." },
  { key: "high", name: "High", hint: "Thinks hardest. Slowest; for decisions that cost money." },
] as const;
const KINDS: Record<Kind, { name: string; plural: string; hint: string; tone: string; dot: string }> = {
  skill: { name: "Skill", plural: "Skills", hint: "A method to follow: a framework, checklist or procedure.", tone: "bg-brand-soft text-brand-text", dot: "bg-brand" },
  knowledge: { name: "Knowledge", plural: "Knowledge", hint: "Facts to know: brand rules, policies, offers, how Kaizen works.", tone: "bg-surface-2 text-muted", dot: "bg-fg/50" },
  example: { name: "Example", plural: "Examples", hint: "What good looks like: a brief or copy you loved.", tone: "bg-ok-soft text-ok", dot: "bg-ok" },
};

const ICONS: Record<string, string> = {
  compass: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm3.5-12.5-2 5-5 2 2-5z",
  shield: "M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6zm-3 9 2 2 4-4",
  feed: "M4 5h16M4 10h16M4 15h10M4 20h7",
  pen: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  rocket: "M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2m-1-4 4 4m-6-6c1-4 5-9 12-9 0 7-5 11-9 12m3-7a1.5 1.5 0 1 0 0-.01",
  pulse: "M3 12h4l2-6 4 12 2-6h6",
  film: "M4 5h16v14H4zM8 5v14M16 5v14M4 9h4M4 15h4M16 9h4M16 15h4",
  book: "M5 4h10a4 4 0 0 1 4 4v12H9a4 4 0 0 1-4-4zM5 16a4 4 0 0 1 4-4h10",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  scan: "M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-4a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0-4a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  spark: "M12 3c.7 5 3 7.3 8 8v2c-5 .7-7.3 3-8 8h-.1c-.7-5-3-7.3-8-8v-2c5-.7 7.3-3 8-8z",
};
const TINT = AGENT_TINT;

const fmt = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
const tokensOf = (s: string) => Math.round(s.length / 4);

function AgentIcon({ icon, size = 44 }: { icon: string; size?: number }) {
  const tint = TINT[icon] ?? TINT.spark;
  return (
    <span className="relative grid shrink-0 place-items-center rounded-[14px]" style={{ width: size, height: size, background: `${tint}22`, color: tint, boxShadow: `inset 0 0 0 1px ${tint}33` }}>
      <svg width={size * 0.46} height={size * 0.46} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d={ICONS[icon] ?? ICONS.spark} />
      </svg>
    </span>
  );
}

// ─── Unsaved changes ─────────────────────────────────────────────────────────
// Every editor that has changes registers itself; the banner at the bottom saves or discards them all.

type Pending = { label: string; save: () => Promise<Result>; discard: () => void };
const DirtyCtx = createContext<{ set: (id: string, p: Pending | null) => void } | null>(null);

function useDirty(id: string, dirty: boolean, p: Omit<Pending, "label"> & { label: string }) {
  const ctx = useContext(DirtyCtx);
  const ref = useRef(p);
  // Keep the latest save/discard (they close over the editor's current values)
  useEffect(() => {
    ref.current = p;
  });
  useEffect(() => {
    if (!ctx) return;
    ctx.set(id, dirty ? { label: ref.current.label, save: () => ref.current.save(), discard: () => ref.current.discard() } : null);
    return () => ctx.set(id, null);
  }, [ctx, id, dirty, p.label]);
}

function DirtyProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<Record<string, Pending>>({});
  const [saving, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const set = useCallback((id: string, p: Pending | null) => {
    setPending((cur) => {
      if (!p && !(id in cur)) return cur;
      const next = { ...cur };
      if (p) next[id] = p;
      else delete next[id];
      return next;
    });
  }, []);
  const list = Object.values(pending);

  // Leaving the page with unsaved edits asks first
  useEffect(() => {
    if (!list.length) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [list.length]);

  return (
    <DirtyCtx.Provider value={useMemo(() => ({ set }), [set])}>
      {children}
      {/* Phones: it sits just above the tab bar */}
      <div
        className={`pointer-events-none fixed inset-x-0 bottom-[calc(58px+env(safe-area-inset-bottom))] z-40 flex justify-center px-3 pb-3 transition-all duration-300 md:bottom-0 md:px-4 md:pb-5 md:pl-[240px] ${list.length ? "translate-y-0 opacity-100" : "invisible translate-y-6 opacity-0 md:visible"}`}
      >
        <div className="pointer-events-auto flex w-full max-w-3xl flex-wrap items-center gap-x-3 gap-y-2 rounded-[16px] border border-warn/40 bg-surface/95 px-4 py-3 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.8)] backdrop-blur md:px-5 md:py-3.5">
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warn opacity-50" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-warn" />
          </span>
          <p className="min-w-0 flex-1 text-sm">
            <span className="font-medium">Unsaved changes</span>
            <span className="text-muted max-md:line-clamp-2 max-md:[overflow-wrap:anywhere]"> · {list.map((p) => p.label).join(", ")}</span>
            {error && <span className="block text-xs text-bad">{error}</span>}
          </p>
          <button onClick={() => (list.forEach((p) => p.discard()), setError(null))} disabled={saving} className="h-11 flex-1 rounded-full border border-line px-4 text-sm text-muted transition-colors hover:text-fg md:h-9 md:flex-none md:border-0">
            Discard
          </button>
          <button
            disabled={saving}
            onClick={() =>
              start(async () => {
                setError(null);
                for (const p of list) {
                  const r = await p.save();
                  if (!r.ok) return setError(`${p.label}: ${r.error}`);
                }
                router.refresh();
              })
            }
            className="h-11 flex-[2] rounded-full bg-brand px-5 text-sm font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-60 md:h-9 md:flex-none"
          >
            {saving ? "Saving…" : list.length > 1 ? `Save all ${list.length}` : "Save changes"}
          </button>
        </div>
      </div>
    </DirtyCtx.Provider>
  );
}

// ─── Overview ────────────────────────────────────────────────────────────────

function ModelMeter({ model }: { model: Agent["model"] }) {
  const n = MODELS.find((m) => m.key === model)?.meter ?? 1;
  return (
    <span className="inline-flex items-end gap-0.5" aria-hidden>
      {[1, 2, 3].map((i) => (
        <span key={i} className={`w-1 rounded-full ${i <= n ? "bg-fg/80" : "bg-fg/15"}`} style={{ height: 4 + i * 3 }} />
      ))}
    </span>
  );
}

export function AgentsOverview({ agents, items }: { agents: Agent[]; items: Item[] }) {
  const shared = items.filter((k) => k.agentKey === null);
  return (
    <DirtyProvider>
      <div className="grid gap-8">
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {agents.map((a) => {
            const mine = items.filter((k) => k.agentKey === a.key && k.active);
            const count = (kind: Kind) => mine.filter((k) => k.kind === kind).length;
            const tint = TINT[a.icon] ?? TINT.spark;
            return (
              <li key={a.key}>
                <Link
                  href={`/settings?tab=agents&agent=${a.key}`}
                  className="group relative grid h-full content-start gap-5 overflow-hidden rounded-[18px] border border-line bg-surface p-5 transition-all active:bg-surface-2/40 md:p-6 duration-200 hover:-translate-y-0.5 hover:border-faint/70 hover:shadow-[0_24px_60px_-30px_rgba(0,0,0,0.9)]"
                >
                  <span aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full opacity-[0.13] blur-2xl transition-opacity group-hover:opacity-25" style={{ background: tint }} />
                  <div className="relative flex items-start justify-between gap-3">
                    <AgentIcon icon={a.icon} size={48} />
                    {a.live ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-ok-soft px-2.5 py-1 text-[11px] text-ok">
                        <span className="relative flex h-1.5 w-1.5">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-60" />
                          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-ok" />
                        </span>
                        Working
                      </span>
                    ) : (
                      <span className="rounded-full border border-dashed border-line px-2.5 py-1 text-[11px] text-faint">Coming soon</span>
                    )}
                  </div>
                  <div className="relative">
                    <h3 className="font-heading text-[20px] leading-snug">{a.label}</h3>
                    <p className="mt-1.5 line-clamp-3 text-sm leading-relaxed text-muted">{a.description}</p>
                  </div>
                  <div className="relative mt-auto grid gap-4">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {(["skill", "knowledge", "example"] as const).map((k) =>
                        count(k) ? (
                          <span key={k} className={`rounded-full px-2.5 py-1 text-[11px] ${KINDS[k].tone}`}>
                            {count(k)} {count(k) === 1 ? KINDS[k].name.toLowerCase() : KINDS[k].plural.toLowerCase()}
                          </span>
                        ) : null,
                      )}
                      {!mine.length && <span className="text-[11px] text-faint">No skills yet</span>}
                    </div>
                    <div className="flex items-center justify-between border-t border-line pt-4 text-xs">
                      <span className="flex items-center gap-2 text-muted">
                        <ModelMeter model={a.model} />
                        <span className="capitalize text-fg">{a.model}</span>
                        <span className="text-faint">· {a.effort} effort</span>
                      </span>
                      <span className="text-right text-faint">
                        {a.stats.runs ? `${a.stats.runs} runs this week` : a.lastAt ? "No runs this week" : "No runs yet"}
                        {a.lastAt && <span className="block text-[11px]">last {ago(a.lastAt)}</span>}
                      </span>
                    </div>
                  </div>
                  <span className="absolute bottom-6 right-6 hidden translate-x-1 text-sm text-muted opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100 xl:block" aria-hidden>
                    →
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>

        <section className="grid gap-4 rounded-[18px] border border-line bg-surface p-4 md:p-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="font-heading text-[20px]">Shared knowledge</h2>
              <p className="mt-1 text-sm text-muted">Every agent reads these: how Kaizen works, Meta policy, formats and specs.</p>
            </div>
            <span className="tabular text-xs text-faint">~{shared.filter((k) => k.active).reduce((t, k) => t + tokensOf(k.body), 0).toLocaleString()} tokens</span>
          </div>
          <ItemList items={shared} agentKey={null} />
        </section>
      </div>
    </DirtyProvider>
  );
}

// ─── Items (skills, knowledge, examples) with a pencil to edit ─────────────

function ItemCard({ item, readOnly = false }: { item: Item; readOnly?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState(item.kind);
  const [title, setTitle] = useState(item.title);
  const [body, setBody] = useState(item.body);
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const dirty = editing && (kind !== item.kind || title !== item.title || body !== item.body);
  const discard = () => {
    setKind(item.kind);
    setTitle(item.title);
    setBody(item.body);
    setEditing(false);
  };
  const save = async () => {
    const r = await updateItem(item.id, { kind, title, body });
    if (r.ok) setEditing(false);
    return r;
  };
  useDirty(`item:${item.id}`, dirty, { label: `${KINDS[kind].name}: ${title || "untitled"}`, save, discard });
  const meta = KINDS[item.kind];

  if (editing)
    return (
      <li className="grid gap-3 rounded-[14px] border border-brand/40 bg-bg p-4 shadow-[0_0_0_4px_var(--brand-soft)]">
        <div className="grid gap-3 sm:grid-cols-[150px_minmax(0,1fr)]">
          <select value={kind} onChange={(e) => setKind(e.target.value as Kind)} className={field}>
            {(Object.keys(KINDS) as Kind[]).map((k) => (
              <option key={k} value={k}>
                {KINDS[k].name}
              </option>
            ))}
          </select>
          <input value={title} onChange={(e) => setTitle(e.target.value)} className={field} />
        </div>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={Math.min(22, Math.max(8, body.split("\n").length + 2))} className={`${field} h-auto py-3 text-[13px] font-normal leading-relaxed`} />
        <div className="flex flex-wrap items-center gap-2">
          <button
            disabled={busy || !dirty}
            onClick={() =>
              start(async () => {
                const r = await save();
                if (r.ok) router.refresh();
                else setError(r.error);
              })
            }
            className="h-11 rounded-full bg-brand px-5 md:h-9 md:px-4 text-sm font-medium text-white disabled:opacity-40"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          <button onClick={discard} className="h-11 rounded-full px-4 text-sm md:h-9 text-muted hover:text-fg">
            Cancel
          </button>
          <span className="tabular ml-auto text-[11px] text-faint">~{tokensOf(body).toLocaleString()} tokens</span>
          <button
            onClick={() => {
              if (!confirm(`Delete "${item.title}"? This can't be undone.`)) return;
              start(async () => {
                const r = await deleteItem(item.id);
                if (r.ok) router.refresh();
                else setError(r.error);
              });
            }}
            className="h-11 rounded-full px-3 text-sm md:h-9 text-faint hover:text-bad"
          >
            Delete
          </button>
        </div>
        {error && <p className="text-xs text-bad">{error}</p>}
      </li>
    );

  return (
    <li className={`group relative grid gap-2 rounded-[14px] border border-line bg-bg p-4 transition-colors hover:border-faint/60 ${item.active ? "" : "opacity-50"}`}>
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[11px] ${meta.tone}`}>{meta.name}</span>
        <p className="min-w-0 flex-1 text-sm font-medium leading-snug">
          {item.title}
          {item.fileName && <span className="font-normal text-faint"> · {item.fileName}</span>}
          {!item.active && <span className="font-normal text-faint"> · off</span>}
        </p>
        {!readOnly && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={() => start(async () => void ((await setItemActive(item.id, !item.active)).ok && router.refresh()))}
              className="inline-flex h-11 items-center rounded-full px-2.5 text-[11px] text-faint transition-opacity hover:text-fg active:bg-surface-2 md:h-auto md:py-1 md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100"
            >
              {item.active ? "Turn off" : "Turn on"}
            </button>
            <button onClick={() => setEditing(true)} aria-label={`Edit ${item.title}`} className="grid h-11 w-11 place-items-center active:bg-surface-2 md:h-8 md:w-8 rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-fg">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />
              </svg>
            </button>
          </div>
        )}
      </div>
      <p className="line-clamp-3 whitespace-pre-line text-xs leading-relaxed text-muted">{item.body}</p>
      <p className="tabular text-[11px] text-faint">~{tokensOf(item.body).toLocaleString()} tokens · updated {fmt(item.updatedAt)}</p>
    </li>
  );
}

function NewItem({ agentKey, kind, onDone }: { agentKey: string | null; kind: Kind; onDone: () => void }) {
  const [k, setK] = useState(kind);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [file, setFile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const router = useRouter();
  const save = async () => {
    const r = await addItem({ agentKey, kind: k, title, body, fileName: file });
    if (r.ok) onDone();
    return r;
  };
  useDirty(`new:${agentKey}`, Boolean(title || body), { label: `New ${KINDS[k].name.toLowerCase()}`, save, discard: onDone });
  return (
    <div className="grid gap-3 rounded-[14px] border border-brand/40 bg-bg p-4 shadow-[0_0_0_4px_var(--brand-soft)]">
      <div className="grid gap-3 sm:grid-cols-[150px_minmax(0,1fr)]">
        <select value={k} onChange={(e) => setK(e.target.value as Kind)} className={field}>
          {(Object.keys(KINDS) as Kind[]).map((x) => (
            <option key={x} value={x}>
              {KINDS[x].name}
            </option>
          ))}
        </select>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={k === "skill" ? "e.g. Hook writing framework" : k === "example" ? "e.g. Nectr brief that won" : "e.g. Holiday offer calendar"} className={field} />
      </div>
      <p className="-mt-1 text-xs text-faint">{KINDS[k].hint}</p>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} placeholder="Paste it here, or upload a text file." className={`${field} h-auto py-3 text-[13px] font-normal leading-relaxed`} />
      <div className="flex flex-wrap items-center gap-2">
        <button
          disabled={busy || !title.trim() || !body.trim()}
          onClick={() =>
            start(async () => {
              const r = await save();
              if (r.ok) router.refresh();
              else setError(r.error);
            })
          }
          className="h-11 rounded-full bg-brand px-5 md:h-9 md:px-4 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? "Adding…" : "Add"}
        </button>
        <button onClick={onDone} className="h-11 rounded-full px-4 text-sm md:h-9 text-muted hover:text-fg">
          Cancel
        </button>
        <label className="inline-flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-full border border-line px-3 py-1.5 text-xs sm:ml-auto sm:w-auto md:min-h-0 text-muted hover:text-fg">
          <input
            type="file"
            accept=".txt,.md,.markdown,.csv,.json,.html,text/*"
            className="sr-only"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              if (f.size > 500_000) return setError("That file is over 500 KB. Paste the part that matters.");
              setError(null);
              setFile(f.name);
              setBody(await f.text());
              if (!title) setTitle(f.name.replace(/\.[^.]+$/, ""));
            }}
          />
          Upload .txt / .md / .csv
        </label>
      </div>
      {error && <p className="text-xs text-bad">{error}</p>}
    </div>
  );
}

function ItemList({ items, agentKey }: { items: Item[]; agentKey: string | null }) {
  const [adding, setAdding] = useState<Kind | null>(null);
  return (
    <div className="grid gap-3">
      {items.length > 0 && (
        <ul className="grid gap-3 lg:grid-cols-2">
          {items.map((k) => (
            <ItemCard key={`${k.id}:${k.updatedAt}`} item={k} />
          ))}
        </ul>
      )}
      {adding ? (
        <NewItem agentKey={agentKey} kind={adding} onDone={() => setAdding(null)} />
      ) : (
        <div className="flex flex-wrap gap-2">
          {(["skill", "knowledge", "example"] as const).map((k) => (
            <button key={k} onClick={() => setAdding(k)} className="inline-flex h-11 items-center gap-2 md:h-9 rounded-full border border-dashed border-line px-4 text-sm text-muted transition-colors hover:border-faint hover:text-fg">
              <span className={`h-1.5 w-1.5 rounded-full ${KINDS[k].dot}`} />+ {KINDS[k].name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── One agent ───────────────────────────────────────────────────────────────

/**
 * What switching this skill's model or effort would do: this month's actual cost against the same work repriced on
 * the picked model (output scaled for the effort), projected over the month, with what's gained and given up.
 */
function CostCompare({ a, model, effort }: { a: Agent; model: string; effort: string }) {
  const used = Object.values(a.mtd).filter((u): u is Usage => Boolean(u));
  const runs = used.reduce((t, u) => t + u.runs, 0);
  const actual = Object.entries(a.mtd).reduce((t, [m, u]) => t + (u ? costOf(m, u) : 0), 0);
  const same = model === a.model && effort === a.effort;
  const next = costIf(a.mtd, a.effort as "low" | "medium" | "high", { model: model as CostModel, effort: effort as "low" | "medium" | "high" });
  const day = new Date().getDate();
  const days = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const month = (n: number) => (n / Math.max(1, day)) * days;
  const diff = actual ? (next - actual) / actual : 0;
  const t = TRADEOFFS[model as CostModel];
  const e = EFFORT_TRADEOFFS[effort as "low" | "medium" | "high"];
  return (
    <div className={`grid gap-3 rounded-[14px] border p-4 transition-colors ${same ? "border-line bg-bg" : diff < 0 ? "border-ok/40 bg-ok-soft/30" : "border-warn/40 bg-warn-soft/30"}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">{same ? "What this skill costs" : "If you make this change"}</p>
        <p className="text-[11px] text-faint">{runs ? `${runs.toLocaleString()} runs this month` : "No runs yet this month"}</p>
      </div>
      {runs > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-0.5">
            <span className="text-xs text-muted">This month so far</span>
            <span className="tabular font-heading text-[22px] leading-none">{money(actual)}</span>
            <span className="tabular text-[11px] text-faint">about {money(month(actual))} for the month · {money(actual / runs)} a run</span>
          </div>
          {!same && (
            <div className="grid gap-0.5">
              <span className="text-xs text-muted">
                The same work on {model[0].toUpperCase() + model.slice(1)}, {effort} effort
              </span>
              <span className={`tabular font-heading text-[22px] leading-none ${diff < 0 ? "text-ok" : "text-warn"}`}>
                {money(next)} <span className="text-sm">({diff < 0 ? "" : "+"}{Math.round(diff * 100)}%)</span>
              </span>
              <span className="tabular text-[11px] text-faint">
                about {money(month(next))} for the month · {diff < 0 ? "saves" : "adds"} about {money(Math.abs(month(next) - month(actual)))}
              </span>
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted">Once it runs this month, the cost of switching shows here.</p>
      )}
      {!same && (
        <ul className="grid gap-1.5 text-[12.5px] leading-relaxed">
          {model !== a.model && (
            <>
              <li className="flex gap-2"><span className="text-ok">+</span><span>{t.good}</span></li>
              <li className="flex gap-2"><span className="text-warn">−</span><span>{t.watch}</span></li>
            </>
          )}
          {effort !== a.effort && (
            <>
              <li className="flex gap-2"><span className="text-ok">+</span><span>{e.good}</span></li>
              {e.watch && <li className="flex gap-2"><span className="text-warn">−</span><span>{e.watch}</span></li>}
            </>
          )}
        </ul>
      )}
      {!same && <p className="text-[10.5px] text-faint">An estimate: this month&apos;s tokens repriced, with output scaled for effort. Quality changes aren&apos;t priced in, so check a few results after switching.</p>}
    </div>
  );
}

function Setup({ a }: { a: Agent }) {
  const [model, setModel] = useState(a.model);
  const [effort, setEffort] = useState(a.effort);
  const [instructions, setInstructions] = useState(a.instructions);
  const dirty = model !== a.model || effort !== a.effort || instructions !== a.instructions;
  useDirty(`setup:${a.key}`, dirty, {
    label: "Model and instructions",
    save: () => saveAgentSetup(a.key, { model, effort, instructions }),
    discard: () => {
      setModel(a.model);
      setEffort(a.effort);
      setInstructions(a.instructions);
    },
  });
  return (
    <div className="grid gap-8">
      <div className="grid gap-4">
        <p className="text-sm font-medium">Brain</p>
        <div className="grid gap-3 md:grid-cols-3">
          {MODELS.map((m) => {
            const on = model === m.key;
            return (
              <button
                key={m.key}
                onClick={() => setModel(m.key)}
                className={`grid gap-2 rounded-[14px] border p-4 text-left transition-all ${on ? "border-fg/60 bg-surface-2 shadow-[0_0_0_4px_rgba(255,255,255,0.04)]" : "border-line bg-bg hover:border-faint/60"}`}
              >
                <span className="flex items-center justify-between">
                  <span className="font-heading text-[17px]">{m.name}</span>
                  <ModelMeter model={m.key} />
                </span>
                <span className="text-xs leading-relaxed text-muted">{m.hint}</span>
              </button>
            );
          })}
        </div>
        <div className="grid gap-2">
          <div className="grid grid-cols-3 gap-1 rounded-[12px] border border-line bg-bg p-1">
            {EFFORTS.map((e) => (
              <button key={e.key} onClick={() => setEffort(e.key)} className={`min-h-11 rounded-[9px] px-2 py-2 text-sm transition-colors md:min-h-0 md:px-3 ${effort === e.key ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
                {e.name}
                <span className="hidden sm:inline"> effort</span>
              </button>
            ))}
          </div>
          <p className="text-xs text-faint">{EFFORTS.find((e) => e.key === effort)?.hint}</p>
        </div>
        <CostCompare a={a} model={model} effort={effort} />
      </div>

      <div className="grid gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-medium">Instructions</p>
          <p className="text-xs text-faint">How it thinks, what matters most, hard rules. ~{tokensOf(instructions).toLocaleString()} tokens</p>
        </div>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={Math.min(26, Math.max(10, instructions.split("\n").length + 2))}
          className={`${field} h-auto py-4 text-[13.5px] font-normal leading-relaxed`}
        />
      </div>
    </div>
  );
}

const CHANGE_LABEL: Record<Change["op"], string> = {
  set_instructions: "Rewrite instructions",
  update_item: "Update",
  add_item: "Add",
  turn_off_item: "Turn off",
  set_model: "Switch brain",
  set_core: "Rewrite core",
};

function ChangeCard({ c, onApply, items, skill = null }: { c: Change; onApply: () => Promise<void>; items: Item[]; skill?: string | null }) {
  const [open, setOpen] = useState(false);
  const [busy, start] = useTransition();
  const target = items.find((i) => i.id === c.item_id);
  const title =
    c.op === "set_model"
      ? `${c.model ? c.model[0].toUpperCase() + c.model.slice(1) : ""}${c.effort ? ` · ${c.effort} effort` : ""}`
      : c.op === "set_instructions" || c.op === "set_core"
        ? ""
        : c.title || target?.title || "";
  return (
    <div className={`grid gap-2 rounded-[12px] border p-3.5 ${c.applied ? "border-ok/40 bg-ok-soft/30" : "border-line bg-bg"}`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {skill && (
            <p className="mb-1.5">
              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] ${c.skill === "core" ? "bg-brand-soft text-brand-text" : "bg-surface-2 text-muted"}`}>{skill}</span>
            </p>
          )}
          <p className="text-sm [overflow-wrap:anywhere]">
            <span className="font-medium">{CHANGE_LABEL[c.op]}</span>
            {c.op === "add_item" && c.kind && <span className="text-muted"> {KINDS[c.kind as Kind]?.name.toLowerCase()}</span>}
            {title && <span className="text-muted"> · {title}</span>}
            {c.scope === "shared" && <span className="text-faint"> (shared)</span>}
          </p>
          {c.reason && <p className="mt-0.5 text-xs text-faint">{c.reason}</p>}
        </div>
        {c.applied ? (
          <span className="shrink-0 text-xs text-ok">✓ Applied</span>
        ) : (
          <button disabled={busy} onClick={() => start(onApply)} className="h-11 shrink-0 rounded-full bg-fg px-4 text-xs font-medium text-bg disabled:opacity-50 md:h-8 md:px-3.5">
            {busy ? "Applying…" : "Apply"}
          </button>
        )}
      </div>
      {c.body && (
        <>
          <button onClick={() => setOpen((o) => !o)} className="min-h-11 justify-self-start text-xs text-muted hover:text-fg md:min-h-0">
            {open ? "Hide" : "See"} the new text
          </button>
          {open && <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-[8px] bg-surface p-3 font-sans text-xs leading-relaxed text-muted">{c.body}</pre>}
        </>
      )}
    </div>
  );
}

const STARTERS: Record<string, string[]> = {
  suggest: ["The briefs feel too generic. Make them more specific.", "Always include one UGC-style video idea.", "What do you look at first when you suggest an angle?"],
  review: ["You're flagging too many small things. Only real problems.", "Block anything that mentions a competitor by name.", "Walk me through how you decide block vs warn."],
  briefing: ["Put client complaints at the very top, always.", "Performance lines need cost per result and ROAS.", "What's missing from how you write briefings?"],
  copy: ["Keep headlines under 30 characters.", "Here's an example of copy we loved: …", "Our school clients need a warmer, parent-to-parent voice."],
  launcher: ["Here's our naming convention: …", "Never put prospecting and retargeting in the same ad set.", "What do you need from us before you can launch?"],
  fatigue: ["Frequency of 2.5 is already too high for our small accounts.", "Ignore ads with under $100 spend.", "How would you decide what to make next?"],
  scripts: ["Scripts run too long. Keep them under 30 seconds.", "Always give one founder-to-camera option.", "Which framework would you pick for a law firm?"],
  brandbible: ["Every bible needs a competitor ad table with links.", "Keep Read this first to half a page.", "What do you need from us before you build one?"],
};

// Feedback to the whole agent, starting points per agent
const ROLE_STARTERS: Record<string, string[]> = {
  strategist: ["Your briefs are too wordy. Get to the angle faster.", "Walk me through how you pick an angle for a new client.", "Always tie the angle back to the client's offer."],
  creative_director: ["You're flagging too many small things in reviews.", "How do you decide a piece is ready for the client?", "Every video needs the hook in the first 2 seconds."],
  copywriter: ["Keep headlines under 30 characters.", "How do you pick the voice for a new client?", "Our school clients need a warmer, parent-to-parent voice."],
  media_buyer: ["Always check frequency before calling fatigue.", "How do you decide an ad is fatigued?", "Ignore ads with under $100 spend."],
  google_buyer: ["How do you audit a Google account?", "Never raise a budget more than 20% in a day.", "Always check search terms before adding negatives."],
  market_analyst: ["How do you research a new vertical?", "Benchmarks need a source and a date.", "What do you look at first in a market?"],
  account_manager: ["Put client complaints at the very top, always.", "How do you decide a client is at risk?", "Keep briefings to what changed since last time."],
};

type ChatMsg = { id: number; role: "user" | "coach" | "agent"; content: string; changes: Change[]; at: string; attachments?: Attachment[] };

// Training material dropped into an agent chat: up to 6 files of 50 MB, stored privately under the agent's key
const MAX_FILE = 50 * 1024 * 1024;
const safeName = (n: string) => n.normalize("NFKD").replace(/[^\w.\-]+/g, "-").replace(/-+/g, "-").slice(-120);
const PAPERCLIP = "m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5";

/** One running conversation with an agent or one of its skills: messages, proposed edits with Apply, and the composer. */
function ChatPanel({
  icon,
  heading,
  intro,
  starters,
  placeholder,
  footnote,
  thinkingLabel,
  initial,
  items,
  skillName,
  onSend,
  onApply,
  onClear,
  folder,
  tall = false,
}: {
  icon: string;
  heading: string;
  intro: string;
  starters: string[];
  placeholder: string;
  footnote: string;
  thinkingLabel: string;
  initial: ChatMsg[];
  items: Item[];
  /** In the agent chat: the name of the skill (or "Core") each change touches */
  skillName?: (c: Change) => string | null;
  onSend: (msg: string, files: AgentFile[]) => Promise<{ ok: true; messages: ChatMsg[] } | { ok: false; error: string }>;
  onApply: (chatId: number, index: number) => Promise<Result>;
  onClear: () => Promise<Result>;
  /** Where files shared in this chat are stored (the agent's or skill's key) */
  folder: string;
  tall?: boolean;
}) {
  const [messages, setMessages] = useState(initial);
  const [text, setText] = useState("");
  const [thinking, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const end = useRef<HTMLDivElement>(null);
  // Phones: the conversation opens full-screen over the app, the composer pinned at the bottom
  const [full, setFull] = useState(false);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages.length, thinking, full]);
  useEffect(() => {
    if (!full) return;
    const wide = window.matchMedia("(min-width: 768px)");
    const close = () => wide.matches && setFull(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setFull(false);
    const was = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    wide.addEventListener("change", close);
    window.addEventListener("keydown", esc);
    return () => {
      document.body.style.overflow = was;
      wide.removeEventListener("change", close);
      window.removeEventListener("keydown", esc);
    };
  }, [full]);
  const pendingEdits = messages.reduce((t, m) => t + m.changes.filter((c) => !c.applied).length, 0);
  const last = [...messages].reverse().find((m) => m.content.trim());

  // Files to share with the next message (dropped, picked or pasted); links are read straight from the message
  const [files, setFiles] = useState<File[]>([]);
  const [over, setOver] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const addFiles = (list: File[]) => {
    const ok = list.filter((f) => f.size <= MAX_FILE);
    if (ok.length < list.length) setError("Files over 50 MB were left out.");
    setFiles((cur) => [...cur, ...ok].slice(0, 6));
  };

  const send = (msg: string) => {
    if ((!msg.trim() && !files.length) || thinking) return;
    const sending = files;
    setError(null);
    setText("");
    setFiles([]);
    setMessages((m) => [...m, { id: -Date.now(), role: "user", content: msg, changes: [], at: new Date().toISOString(), attachments: sending.map((f) => ({ kind: "file" as const, name: f.name, note: null })) }]);
    start(async () => {
      const supabase = createBrowserClient();
      const uploaded: AgentFile[] = [];
      for (const f of sending) {
        const path = `${folder}/${crypto.randomUUID()}-${safeName(f.name)}`;
        const { error: e } = await supabase.storage.from("agent-docs").upload(path, f, { contentType: f.type || "application/octet-stream" });
        if (!e) uploaded.push({ path, name: f.name, mime: f.type, bytes: f.size });
      }
      const r = await onSend(msg, uploaded);
      if (r.ok) {
        setMessages(r.messages);
        if (uploaded.length < sending.length) setError(`${sending.length - uploaded.length} file${sending.length - uploaded.length === 1 ? "" : "s"} didn't upload.`);
      } else {
        setError(r.error);
        setText(msg);
        setFiles(sending);
        setMessages((m) => m.filter((x) => x.id > 0));
      }
    });
  };

  const panel = (
    <div
      role={full ? "dialog" : undefined}
      aria-modal={full || undefined}
      aria-label={full ? heading : undefined}
      className={
        full
          ? "fixed inset-0 z-[70] flex flex-col bg-bg pt-safe animate-[sheet-up_.28s_cubic-bezier(.2,.8,.2,1)]"
          : "relative overflow-hidden rounded-[16px] border border-line bg-bg"
      }
    >
      {full && (
        <div className="flex shrink-0 items-center gap-3 border-b border-line bg-surface/95 px-3 py-2 backdrop-blur">
          <button type="button" onClick={() => setFull(false)} aria-label="Close the conversation" className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted active:bg-surface-2">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
          <AgentIcon icon={icon} size={32} />
          <p className="min-w-0 flex-1 truncate font-heading text-[16px]">{heading}</p>
        </div>
      )}
      <div
        className={
          full
            ? "min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5"
            : `${tall ? "max-h-[620px] min-h-[360px]" : "max-h-[560px] min-h-[320px]"} overflow-y-auto px-5 py-5`
        }
      >
          {messages.length === 0 && !thinking ? (
            <div className="grid justify-items-center gap-4 py-10 text-center">
              <AgentIcon icon={icon} size={56} />
              <div>
                <p className="font-heading text-[18px]">{heading}</p>
                <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-muted">{intro}</p>
              </div>
              <div className="flex max-w-xl flex-wrap justify-center gap-2">
                {starters.map((s) => (
                  <button
                    key={s}
                    onClick={() => (s.endsWith("…") ? setText(s.replace("…", "")) : send(s))}
                    className="min-h-11 rounded-full border border-line px-3.5 py-2 text-xs text-muted transition-colors hover:border-faint hover:text-fg active:bg-surface-2 md:min-h-0 md:py-1.5"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <ul className="grid gap-5">
              {messages.map((m) =>
                m.role === "user" ? (
                  <li key={m.id} className="ml-auto grid max-w-[85%] justify-items-end gap-1.5 md:max-w-[80%]">
                    {m.content && <p className="whitespace-pre-wrap rounded-[16px] rounded-br-[6px] bg-surface-2 px-4 py-2.5 text-sm leading-relaxed [overflow-wrap:anywhere]">{m.content}</p>}
                    {m.attachments && m.attachments.length > 0 && (
                      <span className="flex flex-wrap justify-end gap-1.5">
                        {m.attachments.map((a, i) => (
                          <span key={i} title={a.note ?? undefined} className={`inline-flex max-w-[260px] items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] ${a.note ? "border-warn/40 text-warn" : "border-line text-muted"}`}>
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <path d={a.kind === "link" ? "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" : PAPERCLIP} />
                            </svg>
                            <span className="truncate">{a.name}</span>
                            {a.note && <span className="shrink-0">· not read</span>}
                          </span>
                        ))}
                      </span>
                    )}
                  </li>
                ) : (
                  <li key={m.id} className="grid min-w-0 gap-3 md:max-w-[92%]">
                    <div className="flex items-start gap-3">
                      <AgentIcon icon={icon} size={28} />
                      <p className="min-w-0 whitespace-pre-wrap pt-1 text-sm leading-relaxed [overflow-wrap:anywhere]">{m.content}</p>
                    </div>
                    {m.changes.length > 0 && (
                      <div className="grid gap-2 md:ml-10">
                        {m.changes.map((c, i) => (
                          <ChangeCard
                            key={i}
                            c={c}
                            items={items}
                            skill={skillName?.(c) ?? null}
                            onApply={async () => {
                              const r = await onApply(m.id, i);
                              if (!r.ok) return setError(r.error);
                              setMessages((all) => all.map((x) => (x.id === m.id ? { ...x, changes: x.changes.map((y, j) => (j === i ? { ...y, applied: true } : y)) } : x)));
                              router.refresh();
                            }}
                          />
                        ))}
                      </div>
                    )}
                  </li>
                ),
              )}
              {thinking && (
                <li className="flex items-center gap-3">
                  <AgentIcon icon={icon} size={28} />
                  <span className="flex gap-1">
                    {[0, 1, 2].map((i) => (
                      <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted" style={{ animationDelay: `${i * 140}ms` }} />
                    ))}
                  </span>
                  <span className="text-xs text-faint">{thinkingLabel}</span>
                </li>
              )}
            </ul>
          )}
          <div ref={end} />
      </div>
      {full && error && <p className="shrink-0 border-t border-line bg-bad-soft px-4 py-2 text-xs text-bad">{error}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={(e) => e.currentTarget.contains(e.relatedTarget as Node) || setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          addFiles([...e.dataTransfer.files]);
        }}
        className={`grid shrink-0 gap-2 border-t p-3 transition-colors ${over ? "border-brand/60 bg-brand-soft" : "border-line bg-surface"} ${full ? "pb-[max(12px,env(safe-area-inset-bottom))]" : ""}`}
      >
        <input
          ref={picker}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            addFiles([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {files.map((f, i) => (
              <span key={`${f.name}-${i}`} className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-bg py-1 pl-3 pr-1 text-[11.5px] text-muted">
                <span className="truncate">{f.name}</span>
                <button type="button" onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`} className="grid h-7 w-7 place-items-center rounded-full text-faint hover:bg-surface-2 hover:text-fg md:h-5 md:w-5">
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {over && <p className="text-center text-xs text-muted">Drop to share: it reads the file and proposes what to change</p>}
        <div className="flex items-end gap-2">
        <button
          type="button"
          onClick={() => picker.current?.click()}
          aria-label="Share a file"
          title="Share files (PDF, Word, PowerPoint, Excel, text, pictures) or paste links: it reads them and proposes edits"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-[10px] border border-line text-muted hover:border-faint hover:text-fg md:h-10 md:w-10"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d={PAPERCLIP} />
          </svg>
        </button>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(text);
            }
          }}
          onPaste={(e) => {
            const pasted = [...e.clipboardData.files];
            if (pasted.length) {
              e.preventDefault();
              addFiles(pasted);
            }
          }}
          rows={Math.min(8, Math.max(1, text.split("\n").length))}
          placeholder={placeholder}
          className="min-h-11 min-w-0 flex-1 resize-none rounded-[10px] border border-line bg-bg px-3.5 py-2.5 text-sm outline-none focus:border-brand-text/60 md:min-h-10"
        />
        <button disabled={thinking || (!text.trim() && !files.length)} className="h-11 shrink-0 rounded-[10px] bg-brand px-4 text-sm font-medium text-white disabled:opacity-40 md:h-10">
          {files.length && !text.trim() ? "Share" : "Send"}
        </button>
        </div>
      </form>
    </div>
  );

  return (
    <div className="grid gap-4">
      {/* Phones: a card that opens the conversation full-screen */}
      <button
        type="button"
        onClick={() => setFull(true)}
        className="flex min-h-[72px] w-full items-center gap-3 rounded-[16px] border border-line bg-bg p-4 text-left transition-colors active:bg-surface-2 md:hidden"
      >
        <AgentIcon icon={icon} size={40} />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="truncate text-sm font-medium">{messages.length ? "Open the conversation" : heading}</span>
          <span className="line-clamp-2 text-xs leading-relaxed text-muted [overflow-wrap:anywhere]">
            {thinking ? thinkingLabel : last ? `${last.role === "user" ? "You: " : ""}${last.content}` : placeholder}
          </span>
        </span>
        {pendingEdits > 0 ? (
          <span className="shrink-0 rounded-full bg-brand-soft px-2 py-0.5 text-[10px] text-brand-text">{pendingEdits} to apply</span>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-faint" aria-hidden>
            <path d="m9 18 6-6-6-6" />
          </svg>
        )}
      </button>
      {full ? createPortal(panel, document.body) : <div className="hidden md:block">{panel}</div>}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        {error ? <span className="min-w-0 text-bad [overflow-wrap:anywhere]">{error}</span> : <span className="text-faint">{footnote}</span>}
        {messages.length > 0 && (
          <button
            onClick={() => {
              if (!confirm("Clear this conversation? Applied changes stay.")) return;
              void onClear().then((r) => (r.ok ? setMessages([]) : setError(r.error)));
            }}
            className="min-h-11 text-faint hover:text-fg md:min-h-0"
          >
            Clear conversation
          </button>
        )}
      </div>
    </div>
  );
}

/** Tune just this skill. The main conversation is with the whole agent, on its page. */
function Coach({ a, initial, items }: { a: Agent; initial: ChatMessage[]; items: Item[] }) {
  return (
    <ChatPanel
      icon={a.icon}
      heading={`Tune just the ${a.label.toLowerCase()}`}
      intro={`For feedback that's only about this one job. It finds the instruction or item that needs to change and proposes the exact edit.${a.roleLabel ? ` To talk to the whole ${a.roleLabel}, open its page.` : ""}`}
      starters={STARTERS[a.key] ?? []}
      placeholder={`Feedback for the ${a.label.toLowerCase()} only…`}
      footnote="Runs on Opus. Nothing changes until you press Apply."
      thinkingLabel="Reading its playbook…"
      initial={initial}
      items={items}
      folder={a.key}
      onSend={(msg, files) => chatWithCoach(a.key, msg, files)}
      onApply={(id, i) => applyChange(a.key, id, i)}
      onClear={() => clearChat(a.key)}
    />
  );
}

const TABS = [
  ["use", "Where it's used"],
  ["setup", "Brain & instructions"],
  ["playbook", "Skills & knowledge"],
  ["coach", "Tune this skill"],
  ["runs", "Runs"],
] as const;

export function AgentDetail({ a, items, chat }: { a: Agent; items: Item[]; chat: ChatMessage[] }) {
  // The skill's tab is in the address (?view=), so back returns to the tab read before
  const asked = useParam("view");
  const tab = TABS.find(([k]) => k === asked)?.[0] ?? "use";
  const setTab = (k: (typeof TABS)[number][0]) => pushParams({ view: k === "use" ? null : k });
  const mine = items.filter((k) => k.agentKey === a.key);
  const shared = items.filter((k) => k.agentKey === null && k.active);
  const tint = TINT[a.icon] ?? TINT.spark;
  const tokens = tokensOf(a.instructions) + [...mine.filter((k) => k.active), ...shared].reduce((t, k) => t + tokensOf(k.body), 0);

  return (
    <DirtyProvider>
      <div className="grid gap-6 pb-24">
        <Link href={a.roleKey ? `/settings?tab=agents&role=${a.roleKey}` : "/settings?tab=agents"} className="inline-flex min-h-11 items-center text-xs text-muted hover:text-fg md:min-h-0">
          ← {a.roleLabel ?? "All agents"}
        </Link>
        <header className="relative overflow-hidden rounded-[20px] border border-line bg-surface p-5 sm:p-8">
          <span aria-hidden className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full opacity-20 blur-3xl" style={{ background: tint }} />
          <div className="relative flex flex-wrap items-start gap-5">
            <AgentIcon icon={a.icon} size={64} />
            <div className="min-w-0 flex-1">
              {a.roleLabel && <p className="text-[11px] uppercase tracking-[0.16em] text-faint">Skill of the {a.roleLabel}</p>}
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-heading text-[24px] leading-tight [overflow-wrap:anywhere] md:text-[28px]">{a.label}</h2>
                {a.live ? <span className="rounded-full bg-ok-soft px-2.5 py-1 text-[11px] text-ok">Working in the app</span> : <span className="rounded-full border border-dashed border-line px-2.5 py-1 text-[11px] text-faint">Coming soon: shape it now</span>}
              </div>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">{a.description}</p>
            </div>
            {a.roleKey && a.roleLabel && (
              <Link
                href={`/settings?tab=agents&role=${a.roleKey}#talk`}
                className="inline-flex h-11 w-full shrink-0 items-center justify-center gap-2 active:bg-surface-2 md:h-9 md:w-auto md:justify-start rounded-full border border-line bg-bg/60 px-4 text-sm text-muted transition-colors hover:border-faint hover:text-fg"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden>
                  <path fill="currentColor" d={ICONS.spark} />
                </svg>
                Talk to the {a.roleLabel}
              </Link>
            )}
            <dl className="grid w-full grid-cols-2 gap-x-8 gap-y-3 border-t border-line pt-5 sm:grid-cols-5">
              {[
                ["Brain", `${a.model[0].toUpperCase()}${a.model.slice(1)} · ${a.effort}`],
                ["Reads", `~${tokens.toLocaleString()} tokens`],
                ["Runs, 7 days", a.stats.runs ? String(a.stats.runs) : "—"],
                ["Cost, 7 days", a.cost7 >= 0.005 ? `${money(a.cost7)} · ${money(a.cost7 / 7)}/day` : "—"],
                ["Last used", ago(a.lastAt) ?? "Never"],
                ["Avg time", a.stats.avgMs == null ? "—" : `${(a.stats.avgMs / 1000).toFixed(1)}s`],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-[11px] text-faint">{k}</dt>
                  <dd className="tabular mt-0.5 text-sm">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </header>

        <nav className="no-scrollbar -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-1.5 overflow-x-auto px-4 md:mx-0 md:snap-none md:flex-wrap md:overflow-visible md:px-0">
          {TABS.map(([k, name]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`inline-flex h-11 shrink-0 snap-start items-center gap-2 whitespace-nowrap rounded-full px-4 text-sm transition-colors md:h-9 ${tab === k ? "bg-fg text-bg" : "bg-surface text-muted hover:bg-surface-2 hover:text-fg active:bg-surface-2 md:bg-transparent"}`}
            >
              {k === "coach" && (
                <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden>
                  <path fill="currentColor" d={ICONS.spark} />
                </svg>
              )}
              {name}
              {k === "playbook" && <span className="tabular opacity-60">{mine.length}</span>}
            </button>
          ))}
        </nav>

        {/* Keep every tab mounted so unsaved edits survive switching tabs */}
        <section className={tab === "setup" ? "grid gap-6 rounded-[18px] border border-line bg-surface p-4 md:p-6" : "hidden"}>
          <Setup a={a} />
          <p className="text-[11px] text-faint">
            Last changed {fmt(a.updatedAt)}
            {a.updatedBy && ` by ${a.updatedBy}`}. Saved changes apply to its next run, within a minute.
          </p>
        </section>
        <section className={tab === "playbook" ? "grid gap-6 rounded-[18px] border border-line bg-surface p-4 md:p-6" : "hidden"}>
          <div>
            <h3 className="font-heading text-[18px]">Skills & knowledge</h3>
            <p className="mt-1 text-sm text-muted">What only this agent reads. Click the pencil to edit or overwrite one.</p>
          </div>
          <ItemList items={mine} agentKey={a.key} />
          {shared.length > 0 && (
            <div className="grid gap-3 border-t border-line pt-5">
              <p className="text-xs text-faint">
                Also reads {shared.length} shared {shared.length === 1 ? "item" : "items"} every agent uses (edit them under{" "}
                <Link href="/settings?tab=agents" className="text-muted underline-offset-4 hover:text-fg hover:underline">
                  Shared knowledge
                </Link>
                ):
              </p>
              <div className="flex flex-wrap gap-1.5">
                {shared.map((k) => (
                  <span key={k.id} className={`rounded-full px-2.5 py-1 text-[11px] ${KINDS[k.kind].tone}`}>
                    {k.title}
                  </span>
                ))}
              </div>
            </div>
          )}
        </section>
        <section className={tab === "use" ? "grid gap-5" : "hidden"}>
          <div className="grid gap-3 rounded-[18px] border border-line bg-surface p-4 md:p-6">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-heading text-[18px]">Where it comes in</h3>
              <span className="text-xs text-faint">
                {a.moments.length} {a.moments.length === 1 ? "moment" : "moments"} in the app · last used {ago(a.lastAt) ?? "never"}
              </span>
            </div>
            {a.moments.length === 0 ? (
              <p className="text-sm text-faint">Not wired into the app yet.</p>
            ) : (
              <ul className="grid divide-y divide-line">
                {a.moments.map((m) => {
                  const idle = !m.lastAt;
                  return (
                    <li key={m.title} className="flex flex-wrap items-start gap-x-4 gap-y-1.5 py-3.5">
                      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${m.runs7 ? "bg-ok" : idle ? "bg-surface-2 ring-1 ring-line" : "bg-warn"}`} />
                      <span className="grid min-w-0 flex-1 gap-0.5">
                        <span className="text-sm">{m.title}</span>
                        <span className="text-xs text-muted">
                          {m.where} · <span className="text-faint">{m.when}</span>
                        </span>
                      </span>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${m.trigger === "auto" ? "bg-surface-2 text-muted" : "bg-brand-soft text-brand-text"}`}>
                        {m.trigger === "auto" ? "Automatic" : "When someone clicks"}
                      </span>
                      <span className="w-full pl-6 text-xs md:w-36 md:shrink-0 md:pl-0 md:text-right">
                        <span className={`block tabular ${m.runs7 ? "text-fg" : "text-faint"}`}>{m.runs7 ? `${m.runs7} this week` : "None this week"}</span>
                        <span className="block text-[11px] text-faint">{m.lastAt ? `last ${ago(m.lastAt)}` : "not used yet"}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="text-[11px] text-faint">Green: used this week. Amber: used before, not this week. Grey: not used yet, worth checking it&apos;s reachable.</p>
          </div>

          <div className="grid gap-3 rounded-[18px] border border-line bg-surface p-4 md:p-6">
            <h3 className="font-heading text-[18px]">Most recent</h3>
            {a.recent.length === 0 ? (
              <p className="text-sm text-faint">No runs in the last month.</p>
            ) : (
              <ul className="grid gap-1">
                {a.recent.slice(0, 8).map((r, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-[10px] px-2 py-2 text-sm odd:bg-bg/50">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${r.ok ? "bg-ok" : "bg-bad"}`} />
                    <span className="min-w-0 flex-1 truncate">
                      {r.moment ?? r.label}
                      {r.moment && r.label && <span className="text-faint"> · {r.label}</span>}
                    </span>
                    <span className="shrink-0 text-xs text-faint">{ago(r.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
        <section className={tab === "coach" ? "grid" : "hidden"}>
          <Coach a={a} initial={chat} items={items} />
        </section>
        <section className={tab === "runs" ? "grid gap-3 rounded-[18px] border border-line bg-surface p-4 md:p-6" : "hidden"}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-heading text-[18px]">Recent runs</h3>
            <p className="tabular text-xs text-faint">
              {a.stats.runs} this week · {Math.round((a.stats.inTokens + a.stats.outTokens) / 1000)}k tokens
              {a.stats.failed > 0 && <span className="text-bad"> · {a.stats.failed} failed</span>}
            </p>
          </div>
          {a.recent.length ? (
            <ul className="grid gap-1">
              {a.recent.map((r, i) => (
                <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 md:grid md:grid-cols-[120px_minmax(0,1fr)_70px_60px_150px] md:gap-3 rounded-[8px] px-3 py-2 text-xs odd:bg-bg">
                  <span className="tabular text-faint">{fmt(r.at)}</span>
                  <span className={`order-first basis-full truncate md:order-none md:basis-auto ${r.ok ? "text-muted" : "text-bad"}`} title={r.error ?? undefined}>
                    {r.label}
                    {r.error && ` · ${r.error}`}
                  </span>
                  <span className="capitalize text-muted">{r.model}</span>
                  <span className="tabular text-right text-muted">{r.ms == null ? "—" : `${(r.ms / 1000).toFixed(1)}s`}</span>
                  <span className="tabular text-right text-faint">{r.tokens}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-faint">{a.live ? "No runs this week yet." : "It runs once it's wired into the app."}</p>
          )}
        </section>
      </div>
    </DirtyProvider>
  );
}

// ─── The six agents ─────────────────────────────────────────────────────────

export type Role = {
  key: string;
  label: string;
  description: string;
  icon: string;
  core: string;
  updatedAt: string;
  updatedBy: string | null;
  proposals: number; // edits it proposed in its own chat that nobody has applied yet
};

/** A rule split into its short title (up to the first full stop or colon) and the rest. */
function splitRule(line: string) {
  const text = line.replace(/^\s*\d+\.\s*/, "");
  const m = text.match(/^(.{8,90}?[.:])\s+(.*)$/);
  return m ? { head: m[1].replace(/[.:]$/, ""), rest: m[2] } : { head: text, rest: "" };
}

function SpineEditor({ spine }: { spine: { body: string; updatedAt: string | null; updatedBy: string | null } }) {
  const [body, setBody] = useState(spine.body);
  // Summary, read or edit, in the address (?spine=), so back steps out of reading or editing it
  const asked = useParam("spine");
  const mode = asked === "read" || asked === "edit" ? asked : "summary";
  const setMode = (k: typeof mode) => pushParams({ spine: k === "summary" ? null : k });
  useDirty("spine", body !== spine.body, { label: "Kaizen strategy", save: () => saveSpine(body), discard: () => setBody(spine.body) });
  const rules = spine.body
    .split("\n")
    .filter((l) => /^\s*\d+\./.test(l))
    .map(splitRule);
  const tab = (k: typeof mode, label: string) => (
    <button
      type="button"
      onClick={() => setMode(k)}
      className={`h-10 flex-1 rounded-full px-3 text-xs transition-colors md:h-auto md:flex-none md:py-1 ${mode === k ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}
    >
      {label}
    </button>
  );
  return (
    <section className="grid gap-5 rounded-[18px] border border-line bg-surface p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <p className="text-[11px] uppercase tracking-[0.16em] text-faint">Read first by every agent</p>
          <h2 className="font-heading text-[20px] leading-tight">Kaizen strategy</h2>
          <p className="max-w-xl text-[13px] text-muted">Kyle and Santi&apos;s non-negotiables. They win over any agent&apos;s core or skills. Execs edit them here; the Coach can&apos;t.</p>
        </div>
        <div className="flex w-full items-center gap-1 rounded-full border border-line bg-bg p-0.5 md:w-auto">
          {tab("summary", "Rules")}
          {tab("read", "Full text")}
          {tab("edit", "Edit")}
        </div>
      </div>

      {mode === "summary" && (
        <ol className="grid gap-px overflow-hidden rounded-[12px] border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
          {rules.map((r, i) => (
            <li key={i} title={r.rest} className="flex items-start gap-3 bg-surface px-4 py-3">
              <span className="font-heading text-xs tabular text-brand-text">{String(i + 1).padStart(2, "0")}</span>
              <span className="text-[13px] leading-snug">{r.head}</span>
            </li>
          ))}
        </ol>
      )}
      {mode === "read" && (
        <ol className="grid gap-x-10 gap-y-4 md:grid-cols-2">
          {rules.map((r, i) => (
            <li key={i} className="grid grid-cols-[24px_minmax(0,1fr)] gap-2">
              <span className="font-heading text-xs tabular text-brand-text">{String(i + 1).padStart(2, "0")}</span>
              <span className="grid gap-1">
                <span className="text-sm font-medium leading-snug">{r.head}</span>
                {r.rest && <span className="text-[13px] leading-relaxed text-muted">{r.rest}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
      {mode === "edit" && (
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={Math.min(30, Math.max(12, body.split("\n").length + 4))}
          className={`${field} h-auto py-4 text-[13.5px] font-normal leading-relaxed`}
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4 text-[11px] text-faint">
        <span className="flex flex-wrap items-center gap-1.5">
          Every AI call reads
          <span className="rounded-full bg-brand-soft px-2 py-0.5 text-brand-text">Kaizen strategy</span>→<span className="rounded-full bg-surface-2 px-2 py-0.5 text-muted">the agent&apos;s core</span>→
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-muted">the skill&apos;s playbook</span>→<span className="rounded-full bg-surface-2 px-2 py-0.5 text-muted">shared knowledge</span>
        </span>
        <span className="tabular">
          {rules.length} rules{spine.updatedAt ? ` · changed ${fmt(spine.updatedAt)}${spine.updatedBy ? ` by ${spine.updatedBy}` : ""}` : ""}
        </span>
      </div>
    </section>
  );
}

const money = (n: number) => (n >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(n >= 10 ? 1 : 2)}`);
const roleStats = (role: Role, skills: Agent[]) => ({
  cost7: skills.reduce((t, s) => t + s.cost7, 0),
  runs: skills.reduce((t, s) => t + s.stats.runs, 0),
  last: skills.map((s) => s.lastAt).filter((x): x is string => Boolean(x)).sort().at(-1) ?? null,
  proposals: role.proposals + skills.reduce((t, s) => t + s.proposals, 0),
});

/** The AI agents section: the agents, the knowledge every one of them reads, and what they cost */
export function AgentsNav({ section }: { section: string }) {
  const tabs = [
    ["agents", "Agents"],
    ["knowledge", "Knowledge"],
    ["expenses", "Expenses"],
  ] as const;
  const on = tabs.some(([k]) => k === section) ? section : "agents";
  return (
    <nav className="flex w-full gap-1 justify-self-start rounded-full border border-line bg-surface p-1 md:w-fit" aria-label="AI agents">
      {tabs.map(([k, l]) => (
        <Link
          key={k}
          href={k === "agents" ? "/settings?tab=agents" : `/settings?tab=agents&section=${k}`}
          aria-current={on === k ? "page" : undefined}
          className={`inline-flex h-10 flex-1 items-center justify-center rounded-full px-5 text-sm transition-colors md:h-9 md:flex-none ${on === k ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}
        >
          {l}
        </Link>
      ))}
    </nav>
  );
}

/** Knowledge every agent reads: Kaizen's strategy first, then the shared items (how Kaizen works, policy, formats) */
export function KnowledgeView({ items, spine }: { items: Item[]; spine: { body: string; updatedAt: string | null; updatedBy: string | null } }) {
  const shared = items.filter((k) => k.agentKey === null);
  return (
    <DirtyProvider>
      <div className="grid gap-8">
        <SpineEditor spine={spine} />
        <section className="grid gap-4 rounded-[18px] border border-line bg-surface p-4 sm:p-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="font-heading text-[20px]">Shared knowledge</h2>
              <p className="mt-1 text-[13px] text-muted">Every agent reads these: how Kaizen works, packages and pricing, Meta policy, formats and specs.</p>
            </div>
            <span className="tabular text-xs text-faint">~{shared.filter((k) => k.active).reduce((t, k) => t + tokensOf(k.body), 0).toLocaleString()} tokens</span>
          </div>
          <ItemList items={shared} agentKey={null} />
        </section>
      </div>
    </DirtyProvider>
  );
}

export function RolesOverview({ roles, agents, items }: { roles: Role[]; agents: Agent[]; items: Item[] }) {
  const week = agents.reduce((t, a) => t + a.cost7, 0);
  const runs = agents.reduce((t, a) => t + a.stats.runs, 0);
  const live = agents.filter((a) => a.live).length;
  const review = roles.reduce((t, r) => t + roleStats(r, agents.filter((a) => a.roleKey === r.key)).proposals, 0);
  return (
    <DirtyProvider>
      <div className="grid gap-6">
        {/* The team at a glance */}
        <section className="relative isolate overflow-hidden rounded-[28px] border border-line bg-deep px-5 py-6 md:px-8 md:py-7">
          <span aria-hidden className="pointer-events-none absolute -right-20 -top-28 -z-10 h-80 w-80 rounded-full bg-[#5b8def]/20 blur-[110px]" />
          <span aria-hidden className="pointer-events-none absolute -bottom-32 -left-16 -z-10 h-72 w-72 rounded-full bg-brand/20 blur-[110px]" />
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div className="grid gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-faint">Kaizen&apos;s AI team</p>
              <h2 className="font-heading text-[28px] leading-tight md:text-[34px]">Six agents, {agents.length} skills</h2>
              <div className="flex -space-x-2">
                {roles.map((r) => (
                  <span key={r.key} className="rounded-[16px] ring-4 ring-deep">
                    <AgentIcon icon={r.icon} size={40} />
                  </span>
                ))}
              </div>
            </div>
            <dl className="grid grid-cols-3 gap-6 md:gap-10">
              {[
                ["This week", money(week), `${money(week / 7)} a day`],
                ["Runs", runs.toLocaleString(), "last 7 days"],
                ["Switched on", `${live}/${agents.length}`, review ? `${review} edits to review` : "skills running"],
              ].map(([k, v, n]) => (
                <div key={k} className="grid gap-0.5">
                  <dt className="text-[11px] text-faint">{k}</dt>
                  <dd className="tabular font-display text-[26px] leading-none md:text-[32px]">{v}</dd>
                  <dd className={`text-[11px] ${k === "Switched on" && review ? "text-brand-text" : "text-faint"}`}>{n}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {roles.map((r) => {
            const skills = agents.filter((a) => a.roleKey === r.key);
            const st = roleStats(r, skills);
            const tint = tintOf(r.icon);
            const itemCount = items.filter((k) => k.active && skills.some((s) => s.key === k.agentKey)).length;
            const top = Math.max(...skills.map((s) => s.cost7), 0.0001);
            return (
              <li key={r.key} className="min-w-0">
                <Link
                  href={`/settings?tab=agents&role=${r.key}`}
                  className="group relative isolate flex h-full flex-col gap-5 overflow-hidden rounded-[24px] border border-line bg-surface p-5 transition-all duration-300 hover:-translate-y-0.5 hover:border-faint/60 hover:shadow-[0_30px_60px_-35px_rgba(0,0,0,0.8)] md:p-6"
                  style={{ backgroundImage: `radial-gradient(120% 70% at 0% 0%, ${tint}1f, transparent 60%)` }}
                >
                  <span aria-hidden className="absolute inset-x-6 top-0 h-px" style={{ background: `linear-gradient(90deg, transparent, ${tint}, transparent)` }} />
                  <div className="flex items-start gap-3.5">
                    <AgentIcon icon={r.icon} size={46} />
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate font-heading text-[19px] leading-tight">{r.label}</h3>
                      <p className="mt-0.5 text-[11px] text-faint">
                        {skills.length} skills · {itemCount} playbook items
                      </p>
                    </div>
                    <div className="grid shrink-0 justify-items-end">
                      <span className="tabular font-display text-[26px] leading-none" style={{ color: st.cost7 >= 0.005 ? undefined : "var(--fg-faint)" }}>
                        {st.cost7 >= 0.005 ? money(st.cost7 / 7) : "$0"}
                      </span>
                      <span className="text-[10.5px] text-faint">a day, avg</span>
                    </div>
                  </div>
                  <p className="line-clamp-2 text-[13px] leading-relaxed text-muted">{r.description}</p>
                  <ul className="grid gap-2.5">
                    {skills.map((s) => (
                      <li key={s.key} className="grid gap-1">
                        <span className="flex items-center justify-between gap-3 text-[13px]">
                          <span className="flex min-w-0 items-center gap-2">
                            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.live ? "" : "border border-dashed border-faint"}`} style={s.live ? { background: tint } : undefined} title={s.live ? "Connected: it runs in the app" : "Not switched on yet"} />
                            <span className={`truncate ${s.live ? "" : "text-faint"}`}>{s.label}</span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2 text-[11px] text-faint">
                            {s.stats.runs > 0 && <span className="tabular">{s.stats.runs} runs</span>}
                            <span className="tabular w-11 text-right text-muted">{s.cost7 >= 0.005 ? money(s.cost7) : "—"}</span>
                            <span className="w-14 rounded-full border border-line px-1.5 py-px text-center capitalize">{s.key === "fatigue" ? "rule" : s.model}</span>
                          </span>
                        </span>
                        <span className="ml-3.5 h-[3px] overflow-hidden rounded-full bg-surface-2">
                          <span className="block h-full rounded-full opacity-80" style={{ width: `${s.cost7 >= 0.005 ? Math.max(2, (s.cost7 / top) * 100) : 0}%`, background: tint }} />
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-auto flex items-center justify-between border-t border-line/70 pt-4 text-[11px] text-faint">
                    <span>
                      <span className="tabular text-fg">{st.runs}</span> runs this week{st.cost7 >= 0.005 ? ` · ${money(st.cost7)}` : ""}
                    </span>
                    {st.proposals > 0 ? (
                      <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[10px] text-brand-text">{st.proposals} to review</span>
                    ) : (
                      <span className="flex items-center gap-1.5">
                        {st.last ? `used ${ago(st.last)}` : "not used yet"}
                        <span className="transition-transform group-hover:translate-x-0.5" aria-hidden>
                          →
                        </span>
                      </span>
                    )}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </DirtyProvider>
  );
}

function CoreEditor({ role }: { role: Role }) {
  const [core, setCore] = useState(role.core);
  useDirty(`core:${role.key}`, core !== role.core, { label: `${role.label} core`, save: () => saveRoleCore(role.key, core), discard: () => setCore(role.core) });
  return (
    <section className="grid gap-3 rounded-[18px] border border-line bg-surface p-4 md:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="font-heading text-[18px]">Core</h3>
          <p className="mt-1 text-sm text-muted">Every {role.label} skill reads this after Kaizen strategy and before its own playbook. ~{tokensOf(core).toLocaleString()} tokens</p>
        </div>
        <span className="text-xs text-faint">
          Changed {fmt(role.updatedAt)}
          {role.updatedBy && ` by ${role.updatedBy}`}
        </span>
      </div>
      <textarea value={core} onChange={(e) => setCore(e.target.value)} rows={Math.min(24, Math.max(8, core.split("\n").length + 2))} className={`${field} h-auto py-4 text-[13.5px] font-normal leading-relaxed`} />
    </section>
  );
}

/** Talk to the whole agent like an employee: it answers from its core and every skill, and proposes edits wherever they belong. */
function TalkToAgent({ role, skills, items, chat }: { role: Role; skills: Agent[]; items: Item[]; chat: RoleChatMessage[] }) {
  const names = new Map(skills.map((s) => [s.key as string, s.label]));
  return (
    <section id="talk" className="relative grid scroll-mt-6 gap-4 overflow-hidden rounded-[20px] border border-line bg-surface p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="font-heading text-[20px] leading-tight">Talk to the {role.label}</h3>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Ask how it works, tell it what to do better, or share files and links (SOPs, examples of great work, call notes) like you would with a teammate. It works out whether that belongs in its core or in one of its {skills.length} skills and proposes the exact edit. You apply each one.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <span className="rounded-full bg-brand-soft px-2.5 py-1 text-[11px] text-brand-text">Core</span>
          {skills.map((s) => (
            <span key={s.key} className="rounded-full bg-surface-2 px-2.5 py-1 text-[11px] text-muted">
              {s.label}
            </span>
          ))}
        </div>
      </div>
      <ChatPanel
        tall
        icon={role.icon}
        heading={`Hi, I'm the ${role.label}`}
        intro={`I know my core and all ${skills.length} of my skills. Ask me how I do something, tell me what to change, or share a playbook, an example or a link and I'll show you exactly where I'd change it.`}
        starters={ROLE_STARTERS[role.key] ?? []}
        placeholder={`Talk to the ${role.label}, paste a link or drop a file…`}
        footnote="Runs on Opus. Nothing changes until you press Apply."
        thinkingLabel="Thinking it through…"
        initial={chat}
        items={items}
        skillName={(c) => (c.skill === "core" ? "Core" : names.get(c.skill ?? "") ?? null)}
        folder={role.key}
        onSend={(msg, files) => chatWithAgent(role.key, msg, files)}
        onApply={(id, i) => applyRoleChange(role.key, id, i)}
        onClear={() => clearRoleChat(role.key)}
      />
    </section>
  );
}

export function RoleDetail({ role, skills, items, chat }: { role: Role; skills: Agent[]; items: Item[]; chat: RoleChatMessage[] }) {
  const st = roleStats(role, skills);
  return (
    <DirtyProvider>
      <div className="grid gap-6 pb-24">
        <Link href="/settings?tab=agents" className="inline-flex min-h-11 items-center text-xs text-muted hover:text-fg md:min-h-0">
          ← All agents
        </Link>
        <header className="relative overflow-hidden rounded-[20px] border border-line bg-surface p-5 sm:p-8">
          <div className="relative flex flex-wrap items-start gap-5">
            <AgentIcon icon={role.icon} size={64} />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] uppercase tracking-[0.16em] text-faint">Agent</p>
              <h2 className="font-heading text-[26px] leading-tight [overflow-wrap:anywhere] md:text-[30px]">{role.label}</h2>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">{role.description}</p>
            </div>
            <dl className="grid w-full grid-cols-2 gap-x-8 gap-y-3 border-t border-line pt-5 sm:grid-cols-5">
              {[
                ["Skills", String(skills.length)],
                ["Runs, 7 days", st.runs ? String(st.runs) : "—"],
                ["Cost, 7 days", st.cost7 >= 0.005 ? `${money(st.cost7)} · ${money(st.cost7 / 7)}/day` : "—"],
                ["Last used", ago(st.last) ?? "Never"],
                ["Proposed edits", st.proposals ? String(st.proposals) : "None"],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-[11px] text-faint">{k}</dt>
                  <dd className="tabular mt-0.5 text-sm">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </header>

        <TalkToAgent role={role} skills={skills} items={items} chat={chat} />

        {/* Remounts when the core changes (an edit applied from the chat) so the editor shows the new text */}
        <CoreEditor key={role.updatedAt} role={role} />

        <section className="grid gap-3">
          <h3 className="font-heading text-[18px]">Skills</h3>
          <ul className="grid gap-3 md:grid-cols-2">
            {skills.map((s) => {
              const mine = items.filter((k) => k.agentKey === s.key && k.active);
              return (
                <li key={s.key}>
                  <Link
                    href={`/settings?tab=agents&agent=${s.key}`}
                    className="group grid h-full content-start gap-3 rounded-[16px] border border-line bg-surface p-4 transition-colors hover:border-faint/70 active:bg-surface-2/40 md:p-5"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-heading text-[17px] leading-snug">{s.label}</p>
                        <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-muted">{s.description}</p>
                      </div>
                      {s.live ? (
                        s.proposals > 0 ? <span className="shrink-0 rounded-full bg-brand-soft px-2 py-0.5 text-[10px] text-brand-text">{s.proposals} to review</span> : null
                      ) : (
                        <span className="shrink-0 rounded-full border border-dashed border-line px-2 py-0.5 text-[10px] text-faint">Not on yet</span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                      {(["skill", "knowledge", "example"] as const).map((k) => {
                        const n = mine.filter((x) => x.kind === k).length;
                        return n ? (
                          <span key={k} className={`rounded-full px-2 py-0.5 ${KINDS[k].tone}`}>
                            {n} {n === 1 ? KINDS[k].name.toLowerCase() : KINDS[k].plural.toLowerCase()}
                          </span>
                        ) : null;
                      })}
                      {s.instructions.trim() && <span className="rounded-full border border-line px-2 py-0.5 text-muted">instructions</span>}
                      <span className="text-faint">· {s.moments.length} {s.moments.length === 1 ? "place" : "places"} in the app</span>
                    </div>
                    <div className="mt-auto flex items-center justify-between border-t border-line pt-3 text-xs">
                      <span className="flex items-center gap-2 text-muted">
                        <ModelMeter model={s.model} />
                        <span className="capitalize text-fg">{s.model}</span>
                        <span className="text-faint">· {s.effort}</span>
                      </span>
                      <span className="text-faint">
                        {s.stats.runs ? `${s.stats.runs} this week` : "none this week"}
                        {s.lastAt ? ` · last ${ago(s.lastAt)}` : ""}
                      </span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </DirtyProvider>
  );
}
