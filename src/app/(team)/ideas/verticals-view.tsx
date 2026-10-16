import Link from "next/link";
import type { Benchmark, Vertical } from "@/lib/verticals";
import { RebuildVerticals } from "./rebuild-verticals";

export type SubCard = {
  clients: { id: string; name: string; slug: string; why: string | null }[];
  brands: number;
  fame: number;
  market: number;
  thumbs: string[];
  playbook: { summary: string; avatars: string[]; angles: number } | null;
};

const money = (v: number) => `$${v.toLocaleString("en-US", { maximumFractionDigits: v < 10 ? 2 : 0 })}`;
/** The one number that says what good looks like here: ROAS, or cost per result. */
function headline(bm: Benchmark[]) {
  const b = bm.find((x) => x.metric === "roas" && x.good != null) ?? bm.find((x) => x.metric === "cost_per_result" && x.good != null);
  if (!b) return null;
  const f = (v: number | null) => (v == null ? "—" : b.unit === "x" ? `${v}x` : b.unit === "$" ? money(v) : `${v}${b.unit}`);
  return { label: b.metric === "roas" ? "ROAS" : "Cost per result", good: f(b.good), great: f(b.great) };
}
const initials = (n: string) =>
  n
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

/**
 * The markets the paid ads team serves, as the AI reads them from our paid clients: each sub-vertical as a card with
 * the creative that proves it, its avatars, what good looks like, and the door to its playbook.
 */
export function VerticalsView({
  verticals,
  cards,
  unplaced,
  totals,
  canRebuild,
}: {
  verticals: Vertical[];
  cards: Map<string, SubCard>;
  unplaced: { id: string; name: string }[];
  totals: { clients: number; fame: number; market: number; playbooks: number };
  canRebuild: boolean;
}) {
  // Only sub-verticals with a paid client or market brands in them
  const has = (id: string) => (cards.get(id)?.clients.length ?? 0) > 0 || (cards.get(id)?.brands ?? 0) > 0;
  const shown = verticals.map((v) => ({ ...v, subs: v.subs.filter((s) => has(s.id)) })).filter((v) => v.subs.length);
  if (!shown.length)
    return (
      <div className="mx-auto grid max-w-6xl place-items-center gap-3 rounded-[20px] border border-dashed border-line px-6 py-20 text-center">
        <p className="font-heading text-lg">Working out the verticals</p>
        <p className="max-w-md text-sm text-muted">
          The AI reads every paid ads client page (intake, Brand Bible, strategy) and sorts them into verticals and sub-verticals. It runs every hour until it&apos;s done.
        </p>
        {canRebuild && <RebuildVerticals />}
      </div>
    );
  const subCount = shown.reduce((n, v) => n + v.subs.length, 0);

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-12">
      <header className="relative grid gap-8 overflow-hidden rounded-[28px] border border-line bg-surface px-6 py-10 md:px-10 md:py-12">
        <div aria-hidden className="pointer-events-none absolute -right-24 -top-32 h-[380px] w-[380px] rounded-full bg-brand/20 blur-[110px]" />
        <div aria-hidden className="pointer-events-none absolute -bottom-40 left-1/3 h-[300px] w-[300px] rounded-full bg-brand/10 blur-[120px]" />
        <div className="relative grid gap-3">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <p className="text-xs uppercase tracking-[0.2em] text-faint">Verticals · paid ads clients</p>
            {canRebuild && <RebuildVerticals />}
          </div>
          <h1 className="font-display text-4xl tracking-tight md:text-6xl">The markets we win in</h1>
          <p className="max-w-2xl text-[15px] leading-relaxed text-muted">
            Every paid ads client, sorted by how they sell and to whom. Each sub-vertical has a playbook: who buys, the angles that land with them, and the ads that prove it.
          </p>
        </div>
        <dl className="relative grid grid-cols-2 gap-px overflow-hidden rounded-[16px] border border-line bg-line md:grid-cols-4">
          {(
            [
              [subCount, "sub-verticals", `across ${shown.length} verticals`],
              [totals.clients, "paid clients", "placed by the AI"],
              [totals.fame, "Hall of Fame ads", "beat their target 30+ days"],
              [totals.playbooks, "playbooks", `from ${totals.market.toLocaleString("en-US")} market ads live 30+ days`],
            ] as const
          ).map(([n, label, sub]) => (
            <div key={label} className="flex flex-col gap-1 bg-surface px-5 py-4">
              <dd className="font-display text-3xl tabular tracking-tight">{n.toLocaleString("en-US")}</dd>
              <dt className="text-xs text-muted">{label}</dt>
              <p className="text-[11px] text-faint">{sub}</p>
            </div>
          ))}
        </dl>
        <nav className="relative flex flex-wrap gap-1.5" aria-label="Verticals">
          {shown.map((v) => (
            <a key={v.id} href={`#v-${v.slug}`} className="rounded-full border border-line bg-bg/60 px-3 py-1.5 text-xs text-muted backdrop-blur transition-colors hover:border-fg/30 hover:text-fg">
              {v.name} <span className="text-faint">{v.subs.length}</span>
            </a>
          ))}
        </nav>
      </header>

      {shown.map((v) => (
        <section key={v.id} id={`v-${v.slug}`} className="grid scroll-mt-8 gap-5">
          <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line pb-4">
            <div className="grid gap-1">
              <h2 className="font-display text-2xl tracking-tight md:text-3xl">{v.name}</h2>
              {v.description && <p className="max-w-2xl text-sm text-muted">{v.description}</p>}
            </div>
            <p className="text-xs text-faint">
              {v.subs.reduce((n, s) => n + (cards.get(s.id)?.clients.length ?? 0), 0)} clients · {v.subs.length} sub-verticals
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {v.subs.map((s) => (
              <SubVerticalCard key={s.id} sub={s} card={cards.get(s.id)!} />
            ))}
          </div>
        </section>
      ))}

      {unplaced.length > 0 && <p className="text-xs text-faint">Still being placed: {unplaced.map((c) => c.name).join(", ")}.</p>}
    </div>
  );
}

