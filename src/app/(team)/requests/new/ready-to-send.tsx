"use client";

import { useEffect, useRef, useState } from "react";
import { PersonAvatar } from "@/components/person-avatar";
import { RefThumb } from "@/components/ref-thumb";
import { SavedConcepts } from "@/components/saved-concepts";
import { Line } from "@/components/quick-brief-sheet";
import type { Allotment } from "@/lib/allotment";
import { savedHref, savedLine } from "@/lib/saved-references";
import { FORMAT_LABEL, type Format, type Priority } from "@/lib/stages";
import { FormatIcon } from "@/app/(team)/board/ticket-card";
import { SIZES, refLinks, selectedFormats, type Draft, type Size } from "./draft";
import { AllotmentBars, Stepper, conceptLine } from "./parts";

// "Ready to send": the request as the designer or editor will receive it, every part readable and editable right here
// (no going back a step): title, angle, audience, priority, sizes, landing page, references (saved ones too), the full
// brief as readable sections with an edit mode, and the copy when it's already written. The allotment says what this
// takes and what's left. The destinations sit in the form's action bar below.

export const TURNAROUND: Record<Format, number> = { image: 2, video: 4, carousel: 2 };
export const MAKER: Record<Format, { role: string; label: string }> = {
  image: { role: "graphic_designer", label: "designer" },
  carousel: { role: "graphic_designer", label: "designer" },
  video: { role: "video_editor", label: "video editor" },
};
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const dueLabel = (f: Format, p: Priority) => {
  const days = p === "urgent" ? Math.floor(TURNAROUND[f] / 2) : TURNAROUND[f];
  return days === 0 ? "Due today" : `Due in ${plural(days, "business day")}`;
};

const PRIORITIES: [Priority, string, string][] = [
  ["normal", "Normal", "Standard turnaround"],
  ["high", "High", "Top of their queue"],
  ["urgent", "Urgent", "Half the turnaround"],
];
const RATIO: Record<Size, { w: number; h: number; label: string }> = { "1x1": { w: 14, h: 14, label: "1:1" }, "4x5": { w: 13, h: 16, label: "4:5" }, "9x16": { w: 10, h: 18, label: "9:16" } };

/** The concepts folded into a brief ("Concepts:" then "1. Name"): one concept per brief, so more than one can be split */
export function briefConcepts(brief: string) {
  const m = /(^|\n)Concepts:\s*\n([\s\S]*?)(?=\n\n[A-Z][^\n]{0,40}:|\n*$)/.exec(brief);
  if (!m) return { base: brief, concepts: [] as { name: string; body: string }[] };
  const parts = m[2].split(/\n(?=\d+\.\s)/).map((x) => x.trim()).filter((x) => /^\d+\.\s/.test(x));
  const concepts = parts.map((p) => {
    const [first, ...rest] = p.split("\n");
    return { name: first.replace(/^\d+\.\s*/, "").trim(), body: rest.map((l) => l.trim()).join("\n") };
  });
  return { base: brief.replace(m[0], m[1]).trim(), concepts };
}

