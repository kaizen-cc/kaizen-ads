import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { RequestForm } from "./request-form";

export default async function NewRequest({ searchParams }: PageProps<"/requests/new">) {
  await requireStaff();
  const { client } = await searchParams;
  const supabase = await createClient();
  const [{ data: clients }, { data: angles }, { data: assignments }] = await Promise.all([
    supabase.from("clients").select("id, name, slug").in("status", ["active", "onboarding"]).order("name"),
    supabase.from("angles").select("client_id, name").eq("status", "active").order("name"),
    supabase.from("client_assignments").select("client_id, role, profiles(full_name)"),
  ]);

  const anglesByClient: Record<string, string[]> = {};
  for (const a of angles ?? []) (anglesByClient[a.client_id] ??= []).push(a.name);
  const teamByClient: Record<string, Record<string, string>> = {};
  for (const a of assignments ?? []) {
    (teamByClient[a.client_id] ??= {})[a.role] = (a.profiles as unknown as { full_name: string } | null)?.full_name ?? "";
  }

  return (
    <div className="mx-auto grid max-w-3xl gap-8">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">New request</p>
        <h1 className="mt-2 font-heading text-3xl">What do we need to make?</h1>
        <p className="mt-2 text-sm text-muted">It goes straight to the client&apos;s designer or editor with its turnaround running.</p>
      </div>
      <RequestForm
        clients={clients ?? []}
        anglesByClient={anglesByClient}
        teamByClient={teamByClient}
        initialClient={typeof client === "string" ? (clients ?? []).find((c) => c.slug === client)?.id ?? null : null}
      />
    </div>
  );
}
