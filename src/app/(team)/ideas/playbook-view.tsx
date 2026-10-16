import type { Playbook } from "@/lib/playbooks";

export type Example = { kind: "fame" | "market"; image: string | null; video: string | null; headline: string | null; result: string; name: string; href: string | null };

/**
 * One sub-vertical's playbook, read top down the way creative is reverse-engineered: who buys, the angles that land
 * with each, and the ads that prove them. `named` shows client and brand names (the team view); the share link never does.
 */
export function PlaybookView({
  title,
  parent,
  playbook,
  examples,
  named,
  benchmarks,
  actions,
}: {
  title: string;
  parent: string | null;
  playbook: Playbook;
  examples: Map<string, Example>;
  named: boolean;
  benchmarks?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const s = playbook.sources;
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-10">
      <header className="grid gap-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="grid gap-2">
            <p className="text-xs uppercase tracking-[0.18em] text-faint">{parent ? `${parent} · playbook` : "Playbook"}</p>
            <h1 className="font-display text-3xl tracking-tight md:text-5xl">{title}</h1>
          </div>
          {actions}
        </div>
        <p className="max-w-3xl text-[15px] leading-relaxed text-muted">{playbook.summary}</p>
        <p className="text-[11px] text-faint">
          Built from {s.clients} {s.clients === 1 ? "client strategy" : "client strategies"}, {s.fame} Hall of Fame {s.fame === 1 ? "ad" : "ads"} and {s.market} market{" "}
          {s.market === 1 ? "ad" : "ads"} live 30+ days
          {playbook.generatedAt ? ` · updated ${new Date(playbook.generatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}
        </p>
        {benchmarks}
      </header>

      {playbook.avatars.map((a, i) => (
        <section key={i} className="grid gap-5">
          <div className="grid gap-3 rounded-[20px] border border-line bg-surface p-6 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] md:gap-8">
            <div className="grid content-start gap-2">
              <p className="text-[11px] uppercase tracking-[0.16em] text-faint">Avatar {i + 1}</p>
              <h2 className="font-heading text-2xl">{a.name}</h2>
              <p className="text-sm leading-relaxed text-muted">{a.who}</p>
            </div>
            <dl className="grid content-start gap-3 text-[13px]">
              {(
                [
                  ["Pains", a.pains],
                  ["What makes them act", a.triggers],
                  ["Objections", a.objections],
                ] as const
              ).map(([label, items]) =>
                items.length ? (
                  <div key={label} className="grid gap-1">
                    <dt className="text-[10px] uppercase tracking-[0.14em] text-faint">{label}</dt>
                    <dd className="leading-relaxed">{items.join(" · ")}</dd>
                  </div>
                ) : null,
              )}
            </dl>
          </div>

          <div className="grid gap-4 md:pl-6">
            {a.angles.map((g, j) => (
              <article key={j} className="grid gap-4 border-l border-line pl-5">
                <div className="grid gap-1">
                  <p className="text-[11px] uppercase tracking-[0.14em] text-faint">Angle</p>
                  <h3 className="font-heading text-lg">{g.name}</h3>
                  <p className="font-display text-xl leading-snug tracking-tight">&ldquo;{g.hook}&rdquo;</p>
                  <p className="max-w-2xl text-sm leading-relaxed text-muted">{g.why}</p>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {g.examples.map((r) => {
                    const e = examples.get(`${r.kind}:${r.id}`);
                    return e ? <ExampleCard key={`${r.kind}:${r.id}`} e={e} named={named} /> : null;
                  })}
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}

      {playbook.watchouts.length > 0 && (
        <section className="grid gap-2 rounded-[20px] border border-line p-6">
          <p className="text-[11px] uppercase tracking-[0.16em] text-faint">Watch out</p>
          <ul className="grid gap-1.5 text-sm leading-relaxed text-muted">
            {playbook.watchouts.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ExampleCard({ e, named }: { e: Example; named: boolean }) {
  const body = (
    <>
      <div className="relative aspect-[4/5] overflow-hidden rounded-[12px] bg-line/40">
        {e.video ? (
          <video src={e.video} poster={e.image ?? undefined} muted loop playsInline autoPlay className="h-full w-full object-cover" />
        ) : e.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={e.image} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : null}
        <span className="absolute left-2 top-2 rounded-full bg-bg/85 px-2 py-0.5 text-[10px] font-medium backdrop-blur">{e.kind === "fame" ? "Ours" : "Market"}</span>
      </div>
      <div className="grid gap-0.5 px-0.5">
        {e.headline && <p className="line-clamp-2 text-[12px] font-medium leading-snug">{e.headline}</p>}
        <p className="text-[11px] text-muted">{e.result}</p>
        {named && e.name && <p className="truncate text-[11px] text-faint">{e.name}</p>}
      </div>
    </>
  );
  return named && e.href ? (
    <a href={e.href} target={e.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer" className="grid content-start gap-2 transition-opacity hover:opacity-85">
      {body}
    </a>
  ) : (
    <div className="grid content-start gap-2">{body}</div>
  );
}

const METRIC: Record<string, string> = { cost_per_result: "Cost per result", roas: "ROAS", ctr: "Link CTR", cpm: "CPM", conversion_rate: "Conversion rate" };
const fmt = (unit: string, v: number | null) => (v == null ? "—" : unit === "$" ? `$${v.toLocaleString("en-US", { maximumFractionDigits: v < 10 ? 2 : 0 })}` : unit === "x" ? `${v}x` : `${v}${unit}`);

/** The sub-vertical's researched Meta benchmarks, as a quiet strip. */
export function BenchmarkStrip({ benchmarks }: { benchmarks: { metric: string; good: number | null; great: number | null; unit: string }[] }) {
  if (!benchmarks.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {benchmarks.map((b, i) => (
        <span key={i} className="rounded-full border border-line px-3 py-1 text-[11px] text-muted">
          {METRIC[b.metric] ?? b.metric} <span className="tabular text-fg">{fmt(b.unit, b.good)}</span> good · <span className="tabular text-ok">{fmt(b.unit, b.great)}</span> great
        </span>
      ))}
    </div>
  );
}
