import Link from "next/link";
import type { ReactNode } from "react";
import { GoogleIdField, KlaviyoKeyField } from "@/components/platform-fields";
import { freshness } from "@/lib/dates";
import { sentence, type PlainError } from "@/lib/google-health";
import type { GoogleRosterRow } from "@/lib/google-sync-health";
import type { KlaviyoRosterRow } from "@/lib/klaviyo/store";
import type { SocialRosterRow } from "@/lib/social/store";
import { LastRun, ProgressBar, RetryOne, SyncNowButton, type Progress, type RunState } from "./sync-buttons";
import type { SyncJob } from "./sync-actions";

// Settings › Sync health › Ad platforms: the Google Ads and Klaviyo cards. Each reads like the other sync cards (what's
// synced and how often, tracked / failing / behind, the last sync, Sync now) and opens on every client it should cover,
// worst first: synced, failing with the reason and the fix in plain words, or not connected with the field to connect
// it right there.

export type CardState = "failing" | "behind" | "ok" | "idle";
export type PlatformSummary = { tracked: number; failing: number; behind: number; missing: number; newest: string | null; state: CardState; failingLines: string[] };

const stateOf = (failing: number, behind: number, tracked: number): CardState => (failing ? "failing" : behind ? "behind" : tracked ? "ok" : "idle");

export function summarizeGoogle(rows: GoogleRosterRow[]): PlatformSummary {
  const accounts = rows.flatMap((r) => r.accounts.filter((a) => a.active).map((a) => ({ ...a, client: r.name })));
  const failing = accounts.filter((a) => a.state === "failing");
  const behind = accounts.filter((a) => a.state === "behind").length;
  const newest = accounts.map((a) => a.lastSync).filter(Boolean).sort().at(-1) ?? null;
  return { tracked: accounts.length, failing: failing.length, behind, missing: rows.filter((r) => r.state === "missing").length, newest, state: stateOf(failing.length, behind, accounts.length), failingLines: failing.map((a) => `${a.client} (${a.error?.message ?? "failing"})`) };
}

export function summarizeKlaviyo(rows: KlaviyoRosterRow[] | null): PlatformSummary {
  const list = rows ?? [];
  const tracked = list.filter((r) => r.state !== "missing");
  const failing = list.filter((r) => r.state === "failing");
  const behind = list.filter((r) => r.state === "behind").length;
  const newest = tracked.map((r) => r.lastSyncedAt).filter(Boolean).sort().at(-1) ?? null;
  return { tracked: tracked.length, failing: failing.length, behind, missing: list.length - tracked.length, newest, state: stateOf(failing.length, behind, tracked.length), failingLines: failing.map((r) => `${r.name} (${r.error?.message ?? "failing"})`) };
}

export function summarizeSocial(rows: SocialRosterRow[] | null): PlatformSummary {
  const list = rows ?? [];
  const tracked = list.filter((r) => r.state !== "missing");
  const failing = list.filter((r) => r.state === "failing");
  const behind = list.filter((r) => r.state === "behind").length;
  const newest = tracked.map((r) => r.lastSyncedAt).filter(Boolean).sort().at(-1) ?? null;
  return { tracked: tracked.length, failing: failing.length, behind, missing: list.length - tracked.length, newest, state: stateOf(failing.length, behind, tracked.length), failingLines: failing.map((r) => `${r.name} (${r.error?.message ?? "failing"})`) };
}

const DOT = { failing: "bg-bad", behind: "bg-warn", ok: "bg-ok", idle: "bg-line", synced: "bg-ok", connected: "bg-ok", pending: "bg-faint", missing: "bg-faint" } as const;

