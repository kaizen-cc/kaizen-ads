import { notFound } from "next/navigation";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { BibleTurn } from "../brand-bible-actions";
import { BibleViewer } from "./bible-viewer";

// The Brand Bible's review page: the whole Bible laid out section by section (not one wall of text), a PDF of it, and
// the review chat where the team clears its open questions with the strategist.

export const maxDuration = 300; // a review chat answer can rewrite several sections

export default async function BrandBiblePage({ params }: { params: Promise<{ slug: string }> }) {
  const me = await requireStaff();
  const { slug } = await params;
  const supabase = await createClient();
  const { data: client } = await supabase.from("clients").select("id, name, slug").eq("slug", slug).maybeSingle();
  if (!client) notFound();
  const { data: b } = await supabase
    .from("client_brand_bibles")
    .select("status, version, markdown, read_this_first, team_notes, open_questions, generated_at, reviewed_at, learnings, review_chat, profiles!client_brand_bibles_reviewed_by_fkey(full_name)")
    .eq("client_id", client.id)
    .maybeSingle();
  if (!b?.markdown) notFound();
  return (
    <BibleViewer
      client={{ id: client.id, name: client.name, slug: client.slug }}
      canEdit={isExecOrLead(me)}
      bible={{
        status: b.status,
        version: b.version,
        markdown: b.markdown,
        readThisFirst: b.read_this_first ?? "",
        teamNotes: (b.team_notes ?? []) as string[],
        openQuestions: (b.open_questions ?? []) as { question: string; who: string }[],
        generatedAt: b.generated_at,
        reviewedAt: b.reviewed_at,
        reviewedBy: (b.profiles as unknown as { full_name: string } | null)?.full_name ?? null,
        learnings: (b.learnings ?? []) as { at: string; kind: string; text: string }[],
        chat: (b.review_chat ?? []) as BibleTurn[],
      }}
    />
  );
}
