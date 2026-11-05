"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { attributeBuyerInsights, consolidateBuyerInsights, loadConflict, ruleBuyerInsight, talkConflict, teachRefinedRule } from "@/app/(team)/loom-actions";
import type { InsightsStatus } from "@/lib/buying-insights";
import type { ConflictDetail, ConflictMessage, ConflictPoint, ConflictSkill } from "@/lib/insight-conflicts";
import { closeParams, pushParams, replaceParams, useParam } from "@/lib/url-state";

// What the buyers learned from the senior buyer's Looms, at a glance: how many points, of what kind and for which
// platform, the contradictions to settle (each opens a review sheet), the most-said points, and the breakdown by
// industry on demand. The exec tools (consolidate, attribute) sit at the bottom.

const LAYERS: { key: keyof InsightsStatus["byLayer"]; label: string; color: string }[] = [
  { key: "rule", label: "Decision rules", color: "bg-brand" },
  { key: "principle", label: "Principles", color: "bg-ok" },
  { key: "diagnostic", label: "Diagnostics", color: "bg-warn" },
  { key: "case", label: "Cases", color: "bg-muted" },
  { key: "voice", label: "Voice", color: "bg-faint" },
];
const PLATFORM: Record<string, string> = { meta: "Meta", google: "Google", both: "Meta + Google", none: "Any platform" };
const ago = (iso: string | null) => {
  if (!iso) return "not yet";
  const d = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
};

