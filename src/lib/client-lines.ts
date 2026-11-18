import { isEmailRole, isSocialRole, worksAs, type TeamRole } from "@/lib/roles";

// A client's page shows every service line they have to everyone on the team (no gatekeeping). What differs is what
// you can DO: your own line stays actionable, the others are read-only overviews (numbers, status, what's happening).

export type LineId = "meta" | "google" | "tiktok" | "email" | "social" | "creative";
export const ALL_LINES: readonly LineId[] = ["meta", "google", "tiktok", "email", "social", "creative"];

type Who = { role: string; isExec?: boolean | null; also_buys?: boolean | null; also_social?: boolean | null; also_designs_email?: boolean | null };

/** The seats a person holds on this client, as the lines they work in (a seat is work on that line even for a visitor) */
const SEAT_LINE: Record<string, LineId> = { meta_buyer: "meta", google_buyer: "google", tiktok_buyer: "tiktok", social_creative: "social", social_manager: "social" };

/** The lines this person works in (and so may act on); everyone sees every line, read only otherwise */
export function actableLines(who: Who, seats: readonly string[] = []): Set<LineId> {
  const out = new Set<LineId>();
  // Executives and customer success (account managers) work across every line
  if (who.isExec || who.role === "executive" || who.role === "customer_success") return new Set(ALL_LINES);
  const r = who.role as TeamRole;
  if (r === "head_of_meta" || r === "media_buyer") { out.add("meta"); out.add("tiktok"); }
  if (r === "head_of_google" || r === "google_buyer") out.add("google");
  if (worksAs(r, "head_of_creative", "graphic_designer", "video_editor") || r === "copywriter") out.add("creative");
  if (isEmailRole(r) || who.also_designs_email) out.add("email");
  if (isSocialRole(r) || who.also_social) out.add("social");
  if (who.also_buys) { out.add("meta"); out.add("google"); out.add("tiktok"); }
  for (const s of seats) {
    const l = SEAT_LINE[s];
    if (l) out.add(l);
  }
  return out;
}
