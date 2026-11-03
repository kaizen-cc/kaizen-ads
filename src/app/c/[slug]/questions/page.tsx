import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getViewer } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { QuestionsView } from "./questions-view";

export const metadata: Metadata = { title: "A few questions · Kaizen", robots: { index: false, follow: false } };
// An answer is folded into their brand plan as it's given
export const maxDuration = 300;

// The questions only the client can answer for their brand plan (offers, claims, what's in stock…), one tap where
// there are options. "I don't know" is a fine answer: it goes to the right person on our team.
export default async function QuestionsPage({ params }: { params: Promise<{ slug: string }> }) {
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
  const { syncQuestions } = await import("@/lib/bible-questions");
  const all = await syncQuestions(admin, client.id);
  const firstName = viewer.kind === "contact" ? (viewer.fullName?.split(" ")[0] ?? null) : null;
  return (
    <main>
      <QuestionsView
        slug={client.slug}
        brand={client.name}
        firstName={firstName}
        open={all.filter((q) => q.stage === "client").map((q) => ({ id: q.id, question: q.question, category: q.category, options: q.options, multi: q.multi, thread: q.thread }))}
        answered={all.filter((q) => q.answeredVia === "client").length}
      />
    </main>
  );
}
