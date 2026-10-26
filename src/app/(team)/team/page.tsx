import { requireStaff } from "@/lib/auth";
import type { TeamRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { TeamList, type Person } from "./team-list";
import { usageOf } from "@/lib/activity";

export default async function Team() {
  const me = await requireStaff();
  const supabase = await createClient();
  const [{ data: profiles }, { data: assignments }] = await Promise.all([
    supabase.from("profiles").select("id, email, full_name, role, is_active, joined_at, invited_at, last_active_at, last_sign_in_at").order("full_name"),
    supabase.from("client_assignments").select("profile_id, client_id, clients!inner(archived_at)").is("clients.archived_at", null),
  ]);

  // Execs: when each person was last on, and how much they use it (the activity record is theirs to see)
  const usage = me.isExec ? await usageOf(supabase, profiles ?? []) : null;

  const clientsPer = new Map<string, Set<string>>();
  for (const a of assignments ?? []) {
    if (!clientsPer.has(a.profile_id)) clientsPer.set(a.profile_id, new Set());
    clientsPer.get(a.profile_id)!.add(a.client_id);
  }

  const people: Person[] = (profiles ?? []).map((p) => ({
    id: p.id,
    email: p.email,
    fullName: p.full_name,
    role: p.role as TeamRole,
    isActive: p.is_active,
    joined: Boolean(p.joined_at),
    invitedAt: p.invited_at,
    clientCount: clientsPer.get(p.id)?.size ?? 0,
    usage: usage?.get(p.id) ?? null,
  }));

  return (
    <div className="grid min-w-0 max-w-4xl grid-cols-[minmax(0,1fr)] gap-6">
      <div>
        <h1 className="font-heading text-2xl">Team</h1>
        <p className="mt-1 text-sm text-muted">
          One role per person. The role sets what they can see and do.
          {!me.isExec && " Only executives can change roles."}
        </p>
      </div>
      <TeamList people={people} canEdit={me.isExec} meId={me.id} />
    </div>
  );
}
