import "server-only";
import { getViewer } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Who may open a client's portal chat: a contact of that brand once Kaizen has switched it live, or someone on the
// team who can see the client (the team's own access rules decide). Every chat request goes through here.
export async function chatAccess(slug: string) {
  if (!adminConfigured()) return null;
  const viewer = await getViewer();
  const admin = createAdminClient();
  const { data: client } = await admin.from("clients").select("id, name, slug, portal_live, slack_channel_id").eq("slug", slug).maybeSingle();
  if (!client) return null;
  if (viewer.kind === "contact") {
    if (!client.portal_live || !viewer.brands.some((b) => b.slug === slug)) return null;
    return { admin, client, viewer, readerId: viewer.id, contactId: viewer.id, name: viewer.fullName || viewer.email.split("@")[0]!, team: false as const };
  }
  const { data: mine } = await (await createClient()).from("clients").select("id").eq("id", client.id).maybeSingle();
  if (!mine) return null;
  return { admin, client, viewer, readerId: viewer.id, contactId: null, name: viewer.fullName, team: true as const };
}

/** A few messages a minute is plenty for a person; more is a stuck key or a script */
export async function tooFast(admin: ReturnType<typeof createAdminClient>, clientId: string, name: string) {
  const { count } = await admin
    .from("portal_chat_messages")
    .select("ts", { count: "exact", head: true })
    .eq("client_id", clientId)
    .eq("from_portal", true)
    .eq("author_name", name)
    .gte("sent_at", new Date(Date.now() - 60_000).toISOString());
  return (count ?? 0) >= 10;
}
