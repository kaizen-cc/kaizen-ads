import { aiEnabled } from "@/lib/ai";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { RequestForm } from "./request-form";

// The AI review can take a little while
export const maxDuration = 60;

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
    <div className="mx-auto max-w-5xl">
      <RequestForm
        clients={clients ?? []}
        anglesByClient={anglesByClient}
        teamByClient={teamByClient}
        aiOn={aiEnabled()}
        initialClient={typeof client === "string" ? (clients ?? []).find((c) => c.slug === client)?.id ?? null : null}
      />
    </div>
  );
}
