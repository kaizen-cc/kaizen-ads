"use client";

import { linkWord, splitLink } from "@/lib/asset-links";
import { ASSET_WORD, beatRows, copyOf, frameOf, pacing, parseBrief, slideRows, type AssetStatus, type BriefSpec } from "@/lib/brief-spec";

// The brief on screen, in its one structure (src/lib/brief-spec.ts), the same sections as the PDF: the idea and its
// payoff, why it works and who it's for, the build (a video's beats with a pacing bar, a carousel's slides, a single
// image's frame), the versions, then the guardrails (Must, Never, Your call), the assets with "Open in Drive", the copy,
// what to confirm with the client and the export line. Older briefs show their own sections the same way; a brief that
// isn't written in sections reads as its text, headings and lists kept. Used by Ready to send and the ticket.

const LABEL = "text-[11px] font-semibold uppercase tracking-[0.16em]";
const STATUS_CLS: Record<AssetStatus, string> = { have: "bg-ok/15 text-ok", need: "bg-warn-soft text-warn", shoot: "bg-warn-soft text-warn", missing: "bg-bad-soft text-bad" };

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

function Section({ title, note, tone = "brand", children }: { title: string; note?: string | null; tone?: "brand" | "warn" | "bad" | "muted"; children: React.ReactNode }) {
  const cls = tone === "warn" ? "text-warn" : tone === "bad" ? "text-bad" : tone === "muted" ? "text-faint" : "text-brand-text";
  return (
    <section className="grid min-w-0 gap-2">
      <h4 className={`flex flex-wrap items-baseline gap-x-2 ${LABEL} ${cls}`}>
        {title}
        {note ? <span className="text-[11px] font-normal normal-case tracking-normal text-faint">{note}</span> : null}
      </h4>
      {children}
    </section>
  );
}

const two = (n: number) => String(n).padStart(2, "0");

