import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { billedServices, type Bill, type Billed } from "./core";

// What Stripe bills each client for, as Kaizen Track keeps it (stripe_payments and stripe_open_invoices, matched to a
// client by Track: a subscription matched by hand there wins, then the subscription's client, then the payment's).
// White-label bills name our client in the memo. Kept on clients.billed_services by the hourly Track mirror, so the
// watch and the Stripe check read it without going to Track. Read only: Stripe and Track are never changed.

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

type Pay = Bill & { client_id: string | null; customer_id: string | null; subscription_id: string | null };

export async function syncBilledServices(admin: SupabaseClient, track: SupabaseClient, now = new Date()) {
  const since = new Date(now.getTime() - 50 * 86_400_000).toISOString();
  const [{ data: pays, error }, { data: open }, { data: subs }, { data: manual }, { data: agencies }] = await Promise.all([
    track.from("stripe_payments").select("client_id, customer_id, subscription_id, paid_at, lines, line_items, memo, amount, refunded, ignored").gte("paid_at", since),
    track.from("stripe_open_invoices").select("client_id, customer_id, subscription_id, created_at, lines, memo, amount_due").gte("created_at", since),
    track.from("stripe_subscriptions").select("id, client_id"),
    track.from("stripe_subscription_clients").select("subscription_id, client_id"),
    track.from("stripe_customers").select("id").eq("white_label", true),
  ]);
  if (error) throw new Error(`Kaizen Track: ${error.message}`);
  const setByHand = new Map((manual ?? []).map((m) => [m.subscription_id as string, m.client_id as string]));
  const subClient = new Map((subs ?? []).map((s) => [s.id as string, s.client_id as string | null]));
  const whiteLabel = new Set((agencies ?? []).map((a) => a.id as string));
  const { data: ours } = await admin.from("clients").select("id, name, track_client_id").is("archived_at", null);
  const byTrack = new Map((ours ?? []).filter((c) => c.track_client_id).map((c) => [c.track_client_id as string, c.id as string]));
  const named = (ours ?? []).map((c) => ({ id: c.id as string, key: norm(c.name as string) })).filter((c) => c.key.length >= 4).sort((a, b) => b.key.length - a.key.length);
  const fromMemo = (memo: string | null | undefined) => {
    const m = norm((memo ?? "").split("·")[0]);
    return m ? (named.find((c) => m.includes(c.key))?.id ?? null) : null;
  };

  const bills = new Map<string, Bill[]>();
  const add = (x: Pay) => {
    const agency = Boolean(x.customer_id && whiteLabel.has(x.customer_id));
    let ourId: string | null = null;
    if (agency && !x.client_id) ourId = fromMemo(x.memo);
    else {
      const t = agency ? x.client_id : (x.subscription_id && setByHand.get(x.subscription_id)) || (x.subscription_id && subClient.get(x.subscription_id)) || x.client_id;
      ourId = t ? (byTrack.get(t) ?? null) : null;
    }
    if (ourId) bills.set(ourId, [...(bills.get(ourId) ?? []), x]);
  };
  for (const p of (pays ?? []) as (Pay & { paid_at: string })[]) add({ ...p, at: p.paid_at });
  for (const o of (open ?? []) as (Pay & { created_at: string; amount_due: number | null })[]) add({ ...o, at: o.created_at, amount: o.amount_due });

  const at = now.toISOString();
  let updated = 0;
  // Every linked client gets a fresh answer (an empty one when nothing was billed), so "not billed" is known, not missing
  for (const c of ours ?? []) {
    if (!c.track_client_id && !bills.has(c.id as string)) continue;
    const billed: Billed = billedServices(bills.get(c.id as string) ?? [], now);
    await admin.from("clients").update({ billed_services: billed, billed_synced_at: at }).eq("id", c.id);
    updated++;
  }
  return { updated, billed: bills.size };
}
