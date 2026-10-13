import { ActionForm } from "@/components/action-form";
import { requireStaff } from "@/lib/auth";
import { ROLE_DEFS } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { addPerson, saveRoles } from "./actions";

type Person = Record<string, unknown> & { id: string; email: string; full_name: string; is_active: boolean; joined_at: string | null };

const field = "h-9 w-full rounded-brand border border-line bg-bg px-3 text-sm outline-none focus:border-brand-text";

function RoleChecks({ person }: { person?: Person }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {ROLE_DEFS.map((d) => (
        <label
          key={d.column}
          title={d.help}
          className="flex cursor-pointer items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-xs has-[:checked]:border-brand-text has-[:checked]:bg-brand-soft"
        >
          <input type="checkbox" name={d.column} defaultChecked={Boolean(person?.[d.column])} className="accent-[#b21e2c]" />
          {d.label}
        </label>
      ))}
    </div>
  );
}

export default async function Team() {
  const me = await requireStaff();
  const supabase = await createClient();
  const { data } = await supabase
    .from("profiles")
    .select("id, email, full_name, is_active, joined_at, is_exec, is_lead, is_creative, is_buyer, is_copywriter, is_coordinator")
    .order("is_active", { ascending: false })
    .order("full_name");
  const people = (data ?? []) as Person[];

  return (
    <div className="grid max-w-5xl gap-6">
      <div>
        <h1 className="font-heading text-2xl">Team</h1>
        <p className="mt-1 text-sm text-muted">
          Who can use Kaizen Ads and what they do. People sign in with their @kaizenmarketing.agency Google account.
          {!me.isExec && " Only executives can change roles."}
        </p>
      </div>

      <ul className="grid gap-2">
        {people.map((p) => (
          <li key={p.id} className={`grid gap-3 rounded-brand border border-line bg-surface p-4 ${p.is_active ? "" : "opacity-60"}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium">{p.full_name}</p>
                <p className="truncate text-xs text-muted">{p.email}</p>
              </div>
              <span className="text-[11px] text-faint">{p.joined_at ? "Has signed in" : "Not signed in yet"}</span>
            </div>
            {me.isExec ? (
              <ActionForm action={saveRoles.bind(null, p.id)} submitLabel="Save" className="flex flex-wrap items-center justify-between gap-3">
                <RoleChecks person={p} />
                <label className="flex items-center gap-1.5 text-xs text-muted">
                  <input type="checkbox" name="is_active" defaultChecked={p.is_active} className="accent-[#b21e2c]" />
                  Active
                </label>
              </ActionForm>
            ) : (
              <p className="text-xs text-muted">
                {ROLE_DEFS.filter((d) => p[d.column]).map((d) => d.label).join(" · ") || "No role yet"}
              </p>
            )}
          </li>
        ))}
      </ul>

      {me.isExec && (
        <section className="grid gap-3 rounded-brand border border-line bg-surface p-5">
          <h2 className="font-medium">Add someone</h2>
          <ActionForm action={addPerson} submitLabel="Add to team" resetOnSuccess className="grid gap-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="grid gap-1 text-xs text-muted">
                Name
                <input name="full_name" required className={field} />
              </label>
              <label className="grid gap-1 text-xs text-muted">
                Email
                <input name="email" type="email" required className={field} placeholder="name@kaizenmarketing.agency" />
              </label>
            </div>
            <RoleChecks />
          </ActionForm>
        </section>
      )}
    </div>
  );
}