/** The card's frame: the same summary row and chips as every other sync card, opening on the client list */
function Card({ name, cadence, job, run, progress, summary, missingLabel, about, banner, children }: { name: string; cadence: string; job: SyncJob; run: RunState; progress: Progress; summary: PlatformSummary; missingLabel: string; about: string; banner?: ReactNode; children: ReactNode }) {
  const s = summary;
  return (
    <details className="group min-w-0 rounded-[16px] border border-line bg-surface transition-colors open:border-faint/50 hover:border-faint/40">
      <summary className="grid cursor-pointer list-none gap-3 p-4">
        <span className="flex items-start justify-between gap-3">
          <span className="grid min-w-0 gap-0.5">
            <span className="flex items-center gap-2">
              <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[s.state]}`} />
              <span className="truncate font-heading text-[15px]">{name}</span>
            </span>
            <span className="pl-4 text-[11px] text-faint">{cadence}</span>
          </span>
          <SyncNowButton job={job} run={run} progress={progress} />
        </span>
        <span className="flex flex-wrap items-center gap-1.5 pl-4 text-[11px]">
          <span className="rounded-full bg-surface-2 px-2 py-0.5 tabular text-muted">{s.tracked} tracked</span>
          {s.failing > 0 && <span className="rounded-full bg-bad/10 px-2 py-0.5 text-bad">{s.failing} failing</span>}
          {s.behind > 0 && <span className="rounded-full bg-warn/10 px-2 py-0.5 text-warn">{s.behind} behind</span>}
          {s.missing > 0 && (
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-muted">
              {s.missing} {missingLabel}
            </span>
          )}
          <span className="text-faint">{s.newest ? freshness(s.newest).label.toLowerCase() : "not run yet"}</span>
          <span className="ml-auto text-faint transition-transform group-open:rotate-180" aria-hidden>
            ⌄
          </span>
        </span>
        <ProgressBar progress={progress} />
      </summary>
      <div className="grid gap-2 border-t border-line px-3 py-3">
        <div className="grid gap-0.5 px-1">
          <p className="text-[11px] text-faint">{about}</p>
          <LastRun run={run} />
        </div>
        {banner}
        <ul className="grid max-h-[32rem] divide-y divide-line overflow-y-auto rounded-[12px] border border-line [scrollbar-width:thin]">{children}</ul>
      </div>
    </details>
  );
}

/** One client's line: the dot, the name (to their Team & setup), what's true now, and what to do on the right */
function Row({ dot, name, slug, anchor, href, meta, status, error, tone, action }: { dot: keyof typeof DOT; name: string; slug: string; anchor?: string; href?: string; meta?: string | null; status: ReactNode; error?: PlainError | null; tone?: "bad" | "warn" | "muted"; action?: ReactNode }) {
  return (
    <li className="grid gap-2 px-3 py-2.5 text-xs md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:gap-4">
      <span className="flex min-w-0 items-start gap-2.5">
        <span className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${DOT[dot]}`} aria-hidden />
        <span className="grid min-w-0 gap-0.5">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <Link href={href ?? `/clients/${slug}?tab=team${anchor ? `#${anchor}` : ""}`} className="min-w-0 truncate text-[13px] text-fg/90 underline-offset-2 hover:underline">
              {name}
            </Link>
            {meta && <span className="tabular min-w-0 truncate text-[11px] text-faint">{meta}</span>}
          </span>
          <span className={`text-[11.5px] leading-snug ${tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : "text-muted"}`}>{status}</span>
          {error && <span className="text-[11.5px] leading-snug text-muted">{error.fix}</span>}
        </span>
      </span>
      {action && <span className="flex min-w-0 flex-wrap items-center gap-2 pl-4 md:justify-end md:pl-0">{action}</span>}
    </li>
  );
}

const ago = (iso: string | null) => (iso ? freshness(iso).label : "Not synced yet");

