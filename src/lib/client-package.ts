import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// A client's package: the tier it's on for each service it buys (basic, silver, gold...) and what that tier includes,
// as set on the client's page (service_tiers, client_service_tiers). Read by get_client_context and client_package, so
// the agents plan volume and scope from the package instead of asking.

export type PackageLine = { service: string; tier: string | null; includes: string | null; note: string | null };

export async function clientPackage(admin: SupabaseClient, clientId: string): Promise<PackageLine[]> {
  const [{ data: picks }, { data: tiers }] = await Promise.all([
    admin.from("client_service_tiers").select("service, tier_id, note").eq("client_id", clientId),
    admin.from("service_tiers").select("id, service, label, includes"),
  ]);
  const byId = new Map((tiers ?? []).map((t) => [t.id as string, t]));
  return (picks ?? []).map((p) => {
    const t = p.tier_id ? byId.get(p.tier_id as string) : null;
    return { service: p.service as string, tier: (t?.label as string | undefined) ?? null, includes: (t?.includes as string | null | undefined) ?? null, note: (p.note as string | null) ?? null };
  });
}

/** The package as a block for an agent's context ("none set yet" said plainly, so it's never guessed) */
export function packageBlock(lines: PackageLine[]): string {
  if (!lines.length) return "<package>No package tier is set for this client yet (it's set on the client's page). Don't guess the tier: ask, or say it isn't set.</package>";
  return `<package>\n${lines.map((l) => `- ${l.service}: ${l.tier ?? "no tier picked"}${l.includes ? ` (includes: ${l.includes.replace(/\s+/g, " ").slice(0, 600)})` : ""}${l.note ? ` [note: ${l.note.slice(0, 200)}]` : ""}`).join("\n")}\n</package>`;
}
