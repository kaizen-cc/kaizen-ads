import Link from "next/link";
import type { Benchmark, Vertical } from "@/lib/verticals";

const METRIC: Record<string, string> = { cost_per_result: "Cost per result", roas: "ROAS", ctr: "Link CTR", cpm: "CPM", conversion_rate: "Conversion rate" };
const fmt = (b: Benchmark, v: number | null) => (v == null ? "—" : b.unit === "$" ? `$${v.toLocaleString("en-US", { maximumFractionDigits: v < 10 ? 2 : 0 })}` : b.unit === "x" ? `${v}x` : `${v}${b.unit}`);

/**
 * The verticals we serve, as the AI reads them from our clients: each sub-vertical with its clients, its market
 * brands, and researched Meta benchmarks (what good and great look like, with sources).
 */
export function VerticalsView({
  verticals,
  clients,
  brands,
}: {
  verticals: Vertical[];
  clients: { id: string; name: string; slug: string; verticalId: string | null; why: string | null }[];
  brands: Map<string, number>;
}) {
  if (!verticals.length)
    return (
      <div className="mx-auto grid max-w-6xl place-items-center gap-2 rounded-[16px] border border-dashed border-line px-6 py-16 text-center">
        <p className="font-medium">Working out the verticals</p>
        <p className="max-w-md text-sm text-muted">The AI reads every client page (intake, briefs, Brand Bible, strategy) and sorts them into verticals and sub-verticals. It runs every hour until it&apos;s done.</p>
      </div>
    );
  const unplaced = clients.filter((c) => !c.verticalId);
  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <header className="grid gap-2">
        <p className="text-xs uppercase tracking-[0.18em] text-faint">Verticals</p>
        <h1 className="font-display text-3xl tracking-tight md:text-4xl">The markets we serve</h1>
        <p className="max-w-2xl text-sm text-muted">
          Worked out from every client page, by how each business sells and to whom. Each sub-vertical carries researched Meta benchmarks; they set what counts as a
          winner for clients without their own KPI target.
        </p>
      </header>
      {verticals.map((v) => (
        <section key={v.id} className="grid gap-3">
          <div>
            <h2 className="font-heading text-xl">{v.name}</h2>
            {v.description && <p className="text-sm text-muted">{v.description}</p>}
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {v.subs.map((s) => {
              const mine = clients.filter((c) => c.verticalId === s.id);
              return (
                <article key={s.id} className="grid content-start gap-3 rounded-[16px] border border-line bg-surface p-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-heading text-[16px]">{s.name}</p>
                    <span className="text-[11px] text-faint">
                      {mine.length} {mine.length === 1 ? "client" : "clients"} · {brands.get(s.id) ?? 0} market brands{s.conversion ? ` · a result is a ${s.conversion}` : ""}
                    </span>
                  </div>
                  {s.description && <p className="text-xs leading-relaxed text-muted">{s.description}</p>}
                  {mine.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {mine.map((c) => (
                        <Link key={c.id} href={`/clients/${c.slug}`} title={c.why ?? undefined} className="rounded-full border border-line px-2.5 py-1 text-[11px] text-muted hover:text-fg">
                          {c.name}
                        </Link>
                      ))}
                    </div>
                  )}
                  {s.benchmarks.length > 0 ? (
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-[10px] uppercase tracking-[0.12em] text-faint">
                          <th className="py-1 font-medium">Benchmark</th>
                          <th className="py-1 font-medium">Good</th>
                          <th className="py-1 font-medium">Great</th>
                          <th className="py-1 font-medium">Source</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {s.benchmarks.map((b, i) => (
                          <tr key={i} title={b.note}>
                            <td className="py-1.5 text-muted">{METRIC[b.metric] ?? b.metric}</td>
                            <td className="tabular py-1.5">{fmt(b, b.good)}</td>
                            <td className="tabular py-1.5 text-ok">{fmt(b, b.great)}</td>
                            <td className="max-w-[140px] truncate py-1.5">
                              {/^https?:/.test(b.source) ? (
                                <a href={b.source} target="_blank" rel="noreferrer" className="text-faint hover:text-fg">
                                  {new URL(b.source).hostname.replace(/^www\./, "")} {b.year}
                                </a>
                              ) : (
                                <span className="text-faint">
                                  {b.source} {b.year}
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="text-[11px] text-faint">Benchmarks are being researched.</p>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      ))}
      {unplaced.length > 0 && <p className="text-xs text-faint">Still being placed: {unplaced.map((c) => c.name).join(", ")}.</p>}
    </div>
  );
}
