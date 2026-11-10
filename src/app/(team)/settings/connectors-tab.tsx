import type { Staff } from "@/lib/auth";
import { isWriteTool } from "@/lib/connectors/core";
import { encryptionKey } from "@/lib/meta-token-core";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { ConnectorsAdmin, MyConnections, type AdminItem, type CatalogItem, type MineItem } from "./connectors";

// Settings › Connectors (execs: what's offered to the team, and the live catalog from Anthropic's MCP registry, synced
// daily) and Settings › Your connections (everyone: connect their own account to each one offered to them).

export async function ConnectorsTab({ me, view, q }: { me: Staff; view: string | null; q: string | null }) {
  if (!adminConfigured()) return <p className="text-sm text-muted">Server key missing.</p>;
  const admin = createAdminClient();
  const { listConnectors } = await import("@/lib/connectors/server");
  const search = (q ?? "").replace(/[%_,()*]/g, " ").trim().slice(0, 60);
  let reg = admin.from("ai_connector_registry").select("name, title, description, url, transport, version, icon_url, website_url, available, first_seen_at, changed_at").eq("available", true).order("first_seen_at", { ascending: false }).limit(60);
  if (search) reg = reg.or(`title.ilike.%${search}%,name.ilike.%${search}%,description.ilike.%${search}%`);
  const [list, secrets, conns, probe, catalog, seen, state, total] = await Promise.all([
    listConnectors(admin),
    admin.from("ai_connector_secrets").select("connector_id, client_secret_ciphertext, reg_client_id").then((r) => r.data ?? []),
    admin.from("ai_connections").select("connector_id, status").then((r) => r.data ?? []),
    admin.from("ai_connectors").select("id", { head: true, count: "exact" }),
    view === "catalog" ? reg.then((r) => r.data ?? []) : Promise.resolve([]),
    admin.from("ai_connector_registry_seen").select("seen_at").eq("profile_id", me.id).maybeSingle().then((r) => (r.data?.seen_at as string | undefined) ?? null),
    admin.from("ai_connector_registry_state").select("last_run_at, last_error, source").eq("id", "main").maybeSingle().then((r) => r.data as { last_run_at: string | null; last_error: string | null; source: string | null } | null),
    admin.from("ai_connector_registry").select("name", { head: true, count: "exact" }).eq("available", true).then((r) => r.count ?? 0),
  ]);
  // Offered connectors whose registry entry went away: a warning, still working until an exec turns it off
  const fromRegistry = list.filter((c) => c.registry_name).map((c) => c.registry_name!);
  const { data: regRows } = fromRegistry.length ? await admin.from("ai_connector_registry").select("name, available").in("name", fromRegistry) : { data: [] };
  const items: AdminItem[] = list.map((c) => ({
    ...c,
    hasSecret: secrets.some((s) => s.connector_id === c.id && s.client_secret_ciphertext),
    registered: secrets.some((s) => s.connector_id === c.id && s.reg_client_id),
    people: conns.filter((x) => x.connector_id === c.id && x.status === "active").length,
    removed: Boolean(c.registry_name && (regRows ?? []).some((r) => r.name === c.registry_name && !r.available)),
  }));
  const offeredNames = new Map(list.filter((c) => c.registry_name).map((c) => [c.registry_name!, c.enabled]));
  const cat: CatalogItem[] = (catalog as Omit<CatalogItem, "badge" | "offered">[]).map((e) => ({
    ...e,
    badge: !seen || e.first_seen_at > seen ? "new" : e.changed_at && e.changed_at > seen ? "updated" : null,
    offered: offeredNames.has(e.name) ? (offeredNames.get(e.name) ? "on" : "off") : null,
  }));
  return (
    <ConnectorsAdmin
      items={items}
      ready={!probe.error}
      encryption={Boolean(encryptionKey(process.env.TOKEN_ENCRYPTION_KEY))}
      catalog={cat}
      catalogTotal={total}
      lastSync={state?.last_run_at ?? null}
      syncError={state?.last_error ?? null}
    />
  );
}

export async function MyConnectionsTab({ me }: { me: Staff }) {
  if (!adminConfigured()) return <p className="text-sm text-muted">Server key missing.</p>;
  const admin = createAdminClient();
  const { offeredConnectors, myConnections } = await import("@/lib/connectors/server");
  const [offered, mine] = await Promise.all([offeredConnectors(admin, me), myConnections(admin, me.id)]);
  const items: MineItem[] = offered.map((c) => {
    const m = mine.find((x) => x.connector_id === c.id);
    return {
      key: c.key,
      name: c.name,
      icon_url: c.icon_url,
      note: c.note,
      auth: c.auth,
      state: c.auth === "none" ? "open" : !m ? "not_connected" : m.status === "active" ? "connected" : "reconnect",
      since: m?.connected_at ?? null,
      lastUsed: m?.last_used_at ?? null,
      last4: m?.token_last4 ?? null,
      error: m?.last_error ?? null,
      tools: m?.tools.length ?? 0,
      writes: m ? m.tools.filter(isWriteTool).length : 0,
    };
  });
  return <MyConnections items={items} isExec={me.isExec} />;
}
