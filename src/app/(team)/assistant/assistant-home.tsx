"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { useAgentCall } from "@/components/agent-call-provider";
import { AgentGlyph, NotesBlock, TranscriptButton } from "@/components/assistant-call-parts";
import { field } from "@/components/ui";
import { ASSISTANT_PALETTE, ASSISTANT_TINT } from "@/lib/agent-look";
import { DEFAULT_VOICES } from "@/lib/agent-call/core";
import { clock } from "@/lib/agent-call/core";
import type { CallNotes } from "@/lib/assistant/notes";
import { pushParams, replaceParams, useParam } from "@/lib/url-state";
import { addMemory, assistantVoices, deleteMemory, setAssistantLook, updateMemory, type AssistantVoice, type MemoryItem } from "./actions";

// Your assistant's page: the call button, its voice and color (yours alone), the notes from your calls (with their
// transcripts), and "What I know about you" (only you see it: view, edit, delete one thing or everything). The tab
// lives in the address, so back returns to it.

export type PastCall = { id: string; startedAt: string; seconds: number; topic: string | null; notes: CallNotes | null };

const TOPIC_WORDS: Record<string, string> = { birthday: "Birthday", family: "Family", trip: "Trips", preference: "Preferences", work: "Work", hobby: "Hobbies", other: "Other", length: "Length", humor: "Humor", numbers: "Numbers or story", pace: "Pace" };
const when = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

export function AssistantHome({ name, memory, calls, voice }: { name: string; memory: MemoryItem[]; calls: PastCall[]; voice: string | null }) {
  const { startAssistant, activeRole, live, assistantTint: ASSISTANT_COLOR } = useAgentCall();
  const tab = useParam("tab") === "memory" ? "memory" : "calls";
  const on = live && activeRole === "assistant";
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <section className="relative overflow-hidden rounded-[24px] border border-line bg-surface p-5 sm:p-7">
        <span aria-hidden className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full opacity-20 blur-3xl" style={{ background: ASSISTANT_COLOR }} />
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center">
          <AgentGlyph icon="spark" tint={ASSISTANT_COLOR} size={64} />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] uppercase tracking-[0.16em] text-faint">Your assistant</p>
            <h1 className="mt-1 font-heading text-[26px] leading-tight">Hey {name}, I&apos;m here when you need me</h1>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">Ask what&apos;s on today, get a report built, run an audit, move a ticket or bring in a specialist. I act with your own access, and I ask before anything goes to a client, spends or goes live.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={startAssistant}
          className="relative mt-5 inline-flex min-h-12 w-full items-center justify-center gap-2.5 rounded-full bg-brand px-6 text-[15px] font-medium text-white shadow-sm transition hover:bg-brand-hover active:scale-[0.98] sm:w-auto"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
          </svg>
          {on ? "Back to the call" : "Call my assistant"}
        </button>
      </section>

      <YourAssistant voice={voice} />

      <div role="tablist" aria-label="Your assistant" className="flex gap-1 rounded-full border border-line bg-surface p-1 sm:self-start">
        {(["calls", "memory"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => pushParams({ tab: t === "calls" ? null : t })}
            className={`min-h-11 flex-1 rounded-full px-4 text-[13.5px] transition-colors md:min-h-9 ${tab === t ? "bg-surface-2 text-fg" : "text-muted hover:text-fg"}`}
          >
            {t === "calls" ? "Your calls" : "What I know about you"}
          </button>
        ))}
      </div>

      {tab === "calls" ? <Calls calls={calls} /> : <Memory memory={memory} />}
    </div>
  );
}

