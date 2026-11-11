"use client";

import { parseBrief, ASSET_WORD, beatRows, frameOf, hookOf, openingOf, slideRows, type AssetStatus } from "@/lib/brief-spec";
import { linkWord, splitLink } from "@/lib/asset-links";
import { briefFileStem } from "@/lib/creative-drive-paths";
import { FORMAT_LABEL } from "@/lib/stages";
import { FormatIcon } from "./ticket-card";
import type { Ticket } from "./types";

// The brief at a glance, above the fold: what the maker reads in ten seconds (the idea and its payoff, why it works, the
// hook, the build in a line, how many versions, the sizes, when it's due and who makes it) and the assets with their
// Drive links, the same sections as the full brief (src/components/brief-sheet.tsx) and the PDF, shortened. "make" is the production sheet: what to
// make, the specs per size and the file names to deliver. The full brief, its check and the references sit one tap away.

const SPECS: Record<string, string> = { "4x5": "4:5 at 1080 x 1350", "9x16": "9:16 at 1080 x 1920", "1x1": "1:1 at 1080 x 1080" };
const STATUS_CLS: Record<AssetStatus, string> = { have: "bg-ok/15 text-ok", need: "bg-warn-soft text-warn", shoot: "bg-warn-soft text-warn", missing: "bg-bad-soft text-bad" };

const fmtDue = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).format(new Date(iso));

/** The idea in one sentence, in words a maker gets in ten seconds (never its Fallback or copy direction) */
const ideaOf = (overview: string) => openingOf(overview).idea;

/** The build in one line: "6 beats, ~30s: Hook, The team, Your way..." / "5 slides: ..." / "Headline: ..." */
function buildLine(spec: ReturnType<typeof parseBrief>["spec"]) {
  const beats = beatRows(spec);
  if (beats.length) return `${beats.length} beats${spec.length ? `, ${spec.length}` : ""}: ${beats.map((b) => b.name).filter(Boolean).join(" · ")}`;
  const slides = slideRows(spec);
  if (slides.length) return `${slides.length} slides: ${slides.map((s) => s.job || s.headline).filter(Boolean).slice(0, 6).join(" · ")}`;
  const f = frameOf(spec.frame);
  return f.headline ? `Headline: ${f.headline}` : "";
}

export function versionsLabel(t: Pick<Ticket, "newCount" | "variationCount" | "quantity">) {
  return (
    [t.newCount && `${t.newCount} new`, t.variationCount && `${t.variationCount} variation${t.variationCount === 1 ? "" : "s"}`].filter(Boolean).join(" + ") ||
    `${t.quantity} creative${t.quantity === 1 ? "" : "s"}`
  );
}

/** The file names the brief asks for: one per size of a design, V for the design's number */
export function fileNames(t: Pick<Ticket, "clientName" | "title" | "sizes">) {
  const stem = briefFileStem(t.clientName, t.title);
  const keys = t.sizes.map((z) => z.replace(":", "x")).filter((z) => z === "4x5" || z === "9x16");
  return (keys.length ? keys : ["4x5", "9x16"]).map((k) => `${stem}_V1_${k}`);
}

const label = "text-[11px] font-semibold uppercase tracking-[0.14em] text-faint";