export function GoogleAdsCard({ rows, run, progress, summary, setupError }: { rows: GoogleRosterRow[]; run: RunState; progress: Progress; summary: PlatformSummary; setupError: PlainError | null }) {
  return (
    <Card
      name="Google Ads"
      cadence="Per account · every 30 min (business hours), hourly otherwise"
      job="google"
      run={run}
      progress={progress}
      summary={summary}
      missingLabel="not connected"
      about="Each client's campaign numbers per day, read through Kaizen's manager account with the KPI numbers. Every client that runs Google (the service, or a Google KPI) is listed; one without a customer ID can be connected right here."
      banner={
        setupError && (
          <p className="rounded-[12px] border border-bad/30 bg-bad-soft px-3 py-2 text-[12px] leading-relaxed">
            <span className="text-bad">{sentence(setupError.message)}</span> <span className="text-muted">{setupError.fix}</span>
          </p>
        )
      }
    >
      {rows.length === 0 && <li className="px-3 py-3 text-xs text-faint">No live client runs Google Ads.</li>}
      {rows.map((r) => {
        const ids = r.accounts.filter((a) => a.active).map((a) => a.id).join(", ");
        const worst = r.accounts.find((a) => a.active && a.state === r.state);
        const retry = worst && (r.state === "failing" || r.state === "behind") ? <RetryOne source={`kpi:${worst.id.replace(/\D/g, "")}`} /> : null;
        if (r.state === "missing") return <Row key={r.id} dot="missing" name={r.name} slug={r.slug} status="Not connected: no Google Ads customer ID on file" action={<GoogleIdField clientId={r.id} compact />} />;
        if (r.state === "failing")
          return <Row key={r.id} dot="failing" name={r.name} slug={r.slug} meta={ids} tone="bad" status={sentence(r.error?.message ?? "The last sync failed")} error={setupError ? null : r.error} action={retry} />;
        if (r.state === "behind") return <Row key={r.id} dot="behind" name={r.name} slug={r.slug} meta={ids} tone="warn" status={`${ago(r.lastSync)}. No successful sync in over a day.`} action={retry} />;
        if (r.state === "pending") return <Row key={r.id} dot="pending" name={r.name} slug={r.slug} meta={ids} status="Waiting for its first sync" />;
        return <Row key={r.id} dot="synced" name={r.name} slug={r.slug} meta={ids} status={ago(r.lastSync)} />;
      })}
    </Card>
  );
}

const ORDER = { failing: 0, missing: 1, behind: 2, pending: 3, connected: 4 } as const;

export function KlaviyoSyncCard({ rows, run, progress, summary }: { rows: KlaviyoRosterRow[] | null; run: RunState; progress: Progress; summary: PlatformSummary }) {
  const list = [...(rows ?? [])].sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name));
  return (
    <Card
      name="Klaviyo"
      cadence="Per client · every 30 min (business hours), hourly otherwise · full read daily"
      job="klaviyo"
      run={run}
      progress={progress}
      summary={summary}
      missingLabel="missing"
      about="Each client's email and SMS, read only: every run reads today and yesterday's totals, the last 7 days' campaigns and each flow's 30 days; once a day the full 120 days, lists and segments. Six clients at a time, each within Klaviyo's limits for its own account."
      banner={!rows && <p className="rounded-[12px] border border-line px-3 py-2 text-[12px] text-faint">Klaviyo isn&apos;t set up in the database yet: its migration hasn&apos;t been applied.</p>}
    >
      {rows && list.length === 0 && <li className="px-3 py-3 text-xs text-faint">No live clients.</li>}
      {list.map((r) => {
        const meta = r.state === "missing" ? null : [r.account, r.last4 ? `key ••••${r.last4}` : null].filter(Boolean).join(" · ");
        const retry = <RetryOne source={`klaviyo:${r.id}`} />;
        if (r.state === "missing") return <Row key={r.id} dot="missing" name={r.name} slug={r.slug} anchor="klaviyo" status="Not connected" action={<KlaviyoKeyField clientId={r.id} />} />;
        if (r.state === "failing")
          return (
            <Row
              key={r.id}
              dot="failing"
              name={r.name}
              slug={r.slug}
              anchor="klaviyo"
              meta={meta}
              tone="bad"
              status={sentence(r.error?.message ?? "The last read failed")}
              error={r.error}
              action={
                <>
                  {retry}
                  <KlaviyoKeyField clientId={r.id} label="Replace key" />
                </>
              }
            />
          );
        const read = r.lastSyncedAt ? `Read ${freshness(r.lastSyncedAt, "").label.trim()}${r.window ? ` (${r.window === "full" ? "full" : "recent"})` : ""}` : "First read running";
        const note = r.error?.severity === "warn" ? ` · ${sentence(r.error.message)}` : "";
        if (r.state === "behind") return <Row key={r.id} dot="behind" name={r.name} slug={r.slug} anchor="klaviyo" meta={meta} tone="warn" status={`${read}. No successful read in over a day.`} action={retry} />;
        return <Row key={r.id} dot={r.state === "pending" ? "pending" : "connected"} name={r.name} slug={r.slug} anchor="klaviyo" meta={meta} tone={note ? "warn" : "muted"} status={`${read}${note}`} error={note ? r.error : null} />;
      })}
    </Card>
  );
}