function Calls({ calls }: { calls: PastCall[] }) {
  const open = useParam("call");
  if (!calls.length) return <p className="rounded-[18px] border border-dashed border-line p-6 text-center text-sm text-muted">No calls yet. Your notes from each call show up here.</p>;
  return (
    <ul className="grid gap-2.5">
      {calls.map((c) => {
        const expanded = open === c.id;
        return (
          <li key={c.id} className="rounded-[18px] border border-line bg-surface">
            <button type="button" onClick={() => (expanded ? replaceParams({ call: null }) : replaceParams({ call: c.id }))} aria-expanded={expanded} className="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14.5px] font-medium">{c.topic ?? "Call with your assistant"}</span>
                <span className="block text-[12px] text-faint">
                  {when(c.startedAt)} · {clock(c.seconds)}
                </span>
              </span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={`shrink-0 text-faint transition-transform ${expanded ? "rotate-180" : ""}`}>
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
            {expanded && (
              <div className="border-t border-line px-4 py-4">
                <NotesBlock notes={c.notes ?? "none"} />
                {!c.notes && <p className="text-sm text-muted">No notes for this call.</p>}
                <TranscriptButton callId={c.id} className="mt-3 min-h-11 rounded-full border border-line px-4 text-[13px] text-muted transition-colors hover:border-faint hover:text-fg md:min-h-9" />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Memory({ memory }: { memory: MemoryItem[] }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [wipe, setWipe] = useState(false);
  const [adding, setAdding] = useState(false);
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.error ?? "That didn't work.");
      else router.refresh();
    });
  const style = memory.filter((m) => m.kind === "style");
  const facts = memory.filter((m) => m.kind === "fact");
  return (
    <div className="grid gap-5">
      <p className="text-[13px] leading-relaxed text-muted">
        Only you can see this. I learn it from what you tell me on our calls and how you like to talk, never from your email or Slack, and none of it goes to the other agents or to anyone on the team. Change or delete anything, any time.
      </p>
      {error && <p className="text-sm text-bad">{error}</p>}
      <Group title="How you like to talk" empty="Nothing yet. Tell me on a call (“keep it short”, “numbers first”)." items={style} busy={busy} run={run} />
      <Group title="What you've told me" empty="Nothing yet. I remember things like birthdays, trips and how you like updates when you mention them." items={facts} busy={busy} run={run} />
      {adding ? (
        <AddForm busy={busy} onCancel={() => setAdding(false)} onAdd={(input) => run(async () => { const r = await addMemory(input); if (r.ok) setAdding(false); return r; })} />
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="inline-flex min-h-11 items-center justify-center rounded-full border border-line px-4 text-[13.5px] text-muted transition-colors hover:border-faint hover:text-fg sm:self-start md:min-h-9">
          Add something
        </button>
      )}
      {memory.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
          {wipe ? (
            <>
              <span className="text-sm text-muted">Delete everything I know about you? This can&apos;t be undone.</span>
              <button type="button" disabled={busy} onClick={() => run(async () => { const r = await deleteMemory("all"); setWipe(false); return r; })} className="min-h-11 rounded-full bg-bad px-4 text-[13.5px] font-medium text-white transition hover:opacity-90 md:min-h-9">
                Delete everything
              </button>
              <button type="button" onClick={() => setWipe(false)} className="min-h-11 rounded-full px-3 text-[13.5px] text-muted hover:text-fg md:min-h-9">
                Keep it
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setWipe(true)} className="min-h-11 rounded-full text-[13px] text-faint transition-colors hover:text-bad md:min-h-9">
              Delete everything I know about you
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Group({ title, empty, items, busy, run }: { title: string; empty: string; items: MemoryItem[]; busy: boolean; run: (fn: () => Promise<{ ok: boolean; error?: string }>) => void }) {
  return (
    <section className="grid gap-2">
      <h2 className="text-[11px] uppercase tracking-[0.16em] text-faint">{title}</h2>
      {items.length === 0 ? (
        <p className="rounded-[14px] border border-dashed border-line px-4 py-3 text-[13px] text-faint">{empty}</p>
      ) : (
        <ul className="grid gap-2">
          {items.map((m) => (
            <MemoryRow key={m.id} item={m} busy={busy} run={run} />
          ))}
        </ul>
      )}
    </section>
  );
}

function MemoryRow({ item, busy, run }: { item: MemoryItem; busy: boolean; run: (fn: () => Promise<{ ok: boolean; error?: string }>) => void }) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(item.body);
  const [confirm, setConfirm] = useState(false);
  return (
    <li className="grid gap-2 rounded-[14px] border border-line bg-surface p-3.5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 rounded-full bg-surface-2 px-2.5 py-0.5 text-[11px] text-muted">{TOPIC_WORDS[item.topic] ?? item.topic}</span>
        {editing ? (
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} aria-label="What I know" className={`${field} h-auto min-w-0 flex-1 py-2 text-[14px] font-normal leading-relaxed`} />
        ) : (
          <p className="min-w-0 flex-1 text-[14px] leading-relaxed [overflow-wrap:anywhere]">
            {item.body}
            {item.onDate && <span className="text-faint"> · {item.topic === "birthday" ? item.onDate.slice(5) : item.onDate}</span>}
          </p>
        )}
      </div>
      <div className="flex flex-wrap justify-end gap-1.5">
        {editing ? (
          <>
            <button type="button" onClick={() => { setEditing(false); setBody(item.body); }} className="min-h-11 rounded-full px-3 text-[13px] text-muted hover:text-fg md:min-h-8">
              Cancel
            </button>
            <button type="button" disabled={busy} onClick={() => run(async () => { const r = await updateMemory(item.id, { body }); if (r.ok) setEditing(false); return r; })} className="min-h-11 rounded-full bg-brand px-4 text-[13px] font-medium text-white transition hover:bg-brand-hover md:min-h-8">
              Save
            </button>
          </>
        ) : confirm ? (
          <>
            <button type="button" onClick={() => setConfirm(false)} className="min-h-11 rounded-full px-3 text-[13px] text-muted hover:text-fg md:min-h-8">
              Keep
            </button>
            <button type="button" disabled={busy} onClick={() => run(() => deleteMemory(item.id))} className="min-h-11 rounded-full bg-bad px-4 text-[13px] font-medium text-white transition hover:opacity-90 md:min-h-8">
              Delete
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => setEditing(true)} className="min-h-11 rounded-full px-3 text-[13px] text-muted transition-colors hover:bg-surface-2 hover:text-fg md:min-h-8">
              Edit
            </button>
            <button type="button" onClick={() => setConfirm(true)} className="min-h-11 rounded-full px-3 text-[13px] text-muted transition-colors hover:bg-surface-2 hover:text-bad md:min-h-8">
              Delete
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function AddForm({ busy, onAdd, onCancel }: { busy: boolean; onAdd: (input: { kind: "fact" | "style"; topic: string; body: string; onDate: string | null }) => void; onCancel: () => void }) {
  const [kind, setKind] = useState<"fact" | "style">("fact");
  const [topic, setTopic] = useState("preference");
  const [body, setBody] = useState("");
  const [onDate, setOnDate] = useState("");
  const topics = kind === "fact" ? ["birthday", "family", "trip", "preference", "work", "hobby", "other"] : ["length", "humor", "numbers", "pace", "other"];
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onAdd({ kind, topic, body, onDate: onDate || null });
      }}
      className="grid gap-2.5 rounded-[16px] border border-line bg-surface p-4"
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="grid gap-1 text-[12px] text-muted">
          Kind
          <select value={kind} onChange={(e) => { const k = e.target.value as "fact" | "style"; setKind(k); setTopic(k === "fact" ? "preference" : "length"); }} className={`${field} h-11 md:h-9`}>
            <option value="fact">Something about me</option>
            <option value="style">How I like to talk</option>
          </select>
        </label>
        <label className="grid gap-1 text-[12px] text-muted">
          About
          <select value={topic} onChange={(e) => setTopic(e.target.value)} className={`${field} h-11 md:h-9`}>
            {topics.map((t) => (
              <option key={t} value={t}>
                {TOPIC_WORDS[t] ?? t}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="grid gap-1 text-[12px] text-muted">
        What to remember
        <input value={body} onChange={(e) => setBody(e.target.value)} placeholder={kind === "fact" ? "My daughter Mia starts school in September" : "Keep answers short, numbers first"} className={`${field} h-11 md:h-9`} />
      </label>
      {kind === "fact" && (topic === "birthday" || topic === "trip") && (
        <label className="grid gap-1 text-[12px] text-muted">
          {topic === "birthday" ? "Birthday" : "Date"}
          <input type="date" value={onDate} onChange={(e) => setOnDate(e.target.value)} className={`${field} h-11 md:h-9`} />
        </label>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="min-h-11 rounded-full px-4 text-[13.5px] text-muted hover:text-fg md:min-h-9">
          Cancel
        </button>
        <button type="submit" disabled={busy || body.trim().length < 2} className="min-h-11 rounded-full bg-brand px-5 text-[13.5px] font-medium text-white transition hover:bg-brand-hover disabled:opacity-50 md:min-h-9">
          Add
        </button>
      </div>
    </form>
  );
}

/** Your assistant's voice and color: yours alone (nobody else's assistant changes), saved as you pick */
function YourAssistant({ voice }: { voice: string | null }) {
  const router = useRouter();
  const { assistantTint, setAssistantTint } = useAgentCall();
  const [voices, setVoices] = useState<AssistantVoice[] | null>(null);
  const [value, setValue] = useState(voice ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [loading, setLoading] = useState(false);
  const preview = useRef<HTMLAudioElement | null>(null);
  const load = () => {
    if (voices || loading) return;
    setLoading(true);
    void assistantVoices().then((r) => {
      setLoading(false);
      if (r.ok) setVoices(r.voices);
      else setError(r.error);
    });
  };
  const save = (change: { voice?: string | null; color?: string | null }, what: string) =>
    start(async () => {
      setError(null);
      setSaved(null);
      const r = await setAssistantLook(change);
      if (!r.ok) return setError(r.error);
      setSaved(what);
      router.refresh();
    });
  const pickVoice = (id: string) => {
    setValue(id);
    save({ voice: id || null }, "Voice saved. You'll hear it on your next call.");
  };
  const pickColor = (hex: string) => {
    setAssistantTint(hex);
    save({ color: hex === ASSISTANT_TINT ? null : hex }, "Color saved.");
  };
  const current = voices?.find((v) => v.id === value);
  const play = () => {
    const url = current?.preview;
    if (!url) return;
    preview.current?.pause();
    preview.current = new Audio(url);
    void preview.current.play().catch(() => undefined);
  };
  return (
    <section aria-label="Your assistant" className="grid gap-5 rounded-[24px] border border-line bg-surface p-5 sm:p-6">
      <div>
        <h2 className="font-heading text-[18px] leading-tight">Make it yours</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-muted">The voice and color of your assistant are yours alone. Nobody else&apos;s assistant changes.</p>
      </div>

      <div className="grid gap-2">
        <label htmlFor="assistant-voice" className="text-[11px] uppercase tracking-[0.16em] text-faint">
          Voice
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <select
            id="assistant-voice"
            value={value}
            onFocus={load}
            onPointerDown={load}
            onChange={(e) => pickVoice(e.target.value)}
            disabled={pending}
            className={`${field} h-11 min-w-0 flex-1 sm:max-w-sm md:h-10`}
          >
            <option value="">{DEFAULT_VOICES.assistant.name} (default)</option>
            {voice && !voices && <option value={voice}>Your pick</option>}
            {(voices ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.about ? ` · ${v.about}` : ""}
              </option>
            ))}
          </select>
          {current?.preview && (
            <button type="button" onClick={play} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line px-4 text-[13px] text-muted transition-colors hover:border-faint hover:text-fg md:min-h-10">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M8 5v14l11-7z" />
              </svg>
              Preview
            </button>
          )}
        </div>
        {loading && <p className="text-[12px] text-faint">Loading the voices…</p>}
      </div>

      <div className="grid gap-2">
        <p id="assistant-color" className="text-[11px] uppercase tracking-[0.16em] text-faint">
          Color
        </p>
        <div role="radiogroup" aria-labelledby="assistant-color" className="flex flex-wrap gap-1.5">
          {ASSISTANT_PALETTE.map((c) => {
            const on = assistantTint === c.hex;
            return (
              <button
                key={c.hex}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={c.name}
                title={c.name}
                onClick={() => pickColor(c.hex)}
                className="grid h-11 w-11 place-items-center rounded-full transition active:scale-95"
                style={{ boxShadow: on ? `0 0 0 2px ${c.hex}` : undefined }}
              >
                <span className="grid h-8 w-8 place-items-center rounded-full text-white" style={{ background: c.hex }}>
                  {on && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <p aria-live="polite" className="min-h-[1.2em] text-[12.5px]">
        {error ? <span className="text-bad">{error}</span> : saved ? <span className="text-muted">{saved}</span> : null}
      </p>
    </section>
  );
}
