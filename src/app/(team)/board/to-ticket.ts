import type { Format, Priority, Stage } from "@/lib/stages";
import { cleanTitle } from "@/lib/task-title";
import type { Ticket } from "./types";

/** A row from the `board_requests` view. */
export type BoardRow = {
  id: string;
  number: number;
  client_id: string;
  client_name: string;
  client_slug: string;
  title: string;
  format: Format;
  kind: "new" | "iteration";
  priority: Priority;
  stage: Stage;
  assignee_id: string | null;
  assignee_name: string | null;
  creative_name: string | null;
  buyer_name: string | null;
  angle_name: string | null;
  avatar?: string | null;
  avatar_test?: boolean | null;
  audience: string | null;
  brief: string | null;
  refs: string[] | null;
  origin?: Ticket["origin"];
  sizes: string[] | null;
  quantity: number;
  new_count: number | null;
  variation_count: number | null;
  batch_id: string | null;
  stage_entered_at: string;
  stage_due_at: string | null;
  minutes_in_stage: number;
  minutes_over: number;
  created_at: string;
  landing_url?: string | null;
  parent_number?: number | null;
  internal_rounds?: number | null;
  client_rounds?: number | null;
};

export const toTicket = (r: BoardRow): Ticket => ({
  id: r.id,
  number: r.number,
  clientId: r.client_id,
  clientName: r.client_name,
  clientSlug: r.client_slug,
  // A ticket migrated from Asana can still carry "URGENT: URGENT:" in its title: shown once, as the badge
  title: cleanTitle(r.title).title,
  format: r.format,
  kind: r.kind,
  // The ticket's own priority (set from Asana's at migration, then changed only in the ticket)
  priority: r.priority ?? "normal",
  stage: r.stage,
  assigneeId: r.assignee_id,
  assigneeName: r.assignee_name,
  creativeName: r.creative_name,
  buyerName: r.buyer_name,
  angleName: r.angle_name,
  avatar: r.avatar ?? null,
  avatarTest: Boolean(r.avatar_test),
  audience: r.audience,
  brief: r.brief,
  refs: r.refs ?? [],
  origin: r.origin ?? null,
  sizes: r.sizes ?? [],
  quantity: r.quantity,
  newCount: r.new_count ?? r.quantity,
  variationCount: r.variation_count ?? 0,
  batchId: r.batch_id,
  stageEnteredAt: r.stage_entered_at,
  stageDueAt: r.stage_due_at,
  minutesInStage: r.minutes_in_stage ?? 0,
  minutesOver: r.minutes_over ?? 0,
  createdAt: r.created_at,
  landingUrl: r.landing_url ?? null,
  parentNumber: r.parent_number ?? null,
  internalRounds: r.internal_rounds ?? 0,
  clientRounds: r.client_rounds ?? 0,
});
