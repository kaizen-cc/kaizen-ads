"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import { buildReportAction } from "./actions";

// The report builder: the client, the date ranges (as many as the report needs: the last 7 days AND the month), and
// the services. Another buyer's service is drafted for them and they're asked to approve it; the whole thing goes to
// the client as one report. On the right, the report as it takes shape: what it covers, who's in it, where it goes.

/** A one-tap report: what this person builds again and again, or their client with no report this week */
export type QuickPick = { clientId: string; ranges: string[]; services: string[]; reason: string };
export type BuilderClient = { id: string; name: string; slug: string; hasChannel: boolean; services: { platform: "meta" | "google"; owner: string | null; mine: boolean }[] };

const RANGES = [
  { key: "last7", label: "Last 7 days", hint: "This week's pulse" },
  { key: "last14", label: "Last 14 days", hint: "Two-week trend" },
  { key: "last30", label: "Last 30 days", hint: "A rolling month" },
  { key: "mtd", label: "Month to date", hint: "Pacing this month" },
  { key: "lastMonth", label: "Last month", hint: "The full month" },
  { key: "custom", label: "Custom", hint: "Any dates" },
] as const;
const PLATFORM = {
  meta: { name: "Meta Ads", color: "#4f7cff", glow: "rgba(79,124,255,0.35)" },
  google: { name: "Google Ads", color: "#34c38f", glow: "rgba(52,195,143,0.3)" },
} as const;

const shift = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const fmt = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
/** The dates a range covers, as of yesterday (where the data runs to) */
function datesOf(key: string, yesterday: string, custom: { start: string; end: string }) {
  if (key === "last7") return [shift(yesterday, -6), yesterday];
  if (key === "last14") return [shift(yesterday, -13), yesterday];
  if (key === "last30") return [shift(yesterday, -29), yesterday];
  if (key === "mtd") return [`${yesterday.slice(0, 8)}01`, yesterday];
  if (key === "lastMonth") {
    const today = shift(yesterday, 1);
    const end = shift(`${today.slice(0, 8)}01`, -1);
    return [`${end.slice(0, 8)}01`, end];
  }
  return custom.start ? [custom.start, custom.end] : null;
}
const initials = (n: string) => n.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

function Mark({ platform, size = 18 }: { platform: "meta" | "google"; size?: number }) {
  return platform === "meta" ? (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
      <path d="M3 15c0-4 2-8 4.5-8C11 7 13 17 16.5 17 19 17 21 14 21 11.5S19.5 7 17.5 7C14 7 12 15 8 15c-2 0-5 .5-5 0z" />
    </svg>
  ) : (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
      <path d="M20.5 12.2c0-.6 0-1.1-.1-1.7H12v3.3h4.8a4.2 4.2 0 0 1-1.8 2.7" />
      <path d="M15 16.5A6.5 6.5 0 1 1 16.4 7" />
    </svg>
  );
}

function Step({ n, title, done, children, last = false, enter = false }: { n: number; title: string; done: boolean; children: React.ReactNode; last?: boolean; enter?: boolean }) {
  return (
    <div className="relative grid grid-cols-[32px_minmax(0,1fr)] gap-4" style={enter ? { animation: "step-in .4s cubic-bezier(.2,.8,.2,1) both" } : undefined}>
      {!last && <span aria-hidden className={`absolute left-[15px] top-9 bottom-[-12px] w-px ${done ? "bg-gradient-to-b from-brand/70 to-line" : "bg-line"}`} />}
      <span className={`relative z-10 grid h-8 w-8 place-items-center rounded-full text-[13px] font-semibold transition-colors ${done ? "bg-brand text-white shadow-[0_0_0_4px_rgba(200,16,46,0.18)]" : "border border-line bg-bg text-muted"}`}>{done ? "✓" : n}</span>
      <div className="grid min-w-0 gap-3 pb-7">
        <p className="pt-1 font-heading text-[17px]">{title}</p>
        {children}
      </div>
    </div>
  );
}