/** The brief as sections a person can read: headings ("Hooks to try:"), lists, labelled lines ("Assets: …") */
function BriefText({ text }: { text: string }) {
  const blocks = text.trim().split(/\n\s*\n/);
  return (
    <div className="grid gap-4 text-[15px] leading-relaxed">
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        const head = /^[A-Z][^.!?\n]{0,48}:\s*$/.test(lines[0].trim()) ? lines[0].trim().replace(/:$/, "") : null;
        const body = head ? lines.slice(1) : lines;
        return (
          <section key={i} className="grid gap-1.5">
            {head && <h4 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-brand-text">{head}</h4>}
            {body.map((l, j) => {
              const t = l.trim();
              if (!t) return null;
              const bullet = /^[-•]\s+/.test(t);
              const num = /^(\d+)\.\s+/.exec(t);
              const labelled = /^([A-Z][A-Za-z /&'-]{1,28}):\s+(.+)$/.exec(t.replace(/^[-•]\s+/, ""));
              const content = labelled ? (
                <>
                  <b className="font-medium text-fg">{labelled[1]}:</b> <span className="text-fg/85">{labelled[2]}</span>
                </>
              ) : (
                <span className="text-fg/90">{t.replace(/^[-•]\s+/, "").replace(/^\d+\.\s+/, "")}</span>
              );
              if (num) return <p key={j} className="mt-1 font-heading text-[16px] leading-snug"><span className="tabular mr-2 text-faint">{num[1]}</span>{t.replace(/^\d+\.\s+/, "")}</p>;
              if (bullet)
                return (
                  <p key={j} className="flex gap-2.5 pl-1">
                    <span aria-hidden className="mt-[10px] h-1.5 w-1.5 shrink-0 rounded-full bg-brand/70" />
                    <span>{content}</span>
                  </p>
                );
              return <p key={j} className={/^\s/.test(l) ? "pl-6" : ""}>{content}</p>;
            })}
          </section>
        );
      })}
    </div>
  );
}

/** A picture for a reference link when there is one: the kept copy of a Meta ad, or a direct image */
const refPicture = (u: string) => {
  const ad = /\/api\/ad-media\/(\d{5,25})/.exec(u)?.[1] ?? null;
  const img = /\.(png|jpe?g|webp|gif|avif)(\?|$)/i.test(u) ? u : null;
  return { adId: ad, src: img };
};
const host = (u: string) => {
  try {
    const x = new URL(u, "https://x.invalid");
    return { host: x.host === "x.invalid" ? "Kaizen Ads" : x.host.replace(/^www\./, ""), path: x.pathname.length > 1 ? x.pathname : "" };
  } catch {
    return { host: u, path: "" };
  }
};

export type ReadyHandle = { focus: (field: string) => void };

