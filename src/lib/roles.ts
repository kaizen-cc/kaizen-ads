export type TeamRole =
  | "executive"
  | "head_of_meta"
  | "head_of_creative"
  | "head_of_google"
  | "media_buyer"
  | "google_buyer"
  | "graphic_designer"
  | "video_editor"
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

/** Per-client slots and who can fill them. */
export const SLOTS = [
  { value: "meta_buyer", label: "Meta buyer", eligible: ["media_buyer", "head_of_meta"] as TeamRole[] },
  { value: "google_buyer", label: "Google buyer", eligible: ["google_buyer", "head_of_google"] as TeamRole[] },
  { value: "graphic_designer", label: "Designer", eligible: ["graphic_designer", "head_of_creative"] as TeamRole[] },
  { value: "video_editor", label: "Video editor", eligible: ["video_editor", "head_of_creative"] as TeamRole[] },
] as const;

export type SlotRole = (typeof SLOTS)[number]["value"];
export type AssignmentRole = SlotRole | "copywriter" | "coordinator";
