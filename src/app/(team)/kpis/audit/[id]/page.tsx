import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import type { AuditResult } from "@/lib/audit";
import { conversionFor, conversionLabel } from "@/lib/kpi/conversions";
import { kpiValue } from "@/lib/kpi/format";
import { createClient } from "@/lib/supabase/server";
import { VERDICT } from "../../audit-panel";
import { ActionCard, RerunAudit } from "./audit-parts";

export const metadata: Metadata = { title: "Account audit" };
export const maxDuration = 800;

const AREA: Record<string, string> = {
  creative: "Creative",
  audience: "Audience",
  offer: "Offer",
  funnel: "Funnel",
  landing_page: "Landing page",
  structure: "Structure",
  budget: "Budget",
  bidding: "Bidding",
  tracking: "Tracking",
  seasonality: "Seasonality",
};
const SEV: Record<string, string> = { high: "border-l-bad", medium: "border-l-warn", low: "border-l-line" };
const WHEN: [string, string, string][] = [
  ["now", "Today", "Do these before anything else"],
  ["this_week", "This week", "Once today's changes are in"],
  ["next", "Next", "After the tests read out"],
];
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

/** One account audit in full: the verdict, why, the action plan the buyer ticks off, tests, creative, budget, and what to ask. */
export default async function AuditPage({ params }: PageProps<"/kpis/audit/[id]">) {
  const { id } = await params;
  await requireStaff();
  const supabase = await createClient();
  const { data: a } = await supabase
    .from("account_audits")
    .select("id, target_id, client_id, status, result, done, inputs, steps, created_at, error, profiles(full_name), clients(name, slug), kpi_targets(conversion, custom_action, target, label)")
    .eq("id", id)
    .maybeSingle();
  if (!a) notFound();
  const client = a.clients as unknown as { name: string; slug: string };
  const t = a.kpi_targets as unknown as { conversion: string; custom_action: string | null; target: number | null; label: string | null };
  const [{ data: snap }, { data: history }] = await Promise.all([
    supabase.from("kpi_snapshots").select("windows, deviation").eq("target_id", a.target_id).maybeSingle(),
    supabase.from("account_audits").select("id, created_at, status, result").eq("target_id", a.target_id).order("created_at", { ascending: false }).limit(10),
  ]);
  const back = (
    <Link href="/kpis" className="text-sm text-muted hover:text-fg">
      ← KPIs
    </Link>
  );
  const r = a.result as AuditResult | null;
  if (a.status !== "ready" || !r)
    return (
      <div className="mx-auto grid max-w-6xl gap-6">
        {back}
        <div className="grid place-items-center gap-3 rounded-[20px] border border-dashed border-line px-6 py-20 text-center">
          <p className="font-heading text-lg">{a.status === "running" ? "This audit is still running" : "This audit didn't finish"}</p>
          <p className="max-w-md text-sm text-muted">{a.status === "running" ? "Follow it on the KPI board; it opens here when it's done." : a.error}</p>
          <RerunAudit targetId={a.target_id} />
        </div>
      </div>
    );

  const roas = Boolean(conversionFor(t.conversion).roas);
  const d14 = (snap?.windows as { d14?: { value: number | null } } | null)?.d14?.value ?? null;
  const done = (a.done ?? {}) as Record<string, { by: string; at: string }>;
  const v = VERDICT[r.verdict.status] ?? VERDICT.at_risk;
  const inputs = (a.inputs ?? {}) as Record<string, number | boolean | null>;
  const deviation = snap?.deviation == null ? null : Math.round(Number(snap.deviation) * 100);

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-14 pb-16">
      {back}

      {/* The verdict */}
      <header className="relative isolate overflow-hidden rounded-[28px] border border-line bg-surface">
        <div aria-hidden className={`pointer-events-none absolute -right-32 -top-40 -z-10 h-[420px] w-[420px] rounded-full blur-[120px] ${r.verdict.status === "off" ? "bg-bad/25" : r.verdict.status === "at_risk" ? "bg-warn/20" : "bg-ok/20"}`} />
        <div className="grid gap-8 px-6 py-10 md:px-12 md:py-14">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs uppercase tracking-[0.2em] text-faint">
              Account audit · {client.name}
              {t.label ? ` · ${t.label}` : ""} · {when(a.created_at)}
            </p>
            <div className="flex items-center gap-2">
              <span className={`rounded-full border px-3 py-1 text-xs font-medium ${v.ring} ${v.tone}`}>{v.label}</span>
              <RerunAudit targetId={a.target_id} quiet />
            </div>
          </div>
          <div className="grid gap-5">
            <h1 className="max-w-4xl font-display text-3xl leading-[1.05] tracking-tight md:text-6xl">{r.verdict.headline}</h1>
            <p className="max-w-3xl text-base leading-relaxed text-muted md:text-lg">{r.verdict.summary}</p>
          </div>
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[16px] border border-line bg-line md:grid-cols-4">
            {[
              [kpiValue(t.target, roas), `Target · ${conversionLabel(t.conversion, t.custom_action)}`],
              [kpiValue(d14, roas), deviation == null ? "Last 14 days" : `Last 14 days · ${Math.abs(deviation)}% ${deviation > 0 ? "worse" : "better"}`],
              [String(r.causes.length), "Root causes found"],
              [`${Object.keys(done).length}/${r.actions.length}`, "Actions done"],
            ].map(([n, label]) => (
              <div key={label} className="flex flex-col gap-1 bg-surface/90 px-5 py-4">
                <dd className="font-display text-3xl tabular tracking-tight">{n}</dd>
                <dt className="text-xs text-muted">{label}</dt>
              </div>
            ))}
          </dl>
        </div>
      </header>

      <Section n="01" title="Here's what I found" sub="Why the numbers are where they are against the KPI.">
        <div className="grid gap-4 rounded-[20px] border border-line bg-surface p-6 text-[15px] leading-relaxed md:p-8">
          {r.diagnosis
            .split(/\n+/)
            .filter(Boolean)
            .map((p, i) => (
              <p key={i} className={i === 0 ? "text-fg" : "text-muted"}>
                {p}
              </p>
            ))}
        </div>
        <Sub title="What's behind it" sub="The root causes, most important first, with the numbers.">
          <div className="grid gap-3 md:grid-cols-2">
            {r.causes.map((c, i) => (
              <article key={i} className={`grid content-start gap-3 rounded-[16px] border border-l-4 border-line bg-surface p-5 ${SEV[c.severity]}`}>
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  <span className="font-display text-sm tabular text-faint">{String(i + 1).padStart(2, "0")}</span>
                  <span className="rounded-full border border-line px-2 py-0.5 text-muted">{AREA[c.area] ?? c.area}</span>
                  <span className={c.severity === "high" ? "text-bad" : c.severity === "medium" ? "text-warn" : "text-faint"}>{c.severity} impact</span>
                  <span className="text-faint">· {c.confidence} confidence</span>
                </div>
                <h3 className="font-heading text-lg leading-snug">{c.title}</h3>
                <ul className="grid gap-1.5 text-[13px] leading-relaxed text-muted">
                  {c.evidence.map((e, j) => (
                    <li key={j} className="flex gap-2">
                      <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-faint" />
                      {e}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </Sub>
        {r.tracking.length > 0 && (
          <Panel title="Tracking and data to check first" tone="warn">
            <List items={r.tracking} />
          </Panel>
        )}
      </Section>

      <Section n="02" title="What I'd do if I were you" sub="Tick each move off as it's done; the KPI board shows how far along the plan is.">
        <div className="grid gap-6 lg:grid-cols-3">
          {WHEN.map(([key, label, hint]) => {
            const items = r.actions.map((x, i) => ({ x, i })).filter(({ x }) => x.when === key);
            return (
              <div key={key} className="grid content-start gap-3">
                <div className="flex items-baseline justify-between gap-2 border-b border-line pb-2">
                  <p className="font-heading">{label}</p>
                  <p className="text-[11px] text-faint">{items.length ? hint : "Nothing here"}</p>
                </div>
                {items.map(({ x, i }) => (
                  <ActionCard key={i} auditId={a.id} index={i} action={x} area={AREA[x.area] ?? x.area} done={done[String(i)] ?? null} />
                ))}
              </div>
            );
          })}
        </div>

        <Panel title="The budget call">
          <p className="text-sm leading-relaxed">{r.budget.call}</p>
          {r.budget.moves.length > 0 && <List items={r.budget.moves} />}
        </Panel>

        {r.tests.length > 0 && (
          <Sub title="Tests I'd run" sub="Each one set up to read out at this account's spend.">
            <div className="grid gap-3 md:grid-cols-2">
              {r.tests.map((x, i) => (
                <article key={i} className="grid content-start gap-3 rounded-[18px] border border-line bg-surface p-6">
                  <p className="text-[10px] uppercase tracking-[0.16em] text-faint">Test {i + 1}</p>
                  <h3 className="font-heading text-lg leading-snug">{x.name}</h3>
                  <p className="text-sm leading-relaxed">
                    <span className="text-faint">If </span>
                    {x.hypothesis}
                  </p>
                  <dl className="grid gap-2 text-[13px]">
                    {(
                      [
                        ["Set up", x.setup],
                        ["Measure", x.metric],
                        ["It worked if", x.success],
                      ] as const
                    ).map(([k, val]) => (
                      <div key={k} className="grid grid-cols-[96px_minmax(0,1fr)] gap-3">
                        <dt className="text-faint">{k}</dt>
                        <dd className="leading-relaxed text-muted">{val}</dd>
                      </div>
                    ))}
                  </dl>
                  <div className="flex flex-wrap gap-2 text-[11px]">
                    <span className="rounded-full bg-bg px-2.5 py-1 text-muted">{x.budget}</span>
                    <span className="rounded-full bg-bg px-2.5 py-1 text-muted">{x.duration}</span>
                  </div>
                </article>
              ))}
            </div>
          </Sub>
        )}

        {r.creative.length > 0 && (
          <Sub title="Creative I'd make" sub="From the playbook's proven angles, our Hall of Fame and the Brand Bible.">
            <div className="grid gap-3 md:grid-cols-2">
              {r.creative.map((c, i) => (
                <article key={i} className="grid content-start gap-3 rounded-[18px] border border-line bg-surface p-6">
                  <div className="flex flex-wrap gap-2 text-[11px]">
                    <span className="rounded-full border border-line px-2 py-0.5 text-muted">{c.angle}</span>
                    <span className="rounded-full border border-line px-2 py-0.5 text-muted">{c.format}</span>
                  </div>
                  <p className="font-heading text-lg leading-snug">{c.concept}</p>
                  <p className="font-display text-xl leading-snug tracking-tight">
                    <span className="text-brand-text">&ldquo;</span>
                    {c.hook}
                    <span className="text-brand-text">&rdquo;</span>
                  </p>
                  <p className="text-sm leading-relaxed text-muted">{c.why}</p>
                  <Link href={`/requests/new?client=${client.slug}`} className="justify-self-start text-sm font-medium hover:underline">
                    Start a request for {client.name} →
                  </Link>
                </article>
              ))}
            </div>
          </Sub>
        )}
      </Section>

      <Section n="03" title="What I'd watch out for" sub="What could mislead us in these results, what the changes could break, and what to keep an eye on.">
        {(r.watchouts ?? []).length > 0 && (
          <div className="grid gap-3 md:grid-cols-2">
            {(r.watchouts ?? []).map((w, i) => (
              <article key={i} className="grid content-start gap-2 rounded-[16px] border border-warn/30 bg-surface p-5">
                <h3 className="flex gap-2 font-heading leading-snug">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />
                  {w.title}
                </h3>
                <p className="pl-3.5 text-[13px] leading-relaxed text-muted">{w.why}</p>
              </article>
            ))}
          </div>
        )}
        <div className="grid gap-3 lg:grid-cols-2">
          <Panel title="Numbers to watch over the next 7 days">
            <List items={r.watch} />
          </Panel>
          {r.questions.length > 0 && (
            <Panel title="Ask the client">
              <List items={r.questions} numbered />
            </Panel>
          )}
        </div>
      </Section>

      <footer className="grid gap-4 border-t border-line pt-6 text-xs text-faint">
        {((a.steps ?? []) as { key: string; label: string; status: string; detail: string | null }[]).length > 0 && (
          <div className="grid gap-2">
            <p className="text-[10px] uppercase tracking-[0.16em]">How I got here</p>
            <ol className="grid gap-1.5">
              {((a.steps ?? []) as { key: string; label: string; status: string; detail: string | null }[]).map((st) => (
                <li key={st.key} className="grid gap-x-3 sm:grid-cols-[260px_minmax(0,1fr)]">
                  <span className="text-muted">
                    {st.status === "done" ? "✓" : st.status === "skipped" ? "–" : "×"} {st.label}
                  </span>
                  <span>{st.detail}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
        <p>
          Read {inputs.days ?? "?"} days and {inputs.ads ?? "?"} ads
          {inputs.liveSetup ? `, the live setup (${inputs.campaigns} campaigns, ${inputs.adsets} ad sets)` : ", (live setup not available)"}, {inputs.fatigue ?? 0} tiring ads
          {inputs.playbook ? ", the sub-vertical playbook" : ""}
          {inputs.benchmarks ? ", benchmarks" : ""}, {inputs.hallOfFame ?? 0} Hall of Fame ads{inputs.market ? ", the market" : ""}, and the client page. Run by{" "}
          {(a.profiles as unknown as { full_name: string } | null)?.full_name ?? "the team"}.
        </p>
        {(history ?? []).length > 1 && (
          <div className="flex flex-wrap gap-2">
            <span>Earlier audits:</span>
            {(history ?? [])
              .filter((h) => h.id !== a.id)
              .map((h) => (
                <Link key={h.id} href={`/kpis/audit/${h.id}`} className="rounded-full border border-line px-2.5 py-0.5 text-muted hover:text-fg">
                  {new Date(h.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })} · {h.status === "ready" ? (VERDICT[(h.result as AuditResult | null)?.verdict.status ?? ""]?.label ?? "ready") : h.status}
                </Link>
              ))}
          </div>
        )}
      </footer>
    </div>
  );
}

function Section({ n, title, sub, children }: { n: string; title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-6">
      <div className="grid gap-1 border-b border-line pb-4">
        <p className="font-display text-sm tabular text-brand-text">{n}</p>
        <h2 className="font-display text-2xl tracking-tight md:text-3xl">{title}</h2>
        {sub && <p className="text-sm text-muted">{sub}</p>}
      </div>
      {children}
    </section>
  );
}

function Sub({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-3">
      <div className="grid gap-0.5">
        <h3 className="font-heading text-lg">{title}</h3>
        {sub && <p className="text-[13px] text-muted">{sub}</p>}
      </div>
      {children}
    </div>
  );
}

function Panel({ title, tone, children }: { title: string; tone?: "warn"; children: React.ReactNode }) {
  return (
    <div className={`grid content-start gap-3 rounded-[18px] border p-6 ${tone === "warn" ? "border-warn/30 bg-warn-soft" : "border-line bg-surface"}`}>
      <p className="text-[10px] uppercase tracking-[0.16em] text-faint">{title}</p>
      {children}
    </div>
  );
}

function List({ items, numbered }: { items: string[]; numbered?: boolean }) {
  return (
    <ul className="grid gap-2 text-sm leading-relaxed text-muted">
      {items.map((x, i) => (
        <li key={i} className="grid grid-cols-[18px_minmax(0,1fr)] gap-2">
          <span className="pt-0.5 text-[11px] tabular text-faint">{numbered ? `${i + 1}.` : "·"}</span>
          <span>{x}</span>
        </li>
      ))}
    </ul>
  );
}
