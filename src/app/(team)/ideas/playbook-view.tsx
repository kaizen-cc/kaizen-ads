"use client";

import { useRef, useState } from "react";
import type { Playbook } from "@/lib/playbooks";

export type Example = { kind: "fame" | "market"; image: string | null; video: string | null; headline: string | null; result: string; name: string; href: string | null };
type Bench = { metric: string; good: number | null; great: number | null; unit: string };

const METRIC: Record<string, string> = { cost_per_result: "Cost per result", roas: "ROAS", ctr: "Link CTR", cpm: "CPM", conversion_rate: "Conversion rate" };
const fmt = (unit: string, v: number | null) => (v == null ? "—" : unit === "$" ? `$${v.toLocaleString("en-US", { maximumFractionDigits: v < 10 ? 2 : 0 })}` : unit === "x" ? `${v}x` : `${v}${unit}`);

/**
 * One sub-vertical's playbook, read the way creative is reverse-engineered: who buys (pick an avatar), the angles that
 * land with them, and the ads that prove each one. `named` shows client and brand names (the team view); the share
 * link never does.
 */
export function PlaybookView({
  title,
  parent,
  playbook,
  examples,
  named,
  benchmarks = [],
  actions,
}: {
  title: string;
  parent: string | null;
  playbook: Playbook;
  examples: Map<string, Example>;
  named: boolean;
  benchmarks?: Bench[];
  actions?: React.ReactNode;
}) {
  const [pick, setPick] = useState(0);
  const s = playbook.sources;
  const avatar = playbook.avatars[pick] ?? playbook.avatars[0];
  const backdrop = [...examples.values()].map((e) => e.image).filter((x): x is string => Boolean(x)).slice(0, 8);
  const angleCount = playbook.avatars.reduce((n, a) => n + a.angles.length, 0);

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-14">
      {/* Hero: the creative behind it, softly, under the attack in one paragraph */}
      <header className="relative isolate overflow-hidden rounded-[28px] border border-line bg-surface">
        {backdrop.length > 0 && (
          <div aria-hidden className="absolute inset-0 -z-10 grid grid-cols-4 opacity-[0.16] md:grid-cols-8">
            {backdrop.map((src) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={src} src={src} alt="" className="h-full w-full object-cover" />
            ))}
          </div>
        )}
        <div aria-hidden className="absolute inset-0 -z-10 bg-gradient-to-b from-surface/70 via-surface/95 to-surface" />
        <div aria-hidden className="pointer-events-none absolute -right-32 -top-40 -z-10 h-[420px] w-[420px] rounded-full bg-brand/25 blur-[120px]" />
        <div className="grid gap-8 px-6 py-10 md:px-12 md:py-14">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <p className="text-xs uppercase tracking-[0.2em] text-faint">{parent ? `${parent} · Playbook` : "Playbook"}</p>
            {actions}
          </div>
          <div className="grid gap-5">
            <h1 className="max-w-4xl font-display text-4xl leading-[1.05] tracking-tight md:text-5xl">{title}</h1>
            <p className="max-w-3xl text-base leading-relaxed text-muted md:text-lg">{playbook.summary}</p>
          </div>
          <div className="grid gap-px overflow-hidden rounded-[16px] border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
            {[
              [playbook.avatars.length, playbook.avatars.length === 1 ? "avatar" : "avatars", "who buys"],
              [angleCount, "proven angles", "each backed by real ads"],
              ...benchmarks
                .filter((b) => b.good != null)
                .slice(0, 2)
                .map((b) => [fmt(b.unit, b.good), `${METRIC[b.metric] ?? b.metric} · good`, `great is ${fmt(b.unit, b.great)}`] as const),
            ].map(([n, label, sub]) => (
              <div key={String(label)} className="flex flex-col gap-1 bg-surface/90 px-5 py-4 backdrop-blur">
                <p className="font-display text-3xl tabular tracking-tight">{n}</p>
                <p className="text-xs text-muted">{label}</p>
                <p className="text-[11px] text-faint">{sub}</p>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-faint">
            Built from {s.clients} {s.clients === 1 ? "client strategy" : "client strategies"}, {s.fame} Hall of Fame {s.fame === 1 ? "ad" : "ads"} and {s.market} market{" "}
            {s.market === 1 ? "ad" : "ads"} live 30+ days
            {playbook.generatedAt ? ` · updated ${new Date(playbook.generatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}
          </p>
        </div>
      </header>

      {/* Who buys */}
      <section className="grid gap-6">
        <SectionTitle n="01" title="Who buys" sub="Pick an avatar to see the angles that land with them." />
        {/* Phones: the avatars swipe sideways, so the angles below stay close */}
        <div role="tablist" aria-label="Avatars" className="no-scrollbar -mx-4 flex snap-x gap-3 overflow-x-auto px-4 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 lg:grid-cols-4">
          {playbook.avatars.map((a, i) => (
            <button
              key={i}
              role="tab"
              type="button"
              aria-selected={i === pick}
              onClick={() => setPick(i)}
              className={`group grid w-[78%] shrink-0 snap-start content-start gap-2 rounded-[18px] border p-5 text-left transition-all duration-300 sm:w-auto ${
                i === pick ? "border-brand/60 bg-brand-soft shadow-[0_0_0_1px_var(--brand)_inset]" : "border-line bg-surface hover:-translate-y-0.5 hover:border-fg/20"
              }`}
            >
              <span className={`font-display text-sm tabular ${i === pick ? "text-brand-text" : "text-faint"}`}>{String(i + 1).padStart(2, "0")}</span>
              <span className="font-heading text-lg leading-tight">{a.name}</span>
              <span className="line-clamp-3 text-xs leading-relaxed text-muted">{a.who}</span>
              <span className="text-[11px] text-faint">
                {a.angles.length} {a.angles.length === 1 ? "angle" : "angles"}
              </span>
            </button>
          ))}
        </div>

        {avatar && (
          <div key={pick} className="grid animate-[step-in_.35s_ease] gap-px overflow-hidden rounded-[20px] border border-line bg-line md:grid-cols-3">
            {(
              [
                ["Pains", avatar.pains],
                ["What makes them act now", avatar.triggers],
                ["What stops them", avatar.objections],
              ] as const
            ).map(([label, items]) => (
              <div key={label} className="grid content-start gap-3 bg-surface p-6">
                <p className="text-[10px] uppercase tracking-[0.16em] text-faint">{label}</p>
                <ol className="grid gap-2.5">
                  {items.map((x, i) => (
                    <li key={i} className="grid grid-cols-[18px_minmax(0,1fr)] gap-2 text-sm leading-snug">
                      <span className="pt-0.5 text-[10px] tabular text-faint">{i + 1}</span>
                      <span>{x}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* The angles for that avatar */}
      {avatar && (
        <section key={`angles-${pick}`} className="grid gap-6">
          <SectionTitle n="02" title={`What lands with ${avatar.name}`} sub="Each angle with the hook that opens it, why it works, and the ads that prove it." />
          <div className="grid gap-5">
            {avatar.angles.map((g, j) => (
              <article key={j} className="grid min-w-0 gap-6 overflow-hidden rounded-[22px] border border-line bg-surface p-5 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] md:p-8">
                <div className="grid content-start gap-4">
                  <p className="text-[10px] uppercase tracking-[0.16em] text-faint">
                    Angle {j + 1} · {g.name}
                  </p>
                  <p className="font-heading text-xl leading-snug md:text-2xl">
                    <span className="text-brand-text">&ldquo;</span>
                    {g.hook}
                    <span className="text-brand-text">&rdquo;</span>
                  </p>
                  <p className="text-sm leading-relaxed text-muted">{g.why}</p>
                  <p className="text-[11px] text-faint">
                    Proven by {g.examples.filter((x) => x.kind === "fame").length} of our ads
                    {g.examples.some((x) => x.kind === "market") ? `, backed by ${g.examples.filter((x) => x.kind === "market").length} in the market` : ""}
                  </p>
                </div>
                <div className="-mx-2 flex snap-x gap-3 overflow-x-auto px-2 pb-2 [scrollbar-width:thin]">
                  {g.examples.map((r) => {
                    const e = examples.get(`${r.kind}:${r.id}`);
                    return e ? <ExampleCard key={`${r.kind}:${r.id}`} e={e} named={named} /> : null;
                  })}
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {playbook.watchouts.length > 0 && (
        <section className="grid gap-6">
          <SectionTitle n="03" title="Watch out" sub="What doesn't work here, and what to stay clear of." />
          <ul className="grid gap-px overflow-hidden rounded-[20px] border border-bad/25 bg-bad/20 md:grid-cols-2">
            {playbook.watchouts.map((w, i) => (
              <li key={i} className="flex gap-3 bg-surface p-5 text-sm leading-relaxed text-muted">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-bad" />
                {w}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function SectionTitle({ n, title, sub }: { n: string; title: string; sub: string }) {
  return (
    <div className="grid gap-1 border-b border-line pb-4">
      <p className="font-display text-sm tabular text-brand-text">{n}</p>
      <h2 className="font-heading text-2xl md:text-[26px]">{title}</h2>
      <p className="text-sm text-muted">{sub}</p>
    </div>
  );
}

/** An ad as a phone-sized card; a video plays while hovered. */
function ExampleCard({ e, named }: { e: Example; named: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const body = (
    <>
      <div className="relative aspect-[4/5] overflow-hidden rounded-[14px] bg-bg ring-1 ring-line">
        {e.video ? (
          <video ref={video} src={e.video} poster={e.image ?? undefined} muted loop playsInline preload="none" className="h-full w-full object-cover" />
        ) : e.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={e.image} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
        ) : (
          <div className="grid h-full place-items-center p-4 text-center text-xs text-faint">{e.headline ?? "No preview"}</div>
        )}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-3 pb-2.5 pt-10">
          <p className="text-[11px] font-medium leading-snug text-white">{e.result}</p>
        </div>
        <span className={`absolute left-2 top-2 rounded-full px-2 py-0.5 text-[10px] font-medium backdrop-blur ${e.kind === "fame" ? "bg-brand text-white" : "bg-black/60 text-white"}`}>
          {e.kind === "fame" ? "Our winner" : "Market"}
        </span>
        {e.video && <span className="absolute right-2 top-2 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] text-white backdrop-blur">▶</span>}
      </div>
      <div className="grid gap-0.5 px-0.5">
        {e.headline && <p className="line-clamp-2 text-[12px] font-medium leading-snug">{e.headline}</p>}
        {named && e.name && <p className="truncate text-[11px] text-faint">{e.name}</p>}
      </div>
    </>
  );
  const cls = "group grid w-[180px] shrink-0 snap-start content-start gap-2";
  const hover = {
    onMouseEnter: () => void video.current?.play().catch(() => null),
    onMouseLeave: () => video.current?.pause(),
  };
  return named && e.href ? (
    <a href={e.href} target={e.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer" className={cls} {...hover}>
      {body}
    </a>
  ) : (
    <div className={cls} {...hover}>
      {body}
    </div>
  );
}
