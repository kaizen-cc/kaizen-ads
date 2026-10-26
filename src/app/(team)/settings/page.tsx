import { GoogleWriteCard, MetaWriteCard } from "./meta-write-card";
import { DEFAULT_URL_TAGS, metaWriteSetting } from "@/lib/meta-write";
import Link from "next/link";
import { redirect } from "next/navigation";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { daysAgoIso, freshness } from "@/lib/dates";
import { nyParts } from "@/lib/kpi/calc";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { ChatMessage, Change, RoleChatMessage } from "./actions";
import { AgentDetail, RoleDetail, RolesOverview, type Agent, type Item, type Role } from "./agents";
import { DataInspector } from "./data-inspector";
import { AGENT_MOMENTS, momentOf } from "@/lib/agent-moments";
import Team from "../team/page";
import { ErrorButtons } from "./error-buttons";
import { DeletedTicketRow, type DeletedTicket } from "./deleted-ticket";
import { STAGES } from "@/lib/stages";
import { LastRun, ProgressBar, RetryOne, SyncNowButton, type Progress, type RunState } from "./sync-buttons";
import type { SyncJob } from "./sync-actions";

// Inspecting a big ad account reads a few thousand rows; Sync now runs a whole job in the background
export const maxDuration = 800;

const TABS = [
  ["agents", "AI agents"],
  ["team", "Team"],
  ["data", "Raw data"],
  ["sync", "Sync health"],
  ["errors", "Errors"],
  ["deleted", "Deleted"],
] as const;
// Leads see the team and the deleted log; execs see everything
const LEAD_TABS = ["team", "deleted"];

