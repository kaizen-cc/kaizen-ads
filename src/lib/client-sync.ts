import "server-only";
import { createClient as createSupabase, type SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";
import { backInCycle } from "@/lib/reactivate";

// Clients stay in step with Kaizen Track. The enrollment and upsell Zaps post to both apps (instant); this hourly
// mirror catches anything done by hand in Track: a client archived there is archived here, made active again it
// comes back, a new one is added, a creative package added or upgraded is applied. A package removed in Track is
// reported, not applied, so a slip there never switches off a client's creative here.

export const trackConfigured = () => Boolean(process.env.TRACK_SUPABASE_URL && process.env.TRACK_SUPABASE_SECRET_KEY);

type TrackClient = { id: string; name: string; external_id: string | null; status: "active" | "archived"; creative_package: string | null; is_internal: boolean };
type Ours = { id: string; name: string; kaizen_id: number | null; track_client_id: string | null; archived_at: string | null; archive_source: string | null; creative_package: boolean; creative_package_key: string | null };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export async function mirrorTrack(admin: SupabaseClient) {
  if (!trackConfigured()) return { skipped: "TRACK_SUPABASE_URL / TRACK_SUPABASE_SECRET_KEY not set" };
  const track = createSupabase(process.env.TRACK_SUPABASE_URL!, process.env.TRACK_SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });
  const { data: theirs, error } = await track.from("clients").select("id, name, external_id, status, creative_package, is_internal");
  if (error) throw new Error(`Kaizen Track: ${error.message}`);
  const { data: ours } = await admin.from("clients").select("id, name, kaizen_id, track_client_id, archived_at, archive_source, creative_package, creative_package_key");
  const list = (ours ?? []) as Ours[];
  const byTrack = new Map(list.filter((c) => c.track_client_id).map((c) => [c.track_client_id!, c]));
  const byKaizen = new Map(list.filter((c) => c.kaizen_id != null).map((c) => [c.kaizen_id!, c]));
  const byName = new Map(list.map((c) => [norm(c.name), c]));

  // The services each client buys (Facebook Ads, Creative, Email…): paid_ads follows from them
  const { data: svc } = await track.from("client_services").select("client_id, services!inner(slug, kind)").is("ended_at", null).eq("services.kind", "sold");
  const servicesOf = new Map<string, string[]>();
  for (const r of svc ?? []) {
    const slug = (r.services as unknown as { slug: string }).slug;
    servicesOf.set(r.client_id as string, [...(servicesOf.get(r.client_id as string) ?? []), slug].sort());
  }
  const now = new Date().toISOString();
  // Track's statuses as of the last run, to see who flipped from archived to active
  const { data: prev } = await admin.from("sync_state").select("last_result").eq("source", "track-status").maybeSingle();
  const seen = (prev?.last_result ?? {}) as Record<string, string>;

  const out = { linked: 0, services: 0, created: [] as string[], archived: [] as string[], restored: [] as string[], packages: [] as string[], packageRemovedInTrack: [] as string[], errors: [] as string[] };
  for (const t of (theirs ?? []) as TrackClient[]) {
    if (t.is_internal) continue;
    const ext = t.external_id && /^\s*\d+\s*$/.test(t.external_id) ? Number(t.external_id) : null;
    let c = byTrack.get(t.id) ?? (ext != null ? byKaizen.get(ext) : undefined) ?? byName.get(norm(t.name));
    try {
      if (!c) {
        if (t.status !== "active") continue; // never heard of, and archived there: nothing to do
        // New in Track: enrolled the same way the form would (a stable key, so it happens once)
        const { data: res, error: e } = await admin.rpc("zapier_enroll", {
          p_key: `track:${t.id}`,
          p_source: "enrollment",
          p_data: { business_name: t.name, client_id: t.external_id, creatives: Boolean(t.creative_package), creative_package: t.creative_package },
        });
        if (e) throw new Error(e.message);
        const id = (res as { client_id?: string })?.client_id;
        if (id) {
          await admin.from("clients").update({ track_client_id: t.id }).eq("id", id).is("track_client_id", null);
          out.created.push(t.name);
          // Their pre-sale audit Looms, if the senior buyer recorded any while they were a prospect
          await (await import("@/lib/loom-prospects")).attachForNewClient(admin, id);
        }
        continue;
      }
      if (c.track_client_id !== t.id) {
        await admin.from("clients").update({ track_client_id: t.id }).eq("id", c.id);
        out.linked++;
      }
      await admin.from("clients").update({ services: servicesOf.get(t.id) ?? [], services_synced_at: now }).eq("id", c.id);
      out.services++;
      if (t.status === "archived" && !c.archived_at) {
        await admin.rpc("system_archive_client", { p_client: c.id, p_reason: "Archived in Kaizen Track", p_source: "track" });
        out.archived.push(c.name);
        continue;
      }
      // Made active again in Track: back, however they were archived here (the form, the team, Track itself). Only on
      // the flip from archived, so a client archived here while still active in Track stays archived.
      if (t.status === "active" && c.archived_at && (c.archive_source === "track" || seen[t.id] === "archived")) {
        await admin.rpc("system_restore_client", { p_client: c.id, p_status: "onboarding" });
        await admin.from("clients").update({ reonboarded_at: new Date().toISOString() }).eq("id", c.id);
        out.restored.push(c.name);
        after(() => backInCycle(admin, c!.id).catch((e) => console.error("backInCycle", c!.id, e)));
        c = { ...c, archived_at: null };
      }
      if (t.status === "active" && t.creative_package && (!c.creative_package || c.creative_package_key !== t.creative_package)) {
        // Added or changed in Track: applied like the upsell form would (once per package)
        await admin.rpc("zapier_enroll", { p_key: `track:${t.id}:${t.creative_package}`, p_source: "upsell", p_data: { business_name: c.name, client_id: c.kaizen_id != null ? String(c.kaizen_id) : t.external_id, creatives: true, creative_package: t.creative_package } });
        out.packages.push(`${c.name}: ${t.creative_package}`);
      } else if (t.status === "active" && !t.creative_package && c.creative_package) out.packageRemovedInTrack.push(c.name);
    } catch (e) {
      out.errors.push(`${t.name}: ${e instanceof Error ? e.message : e}`);
    }
  }
  await billingDays(admin, track).catch((e) => console.error("[track] billing days", e));
  await admin.from("sync_state").upsert({ source: "track-status", cursor_at: now, last_run_at: now, last_result: Object.fromEntries(((theirs ?? []) as TrackClient[]).map((t) => [t.id, t.status])) });
  return out;
}

