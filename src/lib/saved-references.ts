// References saved for later, per client (client_saved_references): a star on a market ad, a similar client's winning
// ad, a pattern or a brief. They show at the top of the new request flow and on the client's tickets until a brief is
// made from one; then it's marked used (and kept). Shapes and pure helpers, shared by the server and the browser.

export type SavedSource = "market" | "winner" | "pattern" | "brief";
export type SavedFormat = "image" | "video" | "carousel";

export type SavedRef = {
  id: string;
  source: SavedSource;
  refId: string;
  url: string | null;
  thumbnail: string | null;
  title: string | null;
  subtitle: string | null;
  format: SavedFormat | null;
  data: Record<string, unknown>;
  createdAt: string;
  savedBy: string | null;
};

/** What a star sends: everything to show it again and brief from it later */
export type SaveInput = Pick<SavedRef, "source" | "refId" | "url" | "thumbnail" | "title" | "subtitle" | "format" | "data">;

export const savedKey = (source: SavedSource, refId: string) => `${source}:${refId}`;

export const SAVED_COLS = "id, source, ref_id, url, thumbnail, title, subtitle, format, data, created_at, profiles:saved_by(full_name)";

export function toSaved(r: Record<string, unknown>): SavedRef {
  return {
    id: r.id as string,
    source: r.source as SavedSource,
    refId: r.ref_id as string,
    url: (r.url as string | null) ?? null,
    thumbnail: (r.thumbnail as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    subtitle: (r.subtitle as string | null) ?? null,
    format: (r.format as SavedFormat | null) ?? null,
    data: (r.data as Record<string, unknown> | null) ?? {},
    createdAt: r.created_at as string,
    savedBy: (r.profiles as { full_name?: string } | null)?.full_name ?? null,
  };
}

export const SOURCE_LABEL: Record<SavedSource, string> = { market: "In the market", winner: "Similar client", pattern: "Pattern", brief: "Brief" };

/** A Meta ad id, whose picture the app keeps (/api/ad-media/<id>) because Meta's own links expire */
export const metaAdId = (s: SavedRef) => (s.source === "winner" && /^\d{5,25}$/.test(s.refId) ? s.refId : typeof s.data.adId === "string" && /^\d{5,25}$/.test(s.data.adId) ? s.data.adId : null);

/** A link to open the reference, absolute when the app's own (a winner opens in the winners library) */
export function savedHref(s: SavedRef, origin?: string) {
  const raw = s.url ?? (s.source === "winner" ? `/winners?ad=${encodeURIComponent(s.refId)}` : null);
  if (!raw) return null;
  try {
    return origin ? new URL(raw, origin).href : raw;
  } catch {
    return null;
  }
}

/** The line a reference adds to a brief when it has no link to put under References */
export const savedLine = (s: SavedRef) => `Reference (saved ${SOURCE_LABEL[s.source].toLowerCase()}): ${s.title ?? "an ad"}${s.subtitle ? ` · ${s.subtitle}` : ""}`;
