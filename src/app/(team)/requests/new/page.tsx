import { aiEnabled } from "@/lib/ai";
import { toAllotment, type Allotment, type UsageRow } from "@/lib/allotment";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import type { Draft, Size } from "./draft";
import { createClient } from "@/lib/supabase/server";
import { RequestForm } from "./request-form";
import { LIVE } from "@/lib/live";

// The AI review can take a little while
export const maxDuration = 60;

export default async function NewRequest({ searchParams }: PageProps<"/requests/new">) {
  const me = await requireStaff();
  const { client, from, brief } = await searchParams;
  const supabase = await createClient();
  const [{ data: rows }, { data: usage }, { data: angles }, { data: assignments }] = await Promise.all([
    supabase.from("clients").select("id, name, slug, status, creative_package").is("archived_at", null).in("status", LIVE).order("name"),
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

  // Starting again from a deleted ticket (Settings › Deleted): its brief, ready to send as is or to edit
  const restart = typeof from === "string" && isExecOrLead(me) ? await fromDeleted(from) : null;

  return (
    <div className="mx-auto max-w-5xl">
      <RequestForm
        initialDraft={restart?.draft ?? null}
        startAtReview={Boolean(restart) && brief === "same"}
        clients={clients}
        allotments={allotments}
        anglesByClient={anglesByClient}
        teamByClient={teamByClient}
        aiOn={aiEnabled()}
        initialClient={restart?.draft.clientId ?? (typeof client === "string" ? (clients.find((c) => c.slug === client && c.creative)?.id ?? null) : null)}
      />
    </div>
  );
}

/** A deleted ticket as a new request's draft. */
async function fromDeleted(id: string): Promise<{ draft: Partial<Draft> & { clientId: string } } | null> {
  if (!adminConfigured()) return null;
  const { data: r } = await createAdminClient()
    .from("requests")
    .select("number, client_id, title, format, new_count, variation_count, sizes, audience, brief, refs, landing_url, priority, origin, deleted_at, angles(name)")
    .eq("id", id)
    .maybeSingle();
  if (!r?.deleted_at) return null;
  const refs = r.refs as unknown;
  return {
    draft: {
      clientId: r.client_id,
      title: r.title,
      formats: { [r.format]: { new: r.new_count, variations: r.variation_count } },
      sizes: ((r.sizes ?? []) as Size[]).length ? (r.sizes as Size[]) : ["4x5", "9x16"],
      angle: (r.angles as unknown as { name: string } | null)?.name ?? "",
      audience: r.audience ?? "",
      priority: r.priority ?? "normal",
      brief: r.brief ?? "",
      refs: Array.isArray(refs) ? refs.join("\n") : typeof refs === "string" ? refs : "",
      landing: r.landing_url ?? "",
      origin: { kind: "brief", label: `Started again from deleted ticket #${r.number}${(r.origin as { label?: string } | null)?.label ? `, built on ${(r.origin as { label: string }).label}` : ""}`.slice(0, 200) },
    },
  };
}
