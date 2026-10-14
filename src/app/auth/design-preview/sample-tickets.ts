import type { Ticket } from "@/app/(team)/board/types";
import type { Format, Priority, Stage } from "@/lib/stages";

// Sample tickets for the local design preview only.
let n = 1040;
const t = (client: string, title: string, format: Format, stage: Stage, who: string | null, inStage: number, over: number, priority: Priority = "normal"): Ticket => ({
  id: `s${++n}`,
  number: n,
  clientId: client,
  clientName: client,
  clientSlug: client.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
  title,
  format,
  kind: "new",
  priority,
  stage,
  assigneeId: who,
  assigneeName: who,
  creativeName: format === "video" ? "Jazem" : "Nelson",
  buyerName: "Mark",
  angleName: "Weekly Deals",
  audience: "Families within 10 miles, retargeting site visitors",
  brief: "Three images for the $8 Calzone Mondays offer. Lead with the price, show the calzone cut open, warm lighting. Keep text on the image under 8 words.",
  refs: ["https://projects.motionapp.com/snapshot/example"],
  sizes: ["4x5", "9x16"],
  quantity: 3,
  stageEnteredAt: new Date(Date.now() - inStage * 60_000).toISOString(),
  stageDueAt: new Date(Date.now() + 6 * 3_600_000).toISOString(),
  minutesInStage: inStage,
  minutesOver: over,
  createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
});

export const sampleTickets: Ticket[] = [
  t("Sierra Dreams", "BFCM · Buy More, Save More", "image", "requested", "Nelson", 90, 0, "high"),
  t("Nectr", "Energy Anywhere hook iteration", "video", "requested", "Mira", 240, 0),
  t("Best Tickets", "Local Presence · UGC selfie", "video", "requested", "Daniel", 1300, 400),
  t("Tejas Brewery", "Seasonal tap list", "video", "in_production", "Daniel", 2600, 1500, "urgent"),
  t("Lice Treatment Center", "Prevention reframe hooks", "video", "in_production", "Mira", 700, 0),
  t("Wild World Paintball", "Weekend activities", "carousel", "in_production", "Hillary", 950, 300),
  t("Crust Pizza Co.", "Donation Program · in-store poster", "image", "client_revision", "Victor", 820, 220, "urgent"),
  t("Fast Conversational Spanish", "$7 trial · teachers image", "image", "internal_review", "Jesus", 320, 0, "urgent"),
  t("Union Hill Day School", "October stacked", "carousel", "internal_review", "Jesus", 120, 0),
  t("Idalia Photography", "Book Lovers · discover your confidence", "image", "copy", "Priscila", 60, 0),
  t("Fast Conversational Spanish", "$7 trial · Unlimited Live Classes", "video", "copy_review", "Camille", 410, 0),
  t("Nectr", "Performance claim statics", "image", "ready_for_client", "Jorgi Conti", 180, 0),
  t("Atlas Print Solutions", "Website leads refresh", "video", "ready_for_client", "Jorgi Conti", 900, 300),
  t("Leap Funding", "Special Category · instant form", "video", "client_review", "Jorgi Conti", 3100, 1900, "urgent"),
  t("Crust Pizza Co.", "$8 Calzone Mondays", "image", "client_review", "Jorgi Conti", 380, 0),
  t("Sierra Dreams", "Save up to 30% · statics", "image", "client_review", "Jorgi Conti", 1450, 650),
  t("Limelight Entertainment", "Photo + Video + DJ · price point", "carousel", "ready_for_launch", "Matheus", 200, 0),
  t("Extreme Velocity", "Zombie Shoot 2026", "video", "ready_for_launch", "Rahul", 760, 160),
  t("Darling Psychology", "Profile visits · October", "carousel", "launched", "Eduarda", 900, 0),
];
