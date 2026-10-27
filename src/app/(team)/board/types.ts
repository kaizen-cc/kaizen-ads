import type { Format, Priority, Stage } from "@/lib/stages";

export type Ticket = {
  /** Moved over from Asana and still missing what its stage needs (the creative files, the copy set) */
  migration?: { url: string | null; needsCreative: boolean; needsCopy: boolean } | null;
  id: string;
  number: number;
  clientId: string;
  clientName: string;
  clientSlug: string;
  title: string;
  format: Format;
  kind: "new" | "iteration";
  priority: Priority;
  stage: Stage;
  assigneeId: string | null;
  assigneeName: string | null;
  creativeName: string | null;
  buyerName: string | null;
  angleName: string | null;
  audience: string | null;
  brief: string | null;
  refs: string[];
  origin: { kind: "winner" | "market" | "promise" | "brief"; label: string; link?: string | null; thumb?: string | null } | null; // what it's built on
  sizes: string[];
  /** Carousels: cards per carousel */
  cards?: number | null;
  /** What's uploaded so far: net new and variation designs, and each carousel's card count */
  uploaded?: { new: number; variations: number; cards: number[] } | null;
  quantity: number;
  newCount: number;
  variationCount: number;
  batchId: string | null;
  stageEnteredAt: string;
  stageDueAt: string | null;
  minutesInStage: number;
  minutesOver: number;
  createdAt: string;
  landingUrl?: string | null;
  parentNumber?: number | null; // split off from this ticket (the client approved part of it)
  internalRounds?: number; // times the Head of Creative sent it back
  clientRounds?: number; // times the client asked for changes
};

export type Person = { id: string; name: string; role: string };
export type ClientOption = { id: string; name: string; slug: string };
