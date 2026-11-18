import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { latestChanges, loadCopyDoc } from "@/lib/copy-docs/server";
import { CopyDocView } from "./copy-doc-view";

export const metadata: Metadata = { title: "Copy" };
export const maxDuration = 120; // a revision rewrites the whole batch

// A copy document full screen: the brief, then each email as it will be designed (subject, preview text, sections,
// button, design notes). Tap a line to comment on it, ask for a change in words, see what the revision changed, then
// approve it into the client's Drive and create the request.

export default async function CopyPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireStaff();
  const { id } = await params;
  const db = await createClient();
  const doc = await loadCopyDoc(db, id);
  if (!doc) notFound();
  const { data: run } = await db.from("deliverable_runs").select("state").eq("doc_id", id).eq("open", true).maybeSingle();
  const requests = ((run?.state as { requests?: { name: string; url: string }[] } | null)?.requests ?? []).map((r) => ({ name: r.name, url: r.url }));
  // Keyed by version and status: a new version (from a call, the chat or a revision here) starts the view fresh
  return <CopyDocView key={`${doc.version}-${doc.status}-${doc.comments.length}`} doc={doc} changed={latestChanges(doc)} me={me.id} requests={requests} />;
}
