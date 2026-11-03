import { notFound } from "next/navigation";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { conversionFor, conversionLabel } from "@/lib/kpi/conversions";
import { createClient } from "@/lib/supabase/server";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
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
    .select("status, version, markdown, read_this_first, overview, team_notes, open_questions, generated_at, reviewed_at, learnings, review_chat, profiles!client_brand_bibles_reviewed_by_fkey(full_name)")
    .eq("client_id", client.id)
    .maybeSingle();
  if (!b?.markdown) notFound();
  // The live KPI on each account, for the cover's corner (the goal the client gave us comes from the Bible)
  const { data: kpis } = await supabase.from("kpi_targets").select("platform, conversion, custom_action, target").eq("client_id", client.id).eq("active", true);
  const targets = (kpis ?? [])
    .filter((k) => k.target != null)
    .map((k) => ({
      platform: k.platform === "google" ? "Google" : "Meta",
      text: conversionFor(k.conversion as string).roas ? `${Number(k.target)}x return on ad spend` : `$${Number(k.target)} per ${conversionLabel(k.conversion as string, k.custom_action as string | null).toLowerCase().replace(/s$/, "")}`,
    }));
  // The open questions, routed (new ones start with whoever answers first; settled ones close)
  const { syncQuestions } = await import("@/lib/bible-questions");
  const questions = adminConfigured() ? await syncQuestions(createAdminClient(), client.id).catch(() => []) : [];
  const { loadIssues } = await import("@/lib/website-issues");
  const [issues, { data: links }, { data: pack }] = await Promise.all([
    adminConfigured() ? loadIssues(createAdminClient(), client.id).catch(() => []) : Promise.resolve([]),
    supabase.from("bible_links").select("url, label, source, ok, status, title, checked_at, change_note, changed_at").eq("client_id", client.id).order("source").limit(60),
    supabase.from("client_exports").select("created_at, reason").eq("client_id", client.id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  return (
    <BibleViewer
      client={{ id: client.id, name: client.name, slug: client.slug }}
      canEdit={isExecOrLead(me)}
      bible={{
        status: b.status,
        version: b.version,
        markdown: b.markdown,
        readThisFirst: b.read_this_first ?? "",
        overview: (b.overview ?? null) as { statement: string; mission: string; vision: string; goal: string } | null,
        targets,
        teamNotes: (b.team_notes ?? []) as string[],
        openQuestions: (b.open_questions ?? []) as { question: string; who: string }[],
        questions,
        issues,
        links: (links ?? []).map((l) => ({ url: l.url, label: l.label, source: l.source, ok: l.ok, status: l.status, title: l.title, checkedAt: l.checked_at, change: l.change_note, changedAt: l.changed_at })),
        lastExport: pack ? { at: pack.created_at, reason: pack.reason } : null,
        generatedAt: b.generated_at,
        reviewedAt: b.reviewed_at,
        reviewedBy: (b.profiles as unknown as { full_name: string } | null)?.full_name ?? null,
        learnings: (b.learnings ?? []) as { at: string; kind: string; text: string }[],
        chat: (b.review_chat ?? []) as BibleTurn[],
      }}
    />
  );
}
