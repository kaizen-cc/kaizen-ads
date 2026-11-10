// Ideas saved for later (client_saved_references), PER PERSON per client: a star on anything that offers a brief (a
// market ad, a similar client's winner, a pattern, a suggested brief, a tiring ad, a promise, an audit's idea, a Kaizen
// AI card). Each person sees their own in the new request flow ("Things you've saved") until a brief is made from it.
// Several people can save the same idea; once anyone briefs it, every save of it is marked used (who, where), and the
// others see "already in motion by <name>" instead of briefing it again. Shapes and pure helpers, shared by the server
// and the browser.

import type { BriefSource } from "@/lib/quick-brief";

export type SavedSource = "market" | "winner" | "pattern" | "brief" | "fatigue" | "promise" | "audit_idea" | "ai" | "idea" | "link";

/** What kind of page a pasted reference link is */
export type LinkKind = "motion" | "pinterest" | "instagram" | "tiktok" | "meta_ad_library" | "youtube" | "link";

/** A pasted link as a card: what it is, its title and picture (read on the server, src/lib/link-preview.ts) */
export type LinkPreview = { url: string; kind: LinkKind; title: string | null; subtitle: string | null; thumbnail: string | null; site: string; adId: string | null };

export const LINK_LABEL: Record<LinkKind, string> = { motion: "Motion", pinterest: "Pinterest", instagram: "Instagram", tiktok: "TikTok", meta_ad_library: "Ad Library", youtube: "YouTube", link: "Link" };

/** The kind of a link, from its address alone */
export function linkKind(url: string): LinkKind {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "link";
  }
  const h = u.hostname.toLowerCase().replace(/^www\./, "");
  if (h.endsWith("motionapp.com")) return "motion";
  if (h === "pin.it" || /(^|\.)pinterest\.[a-z.]+$/.test(h)) return "pinterest";
  if (h === "instagram.com" || h.endsWith(".instagram.com") || h === "instagr.am") return "instagram";
  if (h === "tiktok.com" || h.endsWith(".tiktok.com")) return "tiktok";
  if ((h === "facebook.com" || h.endsWith(".facebook.com")) && u.pathname.startsWith("/ads/library")) return "meta_ad_library";
  if (h === "youtu.be" || h === "youtube.com" || h.endsWith(".youtube.com")) return "youtube";
  return "link";
}

/** Every http(s) link in a piece of text (a chat message, a pasted list), cleaned of trailing punctuation */
export function linksIn(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  return [...new Set(found.map((u) => u.replace(/[),.;:!?\]]+$/, "")))].slice(0, 10);
}

/** A pasted link, saved for later for a client: keyed by its address */
export function linkSaveInput(p: LinkPreview): SaveInput {
  return { source: "link", refId: ideaHash(p.url.toLowerCase()), url: p.url, thumbnail: p.thumbnail, title: p.title ?? p.site, subtitle: `${LINK_LABEL[p.kind]}${p.kind === "link" ? ` · ${p.site}` : ""}`, format: null, data: { kind: p.kind, adId: p.adId, site: p.site } };
}
export type SavedFormat = "image" | "video" | "carousel";

/** Someone else briefed an idea this person saved */
export type InMotion = { by: string | null; href: string | null; at: string };

export type SavedRef = {
  id: string;
  clientId: string;
  source: SavedSource;
  refId: string;
  url: string | null;
  thumbnail: string | null;
  title: string | null;
  subtitle: string | null;
  format: SavedFormat | null;
  data: Record<string, unknown>;
  createdAt: string;
  /** The saver's name */
  savedBy: string | null;
  savedById: string | null;
  /** Briefed by someone else: shown as a notice, not briefable again */
  motion: InMotion | null;
};

/** What a star sends: everything to show it again and brief from it later */
export type SaveInput = Pick<SavedRef, "source" | "refId" | "url" | "thumbnail" | "title" | "subtitle" | "format" | "data">;

/** One idea for one client: what every person's save of it shares */
export type IdeaKey = { source: SavedSource; refId: string };

export const savedKey = (source: SavedSource, refId: string) => `${source}:${refId}`;

export const SAVED_COLS =
  "id, client_id, source, ref_id, url, thumbnail, title, subtitle, format, data, created_at, saved_by, used_at, used_by, used_href, dismissed_at, saver:profiles!client_saved_references_saved_by_fkey(full_name), user:profiles!client_saved_references_used_by_fkey(full_name)";

const firstName = (n: string | null | undefined) => (n ? n.trim().split(/\s+/)[0] || null : null);

