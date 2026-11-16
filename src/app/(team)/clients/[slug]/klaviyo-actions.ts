"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { campaignPreview, connectKlaviyo, klaviyoMetricChoices, removeKlaviyo, setKlaviyoMetric, syncKlaviyo, type CampaignPreview } from "@/lib/klaviyo/store";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Klaviyo on the client page: a lead or exec pastes the account's read-only private API key (checked, encrypted, never
// shown again but its last 4), replaces or removes it; anyone on the client can sync it now. Read only in Klaviyo.

type Result = { ok: true; account?: string | null } | { ok: false; error: string };

async function mine(clientId: string, manage: boolean) {
  const me = await requireStaff();
  if (manage && !isExecOrLead(me)) return { error: "Only a lead or an exec can connect Klaviyo." } as const;
  if (!adminConfigured()) return { error: "Not set up here." } as const;
  const { data } = await (await createClient()).from("clients").select("id, slug").eq("id", clientId).maybeSingle();
  if (!data) return { error: "You don't work on this client." } as const;
  return { me, slug: data.slug as string, admin: createAdminClient() } as const;
}

/**
 * quick: connected from the Email board or the Overview while working down a list of clients. The board marks the card
 * itself, so the answer doesn't wait on the whole board being worked out again (every client's score); those pages show
 * the new numbers the next time they load, once the first read has landed anyway.
 */
export async function connectKlaviyoKey(clientId: string, key: string, opts: { quick?: boolean } = {}): Promise<Result> {
  const l = await mine(clientId, true);
  if ("error" in l) return { ok: false, error: l.error! };
  const r = await connectKlaviyo(l.admin, clientId, key, l.me.id);
  if (!r.ok) return r;
  // The first pull (90 days back) right after the answer
  const admin = l.admin;
  after(() => syncKlaviyo(admin, clientId).then(() => undefined));
  revalidatePath(`/clients/${l.slug}`);
  // Connected from Settings › Sync health too: its Klaviyo card shows it
  revalidatePath("/settings");
  if (!opts.quick) {
    revalidatePath("/kpis");
    revalidatePath("/pipeline");
  }
  return { ok: true, account: r.account };
}

export async function removeKlaviyoKey(clientId: string): Promise<Result> {
  const l = await mine(clientId, true);
  if ("error" in l) return { ok: false, error: l.error! };
  const r = await removeKlaviyo(l.admin, clientId);
  revalidatePath(`/clients/${l.slug}`);
  return r;
}

/** A campaign's preview for the Email tab: the email's HTML (made safe) or the SMS text, cached after the first read */
export async function klaviyoCampaignPreview(clientId: string, campaignId: string): Promise<{ ok: true; preview: CampaignPreview } | { ok: false; error: string }> {
  const l = await mine(clientId, false);
  if ("error" in l) return { ok: false, error: l.error! };
  return campaignPreview(l.admin, clientId, String(campaignId).slice(0, 64));
}

export async function syncKlaviyoNow(clientId: string): Promise<Result> {
  const l = await mine(clientId, false);
  if ("error" in l) return { ok: false, error: l.error! };
  const r = await syncKlaviyo(l.admin, clientId);
  revalidatePath(`/clients/${l.slug}`);
  revalidatePath("/settings");
  return r.ok ? { ok: true } : { ok: false, error: (r.error ?? "The sync failed.").slice(0, 240) };
}


/** The account's metrics, to pick the one that counts as the sale (anyone on the client can look) */
export async function klaviyoMetrics(clientId: string) {
  const l = await mine(clientId, false);
  if ("error" in l) return { ok: false as const, error: l.error! };
  return klaviyoMetricChoices(l.admin, clientId);
}

/**
 * Count this metric as the sale (Toast's Placed Order, Eventbrite's Bought Ticket...): a lead or an exec, like the key.
 * The 90 days are read again with it, after the answer.
 */
export async function chooseKlaviyoMetric(clientId: string, metricId: string, name: string): Promise<Result> {
  const l = await mine(clientId, true);
  if ("error" in l) return { ok: false, error: l.error! };
  const r = await setKlaviyoMetric(l.admin, clientId, { id: String(metricId).slice(0, 64), name: String(name) }, l.me.id);
  if (!r.ok) return r;
  const admin = l.admin;
  after(() => syncKlaviyo(admin, clientId, { window: "full" }).then(() => undefined));
  revalidatePath(`/clients/${l.slug}`);
  return { ok: true };
}