const day = (offset: number) => {
  const d = new Date(`${nyParts(new Date()).date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

async function Agents({ open, role: openRole }: { open: string | null; role: string | null }) {
  const supabase = await createClient();
  const since = daysAgoIso(7);
  const [{ data: agents }, { data: knowledge }, { data: month }, { data: roleRows }, { data: spineRow }, { data: chats }, { data: roleChats }] = await Promise.all([
    supabase.from("ai_agents").select("*, profiles(full_name)").order("sort_order"),
    supabase.from("ai_knowledge").select("*").order("created_at"),
    supabase.from("ai_runs").select("agent_key, label, model, ms, input_tokens, output_tokens, ok, error, created_at").gte("created_at", daysAgoIso(30)).order("created_at", { ascending: false }).limit(5000),
    supabase.from("ai_roles").select("*, profiles(full_name)").order("sort_order"),
    supabase.from("ai_spine").select("body, updated_at, profiles(full_name)").eq("id", 1).maybeSingle(),
    supabase.from("ai_agent_chats").select("agent_key, changes").eq("role", "coach").gte("created_at", daysAgoIso(90)),
    supabase.from("ai_role_chats").select("role_key, changes").eq("role", "agent").gte("created_at", daysAgoIso(90)),
  ]);
  // Edits an agent proposed in its own chat that nobody has applied yet
  const roleProposals = new Map<string, number>();
  for (const c of roleChats ?? []) {
    const open = ((c.changes ?? []) as { applied?: boolean }[]).filter((x) => !x.applied).length;
    if (open) roleProposals.set(c.role_key, (roleProposals.get(c.role_key) ?? 0) + open);
  }
  const roles: Role[] = (roleRows ?? []).map((r) => ({
    key: r.key,
    label: r.label,
    description: r.description,
    icon: r.icon,
    core: r.core,
    updatedAt: r.updated_at,
    updatedBy: (r.profiles as unknown as { full_name: string } | null)?.full_name ?? null,
    proposals: roleProposals.get(r.key) ?? 0,
  }));
  // Edits the Coach or the Ads Lab proposed that nobody has applied yet
  const proposals = new Map<string, number>();
  for (const c of chats ?? []) {
    const open = ((c.changes ?? []) as { applied?: boolean }[]).filter((x) => !x.applied).length;
    if (open) proposals.set(c.agent_key, (proposals.get(c.agent_key) ?? 0) + open);
  }
  const runs = (month ?? []).filter((r) => r.created_at >= since);
  // When each agent last ran, even if it was over a month ago
  const lastEver = new Map<string, string>();
  for (const r of month ?? []) if (!lastEver.has(r.agent_key)) lastEver.set(r.agent_key, r.created_at);
  const quiet = (agents ?? []).filter((a) => !lastEver.has(a.key)).map((a) => a.key as string);
  await Promise.all(
    quiet.map(async (k) => {
      const { data } = await supabase.from("ai_runs").select("created_at").eq("agent_key", k).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (data) lastEver.set(k, data.created_at);
    }),
  );
  const list: Agent[] = (agents ?? []).map((a) => {
    const mine = runs.filter((r) => r.agent_key === a.key);
    const mineMonth = (month ?? []).filter((r) => r.agent_key === a.key);
    const timed = mine.filter((r) => r.ms != null && r.ok);
    return {
      key: a.key,
      roleKey: a.role_key,
      roleLabel: roles.find((r) => r.key === a.role_key)?.label ?? null,
      proposals: proposals.get(a.key) ?? 0,
      label: a.label,
      description: a.description,
      model: a.model,
      effort: a.effort,
      icon: a.icon,
      instructions: a.instructions,
      live: a.live,
      updatedAt: a.updated_at,
      updatedBy: (a.profiles as unknown as { full_name: string } | null)?.full_name ?? null,
      stats: {
        runs: mine.length,
        avgMs: timed.length ? Math.round(timed.reduce((t, r) => t + r.ms!, 0) / timed.length) : null,
        inTokens: mine.reduce((t, r) => t + (r.input_tokens ?? 0), 0),
        outTokens: mine.reduce((t, r) => t + (r.output_tokens ?? 0), 0),
        failed: mine.filter((r) => !r.ok).length,
      },
      lastAt: lastEver.get(a.key) ?? null,
      // Every moment in the app that calls it, with how often each ran this week and when it last did
      moments: (AGENT_MOMENTS[a.key] ?? []).map((m) => {
        const hits = mineMonth.filter((r) => momentOf(a.key, r.label) === m);
        return { title: m.title, where: m.where, trigger: m.trigger, when: m.when, runs7: hits.filter((r) => r.created_at >= since).length, lastAt: hits[0]?.created_at ?? null };
      }),
      recent: mineMonth.slice(0, 15).map((r) => ({
        at: r.created_at,
        moment: momentOf(a.key, r.label)?.title ?? null,
        label: r.label ?? a.key,
        model: r.model ?? "",
        ms: r.ms,
        tokens: r.input_tokens != null ? `${r.input_tokens.toLocaleString()} in · ${(r.output_tokens ?? 0).toLocaleString()} out` : "—",
        ok: r.ok,
        error: r.error,
      })),
    };
  });
  const items: Item[] = (knowledge ?? []).map((k) => ({
    id: k.id,
    agentKey: k.agent_key,
    kind: k.kind,
    title: k.title,
    body: k.body,
    fileName: k.file_name,
    active: k.active,
    updatedAt: k.updated_at,
  }));
  const agent = list.find((a) => a.key === open);
  const role = roles.find((r) => r.key === openRole);
  if (!agent && role) {
    const { data: talk } = await supabase.from("ai_role_chats").select("id, role, content, changes, created_at").eq("role_key", role.key).order("created_at").limit(200);
    const chat: RoleChatMessage[] = (talk ?? []).map((m) => ({ id: m.id, role: m.role, content: m.content, changes: (m.changes ?? []) as Change[], at: m.created_at }));
    return <RoleDetail key={role.key} role={role} skills={list.filter((a) => a.roleKey === role.key)} items={items} chat={chat} />;
  }
  if (!agent)
    return (
      <RolesOverview
        roles={roles}
        agents={list.filter((a) => a.roleKey)}
        items={items}
        spine={{ body: spineRow?.body ?? "", updatedAt: spineRow?.updated_at ?? null, updatedBy: (spineRow?.profiles as unknown as { full_name: string } | null)?.full_name ?? null }}
      />
    );
  const { data: chat } = await supabase.from("ai_agent_chats").select("id, role, content, changes, created_at").eq("agent_key", agent.key).order("created_at").limit(200);
  const messages: ChatMessage[] = (chat ?? []).map((m) => ({ id: m.id, role: m.role, content: m.content, changes: (m.changes ?? []) as Change[], at: m.created_at }));
  return <AgentDetail key={agent.key} a={agent} items={items} chat={messages} />;
}

async function Data({ target, from, to }: { target: string | null; from: string; to: string }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("kpi_targets")
    .select("id, platform, ad_account_id, label, conversion, custom_action, campaign_match, target, monthly_budget, clients!inner(name)")
    .eq("active", true)
    .is("clients.archived_at", null);
  const targets = (data ?? [])
    .map((t) => ({ ...t, client: (t.clients as unknown as { name: string } | null)?.name ?? "Unknown", target: t.target == null ? null : Number(t.target), monthly_budget: t.monthly_budget == null ? null : Number(t.monthly_budget) }))
    .sort((a, b) => a.client.localeCompare(b.client));
  return <DataInspector targets={targets} targetId={target} from={from} to={to} />;
}

// [source prefix, name, the job Sync now runs, what it does]
/** prefix, name, job, what it does, category, how often (short) */
const GROUPS: [string, string, SyncJob, string, string, string][] = [
  ["kpi:", "KPI numbers", "kpi", "Campaign numbers for the KPI dashboard, per ad account, every 2 hours", "ads", "Per ad account · every 2 hours"],
  ["meta", "Meta ads", "meta", "Every ad's daily numbers, then fatigue, winners and the Hall of Fame, every 2 hours", "ads", "Daily, per ad · every 2 hours"],
  ["slack", "Slack channels", "slack", "Client and internal channels, every 30 minutes in business hours", "talk", "Every 30 min · business hours"],
  ["gmail:", "Inboxes", "gmail", "Mail with client contacts in every team inbox, every 30 minutes in business hours", "talk", "Every 30 min · business hours"],
  ["calls", "Call notes", "calls", "Gemini and Fireflies notes from every team: what clients said goes on their page, paid ads promises go to Home. Every 30 minutes in business hours", "talk", "Every 30 min · business hours"],
  ["drive", "Drive folders", "drive", "Each client's Drive folder: new files and the asset catalogue, every 30 minutes in business hours", "files", "Every 30 min · business hours"],
  ["docs", "Workspace docs", "docs", "New and edited Google Docs and Slides in everyone's Drive, read for the client they're about, every 30 minutes", "files", "Every 30 min"],
  ["sheet", "Account Overview sheet", "sheet", "Buyer, budget and KPI target for every account, and the team's notes, at 12pm and 5pm", "ops", "12pm and 5pm"],
  ["asana", "Asana", "asana", "Open tasks on Asana's Creative board, mirrored on the board as outline cards, every 5 minutes", "ops", "Every 5 min"],
  ["verticals", "Verticals and playbooks", "verticals", "Places new clients, researches benchmarks and writes playbooks, hourly", "ai", "Hourly"],
];

/** The sections of Sync health, by what the data is */
const CATEGORIES = [
  { key: "ads", label: "Ad platforms", about: "Numbers and ads from Meta and Google, and the market from Motion" },
  { key: "talk", label: "Conversations", about: "What clients and the team say: Slack, email and calls" },
  { key: "files", label: "Files and docs", about: "Client folders, assets and the docs written about them" },
  { key: "ops", label: "Operations", about: "Who runs what, and the work still in Asana" },
  { key: "ai", label: "AI knowledge", about: "What the agents learn across clients" },
];

type ErrorRow = {
  fingerprint: string;
  message: string;
  path: string | null;
  kind: string;
  count: number;
  people: string[];
  sample: { stack?: string | null; digest?: string | null; userAgent?: string | null } | null;
  first_seen: string;
  last_seen: string;
  resolved_at: string | null;
  diagnosis: { summary?: string; cause?: string; impact?: string; fix?: string; handled?: string; severity?: string; dataRisk?: boolean } | null;
  auto_resolved: boolean;
  muted_at: string | null;
  fix_issue_url: string | null;
};

const at = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Every error someone hit, grouped, diagnosed and tracked: open first, with what happened and what would fix it. */
async function Errors({ all }: { all: boolean }) {
  if (!adminConfigured()) return <p className="text-sm text-faint">Server key missing.</p>;
  let q = createAdminClient().from("error_events").select("*").order("last_seen", { ascending: false }).limit(100);
  if (!all) q = q.is("resolved_at", null);
  const { data } = await q;
  const rows = (data ?? []) as ErrorRow[];
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm text-muted">
          Every error someone hits in Kaizen Ads, on a page, a button or in the background. Harmless ones (a dropped connection, a tab on an old version) are explained and
          closed automatically. Real ones get a diagnosis, and you&apos;re emailed the first time, then at most hourly while it keeps happening.
        </p>
        <Link href={all ? "/settings?tab=errors" : "/settings?tab=errors&show=all"} className="inline-flex h-11 shrink-0 items-center rounded-full border border-line px-4 text-xs text-muted hover:text-fg md:h-auto md:rounded-none md:border-0 md:px-0">
          {all ? "Open only" : "Include resolved"}
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-[12px] border border-dashed border-line p-10 text-center text-sm text-muted">No open errors.</p>
      ) : (
        <ul className="grid grid-cols-[minmax(0,1fr)] gap-3">
          {rows.map((r) => (
            <li key={r.fingerprint} className={`min-w-0 rounded-[12px] border border-line bg-surface p-4 ${r.resolved_at ? "opacity-60" : ""}`}>
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="break-words font-medium">{r.diagnosis?.summary ?? r.message}</p>
                  {r.diagnosis?.summary && <p className="mt-0.5 break-words font-mono text-[11px] text-faint">{r.message}</p>}
                  <p className="mt-1 text-xs text-muted [overflow-wrap:anywhere]">
                    {r.path ?? "unknown page"} · {r.kind} · <span className="tabular">{r.count}×</span> · last {at(r.last_seen)} · first {at(r.first_seen)}
                  </p>
                  {r.people.length > 0 && <p className="mt-0.5 text-xs text-faint">Hit by {r.people.join(", ")}</p>}
                </div>
                <span className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 md:w-auto md:shrink-0 md:flex-col md:flex-nowrap md:items-end md:gap-1">
                  {r.auto_resolved ? (
                    <span className="rounded-full bg-ok-soft px-2 py-0.5 text-[11px] text-ok">Auto-handled</span>
                  ) : r.muted_at ? (
                    <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-faint">Muted</span>
                  ) : r.resolved_at ? (
                    <span className="text-xs text-faint">Resolved</span>
                  ) : (
                    <ErrorButtons fingerprint={r.fingerprint} fixing={Boolean(r.fix_issue_url)} />
                  )}
                  {r.diagnosis?.severity && !r.auto_resolved && (
                    <span className={`text-[11px] ${r.diagnosis.severity === "high" ? "text-bad" : r.diagnosis.severity === "low" ? "text-faint" : "text-warn"}`}>
                      {r.diagnosis.severity} severity{r.diagnosis.dataRisk ? " · data may be affected" : ""}
                    </span>
                  )}
                  {r.fix_issue_url && (
                    <a href={r.fix_issue_url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center text-[11px] text-brand-text hover:underline md:min-h-0">
                      Claude&apos;s fix →
                    </a>
                  )}
                </span>
              </div>
              {r.diagnosis?.cause && (
                <dl className="mt-3 grid gap-x-4 gap-y-1 rounded-[10px] bg-bg/60 p-3 text-xs sm:grid-cols-[auto_minmax(0,1fr)]">
                  <dt className="text-faint">Why</dt>
                  <dd className="mb-1.5 text-muted sm:mb-0">{r.diagnosis.cause}</dd>
                  {r.diagnosis.impact && (
                    <>
                      <dt className="text-faint">Impact</dt>
                      <dd className="text-muted">{r.diagnosis.impact}</dd>
                    </>
                  )}
                  {r.diagnosis.fix && (
                    <>
                      <dt className="text-faint">What would fix it</dt>
                      <dd className="text-muted">{r.diagnosis.fix}</dd>
                    </>
                  )}
                  {r.diagnosis.handled && (
                    <>
                      <dt className="text-faint">What was done</dt>
                      <dd className="text-muted">{r.diagnosis.handled}</dd>
                    </>
                  )}
                </dl>
              )}
              {r.sample?.stack && (
                <details className="mt-2">
                  <summary className="cursor-pointer py-3 text-xs text-muted hover:text-fg md:py-0">Technical details</summary>
                  <pre className="mt-2 overflow-x-auto rounded-[10px] bg-bg p-3 text-[11px] text-muted">{r.sample.stack}</pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

async function MotionCard({ notice }: { notice: string | null }) {
  const admin = createAdminClient();
  const [{ data: m }, { count: brands }, { count: ads }, { count: matched }, { data: runRow }] = await Promise.all([
    admin.from("motion_connection").select("access_token, connected_at, last_sync_at, last_result, error, profiles(full_name)").eq("id", 1).maybeSingle(),
    admin.from("market_brands").select("id", { count: "exact", head: true }).eq("rejected", false).not("checked_at", "is", null),
    admin.from("market_ads").select("id", { count: "exact", head: true }).neq("active", false),
    admin.from("clients").select("id", { count: "exact", head: true }).not("market_matched_at", "is", null),
    admin.from("sync_state").select("last_result").eq("source", "run:market").maybeSingle(),
  ]);
  const run = timedOut((runRow?.last_result ?? null) as RunState);
  const progress = progressOf("market", run);
  const on = Boolean(m?.access_token);
  const r = (m?.last_result ?? null) as { brands?: number; pulled?: number; read?: number; brandsFound?: number; checked?: number; sorted?: number; clientsMatched?: number; errors?: string[] } | null;
  const fresh = freshness(m?.last_sync_at);
  const failing = !on || Boolean(m?.error);
  const by = (m?.profiles as unknown as { full_name: string } | null)?.full_name;
  const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return (
    <details className="group rounded-[14px] border border-line bg-surface" open={Boolean(notice) || !on}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 px-4 py-4 md:px-6">
        <span className="flex items-center gap-3">
          <span className={`h-2 w-2 rounded-full ${failing ? "bg-bad" : fresh.tone !== "ok" ? "bg-warn" : "bg-ok"}`} />
          <span className="font-heading text-[16px]">Motion (Market)</span>
        </span>
        <span className="text-xs text-muted">
          {on ? (
            <>
              <span className="tabular">{(brands ?? 0).toLocaleString("en-US")}</span> brands · <span className="tabular">{(ads ?? 0).toLocaleString("en-US")}</span> live ads
              {m?.error && <span className="text-bad"> · failing</span>}
              {!m?.error && fresh.tone !== "ok" && <span className="text-warn"> · behind</span>}
              <span className="text-faint"> · {fresh.label.toLowerCase()}</span>
            </>
          ) : (
            <span className="text-bad">Not connected</span>
          )}
        </span>
        <ProgressBar progress={progress} />
      </summary>
      <div className="grid gap-3 border-t border-line px-4 py-4 md:px-6">
        {notice && !progress && notice !== "syncing" && (
          <p className={`text-xs ${notice === "connected" ? "text-ok" : "text-bad"}`}>
            {notice === "connected" ? "Connected. The first market sync is running now." : notice === "syncing" ? "The market sync is running. It takes a few minutes; refresh to see the result." : notice}
          </p>
        )}
        {m?.error && <p className="text-xs text-bad">{m.error}</p>}
        <dl className="grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-[auto_minmax(0,1fr)]">
          <dt className="text-faint">Connection</dt>
          <dd className="text-muted">{on ? `Kaizen's Motion account${by ? `, connected by ${by}` : ""}${m?.connected_at ? ` on ${when(m.connected_at)}` : ""}` : "Not connected"}</dd>
          <dt className="text-faint">Last sync</dt>
          <dd className="text-muted">
            {m?.last_sync_at ? when(m.last_sync_at) : "Not yet"}
            {r && ` · ${r.brands ?? 0} brands pulled, ${(r.pulled ?? 0).toLocaleString("en-US")} ads, ${r.read ?? 0} read by the AI`}
            {r?.sorted ? `, ${r.sorted} brands described` : ""}
            {r?.checked ? `, ${r.checked} brands checked` : ""}
            {r?.clientsMatched ? `, ${r.clientsMatched} clients matched` : ""}
          </dd>
          <dt className="text-faint">Clients matched</dt>
          <dd className="text-muted">
            <span className="tabular">{matched ?? 0}</span> live clients have their comparable brands worked out (refreshed weekly)
          </dd>
          {r?.errors?.length ? (
            <>
              <dt className="text-faint">Hiccups</dt>
              <dd className="text-warn">{r.errors.length} on the last run (a slow answer from Motion; those brands go first next time)</dd>
            </>
          ) : null}
        </dl>
        <div className="flex flex-wrap gap-2">
          {on && (
            <a href="/api/motion/sync" className="grid h-11 place-items-center rounded-full bg-fg px-4 text-xs text-bg md:h-8 md:px-3.5">
              Sync now
            </a>
          )}
          <a href="/api/motion/connect" className={`grid h-11 place-items-center rounded-full px-4 text-xs md:h-8 md:px-3.5 ${on ? "border border-line text-muted hover:text-fg" : "bg-brand font-medium text-white hover:brightness-110"}`}>
            {on ? "Reconnect" : "Connect Motion"}
          </a>
        </div>
      </div>
    </details>
  );
}

