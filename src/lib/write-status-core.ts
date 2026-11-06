// Whether a change can actually be written to an ad account right now, decided the same way the gates decide it
// (src/lib/meta-write.ts writeBlocked for Meta, googleWritesOn in src/lib/ad-changes.ts for Google). Pure, so the
// buttons can show it before anyone presses them and the tests can pin it down. The server side is write-status.ts.

export type WritePlatform = "meta" | "google";

/** Why a write can't happen: the client's live changes are off, the platform isn't connected, or there's no account */
export type WriteOff = "client" | "disconnected" | "no_account";

export type WriteStatus = {
  platform: WritePlatform;
  live: boolean;
  /** The plain sentence for the button's place, or null when it can write */
  reason: string | null;
  off: WriteOff | null;
  /** The client the account belongs to, for the name and the Team & setup link */
  client: { id: string; name: string; slug: string } | null;
};

export type WriteInputs = {
  platform: WritePlatform;
  /** The ad account, any format (act_123, 123-456-7890) */
  account: string | null;
  client: { id: string; name: string; slug: string } | null;
  /** Meta: the token is set up. Google: the API is set up */
  configured: boolean;
  /** Meta's sandbox switch (Settings): on means client accounts are refused unless switched on per client */
  sandbox?: boolean;
  /** Meta: Kaizen's own account, always writable */
  sandboxAccount?: string | null;
  /** Google: live changes for every client (Settings → Sync health) */
  googleGlobal?: boolean;
  /** An exec switched live changes on for the client that owns this account */
  clientLive: boolean;
};

export const bareAccount = (a: string | null | undefined) => String(a ?? "").replace(/^act_/, "").replace(/\D/g, "");

const NAME: Record<WritePlatform, string> = { meta: "Meta", google: "Google Ads" };

export function decideWrite(i: WriteInputs): WriteStatus {
  const base = { platform: i.platform, client: i.client };
  if (!i.configured) return { ...base, live: false, off: "disconnected", reason: `${NAME[i.platform]} isn't connected.` };
  if (!bareAccount(i.account)) return { ...base, live: false, off: "no_account", reason: `No ${NAME[i.platform]} ad account is linked${i.client ? ` for ${i.client.name}` : ""}.` };
  const live =
    i.platform === "meta"
      ? i.sandbox === false || (Boolean(i.sandboxAccount) && bareAccount(i.account) === bareAccount(i.sandboxAccount)) || i.clientLive
      : i.googleGlobal === true || i.clientLive;
  if (live) return { ...base, live: true, off: null, reason: null };
  return { ...base, live: false, off: "client", reason: `Live changes are off for ${i.client?.name ?? "this client"}${i.platform === "google" ? "'s Google Ads" : ""}.` };
}

/** Where an exec switches it on: the client's Team & setup tab */
export const switchHref = (s: Pick<WriteStatus, "client">) => (s.client ? `/clients/${s.client.slug}?tab=team` : "/settings");

/** Each object's place in Ads Manager or Google Ads, for doing a planned change by hand */
export function managerHref(platform: WritePlatform, account: string | null) {
  const a = bareAccount(account);
  if (!a) return null;
  return platform === "meta" ? `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${a}` : `https://ads.google.com/aw/campaigns?__e=${a}`;
}
