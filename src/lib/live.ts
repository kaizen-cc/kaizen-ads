// Live clients: active or onboarding, not archived. Only they get background work (syncs, pulls, AI); paused and
// archived clients are read-only until they're reactivated, so they don't cost API calls or tokens.
export const LIVE = ["active", "onboarding"] as const;

export const isLive = (c: { status?: string | null; archived_at?: string | null }) => !c.archived_at && (LIVE as readonly string[]).includes(c.status ?? "");
