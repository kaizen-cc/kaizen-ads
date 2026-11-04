import { notFound } from "next/navigation";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { conversionFor, conversionLabel } from "@/lib/kpi/conversions";
import { createClient } from "@/lib/supabase/server";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import type { BibleTurn } from "../brand-bible-actions";
import { BibleViewer, type ReviewBankInfo } from "./bible-viewer";
import type { BibleTargets } from "@/lib/ai";

/** How long a kind of AI run usually takes (the last 20 that worked), plus what runs around it; a default without any */
async function usualMs(like: string, extra: number, fallback: number) {
  if (!adminConfigured()) return fallback;
  const { data } = await createAdminClient().from("ai_runs").select("ms").like("label", like).eq("ok", true).order("created_at", { ascending: false }).limit(20);
  const ms = (data ?? []).map((r) => r.ms as number).filter((n) => n > 0);
  return ms.length ? Math.round((ms.reduce((a, b) => a + b, 0) / ms.length) * 1.25 + extra) : fallback;
}

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
    .select("status, version, markdown, read_this_first, overview, team_notes, open_questions, generated_at, reviewed_at, learnings, review_chat, review_bank, profiles!client_brand_bibles_reviewed_by_fkey(full_name)")
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
  const [issues, { data: links }, { data: pack }, { data: sheet }, { data: pres }, { data: newest }, reviewsMs, presentationMs] = await Promise.all([
    adminConfigured() ? loadIssues(createAdminClient(), client.id).catch(() => []) : Promise.resolve([]),
    supabase.from("bible_links").select("url, label, source, ok, status, title, checked_at, change_note, changed_at").eq("client_id", client.id).order("source").limit(60),
    supabase.from("client_exports").select("created_at, reason").eq("client_id", client.id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("client_onboarding_sheets").select("url, name, modified_at, read_at, error, bible, meta, google").eq("client_id", client.id).maybeSingle(),
    supabase.from("client_presentations").select("status, started_at, drafted_at, sent_at, bible_version").eq("client_id", client.id).maybeSingle(),
    supabase.from("client_presentation_versions").select("status, started_at").eq("client_id", client.id).neq("status", "superseded").order("started_at", { ascending: false }).limit(1).maybeSingle(),
    // Collecting reads the sources (about half a minute) and the AI picks the bank
    usualMs("brand bible reviews %", 30_000, 90_000),
    usualMs("client presentation %", 15_000, 60_000),
  ]);
  const rb = (b.review_bank ?? null) as (Partial<ReviewBankInfo> & { status?: ReviewBankInfo["status"] }) | null;
  // A new version written beside the one already with the client
  const beside = pres && ["sent", "approved"].includes(pres.status as string) && newest && (!pres.sent_at || Date.parse(newest.started_at as string) > Date.parse(pres.sent_at as string)) ? newest : null;
  return (
    <BibleViewer
      client={{ id: client.id, name: client.name, slug: client.slug }}
      canEdit={isExecOrLead(me)}
      bible={{
        status: b.status,
        version: b.version,
        markdown: b.markdown,
        readThisFirst: b.read_this_first ?? "",
        overview: (b.overview ?? null) as { statement: string; mission: string; vision: string; values?: string; drafted?: boolean; goal: string; targets?: BibleTargets } | null,
        reviewBank: rb
          ? {
              status: rb.status ?? null,
              startedAt: rb.startedAt ?? null,
              collectedAt: rb.collectedAt ?? null,
              error: rb.error ?? null,
              read: rb.read ?? 0,
              sources: rb.sources ?? [],
            }
          : null,
        presentation: pres
          ? {
              status: pres.status as string,
              startedAt: (beside?.status === "writing" ? beside.started_at : pres.started_at) as string | null,
              draftedAt: pres.drafted_at as string | null,
              bibleVersion: (pres.bible_version as string | null) ?? null,
              newVersion: (beside?.status as string | null) ?? null,
            }
          : null,
        expected: { reviews: reviewsMs, presentation: presentationMs },
        targets,
        teamNotes: (b.team_notes ?? []) as string[],
        openQuestions: (b.open_questions ?? []) as { question: string; who: string }[],
        questions,
        issues,
        links: (links ?? []).map((l) => ({ url: l.url, label: l.label, source: l.source, ok: l.ok, status: l.status, title: l.title, checkedAt: l.checked_at, change: l.change_note, changedAt: l.changed_at })),
        lastExport: pack ? { at: pack.created_at, reason: pack.reason } : null,
        sheet: sheet ? { url: sheet.url as string, name: sheet.name as string, editedAt: sheet.modified_at as string | null, readAt: sheet.read_at as string | null, error: sheet.error as string | null, parts: (["bible", "meta", "google"] as const).filter((k) => Boolean(sheet[k])) } : null,
        generatedAt: b.generated_at,
        reviewedAt: b.reviewed_at,
        reviewedBy: (b.profiles as unknown as { full_name: string } | null)?.full_name ?? null,
        learnings: (b.learnings ?? []) as { at: string; kind: string; text: string }[],
        chat: (b.review_chat ?? []) as BibleTurn[],
      }}
    />
  );
}
