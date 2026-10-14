import type { Format, Priority, Stage } from "@/lib/stages";

export type Ticket = {
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
  sizes: string[];
  quantity: number;
  stageEnteredAt: string;
  stageDueAt: string | null;
  minutesInStage: number;
  minutesOver: number;
  createdAt: string;
};

export type Person = { id: string; name: string; role: string };
export type ClientOption = { id: string; name: string; slug: string };