function Beats({ sp }: { sp: BriefSpec }) {
  const beats = beatRows(sp);
  if (!beats.length) return null;
  const p = pacing(beats);
  return (
    <Section title={`The video in ${beats.length} beats`} note={sp.length ? `about ${sp.length.replace(/^~/, "")}` : null}>
      <ol className="grid divide-y divide-line overflow-hidden rounded-[14px] border border-line">
        {beats.map((b, i) => (
          <li key={i} className="grid gap-x-4 gap-y-1.5 px-3.5 py-3 sm:grid-cols-[64px_minmax(0,1fr)_minmax(0,1.15fr)]">
            <span className="flex items-baseline gap-2 sm:grid sm:gap-0.5">
              <span className="tabular font-heading text-[17px] leading-none text-brand-text">{two(i + 1)}</span>
              {b.time && <span className="tabular text-[11.5px] text-faint">{b.time}</span>}
            </span>
            <span className="grid min-w-0 content-start gap-0.5">
              <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fg">{b.name || `Beat ${i + 1}`}</span>
              {b.onScreen && <span className="text-[14px] leading-relaxed text-fg/80">{b.onScreen}</span>}
            </span>
            <span className="grid min-w-0 content-start gap-1.5">
              {b.text && (
                <span className="grid gap-0.5">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">On-screen text</span>
                  <span className="text-[14px] font-medium leading-snug text-fg">{b.text}</span>
                </span>
              )}
              {b.says && (
                <span className="grid gap-0.5">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">{b.source ? `Says · source ${b.source}` : "Says"}</span>
                  <span className="text-[14px] leading-snug text-fg">{b.says}</span>
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] sm:items-start">
        <p className="text-[14px] leading-relaxed">
          <span className="mr-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Audio</span>
          <span className="text-fg/85">{sp.audio || "Your call, within the rules."}</span>
        </p>
        <div className="grid gap-1" aria-label="Pacing">
          <div className="flex h-5 overflow-hidden rounded-[6px]">
            {p.parts.map((x, i) => (
              <span key={i} title={x.name} style={{ width: `${(x.share * 100).toFixed(2)}%` }} className={`grid place-items-center border-r border-surface text-[10px] font-semibold last:border-r-0 ${i % 2 ? "bg-fg/70 text-bg" : "bg-brand text-white"}`}>
                {i + 1}
              </span>
            ))}
          </div>
          {p.total ? <span className="tabular text-right text-[11px] text-faint">0:00 to 0:{two(p.total)}</span> : null}
        </div>
      </div>
    </Section>
  );
}

function Slides({ sp }: { sp: BriefSpec }) {
  const slides = slideRows(sp);
  if (!slides.length) return null;
  return (
    <Section title="The carousel, slide by slide" note={`${slides.length} slides, top to bottom`}>
      <ol className="grid divide-y divide-line overflow-hidden rounded-[14px] border border-line">
        {slides.map((x, i) => (
          <li key={i} className="grid gap-x-4 gap-y-1 px-3.5 py-3 sm:grid-cols-[44px_minmax(0,1fr)_minmax(0,1fr)]">
            <span className="flex items-center gap-2 sm:grid sm:content-start sm:gap-1">
              <span className="tabular font-heading text-[16px] leading-none text-brand-text">S{i + 1}</span>
              {x.job && <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">{x.job}</span>}
            </span>
            <span className="text-[15px] font-medium leading-snug text-fg">{x.headline || "–"}</span>
            {x.shows && <span className="text-[14px] leading-relaxed text-fg/75">{x.shows}</span>}
          </li>
        ))}
      </ol>
    </Section>
  );
}

function FrameView({ sp }: { sp: BriefSpec }) {
  const f = frameOf(sp.frame);
  if (!f.headline && !f.shows) return null;
  const rows: [string, string][] = [
    ["What's in the frame", f.shows],
    ["Reads first", f.readsFirst],
    ["CTA on the image", f.cta],
  ];
  return (
    <Section title="The frame">
      <div className="grid gap-4 rounded-[14px] border border-line p-4 sm:grid-cols-2">
        <div className="grid content-start gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Headline</span>
          <p className="font-heading text-[22px] leading-tight text-fg">{f.headline || "–"}</p>
          {f.subline && <p className="text-[14px] leading-relaxed text-fg/80">{f.subline}</p>}
        </div>
        <dl className="grid content-start gap-2.5">
          {rows
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={k} className="grid gap-0.5">
                <dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">{k}</dt>
                <dd className="text-[14px] leading-relaxed text-fg/85">{v}</dd>
              </div>
            ))}
        </dl>
      </div>
    </Section>
  );
}

function Marks({ items, mark, cls }: { items: string[]; mark: string; cls: string }) {
  return (
    <ul className="grid gap-1.5">
      {items.map((x, i) => (
        <li key={i} className="flex gap-2.5 text-[14px] leading-relaxed">
          <span aria-hidden className={`w-3 shrink-0 font-semibold ${cls}`}>
            {mark}
          </span>
          <span className="min-w-0 text-fg/90">{withLinks(x)}</span>
        </li>
      ))}
    </ul>
  );
}

/** The brief in its sections. exportLine: the request's one export line, when the brief doesn't carry its own. */
export function BriefSheet({ text, exportLine }: { text: string; exportLine?: string | null }) {
  const { overview, spec: sp } = parseBrief(text);
  const lines = overview.split("\n");
  const firstBlank = lines.findIndex((l) => !l.trim());
  const opening = (firstBlank < 0 ? lines : lines.slice(0, firstBlank)).map((l) => l.trim()).filter(Boolean);
  const idea = opening.filter((l) => !/^fallback\s*:/i.test(l) && !/^[A-Z][^.!?\n]{0,48}:\s*$/.test(l));
  const fallback = opening.find((l) => /^fallback\s*:/i.test(l));
  // Anything else in the overview ("Hooks to try:", a heading this doesn't know) reads as its text
  const rest = firstBlank < 0 ? "" : lines.slice(firstBlank).join("\n").trim();
  const versions = sp.versions.filter(Boolean);
  const hook = sp.hook.trim() && sp.hook.trim() !== versions[0] ? sp.hook.trim() : "";
  const copy = copyOf(sp.copy);
  const assets = sp.assets.filter((a) => a.item.trim());
  const exp = sp.exportLine || exportLine || "";
  const older: [string, React.ReactNode][] = [
    ["Key message", sp.keyMessage],
    ["Proof", sp.proof.length ? <Marks items={sp.proof} mark="•" cls="text-brand-text" /> : null],
    ["Constraints", sp.constraints.length ? <Marks items={sp.constraints} mark="•" cls="text-brand-text" /> : null],
    ["KPI", sp.kpi],
    ["Success looks like", sp.success],
  ];

  return (
    <div className="grid min-w-0 gap-6 text-[15px] leading-relaxed">
      {(idea.length > 0 || sp.stage || fallback) && (
        <div className="grid gap-2">
          {sp.stage && <span className="w-fit rounded-full bg-surface-2 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-[0.12em] text-muted">{sp.stage}</span>}
          {idea.length > 0 && <p className="font-heading text-[19px] leading-snug text-fg md:text-[21px]">{withLinks(idea.join(" "))}</p>}
          {fallback && <p className="text-[13.5px] leading-relaxed text-muted">{fallback}</p>}
        </div>
      )}

      {(sp.insight || sp.who) && (
        <div className="grid gap-5 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          {sp.insight && (
            <Section title="Why it works">
              <p className="text-fg/90">{sp.insight}</p>
              {sp.insightSource && <p className="text-[12.5px] text-faint">Source: {sp.insightSource}</p>}
            </Section>
          )}
          {sp.who && (
            <Section title="Who it's for">
              <p className="text-fg/90">{sp.who}</p>
              <p className="text-[12.5px] text-faint">Targeting is the media buyer&apos;s call.</p>
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
      <FrameView sp={sp} />

      {versions.length > 0 && (
        <Section title={`The versions (${versions.length})`} note={versions.length > 1 ? "only this line changes; V1 is net new" : null}>
          <ol className="grid gap-1.5">
            {versions.map((v, i) => (
              <li key={i} className="flex gap-3">
                <span className="tabular w-7 shrink-0 font-heading text-brand-text">V{i + 1}</span>
                <span className="min-w-0 font-medium text-fg">{v}</span>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {(sp.dos.length > 0 || sp.donts.length > 0) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {sp.dos.length > 0 && (
            <div className="rounded-[14px] border border-line p-3.5">
              <Section title="Must">
                <Marks items={sp.dos} mark="+" cls="text-fg" />
              </Section>
            </div>
          )}
          {sp.donts.length > 0 && (
            <div className="rounded-[14px] border border-bad/30 p-3.5">
              <Section title="Never" tone="bad">
                <Marks items={sp.donts} mark="×" cls="text-bad" />
              </Section>
            </div>
          )}
        </div>
      )}

      {sp.yourCall && (
        <div className="rounded-[14px] border-l-[3px] border-brand bg-surface-2/70 px-4 py-3">
          <Section title="Your call">
            <p className="text-fg/90">{sp.yourCall}</p>
          </Section>
        </div>
      )}

      {assets.length > 0 && (
        <Section title="Assets">
          <ul className="grid divide-y divide-line overflow-hidden rounded-[14px] border border-line">
            {assets.map((a, i) => {
              const { text: t, url } = splitLink(a.item);
              return (
                <li key={i} className="flex min-w-0 items-center gap-3 px-3.5 py-2.5 text-[14px]">
                  {a.status !== "have" && <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_CLS[a.status]}`}>{ASSET_WORD[a.status]}</span>}
                  <span className="min-w-0 flex-1 leading-relaxed text-fg/90">{t}</span>
                  {url && (
                    <a href={url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-full border border-brand/40 px-3 text-[12.5px] font-medium text-brand-text hover:bg-brand-soft md:min-h-8">
                      {linkWord(url)} ↗
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {(copy.primary.length > 0 || copy.headlines.length > 0 || copy.cta) && (
        <Section title="Copy">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <div className="grid content-start gap-2">
              {copy.primary.map((x, i) => (
                <p key={i} className="border-l-2 border-line pl-3 text-fg/90">
                  {x}
                </p>
              ))}
            </div>
            <div className="grid content-start gap-2">
              {copy.headlines.map((x, i) => (
                <p key={i} className="font-medium text-fg">
                  {x}
                </p>
              ))}
              {copy.cta && <span className="w-fit rounded-full bg-fg px-3 py-1 text-[12.5px] font-medium text-bg">{copy.cta}</span>}
            </div>
          </div>
        </Section>
      )}

      {older.some(([, v]) => v) && (
        <div className="grid gap-4">
          {older
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <Section key={k} title={k} tone="muted">
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

      {sp.confirm.length > 0 && (
        <div className="rounded-[14px] border border-warn/40 bg-warn-soft/30 px-4 py-3">
          <Section title="Confirm with client" note="doesn't hold the work" tone="warn">
            <ul className="grid gap-1.5">
              {sp.confirm.map((c, i) => (
                <li key={i} className="text-[14px] leading-relaxed">
                  <span className="text-fg">{c.question}</span>
                  {c.answer && (
                    <span className="text-fg/75">
                      {" "}
                      <b className="font-medium text-ok">Answer:</b> {c.answer}
                      {c.source ? <span className="text-faint"> ({c.source})</span> : null}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </Section>
        </div>
      )}

      {rest && <PlainBriefText text={rest} />}

      {exp && (
        <div className="grid gap-1 rounded-[14px] bg-fg px-4 py-3 text-bg">
          <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-bg/60">Export</span>
          <span className="tabular break-words text-[13px] leading-relaxed">{exp}</span>
        </div>
      )}
    </div>
  );
}

/** The brief as the maker reads it: its sections when it's written in them, its text otherwise */
export function BriefText({ text, exportLine }: { text: string; exportLine?: string | null }) {
  if (!parseBrief(text).structured) return <PlainBriefText text={text} />;
  return <BriefSheet text={text} exportLine={exportLine} />;
}
