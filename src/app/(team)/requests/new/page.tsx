import { aiEnabled } from "@/lib/ai";
import { toAllotment, type Allotment, type UsageRow } from "@/lib/allotment";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { RequestForm } from "./request-form";

// The AI review can take a little while
export const maxDuration = 60;

export default async function NewRequest({ searchParams }: PageProps<"/requests/new">) {
  await requireStaff();
  const { client } = await searchParams;
  const supabase = await createClient();
  const [{ data: rows }, { data: usage }, { data: angles }, { data: assignments }] = await Promise.all([
    supabase.from("clients").select("id, name, slug, status, creative_package").neq("status", "offboarded").order("name"),
    supabase.from("client_allotment_usage").select("*"),
    supabase.from("angles").select("client_id, name").eq("status", "active").order("name"),
    supabase.from("client_assignments").select("client_id, role, profiles(full_name)"),
  ]);

  // Clients whose package is live (a sprint counts until its end date) can be picked.
  // Other current clients show greyed out, as an upsell prompt.
  const allotments: Record<string, Allotment> = {};
  for (const u of (usage ?? []) as UsageRow[]) allotments[u.client_id] = toAllotment(u);
  const clients = (rows ?? [])
    .filter((c) => c.creative_package || c.status === "active" || c.status === "onboarding")
    .map((c) => ({ id: c.id, name: c.name, slug: c.slug, creative: c.id in allotments }));

  const anglesByClient: Record<string, string[]> = {};
  for (const a of angles ?? []) (anglesByClient[a.client_id] ??= []).push(a.name);
  const teamByClient: Record<string, Record<string, string>> = {};
  for (const a of assignments ?? []) {
    (teamByClient[a.client_id] ??= {})[a.role] = (a.profiles as unknown as { full_name: string } | null)?.full_name ?? "";
  }

  return (
    <div className="mx-auto max-w-5xl">
      <RequestForm
        clients={clients}
        allotments={allotments}
        anglesByClient={anglesByClient}
        teamByClient={teamByClient}
        aiOn={aiEnabled()}
        initialClient={typeof client === "string" ? (clients.find((c) => c.slug === client && c.creative)?.id ?? null) : null}
      />
    </div>
  );
}
