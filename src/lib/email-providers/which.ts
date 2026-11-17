import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CONNECTION_TABLE, EMAIL_PROVIDERS, providerName, revenueMeasured, type EmailProvider } from "./core";

// Which email provider each client is on, read from the three connection tables (a client has at most one). Every
// screen that only needs to know "is this client's email connected, to what, and is it healthy" asks here, so Klaviyo,
// Brevo and Customer.io are one thing to them. The connections hold a sealed key: only the server's rights read them.

export type EmailConn = {
  provider: EmailProvider;
  clientId: string;
  account: string | null;
  currency: string | null;
  status: string;
  lastSyncedAt: string | null;
  lastError: string | null;
  /** Klaviyo's Placed Order metric name (the board shows it); null for the others */
  conversionMetric: string | null;
  /** Whether this source reports revenue: always for Klaviyo, only when Brevo's attribution or Customer.io's revenue event read */
  revenueRead: boolean;
};

const COLUMNS: Record<EmailProvider, string> = {
  klaviyo: "client_id, account_name, currency, status, last_synced_at, last_error, conversion_metric_name",
  brevo: "client_id, account_name, currency, status, last_synced_at, last_error, revenue_read",
  customerio: "client_id, account_name, currency, status, last_synced_at, last_error, revenue_read",
};

/** The connections of these clients (every client when `clientIds` is null), one per client; a table not migrated yet reads as empty */
export async function emailConnections(admin: SupabaseClient, clientIds: string[] | null): Promise<Map<string, EmailConn>> {
  const out = new Map<string, EmailConn>();
  if (clientIds && !clientIds.length) return out;
  const lists = await Promise.all(
    EMAIL_PROVIDERS.map(async (p) => {
      let q = admin.from(CONNECTION_TABLE[p]).select(COLUMNS[p]);
      if (clientIds) q = q.in("client_id", clientIds);
      const { data, error } = await q;
      return error ? [] : ((data ?? []) as unknown as Record<string, unknown>[]).map((r) => ({ p, r }));
    }),
  );
  for (const { p, r } of lists.flat()) {
    const id = r.client_id as string;
    if (out.has(id)) continue;
    out.set(id, {
      provider: p,
      clientId: id,
      account: (r.account_name as string | null) ?? null,
      currency: (r.currency as string | null) ?? null,
      status: r.status as string,
      lastSyncedAt: (r.last_synced_at as string | null) ?? null,
      lastError: (r.last_error as string | null) ?? null,
      conversionMetric: (r.conversion_metric_name as string | null) ?? null,
      revenueRead: revenueMeasured(p, r as { revenue_read?: boolean | null }),
    });
  }
  return out;
}

export async function emailConnection(admin: SupabaseClient, clientId: string): Promise<EmailConn | null> {
  return (await emailConnections(admin, [clientId])).get(clientId) ?? null;
}

/** Where a client's email numbers come from: its provider's name, "Klaviyo" when nothing is connected (the tables' default) */
export async function emailSourceName(admin: SupabaseClient, clientId: string): Promise<string> {
  return providerName((await emailConnection(admin, clientId))?.provider);
}

/** The other provider this client already has connected, if any: a client has one, so connecting another asks to remove it first */
export async function connectedElsewhere(admin: SupabaseClient, clientId: string, except: EmailProvider): Promise<EmailProvider | null> {
  for (const p of EMAIL_PROVIDERS) {
    if (p === except) continue;
    const { data } = await admin.from(CONNECTION_TABLE[p]).select("client_id").eq("client_id", clientId).maybeSingle();
    if (data) return p;
  }
  return null;
}

/** The message for a refused second provider */
export const elsewhereMessage = (other: EmailProvider) => `This client already has ${providerName(other)} connected. Remove it first: a client has one email provider.`;

/** Active connections of live clients across every provider, for the daily audits and the suggestion runs */
export async function activeEmailClients(admin: SupabaseClient, live: readonly string[]): Promise<{ client_id: string; provider: EmailProvider; name: string | null }[]> {
  const out: { client_id: string; provider: EmailProvider; name: string | null }[] = [];
  for (const p of EMAIL_PROVIDERS) {
    const { data, error } = await admin.from(CONNECTION_TABLE[p]).select("client_id, clients!inner(name, status, archived_at)").eq("status", "active").is("clients.archived_at", null).in("clients.status", [...live]);
    if (error) continue;
    for (const r of (data ?? []) as unknown as { client_id: string; clients: { name: string } | null }[]) out.push({ client_id: r.client_id, provider: p, name: r.clients?.name ?? null });
  }
  return out;
}