function SubVerticalCard({ sub, card }: { sub: Vertical["subs"][number]; card: SubCard }) {
  const bm = headline(sub.benchmarks);
  const pb = card.playbook;
  const thumbs = card.thumbs.slice(0, 3);
  return (
    <Link
      href={`/ideas/playbook/${sub.id}`}
      className="group relative grid content-start overflow-hidden rounded-[22px] border border-line bg-surface transition-all duration-300 hover:-translate-y-1 hover:border-fg/20 hover:shadow-[0_24px_60px_-30px_rgba(0,0,0,0.8)]"
    >
      {/* The creative that proves it, or a quiet gradient until there is some */}
      <div className="relative aspect-[16/10] overflow-hidden bg-bg">
        {thumbs.length ? (
          <div className={`grid h-full gap-px ${thumbs.length === 1 ? "grid-cols-1" : thumbs.length === 2 ? "grid-cols-2" : "grid-cols-[1.4fr_1fr] grid-rows-2"}`}>
            {thumbs.map((t, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={t}
                src={t}
                alt=""
                loading="lazy"
                className={`h-full w-full object-cover transition-transform duration-700 group-hover:scale-[1.04] ${thumbs.length === 3 && i === 0 ? "row-span-2" : ""}`}
              />
            ))}
          </div>
        ) : (
          <div className="absolute inset-0 bg-[radial-gradient(120%_90%_at_10%_0%,var(--brand-soft),transparent_60%),radial-gradient(90%_80%_at_100%_100%,rgba(255,255,255,0.05),transparent_60%)]">
            <p className="absolute right-5 top-3 font-display text-[88px] leading-none tracking-tighter text-fg/[0.05]">{initials(sub.name)}</p>
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-surface via-surface/30 to-transparent" />
        <div className="absolute left-3 top-3 flex gap-1.5">
          {card.fame > 0 && <span className="rounded-full bg-bg/80 px-2 py-0.5 text-[10px] font-medium backdrop-blur">{card.fame} ours</span>}
          {card.market > 0 && <span className="rounded-full bg-bg/80 px-2 py-0.5 text-[10px] text-muted backdrop-blur">{card.market} market</span>}
        </div>
        <div className="absolute inset-x-5 bottom-3">
          <h3 className="font-heading text-xl leading-tight">{sub.name}</h3>
          {sub.conversion && <p className="text-[11px] text-muted">A result is a {sub.conversion}</p>}
        </div>
      </div>

      <div className="grid gap-4 px-5 pb-5 pt-3">
        {pb ? (
          <>
            <p className="line-clamp-2 text-[13px] leading-relaxed text-muted">{pb.summary}</p>
            <div className="flex flex-wrap gap-1.5">
              {pb.avatars.slice(0, 3).map((a) => (
                <span key={a} className="rounded-full border border-line px-2.5 py-1 text-[11px]">
                  {a}
                </span>
              ))}
            </div>
          </>
        ) : (
          <div className="grid gap-2" aria-label="Playbook being written">
            <div className="h-2.5 w-11/12 animate-pulse rounded-full bg-line/70" />
            <div className="h-2.5 w-2/3 animate-pulse rounded-full bg-line/50" />
            <p className="line-clamp-2 text-[11px] text-faint">{sub.description ?? "The playbook is being written."}</p>
          </div>
        )}

        {bm ? (
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[12px] border border-line bg-line text-center">
            <div className="bg-bg px-3 py-2">
              <p className="text-[10px] uppercase tracking-[0.12em] text-faint">{bm.label} · good</p>
              <p className="tabular text-sm">{bm.good}</p>
            </div>
            <div className="bg-bg px-3 py-2">
              <p className="text-[10px] uppercase tracking-[0.12em] text-faint">Great</p>
              <p className="tabular text-sm text-ok">{bm.great}</p>
            </div>
          </div>
        ) : (
          <p className="text-[11px] text-faint">Benchmarks being researched</p>
        )}

        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center">
            <div className="flex -space-x-2">
              {card.clients.slice(0, 5).map((c) => (
                <span key={c.id} title={c.name} className="grid h-7 w-7 place-items-center rounded-full border-2 border-surface bg-surface-2 text-[9px] font-medium text-muted">
                  {initials(c.name)}
                </span>
              ))}
            </div>
            <span className="ml-2 text-[11px] text-faint">
              {card.clients.length} {card.clients.length === 1 ? "client" : "clients"}
            </span>
          </div>
          <span className="flex shrink-0 items-center gap-1 text-xs font-medium transition-transform group-hover:translate-x-0.5">
            {pb ? `${pb.angles} proven angles` : "Playbook"} <span aria-hidden>→</span>
          </span>
        </div>
      </div>
    </Link>
  );
}
