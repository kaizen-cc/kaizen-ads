"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { BusinessAuditResult } from "@/lib/business-audit";
import type { BusinessRouting, RoutedAction } from "@/lib/business-audit-route";
import { Rebut, type RebutNote } from "@/components/audit-rebut";
import { AuditWhy } from "@/components/audit-why";
import { ObjectLinks } from "@/components/object-links";
import { BriefPreviewButton } from "@/components/quick-brief-sheet";

// The full business audit on the client page: one button that audits every channel together (Meta, Google, creative,
// what the client is telling us), and the latest result in the same found / do / watch shape as an account audit.

export type BusinessAuditView = { id: string; status: "running" | "ready" | "failed"; step: string | null; error: string | null; result: BusinessAuditResult | null; at: string; by: string | null };

const CHANNEL: Record<string, string> = { meta: "Meta", google: "Google", creative: "Creative", communication: "Communication", business: "Whole business" };
const OWNER: Record<string, string> = { media_buyer: "Media buyer", creative: "Creative team", client: "Client", strategist: "Strategist", account_manager: "Account manager" };
const TONE: Record<string, { label: string; chip: string; dot: string }> = {
  off: { label: "Off target", chip: "bg-bad-soft text-bad", dot: "bg-bad" },
  at_risk: { label: "At risk", chip: "bg-warn-soft text-warn", dot: "bg-warn" },
  on_track: { label: "On track", chip: "bg-ok-soft text-ok", dot: "bg-ok" },
  winning: { label: "Winning", chip: "bg-ok-soft text-ok", dot: "bg-ok" },
  no_data: { label: "No data", chip: "bg-surface-2 text-muted", dot: "bg-faint" },
};
const WHEN: Record<string, string> = { now: "Today", this_week: "This week", next: "Next" };
const SEV: Record<string, string> = { high: "border-l-bad", medium: "border-l-warn", low: "border-l-line" };