export function BriefEssentials({ ticket, variant = "brief" }: { ticket: Ticket; variant?: "brief" | "make" }) {
  const { overview, spec } = parseBrief(ticket.brief ?? "");
  const idea = ideaOf(overview);
  const hook = hookOf(spec);
  const build = buildLine(spec);
  const assets = spec.assets.filter((a) => a.item.trim());
  const maker = ticket.assigneeName ?? ticket.creativeName;
  const make = variant === "make";

  const facts: { k: string; v: React.ReactNode }[] = [
    {
      k: "Versions",
      v: (
        <span className="inline-flex items-center gap-1.5">
          <FormatIcon format={ticket.format} /> {versionsLabel(ticket)} · {FORMAT_LABEL[ticket.format]}
          {ticket.format === "carousel" && ticket.cards ? `, ${ticket.cards} cards` : ""}
        </span>
      ),
    },
    { k: "Sizes", v: ticket.sizes.length ? ticket.sizes.map((s) => s.replace("x", ":")).join(" · ") : <span className="text-faint">Not set</span> },
  ];
  if (!make) {
    facts.push({ k: "Due", v: ticket.stageDueAt ? fmtDue(ticket.stageDueAt) : <span className="text-faint">No turnaround in this stage</span> });
    facts.push({ k: "Making it", v: maker ?? <span className="text-faint">Unassigned</span> });
  }
  if (ticket.avatar) facts.push({ k: ticket.avatarTest ? "Avatar test" : "Avatar", v: <span className={ticket.avatarTest ? "text-warn" : ""}>{ticket.avatar}</span> });
  if (ticket.angleName) facts.push({ k: "Angle", v: ticket.angleName });

  return (
    <section className="grid min-w-0 overflow-hidden rounded-[14px] border border-line bg-surface">
      {/* The idea and the hook */}
      {(idea || hook || spec.keyMessage) && !make ? (
        <div className="grid gap-3 px-5 pb-4 pt-5 max-md:px-4">
          {spec.stage && <span className="w-fit rounded-full bg-surface-2 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-[0.12em] text-muted">{spec.stage}</span>}
          {idea && <p className="font-heading text-[18px] leading-snug text-fg max-md:text-[17px]">{idea}</p>}
          {spec.insight && (
            <p className="grid gap-1">
              <span className={label}>Why it works</span>
              <span className="text-sm leading-relaxed text-fg/85">
                {spec.insight}
                {spec.insightSource && <span className="text-faint"> (Source: {spec.insightSource})</span>}
              </span>
            </p>
          )}
          {hook && (
            <p className="grid gap-1">
              <span className={label}>Hook</span>
              <span className="text-[15px] leading-relaxed text-fg/90">{hook}</span>
            </p>
          )}
          {build && (
            <p className="grid gap-1">
              <span className={label}>The build</span>
              <span className="text-sm leading-relaxed text-fg/85">{build}</span>
            </p>
          )}
          {spec.keyMessage && (
            <p className="grid gap-1">
              <span className={label}>Key message</span>
              <span className="text-sm leading-relaxed text-muted">{spec.keyMessage}</span>
            </p>
          )}
        </div>
      ) : make && (hook || idea) ? (
        <div className="grid gap-1 px-5 pb-3 pt-4 max-md:px-4">
          <span className={label}>What to make</span>
          <p className="text-[15px] leading-relaxed text-fg/90">{hook ? <>Opens on: {hook}</> : idea}</p>
          {build && <p className="text-sm leading-relaxed text-muted">{build}</p>}
        </div>
      ) : !ticket.brief?.trim() ? (
        <p className="px-5 pt-4 text-sm text-faint max-md:px-4">No brief written.</p>
      ) : null}

      {/* The facts, label left and value right */}
      <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-4 gap-y-2.5 border-t border-line px-5 py-4 text-sm max-md:grid-cols-[84px_minmax(0,1fr)] max-md:px-4">
        {facts.map((f) => (
          <div key={f.k} className="contents">
            <dt className="text-muted">{f.k}</dt>
            <dd className="min-w-0 text-fg">{f.v}</dd>
          </div>
        ))}
      </dl>

      {/* The production sheet: specs per size and the file names to deliver */}
      {make && (
        <div className="grid gap-3 border-t border-line px-5 py-4 max-md:px-4">
          {ticket.sizes.length > 0 && (
            <div className="grid gap-1.5">
              <span className={label}>Specs</span>
              <ul className="grid gap-1 text-sm text-fg/90">
                {ticket.sizes.map((s) => (
                  <li key={s} className="tabular">
                    {SPECS[s.replace(":", "x")] ?? s}
                    {ticket.format === "video" ? ", MP4 with captions burned in" : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="grid gap-1.5">
            <span className={label}>File names</span>
            <ul className="grid gap-1">
              {fileNames(ticket).map((n) => (
                <li key={n} className="tabular truncate rounded-[8px] bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-fg">
                  {n}
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-faint">V2, V3 for the next designs; sizes of one design share its name so they upload together.</p>
          </div>
        </div>
      )}

      {/* Assets, each with its Drive link */}
      {assets.length > 0 && (
        <div className="grid gap-2 border-t border-line px-5 py-4 max-md:px-4">
          <span className={label}>Assets</span>
          <ul className="grid gap-1.5">
            {assets.map((a, i) => {
              const { text, url } = splitLink(a.item);
              return (
                <li key={i} className="flex min-w-0 items-start gap-2.5 text-sm">
                  <span className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_CLS[a.status]}`}>{ASSET_WORD[a.status]}</span>
                  <span className="min-w-0 flex-1 leading-relaxed text-fg/90">{text}</span>
                  {url && (
                    <a href={url} target="_blank" rel="noreferrer" className="-my-2 inline-flex min-h-11 shrink-0 items-center whitespace-nowrap text-xs font-medium text-brand-text hover:underline md:min-h-0 md:py-2">
                      {linkWord(url)} ↗
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Where it lands and what it's built on */}
      {(ticket.landingUrl || ticket.origin || ticket.audience || spec.who) && (
        <div className="grid gap-2.5 border-t border-line px-5 py-4 max-md:px-4">
          {(spec.who || ticket.audience) && (
            <p className="text-sm">
              <span className="mr-2 text-muted">For</span>
              {spec.who || ticket.audience}
            </p>
          )}
          {ticket.landingUrl && (
            <p className="flex min-w-0 items-center gap-2 text-sm">
              <span className="shrink-0 text-muted">Landing page</span>
              <a href={ticket.landingUrl} target="_blank" rel="noreferrer" className="min-w-0 truncate text-brand-text hover:underline max-md:py-2">
                {ticket.landingUrl.replace(/^https?:\/\//, "")}
              </a>
            </p>
          )}
          {ticket.origin && (
            <div className="flex items-center gap-3 rounded-[12px] border border-brand/25 bg-brand-soft/30 px-3 py-2.5">
              {ticket.origin.thumb && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={ticket.origin.thumb} alt="" className="h-11 w-11 shrink-0 rounded-[8px] object-cover" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block text-[10px] font-medium uppercase tracking-[0.14em] text-brand-text">
                  Built on {ticket.origin.kind === "winner" ? "a winning ad" : ticket.origin.kind === "market" ? "a live ad in the market" : ticket.origin.kind === "promise" ? "a promise from a call" : "an AI brief"}
                </span>
                <span className="block truncate text-sm">{ticket.origin.label}</span>
              </span>
              {ticket.origin.link && (
                <a href={ticket.origin.link} target="_blank" rel="noreferrer" className="shrink-0 rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-fg max-md:py-3">
                  See it ↗
                </a>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
