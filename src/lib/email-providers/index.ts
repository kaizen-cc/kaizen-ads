import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BREVO, brevoPreview } from "../brevo/store";
import { CUSTOMERIO } from "../customerio/store";
import { campaignPreview, connectKlaviyo, klaviyoConnection, removeKlaviyo, syncAllKlaviyo, syncKlaviyo, type KlaviyoConnectionView } from "../klaviyo/store";
import { isEmailProvider, providerHasPreviews, providerName, type CioRegion, type EmailProvider } from "./core";
import { connectProvider, providerConnection, providerRoster, removeProvider, syncAllProvider, syncProvider, type ConnectExtra, type ConnectResult, type ProviderConnectionView, type ProviderDef, type SyncResult } from "./runner";
import { emailConnection } from "./which";

// One front door for the three email sources: connect, remove, read now, read everything on the schedule, show the
// connection and preview an email. Screens and actions call these with the client's provider; each provider's own
// reading stays in its own module and writes the same tables.

export const DEFS: Record<Exclude<EmailProvider, "klaviyo">, ProviderDef> = { brevo: BREVO, customerio: CUSTOMERIO };

export async function connectEmail(admin: SupabaseClient, provider: EmailProvider, clientId: string, key: string, by: string, extra: ConnectExtra = {}): Promise<ConnectResult> {
  if (provider === "klaviyo") return connectKlaviyo(admin, clientId, key, by);
  return connectProvider(admin, DEFS[provider], clientId, key, by, extra);
}

export async function removeEmail(admin: SupabaseClient, provider: EmailProvider, clientId: string) {
  if (provider === "klaviyo") return removeKlaviyo(admin, clientId);
  return removeProvider(admin, DEFS[provider], clientId);
}

/** Reads one client's email from whichever provider it is on */
export async function syncEmail(admin: SupabaseClient, clientId: string, opts: { window?: "recent" | "full" | "auto" } = {}): Promise<SyncResult> {
  const conn = await emailConnection(admin, clientId);
  if (!conn) return { client: clientId, ok: false, error: "No email provider is connected for this client." };
  if (conn.provider === "klaviyo") return syncKlaviyo(admin, clientId, opts);
  return syncProvider(admin, DEFS[conn.provider], clientId, opts);
}

/** The schedule's step: Klaviyo first (the most clients), then Brevo and Customer.io with what is left of the budget */
export async function syncAllEmail(admin: SupabaseClient, opts: { budgetMs?: number; force?: boolean } = {}) {
  const end = Date.now() + (opts.budgetMs ?? 600_000);
  const klaviyo = await syncAllKlaviyo(admin, { ...opts, budgetMs: Math.max(60_000, Math.round((end - Date.now()) * 0.8)) });
  const brevo = await syncAllProvider(admin, BREVO, { force: opts.force, budgetMs: Math.max(30_000, Math.round((end - Date.now()) / 2)) });
  const customerio = await syncAllProvider(admin, CUSTOMERIO, { force: opts.force, budgetMs: Math.max(30_000, end - Date.now()) });
  return { klaviyo, brevo, customerio };
}

export type EmailConnectionView = { provider: EmailProvider; klaviyo: KlaviyoConnectionView | null; other: ProviderConnectionView | null };

/** The client's connection for Team & setup: its provider (null when none is connected) and that provider's view; undefined when nothing is set up in the database */
export async function emailConnectionView(admin: SupabaseClient, clientId: string): Promise<EmailConnectionView | null | undefined> {
  const k = await klaviyoConnection(admin, clientId);
  if (k) return { provider: "klaviyo", klaviyo: k, other: null };
  for (const p of ["brevo", "customerio"] as const) {
    const v = await providerConnection(admin, DEFS[p], clientId);
    if (v) return { provider: p, klaviyo: null, other: v };
  }
  return k === undefined ? undefined : null;
}

/** The same view the Klaviyo card reads, for whichever provider the client is on (null: none connected; undefined: not set up in the database) */
export async function emailConnectionFlat(admin: SupabaseClient, clientId: string): Promise<KlaviyoConnectionView | null | undefined> {
  const v = await emailConnectionView(admin, clientId);
  if (!v) return v;
  if (v.klaviyo) return { ...v.klaviyo, provider: "klaviyo" };
  const o = v.other!;
  return { provider: o.provider, region: o.region, revenueEvent: o.revenueEvent, revenueRead: o.revenueRead, account: o.account, accountId: o.accountId, timezone: o.timezone, currency: o.currency, last4: o.last4, status: o.status, lastSyncedAt: o.lastSyncedAt, backfilled: o.backfilled, error: o.error, connectedAt: o.connectedAt, by: o.by };
}

export const rosterOf = (admin: SupabaseClient, p: Exclude<EmailProvider, "klaviyo">) => providerRoster(admin, DEFS[p]);

/** A campaign's email for the hover preview, from the client's provider (Customer.io's API gives no email content) */
export async function emailPreview(admin: SupabaseClient, clientId: string, campaignId: string) {
  const conn = await emailConnection(admin, clientId);
  const provider = conn?.provider ?? "klaviyo";
  if (!providerHasPreviews(provider)) return { ok: false as const, error: `${providerName(provider)}'s API doesn't give the email's content, so there is no preview.` };
  // A preview read once stays cached whatever the provider
  if (provider === "brevo") {
    const { data: cached } = await admin.from("klaviyo_previews").select("channel, subject, preview_text, html, body, fetched_at").eq("client_id", clientId).eq("campaign_id", campaignId).maybeSingle();
    if (cached?.html) return { ok: true as const, preview: { channel: (cached.channel as string | null) ?? "email", subject: (cached.subject as string | null) ?? null, previewText: (cached.preview_text as string | null) ?? null, html: cached.html as string, body: (cached.body as string | null) ?? null, fetchedAt: cached.fetched_at as string } };
    return brevoPreview(admin, clientId, campaignId);
  }
  return campaignPreview(admin, clientId, campaignId);
}

/** The purchase event whose value Customer.io reports as revenue (empty clears it); a lead or an exec, then a full read */
export async function setRevenueEvent(admin: SupabaseClient, clientId: string, event: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const name = event.trim().slice(0, 120);
  const { error } = await admin.from("customerio_connections").update({ revenue_event: name || null, revenue_read: null, updated_at: new Date().toISOString() }).eq("client_id", clientId);
  return error ? { ok: false, error: error.message } : { ok: true };
}

export type { CioRegion };
export { isEmailProvider };
