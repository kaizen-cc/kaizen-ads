"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { useAgentCall } from "@/components/agent-call-provider";
import { field } from "@/components/ui";
import { ASSISTANT_PALETTE, ASSISTANT_TINT, normalizeHex, pickedColor } from "@/lib/agent-look";
import { DEFAULT_VOICES } from "@/lib/agent-call/core";
import { groupVoices, voiceMatches } from "@/lib/voices";
import { assistantVoices, setAssistantLook, type AssistantVoice } from "./actions";

// Make it yours: what a person calls their assistant, its color (swatches, a hex, the browser's picker and eyedropper)
// and its voice (every usable voice, grouped, each with a play button). Yours alone: nobody else's assistant changes.
// Each choice saves as it's made.

type EyeDropperCtor = new () => { open: () => Promise<{ sRGBHex: string }> };
const eyeDropper = (): EyeDropperCtor | null => (typeof window !== "undefined" ? ((window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper ?? null) : null);
const subscribeNone = () => () => undefined;

const label = "text-[11px] uppercase tracking-[0.16em] text-faint";

function PlayIcon({ playing }: { playing: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      {playing ? <path d="M7 5h4v14H7zM13 5h4v14h-4z" /> : <path d="M8 5v14l11-7z" />}
    </svg>
  );
}

export function MakeItYours({ voice, assistantName }: { voice: string | null; assistantName: string | null }) {
  const router = useRouter();
  const { assistantTint, setAssistantTint, setAssistantName } = useAgentCall();
  const [name, setName] = useState(assistantName ?? "");
  const [hex, setHex] = useState(assistantTint);
  const [voices, setVoices] = useState<AssistantVoice[] | null>(null);
  const [value, setValue] = useState(voice ?? "");
  const [browsing, setBrowsing] = useState(false);
  const [search, setSearch] = useState("");
  const [playing, setPlaying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [loading, setLoading] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const picker = useSyncExternalStore(
    subscribeNone,
    () => eyeDropper(),
    () => null,
  );

  const save = (change: Parameters<typeof setAssistantLook>[0], what: string, after?: (r: Awaited<ReturnType<typeof setAssistantLook>>) => void) =>
    start(async () => {
      setError(null);
      setSaved(null);
      const r = await setAssistantLook(change);
      if (!r.ok) return setError(r.error);
      setSaved(what);
      after?.(r);
      router.refresh();
    });

  const load = () => {
    if (voices || loading) return;
    setLoading(true);
    void assistantVoices().then((r) => {
      setLoading(false);
      if (r.ok) setVoices(r.voices);
      else setError(r.error);
    });
  };

  const saveName = () => {
    const next = name.replace(/\s+/g, " ").trim();
    if (next === (assistantName ?? "")) return;
    save({ name: next || null }, next ? `It answers to ${next} now.` : "Back to Assistant.", (r) => {
      if (r.ok) setAssistantName(next || null);
    });
  };

  const applyColor = (raw: string) => {
    const norm = normalizeHex(raw);
    if (!norm) return setError("Enter a color like #2a9d8f.");
    const fit = pickedColor(norm) ?? ASSISTANT_TINT;
    setHex(fit);
    setAssistantTint(fit);
    save({ color: fit === ASSISTANT_TINT ? null : fit }, fit === norm ? "Color saved." : "Color saved (nudged a little so it reads on light and dark).");
  };
  const pipette = async () => {
    const Ctor = eyeDropper();
    if (!Ctor) return;
    try {
      const r = await new Ctor().open();
      applyColor(r.sRGBHex);
    } catch {
      /* closed without picking */
    }
  };

  const pickVoice = (v: AssistantVoice | null) => {
    setValue(v?.id ?? "");
    save({ voice: v?.id ?? null, owner: v?.owner ?? null }, "Voice saved. You'll hear it on your next call.");
  };

  const play = (id: string, preview: string | null) => {
    audio.current?.pause();
    if (playing === id) return setPlaying(null);
    const a = new Audio(preview ?? `/api/assistant-voice/sample?voice=${encodeURIComponent(id)}`);
    audio.current = a;
    setPlaying(id);
    a.onended = () => setPlaying((p) => (p === id ? null : p));
    a.onerror = () => {
      setPlaying((p) => (p === id ? null : p));
      setError("Couldn't play that sample.");
    };
    void a.play().catch(() => setPlaying(null));
  };

  const groups = useMemo(() => groupVoices((voices ?? []).filter((v) => voiceMatches(v, search))), [voices, search]);
  const current = voices?.find((v) => v.id === value);
  const defaultId = DEFAULT_VOICES.assistant.id;
  const shownName = current?.name ?? (value ? "Your pick" : `${DEFAULT_VOICES.assistant.name} (default)`);

  return (
    <section id="make-it-yours" aria-label="Your assistant" className="grid scroll-mt-24 gap-6 rounded-[24px] border border-line bg-surface p-5 sm:p-6">
      <div>
        <h2 className="font-heading text-[18px] leading-tight">Make it yours</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-muted">Its name, color and voice are yours alone. Nobody else&apos;s assistant changes.</p>
      </div>

      <div className="grid gap-2">
        <label htmlFor="assistant-name" className={label}>
          Name
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="assistant-name"
            value={name}
            maxLength={24}
            placeholder="Assistant"
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => e.key === "Enter" && (e.currentTarget.blur(), e.preventDefault())}
            className={`${field} h-11 min-w-0 flex-1 text-[16px] sm:max-w-xs md:h-10 md:text-[14px]`}
          />
          {name && (
            <button
              type="button"
              onClick={() => {
                setName("");
                save({ name: null }, "Back to Assistant.", () => setAssistantName(null));
              }}
              className="min-h-11 rounded-full px-3 text-[13px] text-faint transition-colors hover:text-fg md:min-h-9"
            >
              Reset
            </button>
          )}
        </div>
        <p className="text-[12px] text-faint">What it&apos;s called in greetings, transcripts and the menu.</p>
      </div>

      <div className="grid gap-2.5">
        <p id="assistant-color" className={label}>
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
                onClick={() => applyColor(c.hex)}
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
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative grid h-11 w-11 shrink-0 cursor-pointer place-items-center md:h-10 md:w-10" title="Pick any color">
            <span className="h-8 w-8 rounded-full border border-line" style={{ background: assistantTint }} />
            <input type="color" aria-label="Pick any color" value={normalizeHex(hex) ?? ASSISTANT_TINT} onChange={(e) => setHex(e.target.value)} onBlur={(e) => e.target.value !== assistantTint && applyColor(e.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
          </label>
          <input
            aria-label="Color as a hex code"
            value={hex}
            maxLength={7}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => setHex(e.target.value)}
            onBlur={() => hex !== assistantTint && applyColor(hex)}
            onKeyDown={(e) => e.key === "Enter" && (e.currentTarget.blur(), e.preventDefault())}
            className={`${field} h-11 w-28 font-mono text-[16px] md:h-10 md:text-[14px]`}
          />
          {picker && (
            <button type="button" onClick={pipette} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line px-4 text-[13px] text-muted transition-colors hover:border-faint hover:text-fg md:min-h-10">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="m2 22 1-1h3l9-9M3 21v-3l9-9M15 6l3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3z" />
              </svg>
              Eyedropper
            </button>
          )}
        </div>
      </div>

      <div className="grid gap-2.5">
        <p id="assistant-voice" className={label}>
          Voice
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-[14px] border border-line bg-bg/50 px-3 sm:max-w-sm">
            <span className="min-w-0 flex-1 text-[14px] text-fg [overflow-wrap:break-word]">{shownName}</span>
            <button
              type="button"
              onClick={() => play(value || defaultId, current?.preview ?? null)}
              aria-label={`Hear ${shownName}`}
              aria-pressed={playing === (value || defaultId)}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted transition-colors hover:text-fg active:bg-surface-2 md:h-9 md:w-9"
            >
              <PlayIcon playing={playing === (value || defaultId)} />
            </button>
          </div>
          <button
            type="button"
            onClick={() => {
              setBrowsing((b) => !b);
              load();
            }}
            aria-expanded={browsing}
            className="inline-flex min-h-11 items-center justify-center rounded-full border border-line px-4 text-[13.5px] text-muted transition-colors hover:border-faint hover:text-fg md:min-h-10"
          >
            {browsing ? "Done" : "Change voice"}
          </button>
        </div>

        {browsing && (
          <div className="grid gap-3 rounded-[18px] border border-line bg-bg/40 p-3 sm:p-4">
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name, accent or tone" aria-label="Search voices" className={`${field} h-11 text-[16px] md:h-10 md:text-[14px]`} />
            {loading && <p className="text-[12.5px] text-faint">Loading the voices…</p>}
            {!loading && voices && !groups.length && <p className="text-[12.5px] text-faint">{search ? "No voice matches that." : "No voices are available yet."}</p>}
            <div role="radiogroup" aria-labelledby="assistant-voice" className="grid max-h-[26rem] gap-4 overflow-y-auto pr-1">
              <button
                type="button"
                role="radio"
                aria-checked={!value}
                onClick={() => pickVoice(null)}
                disabled={pending}
                className={`flex min-h-12 items-center gap-3 rounded-[12px] border px-3 text-left transition-colors ${!value ? "border-brand/60 bg-surface-2" : "border-transparent hover:bg-surface-2/60"}`}
              >
                <span className="min-w-0 flex-1 text-[14px] text-fg">{DEFAULT_VOICES.assistant.name} (default)</span>
              </button>
              {groups.map((g) => (
                <div key={g.key} className="grid gap-1">
                  <p className="px-1 pb-1 text-[10.5px] font-medium uppercase tracking-[0.14em] text-faint">
                    {g.title} <span className="text-faint/70">{g.voices.length}</span>
                  </p>
                  {g.voices.map((v) => {
                    const on = value === v.id;
                    const canPlay = Boolean(v.preview) || g.key !== "library";
                    return (
                      <div key={v.id} className={`flex min-h-12 items-center rounded-[12px] border transition-colors ${on ? "border-brand/60 bg-surface-2" : "border-transparent hover:bg-surface-2/60"}`}>
                        <button type="button" role="radio" aria-checked={on} onClick={() => pickVoice(v)} disabled={pending} className="flex min-h-12 min-w-0 flex-1 items-center gap-3 px-3 text-left">
                          <span className="min-w-0 flex-1">
                            <span className="block text-[14px] text-fg">{v.name}</span>
                            {v.about && <span className="block text-[12px] leading-snug text-faint [overflow-wrap:anywhere]">{v.about}</span>}
                          </span>
                          {on && (
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-brand-text" aria-hidden>
                              <path d="M20 6 9 17l-5-5" />
                            </svg>
                          )}
                        </button>
                        {canPlay && (
                          <button type="button" onClick={() => play(v.id, v.preview)} aria-label={`Hear ${v.name}`} aria-pressed={playing === v.id} className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted transition-colors hover:text-fg active:bg-surface-2 md:h-10 md:w-10">
                            <PlayIcon playing={playing === v.id} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <p aria-live="polite" className="min-h-[1.2em] text-[12.5px]">
        {error ? <span className="text-bad">{error}</span> : saved ? <span className="text-muted">{saved}</span> : null}
      </p>
    </section>
  );
}
