import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { AREA_LABEL as EMAIL_AREA_LABEL, type EmailAuditResult } from "@/lib/email-ops/audit-core";
import type { ScoreSnapshot } from "@/lib/email-ops/sprint-core";
import { SOCIAL_AREA_LABEL, type SocialAuditResult } from "@/lib/social-ops/audit-core";
import { createClient } from "@/lib/supabase/server";
import { EmailChecks } from "./email-checks";
import { EmailActionCard, FollowAudit, RunEmailAudit, WatchAudit } from "./email-ops-parts";

// One email or social audit in full (the email and social audit pages both render this): the verdict, the score's
// checks, why, the plan the team ticks off, tests and what to ask. The two lines keep the same shapes in their own tables.

type Line = "email" | "social";
const AREA_LABEL: Record<string, string> = { ...EMAIL_AREA_LABEL, ...SOCIAL_AREA_LABEL };
const NAME: Record<Line, string> = { email: "Email", social: "Social" };

const BAND: Record<string, { label: string; tone: string; ring: string; glow: string }> = {
  red: { label: "Red", tone: "text-bad", ring: "border-bad/40 bg-bad-soft", glow: "bg-bad/25" },
  watch: { label: "Yellow", tone: "text-warn", ring: "border-warn/40 bg-warn-soft", glow: "bg-warn/20" },
  good: { label: "Green", tone: "text-ok", ring: "border-ok/40 bg-ok-soft", glow: "bg-ok/20" },
};
const SEV: Record<string, string> = { high: "border-l-bad", medium: "border-l-warn", low: "border-l-line" };
const WHEN: [string, string, string][] = [
  ["now", "Today", "Do these before anything else"],
  ["this_week", "This week", "Once today's changes are in"],
  ["next", "Next", "After the tests read out"],
];
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

function Section({ n, title, sub, children }: { n: string; title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-5">
      <div className="grid gap-1">
        <p className="font-display text-sm tabular text-faint">{n}</p>
        <h2 className="font-heading text-xl md:text-2xl">{title}</h2>
        {sub && <p className="text-sm text-muted">{sub}</p>}
      </div>
      {children}
    </section>
  );
}

