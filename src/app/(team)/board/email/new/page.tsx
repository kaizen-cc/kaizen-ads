import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { seesEmailBoard } from "@/lib/roles";
import { servicesOf } from "@/lib/services";
import { createClient } from "@/lib/supabase/server";
import { emailAllotments } from "@/lib/email-request";
import { EmailRequestForm } from "./email-request-form";

// The strategist plans and the copywriter writes the whole batch here (a minute or two on a slow day)
export const maxDuration = 300;

// A new email request, built like the creative request: pick the client (their email allotment for the cycle on the
// card), start from a suggestion (their own ideas, what worked for similar brands in their industry, the flows they're
// missing, copy drafted from their SOW), by chatting or calling the Email Strategist, or by filling it in. The
// strategist plans the emails, the copywriter writes them, the person edits and comments (the copywriter learns), then
// approves (a Google Doc in the client's HQ under Email Marketing) and sends one batched request to Asana.
export default async function NewEmailRequest({ searchParams }: PageProps<"/board/email/new">) {
  const me = await requireStaff();
  if (!seesEmailBoard(me)) redirect("/requests/new");
  const { client, idea, doc } = await searchParams;
  const db = await createClient();
  const { data } = await db.from("clients").select("id, name, slug, services, services_extra, services_removed, industry_detail, industry, strategy_only, email_supplies_content, email_supplies_sheet").is("archived_at", null).in("status", ["active", "onboarding"]).order("name");
  const clients = (data ?? [])
    // Strategy-only email (no copy or design) never gets requests
    .filter((c) => (servicesOf(c) as string[]).includes("email-marketing") && !((c.strategy_only ?? []) as string[]).includes("email-marketing"))
    .map((c) => ({ id: c.id as string, name: c.name as string, slug: c.slug as string, industry: ((c.industry_detail ?? c.industry) as string | null) ?? null, supplies: c.email_supplies_content ? { sheet: (c.email_supplies_sheet as string | null) ?? null } : null }));
  const [allotments, { data: seats }] = await Promise.all([
    emailAllotments(db, clients.map((c) => c.id)),
    db.from("client_assignments").select("client_id, profiles(full_name)").eq("role", "email_strategist").eq("is_primary", true),
  ]);
  const strategists: Record<string, string> = {};
  for (const s of seats ?? []) {
    const n = (s.profiles as unknown as { full_name: string } | null)?.full_name;
    if (n) strategists[s.client_id as string] = n;
  }
  const initialClient = typeof client === "string" ? (clients.find((c) => c.slug === client)?.id ?? null) : null;
  return (
    <div className="mx-auto max-w-6xl">
      <EmailRequestForm
        clients={clients}
        allotments={allotments}
        strategists={strategists}
        initialClient={initialClient}
        initialIdea={typeof idea === "string" && /^[0-9a-f-]{36}$/i.test(idea) ? idea : null}
        initialDoc={typeof doc === "string" && /^[0-9a-f-]{36}$/i.test(doc) ? doc : null}
      />
    </div>
  );
}
