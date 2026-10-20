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
