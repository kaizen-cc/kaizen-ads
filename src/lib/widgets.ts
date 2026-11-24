import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { cleanChoice, monthsLeft, mrrByLine, type WidgetId } from "@/lib/widgets-core";

// The numbers behind each Overview widget (registry: src/lib/widgets-core.ts; sources: docs/WIDGETS.md). Read with the
// server key, scoped here: finance and sales for execs only (the registry won't let anyone else add them), everyone's
// own load and clients for themselves.

export type WidgetData =
  | { id: "mrr"; total: number; lines: [string, number][]; clients: number }
  | { id: "projection"; mrr: number; atRisk: number; month: number; quarter: number }
  | { id: "pipeline"; stages: [string, number][]; wonThisMonth: number; total: number }
  | { id: "clients-risk"; live: number; atRisk: { name: string; slug: string }[] }
  | { id: "spend"; total: number; accounts: number; top: { name: string; slug: string; spend: number }[] }
  | { id: "team-load"; people: { name: string; asks: number; stuck: number }[] }
  | { id: "my-targets"; rows: { name: string; slug: string; status: string; label: string }[] }
  | { id: "my-load"; open: number; overdue: number; from: [string, number][] };

type Client = { id: string; name: string; slug: string; billed_services: Record<string, { amount?: number | null } | null> | null };

async function liveClients(admin: SupabaseClient): Promise<Client[]> {
  const { data } = await admin.from("clients").select("id, name, slug, billed_services, status, internal").is("archived_at", null).limit(1000);
  return ((data ?? []) as (Client & { status: string | null; internal: boolean | null })[]).filter((c) => !c.internal && c.status !== "paused");
}

export async function myWidgets(admin: SupabaseClient, me: Staff): Promise<WidgetId[]> {
  const { data } = await admin.from("profiles").select("overview_widgets").eq("id", me.id).maybeSingle();
  return cleanChoice(data?.overview_widgets, me);
}