/** The re-onboarding side of the enrollment form: an archived client who signs up again comes back, with everything. */
export async function welcomeBack(admin: SupabaseClient, clientId: string) {
  const { data: c } = await admin.from("clients").select("archived_at").eq("id", clientId).maybeSingle();
  if (!c?.archived_at) return false;
  await admin.rpc("system_restore_client", { p_client: clientId, p_status: "onboarding" });
  await admin.from("clients").update({ reonboarded_at: new Date().toISOString() }).eq("id", clientId);
  after(() => backInCycle(admin, clientId).catch((e) => console.error("backInCycle", clientId, e)));
  return true;
}

/**
 * The day each client's creative is billed, from Stripe as Kaizen Track keeps it: the bill with the creative package on it
 * (its subscription's renewal, or the day its own invoice went out), else their biggest monthly subscription (Track syncs Stripe and
 * matches each subscription to a client by contact email and name; a match set by hand there wins): the next charge's
 * day of the month, capped at the 28th. The creative allotment starts again that day each month. Clients Track has no
 * subscription for fall back to when their first sold service started. A day the team set by hand is never overwritten.
 */
async function billingDays(admin: SupabaseClient, track: SupabaseClient) {
  const dayOf = (at: string) => Math.min(28, Number(new Date(at.length === 10 ? `${at}T12:00:00` : at).toLocaleDateString("en-US", { timeZone: "America/New_York", day: "numeric" })));
  const fromStripe = new Map<string, { day: number; amount: number }>();
  const [{ data: subs }, { data: manual }] = await Promise.all([
    track.from("stripe_subscriptions").select("id, client_id, next_at, amount, status, interval").in("status", ["active", "past_due", "trialing"]),
    track.from("stripe_subscription_clients").select("subscription_id, client_id"),
  ]);
  const setByHand = new Map((manual ?? []).map((m) => [m.subscription_id as string, m.client_id as string]));
  const subOf = new Map<string, { client: string; next_at: string | null }>();
  for (const r of (subs ?? []) as { id: string; client_id: string | null; next_at: string | null; amount: number | null; interval: string | null }[]) {
    const client = setByHand.get(r.id) ?? r.client_id;
    if (!client || !r.next_at || (r.interval && r.interval !== "month")) continue;
    subOf.set(r.id, { client, next_at: r.next_at });
    // Several subscriptions: the biggest is the retainer the allotment follows (unless creative is billed on its own, below)
    const cur = fromStripe.get(client);
    if (!cur || Number(r.amount ?? 0) > cur.amount) fromStripe.set(client, { day: dayOf(r.next_at), amount: Number(r.amount ?? 0) });
  }
  // The creative allotment follows the bill the creative package is on, not the ads retainer: the latest payment or open
  // invoice with a "Creative Package" line (a content package is organic social, not paid creative). If that's part of a
  // subscription, its renewal day; if it's billed on its own invoice (as many are), the day that invoice went out.
  // White-label: the Stripe customer is the agency, so the client is the one the memo names (Track matches it; if Track
  // couldn't, we look for one of our clients' names in the memo), never the subscription's owner.
  const since = new Date(Date.now() - 120 * 86_400_000).toISOString();
  const [{ data: pays }, { data: open }] = await Promise.all([
    track.from("stripe_payments").select("client_id, customer_id, subscription_id, paid_at, lines, memo, refunded, ignored").gte("paid_at", since).order("paid_at", { ascending: false }),
    track.from("stripe_open_invoices").select("client_id, customer_id, subscription_id, created_at, lines, memo"),
  ]);
  const { data: agencies } = await track.from("stripe_customers").select("id").eq("white_label", true);
  const whiteLabel = new Set((agencies ?? []).map((a) => a.id as string));
  const { data: everyone } = await admin.from("clients").select("id, name").is("archived_at", null);
  const named = (everyone ?? []).map((c) => ({ id: c.id as string, key: norm(c.name as string) })).filter((c) => c.key.length >= 4).sort((a, b) => b.key.length - a.key.length);
  /** Our client a white-label memo names ("Ads Management for 21 Property Group · …"), longest name first */
  const fromMemo = (memo: string | null) => {
    const m = norm((memo ?? "").split("·")[0]);
    return m ? (named.find((c) => m.includes(c.key))?.id ?? null) : null;
  };
  const ourCreativeDay = new Map<string, { day: number; at: string }>();
  const creative = (x: { lines?: unknown; memo?: string | null }) => /creative package/i.test(`${typeof x.lines === "string" ? x.lines : JSON.stringify(x.lines ?? "")} ${x.memo ?? ""}`);
  const creativeDay = new Map<string, { day: number; at: string }>();
  const bills = [
    ...((pays ?? []) as { client_id: string | null; customer_id: string | null; subscription_id: string | null; paid_at: string; lines: unknown; memo: string | null; refunded?: boolean | null; ignored?: boolean | null }[]).filter((x) => !x.refunded && !x.ignored).map((x) => ({ ...x, at: x.paid_at })),
    ...((open ?? []) as { client_id: string | null; customer_id: string | null; subscription_id: string | null; created_at: string; lines: unknown; memo: string | null }[]).map((x) => ({ ...x, at: x.created_at })),
  ];
  for (const x of bills) {
    if (!creative(x)) continue;
    const sub = x.subscription_id ? subOf.get(x.subscription_id) : undefined;
    const agency = Boolean(x.customer_id && whiteLabel.has(x.customer_id));
    if (agency && !x.client_id) {
      const ours = fromMemo(x.memo);
      const cur = ours ? ourCreativeDay.get(ours) : undefined;
      if (ours && (!cur || cur.at < x.at)) ourCreativeDay.set(ours, { day: dayOf(sub?.next_at ?? x.at), at: x.at });
      continue;
    }
    const client = agency ? x.client_id : (x.subscription_id && setByHand.get(x.subscription_id)) || sub?.client || x.client_id;
    if (!client) continue;
    const cur = creativeDay.get(client);
    if (cur && cur.at >= x.at) continue;
    creativeDay.set(client, { day: dayOf(sub?.next_at ?? x.at), at: x.at });
  }
  for (const [client, c] of creativeDay) fromStripe.set(client, { day: c.day, amount: Number.MAX_SAFE_INTEGER });
  const { data: rows } = await track.from("client_services").select("client_id, started_at, services!inner(kind)").is("ended_at", null).eq("services.kind", "sold");
  const first = new Map<string, string>();
  for (const r of (rows ?? []) as { client_id: string; started_at: string | null }[]) {
    if (!r.started_at) continue;
    const cur = first.get(r.client_id);
    if (!cur || r.started_at < cur) first.set(r.client_id, r.started_at);
  }
  const { data: ours } = await admin.from("clients").select("id, track_client_id, billing_day, billing_day_source").is("archived_at", null);
  for (const c of ours ?? []) {
    if (c.billing_day_source === "set") continue;
    const tid = c.track_client_id as string | null;
    const stripe = ourCreativeDay.get(c.id as string) ?? (tid ? fromStripe.get(tid) : undefined);
    const started = tid ? first.get(tid) : undefined;
    const [day, source] = stripe ? [stripe.day, "stripe"] : started ? [dayOf(started), "track"] : [0, ""];
    if (!day || (c.billing_day === day && c.billing_day_source === source)) continue;
    await admin.from("clients").update({ billing_day: day, billing_day_source: source }).eq("id", c.id);
  }
}
