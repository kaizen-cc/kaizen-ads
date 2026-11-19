import "server-only";
import { createSessionClient } from "@/lib/supabase/session";
import { activeViewAs } from "@/lib/view-as";
import { viewAsFetch } from "@/lib/view-as-fetch";
import { VIEW_AS_HEADER } from "@/lib/view-as-core";

/**
 * The signed-in person's connection: RLS answers for them. While the owner views as a teammate it answers for that
 * teammate instead (the database's pre-request hook reads x-kz-view-as) and it can't write (lib/view-as-core.ts).
 */
export async function createClient() {
  const va = await activeViewAs();
  if (!va) return createSessionClient();
  return createSessionClient({ headers: { [VIEW_AS_HEADER]: va.target.id }, fetch: viewAsFetch(fetch, { header: true }) });
}
