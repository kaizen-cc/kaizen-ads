import type { Metadata } from "next";
import { OpsSprintView } from "../../ops-sprint-view";

export const metadata: Metadata = { title: "Email sprint" };

/** One email sprint: the audit's moves with where each stands, the score now against the start, and every check */
export default async function EmailSprintPage({ params }: PageProps<"/kpis/email-sprint/[id]">) {
  const { id } = await params;
  return <OpsSprintView line="email" id={id} />;
}