const olderThan = (iso: string, ms: number) => Date.now() - Date.parse(iso) > ms;
/** A run still "running" with no word from it for 15 minutes timed out (the server stopped it). */
const timedOut = (x: RunState): RunState =>
  x?.running && (!x.startedAt || olderThan(x.startedAt, 15 * 60_000)) ? { ...x, running: false, error: x.error ?? "It didn't finish (timed out)" } : x;
// What a job usually takes, until it has run once with progress (then its own last time is used)
const TYPICAL_MS: Record<string, number> = { kpi: 300_000, meta: 420_000, slack: 120_000, gmail: 240_000, drive: 120_000, calls: 180_000, verticals: 300_000, market: 600_000, asana: 60_000, sheet: 60_000, docs: 240_000 };
const span = (ms: number) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
};
const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });

/** How far a running job is: items done of the total (from the job itself), time left at its current speed, and how that compares with its last run. */
function progressOf(job: string, run: RunState): Progress {
  if (!run?.running || !run.startedAt) return null;
  const now = Date.now();
  const elapsed = now - Date.parse(run.startedAt);
  const total = run.total ?? 0;
  const done = Math.min(run.done ?? 0, total || Infinity);
  const usual = run.durationMs || TYPICAL_MS[job] || 300_000;
  let left: number;
  let pct: number;
  let estimated = false;
  if (total > 0 && done > 0) {
    left = ((total - done) * elapsed) / done;
    pct = Math.min(99, Math.round((done / total) * 100));
  } else {
    // Nothing counted yet: from how long it usually takes, easing so it never shows done before it is
    estimated = true;
    pct = Math.round(95 * (1 - Math.exp(-(1.6 * elapsed) / usual)));
    left = Math.max(10_000, usual - elapsed);
  }
  const projected = elapsed + left;
  const pace = !run.durationMs || estimated ? null : projected < run.durationMs * 0.8 ? "faster" : projected > run.durationMs * 1.25 ? "slower" : "usual";
  return {
    pct,
    done: total ? done : undefined,
    total: total || undefined,
    failed: run.failed ?? 0,
    unit: run.unit ?? "items",
    current: run.current ?? null,
    phase: run.phase ?? null,
    estimated,
    elapsed: span(elapsed),
    left: span(left),
    finishAt: clock(now + left),
    pace,
    usual: run.durationMs ? span(run.durationMs) : null,
    by: run.by ?? null,
  };
}