export async function OpsAuditView({ line, id }: { line: Line; id: string }) {
  await requireStaff();
  const supabase = await createClient();
  const { data: a } = await supabase.from(`${line}_audits`).select("id, client_id, status, step, progress, score, band, result, done, inputs, auto, created_at, error, profiles(full_name), clients(name, slug)").eq("id", id).maybeSingle();
  if (!a) notFound();
  const client = a.clients as unknown as { name: string; slug: string };
  const [{ data: sprint }, { data: history }] = await Promise.all([
    supabase.from(`${line}_sprints`).select(`id, audit_id, ${line}_sprint_actions(title, status)`).eq("client_id", a.client_id).eq("status", "active").maybeSingle(),
    supabase.from(`${line}_audits`).select("id, created_at, status, score, band, auto").eq("client_id", a.client_id).order("created_at", { ascending: false }).limit(8),
  ]);
  const back = (
    <Link href={`/clients/${client.slug}`} className="inline-flex min-h-11 w-fit items-center text-xs text-muted hover:text-fg md:min-h-0">
      ← {client.name}
    </Link>
  );
  const r = a.result as EmailAuditResult | SocialAuditResult | null;

  if (a.status !== "ready" || !r)
    return (
      <div className="mx-auto grid max-w-6xl gap-6">
        {back}
        {a.status === "running" && <WatchAudit />}
        <div className="grid place-items-center gap-3 rounded-[20px] border border-dashed border-line px-6 py-20 text-center">
          <p className="font-heading text-lg">{a.status === "running" ? "Reading the account" : "This audit didn't finish"}</p>
          {a.status === "running" ? (
            <>
              <p className="max-w-md text-sm text-muted">{a.step ?? "Starting"}. It opens here when it is done; you can leave this page.</p>
              <div role="progressbar" aria-valuenow={a.progress} aria-valuemin={0} aria-valuemax={100} className="h-1.5 w-56 overflow-hidden rounded-full bg-line">
                <div className="h-full rounded-full bg-fg transition-all" style={{ width: `${Math.max(4, a.progress)}%` }} />
              </div>
            </>
          ) : (
            <>
              <p className="max-w-md text-sm text-muted">{a.error ?? "Something went wrong reading the account."}</p>
              <RunEmailAudit clientId={a.client_id as string} label="Try again" line={line} />
            </>
          )}
        </div>
      </div>
    );

  const snap = ((a.inputs ?? {}) as { snapshot?: ScoreSnapshot }).snapshot ?? null;
  const done = (a.done ?? {}) as Record<string, { by: string; at: string }>;
  const band = BAND[r.verdict.status] ?? BAND.watch;
  const onList = new Map<string, string>((((sprint as Record<string, unknown> | null)?.[`${line}_sprint_actions`] ?? []) as { title: string; status: string }[]).map((x) => [x.title, x.status]));
  const replaced = Boolean(sprint && sprint.audit_id !== a.id);
  const nums = ["03", "04", "05"];
  const nTests = r.tests.length ? nums.shift()! : "";
  const nWatch = nums.shift()!;

  return (
    <div className="mx-auto grid w-full min-w-0 max-w-6xl gap-10 pb-16 md:gap-14">
      {back}

      <header className="relative isolate overflow-hidden rounded-[28px] border border-line bg-surface">
        <div aria-hidden className={`pointer-events-none absolute -right-32 -top-40 -z-10 h-[420px] w-[420px] rounded-full blur-[120px] ${band.glow}`} />
        <div className="grid gap-6 px-5 py-6 md:px-10 md:py-10">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs uppercase tracking-[0.2em] text-faint">
              {NAME[line]} audit · {client.name} · {when(a.created_at as string)}
              {a.auto ? " · ran itself" : ""}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full border px-3 py-1 text-xs font-medium ${band.ring} ${band.tone}`}>
                {band.label} · {a.score ?? "?"}
              </span>
              {sprint && !replaced ? (
                <Link href={`/kpis/${line}-sprint/${sprint.id}`} className="grid min-h-11 place-items-center rounded-full bg-fg px-4 text-[13px] font-medium text-bg md:min-h-9">
                  Open the sprint →
                </Link>
              ) : (
                <FollowAudit auditId={a.id as string} line={line} />
              )}
              <RunEmailAudit clientId={a.client_id as string} label="Run a new audit" quiet line={line} />
            </div>
          </div>
          <div className="grid gap-3">
            <h1 className="max-w-3xl font-heading text-[22px] leading-snug md:text-[28px]">{r.verdict.headline}</h1>
            <p className="max-w-3xl text-[15px] leading-relaxed text-muted">{r.verdict.summary}</p>
          </div>
          {snap && <EmailChecks checks={snap.checks} />}
          <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-[16px] border border-line bg-line">
            {[
              [String(a.score ?? "?"), `${NAME[line]} score`],
              [String(r.causes.length), "Root causes found"],
              [`${Object.keys(done).length}/${r.actions.length}`, "Actions done"],
            ].map(([n, label]) => (
              <div key={label} className="flex min-w-0 flex-col gap-1 bg-surface/90 px-4 py-4 md:px-5">
                <dd className="font-display text-2xl tabular tracking-tight md:text-3xl">{n}</dd>
                <dt className="text-xs text-muted">{label}</dt>
              </div>
            ))}
          </dl>
        </div>
      </header>

      <Section n="01" title="Here's what I found" sub="Why the score is where it is.">
        <div className="grid gap-4 rounded-[20px] border border-line bg-surface p-5 text-[15px] leading-relaxed md:p-8">
          {r.diagnosis
            .split(/\n+/)
            .filter(Boolean)
            .map((p, i) => (
              <p key={i} className={i === 0 ? "text-fg" : "text-muted"}>
                {p}
              </p>
            ))}
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {r.causes.map((c, i) => (
            <article key={i} className={`grid min-w-0 content-start gap-3 rounded-[16px] border border-l-4 border-line bg-surface p-4 md:p-5 ${SEV[c.severity]}`}>
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className="font-display text-sm tabular text-faint">{String(i + 1).padStart(2, "0")}</span>
                <span className="rounded-full border border-line px-2 py-0.5 text-muted">{AREA_LABEL[c.area] ?? c.area}</span>
                <span className={c.severity === "high" ? "text-bad" : c.severity === "medium" ? "text-warn" : "text-faint"}>{c.severity} impact</span>
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
      </Section>

      <Section n="02" title="What I'd do if I were you" sub="Tick each move off as it is done; follow the plan as a sprint and the score is re-measured for you.">
        {replaced && sprint && (
          <p className="rounded-[12px] border border-warn/40 bg-warn-soft px-4 py-3 text-sm">
            A newer audit replaced this plan on the sprint, so its moves are not on the action list.{" "}
            <Link href={`/kpis/${line}-audit/${sprint.audit_id}`} className="font-medium underline-offset-4 hover:underline">
              Open the latest audit →
            </Link>
          </p>
        )}
        <div className="grid gap-6 lg:grid-cols-3">
          {WHEN.map(([key, label, hint]) => {
            const items = (r.actions as (EmailAuditResult["actions"][number] | SocialAuditResult["actions"][number])[]).map((x, i) => ({ x, i })).filter(({ x }) => x.when === key);
            return (
              <div key={key} className="grid content-start gap-3">
                <div className="flex items-baseline justify-between gap-2 border-b border-line pb-2">
                  <p className="font-heading">{label}</p>
                  <p className="text-[11px] text-faint">{items.length ? hint : "Nothing here"}</p>
                </div>
                {items.map(({ x, i }) => (
                  <EmailActionCard key={i} line={line} auditId={a.id as string} index={i} action={x} areaLabel={AREA_LABEL[x.area] ?? x.area} done={done[String(i)] ?? null} listed={replaced ? "replaced" : (onList.get(x.title) ?? null)} />
                ))}
              </div>
            );
          })}
        </div>
      </Section>

      {nTests && (
        <Section n={nTests} title="Tests worth running" sub="One variable each, with what counts as a win.">
          <div className="grid gap-3 md:grid-cols-3">
            {r.tests.map((t, i) => (
              <article key={i} className="grid min-w-0 content-start gap-2 rounded-[16px] border border-line bg-surface p-4 md:p-5">
                <h3 className="font-heading leading-snug">{t.name}</h3>
                <p className="text-[13px] leading-relaxed text-muted">{t.hypothesis}</p>
                <p className="text-[12.5px] leading-relaxed">{t.setup}</p>
                <p className="text-[12px] text-faint">
                  Measure {t.metric}. A win: {t.success}
                </p>
              </article>
            ))}
          </div>
        </Section>
      )}

      <Section n={nWatch} title="What to watch, and what to ask the client">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid content-start gap-2 rounded-[16px] border border-line bg-surface p-5">
            <p className="font-heading">Watch next week</p>
            <ul className="grid gap-1.5 text-[13px] leading-relaxed text-muted">
              {r.watch.length ? r.watch.map((w, i) => <li key={i}>{w}</li>) : <li>Nothing specific.</li>}
            </ul>
          </div>
          <div className="grid content-start gap-2 rounded-[16px] border border-line bg-surface p-5">
            <p className="font-heading">Ask the client</p>
            <ul className="grid gap-1.5 text-[13px] leading-relaxed text-muted">
              {r.questions.length ? r.questions.map((w, i) => <li key={i}>{w}</li>) : <li>Nothing to ask right now.</li>}
            </ul>
          </div>
        </div>
      </Section>

      {(history ?? []).length > 1 && (
        <section className="grid gap-2">
          <p className="text-xs uppercase tracking-[0.2em] text-faint">Earlier audits</p>
          <ul className="grid gap-1 text-sm">
            {(history ?? []).map((h) => (
              <li key={h.id as string}>
                <Link href={`/kpis/${line}-audit/${h.id}`} className={`inline-flex min-h-11 items-center gap-3 md:min-h-0 ${h.id === a.id ? "text-fg" : "text-muted hover:text-fg"}`}>
                  <span>{when(h.created_at as string)}</span>
                  <span className="tabular">{h.status === "ready" ? `score ${h.score ?? "?"}` : h.status}</span>
                  {h.auto ? <span className="text-faint">ran itself</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
