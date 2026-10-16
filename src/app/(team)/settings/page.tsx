import Link from "next/link";
import { redirect } from "next/navigation";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { restoreTicket } from "@/app/(team)/board/actions";
import { ActionButton } from "@/components/action-form";
import { daysAgoIso, freshness } from "@/lib/dates";
import { nyParts } from "@/lib/kpi/calc";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { ChatMessage, Change } from "./actions";
import { AgentDetail, AgentsOverview, type Agent, type Item } from "./agents";
import { DataInspector } from "./data-inspector";

// Inspecting a big ad account reads a few thousand rows
export const maxDuration = 60;

const TABS = [
  ["agents", "AI agents"],
  ["data", "Raw data"],
  ["sync", "Sync health"],
  ["deleted", "Deleted"],
] as const;
// Leads see only the deleted log; execs see everything
const LEAD_TABS = ["deleted"];

const day = (offset: number) => {
  const d = new Date(`${nyParts(new Date()).date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

async function Agents({ open }: { open: string | null }) {
  const supabase = await createClient();
  const since = daysAgoIso(7);
  const [{ data: agents }, { data: knowledge }, { data: runs }] = await Promise.all([
    supabase.from("ai_agents").select("*, profiles(full_name)").order("sort_order"),
    supabase.from("ai_knowledge").select("*").order("created_at"),
    supabase.from("ai_runs").select("agent_key, label, model, ms, input_tokens, output_tokens, ok, error, created_at").gte("created_at", since).order("created_at", { ascending: false }).limit(1000),
  ]);
  const list: Agent[] = (agents ?? []).map((a) => {
    const mine = (runs ?? []).filter((r) => r.agent_key === a.key);
    const timed = mine.filter((r) => r.ms != null && r.ok);
    return {
      key: a.key,
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
      recent: mine.slice(0, 15).map((r) => ({
        at: r.created_at,
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
  if (!agent) return <AgentsOverview agents={list} items={items} />;
  const { data: chat } = await supabase.from("ai_agent_chats").select("id, role, content, changes, created_at").eq("agent_key", agent.key).order("created_at").limit(200);
  const messages: ChatMessage[] = (chat ?? []).map((m) => ({ id: m.id, role: m.role, content: m.content, changes: (m.changes ?? []) as Change[], at: m.created_at }));
  return <AgentDetail key={agent.key} a={agent} items={items} chat={messages} />;
}

async function Data({ target, from, to }: { target: string | null; from: string; to: string }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("kpi_targets")
    .select("id, platform, ad_account_id, label, conversion, custom_action, campaign_match, target, monthly_budget, clients(name)")
    .eq("active", true);
  const targets = (data ?? [])
    .map((t) => ({ ...t, client: (t.clients as unknown as { name: string } | null)?.name ?? "Unknown", target: t.target == null ? null : Number(t.target), monthly_budget: t.monthly_budget == null ? null : Number(t.monthly_budget) }))
    .sort((a, b) => a.client.localeCompare(b.client));
  return <DataInspector targets={targets} targetId={target} from={from} to={to} />;
}

const GROUPS: [string, string][] = [
  ["kpi:", "KPI numbers (per ad account)"],
  ["slack:", "Slack channels"],
  ["gmail:", "Inboxes"],
  ["drive:", "Drive folders"],
];

async function MotionCard({ notice }: { notice: string | null }) {
  const { data: m } = await createAdminClient().from("motion_connection").select("access_token, connected_at, last_sync_at, last_result, error, tools, profiles(full_name)").eq("id", 1).maybeSingle();
  const on = Boolean(m?.access_token);
  const r = (m?.last_result ?? null) as { brands?: number; pulled?: number; read?: number; brandsFound?: number; errors?: string[] } | null;
  return (
    <section className="grid gap-3 rounded-[12px] border border-line bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-heading text-[17px]">Motion</p>
          <p className="mt-0.5 text-sm text-muted">
            {on
              ? `Connected${m?.connected_at ? ` ${new Date(m.connected_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}${(m?.profiles as unknown as { full_name: string } | null)?.full_name ? ` by ${(m?.profiles as unknown as { full_name: string }).full_name}` : ""} · ${((m?.tools ?? []) as unknown[]).length} tools. The Market tab pulls live ads from it every morning.`
              : "Connect Kaizen's Motion account to fill the Market tab with live ads from every industry we serve."}
          </p>
        </div>
        <a href="/api/motion/connect" className={`grid h-9 place-items-center rounded-full px-4 text-sm ${on ? "border border-line text-muted hover:text-fg" : "bg-brand font-medium text-white hover:brightness-110"}`}>
          {on ? "Reconnect" : "Connect Motion"}
        </a>
      </div>
      {notice && <p className={`text-xs ${notice === "connected" ? "text-ok" : "text-bad"}`}>{notice === "connected" ? "Connected. The first market sync is running now." : notice}</p>}
      {m?.error && <p className="text-xs text-bad">{m.error}</p>}
      {on && m?.last_sync_at && (
        <p className="text-xs text-faint">
          Last sync {new Date(m.last_sync_at).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          {r && ` · ${r.brands ?? 0} brands checked, ${r.pulled ?? 0} ads pulled, ${r.read ?? 0} read${r.brandsFound ? `, ${r.brandsFound} brands found` : ""}`}
          {r?.errors?.length ? ` · ${r.errors[0]}` : ""}
        </p>
      )}
    </section>
  );
}

async function Sync({ motion }: { motion: string | null }) {
  if (!adminConfigured()) return <p className="text-sm text-faint">Server key missing.</p>;
  const { data } = await createAdminClient().from("sync_state").select("source, last_run_at, last_result").order("source");
  const rows = data ?? [];
  const errorOf = (r: (typeof rows)[number]) => {
    const res = r.last_result as { error?: string | null; errors?: string[] } | null;
    return res?.error ?? (res?.errors?.length ? res.errors.join("; ") : null);
  };
  return (
    <div className="grid gap-4">
      <MotionCard notice={motion} />
      {GROUPS.map(([prefix, name]) => {
        const list = rows.filter((r) => r.source.startsWith(prefix));
        const failing = list.filter(errorOf);
        const stale = list.filter((r) => freshness(r.last_run_at).tone !== "ok");
        const newest = list.map((r) => r.last_run_at).filter(Boolean).sort().at(-1);
        return (
          <details key={prefix} className="group rounded-[14px] border border-line bg-surface">
            <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 px-6 py-4">
              <span className="flex items-center gap-3">
                <span className={`h-2 w-2 rounded-full ${failing.length ? "bg-bad" : stale.length ? "bg-warn" : "bg-ok"}`} />
                <span className="font-heading text-[16px]">{name}</span>
              </span>
              <span className="text-xs text-muted">
                <span className="tabular">{list.length}</span> tracked
                {failing.length > 0 && <span className="text-bad"> · {failing.length} failing</span>}
                {stale.length > 0 && <span className="text-warn"> · {stale.length} behind</span>}
                {newest && <span className="text-faint"> · {freshness(newest).label.toLowerCase()}</span>}
              </span>
            </summary>
            <ul className="grid gap-1 border-t border-line px-4 py-3">
              {[...failing, ...list.filter((r) => !errorOf(r))].slice(0, 120).map((r) => (
                <li key={r.source} className="grid grid-cols-[minmax(0,220px)_140px_minmax(0,1fr)] gap-3 rounded-[8px] px-2 py-1.5 text-xs odd:bg-bg">
                  <code className="truncate text-muted">{r.source.slice(prefix.length)}</code>
                  <span className="text-faint">{freshness(r.last_run_at).label}</span>
                  <span className={`truncate ${errorOf(r) ? "text-bad" : "text-faint"}`} title={errorOf(r) ?? undefined}>
                    {errorOf(r) ?? "OK"}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        );
      })}
      <p className="text-xs text-faint">Behind = no successful run in the last day. Slack, email and Drive sync every 30 minutes in business hours; KPI numbers every 2 hours.</p>
    </div>
  );
}

type DeletedRow = { id: string; number: number; title: string; client_name: string; client_slug: string; format: string; stage: string; new_count: number; variation_count: number; deleted_at: string; deleted_by: string | null; delete_reason: string | null; created_at: string };

/** Every deleted ticket, newest first, with who deleted it and why. Restoring brings it back exactly as it was. */
async function Deleted() {
  const supabase = await createClient();
  const { data } = await supabase.rpc("deleted_requests");
  const rows = (data ?? []) as DeletedRow[];
  const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
  if (!rows.length) return <p className="rounded-[14px] border border-dashed border-line px-6 py-10 text-center text-sm text-faint">Nothing has been deleted.</p>;
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted">Deleted tickets are hidden everywhere and don&apos;t count toward the allotment. Restoring one puts it back where it was, with its files, copy and history.</p>
      <ul className="grid gap-2">
        {rows.map((r) => (
          <li key={r.id} className="grid gap-3 rounded-[12px] border border-line bg-surface px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div className="grid min-w-0 gap-1">
              <p className="truncate text-sm font-medium">
                <span className="text-faint">#{r.number}</span> {r.title}
              </p>
              <p className="text-xs text-muted">
                {r.client_name} · <span className="capitalize">{r.format}</span> · {r.new_count} new{r.variation_count ? ` + ${r.variation_count} var.` : ""} · was in {r.stage.replaceAll("_", " ")}
              </p>
              <p className="text-xs text-faint">
                Deleted {when(r.deleted_at)}
                {r.deleted_by ? ` by ${r.deleted_by}` : ""}
                {r.delete_reason && <span className="text-muted"> · &ldquo;{r.delete_reason}&rdquo;</span>}
              </p>
            </div>
            <ActionButton action={restoreTicket.bind(null, r.id)} label="Restore" confirmText={`Restore #${r.number}?`} />
          </li>
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
    <div className="grid gap-7">
      <header>
        <h1 className="font-heading text-[32px] leading-tight">Settings</h1>
        <p className="mt-1.5 text-sm text-muted">Tune the AI agents and look under the hood at the data behind every number.</p>
      </header>
      <nav className="flex flex-wrap gap-1.5">
        {tabs.map(([k, name]) => (
          <Link key={k} href={`/settings?tab=${k}`} className={`inline-flex h-9 items-center rounded-full px-4 text-sm transition-colors ${tab === k ? "bg-fg text-bg" : "text-muted hover:bg-surface-2 hover:text-fg"}`}>
            {name}
          </Link>
        ))}
      </nav>
      {tab === "agents" && <Agents open={typeof sp.agent === "string" ? sp.agent : null} />}
      {tab === "data" && <Data target={typeof sp.target === "string" ? sp.target : null} from={from} to={to} />}
      {tab === "sync" && <Sync motion={typeof sp.motion === "string" ? sp.motion : null} />}
      {tab === "deleted" && <Deleted />}
    </div>
  );
}