async function Sync({ motion }: { motion: string | null }) {
  if (!adminConfigured()) return <p className="text-sm text-faint">Server key missing.</p>;
  const admin = createAdminClient();
  const me = await requireStaff();
  const { data: mw } = await admin.from("app_settings").select("updated_at, profiles(full_name)").eq("key", "meta_write").maybeSingle();
  const write = await metaWriteSetting(admin);
  const { data: gw } = await admin.from("app_settings").select("value, updated_at, profiles(full_name)").eq("key", "google_write").maybeSingle();
  const gwBy = (gw?.profiles as unknown as { full_name: string } | null)?.full_name;
  const mwBy = (mw?.profiles as unknown as { full_name: string } | null)?.full_name;
  const [{ data }, { data: accounts }] = await Promise.all([
    admin.from("sync_state").select("source, last_run_at, last_result").order("source"),
    admin.from("kpi_targets").select("ad_account_id, clients(name)").eq("active", true).not("ad_account_id", "is", null),
  ]);
  const everything = data ?? [];
  const runs = new Map(everything.filter((r) => r.source.startsWith("run:")).map((r) => [r.source.slice(4), timedOut(r.last_result as RunState)] as const));
  const rows = everything.filter((r) => !r.source.startsWith("run:"));
  // KPI rows are keyed by ad account; show whose it is
  const owner = new Map((accounts ?? []).map((a) => [String(a.ad_account_id).replace(/^act_/, "").replace(/-/g, ""), (a.clients as unknown as { name: string } | null)?.name ?? ""]));
  const errorOf = (r: (typeof rows)[number]) => {
    const res = r.last_result as { error?: string | null; errors?: string[] } | null;
    return res?.error ?? (res?.errors?.length ? res.errors.join("; ") : null);
  };

  // Each sync, worked out once: its sources, what's failing or behind, and its state
  const syncs = GROUPS.map(([prefix, name, job, about, category, cadence]) => {
    const all = rows.filter((r) => (prefix.endsWith(":") ? r.source.startsWith(prefix) : r.source === prefix || r.source.startsWith(`${prefix}:`)));
    // Offboarded teammates' inboxes: not synced any more, their email kept as history
    const offboarded = all.filter((r) => (r.last_result as { offboarded?: boolean } | null)?.offboarded);
    const list = all.filter((r) => !offboarded.includes(r));
    const failing = list.filter(errorOf);
    const stale = list.filter((r) => !errorOf(r) && freshness(r.last_run_at).tone !== "ok");
    const newest = list.map((r) => r.last_run_at).filter(Boolean).sort().at(-1);
    const run = runs.get(job) ?? null;
    const label = (source: string) => {
      const rest = source.startsWith(prefix) ? source.slice(prefix.length).replace(/^:/, "") : source;
      if (prefix === "kpi:") return owner.get(rest) ? `${owner.get(rest)} · ${rest}` : rest;
      return rest || "everything";
    };
    const state: "failing" | "behind" | "ok" | "idle" = failing.length ? "failing" : stale.length ? "behind" : list.length ? "ok" : "idle";
    return { prefix, name, job, about, category, cadence, list, failing, stale, offboarded, newest, run, progress: progressOf(job, run), label, state, retry: prefix === "kpi:" || prefix === "gmail:" };
  });
  const attention = syncs.filter((s) => s.state === "failing" || s.state === "behind");
  const healthy = syncs.filter((s) => s.state === "ok").length;
  const failingN = syncs.filter((s) => s.state === "failing").length;
  const behindN = syncs.filter((s) => s.state === "behind").length;
  const latest = syncs.map((s) => s.newest).filter(Boolean).sort().at(-1);
  const DOT = { failing: "bg-bad", behind: "bg-warn", ok: "bg-ok", idle: "bg-line" } as const;

  const tile = (s: (typeof syncs)[number]) => (
    <details key={s.prefix} className="group min-w-0 rounded-[16px] border border-line bg-surface transition-colors open:border-faint/50 hover:border-faint/40">
      <summary className="grid cursor-pointer list-none gap-3 p-4">
        <span className="flex items-start justify-between gap-3">
          <span className="grid min-w-0 gap-0.5">
            <span className="flex items-center gap-2">
              <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[s.state]}`} />
              <span className="truncate font-heading text-[15px]">{s.name}</span>
            </span>
            <span className="pl-4 text-[11px] text-faint">{s.cadence}</span>
          </span>
          <SyncNowButton job={s.job} run={s.run} progress={s.progress} />
        </span>
        <span className="flex flex-wrap items-center gap-1.5 pl-4 text-[11px]">
          {s.list.length > 1 && <span className="rounded-full bg-surface-2 px-2 py-0.5 tabular text-muted">{s.list.length} tracked</span>}
          {s.failing.length > 0 && <span className="rounded-full bg-bad/10 px-2 py-0.5 text-bad">{s.failing.length} failing</span>}
          {s.stale.length > 0 && <span className="rounded-full bg-warn/10 px-2 py-0.5 text-warn">{s.stale.length} behind</span>}
          <span className="text-faint">{s.newest ? freshness(s.newest).label.toLowerCase() : "not run yet"}</span>
          <span className="ml-auto text-faint transition-transform group-open:rotate-180" aria-hidden>
            ⌄
          </span>
        </span>
        <ProgressBar progress={s.progress} />
      </summary>
      <div className="grid gap-2 border-t border-line px-3 py-3">
        <div className="grid gap-0.5 px-1">
          <p className="text-[11px] text-faint">{s.about}</p>
          <LastRun run={s.run} />
        </div>
        <ul className="grid max-h-80 gap-0.5 overflow-y-auto [scrollbar-width:thin]">
          {[...s.failing, ...s.list.filter((r) => !errorOf(r))].slice(0, 150).map((r) => (
            <li key={r.source} className={`grid ${s.retry ? "grid-cols-[minmax(0,1fr)_auto_auto] md:grid-cols-[minmax(0,1fr)_88px_auto]" : "grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_88px]"} items-center gap-2 rounded-[8px] px-2 py-1.5 text-xs odd:bg-bg`}>
              <span className="grid min-w-0">
                <span className="truncate text-muted" title={r.source}>
                  {s.label(r.source)}
                </span>
                {errorOf(r) && (
                  <span className="truncate text-[11px] text-bad" title={errorOf(r) ?? undefined}>
                    {errorOf(r)}
                  </span>
                )}
              </span>
              <span className="text-right text-faint">{freshness(r.last_run_at).label}</span>
              {s.retry && <RetryOne source={r.source} />}
            </li>
          ))}
        </ul>
        {s.offboarded.length > 0 && (
          <p className="px-1 text-[11px] text-faint [overflow-wrap:anywhere]">
            Offboarded · {s.offboarded.length} {s.offboarded.length === 1 ? "inbox" : "inboxes"} no longer in Google Workspace, not synced any more (their email stays as history): {s.offboarded.map((r) => r.source.slice(s.prefix.length)).join(", ")}
          </p>
        )}
      </div>
    </details>
  );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-8 md:gap-10">
      {/* The state of it all, at a glance */}
      <section className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <div className={`relative grid content-start gap-5 overflow-hidden rounded-[20px] border p-5 md:p-6 ${failingN ? "border-bad/30" : behindN ? "border-warn/30" : "border-ok/30"} bg-surface`}>
          <div aria-hidden className={`pointer-events-none absolute -left-20 -top-24 h-56 w-56 rounded-full blur-[80px] ${failingN ? "bg-bad/20" : behindN ? "bg-warn/15" : "bg-ok/15"}`} />
          <div className="relative grid gap-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">Sync health</p>
            <p className="font-heading text-xl leading-tight md:text-2xl">{attention.length ? `${attention.length} ${attention.length === 1 ? "sync needs" : "syncs need"} attention` : "Everything's syncing"}</p>
            <p className="text-sm text-muted">{latest ? `Last activity ${freshness(latest).label.toLowerCase()}.` : "Nothing has run yet."} Each source runs on its own schedule; Sync now runs one right away.</p>
          </div>
          <div className="relative grid grid-cols-3 gap-2">
            {(
              [
                ["Healthy", healthy, "text-ok"],
                ["Behind", behindN, "text-warn"],
                ["Failing", failingN, "text-bad"],
              ] as const
            ).map(([k, n, tone]) => (
              <div key={k} className="grid gap-0.5 rounded-[12px] bg-bg/60 px-3 py-2.5">
                <span className={`tabular font-heading text-2xl ${n ? tone : "text-faint"}`}>{n}</span>
                <span className="text-[11px] text-faint">{k}</span>
              </div>
            ))}
          </div>
        </div>
        {/* Writing to the ad platforms: Meta, then Google, stacked */}
        <div className="grid min-w-0 content-start gap-4">
          <MetaWriteCard
            sandbox={write.sandbox}
            sandboxAccount={write.sandboxAccount}
            urlTags={write.urlTags ?? null}
            defaultTags={DEFAULT_URL_TAGS}
            canEdit={me.isExec}
            updated={mw?.updated_at ? `${new Date(mw.updated_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}${mwBy ? ` by ${mwBy}` : ""}` : null}
          />
          <GoogleWriteCard
            enabled={(gw?.value as { enabled?: boolean } | null)?.enabled === true}
            canEdit={me.isExec}
            updated={gw?.updated_at ? `${new Date(gw.updated_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}${gwBy ? ` by ${gwBy}` : ""}` : null}
          />
        </div>
      </section>

      {/* What needs someone, first */}
      {attention.length > 0 && (
        <section className="grid gap-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">Needs attention</h2>
          <ul className="grid divide-y divide-line overflow-hidden rounded-[16px] border border-line bg-surface">
            {attention.map((s) => (
              <li key={s.prefix} className="flex flex-wrap items-center gap-3 px-4 py-3.5 md:py-3">
                <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[s.state]}`} />
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="text-sm font-medium">{s.name}</span>
                  <span className="text-xs text-muted max-md:line-clamp-2 max-md:[overflow-wrap:anywhere] md:truncate" title={s.failing.map(errorOf).filter(Boolean).join(" · ")}>
                    {s.failing.length
                      ? `${s.failing.length} failing: ${s.failing
                          .slice(0, 2)
                          .map((r) => `${s.label(r.source)} (${(errorOf(r) ?? "").slice(0, 80)})`)
                          .join(" · ")}`
                      : `${s.stale.length} ${s.stale.length === 1 ? "hasn't" : "haven't"} synced in a day: ${s.stale
                          .slice(0, 3)
                          .map((r) => s.label(r.source))
                          .join(", ")}`}
                  </span>
                </span>
                <SyncNowButton job={s.job} run={s.run} progress={s.progress} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Every sync, by what it brings in */}
      {CATEGORIES.map((c) => {
        const mine = syncs.filter((s) => s.category === c.key);
        if (!mine.length && c.key !== "ads") return null;
        return (
          <section key={c.key} className="grid gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-heading text-lg">{c.label}</h2>
              <p className="text-xs text-faint">{c.about}</p>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-3 md:grid-cols-2">
              {mine.map(tile)}
              {c.key === "ads" && (
                <div className="md:col-span-2">
                  <MotionCard notice={motion} />
                </div>
              )}
            </div>
          </section>
        );
      })}

      <p className="text-xs text-faint">
        Behind: no successful run in the last day. Sync now runs a job outside its schedule (a few minutes; the tile updates when it&apos;s done). A failing ad account or inbox can be
        retried on its own from inside its tile.
      </p>
    </div>
  );
}

