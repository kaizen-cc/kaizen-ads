import Link from "next/link";
import { isExecOrLead, requireStaff, seesAllClients } from "@/lib/auth";
import { SLOTS, type SlotRole, type TeamRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import type { Option } from "./assign-select";
import { ClientsTable } from "./clients-table";

type Row = {
  id: string;
  name: string;
  slug: string;
  status: string;
  client_type: string;
  client_assignments: { role: string; profile_id: string; profiles: { full_name: string } | null }[];
  contact_clients: { contact_id: string }[];
};

const STATUSES = [
  { value: "active", label: "Active" },
  { value: "onboarding", label: "Onboarding" },
  { value: "paused", label: "Paused" },
  { value: "offboarded", label: "Offboarded" },
  { value: "all", label: "All" },
];

export default async function Clients({ searchParams }: PageProps<"/clients">) {
  const me = await requireStaff();
  const { q, status, gaps } = await searchParams;
  const query = typeof q === "string" ? q.trim() : "";
  const statusFilter = typeof status === "string" ? status : "active";
  const onlyGaps = gaps === "1";

  const supabase = await createClient();
  let req = supabase
    .from("clients")
    .select("id, name, slug, status, client_type, client_assignments(role, profile_id, profiles(full_name)), contact_clients(contact_id)")
    .order("name");
  if (statusFilter !== "all") req = req.eq("status", statusFilter);
  if (query) req = req.ilike("name", `%${query}%`);
  const [{ data }, { data: staff }] = await Promise.all([
    req,
    supabase.from("profiles").select("id, full_name, role").eq("is_active", true).order("full_name"),
  ]);

  const canEdit = isExecOrLead(me);
  const optionsFor = (eligible: readonly TeamRole[]): Option[] =>
    (staff ?? []).filter((p) => eligible.includes(p.role as TeamRole)).map((p) => ({ id: p.id, name: p.full_name }));
  const slotOptions = Object.fromEntries(SLOTS.map((s) => [s.value, optionsFor(s.eligible)]));

  const current = (r: Row, slot: string): Option | null => {
    const a = r.client_assignments.find((x) => x.role === slot);
    return a ? { id: a.profile_id, name: a.profiles?.full_name ?? "Unknown" } : null;
  };
  const missing = (r: Row) => SLOTS.filter((s) => !current(r, s.value)).length + (r.contact_clients.length ? 0 : 1);

  let rows = (data ?? []) as unknown as Row[];
  const gapCount = rows.filter((r) => missing(r) > 0).length;
  if (onlyGaps) rows = rows.filter((r) => missing(r) > 0);

  const link = (params: Record<string, string>) => {
    const merged: Record<string, string> = { q: query, status: statusFilter, gaps: onlyGaps ? "1" : "", ...params };
    const sp = new URLSearchParams(Object.entries(merged).filter(([, v]) => v));
    return `/clients?${sp}`;
  };

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl">Clients</h1>
          <p className="mt-1 text-sm text-muted">
            {canEdit ? "Pick from a dropdown to assign or reassign. Changes save instantly." : seesAllClients(me) ? "Every client and who's on it." : "The clients you're on."}
          </p>
        </div>
        <form className="flex gap-2" role="search">
          <input type="hidden" name="status" value={statusFilter} />
          <input
            name="q"
            defaultValue={query}
            placeholder="Search clients"
            aria-label="Search clients"
            className="h-10 w-64 max-w-full rounded-[8px] border border-line bg-surface px-3 text-sm outline-none transition-colors hover:border-faint/60 focus:border-brand-text/70"
          />
        </form>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {STATUSES.map((s) => (
          <Link
            key={s.value}
            href={link({ status: s.value })}
            className={`rounded-full px-3 py-1 text-sm ${statusFilter === s.value ? "bg-fg text-bg" : "text-muted hover:bg-surface-2 hover:text-fg"}`}
          >
            {s.label}
          </Link>
        ))}
        <span className="mx-1 h-4 w-px bg-line" />
        <Link
          href={link({ gaps: onlyGaps ? "" : "1" })}
          className={`rounded-full px-3 py-1 text-sm ${onlyGaps ? "bg-warn-soft text-warn" : "text-muted hover:bg-surface-2 hover:text-fg"}`}
        >
          Missing someone · {gapCount}
        </Link>
      </div>

      <ClientsTable
        rows={rows.map((r) => ({
          id: r.id,
          name: r.name,
          slug: r.slug,
          whiteLabel: r.client_type === "whitelabel",
          contacts: r.contact_clients.length,
          assigned: Object.fromEntries(SLOTS.map((s) => [s.value, current(r, s.value)])) as Record<SlotRole, Option | null>,
        }))}
        slotOptions={slotOptions as Record<SlotRole, Option[]>}
        canEdit={canEdit}
        emptyText={onlyGaps ? "Every client here is fully staffed." : "No clients match."}
      />
      <p className="text-xs text-faint">{rows.length} clients</p>
    </div>
  );
}
