export type Stage =
  | "requested"
  | "in_production"
  | "internal_review"
  | "copy"
  | "copy_review"
  | "ready_for_client"
  | "client_review"
  | "client_revision"
  | "ready_for_launch"
  | "launched";

export type Phase = "brief" | "make" | "review" | "client" | "launch";

export const PHASE_LABEL: Record<Phase, string> = {
  brief: "Brief",
  make: "Make",
  review: "Review",
  client: "Client",
  launch: "Launch",
};

// retired: no longer on the board (kept so old tickets and history still read). Ready for client went away: approved
// work goes straight to the client's portal.
export const STAGES: { key: Stage; label: string; short: string; phase: Phase; owner: string; next?: Stage; nextLabel?: string; retired?: boolean; offBoard?: boolean }[] = [
  { key: "requested", label: "Requested", short: "Requested", phase: "brief", owner: "Creative", next: "in_production", nextLabel: "Start production" },
  { key: "in_production", label: "In production", short: "Production", phase: "make", owner: "Creative", next: "internal_review", nextLabel: "Send to creative review" },
  { key: "internal_review", label: "Creative review", short: "Review", phase: "review", owner: "Head of Creative", next: "copy", nextLabel: "Approve creative" },
  { key: "copy", label: "Copy", short: "Copy", phase: "review", owner: "AI draft · buyer", next: "copy_review", nextLabel: "Send to copy review" },
  { key: "copy_review", label: "Copy review", short: "Copy review", phase: "review", owner: "Copywriter", next: "client_review", nextLabel: "Approve copy" },
  { key: "ready_for_client", label: "Ready for client", short: "Ready", phase: "client", owner: "Customer success", next: "client_review", nextLabel: "Send to client", retired: true },
  { key: "client_review", label: "With client", short: "With client", phase: "client", owner: "Client · customer success", next: "ready_for_launch", nextLabel: "Client approved" },
  { key: "client_revision", label: "Client changes", short: "Changes", phase: "make", owner: "Creative", next: "internal_review", nextLabel: "Send to creative review" },
  { key: "ready_for_launch", label: "Ready to launch", short: "To launch", phase: "launch", owner: "Media buyer", next: "launched", nextLabel: "Mark launched" },
  // Launched work lives on the client's page (Creative), not the board
  { key: "launched", label: "Launched", short: "Launched", phase: "launch", owner: "", offBoard: true },
];

/** Board order: client changes sit next to production, where the work actually happens. */
export const BOARD_ORDER: Stage[] = [
  "requested",
  "in_production",
  "client_revision",
  "internal_review",
  "copy",
  "copy_review",
  "client_review",
  "ready_for_launch",
];

export const stageInfo = (s: Stage) => STAGES.find((x) => x.key === s)!;

/** Business minutes in a business day (8am–6pm). */
export const DAY_MINUTES = 600;
/** Up to 12 business hours over turnaround is amber; beyond that is red. */
export const AMBER_LIMIT = 12 * 60;

export type Health = "ok" | "warn" | "bad";

export function health(minutesOver: number, stage: Stage): Health {
  if (stage === "launched" || minutesOver <= 0) return "ok";
  return minutesOver <= AMBER_LIMIT ? "warn" : "bad";
}

/** "45m", "5h", "2d 3h" — business time (a day is 10 business hours). */
export function businessDuration(minutes: number) {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  if (m < DAY_MINUTES) return `${Math.floor(m / 60)}h`;
  const d = Math.floor(m / DAY_MINUTES);
  const h = Math.floor((m % DAY_MINUTES) / 60);
  return h ? `${d}d ${h}h` : `${d}d`;
}

export const FORMAT_LABEL = { image: "Image", video: "Video", carousel: "Carousel" } as const;
export type Format = keyof typeof FORMAT_LABEL;
export type Priority = "normal" | "high" | "urgent";
