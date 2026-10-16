"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { KIND_LABEL, type SuggestionKind } from "@/lib/suggestion-kinds";
import type { OpenSuggestion, SuggestionDraft, SuggestionsState } from "@/lib/suggestions";
import { approveSuggestion, chatSuggestion, declineSuggestion, refreshSuggestions, saveSuggestion } from "../suggestion-actions";
import { SectionTitle } from "./shared";

const KIND_TONE: Record<SuggestionKind, string> = {
  fatigue: "bg-warn-soft text-warn",
  kpi: "bg-bad-soft text-bad",
  pacing: "bg-warn-soft text-warn",
  offer: "bg-ok-soft text-ok",
  unhappy: "bg-bad-soft text-bad",
  flop: "bg-warn-soft text-warn",
  lab: "bg-brand-soft text-brand-text",
  winner: "bg-ok-soft text-ok",
  refresh: "bg-warn-soft text-warn",
  onboarding: "bg-brand text-white",
  call: "bg-warn text-black",
  market: "bg-[#6c5ce7]/15 text-[#8b7cf6]",
};
const FORMAT_LABEL = { image: "Images", video: "Videos", carousel: "Carousels" } as const;
const SIZES = ["1x1", "4x5", "9x16"] as const;
const REASONS = ["Not the right time", "Already handled", "Client wouldn't go for it", "The signal isn't real", "Brief isn't strong enough", "Wrong angle"];

/**
 * Briefs the strategist suggests from the data, for execs and leads. Each one can be approved (tickets are made),
 * edited in place, declined with a reason (it learns), or talked through with the AI.
 */
