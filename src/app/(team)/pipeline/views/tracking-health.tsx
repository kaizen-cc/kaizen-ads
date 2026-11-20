"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import type { HealthRow } from "@/lib/tracking-health";
import { pushParams, useParam } from "@/lib/url-state";

// The Tracking Specialist's Tracking tab (?tab=tracking): every client that buys paid ads, worst first, with its health,
// why, days since onboarding, open requests and when it was last checked. Tap a client for the evidence (?client=<slug>,
// so back closes it) and a way to the client.

const STATUS: Record<HealthRow["health"]["status"], string> = { issue: "Potential issue", not_set_up: "Not set up", ok: "OK" };
const TIER_TONE: Record<string, string> = { critical: "bg-bad-soft text-bad", high: "bg-warn-soft text-warn", normal: "bg-ink/[0.06] text-muted", ok: "bg-ok-soft text-ok" };
const TIER_WORD: Record<string, string> = { critical: "Critical", high: "Important", normal: "Worth a look" };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) : "not yet");

export function TrackingHealth({ rows }: { rows: HealthRow[] }) {
  const open = useParam("client");
  const issues = rows.filter((r) => r.health.tier === "critical" || r.health.tier === "high").length;
  const critical = rows.filter((r) => r.health.tier === "critical").length;
  if (!rows.length) return <p className="rounded-[16px] border border-dashed border-line px-4 py-5 text-sm text-muted">No active client buys paid ads right now.</p>;
  return (
    <section className="grid gap-4" aria-labelledby="tracking-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="tracking-title" className="font-heading text-xl">
          Tracking health
        </h2>
        <span className="text-xs text-faint">
          {rows.length} clients on paid ads · {critical ? <span className="text-bad">{critical} critical · </span> : null}
          {issues} need you · worst first
        </span>
      </div>
      <ul className="grid gap-2">
        {rows.map((r) => (
          <Row key={r.clientId} r={r} expanded={open === r.slug} />
        ))}
      </ul>
    </section>
  );
}

function Row({ r, expanded }: { r: HealthRow; expanded: boolean }) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (expanded) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [expanded]);
  const tone = r.health.status === "ok" ? "ok" : (r.health.tier ?? "normal");
  return (
    <li ref={ref} className={`overflow-hidden rounded-[18px] border bg-surface ${expanded ? "border-ink/25" : "border-line"}`}>
      <button type="button" onClick={() => pushParams({ client: expanded ? null : r.slug })} aria-expanded={expanded} className="grid w-full gap-1.5 px-4 py-3 text-left hover:bg-ink/[0.03] md:grid-cols-[minmax(0,1.2fr)_minmax(0,2fr)_auto] md:items-center md:gap-4">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-fg">{r.client}</span>
        </span>
        <span className="min-w-0 truncate text-[12.5px] text-muted">{r.health.why[0] ?? "Tracking set up, nothing flagged"}</span>
        <span className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
          <span className={`rounded-full px-2 py-0.5 ${TIER_TONE[tone]}`}>
            {STATUS[r.health.status]}
            {r.health.tier && r.health.status !== "ok" ? ` · ${TIER_WORD[r.health.tier]}` : ""}
          </span>
          <span className="rounded-full bg-ink/[0.06] px-2 py-0.5 text-muted">{r.health.daysOnboarded}d onboarded</span>
          {r.requests.length > 0 && <span className="rounded-full bg-ink/[0.06] px-2 py-0.5 text-muted">{r.requests.length} request{r.requests.length === 1 ? "" : "s"}</span>}
        </span>
      </button>
      {expanded && (
        <div className="grid gap-3 border-t border-line px-4 pb-4 pt-3">
          {r.health.why.length > 0 && (
            <ul className="grid gap-1 text-[13px]">
              {r.health.why.map((w) => (
                <li key={w} className="flex gap-2">
                  <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-ink/40" />
                  {w}
                </li>
              ))}
            </ul>
          )}
          {r.flags.map((f) => (
            <div key={f.id} className="grid gap-0.5 rounded-[12px] bg-ink/[0.04] px-3 py-2">
              <span className="text-[13px] font-medium text-fg">{f.title}</span>
              {f.body && <span className="whitespace-pre-wrap text-[12.5px] text-muted">{f.body}</span>}
            </div>
          ))}
          <p className="text-[12px] text-faint">Last checked {when(r.lastChecked)}</p>
          <div className="flex flex-wrap gap-2">
            <Link href={`/clients/${r.slug}?tab=onboarding`} className="inline-flex min-h-11 items-center rounded-full bg-fg px-4 text-[13px] font-medium text-bg md:min-h-9">
              Open {r.client}
            </Link>
            {r.flags.length > 0 && (
              <Link href={`/watch?tab=dogs&client=${r.slug}`} className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[13px] text-muted hover:text-fg md:min-h-9">
                The evidence
              </Link>
            )}
            {r.requests.length > 0 && (
              <Link href="/pipeline#next" className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[13px] text-muted hover:text-fg md:min-h-9">
                The requests
              </Link>
            )}
          </div>
        </div>
      )}
    </li>
  );
}
