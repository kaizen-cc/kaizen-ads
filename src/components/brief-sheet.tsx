"use client";

import { linkWord } from "@/lib/asset-links";
import { assetRow, curly, dashTime, driveRows, imageVersions, layoutItems, quoteLine, sourceLabel, type ClientDrive } from "@/lib/brief-cards";
import { ICON_STROKE, ICON_VIEWBOX, ICONS, iconFor, type BriefIcon, type IconTone } from "@/lib/brief-icons";
import { CONFIRM_HEAD, confirmItems, imageVersionNote, versionChange, versionLines } from "@/lib/brief-derive";
import { ASSET_WORD, beatRows, copyOf, frameOf, openingOf, pacing, parseBrief, slideRows, withCopyDirection, type BriefSpec } from "@/lib/brief-spec";

// The brief on screen in the lead video editor's look, the same as the PDF: his section labels (a short red rule), the
// idea, why it works and who it's for, the build as rounded cards (a video's beats with their number, time, name and
// line pictogram, the words on screen in a pink callout, what we see, and what's said in a quote box with a red edge,
// then the pacing bar; a carousel's slides and their order; a single image's frame), the versions as compact cards,
// Do and Don't, Your call, the copy, the assets and export (the client's Drive headquarters and Ad Creatives folder
// first, every link "Open in Drive"), and what to confirm with the client. One column on phones, two on tablets, three
// on a wide sheet. Theme tokens: the cards are --brief-card, the callout brand-soft, the quote box --brief-quote. Nothing
// is cut with "…". Older briefs show their own sections the same way; a brief that isn't written in sections reads as
// its text, headings and lists kept. Used by Ready to send and the ticket.

const LABEL = "text-[11px] font-semibold uppercase tracking-[0.16em]";