export function SuggestedBriefs({ state }: { state: SuggestionsState }) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [starting, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const running = state.running || starting;

  // While the strategist is looking, pick up suggestions as they land
  useEffect(() => {
    if (!state.running) return;
    const t = setInterval(() => router.refresh(), 8000);
    return () => clearInterval(t);
  }, [state.running, router]);

  const refresh = () =>
    start(async () => {
      setNote(null);
      const r = await refreshSuggestions();
      if (!r.ok) setNote(r.error);
      router.refresh();
    });

  const current = state.open.find((s) => s.id === open) ?? null;
  const total = state.decided30.approved + state.decided30.declined;

  return (
    <section className="grid gap-4">
      <SectionTitle
        aside={
          <span className="flex items-center gap-3">
            {total > 0 && (
              <span>
                {state.decided30.approved} approved · {state.decided30.declined} declined in 30 days
              </span>
            )}
            <button onClick={refresh} disabled={running} className="rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-fg disabled:opacity-60">
              {running ? "Looking across accounts…" : "Look again"}
            </button>
          </span>
        }
      >
        Suggested briefs
      </SectionTitle>
      {note && <p className="text-xs text-bad">{note}</p>}

      {state.open.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-line bg-surface px-5 py-4">
          <p className="text-sm text-muted">
            {running
              ? "The strategist is reading every account: fatigue, KPIs, pacing, new offers and how clients are feeling."
              : "Nothing needs a new brief right now. The strategist checks every weekday morning, or look again any time."}
          </p>
          {running && <Dots />}
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {state.open.map((s) => (
            <button key={s.id} onClick={() => setOpen(s.id)} className="group grid content-start gap-2.5 rounded-[14px] border border-line bg-surface p-4 text-left transition-colors hover:border-faint">
              <span className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${KIND_TONE[s.kind]}`}>{KIND_LABEL[s.kind]}</span>
                <span className="text-xs text-muted">{s.client}</span>
              </span>
              <span className="font-heading text-[17px] leading-snug">{s.draft.title}</span>
              <span className="line-clamp-2 text-sm text-muted">{s.signal}</span>
              <span className="flex items-center justify-between gap-2 pt-1 text-xs text-faint">
                <span>
                  {s.draft.formats.map((f) => `${f.new + f.variations} ${FORMAT_LABEL[f.format].toLowerCase()}`).join(" · ")}
                  {s.draft.concepts.length ? ` · ${s.draft.concepts.length} concepts` : ""}
                </span>
                <span className="text-fg transition-transform group-hover:translate-x-0.5">Review →</span>
              </span>
            </button>
          ))}
          {running && (
            <div className="grid place-items-center gap-2 rounded-[14px] border border-dashed border-line p-4 text-center text-xs text-faint">
              <Dots />
              Looking for more…
            </div>
          )}
        </div>
      )}

      {current && <SuggestionSheet key={current.id} s={current} onClose={() => setOpen(null)} />}
    </section>
  );
}

function Dots() {
  return (
    <span className="flex gap-1" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span key={i} className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" style={{ animationDelay: `${i * 180}ms` }} />
      ))}
    </span>
  );
}

/** One suggestion, full screen: edit it, talk it through, approve it or decline it. Also opened from the winners library. */
export function SuggestionSheet({ s, onClose }: { s: OpenSuggestion; onClose: () => void }) {
  const router = useRouter();
  const [draft, setDraft] = useState<SuggestionDraft>(s.draft);
  const [why, setWhy] = useState(s.why);
  const [messages, setMessages] = useState(s.messages);
  const [text, setText] = useState("");
  const [thinking, setThinking] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, act] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number[] | null>(null);
  const chatEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: "end" });
  }, [messages.length, thinking]);

  const edit = (patch: Partial<SuggestionDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const save = (d = draft) => void saveSuggestion(s.id, d);

  const send = async () => {
    const body = text.trim();
    if (!body || thinking) return;
    setText("");
    setError(null);
    setMessages((m) => [...m, { role: "user", body, at: new Date().toISOString() }]);
    setThinking(true);
    const r = await chatSuggestion(s.id, body);
    setThinking(false);
    if (!r.ok) return setError(r.error);
    setDraft(r.draft);
    setWhy(r.why);
    setMessages((m) => [...m, { role: "ai", body: r.reply || "Updated.", at: new Date().toISOString() }]);
  };

  const approve = () =>
    act(async () => {
      setError(null);
      const r = await approveSuggestion(s.id, draft);
      if (!r.ok) return setError(r.error);
      setDone(r.numbers);
      router.refresh();
    });

  const decline = () =>
    act(async () => {
      setError(null);
      const r = await declineSuggestion(s.id, reason, remember);
      if (!r.ok) return setError(r.error);
      onClose();
      router.refresh();
    });

  const setCount = (format: SuggestionDraft["formats"][number]["format"], key: "new" | "variations", n: number) => {
    const has = draft.formats.some((f) => f.format === format);
    const formats = has
      ? draft.formats.map((f) => (f.format === format ? { ...f, [key]: Math.max(0, Math.min(key === "new" ? 10 : 5, n)) } : f))
      : [...draft.formats, { format, new: key === "new" ? Math.max(0, n) : 0, variations: key === "variations" ? Math.max(0, n) : 0 }];
    const next = { ...draft, formats };
    setDraft(next);
    save(next);
  };

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-3 backdrop-blur-sm md:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="grid max-h-[94vh] w-full max-w-[1120px] overflow-y-auto overscroll-contain rounded-[18px] md:h-[92vh] md:grid-rows-[minmax(0,1fr)] md:overflow-hidden border border-line bg-bg md:grid-cols-[1fr_360px]">
        {/* The suggestion */}
        <div className="grid min-h-0 content-start gap-5 overscroll-contain p-5 md:overflow-y-auto md:p-6">
          <div className="flex items-start justify-between gap-3">
            <div className="grid min-w-0 flex-1 gap-1.5">
              <span className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${KIND_TONE[s.kind]}`}>{KIND_LABEL[s.kind]}</span>
                <Link href={`/clients/${s.clientSlug}`} className="text-xs text-muted hover:text-fg">
                  {s.client}
                </Link>
              </span>
              <input
                value={draft.title}
                onChange={(e) => edit({ title: e.target.value })}
                onBlur={() => save()}
                className="w-full bg-transparent font-display text-2xl leading-tight outline-none"
                aria-label="Title"
              />
            </div>
            <button onClick={onClose} className="shrink-0 rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-fg">
              Close
            </button>
          </div>

          <div className="grid gap-3 rounded-[14px] border border-line bg-surface p-4">
            <div className="flex items-start gap-3">
              {s.source?.thumbnail && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={s.source.thumbnail} alt="" className="h-16 w-14 shrink-0 rounded-[8px] object-cover" />
              )}
              <div className="grid gap-1">
                <p className="text-xs uppercase tracking-[0.14em] text-faint">{s.kind === "winner" ? "Built on" : s.kind === "refresh" ? "Refreshing" : s.kind === "call" ? "Promised on the call" : "What the data shows"}</p>
                <p className="text-sm">{s.kind === "winner" && s.source ? `"${s.source.headline ?? "A winning ad"}" from ${s.source.client}` : (s.kind === "refresh" || s.kind === "call") && s.source ? `"${s.source.headline}"` : s.signal}</p>
                {(s.kind === "winner" || s.kind === "refresh" || s.kind === "call" || s.kind === "market") && <p className="text-xs text-faint">{s.signal}</p>}
              </div>
            </div>
            {s.evidence.length > 0 && (
              <ul className="grid gap-1 text-xs text-muted">
                {s.evidence.map((e, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-faint" />
                    {e}
                  </li>
                ))}
              </ul>
            )}
            <p className="border-t border-line pt-3 text-sm text-muted">{why}</p>
          </div>

          {done ? (
            <div className="grid gap-2 rounded-[14px] border border-ok/40 bg-ok/10 p-5">
              <p className="font-heading text-lg text-ok">Approved. It&apos;s with the makers.</p>
              <p className="flex flex-wrap gap-2 text-sm">
                {done.map((n) => (
                  <Link key={n} href={`/board?t=${n}`} className="rounded-full border border-line px-3 py-1 hover:border-faint">
                    #{n}
                  </Link>
                ))}
              </p>
            </div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Angle">
                  <input value={draft.angle} onChange={(e) => edit({ angle: e.target.value })} onBlur={() => save()} className={INPUT} />
                </Field>
                <Field label="Audience">
                  <input value={draft.audience} onChange={(e) => edit({ audience: e.target.value })} onBlur={() => save()} className={INPUT} />
                </Field>
              </div>
              <Field label="Brief for the designer">
                <textarea value={draft.brief} onChange={(e) => edit({ brief: e.target.value })} onBlur={() => save()} rows={Math.max(7, draft.brief.split("\n").reduce((n, l) => n + Math.ceil((l.length || 1) / 90), 0) + 1)} className={`${INPUT} h-auto py-2 leading-relaxed`} />
              </Field>

              {draft.concepts.length > 0 && (
                <div className="grid gap-2">
                  <p className="text-xs text-faint">Concepts</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {draft.concepts.map((c, i) => (
                      <div key={i} className="grid content-start gap-1.5 rounded-[12px] border border-line bg-surface p-3">
                        <p className="text-sm font-medium">{c.name}</p>
                        <p className="text-sm">&ldquo;{c.hook}&rdquo;</p>
                        <p className="text-xs text-muted">{c.visual}</p>
                        <p className="text-xs text-faint">{c.copy}</p>
                      </div>
                    ))}
                  </div>
                  <p className="text-[11px] text-faint">Want different concepts? Ask the strategist on the right.</p>
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                <div className="grid gap-1.5">
                  <p className="text-xs text-faint">Formats</p>
                  {(["image", "carousel", "video"] as const).map((f) => {
                    const row = draft.formats.find((x) => x.format === f) ?? { new: 0, variations: 0 };
                    return (
                      <div key={f} className={`flex items-center gap-3 text-sm ${row.new + row.variations ? "" : "opacity-50"}`}>
                        <span className="w-20">{FORMAT_LABEL[f]}</span>
                        <Counter value={row.new} onChange={(n) => setCount(f, "new", n)} label="new" />
                        <Counter value={row.variations} onChange={(n) => setCount(f, "variations", n)} label="variations" />
                      </div>
                    );
                  })}
                </div>
                <div className="grid content-start gap-1.5">
                  <p className="text-xs text-faint">Sizes</p>
                  <div className="flex gap-1.5">
                    {SIZES.map((z) => {
                      const on = draft.sizes.includes(z);
                      return (
                        <button
                          key={z}
                          onClick={() => {
                            const next = { ...draft, sizes: on ? draft.sizes.filter((x) => x !== z) : [...draft.sizes, z] };
                            setDraft(next);
                            save(next);
                          }}
                          className={`h-8 rounded-full px-3 text-xs ${on ? "bg-fg text-bg" : "border border-line text-muted"}`}
                        >
                          {z.replace("x", ":")}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
              <Field label="Landing page">
                <input value={draft.landing} onChange={(e) => edit({ landing: e.target.value })} onBlur={() => save()} placeholder="https://" className={INPUT} />
              </Field>
              <Field label="References for the creative team">
                <div className="grid gap-2">
                  {(draft.refs ?? []).length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {(draft.refs ?? []).map((u) => (
                        <a key={u} href={u} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1.5 truncate rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] text-muted hover:text-fg">
                          <span className={`shrink-0 rounded-full px-1.5 text-[10px] ${/motionapp\.com/i.test(u) ? "bg-[#6c5ce7]/15 text-[#8b7cf6]" : "bg-surface-2 text-faint"}`}>{/motionapp\.com/i.test(u) ? "Motion" : "Link"}</span>
                          <span className="truncate">{u.replace(/^https?:\/\//, "")}</span>
                        </a>
                      ))}
                    </div>
                  )}
                  <textarea
                    value={(draft.refs ?? []).join("\n")}
                    onChange={(e) => edit({ refs: e.target.value.split(/\s+/).filter(Boolean) })}
                    onBlur={() => save()}
                    rows={2}
                    placeholder="Paste a Motion board or item link, one per line"
                    className={`${INPUT} min-h-[64px] py-2 text-xs`}
                  />
                </div>
              </Field>

              <AllotmentBar allotment={s.allotment} formats={draft.formats} />

              {error && <p className="text-sm text-bad">{error}</p>}

              {declining && (s.kind === "winner" || s.kind === "refresh" || s.kind === "call" || s.kind === "market") ? (
                <div className="flex flex-wrap items-center gap-2 rounded-[14px] border border-line bg-surface p-4">
                  <p className="flex-1 text-sm">Discard this brief? Nothing was sent to production.</p>
                  <button
                    onClick={() =>
                      act(async () => {
                        const r = await declineSuggestion(s.id, s.kind === "refresh" ? "Refresh brief discarded" : s.kind === "call" ? "Not needed after all" : "Discarded from the winners library", false);
                        if (!r.ok) return setError(r.error);
                        onClose();
                      })
                    }
                    disabled={busy}
                    className="h-9 rounded-brand bg-fg px-4 text-sm text-bg"
                  >
                    Discard
                  </button>
                  <button onClick={() => setDeclining(false)} className="h-9 px-3 text-sm text-muted hover:text-fg">
                    Keep it
                  </button>
                </div>
              ) : declining ? (
                <div className="grid gap-3 rounded-[14px] border border-line bg-surface p-4">
                  <p className="text-sm font-medium">Why not? The strategist reads this before every suggestion.</p>
                  <div className="flex flex-wrap gap-1.5">
                    {REASONS.map((r) => (
                      <button key={r} onClick={() => setReason(r)} className={`h-8 rounded-full px-3 text-xs ${reason === r ? "bg-fg text-bg" : "border border-line text-muted hover:text-fg"}`}>
                        {r}
                      </button>
                    ))}
                  </div>
                  <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Say more, so it learns" className={`${INPUT} h-auto py-2`} />
                  <label className="flex items-center gap-2 text-xs text-muted">
                    <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                    Also remember this in {s.client}&apos;s memory (every agent reads it)
                  </label>
                  <div className="flex gap-2">
                    <button onClick={decline} disabled={busy || reason.trim().length < 3} className="h-9 rounded-brand bg-fg px-4 text-sm font-medium text-bg disabled:opacity-40">
                      {busy ? "Declining…" : "Decline"}
                    </button>
                    <button onClick={() => setDeclining(false)} className="h-9 rounded-brand px-3 text-sm text-muted hover:text-fg">
                      Back
                    </button>
                  </div>
                </div>
              ) : (
                <div className="sticky -bottom-5 z-10 -mx-5 -mb-5 flex flex-wrap items-center gap-2 border-t border-line bg-bg px-5 pb-5 pt-3 shadow-[0_-12px_24px_-12px_rgba(0,0,0,0.6)] md:-bottom-6 md:-mx-6 md:-mb-6 md:px-6 md:pb-6">
                  <button onClick={approve} disabled={busy || thinking} className="h-10 rounded-brand bg-brand px-5 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50">
                    {busy ? "Making tickets…" : s.kind === "winner" || s.kind === "refresh" || s.kind === "call" || s.kind === "market" ? "Send to production" : "Approve and send to the makers"}
                  </button>
                  <button onClick={() => setDeclining(true)} disabled={busy} className="h-10 rounded-brand border border-line px-4 text-sm text-muted hover:text-fg">
                    {s.kind === "winner" || s.kind === "refresh" || s.kind === "call" || s.kind === "market" ? "Discard" : "Decline"}
                  </button>
                  <span className="ml-auto text-[11px] text-faint">Edits save as you go</span>
                </div>
              )}
            </>
          )}
        </div>

        {/* Talk it through */}
        <div className="flex min-h-[320px] flex-col border-t border-line bg-surface md:min-h-0 md:border-l md:border-t-0">
          <div className="border-b border-line px-4 py-3">
            <p className="text-sm font-medium">Talk to the strategist</p>
            <p className="text-xs text-faint">Ask why, push back, or ask for a different take. It rewrites the brief.</p>
          </div>
          <div className="grid min-h-0 flex-1 content-start gap-2.5 overflow-y-auto overscroll-contain p-4">
            {messages.length === 0 && !thinking && (
              <div className="grid gap-1.5">
                {["Why this and not variations of what's working?", "Make it more aggressive on the offer", "Give me three different concepts"].map((q) => (
                  <button key={q} onClick={() => setText(q)} className="rounded-[10px] border border-line px-3 py-2 text-left text-xs text-muted hover:text-fg">
                    {q}
                  </button>
                ))}
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`max-w-[90%] rounded-[12px] px-3 py-2 text-sm ${m.role === "user" ? "ml-auto bg-fg text-bg" : "bg-bg"}`}>
                {m.body}
              </div>
            ))}
            {thinking && (
              <div className="flex w-fit items-center gap-2 rounded-[12px] bg-bg px-3 py-2.5 text-xs text-faint">
                <Dots /> Rewriting the brief
              </div>
            )}
            <div ref={chatEnd} />
          </div>
          {!done && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
              className="flex gap-2 border-t border-line p-3"
            >
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Message the strategist" className={`${INPUT} flex-1`} />
              <button disabled={thinking || !text.trim()} className="h-9 rounded-brand bg-fg px-3 text-sm text-bg disabled:opacity-40">
                Send
              </button>
            </form>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

const INPUT = "h-9 w-full rounded-brand border border-line bg-bg px-3 text-sm outline-none placeholder:text-faint focus:border-faint";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5">
      <span className="text-xs text-faint">{label}</span>
      {children}
    </label>
  );
}

function Counter({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <button onClick={() => onChange(value - 1)} className="grid h-7 w-7 place-items-center rounded-full border border-line text-muted hover:text-fg" aria-label={`Fewer ${label}`}>
        −
      </button>
      <span className="tabular w-5 text-center">{value}</span>
      <button onClick={() => onChange(value + 1)} className="grid h-7 w-7 place-items-center rounded-full border border-line text-muted hover:text-fg" aria-label={`More ${label}`}>
        +
      </button>
      <span className="text-xs text-faint">{label}</span>
    </span>
  );
}

/** What's left of the client's monthly creative and what this brief takes from it. Net new only; images and carousels share a pool. */
function AllotmentBar({ allotment: a, formats }: { allotment: OpenSuggestion["allotment"]; formats: SuggestionDraft["formats"] }) {
  const take = {
    images: formats.filter((f) => f.format !== "video").reduce((n, f) => n + f.new, 0),
    videos: formats.filter((f) => f.format === "video").reduce((n, f) => n + f.new, 0),
  };
  if (!a || (a.images === null && a.videos === null))
    return <p className="rounded-[12px] border border-dashed border-line px-4 py-3 text-xs text-faint">No monthly allotment set for this client, so there&apos;s nothing to check this against.</p>;
  const pools = [
    { label: "Images & carousels", cap: a.images, used: a.imagesUsed, take: take.images },
    { label: "Videos", cap: a.videos, used: a.videosUsed, take: take.videos },
  ].filter((p) => p.cap !== null && (p.cap > 0 || p.take > 0)) as { label: string; cap: number; used: number; take: number }[];
  const over = pools.some((p) => p.used + p.take > p.cap);
  return (
    <div className={`grid gap-3 rounded-[14px] border p-4 ${over ? "border-bad/40 bg-bad-soft/40" : "border-line bg-surface"}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs uppercase tracking-[0.14em] text-faint">This month&apos;s allotment</p>
        <p className={`text-xs ${over ? "text-bad" : "text-muted"}`}>{over ? "This asks for more than is left. Trim it, use variations, or upsell." : "Variations don't count against it."}</p>
      </div>
      {pools.map((p) => {
        const left = Math.max(0, p.cap - p.used);
        const pct = (n: number) => `${Math.min(100, (n / Math.max(1, p.cap)) * 100)}%`;
        const tooMany = p.used + p.take > p.cap;
        return (
          <div key={p.label} className="grid gap-1.5">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span>{p.label}</span>
              <span className="tabular text-xs text-muted">
                {p.used} used · <span className={tooMany ? "font-medium text-bad" : "text-fg"}>this takes {p.take}</span> · {left} left of {p.cap}
              </span>
            </div>
            <div className="relative h-2 overflow-hidden rounded-full bg-surface-2">
              <div className="absolute inset-y-0 left-0 rounded-full bg-faint/60" style={{ width: pct(p.used) }} />
              <div className={`absolute inset-y-0 rounded-full ${tooMany ? "bg-bad" : "bg-brand"}`} style={{ left: pct(p.used), width: pct(Math.min(p.take, Math.max(0, p.cap - p.used)) || (tooMany ? 0 : p.take)) }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
