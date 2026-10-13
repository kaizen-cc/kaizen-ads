import Link from "next/link";
import { requireStaff, seesAllClients } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

type Row = {
  id: string;
  name: string;
  slug: string;
  status: string;
  meta_ad_account_id: string | null;
  client_assignments: { role: string; profiles: { full_name: string } | null }[];
  contact_clients: { contact_id: string }[];
};

const STATUS_STYLE: Record<string, string> = {
  active: "bg-ok-soft text-ok",
  onboarding: "bg-brand-soft text-brand-text",
  paused: "bg-warn-soft text-warn",
  offboarded: "bg-surface-2 text-faint",
};

export default async function Clients({ searchParams }: PageProps<"/clients">) {
  const me = await requireStaff();
  const { q, status } = await searchParams;
  const query = typeof q === "string" ? q.trim() : "";
  const statusFilter = typeof status === "string" ? status : "active";

  const supabase = await createClient();
  let req = supabase
    .from("clients")
    .select("id, name, slug, status, meta_ad_account_id, client_assignments(role, profiles(full_name)), contact_clients(contact_id)")
    .order("name");
  if (statusFilter !== "all") req = req.eq("status", statusFilter);
  if (query) req = req.ilike("name", `%${query}%`);
  const { data } = await req;
  const rows = (data ?? []) as unknown as Row[];

  const who = (r: Row, role: string) =>
    r.client_assignments.filter((a) => a.role === role).map((a) => a.profiles?.full_name).filter(Boolean).join(", ");

  return (
    <div className="grid gap-5">
      <div>
        <h1 className="font-heading text-2xl">Clients</h1>
        <p className="mt-1 text-sm text-muted">
          {seesAllClients(me) ? "Every client" : "Clients you're assigned to"}. Missing a buyer, creative or contact? Fix it here before requests start flowing.
        </p>
      </div>

      <form className="flex flex-wrap gap-2" role="search">
        <input
          name="q"
          defaultValue={query}
          placeholder="Search clients"
          className="h-9 w-64 max-w-full rounded-brand border border-line bg-surface px-3 text-sm outline-none focus:border-brand-text"
        />
        <select name="status" defaultValue={statusFilter} className="h-9 rounded-brand border border-line bg-surface px-2 text-sm">
          <option value="active">Active</option>
          <option value="onboarding">Onboarding</option>
          <option value="paused">Paused</option>
          <option value="offboarded">Offboarded</option>
          <option value="all">All</option>
        </select>
        <button className="h-9 rounded-brand bg-surface-2 px-3 text-sm">Filter</button>
      </form>

      <div className="overflow-x-auto rounded-brand border border-line">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-surface text-left text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Client</th>
              <th className="px-3 py-2 font-medium">Meta buyer</th>
              <th className="px-3 py-2 font-medium">Designer</th>
              <th className="px-3 py-2 font-medium">Video editor</th>
              <th className="px-3 py-2 font-medium">Contacts</th>
              <th className="px-3 py-2 font-medium">Ad account</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-line hover:bg-surface">
                <td className="px-3 py-2">
                  <Link href={`/clients/${r.slug}`} className="font-medium hover:text-brand-text">
                    {r.name}
                  </Link>
                  <span className={`ml-2 rounded-full px-2 py-0.5 text-[11px] ${STATUS_STYLE[r.status] ?? ""}`}>{r.status}</span>
                </td>
                <td className="px-3 py-2">{who(r, "meta_buyer") || <Missing />}</td>
                <td className="px-3 py-2">{who(r, "graphic_designer") || <Missing />}</td>
                <td className="px-3 py-2">{who(r, "video_editor") || <Missing />}</td>
                <td className="tabular px-3 py-2">{r.contact_clients.length || <Missing />}</td>
                <td className="tabular px-3 py-2 text-muted">{r.meta_ad_account_id ?? <Missing />}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-muted">
                  No clients match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-faint">{rows.length} clients</p>
    </div>
  );
}

const Missing = () => <span className="text-faint">—</span>;
