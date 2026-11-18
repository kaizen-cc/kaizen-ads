import type { Metadata } from "next";
import { OpsAuditView } from "../../ops-audit-view";

export const metadata: Metadata = { title: "Social audit" };

/** One social audit in full: the verdict, the social score's checks, why, the plan the team ticks off, tests and what to ask */
export default async function SocialAuditPage({ params }: PageProps<"/kpis/social-audit/[id]">) {
  const { id } = await params;
  return <OpsAuditView line="social" id={id} />;
}
