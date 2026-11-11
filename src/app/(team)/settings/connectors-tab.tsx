import type { Staff } from "@/lib/auth";
import { isWriteTool } from "@/lib/connectors/core";
import { encryptionKey } from "@/lib/meta-token-core";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { ConnectorsAdmin, MyConnections, type AdminItem, type MineItem } from "./connectors";

// Settings › Connections › Team connectors (execs enable connectors for the team: the team's requests, the Directory of
// verified servers synced daily or on Refresh now, custom ones, roles) and Your accounts (everyone: what they've
// connected, pointing to Kaizen AI's plug menu where connecting lives).

export async function ConnectorsTab() {
  if (!adminConfigured()) return <p className="text-sm text-muted">Server key missing.</p>;
  const admin = createAdminClient();
  const { listConnectors } = await import("@/lib/connectors/server");
  const { pendingRequests } = await import("@/lib/connectors/requests");
  const [list, secrets, conns, probe, states, total, requests] = await Promise.all([
    listConnectors(admin),
    admin.from("ai_connector_secrets").select("connector_id, client_secret_ciphertext, reg_client_id").then((r) => r.data ?? []),
    admin.from("ai_connections").select("connector_id, status").then((r) => r.data ?? []),
    admin.from("ai_connectors").select("id", { head: true, count: "exact" }),
    admin
      .from("ai_connector_registry_state")
      .select("id, last_run_at, last_error, cursor, last_complete_at")
      .in("id", ["main", "official"])
      .then((r) => (r.data ?? []) as { id: string; last_run_at: string | null; last_error: string | null; cursor: string | null; last_complete_at: string | null }[]),
    admin.from("ai_connector_registry").select("name", { head: true, count: "exact" }).eq("available", true).then((r) => r.count ?? 0),
    pendingRequests(admin),
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
  // The sync's latest run, across both registries (the official one carries the catalog while Anthropic's is empty)
  const latest = [...states].sort((a, b) => (b.last_run_at ?? "").localeCompare(a.last_run_at ?? ""))[0] ?? null;
  return (
    <ConnectorsAdmin
      items={items}
      ready={!probe.error}
      encryption={Boolean(encryptionKey(process.env.TOKEN_ENCRYPTION_KEY))}
      catalogTotal={total}
      lastSync={latest?.last_run_at ?? null}
      syncError={latest?.last_error ?? null}
      syncPartial={states.some((s) => Boolean(s.cursor))}
      requests={requests}
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
      state: !m ? "not_connected" : c.auth === "none" || m.status === "active" ? "connected" : "reconnect",
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