export function toSaved(r: Record<string, unknown>): SavedRef {
  const usedAt = (r.used_at as string | null) ?? null;
  const usedBy = (r.used_by as string | null) ?? null;
  const savedById = (r.saved_by as string | null) ?? null;
  return {
    id: r.id as string,
    clientId: r.client_id as string,
    source: r.source as SavedSource,
    refId: r.ref_id as string,
    url: (r.url as string | null) ?? null,
    thumbnail: (r.thumbnail as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    subtitle: (r.subtitle as string | null) ?? null,
    format: (r.format as SavedFormat | null) ?? null,
    data: (r.data as Record<string, unknown> | null) ?? {},
    createdAt: r.created_at as string,
    savedBy: (r.saver as { full_name?: string } | null)?.full_name ?? null,
    savedById,
    motion: usedAt && usedBy && usedBy !== savedById ? { by: firstName((r.user as { full_name?: string } | null)?.full_name), href: (r.used_href as string | null) ?? null, at: usedAt } : null,
  };
}

/** A save row as the propagation and the lists need it */
export type SaveRow = { id: string; savedBy: string | null; usedAt: string | null; usedBy?: string | null; dismissedAt?: string | null };

/** How a person's own save shows: open (briefable), in motion by someone else (a notice), or gone (used by them, or dismissed) */
export function saveState(r: SaveRow, meId: string): "open" | "motion" | "hidden" {
  if (r.dismissedAt) return "hidden";
  if (!r.usedAt) return "open";
  return r.usedBy && r.usedBy !== meId ? "motion" : "hidden";
}

/**
 * Someone briefed an idea: every save of it not used yet is marked used, and each other person who had saved it is told
 * once (the briefer never is). rows: every person's save of that one idea for that client.
 */
export function propagateUse(rows: SaveRow[], actorId: string) {
  const open = rows.filter((r) => !r.usedAt);
  const seen = new Set<string>();
  const notify: { rowId: string; profileId: string }[] = [];
  for (const r of open) {
    if (!r.savedBy || r.savedBy === actorId || seen.has(r.savedBy)) continue;
    seen.add(r.savedBy);
    notify.push({ rowId: r.id, profileId: r.savedBy });
  }
  return { mark: open.map((r) => r.id), notify };
}

/** A short stable id for an idea that has no id of its own (an audit's idea, a Kaizen AI card): its label, hashed */
export function ideaHash(s: string) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `h${(h >>> 0).toString(36)}${s.length.toString(36)}`;
}

/** The idea a brief source is, for saving it and for marking everyone's save of it used. null: nothing to save (a chat) */
export function ideaKeyOf(s: BriefSource): IdeaKey | null {
  switch (s.kind) {
    case "winner":
      return { source: "winner", refId: s.winner.adId };
    case "market":
      return { source: "market", refId: s.adId };
    case "pattern":
      return { source: "pattern", refId: s.patternId };
    case "refresh":
      return { source: "fatigue", refId: s.adId };
    case "suggestion":
      return { source: "brief", refId: s.id };
    case "promise":
      return { source: "promise", refId: s.commitmentId };
    case "idea": {
      const label = s.label.trim();
      const source: SavedSource = /^From the (business|account) audit/i.test(label) ? "audit_idea" : /Kaizen AI/i.test(label) ? "ai" : "idea";
      return { source, refId: ideaHash(label.toLowerCase()) };
    }
    default:
      return null;
  }
}

/** What a star on a brief card saves: the idea, how it looks, and the brief source to brief it again later */
export function saveInputOf(s: BriefSource, from: { kicker: string; label: string; thumb?: string | null; adId?: string | null; format?: SavedFormat | null }, extra: Partial<SaveInput> = {}): SaveInput | null {
  const key = ideaKeyOf(s);
  if (!key) return null;
  const format = from.format ?? ("format" in s && s.format ? s.format : null);
  return { ...key, url: null, thumbnail: from.thumb ?? null, title: from.label || null, subtitle: from.kicker || null, format, data: { brief: s, ...(from.adId ? { adId: from.adId } : {}) }, ...extra };
}

/** The ideas a suggested brief was built on, from its row (its own id, and the pattern, market ad, winner or tiring ad) */
export function suggestionIdeaKeys(id: string, source: Record<string, unknown> | null | undefined): IdeaKey[] {
  const out: IdeaKey[] = [{ source: "brief", refId: id }];
  const s = source ?? {};
  if (typeof s.patternId === "string") out.push({ source: "pattern", refId: s.patternId });
  if (typeof s.marketAdId === "string") out.push({ source: "market", refId: s.marketAdId });
  if (typeof s.adId === "string") out.push({ source: s.fatigue ? "fatigue" : "winner", refId: s.adId });
  const k = s.savedKey as IdeaKey | undefined;
  if (k && typeof k.source === "string" && typeof k.refId === "string") out.push({ source: k.source, refId: k.refId });
  return uniqueKeys(out);
}

export const uniqueKeys = (keys: IdeaKey[]) => {
  const seen = new Set<string>();
  return keys.filter((k) => {
    const id = savedKey(k.source, k.refId);
    if (!k.refId || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

export const SOURCE_LABEL: Record<SavedSource, string> = {
  market: "In the market",
  winner: "Similar client",
  pattern: "Pattern",
  brief: "Suggested brief",
  fatigue: "Tiring ad",
  promise: "Promised on a call",
  audit_idea: "Audit idea",
  ai: "Kaizen AI",
  idea: "Idea",
  link: "Link",
};

/** A Meta ad id, whose picture the app keeps (/api/ad-media/<id>) because Meta's own links expire */
export const metaAdId = (s: SavedRef) =>
  // A TikTok winner's id is numeric too, but its picture comes from the TikTok sync (its thumbnail), never from Meta
  s.data.platform === "tiktok" || (s.data.winner as { platform?: string } | undefined)?.platform === "tiktok"
    ? null
    : (s.source === "winner" || s.source === "fatigue") && /^\d{5,25}$/.test(s.refId) ? s.refId : typeof s.data.adId === "string" && /^\d{5,25}$/.test(s.data.adId) ? s.data.adId : null;

/** A link to open the reference, absolute when the app's own (a winner opens in the winners library) */
export function savedHref(s: SavedRef, origin?: string) {
  const raw = s.url ?? (s.source === "winner" ? `/winners?ad=${encodeURIComponent(s.refId)}` : s.source === "market" ? `/market?client=${s.clientId}&ad=${encodeURIComponent(s.refId)}` : null);
  if (!raw) return null;
  try {
    return origin ? new URL(raw, origin).href : raw;
  } catch {
    return null;
  }
}

/** The line a reference adds to a brief when it has no link to put under References */
export const savedLine = (s: SavedRef) => `Reference (saved ${SOURCE_LABEL[s.source].toLowerCase()}): ${s.title ?? "an ad"}${s.subtitle ? ` · ${s.subtitle}` : ""}`;
