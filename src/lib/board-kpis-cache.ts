import "server-only";
import { unstable_cache } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Period } from "@/lib/creative-kpis";

// The Board's KPI tabs, worked out once and shared: only execs and leads open them, and they see every client, so the
// numbers are the same for each of them. Kept for three minutes and refreshed in the background after that, so a click
// on Creative KPIs or Copy KPIs is instant; opening the Board warms them, and a dismissal or an error check clears them.

export const BOARD_KPIS_TAG = "board-kpis";

export const cachedCreativeKpis = unstable_cache(
  async (period: Period) => {
    const { loadCreativeKpis } = await import("@/lib/creative-kpis");
    return loadCreativeKpis(createAdminClient(), period);
  },
  ["board-creative-kpis"],
  { revalidate: 180, tags: [BOARD_KPIS_TAG] },
);

export const cachedCopyKpis = unstable_cache(
  async (period: Period) => {
    const { loadCopyKpis } = await import("@/lib/copy-kpis");
    return loadCopyKpis(createAdminClient(), period);
  },
  ["board-copy-kpis"],
  { revalidate: 180, tags: [BOARD_KPIS_TAG] },
);
