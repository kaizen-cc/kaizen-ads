export type TeamRole =
  | "executive"
  | "head_of_meta"
  | "head_of_creative"
  | "head_of_google"
  | "media_buyer"
  | "google_buyer"
  | "graphic_designer"
  | "video_editor"
  | "lead_graphic_designer"
  | "lead_video_editor"
  | "copywriter"
  | "customer_success";

export type Tier = "executive" | "leader" | "member";

export const ROLES: { value: TeamRole; label: string; tier: Tier }[] = [
  { value: "executive", label: "Executive", tier: "executive" },
  { value: "head_of_meta", label: "Head of Meta", tier: "leader" },
  { value: "head_of_creative", label: "Head of Creative", tier: "leader" },
  { value: "head_of_google", label: "Head of Google", tier: "leader" },
  { value: "media_buyer", label: "Media buyer", tier: "member" },
  { value: "google_buyer", label: "Google buyer", tier: "member" },
  { value: "graphic_designer", label: "Graphic designer", tier: "member" },
  { value: "video_editor", label: "Video editor", tier: "member" },
  { value: "lead_graphic_designer", label: "Lead graphic designer", tier: "member" },
  { value: "lead_video_editor", label: "Lead video editor", tier: "member" },
  { value: "copywriter", label: "Copywriter", tier: "member" },
  { value: "customer_success", label: "Customer success", tier: "member" },
];

export const TIERS: { value: Tier; label: string; access: string }[] = [
  { value: "executive", label: "Executives", access: "Everything, including team, clients and AI instructions" },
  { value: "leader", label: "Leaders", access: "Assign people to clients, review work, edit AI instructions" },
  { value: "member", label: "Team", access: "Work on the clients they're assigned to" },
];

export const roleLabel = (r: TeamRole) => ROLES.find((x) => x.value === r)?.label ?? r;
export const tierOf = (r: TeamRole): Tier => ROLES.find((x) => x.value === r)?.tier ?? "member";

/**
 * The lead makers: a lead graphic designer or lead video editor. Each works exactly like their base role (same tier,
 * formats, permissions and data), except they can pick any client: every client is an option to see and request for.
 */
export const LEAD_MAKERS = { lead_graphic_designer: "graphic_designer", lead_video_editor: "video_editor" } as const satisfies Partial<Record<TeamRole, TeamRole>>;
export type LeadMakerRole = keyof typeof LEAD_MAKERS;

/** Whether this position is a lead maker (lead graphic designer or lead video editor) */
export const isLeadMaker = (role: string | null | undefined): role is LeadMakerRole => role === "lead_graphic_designer" || role === "lead_video_editor";

/** The role someone works as: a lead maker's base role (graphic designer or video editor), anyone else's own */
export function baseRole(role: TeamRole): TeamRole;
export function baseRole(role: string): string;
export function baseRole(role: string | null | undefined): string | null;
export function baseRole(role: string | null | undefined): string | null {
  if (!role) return null;
  return isLeadMaker(role) ? LEAD_MAKERS[role] : role;
}

/** Whether someone works as this role (a lead maker counts as their base role too) */
export const worksAs = (role: string | null | undefined, ...as: TeamRole[]) => as.includes(baseRole(role) as TeamRole);

/**
 * The creative team: the Head of Creative, graphic designers and video editors (lead makers included). Their screens
 * leave out the media-buying tools (the KPI board, audits and sprints, reports, the Ads Lab) and the alerts only a
 * buyer or account manager can act on. Matches profiles.is_creative in the database.
 */
export const isCreativeRole = (role: string | null | undefined) => worksAs(role, "head_of_creative", "graphic_designer", "video_editor");

/** Who works with client reports: executives and the media buyers (the heads of Meta and Google, Meta and Google buyers) */
export const REPORT_ROLES: readonly TeamRole[] = ["executive", "head_of_meta", "head_of_google", "media_buyer", "google_buyer"];

/**
 * Whether someone sees client reports at all (the Reports page, a client's Reports tab, report links and notices):
 * executives and media buyers only. The creative team, the copywriter and customer success never do.
 */
export const canSeeReports = (p: { role: string | null | undefined; isExec?: boolean | null }) => Boolean(p.isExec) || REPORT_ROLES.includes(p.role as TeamRole);

/** Per-client slots and who can fill them. */
export const SLOTS = [
  { value: "meta_buyer", label: "Meta buyer", eligible: ["media_buyer", "head_of_meta"] as TeamRole[] },
  { value: "google_buyer", label: "Google buyer", eligible: ["google_buyer", "head_of_google"] as TeamRole[] },
  { value: "graphic_designer", label: "Designer", eligible: ["graphic_designer", "lead_graphic_designer", "head_of_creative"] as TeamRole[] },
  { value: "video_editor", label: "Video editor", eligible: ["video_editor", "lead_video_editor", "head_of_creative"] as TeamRole[] },
] as const;

export type SlotRole = (typeof SLOTS)[number]["value"];
export type AssignmentRole = SlotRole | "copywriter" | "coordinator";

/**
 * Whether a creative client needs this seat, from their monthly allotment: a video-only package needs no designer, an
 * images-only one no video editor. Every other seat (and a package with both, or none set) is needed as usual.
 */
export function seatNeeded(slot: string, allotment: { images: number; videos: number }) {
  if (slot === "graphic_designer") return !(allotment.videos > 0 && allotment.images === 0);
  if (slot === "video_editor") return !(allotment.images > 0 && allotment.videos === 0);
  return true;
}

/** Who can hold a seat: their role, or (for the buyer seats) someone who also buys media alongside their own role (an exec) */
export function canHold(slot: { value: string; eligible: readonly TeamRole[] }, p: { role: string; also_buys?: boolean | null }) {
  return slot.eligible.includes(p.role as TeamRole) || (Boolean(p.also_buys) && (slot.value === "meta_buyer" || slot.value === "google_buyer"));
}

/** The ad platform someone's team works on: the Meta team (buyers and head) Meta, the Google team Google, anyone else null (both) */
export function teamPlatform(role: string): "meta" | "google" | null {
  if (role === "media_buyer" || role === "head_of_meta") return "meta";
  if (role === "google_buyer" || role === "head_of_google") return "google";
  return null;
}
