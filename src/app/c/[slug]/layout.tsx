import { notFound } from "next/navigation";
import { PortalShell } from "@/components/portal-shell";
import { getViewer } from "@/lib/auth";
import { portalSections } from "@/lib/portal-sections";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Every page of a client's portal sits in the same frame: the sidebar on a computer, the tab bar on a phone. Clients
// only get in once Kaizen switches the brand live; until then only the team can open it, with a banner saying so.
export default async function PortalLayout({ children, params }: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const viewer = await getViewer();
  if (!adminConfigured()) notFound();
  if (viewer.kind === "contact" && !viewer.brands.some((b) => b.slug === slug)) notFound();
  const db = viewer.kind === "contact" ? createAdminClient() : await createClient();
  const { data: client } = await db.from("clients").select("id, name, slug, portal_live, slack_channel_id").eq("slug", slug).maybeSingle();
  if (!client || (viewer.kind === "contact" && !client.portal_live)) notFound();
  const admin = createAdminClient();
  const { unreadCount } = await import("@/lib/portal-chat");
  const [nav, { count: waiting }, unread] = await Promise.all([
    portalSections(admin, client.id),
    admin.from("requests").select("id", { count: "exact", head: true }).eq("client_id", client.id).eq("stage", "client_review").is("deleted_at", null),
    // Their team chat: what our team wrote since they last looked
    client.slack_channel_id ? unreadCount(admin, client.id, viewer.id).catch(() => 0) : Promise.resolve(0),
  ]);
  return (
    <PortalShell
      slug={client.slug}
      brand={client.name}
      brands={viewer.kind === "contact" ? viewer.brands : [{ name: client.name, slug: client.slug }]}
      who={viewer.kind === "contact" ? (viewer.fullName ?? viewer.email) : viewer.fullName}
      team={viewer.kind === "staff"}
      live={Boolean(client.portal_live)}
      waiting={waiting ?? 0}
      setup={nav.setup}
      plan={nav.plan}
      chat={client.slack_channel_id ? { unread } : null}
    >
      {children}
    </PortalShell>
  );
}