export function BuyerInsightsPanel({ status, canRule, isExec }: { status: InsightsStatus; canRule: boolean; isExec: boolean }) {
  const [all, setAll] = useState(false);
  const total = Object.values(status.byLayer).reduce((n, x) => n + x, 0);
  const a = status.attribution;
  const conflicts = status.conflicts;
  const shown = all ? conflicts : conflicts.slice(0, 6);
  return (
    <div className="grid min-w-0 gap-5">
      <section className="grid gap-5 rounded-[24px] border border-line bg-surface p-4 md:p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="grid gap-1">
            <h2 className="font-heading text-[20px] leading-tight">How the senior buyer buys</h2>
            <p className="max-w-2xl text-[13px] leading-relaxed text-muted">Distilled from his Loom audits. Points he makes in several videos count up; the best supported are written into the Media Buyer and Google Ads Buyer skills.</p>
          </div>
          <span className="text-[12px] text-faint">Skills rewritten {ago(status.skillsAt)}</span>
        </div>
        {total > 0 && (
          <div className="grid gap-3">
            <div className="flex h-2.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
              {LAYERS.map((l) => (status.byLayer[l.key] ? <span key={l.key} className={`${l.color} h-full`} style={{ width: `${(status.byLayer[l.key] / total) * 100}%` }} /> : null))}
            </div>
            <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-[12.5px]">
              {LAYERS.map((l) => (
                <li key={l.key} className="flex items-center gap-1.5">
                  <span className={`h-2 w-2 rounded-full ${l.color}`} aria-hidden />
                  <span className="text-muted">{l.label}</span>
                  <span className="tabular">{status.byLayer[l.key].toLocaleString()}</span>
                </li>
              ))}
            </ul>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Fact label="For every account" value={a.general} />
              <Fact label="One kind of business" value={a.industry} />
              <Fact label="Meta" value={status.byPlatform.meta + status.byPlatform.both} />
              <Fact label="Google" value={status.byPlatform.google + status.byPlatform.both} />
            </div>
          </div>
        )}
        {status.waiting > 0 && <p className="text-[12px] text-faint">{status.waiting} new points waiting to be merged with the next run.</p>}
      </section>

      {conflicts.length > 0 && (
        <section className="grid gap-3 rounded-[24px] border border-brand/30 bg-surface p-4 md:p-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="grid gap-1">
              <h3 className="font-heading text-[18px] leading-tight">
                {conflicts.length} contradiction{conflicts.length === 1 ? "" : "s"} to settle
              </h3>
              <p className="max-w-2xl text-[13px] text-muted">Two Looms (or a Loom and a written skill) give opposite advice. Neither is taught until it&apos;s ruled on.</p>
            </div>
            <button type="button" onClick={() => pushParams({ conflict: conflicts[0].id })} className="min-h-11 rounded-full bg-fg px-5 text-[13px] font-medium text-bg md:min-h-9">
              {canRule ? "Start settling" : "Read them"}
            </button>
          </div>
          <ul className="grid gap-1.5">
            {shown.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => pushParams({ conflict: c.id })} className="grid w-full gap-1 rounded-[14px] border border-line bg-bg/40 px-3 py-2.5 text-left transition-colors hover:border-faint/60">
                  <span className="line-clamp-2 text-[13px] leading-snug">{c.body}</span>
                  <span className="flex min-w-0 items-center gap-2 text-[11.5px] text-faint">
                    <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5">{PLATFORM[c.platform] ?? c.platform}</span>
                    <span className="truncate">vs {c.againstSkill ? `the skill "${c.againstSkill}"` : (c.against ?? "another point")}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {conflicts.length > 6 && (
            <button type="button" onClick={() => setAll((x) => !x)} className="min-h-11 justify-self-start px-1 text-[13px] text-muted hover:text-fg md:min-h-8">
              {all ? "Show fewer" : `Show all ${conflicts.length}`}
            </button>
          )}
        </section>
      )}

      {status.top.length > 0 && (
        <section className="grid gap-3 rounded-[24px] border border-line bg-surface p-4 md:p-6">
          <h3 className="font-heading text-[18px] leading-tight">What he says most</h3>
          <ol className="grid gap-2.5">
            {status.top.map((t, i) => (
              <li key={i} className="flex gap-3">
                <span className="tabular grid h-7 min-w-7 shrink-0 place-items-center rounded-full bg-brand-soft px-1.5 text-[11.5px] text-brand-text" title={`Said in ${t.confidence} videos`}>
                  {t.confidence}×
                </span>
                <span className="text-[13.5px] leading-relaxed">{t.body}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {a.verticals.length > 0 && (
        <details className="group rounded-[24px] border border-line bg-surface p-4 md:p-6">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 md:min-h-8">
            <span className="font-heading text-[18px] leading-tight">By industry</span>
            <span className="text-[12px] text-faint">
              {a.unmapped ? `${a.unmapped} with no industry · ` : ""}
              <span aria-hidden className="inline-block transition-transform group-open:rotate-90">›</span>
            </span>
          </summary>
          <p className="mt-2 text-[12.5px] text-muted">Industry points only reach accounts in that sub-vertical, its vertical or the same business model.</p>
          <div className="-mx-1 mt-3 overflow-x-auto">
            <table className="w-full min-w-[420px] text-[12.5px]">
              <thead className="text-left text-faint">
                <tr>
                  <th className="px-1 py-1 font-normal">Vertical</th>
                  <th className="px-1 py-1 text-right font-normal">Meta</th>
                  <th className="px-1 py-1 text-right font-normal">Google</th>
                  <th className="px-1 py-1 text-right font-normal">Both</th>
                  <th className="px-1 py-1 text-right font-normal">Industry only</th>
                </tr>
              </thead>
              <tbody>
                {a.verticals.map((v) => (
                  <tr key={v.name} className="border-t border-line">
                    <td className="px-1 py-1.5">{v.name}</td>
                    <td className="tabular px-1 py-1.5 text-right">{v.meta}</td>
                    <td className="tabular px-1 py-1.5 text-right">{v.google}</td>
                    <td className="tabular px-1 py-1.5 text-right">{v.both}</td>
                    <td className="tabular px-1 py-1.5 text-right text-brand-text">{v.industry}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {isExec && <Maintenance pending={a.pending} />}
      <ConflictSheet />
    </div>
  );
}

function Fact({ label, value }: { label: string; value: number }) {
  return (
    <div className="grid gap-0.5 rounded-[14px] bg-surface-2/60 px-3 py-2.5">
      <span className="tabular font-heading text-[20px] leading-none">{value.toLocaleString()}</span>
      <span className="text-[11.5px] text-muted">{label}</span>
    </div>
  );
}

/** Execs: merge new points now, attribute what's left (both also run on their own with the Loom queue) */
function Maintenance({ pending }: { pending: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"merge" | "attr" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const run = async (k: "merge" | "attr") => {
    setBusy(k);
    setNote(null);
    if (k === "merge") {
      const r = await consolidateBuyerInsights();
      setNote(r.ok ? `${r.merged} merged, ${r.kept} new points, ${r.conflicts} to settle${r.left ? `, ${r.left} still to go` : ""}.` : r.error);
    } else {
      const r = await attributeBuyerInsights();
      setNote(r.ok ? `${r.attributed} attributed, ${r.scoped} sorted (${r.industry} industry-only)${r.left ? `, ${r.left} still to go` : ""}.` : r.error);
    }
    setBusy(null);
    router.refresh();
  };
  return (
    <div className="grid gap-2 px-1">
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-faint">
        <span>Runs on its own with the Loom queue.</span>
        <button type="button" disabled={!!busy} onClick={() => void run("merge")} className="min-h-11 rounded-full border border-line px-3.5 text-[12.5px] text-muted hover:text-fg disabled:opacity-50 md:min-h-8">
          {busy === "merge" ? "Consolidating…" : "Consolidate now"}
        </button>
        <button type="button" disabled={!!busy} onClick={() => void run("attr")} className="min-h-11 rounded-full border border-line px-3.5 text-[12.5px] text-muted hover:text-fg disabled:opacity-50 md:min-h-8">
          {busy === "attr" ? "Attributing…" : pending ? `Attribute ${pending} now` : "Attribute again"}
        </button>
      </div>
      {note && <p className="text-[12.5px] text-muted">{note}</p>}
    </div>
  );
}

// ─── The review sheet (?conflict=) ──────────────────────────────────────────

function Side({ label, s }: { label: string; s: ConflictPoint | ConflictSkill | null }) {
  const [more, setMore] = useState(false);
  return (
    <div className="grid content-start gap-2 rounded-[18px] border border-line bg-surface p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{label}</p>
      {!s ? (
        <p className="text-[13px] text-muted">The other side wasn&apos;t kept.</p>
      ) : s.kind === "skill" ? (
        <>
          <p className="text-[14px] font-medium leading-snug">The written skill &ldquo;{s.title}&rdquo;</p>
          {s.body && (
            <>
              <p className={`whitespace-pre-wrap text-[12.5px] leading-relaxed text-muted ${more ? "" : "line-clamp-6"}`}>{s.body}</p>
              <button type="button" onClick={() => setMore((m) => !m)} className="justify-self-start text-[12px] text-brand-text hover:underline">
                {more ? "Less" : "Read the skill"}
              </button>
            </>
          )}
        </>
      ) : (
        <>
          <p className="text-[14px] leading-relaxed">{s.body}</p>
          {s.quote && <p className="text-[12.5px] italic leading-relaxed text-muted">&ldquo;{s.quote}&rdquo;</p>}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-faint">
            {s.url && (
              <a href={s.url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center font-medium text-brand-text hover:underline md:min-h-0">
                Watch{s.at ? ` at ${s.at}` : ""}
              </a>
            )}
            {s.video && <span className="truncate">{s.video}</span>}
            <span>
              in {s.support} video{s.support === 1 ? "" : "s"}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

export function ConflictSheet() {
  const id = useParam("conflict");
  // A fresh sheet for each contradiction (its own thread and state)
  return id ? <ConflictBody key={id} id={id} /> : null;
}

function ConflictBody({ id }: { id: string }) {
  const router = useRouter();
  const [d, setD] = useState<ConflictDetail | null>(null);
  const [canRule, setCanRule] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [talking, setTalking] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [text, setText] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void loadConflict(id).then((r) => {
      if (!live) return;
      if (!r.ok) return setError(r.error);
      setD(r.detail);
      setCanRule(r.canRule);
      setTalking(r.detail.messages.length > 0);
    });
    return () => {
      live = false;
    };
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeParams("conflict");
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [id]);

  useEffect(() => {
    if (talking) end.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [talking, thinking, d?.messages.length]);

  const ready = d && d.id === id ? d : null;

  // A ruling shows at once; the sheet moves on to the next one (or closes) a moment later
  const after = (msg: string) => {
    setDone(msg);
    const next = ready?.next ?? null;
    setTimeout(() => {
      if (next) replaceParams({ conflict: next });
      else closeParams("conflict");
      router.refresh();
    }, 700);
  };
  const rule = async (r: "keep" | "drop" | "both") => {
    if (!ready) return;
    after(r === "keep" ? "Taught. The other side won't be." : r === "both" ? "Both kept, each for its own situation." : "Not taught.");
    const res = await ruleBuyerInsight(ready.id, r);
    if (!res.ok) setError(res.error);
  };
  const say = async (msg: string) => {
    if (!ready || thinking) return;
    setError(null);
    setTalking(true);
    if (msg) setD({ ...ready, messages: [...ready.messages, { id: `q-${Date.now()}`, role: "person", body: msg, by: "You", at: new Date().toISOString(), proposal: null, taught: false }] });
    setText("");
    setThinking(true);
    const r = await talkConflict(ready.id, msg);
    setThinking(false);
    if (!r.ok) return setError(r.error);
    setD((x) => (x ? { ...x, messages: [...x.messages, r.answer] } : x));
  };
  const teach = async (m: ConflictMessage) => {
    if (!ready) return;
    setD({ ...ready, messages: ready.messages.map((x) => (x.id === m.id ? { ...x, taught: true } : x)) });
    after("Taught. The refined rule goes into the skills.");
    const r = await teachRefinedRule(m.id);
    if (!r.ok) setError(r.error);
  };

  return (
    <div className="fixed inset-0 z-[90]" role="dialog" aria-modal="true" aria-label="A contradiction in a media buying tactic">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={() => closeParams("conflict")} aria-hidden />
      <aside className="pb-safe absolute inset-x-0 bottom-0 top-[5vh] grid grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-t-[26px] border border-line bg-bg shadow-[0_-30px_80px_-30px_rgba(0,0,0,0.8)] md:inset-y-3 md:left-auto md:right-3 md:top-3 md:w-[680px] md:rounded-[26px]">
        <header className="flex items-start gap-3 border-b border-line px-5 py-4">
          <div className="grid min-w-0 flex-1 gap-0.5">
            <p className="font-heading text-[19px] leading-tight">A contradiction in a media buying tactic</p>
            <p className="text-[12.5px] text-muted">{ready ? `${PLATFORM[ready.platform] ?? ready.platform} · ${ready.layer}${ready.open ? ` · ${ready.open} left to settle` : ""}` : "Opening…"}</p>
          </div>
          <button type="button" onClick={() => closeParams("conflict")} aria-label="Close" className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted hover:bg-ink/[0.06] hover:text-fg">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="grid content-start gap-4 overflow-y-auto overscroll-contain px-5 py-5">
          {error && <p className="rounded-[12px] bg-bad-soft px-3 py-2 text-[12.5px] text-bad">{error}</p>}
          {!ready && !error && <div className="h-40 animate-pulse rounded-[18px] bg-surface" />}
          {ready && (
            <>
              <div className="grid gap-3 md:grid-cols-2">
                <Side label="This Loom says" s={ready.mine} />
                <Side label={ready.other?.kind === "skill" ? "Our written skill says" : "Another Loom says"} s={ready.other} />
              </div>
              {ready.note && (
                <p className="rounded-[14px] bg-warn-soft px-3.5 py-2.5 text-[13px] leading-relaxed">
                  <span className="font-medium text-warn">How they differ: </span>
                  {ready.note}
                </p>
              )}
              {ready.ruling && <p className="text-[13px] text-ok">Already ruled: {ready.ruling === "keep" ? "taught" : ready.ruling === "both" ? "both hold" : "not taught"}.</p>}

              {talking && (
                <div className="grid gap-3 rounded-[18px] border border-line bg-surface p-3.5">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Talking it through with the {ready.agentName}</p>
                  {ready.messages.map((m) =>
                    m.role === "person" ? (
                      <div key={m.id} className="grid justify-items-end gap-0.5">
                        <p className="max-w-[88%] whitespace-pre-wrap break-words rounded-[14px] rounded-br-[4px] bg-surface-2 px-3 py-2 text-[13px] leading-relaxed">{m.body}</p>
                        <span className="text-[10.5px] text-faint">{m.by ?? "Team"}</span>
                      </div>
                    ) : (
                      <div key={m.id} className="grid gap-2">
                        <div className="grid gap-0.5">
                          <span className="text-[10.5px] font-medium text-brand-text">{ready.agentName}</span>
                          <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{m.body}</p>
                        </div>
                        {m.proposal && (
                          <div className="grid gap-2 rounded-[14px] border border-brand/30 bg-brand-soft/40 px-3 py-2.5">
                            <p className="text-[13px] leading-relaxed">
                              <span className="font-medium">The refined rule: </span>
                              {m.proposal}
                            </p>
                            {m.taught ? (
                              <p className="text-[12px] text-ok">✓ Taught. It settles this contradiction and goes into the skills.</p>
                            ) : canRule ? (
                              <button type="button" onClick={() => void teach(m)} className="min-h-11 justify-self-start rounded-full bg-fg px-4 text-[13px] font-medium text-bg md:min-h-9">
                                Teach this refined rule
                              </button>
                            ) : null}
                          </div>
                        )}
                      </div>
                    ),
                  )}
                  {thinking && <p className="animate-pulse text-[12.5px] text-muted">The {ready.agentName} is weighing both sides…</p>}
                  {canRule && (
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                      <textarea
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey && text.trim()) {
                            e.preventDefault();
                            void say(text.trim());
                          }
                        }}
                        rows={2}
                        placeholder="Which situation decides it?"
                        className="min-h-11 w-full resize-none rounded-[12px] border border-line bg-bg px-3 py-2 text-[13px] leading-relaxed outline-none focus:border-faint"
                      />
                      <button type="button" disabled={!text.trim() || thinking} onClick={() => void say(text.trim())} className="min-h-11 rounded-full bg-fg px-4 text-[13px] font-medium text-bg disabled:opacity-50 md:min-h-9">
                        Send
                      </button>
                    </div>
                  )}
                  <div ref={end} />
                </div>
              )}
            </>
          )}
        </div>

        <footer className="border-t border-line px-5 py-3.5">
          {done ? (
            <p className="text-[13px] text-ok">{done}</p>
          ) : !ready ? null : canRule ? (
            <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
              <button type="button" onClick={() => void rule("keep")} className="min-h-11 rounded-full bg-fg px-4 text-[13px] font-medium text-bg md:min-h-9">
                Teach this one
              </button>
              <button type="button" onClick={() => void rule("both")} className="min-h-11 rounded-full border border-line px-4 text-[13px] hover:bg-surface md:min-h-9">
                Both hold
              </button>
              <button type="button" onClick={() => void rule("drop")} className="min-h-11 rounded-full border border-line px-4 text-[13px] text-muted hover:text-bad md:min-h-9">
                Don&apos;t teach it
              </button>
              {!talking ? (
                <button type="button" onClick={() => void say("")} className="min-h-11 rounded-full bg-brand-soft px-4 text-[13px] font-medium text-brand-text md:min-h-9">
                  Talk it through
                </button>
              ) : ready.next ? (
                <button type="button" onClick={() => replaceParams({ conflict: ready.next })} className="min-h-11 rounded-full px-4 text-[13px] text-muted hover:text-fg md:min-h-9">
                  Skip for now
                </button>
              ) : null}
            </div>
          ) : (
            <p className="text-[12.5px] text-faint">Only the people who rule on audits can settle this. You can read both sides and the conversation.</p>
          )}
        </footer>
      </aside>
    </div>
  );
}
