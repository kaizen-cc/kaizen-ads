import { isExecOrLead, requireStaff, seesAllClients } from "@/lib/auth";
import { freshness, nyToday } from "@/lib/dates";
import { SLOTS, type SlotRole, type TeamRole } from "@/lib/roles";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Option } from "./assign-select";
import { type ClientCard } from "./client-grid";
import { ClientsBrowser } from "./clients-browser";
import { ArchivedList, type ArchiveLog } from "./archived-list";
import { SERVICES, servicesOf, type ServiceSlug } from "@/lib/services";

type Row = {
  id: string;
  name: string;
  slug: string;
  status: string;
  client_type: string;
  creative_package: boolean;
  creative_package_until: string | null;
  meta_ad_account_id: string | null;
  slack_channel_id: string | null;
  internal_slack_channel_id: string | null;
  drive_folder_id: string | null;
  services: string[] | null;
  services_extra: string[] | null;
  creative_packages: { label: string } | null;
  client_assignments: { role: string; profile_id: string; profiles: { full_name: string } | null }[];
  contact_clients: { contact_id: string }[];
};

export default async function Clients({ searchParams }: PageProps<"/clients">) {
  const me = await requireStaff();
  const { view } = await searchParams;

  const supabase = await createClient();
  const req = supabase
    .from("clients")
    .select(
      "id, name, slug, status, client_type, creative_package, creative_package_until, meta_ad_account_id, slack_channel_id, internal_slack_channel_id, drive_folder_id, services, services_extra, creative_packages(label), client_assignments(role, profile_id, profiles(full_name)), contact_clients(contact_id)",
    )
    .neq("status", "offboarded")
    .order("name");
  const [{ data }, { data: staff }, { data: usage }, { data: open }, { data: snaps }, { data: archived }, { data: kpiRows }] = await Promise.all([
    req,
    supabase.from("profiles").select("id, full_name, role").eq("is_active", true).order("full_name"),
    supabase.from("client_allotment_usage").select("*"),
    supabase.from("requests").select("client_id").neq("stage", "launched"),
    supabase.from("meta_snapshots").select("client_id, fetched_at").order("fetched_at", { ascending: false }).limit(500),
    supabase.from("clients").select("id, name, slug, archived_at, archive_reason, archive_source").not("archived_at", "is", null).order("archived_at", { ascending: false }),
    // Which ad platforms each client is set up on (Track's service list is often empty)
    supabase.from("kpi_targets").select("client_id, platform").eq("active", true),
  ]);
  const platforms = new Map<string, Set<string>>();
  for (const k of kpiRows ?? []) platforms.set(k.client_id as string, (platforms.get(k.client_id as string) ?? new Set()).add(k.platform as string));
  // What each client is on: what they buy, or what's set up for them
  const servicesFor = (r: Row): ServiceSlug[] => {
    const bought = new Set<string>(servicesOf(r));
    if (r.meta_ad_account_id || platforms.get(r.id)?.has("meta")) bought.add("facebook-ads");
    if (platforms.get(r.id)?.has("google")) bought.add("google-ads");
    if (pkgOf(r) !== "none") bought.add("creative");
    return SERVICES.filter((s) => bought.has(s.slug)).map((s) => s.slug);
  };
  // The people each service needs: a slot only shows (and only counts as missing) when the client has that service
  const SLOT_SERVICE: Record<string, ServiceSlug> = { meta_buyer: "facebook-ads", google_buyer: "google-ads", graphic_designer: "creative", video_editor: "creative" };
  // The archive log: every archive and restore, who did it, why, and what was set aside
  const { data: log } = archived?.length || isExecOrLead(me)
    ? await supabase.from("client_archive_events").select("client_id, action, reason, source, set_aside, at, profiles(full_name), clients(name, slug)").order("at", { ascending: false }).limit(300)
    : { data: [] };
  const rows = (data ?? []) as unknown as Row[];
  // A sprint counts until its end date (the scheduled job switches it off the day after)
  const today = nyToday();
  const pkgOf = (r: Row): ClientCard["pkg"] =>
    !r.creative_package || (r.creative_package_until && r.creative_package_until < today) ? "none" : r.creative_package_until ? "sprint" : "ongoing";

  // When each connection last synced (bookmarks are server-side; timestamps only)
  const keys = rows.flatMap((r) => [r.slack_channel_id && `slack:${r.slack_channel_id}`, r.internal_slack_channel_id && `slack:${r.internal_slack_channel_id}`, r.drive_folder_id && `drive:${r.drive_folder_id}`]).filter(Boolean) as string[];
  const { data: synced } = adminConfigured() && keys.length ? await createAdminClient().from("sync_state").select("source, last_run_at").in("source", keys) : { data: [] };
  const syncedAt = new Map((synced ?? []).map((s) => [s.source as string, s.last_run_at as string | null]));
  const metaAt = new Map<string, string>();
  for (const s of snaps ?? []) if (!metaAt.has(s.client_id)) metaAt.set(s.client_id, s.fetched_at);
  const tone = (linked: unknown, at: string | null | undefined) => (linked ? freshness(at).tone : null);
  const newest = (...xs: (string | null | undefined)[]) => xs.filter(Boolean).sort().pop() ?? null;

  const canEdit = isExecOrLead(me);
  const optionsFor = (eligible: readonly TeamRole[]): Option[] =>
    (staff ?? []).filter((p) => eligible.includes(p.role as TeamRole)).map((p) => ({ id: p.id, name: p.full_name }));
  const slotOptions = Object.fromEntries(SLOTS.map((s) => [s.value, optionsFor(s.eligible)])) as Record<SlotRole, Option[]>;
  const current = (r: Row, slot: string): Option | null => {
    const a = r.client_assignments.find((x) => x.role === slot);
    return a ? { id: a.profile_id, name: a.profiles?.full_name ?? "Unknown" } : null;
  };
  const missing = (r: Row) => SLOTS.filter((s) => servicesFor(r).includes(SLOT_SERVICE[s.value]) && !current(r, s.value)).length + (r.contact_clients.length ? 0 : 1);
  const inFlight = new Map<string, number>();
  for (const o of open ?? []) inFlight.set(o.client_id, (inFlight.get(o.client_id) ?? 0) + 1);

  // Clients on a package first, then the rest; alphabetical within each
  const ordered = [...rows].sort((a, b) => Number(pkgOf(a) === "none") - Number(pkgOf(b) === "none") || a.name.localeCompare(b.name));
  const cards = ordered.map((r) => {
    const u = (usage ?? []).find((x) => x.client_id === r.id);
    return {
      missing: missing(r),
      services: servicesFor(r),
      pkg: pkgOf(r),
      until: r.creative_package_until,
      id: r.id,
      name: r.name,
      slug: r.slug,
      status: r.status,
      whiteLabel: r.client_type === "whitelabel",
      packageLabel: r.creative_packages?.label ?? null,
      images: { used: u?.images_used ?? 0, cap: u?.images_per_month ?? 0 },
      videos: { used: u?.videos_used ?? 0, cap: u?.videos_per_month ?? 0 },
      inFlight: inFlight.get(r.id) ?? 0,
      contacts: r.contact_clients.length,
      live: {
        meta: tone(r.meta_ad_account_id, metaAt.get(r.id)),
        slack: tone(r.slack_channel_id || r.internal_slack_channel_id, newest(syncedAt.get(`slack:${r.slack_channel_id}`), syncedAt.get(`slack:${r.internal_slack_channel_id}`))),
        drive: tone(r.drive_folder_id, syncedAt.get(`drive:${r.drive_folder_id}`)),
      },
      assigned: Object.fromEntries(SLOTS.map((s) => [s.value, current(r, s.value)])) as Record<SlotRole, Option | null>,
    } satisfies ClientCard;
  });

  return (
    <div className="grid gap-7">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-[32px] leading-tight">Clients</h1>
          <p className="mt-1.5 text-sm text-muted">
            {canEdit
              ? "Every client, with their creative package and team. Assign people right on the card; changes save instantly."
              : seesAllClients(me)
                ? "Every client, their creative package and who's on it."
                : "The clients you're on."}
          </p>
        </div>
        {(archived?.length ?? 0) > 0 && (
          <a href="#archived" className="inline-flex min-h-11 items-center text-sm text-muted hover:text-fg md:min-h-0">
            Archived <span className="text-faint">{archived!.length}</span> →
          </a>
        )}
      </header>

      <ClientsBrowser cards={cards} slotOptions={slotOptions} canEdit={canEdit} />

      <ArchivedList
        canRestore={canEdit}
        startOpen={view === "archived"}
        clients={(archived ?? []).map((c) => ({ id: c.id, name: c.name, slug: c.slug, at: c.archived_at!, reason: c.archive_reason, source: c.archive_source }))}
        log={(log ?? []).map((e) => ({
          clientId: e.client_id,
          name: (e.clients as unknown as { name: string; slug: string } | null)?.name ?? null,
          slug: (e.clients as unknown as { name: string; slug: string } | null)?.slug ?? null,
          action: e.action as "archived" | "restored",
          reason: e.reason,
          source: e.source,
          at: e.at,
          by: (e.profiles as unknown as { full_name: string } | null)?.full_name ?? null,
          setAside: (e.set_aside ?? {}) as ArchiveLog["setAside"],
        }))}
      />
    </div>
  );
}
