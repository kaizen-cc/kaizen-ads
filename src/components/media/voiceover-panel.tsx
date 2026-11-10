"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { clientMedia, generateVoiceover, mediaAccess, mediaToDrive, scriptVoiceover, ticketMedia, voices as loadVoices, type MediaAccess } from "@/app/(team)/media-actions";
import { NoAiNote } from "@/components/media/no-ai-note";
import type { Voice } from "@/lib/elevenlabs";
import { clampVoiceSettings, DEFAULT_VO_MODEL, DEFAULT_VOICE_SETTINGS, MAX_VO_CHARS, VO_MODELS, type MediaJob, type VoiceSettings, type VoModel } from "@/lib/media-models";

// Voiceovers with ElevenLabs, on video tickets (under the script) and on the client's shot list: pick a voice
// (each with a preview), start from the script's VO or paste it, tune the read, and generate. Every take is kept
// on the ticket (or the client) to play, download, regenerate from, or send to their Drive.

const when = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
const LAST_VOICE = "kaizen.vo.voice";
const remember = (v: string) => {
  try {
    localStorage.setItem(LAST_VOICE, v);
  } catch {
    /* private window */
  }
};
const recall = () => {
  try {
    return localStorage.getItem(LAST_VOICE);
  } catch {
    return null;
  }
};

/** Words per second for a natural ad read: the take's length before it's made */
const seconds = (text: string, speed: number) => Math.max(1, Math.round(text.split(/\s+/).filter(Boolean).length / (2.6 * speed)));

const SLIDERS: { key: keyof Omit<VoiceSettings, "speakerBoost">; label: string; min: number; max: number; step: number; low: string; high: string }[] = [
  { key: "stability", label: "Stability", min: 0, max: 1, step: 0.05, low: "More expressive", high: "Steadier" },
  { key: "similarityBoost", label: "Clarity", min: 0, max: 1, step: 0.05, low: "Looser", high: "Closer to the voice" },
  { key: "style", label: "Style", min: 0, max: 1, step: 0.05, low: "Neutral", high: "Exaggerated" },
  { key: "speed", label: "Speed", min: 0.7, max: 1.2, step: 0.05, low: "Slower", high: "Faster" },
];

