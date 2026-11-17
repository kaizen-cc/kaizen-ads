"use client";

import { useRef, useState, useTransition, type ReactNode } from "react";
import { field } from "@/components/ui";
import { useAgentCall } from "@/components/agent-call-provider";
import { HeadsetIcon, PhoneIcon } from "@/components/agent-call-views";
import { callVoices, setAgentVoice, type CallVoice } from "./call-actions";

// Calling an agent: the button on its page. The call itself (microphone, listening, the agent's voice, the huddle on
// computers and the full screen on phones) lives in the call provider above every page, so it carries on while you
// move around. Pressing the button hands the call to it.

type Props = {
  roleKey: string;
  label: string;
  /** The agent's icon at a size */
  icon: (size: number) => ReactNode;
  /** The agent's colour */
  tint: string;
  /** "full": the big button on the agent's page; "compact": a small one beside its chat */
  size?: "full" | "compact";
};

/** Call (phones) or huddle with (computers) the agent: the button */
export function AgentCall({ roleKey, label, icon, tint, size = "full" }: Props) {
  const { start, activeRole } = useAgentCall();
  const here = activeRole === roleKey;
  const dial = () => start({ roleKey, label, icon, tint });
  if (size === "full")
    return (
      <button
        type="button"
        onClick={dial}
        className="inline-flex min-h-12 w-full items-center justify-center gap-2.5 rounded-full bg-brand px-6 text-[15px] font-medium text-white shadow-sm transition hover:bg-brand-hover active:scale-[0.98] sm:w-auto"
      >
        <span className="md:hidden">
          <PhoneIcon />
        </span>
        <span className="hidden md:inline">
          <HeadsetIcon />
        </span>
        <span className="md:hidden">Call the {label}</span>
        <span className="hidden md:inline">{here ? `Back to the huddle with the ${label}` : `Huddle with the ${label}`}</span>
      </button>
    );
  return (
    <button
      type="button"
      onClick={dial}
      className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line bg-bg/60 px-4 text-sm text-fg transition-colors hover:border-faint active:bg-surface-2 md:min-h-9"
    >
      <span className="md:hidden">
        <PhoneIcon size={15} />
      </span>
      <span className="hidden md:inline">
        <HeadsetIcon size={15} />
      </span>
      <span className="md:hidden">Call</span>
      <span className="hidden md:inline">{here ? "In the huddle" : "Huddle"}</span>
    </button>
  );
}

/** The agent's voice on calls: one dropdown, saved on change, with a preview */
export function AgentVoice({ roleKey, voiceId, defaultName }: { roleKey: string; voiceId: string | null; defaultName: string }) {
  const [voices, setVoices] = useState<CallVoice[] | null>(null);
  const [value, setValue] = useState(voiceId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const preview = useRef<HTMLAudioElement | null>(null);
  const load = () =>
    start(async () => {
      const r = await callVoices(roleKey);
      if (r.ok) setVoices(r.voices);
      else setError(r.error);
    });
  const pick = (id: string) => {
    setValue(id);
    setError(null);
    start(async () => {
      const r = await setAgentVoice(roleKey, id || null);
      if (!r.ok) setError(r.error);
    });
  };
  const current = voices?.find((v) => v.id === value);
  const play = () => {
    if (!current?.preview) return;
    preview.current?.pause();
    preview.current = new Audio(current.preview);
    void preview.current.play().catch(() => undefined);
  };
  if (!voices)
    return (
      <button type="button" onClick={load} disabled={pending} className="inline-flex min-h-11 items-center gap-2 text-[13px] text-muted transition-colors hover:text-fg disabled:opacity-60 md:min-h-8">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M11 5 6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" />
        </svg>
        {pending ? "Loading voices…" : `Voice: ${voiceId ? "custom" : `${defaultName} (default)`} · Change`}
        {error && <span className="text-bad">{error}</span>}
      </button>
    );
  return (
    <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
      <label className="sr-only" htmlFor={`voice-${roleKey}`}>
        Voice on calls
      </label>
      <select id={`voice-${roleKey}`} value={value} onChange={(e) => pick(e.target.value)} disabled={pending} className={`${field} h-11 flex-1 sm:w-64 md:h-9`}>
        <option value="">{defaultName} (default)</option>
        {voices.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
            {v.about ? ` · ${v.about}` : ""}
          </option>
        ))}
      </select>
      {current?.preview && (
        <button type="button" onClick={play} className="inline-flex min-h-11 items-center rounded-full border border-line px-3.5 text-[13px] text-muted transition-colors hover:border-faint hover:text-fg md:min-h-9">
          Preview
        </button>
      )}
      {error && <p className="w-full text-xs text-bad">{error}</p>}
    </div>
  );
}