export function ReportBuilder({ clients, quick = [], yesterday }: { clients: BuilderClient[]; quick?: QuickPick[]; yesterday: string }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  // The client is the first step, kept in the address (?client=): back returns to picking one, and a link from a
  // client's page arrives with it picked
  const wanted = useParam("client");
  const picked = clients.find((c) => c.slug === wanted || c.id === wanted) ?? null;
  const [ranges, setRanges] = useState<string[]>([]);
  const [custom, setCustom] = useState({ start: "", end: yesterday });
  // The services ticked for the picked client; until they're changed, the buyer's own (or all of them)
  const [ticked, setTicked] = useState<{ id: string; list: string[] } | null>(null);
  const mine = picked?.services.filter((s) => s.mine).map((s) => s.platform) ?? [];
  const services = !picked ? [] : ticked?.id === picked.id ? ticked.list : mine.length ? mine : picked.services.map((s) => s.platform);
  const setServices = (list: string[]) => picked && setTicked({ id: picked.id, list });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // Results from the second letter on
  const searching = q.trim().length >= 2;
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (t.length < 2) return [];
    return clients.filter((c) => c.name.toLowerCase().includes(t)).sort((a, b) => Number(b.name.toLowerCase().startsWith(t)) - Number(a.name.toLowerCase().startsWith(t)) || a.name.localeCompare(b.name)).slice(0, 9);
  }, [q, clients]);
  const picks = quick.map((p) => ({ ...p, client: clients.find((c) => c.id === p.clientId) })).filter((p): p is QuickPick & { client: BuilderClient } => Boolean(p.client));
  /** A quick pick fills every step at once */
  const apply = (p: QuickPick & { client: BuilderClient }) => {
    pushParams({ client: p.client.slug });
    setQ("");
    setRanges(p.ranges);
    setTicked({ id: p.client.id, list: p.services.filter((s) => p.client.services.some((x) => x.platform === s)) });
    setError(null);
  };
  const choose = (c: BuilderClient) => {
    pushParams({ client: c.slug });
    setQ("");
    setTicked(null);
    setError(null);
  };
  const toggle = (list: string[], set: (x: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const chosen = picked?.services.filter((s) => services.includes(s.platform)) ?? [];
  const others = chosen.filter((s) => !s.mine);
  const joint = chosen.length > 1;
  const rangesReady = ranges.length > 0 && (!ranges.includes("custom") || Boolean(custom.start));
  const ready = Boolean(picked) && rangesReady && chosen.length > 0;

  const build = () =>
    start(async () => {
      if (!picked) return;
      setError(null);
      const r = await buildReportAction(
        picked.id,
        ranges.map((k) => (k === "custom" ? { key: k, start: custom.start, end: custom.end } : { key: k })),
        services,
      );
      if (!r.ok) return setError(r.error);
      router.push(`/reports/${r.id}`);
    });

  return (
    <section className="relative isolate overflow-hidden rounded-[28px] border border-ink/[0.08] bg-deep">
      <span aria-hidden className="pointer-events-none absolute -left-32 -top-40 -z-10 h-[420px] w-[420px] rounded-full bg-[rgba(200,16,46,0.28)] blur-[120px]" />
      <span aria-hidden className="pointer-events-none absolute -bottom-48 right-[-120px] -z-10 h-[380px] w-[380px] rounded-full bg-[rgba(79,124,255,0.16)] blur-[120px]" />
      <div className="grid lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* The steps */}
        <div className="grid gap-2 p-6 md:p-9">
          <div className="mb-5 grid gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-brand-text">Report builder</span>
            <h2 className="font-heading text-[30px] leading-[1.1] tracking-tight md:text-[36px]">One report, everything they need to see</h2>
            <p className="max-w-xl text-sm text-ink/55">Pick the client, the dates and the services. Each service is written for its buyer, and the client gets it all as one.</p>
          </div>

          <Step n={1} title="Who it's for" done={Boolean(picked)} last={!picked}>
            {picked ? (
              <div className="flex flex-wrap items-center gap-3 rounded-[16px] border border-ink/10 bg-ink/[0.04] p-3 pr-4">
                <span className="grid h-11 w-11 place-items-center rounded-[12px] bg-gradient-to-br from-brand to-[#7a0a1c] font-heading text-sm text-white">{initials(picked.name)}</span>
                <span className="grid min-w-0 flex-1">
                  <span className="truncate font-heading text-lg leading-tight">{picked.name}</span>
                  <span className="text-xs text-ink/50">{picked.services.map((s) => PLATFORM[s.platform].name).join(" · ")}</span>
                </span>
                <button type="button" onClick={() => closeParams("client")} className="h-9 rounded-full border border-ink/10 px-3.5 text-xs text-ink/60 hover:text-fg max-md:h-11">
                  Change
                </button>
              </div>
            ) : (
              <div className="grid gap-4">
                <div className="relative md:max-w-md">
                  <svg className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink/40" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                    <circle cx="11" cy="11" r="7" />
                    <path d="m20 20-3.5-3.5" />
                  </svg>
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${clients.length} clients`} className="h-12 w-full rounded-[14px] border border-ink/10 bg-ink/[0.04] pl-10 pr-4 text-[15px] outline-none placeholder:text-ink/35 focus:border-brand/60" />
                </div>
                {!searching && q.trim().length === 1 && <p className="-mt-2 text-xs text-ink/40">One more letter…</p>}
                {/* Before a search: one-tap reports, from what you usually build and your clients due one */}
                {!searching && picks.length > 0 && (
                  <div className="grid gap-2">
                    <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-ink/45">
                      <span className="text-brand-text">✦</span> Quick create
                    </span>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {picks.map((p) => (
                        <button
                          key={`${p.clientId}-${p.ranges.join()}-${p.services.join()}`}
                          type="button"
                          onClick={() => apply(p)}
                          className="group relative grid gap-2 overflow-hidden rounded-[16px] border border-ink/[0.08] bg-gradient-to-br from-ink/[0.06] to-ink/[0.02] p-4 text-left transition hover:-translate-y-0.5 hover:border-brand/50 hover:shadow-[0_16px_40px_-20px_rgba(200,16,46,0.8)]"
                        >
                          <span className="flex items-center gap-3">
                            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[11px] bg-gradient-to-br from-brand to-[#7a0a1c] text-[12px] font-semibold text-white">{initials(p.client.name)}</span>
                            <span className="grid min-w-0">
                              <span className="truncate font-heading text-[15px]">{p.client.name}</span>
                              <span className="truncate text-[11.5px] text-ink/50">{p.ranges.map((k) => RANGES.find((x) => x.key === k)?.label).join(" + ")}</span>
                            </span>
                          </span>
                          <span className="flex flex-wrap items-center gap-1.5">
                            {p.services.map((sv) => (
                              <span key={sv} className="flex items-center gap-1 rounded-full bg-ink/[0.06] px-2 py-0.5 text-[11px] text-ink/70">
                                <span className="h-1.5 w-1.5 rounded-full" style={{ background: PLATFORM[sv as "meta" | "google"]?.color }} />
                                {PLATFORM[sv as "meta" | "google"]?.name.replace(" Ads", "")}
                              </span>
                            ))}
                          </span>
                          <span className="text-[11px] text-ink/40">{p.reason}</span>
                          <span className="absolute right-4 top-4 text-sm text-ink/30 transition group-hover:translate-x-0.5 group-hover:text-fg">→</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {!searching && !picks.length && <p className="text-xs text-ink/40">Type two letters of a client&apos;s name.</p>}
                {searching && (
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {matches.map((c) => (
                    <button key={c.id} type="button" onClick={() => choose(c)} className="group flex min-h-[60px] items-center gap-3 rounded-[14px] border border-ink/[0.07] bg-ink/[0.03] px-3 py-2.5 text-left transition hover:-translate-y-px hover:border-ink/20 hover:bg-ink/[0.06]">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-ink/[0.08] text-[12px] font-semibold text-ink/80 group-hover:bg-brand group-hover:text-white">{initials(c.name)}</span>
                      <span className="grid min-w-0">
                        <span className="truncate text-sm">{c.name}</span>
                        <span className="flex items-center gap-1.5 text-[11px] text-ink/45">
                          {c.services.map((s) => (
                            <span key={s.platform} className="flex items-center gap-1">
                              <span className="h-1.5 w-1.5 rounded-full" style={{ background: PLATFORM[s.platform].color }} />
                              {PLATFORM[s.platform].name.replace(" Ads", "")}
                            </span>
                          ))}
                        </span>
                      </span>
                    </button>
                  ))}
                  {!matches.length && <p className="px-1 text-sm text-ink/45">No client by that name with an ad account to report on.</p>}
                </div>
                )}
              </div>
            )}
          </Step>

          {picked && (
          <Step key={`dates-${picked.id}`} n={2} title="What it covers" done={rangesReady} last={!ranges.length} enter>
            <div className="grid gap-2 sm:grid-cols-3">
              {RANGES.map((r) => {
                const on = ranges.includes(r.key);
                const d = datesOf(r.key, yesterday, custom);
                return (
                  <button
                    key={r.key}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggle(ranges, setRanges, r.key)}
                    className={`relative grid min-h-[72px] content-start gap-0.5 rounded-[14px] border px-3.5 py-3 text-left transition ${on ? "border-brand/70 bg-brand/[0.12] shadow-[0_10px_30px_-18px_rgba(200,16,46,0.9)]" : "border-ink/[0.08] bg-ink/[0.03] hover:border-ink/20"}`}
                  >
                    {on && <span className="absolute right-2.5 top-2.5 grid h-5 min-w-5 place-items-center rounded-full bg-brand px-1 text-[10px] font-semibold text-white">{ranges.length > 1 ? ranges.indexOf(r.key) + 1 : "✓"}</span>}
                    <span className="text-sm font-medium">{r.label}</span>
                    <span className="text-[11.5px] text-ink/45">{d ? `${fmt(d[0])} – ${fmt(d[1])}` : r.hint}</span>
                  </button>
                );
              })}
            </div>
            {ranges.includes("custom") && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <input type="date" value={custom.start} max={yesterday} onChange={(e) => setCustom({ ...custom, start: e.target.value })} className="h-11 rounded-[12px] border border-ink/10 bg-ink/[0.04] px-3 [color-scheme:dark]" />
                <span className="text-ink/40">to</span>
                <input type="date" value={custom.end} max={yesterday} onChange={(e) => setCustom({ ...custom, end: e.target.value })} className="h-11 rounded-[12px] border border-ink/10 bg-ink/[0.04] px-3 [color-scheme:dark]" />
              </div>
            )}
            <p className="text-xs text-ink/40">{ranges.length > 1 ? "Number 1 leads the report; the others each get their own section, each against the period before it." : ranges.length ? "Pick another to cover both: the last 7 days and the month, say." : "Pick one or more."}</p>
          </Step>
          )}

          {picked && ranges.length > 0 && (
          <Step key={`services-${picked.id}`} n={3} title="Which services" done={chosen.length > 0} last enter>
            <div className="grid gap-2 sm:grid-cols-2">
              {picked.services.map((s) => {
                const on = services.includes(s.platform);
                const p = PLATFORM[s.platform];
                return (
                  <button
                    key={s.platform}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggle(services, setServices, s.platform)}
                    className="relative flex min-h-[76px] items-center gap-3 overflow-hidden rounded-[16px] border px-4 py-3 text-left transition"
                    style={on ? { borderColor: p.color, background: `linear-gradient(135deg, ${p.glow}, transparent 70%)` } : { borderColor: "color-mix(in oklab, var(--ink) 8%, transparent)", background: "color-mix(in oklab, var(--ink) 3%, transparent)" }}
                  >
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px]" style={{ background: on ? p.color : "color-mix(in oklab, var(--ink) 8%, transparent)", color: on ? "#fff" : p.color }}>
                      <Mark platform={s.platform} />
                    </span>
                    <span className="grid min-w-0 flex-1">
                      <span className="font-medium">{p.name}</span>
                      <span className="flex items-center gap-1.5 text-[11.5px] text-ink/50">
                        <span className="grid h-4 w-4 place-items-center rounded-full bg-ink/15 text-[8px] font-semibold text-fg">{s.mine ? "Y" : initials(s.owner ?? "?")}</span>
                        {s.mine ? "You write it" : s.owner ? `${s.owner} approves it` : "No buyer set"}
                      </span>
                    </span>
                    <span className={`grid h-6 w-6 place-items-center rounded-full border text-[11px] ${on ? "border-transparent bg-fg text-bg" : "border-ink/20 text-transparent"}`}>✓</span>
                  </button>
                );
              })}
            </div>
          </Step>
          )}
          <style>{`@keyframes step-in { from { opacity: 0; transform: translateY(10px) } to { opacity: 1; transform: none } }`}</style>
        </div>

        {/* The report as it takes shape */}
        <aside className="relative grid content-between gap-6 border-t border-ink/[0.07] bg-ink/[0.02] p-6 md:p-8 lg:border-l lg:border-t-0">
          <div className="grid gap-5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-ink/40">Your report</span>
            <div className="relative overflow-hidden rounded-[18px] bg-deep p-5 shadow-[0_30px_70px_-30px_rgba(0,0,0,0.9)] ring-1 ring-ink/10">
              <span className="mb-4 block h-[3px] w-8 bg-brand" />
              <p className="font-heading text-[22px] leading-tight">{picked?.name ?? "Pick a client"}</p>
              <p className="mt-1 text-[12.5px] text-ink/50">{ranges.map((k) => RANGES.find((r) => r.key === k)?.label).join(" + ") || "Pick the dates"}</p>
              <div className="mt-5 grid gap-1.5">
                {joint && (
                  <span className="flex items-center gap-2 rounded-[10px] bg-ink/[0.05] px-3 py-2 text-[12px] text-ink/75">
                    <span className="h-1.5 w-1.5 rounded-full bg-white" />
                    The whole account, every service side by side
                  </span>
                )}
                {chosen.map((s) => (
                  <span key={s.platform} className="flex items-center gap-2 rounded-[10px] bg-ink/[0.05] px-3 py-2 text-[12px] text-ink/75">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: PLATFORM[s.platform].color }} />
                    {PLATFORM[s.platform].name}
                    <span className="ml-auto text-ink/40">{ranges.length} range{ranges.length === 1 ? "" : "s"}</span>
                  </span>
                ))}
                {!chosen.length && <span className="rounded-[10px] border border-dashed border-ink/10 px-3 py-2 text-[12px] text-ink/35">Services appear here</span>}
              </div>
            </div>
            <ul className="grid gap-2.5 text-[13px] text-ink/65">
              <li className="flex gap-2.5">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                {others.length ? `${others.map((o) => o.owner ?? "The other buyer").join(" and ")} ${others.length === 1 ? "is" : "are"} asked to approve their part` : "Written in your voice, for you to review"}
              </li>
              <li className="flex gap-2.5">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                {joint ? "Goes out once, from the Kaizen app: one message, one PDF" : "Goes out as you, with the PDF attached"}
              </li>
              <li className="flex gap-2.5">
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${picked && !picked.hasChannel ? "bg-warn" : "bg-brand"}`} />
                {picked && !picked.hasChannel ? <span className="text-warn">No Slack channel linked yet: add it on the client page before sending</span> : "Into their Slack channel, after you approve the message"}
              </li>
            </ul>
          </div>
          <div className="grid gap-2">
            {error && <p className="text-sm text-bad">{error}</p>}
            <button
              type="button"
              disabled={pending || !ready}
              onClick={build}
              className="group relative h-14 overflow-hidden rounded-[16px] bg-brand text-[15px] font-semibold text-white shadow-[0_18px_40px_-14px_rgba(200,16,46,0.95)] transition hover:-translate-y-0.5 hover:bg-brand-hover disabled:translate-y-0 disabled:opacity-35 disabled:shadow-none"
            >
              <span aria-hidden className="absolute inset-y-0 -left-1/2 w-1/2 -skew-x-12 bg-ink/20 opacity-0 transition-all duration-700 group-hover:left-full group-hover:opacity-100" />
              {pending ? "Building…" : ready ? "Build the report →" : !picked ? "Pick a client to start" : !rangesReady ? "Pick the dates" : "Pick a service"}
            </button>
            <p className="text-center text-[11.5px] text-ink/40">Written and checked in about a minute</p>
          </div>
        </aside>
      </div>
    </section>
  );
}
