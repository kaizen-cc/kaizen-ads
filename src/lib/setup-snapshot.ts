import "server-only";
import type { AccountSetup } from "@/lib/context/meta";
import type { SetupFacts } from "@/lib/setup-check";

/**
 * What's already in place in one ad account (src/lib/google-setup.ts, src/lib/meta-setup-snapshot.ts), for the audit
 * and each sprint check. Null when the platform isn't connected or nothing could be read; never throws.
 */
export async function setupSnapshot(platform: string | null | undefined, account: string | null, metaSetup?: AccountSetup | null): Promise<{ text: string; facts: SetupFacts } | null> {
  if (!account) return null;
  try {
    if (platform === "google") {
      const { googleAdsConfigured } = await import("@/lib/context/google-ads");
      if (!googleAdsConfigured()) return null;
      const { googleSetupSnapshot } = await import("@/lib/google-setup");
      return await googleSetupSnapshot(account);
    }
    const { metaConfigured } = await import("@/lib/context/meta");
    if (!metaConfigured() || !metaSetup) return null;
    const { metaSetupSnapshot } = await import("@/lib/meta-setup-snapshot");
    return await metaSetupSnapshot(account, metaSetup);
  } catch (e) {
    console.error("[setup snapshot]", e instanceof Error ? e.message : e);
    return null;
  }
}