export function SocialSyncCard({ rows, run, progress, summary }: { rows: SocialRosterRow[] | null; run: RunState; progress: Progress; summary: PlatformSummary }) {
  const list = [...(rows ?? [])].sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name));
  return (
    <Card
      name="Social"
      cadence="Per client · every 3 hours · full read daily"
      job="social"
      run={run}
      progress={progress}
      summary={summary}
      missingLabel="no Page linked"
      about="Each organic social client's Facebook Page and Instagram account, read only through the Meta system user: followers, reach, views, engagement and recent posts, 90 days on the first read and every day after. A client without a Page or Instagram account linked is listed first; pick theirs on its Social tab. A missing Meta permission shows by name with what to add."
      banner={!rows && <p className="rounded-[12px] border border-line px-3 py-2 text-[12px] text-faint">Social isn&apos;t set up in the database yet: its migration hasn&apos;t been applied.</p>}
    >
      {rows && list.length === 0 && <li className="px-3 py-3 text-xs text-faint">No live clients on social media.</li>}
      {list.map((r) => {
        const href = `/clients/${r.slug}?service=social`;
        const meta = r.state === "missing" ? null : [r.page, r.instagram ? `@${r.instagram}` : null].filter(Boolean).join(" · ");
        const retry = <RetryOne source={`social:${r.id}`} />;
        if (r.state === "missing")
          return (
            <Row
              key={r.id}
              dot="missing"
              name={r.name}
              slug={r.slug}
              href={href}
              tone={r.error ? "bad" : "muted"}
              status={r.error ? sentence(r.error.message) : "No Facebook Page or Instagram account linked"}
              error={r.error}
              action={
                <Link href={href} className="inline-flex min-h-11 items-center rounded-full bg-surface-2 px-3 text-xs text-fg hover:bg-line/50 md:min-h-0 md:px-2.5 md:py-1 md:text-[11px]">
                  Link accounts
                </Link>
              }
            />
          );
        if (r.state === "failing") return <Row key={r.id} dot="failing" name={r.name} slug={r.slug} href={href} meta={meta} tone="bad" status={sentence(r.error?.message ?? "The last read failed")} error={r.error} action={retry} />;
        const read = r.lastSyncedAt ? `Read ${freshness(r.lastSyncedAt, "").label.trim()}${r.window ? ` (${r.window === "full" ? "full" : "recent"})` : ""}` : "First read running";
        if (r.state === "behind") return <Row key={r.id} dot="behind" name={r.name} slug={r.slug} href={href} meta={meta} tone="warn" status={`${read}. No successful read in over a day.`} action={retry} />;
        return <Row key={r.id} dot={r.state === "pending" ? "pending" : "connected"} name={r.name} slug={r.slug} href={href} meta={meta} tone="muted" status={`${read}${r.source === "manual" ? " · linked by hand" : ""}`} />;
      })}
    </Card>
  );
}
