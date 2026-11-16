// Connecting an ad account from a KPI card: reading what someone typed, and telling "nothing connected" from
// "connected but the platform won't let us read it". Pure, so the board (browser) and the actions (server) share it.

import type { KpiPlatform } from "./platform";

/** A Meta ad account ID from "act_123", "123" or a pasted Ads Manager URL; digits only, or null when it isn't one */
export function parseMetaAccountId(input: string | null | undefined): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  // Ads Manager links carry it as act=123
  const fromUrl = raw.match(/[?&]act=(\d{5,20})/)?.[1];
  const digits = (fromUrl ?? raw.replace(/^act_/i, "")).replace(/[\s-]/g, "");
  return /^\d{5,20}$/.test(digits) ? digits : null;
}

/** A Google Ads customer ID as 123-456-7890 (how Google's IDs are kept), from dashes or plain digits; null unless 10 digits */
export function parseGoogleCustomerId(input: string | null | undefined): string | null {
  const d = (input ?? "").replace(/\D/g, "");
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : null;
}

/** A TikTok advertiser ID: 10 to 25 digits */
export function parseTikTokAdvertiserId(input: string | null | undefined): string | null {
  const d = (input ?? "").trim();
  return /^\d{10,25}$/.test(d) ? d : null;
}

export type ConnectState =
  /** Nothing on the card to read: no ad account set */
  | { kind: "missing" }
  /** An account is set but the platform won't show it to us (the share or the link is missing) */
  | { kind: "blocked"; why: string; fix: string }
  /** Fine, or failing for a reason connecting won't fix (no data yet, a sync hiccup) */
  | { kind: "ok" };

const BLOCKED: Record<KpiPlatform, { test: RegExp; fix: string }> = {
  meta: {
    test: /can't see this ad account|missing permissions|does not exist|ads_read|permission|not authorized|cannot be loaded/i,
    fix: "Share the ad account with Kaizen's Business Manager (the CommandCenter system user) with ads_read, then check again.",
  },
  google: {
    test: /can't see this account|USER_PERMISSION_DENIED|permission|not associated|customer not enabled/i,
    fix: "Link the Google Ads account to Kaizen's manager account (MCC) and accept the request in Google Ads, then check again.",
  },
  tiktok: {
    test: /No working TikTok connection|permission|not authorized|authorization|advertiser.*(access|not found)/i,
    fix: "Make sure the TikTok ad account is on the grant Kaizen connected (reconnect TikTok in Settings, Sync health), then check again.",
  },
};

/** What to show on a card: connect it, explain a block, or nothing. `status` is the card's status; setup is the only one with a read problem. */
export function connectState(platform: KpiPlatform, accountId: string | null, status: string, error: string | null): ConnectState {
  if (!accountId?.trim()) return { kind: "missing" };
  if (status !== "setup" || !error) return { kind: "ok" };
  // The server itself isn't set up: connecting an account won't fix that
  if (/isn't connected yet/i.test(error)) return { kind: "ok" };
  const b = BLOCKED[platform];
  return b.test.test(error) ? { kind: "blocked", why: error, fix: b.fix } : { kind: "ok" };
}
