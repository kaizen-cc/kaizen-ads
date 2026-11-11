import { getViewer } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// Refresh now (Settings › Connections › Team connectors, execs only): the catalog sync on demand, so the Directory
// fills right after a deploy instead of waiting for the daily cron. A plain request rather than a server action, so a
// long first pull never holds up the page's other actions. It reads and saves a batch of pages at a time for up to
// four minutes; the screen calls again while it isn't complete, carrying on from where this one stopped.
export const maxDuration = 300;

export async function POST() {
  const viewer = await getViewer();
  if (viewer.kind !== "staff" || !viewer.isExec) return Response.json({ error: "Only execs can refresh the catalog." }, { status: 403 });
  if (!adminConfigured()) return Response.json({ error: "Server key missing." }, { status: 500 });
  const { syncConnectorRegistry } = await import("@/lib/connectors/registry-sync");
  try {
    const r = await syncConnectorRegistry(createAdminClient(), { budgetMs: 240_000 });
    return Response.json(r);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "The sync stopped." }, { status: 500 });
  }
}