export function ReadyToSend({
  draft,
  clientName,
  team,
  allotment,
  demo,
  onChange,
  onSplit,
  handleRef,
}: {
  draft: Draft;
  clientName: string;
  team: Record<string, string>;
  allotment: Allotment | undefined;
  demo?: boolean;
  onChange: (patch: Partial<Draft> | ((d: Draft) => Partial<Draft>)) => void;
  /** More than one concept: keep the first here, the rest become their own briefs */
  onSplit: (rest: { name: string; body: string }[], keep: Partial<Draft>) => void;
  /** The review's "Edit" lands on the field here */
  handleRef?: React.MutableRefObject<ReadyHandle | null>;
}) {
  const [editBrief, setEditBrief] = useState(!draft.brief.trim());
  const [link, setLink] = useState("");
  const briefRef = useRef<HTMLTextAreaElement>(null);
  const formats = selectedFormats(draft);
  const links = refLinks(draft.refs);
  const { base, concepts } = briefConcepts(draft.brief);

  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = {
      focus: (field) => {
        if (field === "brief") setEditBrief(true);
        requestAnimationFrame(() => {
          const el = document.getElementById(`rts-${field}`);
          el?.scrollIntoView({ behavior: "smooth", block: "center" });
          (el as HTMLElement | null)?.focus?.({ preventScroll: true });
        });
      },
    };
  }, [handleRef]);

  useEffect(() => {
    const el = briefRef.current;
    if (!el || !editBrief) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(240, el.scrollHeight)}px`;
  }, [draft.brief, editBrief]);

  const setCount = (f: Format, key: "new" | "variations" | "cards", n: number) => onChange({ formats: { ...draft.formats, [f]: { ...draft.formats[f]!, [key]: n } } });
  const toggleSize = (z: Size) => onChange({ sizes: draft.sizes.includes(z) ? draft.sizes.filter((x) => x !== z) : SIZES.filter((x) => x === z || draft.sizes.includes(x)) });
  const removeLink = (u: string) => onChange({ refs: draft.refs.split("\n").filter((l) => l.trim() !== u).join("\n") });
  const addLink = () => {
    const u = link.trim();
    if (!/^https?:\/\/\S+$/i.test(u)) return;
    if (!links.includes(u)) onChange({ refs: `${draft.refs.trimEnd()}${draft.refs.trim() ? "\n" : ""}${u}` });
    setLink("");
  };
  const split = () => {
    const [first, ...rest] = concepts;
    onSplit(rest, { title: first.name.slice(0, 120), brief: `${base}\n\nConcept:\n${first.name}\n${first.body}`.trim() });
  };
  const counted = formats.map((f) => ({ format: f, ...draft.formats[f]! }));

  return (
    <div className="grid min-w-0 gap-6">
      {concepts.length > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[18px] border border-warn/40 bg-warn-soft/40 px-4 py-3.5">
          <p className="min-w-0 flex-1 text-[14px] leading-relaxed">
            This brief holds <b>{concepts.length} concepts</b>. One concept per brief, so each one is made, counted and approved on its own.
          </p>
          <button type="button" onClick={split} className="min-h-11 shrink-0 rounded-full bg-fg px-4 text-[13.5px] font-medium text-bg hover:opacity-90">
            Split into {concepts.length} briefs
          </button>
        </div>
      )}

      {/* The request as the maker receives it */}
      <article className="relative isolate min-w-0 overflow-hidden rounded-[28px] border border-line bg-surface shadow-[0_30px_80px_-50px_rgba(0,0,0,0.55)]">
        <span aria-hidden className="pointer-events-none absolute -right-24 -top-28 -z-10 h-72 w-72 rounded-full bg-brand/15 blur-[90px]" />
        <div className="grid gap-5 px-5 pb-6 pt-5 md:px-8 md:pt-7">
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <span className="rounded-full bg-fg px-3 py-1 font-medium text-bg">{clientName}</span>
            <span className="text-faint">As the {formats.some((f) => f === "video") && formats.some((f) => f !== "video") ? "team" : MAKER[formats[0] ?? "image"].label} will receive it</span>
          </div>
          <Line id="rts-title" value={draft.title} onChange={(v) => onChange({ title: v })} label="Title" placeholder="Give it a title" className="font-heading text-[28px] leading-[1.1] tracking-tight md:text-[36px]" />

          {/* What gets made: per format, its counts, due and who makes it */}
          <div id="rts-formats" tabIndex={-1} className="grid gap-2 outline-none">
            {formats.map((f) => {
              const c = draft.formats[f]!;
              const maker = team[MAKER[f].role];
              return (
                <div key={f} className="grid gap-3 rounded-[18px] border border-line bg-bg/60 p-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[12px] bg-brand-soft text-brand-text">
                      <FormatIcon format={f} size={20} />
                    </span>
                    <span className="grid min-w-0 gap-0.5">
                      <span className="text-[15px] font-medium">{FORMAT_LABEL[f]}</span>
                      <span className="text-[12px] text-muted">{conceptLine({ format: f, ...c })}</span>
                      <span className="flex flex-wrap items-center gap-x-2 text-[12px] text-faint">
                        {dueLabel(f, draft.priority)} ·{" "}
                        {maker ? (
                          <span className="inline-flex items-center gap-1.5 text-muted">
                            <PersonAvatar name={maker} size={16} /> {maker}
                          </span>
                        ) : (
                          <span className="text-warn">lands unassigned</span>
                        )}
                      </span>
                    </span>
                  </div>
                  <div className="flex flex-wrap items-end gap-2">
                    <Stepper label="Net new" value={c.new} onChange={(n) => setCount(f, "new", n)} />
                    <Stepper label="Variations" value={c.variations} max={5} onChange={(n) => setCount(f, "variations", n)} />
                    {f === "carousel" && <Stepper label="Slides" value={c.cards ?? 5} min={2} max={10} onChange={(n) => setCount(f, "cards", n)} />}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Sizes and priority */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div id="rts-sizes" tabIndex={-1} className="grid gap-2 outline-none">
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Sizes</span>
              <div className="flex flex-wrap gap-2">
                {SIZES.map((z) => {
                  const on = draft.sizes.includes(z);
                  return (
                    <button key={z} type="button" role="checkbox" aria-checked={on} onClick={() => toggleSize(z)} className={`inline-flex min-h-11 items-center gap-2 rounded-full border px-3.5 text-[13.5px] transition ${on ? "border-brand/60 bg-brand-soft text-fg" : "border-line text-muted hover:border-faint"}`}>
                      <span className={`block rounded-[2px] border-[1.5px] ${on ? "border-brand-text" : "border-faint"}`} style={{ width: RATIO[z].w, height: RATIO[z].h }} />
                      {RATIO[z].label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="grid gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Priority</span>
              <div role="radiogroup" aria-label="Priority" className="grid grid-cols-3 gap-1 rounded-full border border-line bg-bg/60 p-1">
                {PRIORITIES.map(([v, l, h]) => (
                  <button key={v} type="button" role="radio" aria-checked={draft.priority === v} title={h} onClick={() => onChange({ priority: v })} className={`min-h-10 rounded-full text-[13px] transition ${draft.priority === v ? (v === "urgent" ? "bg-bad text-white" : "bg-fg text-bg") : "text-muted hover:text-fg"}`}>
                    {l}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Angle" id="rts-angle">
              <Line value={draft.angle} onChange={(v) => onChange({ angle: v })} label="Angle" placeholder="The angle or avatar" className="text-[15px]" />
            </Field>
            <Field label="Audience" id="rts-audience">
              <Line value={draft.audience} onChange={(v) => onChange({ audience: v })} label="Audience" placeholder="Who it's for" className="text-[15px]" />
            </Field>
          </div>

          <Field label="Landing page" id="rts-landing">
            <input
              type="url"
              value={draft.landing ?? ""}
              onChange={(e) => onChange({ landing: e.target.value })}
              placeholder="https://brand.com/offer"
              className="h-11 w-full rounded-[12px] border border-line bg-bg/60 px-3.5 text-[16px] outline-none transition-colors placeholder:text-faint focus:border-brand/60 md:text-[14px]"
            />
          </Field>
        </div>

        {/* The brief, readable, with an edit mode */}
        <div className="grid gap-3 border-t border-line bg-bg/40 px-5 py-6 md:px-8">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">The brief</span>
            <button type="button" onClick={() => setEditBrief(!editBrief)} className="min-h-11 rounded-full border border-line px-4 text-[13px] text-muted hover:border-faint hover:text-fg md:min-h-9">
              {editBrief ? "Done" : "Edit"}
            </button>
          </div>
          {editBrief ? (
            <textarea
              id="rts-brief"
              ref={briefRef}
              autoFocus={Boolean(draft.brief.trim())}
              value={draft.brief}
              onChange={(e) => onChange({ brief: e.target.value })}
              placeholder="What it should say and show. The hook, the offer, on-image text, anything the creative needs."
              className="w-full resize-none rounded-[16px] border border-line bg-surface px-4 py-3.5 text-[16px] leading-relaxed outline-none focus:border-brand/60 md:text-[15px]"
            />
          ) : draft.brief.trim() ? (
            <button id="rts-brief" type="button" onClick={() => setEditBrief(true)} className="cursor-text rounded-[16px] text-left outline-none focus-visible:ring-2 focus-visible:ring-brand/50" aria-label="Edit the brief">
              <BriefText text={draft.brief} />
            </button>
          ) : null}
          {draft.migration?.needsCopy && (
            <Field label="The copy as it stands" id="rts-copy">
              <textarea value={draft.migration.copy} onChange={(e) => onChange({ migration: { ...draft.migration!, copy: e.target.value } })} rows={5} className="w-full rounded-[14px] border border-line bg-surface px-4 py-3 text-[16px] leading-relaxed outline-none focus:border-brand/60 md:text-[14px]" />
            </Field>
          )}
        </div>

        {/* References */}
        <div id="rts-references" tabIndex={-1} className="grid gap-3 border-t border-line px-5 py-6 outline-none md:px-8">
          <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">References</span>
          {(links.length > 0 || draft.origin?.thumb) && (
            <ul className="-mx-5 flex snap-x gap-3 overflow-x-auto px-5 pb-1 [scrollbar-width:thin] md:mx-0 md:px-0">
              {draft.origin?.thumb && (
                <li className="grid w-[150px] shrink-0 snap-start content-start overflow-hidden rounded-[14px] border border-line bg-bg">
                  <span className="relative block aspect-[4/5] overflow-hidden bg-surface-2">
                    <RefThumb src={draft.origin.thumb} format={null} hoverZoom={false} />
                    <span className="absolute left-2 top-2 rounded-full bg-black/65 px-2 py-0.5 text-[10.5px] text-white">Built on</span>
                  </span>
                  <span className="line-clamp-2 p-2 text-[12px] leading-snug text-muted">{draft.origin.label}</span>
                </li>
              )}
              {links.map((u) => {
                const pic = refPicture(u);
                const h = host(u);
                return (
                  <li key={u} className="group relative grid w-[150px] shrink-0 snap-start content-start overflow-hidden rounded-[14px] border border-line bg-bg">
                    <a href={u} target="_blank" rel="noreferrer" className="relative block aspect-[4/5] overflow-hidden bg-gradient-to-br from-surface-2 to-surface">
                      {pic.src || pic.adId ? (
                        <RefThumb src={pic.src} adId={pic.adId} hoverZoom={false} />
                      ) : (
                        <span className="absolute inset-0 grid place-items-center p-3 text-center">
                          <span className="grid gap-1">
                            <span className="font-heading text-[15px] leading-tight">{h.host}</span>
                            <span className="line-clamp-3 break-all text-[11px] text-faint">{h.path}</span>
                          </span>
                        </span>
                      )}
                    </a>
                    <span className="truncate p-2 text-[12px] text-muted">{h.host}</span>
                    <button type="button" onClick={() => removeLink(u)} aria-label={`Remove ${h.host}`} className="absolute right-1.5 top-1.5 grid h-11 w-11 place-items-center rounded-full bg-black/55 text-white backdrop-blur hover:bg-black/75 md:h-8 md:w-8">
                      ✕
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex gap-2">
            <input
              value={link}
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addLink();
                }
              }}
              placeholder="Paste a link: a Motion snapshot, the ad to iterate, an example"
              aria-label="Add a reference link"
              className="h-11 min-w-0 flex-1 rounded-[12px] border border-line bg-bg/60 px-3.5 text-[16px] outline-none placeholder:text-faint focus:border-brand/60 md:text-[14px]"
            />
            <button type="button" onClick={addLink} disabled={!/^https?:\/\/\S+$/i.test(link.trim())} className="min-h-11 shrink-0 rounded-full bg-fg px-4 text-[13.5px] text-bg disabled:opacity-40">
              Add
            </button>
          </div>
          {draft.clientId && !demo && (
            <SavedConcepts
              clientId={draft.clientId}
              added={draft.savedRefIds ?? []}
              hint={`Starred for ${clientName} by the team. Add one and it goes with the brief.`}
              onAdd={async (r) => {
                const href = savedHref(r, window.location.origin);
                onChange((d) => ({
                  refs: href && !d.refs.includes(href) ? `${d.refs.trimEnd()}${d.refs.trim() ? "\n" : ""}${href}` : d.refs,
                  brief: href ? d.brief : `${d.brief.trimEnd()}${d.brief.trim() ? "\n\n" : ""}${savedLine(r)}`,
                  savedRefIds: [...new Set([...(d.savedRefIds ?? []), r.id])],
                }));
                return { ok: true };
              }}
            />
          )}
        </div>
      </article>

      <AllotmentBars allotment={allotment} formats={counted} />
    </div>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return (
    <div id={id} tabIndex={-1} className="grid min-w-0 gap-1.5 outline-none">
      <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">{label}</span>
      {children}
    </div>
  );
}