export function BusinessAuditPanel({ clientId, slug: given = null, latest, pushback, canRebut, asked = {} }: { clientId: string; /** For links to the client's tasks (read from the address when not given) */ slug?: string | null; latest: BusinessAuditView | null; pushback: Record<string, RebutNote[]>; canRebut: boolean; /** "Why?" messages per item so far */ asked?: Record<string, number> }) {
  const router = useRouter();
  const path = usePathname();
  const slug = given ?? (path.startsWith("/clients/") ? (path.split("/")[2] ?? null) : null);
  const [running, setRunning] = useState<{ id: string; step: string | null } | null>(latest?.status === "running" ? { id: latest.id, step: latest.step } : null);
  const [error, setError] = useState<string | null>(null);
  // Where its moves went (each paid channel's sprint, the rest as tasks), read once it's in
  const [routing, setRouting] = useState<BusinessRouting | null>(null);
  const readyId = latest?.status === "ready" ? latest.id : null;
  useEffect(() => {
    if (!readyId) return;
    let alive = true;
    let tries = 0;
    const read = async () => {
      const res = await fetch(`/api/business-audits?id=${readyId}`, { cache: "no-store" }).catch(() => null);
      const j = (await res?.json().catch(() => null)) as { routing?: BusinessRouting | null } | null;
      if (!alive) return;
      if (j?.routing) setRouting(j.routing);
      // Routing runs right after the audit: look again for a minute while it's on its way
      else if (++tries < 6) setTimeout(read, 10_000);
    };
    void read();
    return () => {
      alive = false;
    };
  }, [readyId]);

  // Follow a running audit until it's done, then show it
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      const res = await fetch(`/api/business-audits?id=${running.id}`, { cache: "no-store" }).catch(() => null);
      const j = (await res?.json().catch(() => null)) as { status?: string; step?: string | null; error?: string | null } | null;
      if (!j?.status) return;
      if (j.status === "running") return setRunning((r) => (r ? { ...r, step: j.step ?? r.step } : r));
      clearInterval(t);
      setRunning(null);
      if (j.status === "failed") setError(j.error ?? "The audit didn't finish.");
      router.refresh();
    }, 4000);
    return () => clearInterval(t);
  }, [running, router]);

  const start = async () => {
    setError(null);
    const res = await fetch("/api/business-audits", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId }) });
    const j = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
    if (!j.id) return setError(j.error ?? "Couldn't start it.");
    setRunning({ id: j.id, step: "Starting" });
  };

  const r = latest?.status === "ready" ? latest.result : null;
  const rebut = (key: string, finding: string) => (latest ? <Rebut kind="business" auditId={latest.id} itemKey={key} finding={finding} notes={pushback[key] ?? []} can={canRebut} /> : null);
  // Under each item: ask the auditor why (team only), and push back (for those who may)
  const talk = (key: string, finding: string) =>
    latest ? (
      <div className="grid gap-2 border-t border-line pt-3">
        <AuditWhy kind="business" auditId={latest.id} itemKey={key} count={asked[`${latest.id}|${key}`] ?? 0} />
        {rebut(key, finding)}
      </div>
    ) : null;

  return (
    <section className="grid gap-5 rounded-[22px] border border-line bg-surface p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">Full business audit</p>
          <p className="max-w-2xl text-[13.5px] text-muted">Every channel at once: Meta, Google, creative and what the client is telling us, connected. {latest ? `Last run ${new Date(latest.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}${latest.by ? ` by ${latest.by}` : ""}.` : "Not run yet."}</p>
        </div>
        <button type="button" disabled={Boolean(running)} onClick={start} className="min-h-11 rounded-full bg-fg px-5 text-[13.5px] font-medium text-bg disabled:opacity-60 md:min-h-9">
          {running ? (running.step ?? "Auditing…") : latest ? "Audit the whole business again" : "Audit the whole business"}
        </button>
      </div>
      {error && <p className="rounded-[12px] bg-bad-soft px-4 py-2.5 text-[13px] text-bad">{error}</p>}
      {latest?.status === "failed" && !error && !running && <p className="text-[13px] text-faint">The last one didn&apos;t finish: {latest.error}</p>}

      {r && (
        <div className="grid gap-6">
          <div className="grid gap-2">
            <span className={`justify-self-start rounded-full px-3 py-1 text-[11.5px] font-medium ${TONE[r.verdict.status]?.chip ?? ""}`}>{TONE[r.verdict.status]?.label}</span>
            <h3 className="max-w-3xl font-heading text-[20px] leading-snug md:text-[24px]">{r.verdict.headline}</h3>
            <p className="max-w-3xl text-[14.5px] leading-relaxed text-muted">{r.verdict.summary}</p>
            {talk("verdict", r.verdict.headline)}
          </div>

          {/* Each channel at a glance */}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {r.channels.map((c) => (
              <article key={c.channel} className="grid min-w-0 content-start gap-2 rounded-[16px] border border-line bg-bg/40 p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-[13.5px] font-medium">
                    <span className={`h-2 w-2 rounded-full ${TONE[c.status]?.dot ?? "bg-faint"}`} />
                    {CHANNEL[c.channel] ?? c.channel}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-[10.5px] ${TONE[c.status]?.chip ?? ""}`}>{TONE[c.status]?.label}</span>
                </div>
                <p className="text-[13.5px] leading-snug">{c.headline}</p>
                <ul className="grid gap-1 text-[12.5px] leading-relaxed text-muted">
                  {c.notes.map((x, i) => (
                    <li key={i}>· {x}</li>
                  ))}
                </ul>
                {talk(`channel:${c.channel}`, c.headline)}
              </article>
            ))}
          </div>

          {routing && <Routed routing={routing} slug={slug} />}

          <Block title="Here's what I found">
            <div className="grid gap-3 text-[14px] leading-relaxed">
              {r.diagnosis
                .split(/\n+/)
                .filter(Boolean)
                .map((p, i) => (
                  <p key={i} className={i === 0 ? "" : "text-muted"}>
                    {p}
                  </p>
                ))}
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {r.causes.map((c, i) => (
                <article key={i} className={`grid min-w-0 content-start gap-2 rounded-[16px] border border-l-4 border-line bg-bg/40 p-4 ${SEV[c.severity] ?? ""}`}>
                  <div className="flex flex-wrap gap-1.5 text-[11px]">
                    <span className="rounded-full border border-line px-2 py-0.5 text-muted">{CHANNEL[c.channel] ?? c.channel}</span>
                    <span className={c.severity === "high" ? "text-bad" : c.severity === "medium" ? "text-warn" : "text-faint"}>{c.severity} impact</span>
                  </div>
                  <p className="font-heading leading-snug">{c.title}</p>
                  <ul className="grid gap-1 text-[12.5px] leading-relaxed text-muted">
                    {c.evidence.map((e, j) => (
                      <li key={j}>· {e}</li>
                    ))}
                  </ul>
                  {talk(`cause:${i}`, c.title)}
                </article>
              ))}
            </div>
          </Block>

          <Block title="What I'd do">
            <div className="grid gap-3 md:grid-cols-2">
              {r.actions.map((x, i) => (
                <article key={i} className="grid min-w-0 content-start gap-2 rounded-[16px] border border-line bg-bg/40 p-4">
                  <div className="flex flex-wrap gap-1.5 text-[11px]">
                    <span className="rounded-full bg-surface-2 px-2 py-0.5">{WHEN[x.when] ?? x.when}</span>
                    <span className="rounded-full border border-line px-2 py-0.5 text-muted">{CHANNEL[x.channel] ?? x.channel}</span>
                    <span className="rounded-full border border-line px-2 py-0.5 text-muted">{OWNER[x.owner] ?? x.owner}</span>
                  </div>
                  <p className="font-heading leading-snug">{x.title}</p>
                  <p className="text-[12.5px] text-ok">{x.impact}</p>
                  <ol className="grid gap-1 text-[12.5px] leading-relaxed">
                    {x.steps.map((s, j) => (
                      <li key={j} className="grid grid-cols-[14px_minmax(0,1fr)] gap-1.5">
                        <span className="tabular text-[11px] text-faint">{j + 1}</span>
                        <span>{s}</span>
                      </li>
                    ))}
                  </ol>
                  <p className="text-[12px] leading-relaxed text-muted">{x.why}</p>
                  <ObjectLinks objects={x.objects} />
                  {routing?.actions[i] && <WentTo r={routing.actions[i]} slug={slug} />}
                  {latest && (x.owner === "creative" || x.channel === "creative") && (
                    <BriefPreviewButton
                      previewKey={`business-${latest.id.slice(0, 8)}-a${i}`}
                      clientId={clientId}
                      source={{ kind: "idea", label: `From the business audit: ${x.title}`.slice(0, 200), text: [`Move: ${x.title}`, ...x.steps.map((s) => `- ${s}`), `Why: ${x.why}`, `Impact: ${x.impact}`].join("\n") }}
                      from={{ kicker: "Business audit move", label: x.title }}
                      className="inline-flex min-h-11 items-center justify-center justify-self-start rounded-full border border-line px-4 text-[13px] font-medium hover:border-faint md:min-h-9"
                    >
                      Brief it →
                    </BriefPreviewButton>
                  )}
                  {talk(`action:${i}`, x.title)}
                </article>
              ))}
            </div>
          </Block>

          {(r.creative ?? []).length > 0 && latest && (
            <Block title="Creative I'd make">
              <p className="-mt-1 text-[13px] text-muted">From what&apos;s working across the channels and the Brand Bible. Each one opens its quick preview right here; the full brief is written only when you choose it.</p>
              <div className="grid gap-3 md:grid-cols-2">
                {(r.creative ?? []).map((c, i) => (
                  <article key={i} className="grid min-w-0 content-start gap-2.5 rounded-[16px] border border-line bg-bg/40 p-4">
                    <div className="flex flex-wrap gap-1.5 text-[11px]">
                      <span className="rounded-full border border-line px-2 py-0.5 text-muted">{c.angle}</span>
                      <span className="rounded-full border border-line px-2 py-0.5 text-muted">{c.format}</span>
                    </div>
                    <p className="font-heading leading-snug">{c.concept}</p>
                    <p className="rounded-[12px] bg-surface px-3 py-2.5 font-heading text-[14.5px] leading-snug">
                      <span className="text-brand-text">&ldquo;</span>
                      {c.hook}
                      <span className="text-brand-text">&rdquo;</span>
                    </p>
                    <p className="text-[12.5px] leading-relaxed text-muted">{c.why}</p>
                    <BriefPreviewButton
                      previewKey={`business-${latest.id.slice(0, 8)}-${i}`}
                      clientId={clientId}
                      source={{ kind: "idea", label: `From the business audit: ${c.concept}`.slice(0, 200), text: [`Concept: ${c.concept}`, `Angle: ${c.angle}`, `Hook: "${c.hook}"`, `Format: ${c.format}`, `Why: ${c.why}`].join("\n") }}
                      from={{ kicker: "Business audit idea", label: c.concept }}
                      className="inline-flex min-h-11 items-center justify-center justify-self-start rounded-full bg-fg px-4 text-[13px] font-medium text-bg hover:bg-fg/90 md:min-h-9"
                    >
                      Brief it →
                    </BriefPreviewButton>
                    {talk(`creative:${i}`, c.concept)}
                  </article>
                ))}
              </div>
            </Block>
          )}

          <Block title="What I'd watch out for">
            <div className="grid gap-3 md:grid-cols-2">
              {r.watchouts.map((w, i) => (
                <article key={i} className="grid min-w-0 content-start gap-2 rounded-[16px] border border-warn/30 bg-bg/40 p-4">
                  <p className="font-heading leading-snug">{w.title}</p>
                  <p className="text-[12.5px] leading-relaxed text-muted">{w.why}</p>
                  {talk(`watchout:${i}`, w.title)}
                </article>
              ))}
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <List title="Numbers to watch" items={r.watch} />
              {r.questions.length > 0 && <List title="Ask the client" items={r.questions} />}
            </div>
          </Block>
        </div>
      )}
    </section>
  );
}

/** Per channel: the sprint it opened or added to (never reset), or the tasks it made */
function Routed({ routing, slug }: { routing: BusinessRouting; slug: string | null }) {
  const rows = Object.entries(routing.channels).filter(([, c]) => c);
  if (!rows.length) return null;
  return (
    <div className="grid gap-2.5 rounded-[16px] border border-line bg-bg/40 p-4">
      <p className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-faint">Sent to the teams</p>
      <div className="grid gap-2 md:grid-cols-2">
        {rows.map(([ch, c]) => {
          const label = c!.kind === "created" ? "Sprint started" : c!.kind === "added" ? `Added ${c!.added} ${c!.added === 1 ? "move" : "moves"} to the open sprint` : c!.kind === "unchanged" ? "Open sprint already covers it" : `${c!.added} ${c!.added === 1 ? "task" : "tasks"}`;
          const href = c!.sprintId ? `/kpis/sprint/${c!.sprintId}` : slug ? `/clients/${slug}?tab=plan` : null;
          return (
            <div key={ch} className="grid gap-1 rounded-[12px] border border-line bg-surface px-3.5 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[13px] font-medium">{CHANNEL[ch] ?? ch}</span>
                {href && (
                  <Link href={href} className="text-[12px] text-brand-text hover:underline">
                    {c!.sprintId ? "Open the sprint →" : "Open the tasks →"}
                  </Link>
                )}
              </div>
              <p className="text-[12.5px] text-muted">
                {label}
                {c!.kind === "added" || c!.kind === "unchanged" ? ". Progress already made stays." : ""}
                {c!.duplicates ? ` ${c!.duplicates} already on it.` : ""}
              </p>
              {c!.conflicts.length > 0 && (
                <ul className="grid gap-1 text-[12px] text-warn">
                  {c!.conflicts.map((x, i) => (
                    <li key={i}>
                      For the buyer to decide: &ldquo;{x.title}&rdquo; pulls against &ldquo;{x.of}&rdquo; ({x.note})
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Where one action went */
function WentTo({ r, slug }: { r: RoutedAction; slug: string | null }) {
  const text =
    r.to === "sprint" ? "On the sprint" : r.to === "task" ? "A task for the team" : r.to === "duplicate" ? (r.note ?? "Already covered") : r.to === "conflict" ? `Set aside for the buyer: ${r.note ?? "pulls against a move in progress"}` : "Later: not sent yet";
  const href = r.sprintId ? `/kpis/sprint/${r.sprintId}` : r.taskKey && slug ? `/clients/${slug}?tab=plan` : null;
  const tone = r.to === "conflict" ? "border-warn/40 text-warn" : r.to === "later" ? "border-line text-faint" : "border-ok/30 text-ok";
  return (
    <p className={`justify-self-start rounded-full border px-2.5 py-1 text-[11.5px] ${tone}`}>
      {href ? (
        <Link href={href} className="hover:underline">
          {text} →
        </Link>
      ) : (
        text
      )}
    </p>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-3 border-t border-line pt-5">
      <h3 className="font-heading text-[17px]">{title}</h3>
      {children}
    </div>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="grid min-w-0 content-start gap-2 rounded-[16px] border border-line bg-bg/40 p-4">
      <p className="text-[10.5px] uppercase tracking-[0.16em] text-faint">{title}</p>
      <ul className="grid gap-1.5 text-[13px] leading-relaxed text-muted">
        {items.map((x, i) => (
          <li key={i}>· {x}</li>
        ))}
      </ul>
    </div>
  );
}
