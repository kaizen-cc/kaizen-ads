import Link from "next/link";
import { isExecOrLead, requireStaff, seesAllClients } from "@/lib/auth";
import { freshness } from "@/lib/dates";
import { SLOTS, type SlotRole, type TeamRole } from "@/lib/roles";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Option } from "./assign-select";
import { type ClientCard } from "./client-grid";
import { ClientsBrowser } from "./clients-browser";

type Row = {
  id: string;
  name: string;
  slug: string;
  status: string;
  client_type: string;
  creative_package: boolean;
  meta_ad_account_id: string | null;
  slack_channel_id: string | null;
  internal_slack_channel_id: string | null;
  drive_folder_id: string | null;
  creative_packages: { label: string } | null;
  client_assignments: { role: string; profile_id: string; profiles: { full_name: string } | null }[];
  contact_clients: { contact_id: string }[];
};

export default async function Clients({ searchParams }: PageProps<"/clients">) {
  const me = await requireStaff();
  const { view, gaps } = await searchParams;
  const tab = view === "other" ? "other" : "creative";
  const onlyGaps = gaps === "1";

  const supabase = await createClient();
  const req = supabase
    .from("clients")
    .select(
      "id, name, slug, status, client_type, creative_package, meta_ad_account_id, slack_channel_id, internal_slack_channel_id, drive_folder_id, creative_packages(label), client_assignments(role, profile_id, profiles(full_name)), contact_clients(contact_id)",
    )
    .neq("status", "offboarded")
    .order("name");
  const [{ data }, { data: staff }, { data: usage }, { data: open }, { data: snaps }] = await Promise.all([
    req,
    supabase.from("profiles").select("id, full_name, role").eq("is_active", true).order("full_name"),
    supabase.from("client_allotment_usage").select("*"),
    supabase.from("requests").select("client_id").neq("stage", "launched"),
    supabase.from("meta_snapshots").select("client_id, fetched_at").order("fetched_at", { ascending: false }).limit(500),
  ]);
  const rows = (data ?? []) as unknown as Row[];
  const creative = rows.filter((r) => r.creative_package);
  const other = rows.filter((r) => !r.creative_package && r.status !== "paused");

  // When each connection last synced (bookmarks are server-side; timestamps only)
  const keys = creative.flatMap((r) => [r.slack_channel_id && `slack:${r.slack_channel_id}`, r.internal_slack_channel_id && `slack:${r.internal_slack_channel_id}`, r.drive_folder_id && `drive:${r.drive_folder_id}`]).filter(Boolean) as string[];
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
  const missing = (r: Row) => SLOTS.filter((s) => !current(r, s.value)).length + (r.contact_clients.length ? 0 : 1);
  const inFlight = new Map<string, number>();
  for (const o of open ?? []) inFlight.set(o.client_id, (inFlight.get(o.client_id) ?? 0) + 1);

  const gapCount = creative.filter((r) => missing(r) > 0).length;
  const shown = onlyGaps ? creative.filter((r) => missing(r) > 0) : creative;
  const cards: ClientCard[] = shown.map((r) => {
    const u = (usage ?? []).find((x) => x.client_id === r.id);
    return {
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
    };
  });

  const link = (params: Record<string, string>) => {
    const merged: Record<string, string> = { view: tab === "other" ? "other" : "", gaps: onlyGaps ? "1" : "", ...params };
    const sp = new URLSearchParams(Object.entries(merged).filter(([, v]) => v));
    return `/clients${sp.size ? `?${sp}` : ""}`;
  };
  const pill = (on: boolean) => `inline-flex h-9 items-center gap-2 rounded-full px-4 text-sm transition-colors ${on ? "bg-fg text-bg" : "text-muted hover:bg-surface-2 hover:text-fg"}`;

  return (
    <div className="grid gap-7">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-[32px] leading-tight">Clients</h1>
          <p className="mt-1.5 text-sm text-muted">
            {tab === "other"
              ? "Current clients without a creative package. Each one is an upsell conversation."
              : canEdit
                ? "Everyone on a creative package. Assign the team right on the card; changes save instantly."
                : seesAllClients(me)
                  ? "Everyone on a creative package and who's on it."
                  : "The clients you're on."}
          </p>
        </div>
      </header>

      <ClientsBrowser
        tab={tab}
        cards={cards}
        other={other.map((r) => ({ id: r.id, name: r.name, slug: r.slug, status: r.status, whiteLabel: r.client_type === "whitelabel", buyer: current(r, "meta_buyer")?.name ?? null }))}
        slotOptions={slotOptions}
        canEdit={canEdit}
        emptyText={tab === "other" ? "Every current client is on a creative package." : onlyGaps ? "Every creative client is fully staffed." : "No clients on a creative package yet."}
        nav={
      <nav className="flex flex-wrap items-center gap-1.5">
          <Link href={link({ view: "", gaps: "" })} className={pill(tab === "creative" && !onlyGaps)}>
            Creative clients <span className="tabular opacity-60">{creative.length}</span>
          </Link>
          <Link href={link({ view: "other", gaps: "" })} className={pill(tab === "other")}>
            Not on a package <span className="tabular opacity-60">{other.length}</span>
          </Link>
          {tab === "creative" && gapCount > 0 && (
            <>
              <span className="mx-1 h-4 w-px bg-line" />
              <Link
                href={link({ gaps: onlyGaps ? "" : "1" })}
                className={`inline-flex h-9 items-center gap-2 rounded-full px-4 text-sm transition-colors ${onlyGaps ? "bg-warn-soft text-warn" : "text-muted hover:bg-surface-2 hover:text-fg"}`}
              >
                Missing someone <span className="tabular opacity-70">{gapCount}</span>
              </Link>
            </>
          )}
        </nav>
        }
      />
    </div>
  );
}