type DeletedRow = { id: string; number: number; title: string; client_name: string; client_slug: string; format: string; stage: string; new_count: number; variation_count: number; deleted_at: string; deleted_by: string | null; delete_reason: string | null; created_at: string };

/** Every deleted ticket, newest first, with who deleted it and why. Restoring brings it back exactly as it was. */
async function Deleted() {
  const supabase = await createClient();
  const { data } = await supabase.rpc("deleted_requests");
  const rows = (data ?? []) as DeletedRow[];
  if (!rows.length) return <p className="rounded-[14px] border border-dashed border-line px-6 py-10 text-center text-sm text-faint">Nothing has been deleted.</p>;
  // The rest of each ticket (deleted tickets are hidden from normal reads; leads and execs only got this far)
  const db = adminConfigured() ? createAdminClient() : supabase;
  const ids = rows.map((r) => r.id);
  const [{ data: more }, { data: events }, { data: designs }, { data: copy }] = await Promise.all([
    db.from("requests").select("id, brief, audience, sizes, refs, landing_url, priority, origin, angles(name)").in("id", ids),
    db.from("request_events").select("request_id, to_stage, created_at").in("request_id", ids).not("to_stage", "is", null).order("created_at"),
    db.from("designs").select("request_id").in("request_id", ids),
    db.from("copy_sets").select("request_id").in("request_id", ids),
  ]);
  const label = (k: string) => STAGES.find((s) => s.key === k)?.label ?? k.replaceAll("_", " ");
  const tickets: DeletedTicket[] = rows.map((r) => {
    const m = (more ?? []).find((x) => x.id === r.id);
    const refs = (m?.refs ?? []) as unknown;
    return {
      id: r.id,
      number: r.number,
      title: r.title,
      client: r.client_name,
      clientSlug: r.client_slug,
      format: r.format,
      stage: r.stage,
      stageLabel: label(r.stage),
      newCount: r.new_count,
      variations: r.variation_count,
      deletedAt: r.deleted_at,
      deletedBy: r.deleted_by,
      reason: r.delete_reason,
      createdAt: r.created_at,
      brief: m?.brief ?? null,
      angle: (m?.angles as unknown as { name: string } | null)?.name ?? null,
      audience: m?.audience ?? null,
      sizes: (m?.sizes ?? []) as string[],
      refs: (Array.isArray(refs) ? refs : typeof refs === "string" ? refs.split(/\s+/) : []).filter((u: unknown): u is string => typeof u === "string" && /^https?:/.test(u)),
      landing: m?.landing_url ?? null,
      priority: m?.priority ?? null,
      origin: (m?.origin ?? null) as DeletedTicket["origin"],
      designs: (designs ?? []).filter((d) => d.request_id === r.id).length,
      copy: (copy ?? []).filter((c) => c.request_id === r.id).length,
      path: (events ?? []).filter((e) => e.request_id === r.id).map((e) => ({ to: label(e.to_stage as string), at: e.created_at as string })),
    };
  });
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <p className="text-sm text-muted">
        Deleted tickets are hidden everywhere and don&apos;t count toward the allotment. Open one to read its brief and see where it got to, then pick it back up where it left off, or
        start it again as a new ticket with the same brief or an updated one.
      </p>
      <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">
        {tickets.map((t) => (
          <DeletedTicketRow key={t.id} t={t} />
        ))}
      </ul>
    </div>
  );
}

