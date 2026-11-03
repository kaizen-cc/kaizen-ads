import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getViewer } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { IntakeView } from "./intake-view";

export const metadata: Metadata = { title: "Tell us about your business · Kaizen", robots: { index: false, follow: false } };
// The first open tailors the questions with the AI; sending reads them after the answer
export const maxDuration = 300;

// A new client's marketing intake, right after their setup steps: their questions (tailored to their services, how they
// sell and their industry, with what we know filled in), saved as they go, then booking their onboarding call.
export default async function IntakePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const viewer = await getViewer();
  const team = viewer.kind === "staff";
  if (!adminConfigured() || (!team && !viewer.brands.some((b) => b.slug === slug))) notFound();
  const admin = createAdminClient();
  const { data: client } = await admin.from("clients").select("id, name, slug, portal_live").eq("slug", slug).maybeSingle();
  if (!client || (!team && !client.portal_live)) notFound();
  if (team) {
    const { createClient } = await import("@/lib/supabase/server");
    const { data: mine } = await (await createClient()).from("clients").select("id").eq("id", client.id).maybeSingle();
    if (!mine) notFound();
  }
  const { loadIntakeForm } = await import("@/lib/intake-form");
  const row = await loadIntakeForm(admin, client.id);
  const firstName = viewer.kind === "contact" ? (viewer.fullName?.split(" ")[0] ?? null) : null;

  return (
    <main>
      <IntakeView
        slug={client.slug}
        brand={client.name}
        firstName={firstName}
        who={viewer.kind === "contact" ? { name: viewer.fullName ?? "", email: viewer.email } : null}
        form={row?.form && row.status !== "preparing" ? row.form : null}
        answers={row?.answers ?? {}}
        sent={row?.status === "submitted"}
        call={row?.call_type ? { type: row.call_type, reason: row.call_reason ?? "", computer: row.computer, booked: Boolean(row.call_booked_at) } : null}
      />
    </main>
  );
}