/** A line with its links as short "Open in Drive" links (an asset's Drive file, a folder, a page), never a raw address */
export function withLinks(line: string): React.ReactNode {
  const parts = line.split(/(https?:\/\/[^\s<>"')]+)/g);
  if (parts.length === 1) return line;
  return parts.map((p, i) =>
    i % 2 ? (
      <a key={i} href={p.replace(/[.,;:!?]+$/, "")} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="whitespace-nowrap text-[0.92em] font-medium text-brand-text hover:underline">
        {linkWord(p)} ↗
      </a>
    ) : (
      p
    ),
  );
}

/** The brief as sections a person can read: headings ("Hooks to try:"), lists, labelled lines ("Assets: …") */
export function PlainBriefText({ text }: { text: string }) {
  const blocks = text.trim().split(/\n\s*\n/);
  return (
    <div className="grid gap-4 text-[15px] leading-relaxed">
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        const head = /^[A-Z][^.!?\n]{0,48}:\s*$/.test(lines[0].trim()) ? lines[0].trim().replace(/:$/, "") : null;
        const body = head ? lines.slice(1) : lines;
        return (
          <section key={i} className="grid gap-1.5">
            {head && <h4 className={`${LABEL} ${head === "Confirm with client" ? "text-warn" : "text-brand-text"}`}>{head}</h4>}
            {body.map((l, j) => {
              const t = l.trim();
              if (!t) return null;
              const bullet = /^[-•]\s+/.test(t);
              const num = /^(\d+)\.\s+/.exec(t);
              const labelled = /^([A-Z][A-Za-z /&'-]{1,28}):\s+(.+)$/.exec(t.replace(/^[-•]\s+/, ""));
              const content = labelled ? (
                <>
                  <b className="font-medium text-fg">{labelled[1]}:</b> <span className="text-fg/85">{withLinks(labelled[2])}</span>
                </>
              ) : (
                <span className="text-fg/90">{withLinks(t.replace(/^[-•]\s+/, "").replace(/^\d+\.\s+/, ""))}</span>
              );
              if (num)
                return (
                  <p key={j} className="mt-1 font-heading text-[16px] leading-snug">
                    <span className="tabular mr-2 text-faint">{num[1]}</span>
                    {t.replace(/^\d+\.\s+/, "")}
                  </p>
                );
              if (bullet)
                return (
                  <p key={j} className="flex gap-2.5 pl-1">
                    <span aria-hidden className="mt-[10px] h-1.5 w-1.5 shrink-0 rounded-full bg-brand/70" />
                    <span>{content}</span>
                  </p>
                );
              return (
                <p key={j} className={/^\s/.test(l) ? "pl-6" : ""}>
                  {content}
                </p>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

/** His section label: a short red rule and the title in spaced capitals, a note beside it */
function Section({ title, note, children }: { title: string; note?: string | null; children: React.ReactNode }) {
  return (
    <section className="grid min-w-0 content-start gap-3">
      <h4 className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span aria-hidden className="h-[2px] w-5 shrink-0 bg-brand" />
        <span className="text-[11.5px] font-semibold uppercase tracking-[0.2em] text-fg">{title}</span>
        {note ? <span className="text-[12px] text-faint">{note}</span> : null}
      </h4>
      {children}
    </section>
  );
}

const two = (n: number) => String(n).padStart(2, "0");
const clock = (sec: number) => `${Math.floor(sec / 60)}:${two(Math.round(sec % 60))}`;
const SMALL = "text-[10.5px] font-semibold uppercase tracking-[0.14em]";
/** One column on phones, two when there's room, three on a wide sheet (the sheet's own width, not the window's) */
const GRID = "grid gap-3 @lg:grid-cols-2 @3xl:grid-cols-3";

/** A beat's or slide's line pictogram, the same shapes as the PDF's */
function Pictogram({ name, className = "h-8 w-12" }: { name: BriefIcon; className?: string }) {
  const c = (t?: IconTone) => (t === "ink" ? "currentColor" : t === "red" ? "var(--brand)" : t === "pink" ? "var(--brand-soft)" : "none");
  return (
    <svg viewBox={ICON_VIEWBOX} className={`${className} text-fg`} aria-hidden fill="none" strokeLinecap="round" strokeLinejoin="round">
      {ICONS[name].map((p, i) =>
        p.k === "circle" ? (
          <circle key={i} cx={p.cx} cy={p.cy} r={p.r} stroke={c(p.stroke)} strokeWidth={p.w ?? ICON_STROKE} fill={c(p.fill)} />
        ) : p.k === "rect" ? (
          <rect key={i} x={p.x} y={p.y} width={p.w} height={p.h} rx={p.rx ?? 0} stroke={c(p.stroke)} strokeWidth={p.sw ?? ICON_STROKE} fill={c(p.fill)} />
        ) : (
          <path key={i} d={p.d} stroke={c(p.stroke)} strokeWidth={p.w ?? ICON_STROKE} fill={c(p.fill)} strokeDasharray={p.dash} />
        ),
      )}
    </svg>
  );
}

/** The pink callout: a small red label over the bold line */
function Callout({ label, children, big }: { label: string; children: React.ReactNode; big?: boolean }) {
  return (
    <div className="grid gap-0.5 rounded-[8px] bg-brand-soft px-3 py-2">
      <span className={`${SMALL} tracking-[0.06em] text-brand-text`}>{label}</span>
      <p className={`font-semibold leading-snug text-fg ${big ? "font-heading text-[22px] md:text-[26px]" : "text-[14px]"}`}>{children}</p>
    </div>
  );
}

/** The quote box: the background color, a red left edge, a tiny label and the line in italics */
function Quote({ label, children, plain }: { label?: string; children: React.ReactNode; plain?: boolean }) {
  return (
    <div className="grid gap-0.5 rounded-r-[6px] border-l-2 border-brand bg-[var(--brief-quote)] px-3 py-2">
      {label ? <span className={`${SMALL} text-faint`}>{label}</span> : null}
      <p className={`text-[14px] leading-snug text-fg ${plain ? "" : "italic"}`}>{children}</p>
    </div>
  );
}

type CardData = { num: string; time: string; name: string; icon: BriefIcon; calloutLabel: string; callout: string; see: string; quoteLabel: string; quote: string };

function Card({ c, big }: { c: CardData; big?: boolean }) {
  // A single image's version: the headline is the hero, what's in that frame in the quote box
  if (big)
    return (
      <li className="flex min-w-0 flex-col gap-3 rounded-[12px] border border-line bg-[var(--brief-card)] p-4">
        <div className="flex items-start gap-3">
          <span className="tabular font-heading text-[24px] leading-none text-brand-text">{c.num}</span>
          <span className="min-w-0 flex-1 pt-1 text-[12px] font-semibold uppercase tracking-[0.16em] text-fg">{c.name}</span>
          <span className="grid h-11 w-16 shrink-0 place-items-center rounded-[8px] bg-[var(--brief-quote)]">
            <Pictogram name={c.icon} />
          </span>
        </div>
        {c.callout ? (
          <Callout label={c.calloutLabel} big>
            {c.callout}
          </Callout>
        ) : null}
        {c.see ? (
          <div className="mt-auto">
            <Quote label="In this frame" plain>
              {c.see}
            </Quote>
          </div>
        ) : null}
      </li>
    );
  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-[12px] border border-line bg-[var(--brief-card)] p-4">
      <div className="flex items-start gap-3">
        <span className="tabular font-heading text-[24px] leading-none text-brand-text">{c.num}</span>
        <span className="grid min-w-0 flex-1 gap-1">
          {c.time ? <span className="tabular text-[12px] leading-none text-faint">{c.time}</span> : null}
          <span className="text-[12px] font-semibold uppercase tracking-[0.16em] text-fg">{c.name}</span>
        </span>
        <span className="grid h-11 w-16 shrink-0 place-items-center rounded-[8px] bg-[var(--brief-quote)]">
          <Pictogram name={c.icon} />
        </span>
      </div>
      {c.callout ? <Callout label={c.calloutLabel}>{c.callout}</Callout> : null}
      {c.see ? <p className="text-[14px] leading-relaxed text-fg/85">{withLinks(c.see)}</p> : null}
      {c.quote ? (
        <div className="mt-auto">
          <Quote label={c.quoteLabel}>{c.quote}</Quote>
        </div>
      ) : null}
    </li>
  );
}

/** The pacing bar (a video, sized by time with its ticks) or the slide order (a carousel, equal parts) */
function Strip({ parts, total, ticks, label }: { parts: { name: string; share: number }[]; total: number | null; ticks: number[]; label: string }) {
  const marks = total ? [...ticks, ...(ticks[ticks.length - 1] !== total && total - (ticks[ticks.length - 1] ?? 0) >= 3 ? [total] : [])] : [];
  return (
    <div className="grid gap-1.5" aria-label={label}>
      <div className="flex h-8 gap-[3px]">
        {parts.map((x, i) => (
          <span key={i} title={x.name} style={{ width: `${(x.share * 100).toFixed(2)}%` }} className={`flex min-w-0 items-center overflow-hidden rounded-[5px] px-2 text-[12px] text-bg ${i % 2 ? "bg-fg/75" : "bg-fg"}`}>
            <span className="shrink-0 font-semibold">{i + 1}</span>
            <span className="ml-1.5 hidden overflow-hidden whitespace-nowrap capitalize @2xl:inline">{x.name}</span>
          </span>
        ))}
      </div>
      {marks.length ? (
        <div className="relative h-4">
          {marks.map((t, i) => (
            <span key={t} style={i === 0 ? { left: 0 } : t === total ? { right: 0 } : { left: `${(t / total!) * 100}%`, transform: "translateX(-50%)" }} className="tabular absolute top-0 text-[11px] text-faint">
              {clock(t)}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Beats({ sp }: { sp: BriefSpec }) {
  const beats = beatRows(sp);
  if (!beats.length) return null;
  const p = pacing(beats);
  const last = beats[beats.length - 1];
  const cards: CardData[] = beats.map((b, i) => {
    const audioHere = i === beats.length - 1 && !b.says && Boolean(sp.audio);
    return {
      num: two(i + 1),
      time: dashTime(b.time),
      name: b.name || `Beat ${i + 1}`,
      icon: iconFor(b.name, b.onScreen, "play"),
      calloutLabel: "On-screen text",
      callout: b.text ? quoteLine(b.text) : "",
      see: b.onScreen,
      quoteLabel: audioHere ? "Audio" : sourceLabel(b.source),
      quote: b.says ? quoteLine(b.says) : audioHere ? sp.audio : "",
    };
  });
  return (
    <>
      <Section title={`The video in ${beats.length} beats`} note={sp.length ? `about ${sp.length.replace(/^~/, "")}` : null}>
        <ol className={GRID}>
          {cards.map((c) => (
            <Card key={c.num} c={c} />
          ))}
        </ol>
      </Section>
      <Section title="Pacing" note={last?.says && sp.audio ? `Audio: ${sp.audio}` : null}>
        <Strip parts={p.parts} total={p.total} ticks={p.ticks} label="Pacing" />
      </Section>
    </>
  );
}

function Slides({ sp }: { sp: BriefSpec }) {
  const slides = slideRows(sp);
  if (!slides.length) return null;
  const jobOf = (i: number) => slides[i].job || (i === 0 ? "Hook" : i === slides.length - 1 ? "CTA" : `Slide ${i + 1}`);
  const cards: CardData[] = slides.map((x, i) => ({
    num: two(i + 1),
    time: `Slide ${i + 1} of ${slides.length}`,
    name: jobOf(i),
    icon: iconFor(jobOf(i), `${x.headline} ${x.shows}`, i === 0 ? "person" : "ticket"),
    calloutLabel: "Headline",
    callout: x.headline ? quoteLine(x.headline) : "",
    see: x.shows,
    quoteLabel: "",
    quote: "",
  }));
  return (
    <>
      <Section title={`The carousel in ${slides.length} slides`}>
        <ol className={GRID}>
          {cards.map((c) => (
            <Card key={c.num} c={c} />
          ))}
        </ol>
      </Section>
      <Section title="Slide order" note="each slide works on its own; the first stops the scroll, the last asks for the click">
        <Strip parts={slides.map((_, i) => ({ name: jobOf(i), share: 1 / slides.length }))} total={null} ticks={[]} label="Slide order" />
      </Section>
    </>
  );
}

function FrameView({ sp }: { sp: BriefSpec }) {
  const f = frameOf(sp.frame);
  if (!f.headline && !f.shows) return null;
  return (
    <Section title="The frame">
      <div className="grid gap-4 rounded-[12px] border border-line bg-[var(--brief-card)] p-4 @2xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] md:p-5">
        <div className="grid content-start gap-3">
          <Callout label="Headline" big>
            {f.headline || "–"}
          </Callout>
          {f.subline && (
            <div className="grid gap-0.5">
              <span className={`${SMALL} text-faint`}>Subline</span>
              <p className="text-[16px] leading-snug text-fg">{f.subline}</p>
            </div>
          )}
          {f.shows && (
            <div className="grid gap-0.5">
              <span className={`${SMALL} text-faint`}>What&apos;s in the frame</span>
              <p className="text-[14px] leading-relaxed text-fg/85">{f.shows}</p>
            </div>
          )}
        </div>
        <div className="grid content-start gap-3">
          <span className="grid h-20 w-28 place-items-center justify-self-end rounded-[10px] bg-[var(--brief-quote)]">
            <Pictogram name={iconFor("", `${f.headline} ${f.shows}`, "check")} className="h-14 w-20" />
          </span>
          {f.readsFirst && <Quote label="Reads first">{f.readsFirst}</Quote>}
          {f.cta && (
            <div className="flex flex-wrap items-center gap-2">
              <span className={`${SMALL} text-faint`}>CTA on the image</span>
              <span className="rounded-full bg-fg px-3 py-1 text-[12.5px] font-semibold text-bg">{f.cta}</span>
            </div>
          )}
        </div>
      </div>
    </Section>
  );
}

/** A single image in N versions: the versions are the build, one card each, then the layout they share */
function ImageVersionsView({ sp }: { sp: BriefSpec }) {
  const f = frameOf(sp.frame);
  const lines = versionLines(sp.versions.filter(Boolean));
  const vs = imageVersions(lines.map((l) => l.line), f.shows).map((v, i) => (lines[i]?.also ? { ...v, shows: [v.shows, `Also changes: ${lines[i].also}`].filter(Boolean).join(". ") } : v));
  const layout = layoutItems(f, sp.dos);
  const cards: CardData[] = vs.map((v) => ({ num: v.num, time: "", name: v.kind, icon: v.icon, calloutLabel: "Headline", callout: v.headline ? quoteLine(v.headline) : "", see: v.shows, quoteLabel: "", quote: "" }));
  return (
    <>
      <Section title={`The images in ${vs.length} versions`} note={imageVersionNote(vs)}>
        <ol className="grid gap-3 @lg:grid-cols-2 @3xl:grid-cols-4">
          {cards.map((c) => (
            <Card key={c.num} c={c} big />
          ))}
        </ol>
      </Section>
      {layout.length > 0 && (
        <Section title="The layout" note="the same in every version">
          <div className="grid gap-2 rounded-[12px] border border-line bg-[var(--brief-card)] p-3 @lg:grid-cols-2 @3xl:grid-cols-4">
            {layout.map((x) => (
              <Quote key={x.label} label={x.label}>
                {x.label === "Subline" || x.label === "CTA on the image" ? quoteLine(x.text) : x.text}
              </Quote>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

function Marks({ items, mark, cls }: { items: string[]; mark: string; cls: string }) {
  return (
    <ul className="grid gap-2">
      {items.map((x, i) => (
        <li key={i} className="flex gap-3 text-[14px] leading-relaxed">
          <span aria-hidden className={`w-3 shrink-0 font-semibold ${cls}`}>
            {mark}
          </span>
          <span className="min-w-0 text-fg/90">{withLinks(x)}</span>
        </li>
      ))}
    </ul>
  );
}

/** A row of the Assets table: the label, what it is, and its link as a short "Open in Drive ↗" */
function AssetRow({ label, what, url, tone }: { label: string; what: string; url: string | null; tone?: string }) {
  return (
    <li className="grid gap-x-4 gap-y-0.5 px-4 py-2.5 @lg:grid-cols-[150px_minmax(0,1fr)] @lg:items-center">
      <span className={`${SMALL} ${tone ?? "text-faint"}`}>{label}</span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-3 text-[14px] leading-relaxed text-fg/90">
        {what ? <span className="min-w-0">{what}</span> : null}
        {url && (
          <a href={url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex min-h-11 items-center whitespace-nowrap font-semibold text-brand-text underline underline-offset-4 hover:no-underline md:min-h-0">
            {/drive\.google\.com|docs\.google\.com/.test(url) ? "Open in Drive" : linkWord(url)} ↗
          </a>
        )}
      </span>
    </li>
  );
}

/**
 * The brief in its sections, in the lead video editor's look. exportLine: the request's one export line, when the
 * brief doesn't carry its own. drive: the client's Drive headquarters and Ad Creatives folder, first in the Assets.
 */
export function BriefSheet({ text, exportLine, drive }: { text: string; exportLine?: string | null; drive?: ClientDrive | null }) {
  const { overview, spec: sp } = parseBrief(text);
  // The idea in one sentence, the fallback short (its rest under Confirm with client), copy direction in the Copy;
  // anything else in the overview ("Hooks to try:", a heading this doesn't know) reads as its text
  const { idea, fallback, fallbackMore, copy: direction, rest } = openingOf(overview);
  const versions = sp.versions.filter(Boolean);
  const hook = sp.hook.trim() && sp.hook.trim() !== versions[0] ? sp.hook.trim() : "";
  const copy = withCopyDirection(copyOf(sp.copy), direction);
  // A single image in two or more versions: the versions are the build
  const imageGrid = sp.frame.length > 0 && versions.length > 1 && !beatRows(sp).length && !slideRows(sp).length;
  // What to confirm, word for word: the questions the ad can't run without under a blocker heading, the rest under
  // "doesn't hold the work" (src/lib/brief-derive.ts)
  const claims = [idea, ...versions, ...beatRows(sp).flatMap((b) => [b.text, b.says]), ...slideRows(sp).map((x) => x.headline), frameOf(sp.frame).headline, ...copy.primary, ...copy.headlines].join(". ");
  const kinds = confirmItems(
    sp.confirm.map((c) => c.question),
    claims,
  );
  const confirm = sp.confirm.map((c, i) => ({ ...c, question: kinds[i]?.text ?? c.question, blocker: kinds[i]?.blocker ?? false })).filter((c) => c.question);
  const vc = versionChange(versions, beatRows(sp).length ? "video" : slideRows(sp).length ? "carousel" : "image");
  const assets = sp.assets.filter((a) => a.item.trim());
  const exp = sp.exportLine || exportLine || "";
  const driveLinks = driveRows(drive);
  const older: [string, React.ReactNode][] = [
    ["Key message", sp.keyMessage],
    ["Proof", sp.proof.length ? <Marks items={sp.proof} mark="•" cls="text-brand-text" /> : null],
    ["Constraints", sp.constraints.length ? <Marks items={sp.constraints} mark="•" cls="text-brand-text" /> : null],
    ["KPI", sp.kpi],
    ["Success looks like", sp.success],
  ];

  return (
    <div className="@container grid min-w-0 gap-7 text-[15px] leading-relaxed">
      {(idea || sp.stage || fallback) && (
        <div className="grid gap-2">
          {sp.stage && <span className="text-[11.5px] font-semibold uppercase tracking-[0.2em] text-brand-text">{sp.stage}</span>}
          {idea && <p className="font-heading text-[19px] leading-snug text-fg md:text-[21px]">{withLinks(curly(idea))}</p>}
          {fallback && <p className="text-[13.5px] leading-relaxed text-muted">Fallback: {curly(fallback)}</p>}
        </div>
      )}

      {(sp.insight || sp.who) && (
        <div className="grid gap-5 @2xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          {sp.insight && (
            <Section title="Why it works">
              <div className="grid gap-1">
                <p className="text-fg/90">{sp.insight}</p>
                {sp.insightSource && <p className="text-[12.5px] text-faint">Source: {sp.insightSource}</p>}
              </div>
            </Section>
          )}
          {sp.who && (
            <Section title="Who it's for">
              <div className="grid gap-1">
                <p className="text-fg/90">{sp.who}</p>
                <p className="text-[12.5px] text-faint">Targeting is the media buyer&apos;s call.</p>
              </div>
            </Section>
          )}
        </div>
      )}

      {hook && (
        <Section title="Hook">
          <p className="text-fg/90">{hook}</p>
        </Section>
      )}

      <Beats sp={sp} />
      <Slides sp={sp} />
      {imageGrid ? <ImageVersionsView sp={sp} /> : <FrameView sp={sp} />}

      {versions.length > 0 && !imageGrid && (
        <Section title={`The versions (${versions.length})`} note={vc.note}>
          <ol className={GRID}>
            {vc.rows.map((v, i) => (
              <li key={i} className="flex gap-3 rounded-[12px] border border-line bg-[var(--brief-card)] px-4 py-3">
                <span className="tabular w-7 shrink-0 font-heading text-[17px] leading-snug text-brand-text">V{i + 1}</span>
                <span className="grid min-w-0 gap-1">
                  <span className="font-semibold leading-snug text-fg">{v.line}</span>
                  {v.also && (
                    <span className="text-[13px] leading-snug text-fg/80">
                      <b className="font-semibold text-brand-text">Also changes:</b> {v.also}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {(sp.dos.length > 0 || sp.donts.length > 0) && (
        <Section title="Do and don't">
          <div className="grid gap-3 @2xl:grid-cols-2">
            {sp.dos.length > 0 && (
              <div className="grid content-start gap-3 rounded-[12px] border border-line bg-[var(--brief-card)] p-4 md:p-5">
                <span className="text-[11.5px] font-semibold uppercase tracking-[0.2em] text-fg">Do</span>
                <Marks items={sp.dos} mark="+" cls="text-fg" />
              </div>
            )}
            {sp.donts.length > 0 && (
              <div className="grid content-start gap-3 rounded-[12px] border border-brand/40 bg-[var(--brief-quote)] p-4 md:p-5">
                <span className="text-[11.5px] font-semibold uppercase tracking-[0.2em] text-brand-text">Don&apos;t</span>
                <Marks items={sp.donts} mark="×" cls="text-brand-text" />
              </div>
            )}
          </div>
        </Section>
      )}

      {sp.yourCall && (
        <Section title="Your call">
          <div className="rounded-[12px] bg-brand-soft px-4 py-3">
            <p className="text-fg/90">{sp.yourCall}</p>
          </div>
        </Section>
      )}

      {(copy.primary.length > 0 || copy.headlines.length > 0 || copy.cta) && (
        <Section title="Copy">
          <div className="grid gap-4 rounded-[12px] border border-line bg-[var(--brief-card)] p-4 @2xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            {copy.primary.length > 0 && (
              <div className="grid content-start gap-2">
                <span className={`${SMALL} text-faint`}>Primary text</span>
                {copy.primary.map((x, i) => (
                  <Quote key={i} plain>
                    {x}
                  </Quote>
                ))}
              </div>
            )}
            <div className="grid content-start gap-2">
              {copy.headlines.length > 0 && <span className={`${SMALL} text-faint`}>Headlines</span>}
              {copy.headlines.map((x, i) => (
                <p key={i} className="font-semibold leading-snug text-fg">
                  {x}
                </p>
              ))}
              {copy.cta && (
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span className={`${SMALL} text-faint`}>Call to action</span>
                  <span className="rounded-full bg-fg px-3 py-1 text-[12.5px] font-semibold text-bg">{copy.cta}</span>
                </div>
              )}
            </div>
          </div>
        </Section>
      )}

      {(driveLinks.length > 0 || assets.length > 0 || exp) && (
        <Section title="Assets and export">
          <ul className="grid divide-y divide-line overflow-hidden rounded-[12px] border border-line bg-[var(--brief-card)]">
            {driveLinks.map((r) => (
              <AssetRow key={r.label} label={r.label} what={r.what} url={r.url} />
            ))}
            {assets.map((a, i) => {
              const r = assetRow(a.status === "have" ? a.item : `Need: ${a.item}`);
              return <AssetRow key={i} label={a.status === "have" ? r.label : ASSET_WORD[a.status]} what={r.what} url={r.url} tone={a.status === "have" ? undefined : "text-brand-text"} />;
            })}
            {exp && <AssetRow label="Export" what={exp} url={null} />}
          </ul>
        </Section>
      )}

      {older.some(([, v]) => v) && (
        <div className="grid gap-5">
          {older
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <Section key={k} title={k}>
                {typeof v === "string" ? <p className="text-fg/85">{v}</p> : v}
              </Section>
            ))}
        </div>
      )}

      {sp.script && (
        <Section title="Script">
          <p className="whitespace-pre-wrap text-fg/90">{sp.script}</p>
        </Section>
      )}

      {confirm.some((c) => c.blocker) && (
        <div className="grid gap-2 rounded-[12px] border border-brand/60 px-4 py-3">
          <span className={`${SMALL} text-brand-text`}>{CONFIRM_HEAD.blockers}</span>
          <ul className="grid gap-1.5">
            {confirm
              .filter((c) => c.blocker)
              .map((c, i) => (
                <li key={i} className="flex gap-3 text-[14px] leading-relaxed">
                  <span aria-hidden className="w-3 shrink-0 font-semibold text-brand-text">
                    !
                  </span>
                  <span className="min-w-0">
                    <span className="text-fg">{c.question}</span>
                    {c.answer && (
                      <span className="text-fg/75">
                        {" "}
                        <b className="font-medium text-ok">Answer:</b> {c.answer}
                        {c.source ? <span className="text-faint"> ({c.source})</span> : null}
                      </span>
                    )}
                  </span>
                </li>
              ))}
          </ul>
        </div>
      )}

      {(confirm.some((c) => !c.blocker) || fallbackMore) && (
        <div className="grid gap-2 rounded-[12px] bg-brand-soft px-4 py-3">
          <span className={`${SMALL} text-brand-text`}>{CONFIRM_HEAD.open}</span>
          <ul className="grid gap-1.5">
            {confirm.filter((c) => !c.blocker).map((c, i) => (
              <li key={i} className="flex gap-3 text-[14px] leading-relaxed">
                <span aria-hidden className="w-3 shrink-0 font-semibold text-brand-text">
                  ?
                </span>
                <span className="min-w-0">
                  <span className="text-fg">{c.question}</span>
                  {c.answer && (
                    <span className="text-fg/75">
                      {" "}
                      <b className="font-medium text-ok">Answer:</b> {c.answer}
                      {c.source ? <span className="text-faint"> ({c.source})</span> : null}
                    </span>
                  )}
                </span>
              </li>
            ))}
            {fallbackMore && (
              <li className="flex gap-3 text-[14px] leading-relaxed">
                <span aria-hidden className="w-3 shrink-0 font-semibold text-brand-text">
                  ›
                </span>
                <span className="min-w-0 text-fg">
                  <b className="font-semibold">If not:</b> {curly(fallbackMore)}
                </span>
              </li>
            )}
          </ul>
        </div>
      )}

      {rest && <PlainBriefText text={rest} />}
    </div>
  );
}

/** The brief as the maker reads it: its sections when it's written in them, its text otherwise */
export function BriefText({ text, exportLine, drive }: { text: string; exportLine?: string | null; drive?: ClientDrive | null }) {
  if (!parseBrief(text).structured) return <PlainBriefText text={text} />;
  return <BriefSheet text={text} exportLine={exportLine} drive={drive} />;
}