export async function loadWidget(admin: SupabaseClient, me: Staff, id: WidgetId): Promise<WidgetData | null> {
  switch (id) {
    case "mrr": {
      const cs = await liveClients(admin);
      const m = mrrByLine(cs);
      return { id, ...m, clients: cs.filter((c) => Object.keys(c.billed_services ?? {}).length).length };
    }
    case "projection": {
      const [cs, { atRiskNow }] = await Promise.all([liveClients(admin), import("@/lib/today")]);
      const risky = await atRiskNow(admin);
      const mrr = mrrByLine(cs).total;
      const atRisk = mrrByLine(cs.filter((c) => risky.has(c.id))).total;
      const left = monthsLeft();
      return { id, mrr, atRisk, month: Math.round((mrr - atRisk) * left.month), quarter: Math.round((mrr - atRisk) * left.quarter) };
    }
    case "pipeline": {
      const { data } = await admin.from("prospects").select("status, won_at").limit(2000);
      const rows = (data ?? []) as { status: string | null; won_at: string | null }[];
      const by = new Map<string, number>();
      for (const r of rows) by.set(r.status ?? "new", (by.get(r.status ?? "new") ?? 0) + 1);
      const monthStart = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }).slice(0, 8) + "01";
      return { id, stages: [...by].sort((a, b) => b[1] - a[1]), wonThisMonth: rows.filter((r) => r.won_at && r.won_at >= monthStart).length, total: rows.length };
    }
    case "clients-risk": {
      const [cs, { atRiskNow }] = await Promise.all([liveClients(admin), import("@/lib/today")]);
      const risky = await atRiskNow(admin);
      return { id, live: cs.length, atRisk: cs.filter((c) => risky.has(c.id)).map((c) => ({ name: c.name, slug: c.slug })) };
    }
    case "spend": {
      const { data } = await admin.from("kpi_snapshots").select("client_id, windows, clients(name, slug)").limit(2000);
      const rows = ((data ?? []) as unknown as { client_id: string; windows: { d30?: { spend?: number } } | null; clients: { name: string; slug: string } | null }[]).map((r) => ({ name: r.clients?.name ?? "A client", slug: r.clients?.slug ?? "", spend: Number(r.windows?.d30?.spend ?? 0) }));
      const byClient = new Map<string, { name: string; slug: string; spend: number }>();
      for (const r of rows) byClient.set(r.slug, { ...r, spend: (byClient.get(r.slug)?.spend ?? 0) + r.spend });
      const list = [...byClient.values()].filter((r) => r.spend > 0).sort((a, b) => b.spend - a.spend);
      return { id, total: Math.round(list.reduce((s, r) => s + r.spend, 0)), accounts: rows.filter((r) => r.spend > 0).length, top: list.slice(0, 5) };
    }
    case "team-load": {
      const [{ data: asks }, { data: stuck }, { data: people }] = await Promise.all([
        admin.from("agent_asks").select("owner_id").eq("status", "open").limit(5000),
        admin.from("ladder_nudges").select("owner_id").in("status", ["open", "sent"]).limit(5000),
        admin.from("profiles").select("id, full_name").eq("is_active", true),
      ]);
      const name = new Map(((people ?? []) as { id: string; full_name: string | null }[]).map((p) => [p.id, p.full_name ?? "A teammate"]));
      const by = new Map<string, { asks: number; stuck: number }>();
      for (const a of (asks ?? []) as { owner_id: string }[]) by.set(a.owner_id, { asks: (by.get(a.owner_id)?.asks ?? 0) + 1, stuck: by.get(a.owner_id)?.stuck ?? 0 });
      for (const s of (stuck ?? []) as { owner_id: string }[]) by.set(s.owner_id, { asks: by.get(s.owner_id)?.asks ?? 0, stuck: (by.get(s.owner_id)?.stuck ?? 0) + 1 });
      return { id, people: [...by].filter(([p]) => name.has(p)).map(([p, v]) => ({ name: name.get(p)!, ...v })).sort((a, b) => b.asks + b.stuck - (a.asks + a.stuck)).slice(0, 10) };
    }
    case "my-targets": {
      const { data: seats } = await admin.from("client_assignments").select("client_id").eq("profile_id", me.id).limit(300);
      const ids = [...new Set(((seats ?? []) as { client_id: string }[]).map((s) => s.client_id))];
      if (!ids.length) return { id, rows: [] };
      const { data } = await admin.from("kpi_snapshots").select("status, client_id, clients(name, slug), kpi_targets(label, platform)").in("client_id", ids).limit(500);
      const rank: Record<string, number> = { off: 0, close: 1, on: 2 };
      const rows = ((data ?? []) as unknown as { status: string | null; clients: { name: string; slug: string } | null; kpi_targets: { label: string | null; platform: string | null } | null }[])
        .filter((r) => r.clients)
        .map((r) => ({ name: r.clients!.name, slug: r.clients!.slug, status: r.status ?? "unknown", label: [r.kpi_targets?.platform, r.kpi_targets?.label].filter(Boolean).join(" ") }))
        .sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3));
      return { id, rows: rows.slice(0, 8) };
    }
    case "my-load": {
      const { data } = await admin.from("agent_asks").select("due_on, asker:profiles!agent_asks_asked_by_fkey(full_name), asked_by").eq("owner_id", me.id).eq("status", "open").limit(500);
      const rows = (data ?? []) as unknown as { due_on: string | null; asked_by: string | null; asker: { full_name: string } | null }[];
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      const by = new Map<string, number>();
      for (const r of rows) {
        const who = r.asked_by === me.id ? "You" : (r.asker?.full_name ?? "A teammate");
        by.set(who, (by.get(who) ?? 0) + 1);
      }
      return { id, open: rows.length, overdue: rows.filter((r) => r.due_on && r.due_on < today).length, from: [...by].sort((a, b) => b[1] - a[1]).slice(0, 5) };
    }
  }
}
