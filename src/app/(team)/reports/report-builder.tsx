"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { buildReportAction } from "./actions";

// The report builder: the client, the date ranges (as many as the report needs: the last 7 days AND the month), and
// the services. Another buyer's service is drafted for them and they're asked to approve it; the whole thing goes to
// the client as one report.

export type BuilderClient = { id: string; name: string; slug: string; services: { platform: "meta" | "google"; owner: string | null; mine: boolean }[] };

const RANGES = [
  { key: "last7", label: "Last 7 days" },
  { key: "last14", label: "Last 14 days" },
  { key: "last30", label: "Last 30 days" },
  { key: "mtd", label: "Month to date" },
  { key: "lastMonth", label: "Last month" },
  { key: "custom", label: "Custom dates" },
];
const NAME = { meta: "Meta Ads", google: "Google Ads" } as const;

export function ReportBuilder({ clients, initialClient, yesterday }: { clients: BuilderClient[]; initialClient?: string | null; yesterday: string }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<BuilderClient | null>(() => clients.find((c) => c.slug === initialClient || c.id === initialClient) ?? null);
  const [ranges, setRanges] = useState<string[]>(["last7"]);
  const [custom, setCustom] = useState({ start: "", end: yesterday });
  const [services, setServices] = useState<string[]>(() => picked?.services.filter((s) => s.mine).map((s) => s.platform) ?? []);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (t ? clients.filter((c) => c.name.toLowerCase().includes(t)) : clients).slice(0, 8);
  }, [q, clients]);
  const choose = (c: BuilderClient) => {
    setPicked(c);
    setQ("");
    // Your own services to start with (all of them when you're on none, as a lead)
    const mine = c.services.filter((s) => s.mine).map((s) => s.platform);
    setServices(mine.length ? mine : c.services.map((s) => s.platform));
    setError(null);
  };
  const toggle = (list: string[], set: (x: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const others = picked?.services.filter((s) => services.includes(s.platform) && !s.mine) ?? [];

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

  const label = "text-[11px] font-semibold uppercase tracking-[0.16em] text-faint";
  const chip = (on: boolean) => `h-10 rounded-full border px-4 text-sm transition-colors max-md:h-11 ${on ? "border-fg bg-fg text-bg" : "border-line text-muted hover:border-faint hover:text-fg"}`;

  return (
    <section className="relative isolate grid gap-6 overflow-hidden rounded-[22px] border border-line bg-surface p-5 md:p-7">
      <span aria-hidden className="pointer-events-none absolute -right-24 -top-28 -z-10 h-72 w-72 rounded-full bg-brand/20 blur-[100px]" />
      <div className="grid gap-1">
        <h2 className="font-heading text-2xl">Build a report</h2>
        <p className="text-sm text-muted">Pick the client, the dates and the services. Each service is written for its buyer to approve, and the client gets one report.</p>
      </div>

      {/* 1. The client */}
      <div className="grid gap-2">
        <span className={label}>1 · Client</span>
        {picked ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-heading text-lg">{picked.name}</span>
            <button type="button" onClick={() => setPicked(null)} className="text-xs text-faint hover:text-fg max-md:min-h-11">
              Change
            </button>
          </div>
        ) : (
          <div className="grid gap-1.5 md:max-w-md">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your clients" autoFocus className="h-11 rounded-brand border border-line bg-bg px-3.5 text-sm outline-none focus:border-brand-text/60" />
            <ul className="grid gap-1">
              {matches.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => choose(c)} className="flex min-h-11 w-full items-center justify-between gap-3 rounded-[10px] px-3 py-2 text-left text-sm hover:bg-surface-2">
                    <span className="truncate">{c.name}</span>
                    <span className="shrink-0 text-xs text-faint">{c.services.map((s) => NAME[s.platform].replace(" Ads", "")).join(" · ")}</span>
                  </button>
                </li>
              ))}
              {!matches.length && <li className="px-3 py-2 text-sm text-faint">No client by that name with an ad account to report on.</li>}
            </ul>
          </div>
        )}
      </div>

      {picked && (
        <>
          {/* 2. The dates: as many ranges as the report needs */}
          <div className="grid gap-2">
            <span className={label}>2 · Dates · pick one or more</span>
            <div className="flex flex-wrap gap-2">
              {RANGES.map((r) => (
                <button key={r.key} type="button" onClick={() => toggle(ranges, setRanges, r.key)} className={chip(ranges.includes(r.key))} aria-pressed={ranges.includes(r.key)}>
                  {ranges.includes(r.key) && ranges.length > 1 ? `${ranges.indexOf(r.key) + 1}. ` : ""}
                  {r.label}
                </button>
              ))}
            </div>
            {ranges.includes("custom") && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <input type="date" value={custom.start} max={yesterday} onChange={(e) => setCustom({ ...custom, start: e.target.value })} className="h-10 rounded-brand border border-line bg-bg px-3 max-md:h-11" />
                <span className="text-faint">to</span>
                <input type="date" value={custom.end} max={yesterday} onChange={(e) => setCustom({ ...custom, end: e.target.value })} className="h-10 rounded-brand border border-line bg-bg px-3 max-md:h-11" />
              </div>
            )}
            {ranges.length > 1 && <p className="text-xs text-faint">The first one you picked leads the report; the others each get their own part.</p>}
          </div>

          {/* 3. The services: another buyer's is drafted for them to approve */}
          <div className="grid gap-2">
            <span className={label}>3 · Services</span>
            <div className="flex flex-wrap gap-2">
              {picked.services.map((s) => (
                <button key={s.platform} type="button" onClick={() => toggle(services, setServices, s.platform)} className={`${chip(services.includes(s.platform))} grid h-auto min-h-11 justify-items-start py-2 text-left`} aria-pressed={services.includes(s.platform)}>
                  <span>{NAME[s.platform]}</span>
                  <span className={`text-[11px] ${services.includes(s.platform) ? "text-bg/60" : "text-faint"}`}>{s.mine ? "You" : (s.owner ?? "No buyer set")}</span>
                </button>
              ))}
            </div>
            {others.length > 0 && (
              <p className="rounded-[12px] bg-surface-2 px-3.5 py-2.5 text-xs leading-relaxed text-muted">
                {others.map((o) => `${o.owner ?? "The buyer"} (${NAME[o.platform]})`).join(" and ")} will be asked to review and approve their part. It all goes to the client together, from the Kaizen app: one message and one PDF.
              </p>
            )}
          </div>

          {error && <p className="text-sm text-bad">{error}</p>}
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" disabled={pending || !ranges.length || !services.length || (ranges.includes("custom") && !custom.start)} onClick={build} className="h-12 rounded-brand bg-brand px-6 text-sm font-medium text-white shadow-[0_10px_30px_-12px_rgba(200,16,46,0.9)] hover:bg-brand-hover disabled:opacity-40 max-md:w-full">
              {pending ? "Building…" : "Build the report"}
            </button>
            <span className="text-xs text-faint">It&apos;s written in about a minute; you&apos;ll see it come together.</span>
          </div>
        </>
      )}
    </section>
  );
}
