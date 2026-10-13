export type RoleFlags = {
  isExec: boolean;
  isLead: boolean;
  isCreative: boolean;
  isBuyer: boolean;
  isCopywriter: boolean;
  isCoordinator: boolean;
};

export const ROLE_DEFS: { key: keyof RoleFlags; column: string; label: string; help: string }[] = [
  { key: "isExec", column: "is_exec", label: "Executive", help: "Everything, including admin and AI instructions" },
  { key: "isLead", column: "is_lead", label: "Lead", help: "Internal creative review, AI instructions, upgrades" },
  { key: "isCreative", column: "is_creative", label: "Creative", help: "Designs and edits, uploads creative" },
  { key: "isBuyer", column: "is_buyer", label: "Media buyer", help: "Requests creative, confirms launches" },
  { key: "isCopywriter", column: "is_copywriter", label: "Copywriter", help: "Edits and approves all copy" },
  { key: "isCoordinator", column: "is_coordinator", label: "Coordinator", help: "Sends to clients and chases approvals" },
];

export const roleLabels = (r: RoleFlags) => ROLE_DEFS.filter((d) => r[d.key]).map((d) => d.label);

export const ASSIGNMENT_ROLES = [
  { value: "meta_buyer", label: "Meta buyer" },
  { value: "graphic_designer", label: "Graphic designer" },
  { value: "video_editor", label: "Video editor" },
] as const;

export type AssignmentRole = "meta_buyer" | "graphic_designer" | "video_editor" | "copywriter" | "coordinator";