/** Execs: the AI agents and the data under the hood. Leads: the deleted log. */
export default async function Settings({ searchParams }: PageProps<"/settings">) {
  const me = await requireStaff();
  if (!isExecOrLead(me)) redirect("/pipeline");
  const tabs = me.isExec ? TABS : TABS.filter(([k]) => LEAD_TABS.includes(k));
  const sp = await searchParams;
  const tab = tabs.some(([k]) => k === sp.tab) ? (sp.tab as (typeof TABS)[number][0]) : tabs[0][0];
  const valid = (d: unknown) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
  const from = valid(sp.from) ? (sp.from as string) : day(-30);
  const to = valid(sp.to) ? (sp.to as string) : day(0);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5 md:gap-7">
      <header>
        <h1 className="font-heading text-[26px] leading-tight md:text-[32px]">Settings</h1>
        <p className="mt-1.5 text-sm text-muted">Tune the AI agents and look under the hood at the data behind every number.</p>
      </header>
      {/* Phones: one row of pills that scrolls sideways and snaps; desktop: the row wraps as before */}
      <nav className="no-scrollbar -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-1.5 overflow-x-auto px-4 md:mx-0 md:snap-none md:flex-wrap md:overflow-visible md:px-0">
        {tabs.map(([k, name]) => (
          <Link
            key={k}
            href={`/settings?tab=${k}`}
            aria-current={tab === k ? "page" : undefined}
            className={`inline-flex h-11 shrink-0 snap-start items-center whitespace-nowrap rounded-full px-4 text-sm transition-colors md:h-9 ${tab === k ? "bg-fg text-bg" : "bg-surface text-muted hover:bg-surface-2 hover:text-fg active:bg-surface-2 md:bg-transparent"}`}
          >
            {name}
          </Link>
        ))}
      </nav>
      {tab === "agents" && <Agents open={typeof sp.agent === "string" ? sp.agent : null} role={typeof sp.role === "string" ? sp.role : null} />}
      {tab === "team" && <Team />}
      {tab === "data" && <Data target={typeof sp.target === "string" ? sp.target : null} from={from} to={to} />}
      {tab === "sync" && <Sync motion={typeof sp.motion === "string" ? sp.motion : null} />}
      {tab === "errors" && <Errors all={sp.show === "all"} />}
      {tab === "deleted" && <Deleted />}
    </div>
  );
}
