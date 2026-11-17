import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getViewer } from "@/lib/auth";
import { toMessage, withDesignUrls, type EmailMessage } from "@/lib/email-board";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { EmailsView, type PortalEmailTicket } from "./emails-view";

export const metadata: Metadata = { title: "Emails for review · Kaizen", robots: { index: false, follow: false } };

// The client's emails and texts waiting for them: each one's design (with its buttons going where they will), or the
// text itself, to approve or send back with notes pinned right on the design. Read with the server's rights after
// the brand check (the same way the rest of the portal reads).
export default async function PortalEmails({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const viewer = await getViewer();
  if (!adminConfigured()) notFound();
  if (viewer.kind === "contact" && !viewer.brands.some((b) => b.slug === slug)) notFound();
  const admin = createAdminClient();
  const { data: client } = await admin.from("clients").select("id, name, portal_live").eq("slug", slug).maybeSingle();
  if (!client || (viewer.kind === "contact" && !client.portal_live)) notFound();
  const { data: tickets } = await admin.from("email_tickets").select("id, number, kind, title, goal, trigger").eq("client_id", client.id).eq("stage", "with_client").is("deleted_at", null).order("stage_entered_at");
  const ids = (tickets ?? []).map((t) => t.id as string);
  const { data: rows } = ids.length ? await admin.from("email_messages").select("*").in("ticket_id", ids).order("position") : { data: [] };
  const messages = await withDesignUrls(admin, (rows ?? []).map(toMessage));
  const byTicket = new Map<string, EmailMessage[]>();
  for (const [i, r] of (rows ?? []).entries()) byTicket.set(r.ticket_id as string, [...(byTicket.get(r.ticket_id as string) ?? []), messages[i]]);
  const list: PortalEmailTicket[] = (tickets ?? []).map((t) => ({
    id: t.id as string,
    kind: t.kind as "batch" | "flow",
    title: t.title as string,
    goal: (t.goal as string | null) ?? null,
    trigger: (t.trigger as string | null) ?? null,
    messages: (byTicket.get(t.id as string) ?? []).map((m) => ({ id: m.id, channel: m.channel, name: m.name, sendOn: m.sendOn, delayHours: m.delayHours, subject: m.subject, preheader: m.preheader, body: m.body, designUrl: m.designUrl ?? null, pdf: (m.designMime ?? "").includes("pdf"), links: m.links.filter((l) => l.url), approved: m.clientStatus === "approved" })),
  }));
  return <EmailsView slug={slug} brand={client.name as string} tickets={list} team={viewer.kind === "staff"} />;
}