export function VoiceoverPanel({ requestId, clientId, fromScript = false }: { requestId?: string; clientId?: string; fromScript?: boolean }) {
  const [access, setAccess] = useState<MediaAccess | null>(null);
  const [takes, setTakes] = useState<MediaJob[] | null>(null);
  const [open, setOpen] = useState(false);
  const [voiceList, setVoiceList] = useState<Voice[] | null>(null);
  const [voiceErr, setVoiceErr] = useState<string | null>(null);
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [text, setText] = useState("");
  const [model, setModel] = useState<VoModel>(DEFAULT_VO_MODEL);
  const [settings, setSettings] = useState<VoiceSettings>(DEFAULT_VOICE_SETTINGS);
  const [tuning, setTuning] = useState(false);
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const preview = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let live = true;
    void mediaAccess({ requestId: requestId ?? null, clientId: clientId ?? null }).then((a) => live && setAccess(a));
    const list = requestId ? ticketMedia(requestId, "voiceover") : clientId ? clientMedia(clientId, "voiceover") : Promise.resolve([]);
    void list.then((l) => live && setTakes(l));
    return () => {
      live = false;
    };
  }, [requestId, clientId]);

  // The voices load the first time the panel opens
  useEffect(() => {
    if (!open || voiceList || !access?.elevenlabs) return;
    let live = true;
    void loadVoices().then((r) => {
      if (!live) return;
      if (!r.ok) return setVoiceErr(r.error);
      setVoiceList(r.voices);
      const last = recall();
      setVoiceId((v) => v ?? (last && r.voices.some((x) => x.id === last) ? last : (r.voices[0]?.id ?? null)));
    });
    return () => {
      live = false;
    };
  }, [open, voiceList, access]);

  // On a video ticket, start from the script's VO lines
  useEffect(() => {
    if (!open || !fromScript || !requestId || text) return;
    let live = true;
    void scriptVoiceover(requestId).then((t) => live && t && setText((cur) => cur || t));
    return () => {
      live = false;
    };
  }, [open, fromScript, requestId, text]);

  useEffect(() => () => preview.current?.pause(), []);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!voiceList) return [];
    return q ? voiceList.filter((v) => [v.name, v.description, ...Object.values(v.labels)].filter(Boolean).join(" ").toLowerCase().includes(q)) : voiceList;
  }, [voiceList, filter]);
  const voice = voiceList?.find((v) => v.id === voiceId) ?? null;

  const play = (v: Voice) => {
    if (!v.previewUrl) return;
    preview.current?.pause();
    if (playing === v.id) return setPlaying(null);
    const a = new Audio(v.previewUrl);
    preview.current = a;
    a.onended = () => setPlaying(null);
    void a.play().catch(() => setPlaying(null));
    setPlaying(v.id);
  };

  const generate = () =>
    start(async () => {
      if (!voiceId) return setError("Pick a voice.");
      setError(null);
      setNote(null);
      remember(voiceId);
      const r = await generateVoiceover({ voiceId, voiceName: voice?.name ?? null, text, model, settings: clampVoiceSettings(settings), requestId: requestId ?? null, clientId: clientId ?? null });
      if (!r.ok) return setError(r.error);
      setTakes((t) => [r.job, ...(t ?? [])]);
    });

  const again = (j: MediaJob) => {
    if (j.prompt) setText(j.prompt);
    setOpen(true);
    document.getElementById(`vo-${requestId ?? clientId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const toDrive = (j: MediaJob) =>
    start(async () => {
      setNote(null);
      const r = await mediaToDrive(j.id);
      if (!r.ok) return setError(r.error);
      setNote(r.note);
      setTakes((t) => (t ?? []).map((x) => (x.id === j.id ? { ...x, driveNote: r.note } : x)));
    });

  // A client who said no to AI content: no AI voices are offered for them
  const can = access?.canGenerate && access.elevenlabs && !access.noAi;
  const chars = text.trim().length;

  return (
    <section id={`vo-${requestId ?? clientId}`} className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-[0.12em] text-faint">Voiceover</h3>
        {access && !access.elevenlabs && <span className="text-[11px] text-faint">ElevenLabs isn&apos;t connected yet</span>}
      </div>

      {access?.noAi && <NoAiNote text={access.noAi} />}

      {can && !open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="group flex min-h-14 items-center justify-between gap-3 rounded-[12px] border border-dashed border-line px-4 py-3 text-left transition-colors hover:border-faint hover:bg-surface"
        >
          <span className="grid gap-0.5">
            <span className="text-sm text-fg">Make a voiceover</span>
            <span className="text-xs text-muted">{fromScript ? "Reads the script's VO in an ElevenLabs voice" : "Any script, read in an ElevenLabs voice"}</span>
          </span>
          <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-fg text-bg transition-transform group-hover:scale-105">
            <Wave />
          </span>
        </button>
      )}

      {can && open && (
        <div className="grid gap-4 rounded-[14px] border border-line bg-bg p-4 md:p-5">
          {/* Voice */}
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] uppercase tracking-[0.12em] text-faint">Voice{voice ? ` · ${voice.name}` : ""}</p>
              {voiceList && voiceList.length > 8 && (
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Find a voice: female, British, calm…"
                  className="h-9 w-full rounded-full border border-line bg-surface px-3.5 text-xs outline-none focus:border-brand-text/60 max-md:h-11 sm:w-64"
                />
              )}
            </div>
            {voiceErr ? (
              <p className="text-xs text-bad">{voiceErr}</p>
            ) : !voiceList ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <span key={i} className="h-[58px] animate-pulse rounded-[10px] bg-surface-2" />
                ))}
              </div>
            ) : (
              <ul className="grid max-h-[280px] grid-cols-1 gap-2 overflow-y-auto overscroll-contain pr-1 sm:grid-cols-2 lg:grid-cols-3">
                {shown.map((v) => {
                  const on = v.id === voiceId;
                  const tags = [v.labels.gender, v.labels.accent, v.labels.age, v.labels.use_case ?? v.labels["use case"]].filter(Boolean).slice(0, 3);
                  return (
                    <li key={v.id} className={`flex min-h-[58px] items-center gap-2 rounded-[10px] border px-2 py-1.5 transition-colors ${on ? "border-fg bg-surface" : "border-line hover:border-faint"}`}>
                      <button type="button" onClick={() => play(v)} disabled={!v.previewUrl} aria-label={playing === v.id ? `Stop ${v.name}` : `Hear ${v.name}`} className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-surface-2 text-fg transition-colors hover:bg-ink/10 disabled:opacity-40 md:h-9 md:w-9">
                        {playing === v.id ? <Stop /> : <Play />}
                      </button>
                      <button type="button" onClick={() => setVoiceId(v.id)} aria-pressed={on} className="grid min-h-11 min-w-0 flex-1 content-center text-left">
                        <span className="truncate text-[13px] font-medium">{v.name}</span>
                        <span className="truncate text-[11px] text-faint">{tags.length ? tags.join(" · ") : v.category}</span>
                      </button>
                    </li>
                  );
                })}
                {!shown.length && <li className="text-xs text-faint">No voice matches.</li>}
              </ul>
            )}
          </div>

          {/* Script */}
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] uppercase tracking-[0.12em] text-faint">What it says</p>
              {fromScript && requestId && (
                <button type="button" onClick={() => void scriptVoiceover(requestId).then((t) => (t ? setText(t) : setNote("The script has no VO lines yet. Write the script first, or paste the VO.")))} className="text-xs text-muted hover:text-fg max-md:min-h-11">
                  Use the script&apos;s VO
                </button>
              )}
            </div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              maxLength={MAX_VO_CHARS + 200}
              placeholder="Paste the voiceover. Line breaks make natural pauses; ... adds a beat."
              className="min-h-[120px] w-full resize-y rounded-[10px] border border-line bg-surface px-3.5 py-3 text-sm leading-relaxed outline-none focus:border-brand-text/60"
            />
            <p className={`flex justify-between text-[11px] ${chars > MAX_VO_CHARS ? "text-bad" : "text-faint"}`}>
              <span>{chars ? `About ${seconds(text, settings.speed)}s read` : ""}</span>
              <span className="tabular">
                {chars.toLocaleString("en-US")} / {MAX_VO_CHARS.toLocaleString("en-US")} characters
              </span>
            </p>
          </div>

          {/* Tuning */}
          <div className="grid gap-3">
            <button type="button" onClick={() => setTuning((t) => !t)} aria-expanded={tuning} className="flex min-h-11 items-center justify-between rounded-[10px] bg-surface px-3.5 text-left text-xs text-muted hover:text-fg md:min-h-9">
              <span>
                {VO_MODELS.find((m) => m.id === model)?.label} · stability {settings.stability} · speed {settings.speed}×
              </span>
              <span aria-hidden className={`transition-transform ${tuning ? "rotate-180" : ""}`}>⌄</span>
            </button>
            {tuning && (
              <div className="grid gap-4 rounded-[10px] border border-line p-3.5">
                <div className="grid gap-1.5">
                  <p className="text-[11px] text-faint">Model</p>
                  <div className="flex flex-wrap gap-1.5">
                    {VO_MODELS.map((m) => (
                      <button key={m.id} type="button" title={m.about} onClick={() => setModel(m.id)} className={`h-8 rounded-full px-3 text-xs transition-colors max-md:h-11 max-md:px-4 ${model === m.id ? "bg-fg text-bg" : "bg-surface-2 text-muted hover:text-fg"}`}>
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  {SLIDERS.map((s) => (
                    <label key={s.key} className="grid gap-1">
                      <span className="flex justify-between text-[11px] text-faint">
                        <span>{s.label}</span>
                        <span className="tabular text-muted">{settings[s.key]}</span>
                      </span>
                      <input
                        type="range"
                        min={s.min}
                        max={s.max}
                        step={s.step}
                        value={settings[s.key]}
                        onChange={(e) => setSettings((x) => clampVoiceSettings({ ...x, [s.key]: Number(e.target.value) }))}
                        className="h-8 w-full accent-[#b21e2c]"
                      />
                      <span className="flex justify-between text-[10.5px] text-faint">
                        <span>{s.low}</span>
                        <span>{s.high}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="flex min-h-11 items-center gap-2 text-xs text-muted md:min-h-0">
                    <input type="checkbox" checked={settings.speakerBoost} onChange={(e) => setSettings((x) => ({ ...x, speakerBoost: e.target.checked }))} className="h-4 w-4 accent-[#b21e2c]" />
                    Speaker boost
                  </label>
                  <button type="button" onClick={() => (setSettings(DEFAULT_VOICE_SETTINGS), setModel(DEFAULT_VO_MODEL))} className="text-xs text-faint hover:text-fg max-md:min-h-11">
                    Reset
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy || !voiceId || !chars || chars > MAX_VO_CHARS}
              onClick={generate}
              className="inline-flex h-10 items-center gap-2 rounded-full bg-brand px-5 text-sm font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-50 max-md:h-12 max-md:w-full max-md:justify-center"
            >
              {busy ? (
                <>
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden /> Recording…
                </>
              ) : takes?.length ? (
                "Generate another take"
              ) : (
                "Generate voiceover"
              )}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="h-10 px-3 text-xs text-faint hover:text-fg max-md:h-11 max-md:w-full">
              Close
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-bad">{error}</p>}
      {note && <p className="text-xs text-muted">{note}</p>}

      {takes && takes.length > 0 && (
        <ol className="grid gap-2">
          {takes.map((j, i) => (
            <li key={j.id} className="grid gap-2 rounded-[12px] border border-line bg-surface px-3.5 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="text-[13px] font-medium">
                  Take {takes.length - i}
                  <span className="font-normal text-muted"> · {j.title?.replace(/^Voiceover · /, "") ?? "Voiceover"}</span>
                </span>
                <span className="text-[11px] text-faint">
                  {j.by ?? "Someone"} · {when(j.createdAt)}
                  {j.characters ? ` · ${j.characters.toLocaleString("en-US")} chars` : ""}
                </span>
              </div>
              {j.status === "ready" && j.files[0]?.url ? (
                <audio controls preload="none" src={j.files[0].url} className="h-10 w-full" />
              ) : j.status === "failed" ? (
                <p className="text-xs text-bad">{j.error ?? "It didn't work."}</p>
              ) : (
                <p className="text-xs text-muted">Recording…</p>
              )}
              {j.prompt && <p className="line-clamp-2 text-xs leading-relaxed text-muted">{j.prompt}</p>}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                {j.files[0]?.url && (
                  <a href={j.files[0].url} download className="text-muted hover:text-fg max-md:py-2">
                    Download MP3
                  </a>
                )}
                {can && (
                  <button type="button" onClick={() => again(j)} className="text-muted hover:text-fg max-md:py-2">
                    Regenerate with this text
                  </button>
                )}
                {access?.canGenerate && j.status === "ready" && j.clientId && !j.driveNote && (
                  <button type="button" disabled={busy} onClick={() => toDrive(j)} className="text-muted hover:text-fg disabled:opacity-50 max-md:py-2">
                    Save to their Drive
                  </button>
                )}
                {j.driveNote && <span className="text-faint">{j.driveNote}</span>}
              </div>
            </li>
          ))}
        </ol>
      )}
      {access && !access.canGenerate && takes?.length === 0 && <p className="text-xs text-faint">No voiceovers yet. The creative team makes them here.</p>}
    </section>
  );
}

function Play() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <path d="M3 1.8v8.4a.6.6 0 0 0 .9.5l6.6-4.2a.6.6 0 0 0 0-1L3.9 1.3a.6.6 0 0 0-.9.5Z" fill="currentColor" />
    </svg>
  );
}
function Stop() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <rect x="2.5" y="2.5" width="7" height="7" rx="1.2" fill="currentColor" />
    </svg>
  );
}
function Wave() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <path d="M2 7v2M5 4.5v7M8 2.5v11M11 4.5v7M14 7v2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
    </svg>
  );
}
