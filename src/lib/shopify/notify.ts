import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// A store just connected: the client's buyers hear it in Kaizen OS (bell, not Slack), once per store, with where it is.

export async function tellShopifyConnected(admin: SupabaseClient, clientId: string, store: string, from: "team" | "portal") {
  const [{ data: c }, { data: seats }] = await Promise.all([
    admin.from("clients").select("name, slug").eq("id", clientId).maybeSingle(),
    admin.from("client_assignments").select("profile_id").eq("client_id", clientId).in("role", ["meta_buyer", "google_buyer", "tiktok_buyer"]),
  ]);
  if (!c) return 0;
  const ids = [...new Set((seats ?? []).map((s) => s.profile_id as string))];
  if (!ids.length) return 0;
  const rows = ids.map((profile_id) => ({
    profile_id,
    kind: "business",
    title: `${c.name}: Shopify connected`.slice(0, 200),
    body: `${from === "portal" ? "The client connected" : "Connected"} ${store}. Its full order history is being read now (back to the first order), then store revenue and MER show on the client page, in reports and to the agents.`,
    href: `/clients/${c.slug}#store`,
    client_id: clientId,
    key: `shopify-connected:${clientId}:${store}`,
    priority: "normal",
  }));
  await admin.from("notifications").upsert(rows, { onConflict: "profile_id,key", ignoreDuplicates: true });
  return rows.length;
}
