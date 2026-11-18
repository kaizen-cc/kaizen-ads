import type { Metadata } from "next";
import { OpsAuditView } from "../../ops-audit-view";

export const metadata: Metadata = { title: "Email audit" };

/** One email audit in full: the verdict, the checks, why, the plan the team ticks off, tests and what to ask */
export default async function EmailAuditPage({ params }: PageProps<"/kpis/email-audit/[id]">) {
  const { id } = await params;
  return <OpsAuditView line="email" id={id} />;
}
