import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { seesEmailBoard } from "@/lib/roles";
import { servicesOf } from "@/lib/services";
import { createClient } from "@/lib/supabase/server";
import { EmailRequestForm } from "./email-request-form";

// The AI writes the brief here (about a minute on a slow day)
export const maxDuration = 300;

// A new email request: pick the client, start from a suggestion (their own ideas, what worked elsewhere, the flows
// every store should have) or an idea of your own, and the AI writes the brief for a flow or a campaign batch.
export default async function NewEmailRequest({ searchParams }: PageProps<"/board/email/new">) {
  const me = await requireStaff();
  if (!seesEmailBoard(me)) redirect("/requests/new");
  const { client } = await searchParams;
  const db = await createClient();
  const { data } = await db.from("clients").select("id, name, slug, services, services_extra, services_removed").is("archived_at", null).in("status", ["active", "onboarding"]).order("name");
  const clients = (data ?? []).filter((c) => (servicesOf(c) as string[]).includes("email-marketing")).map((c) => ({ id: c.id as string, name: c.name as string, slug: c.slug as string }));
  return <EmailRequestForm clients={clients} initialClient={typeof client === "string" ? (clients.find((c) => c.slug === client)?.id ?? null) : null} />;
}
